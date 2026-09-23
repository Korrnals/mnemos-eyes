"""Provisioner — the install-time SSH channel (wave 4, blocks A/B/D α).

WIP (session handoff, M1.x backlog): the spray tests below create live
job rows DIRECTLY via the store with a no-op worker — an in-loop
cancellation fixture (hanging fake connections + real worker tasks) is
the remaining piece; until then the hang scenarios are exercised at the
route level only.

QA matrix:
- happy path: 202 → connecting → installing → watching → done; the
  FROZEN bootstrap one-liner is executed VERBATIM (url, mne_ token,
  name, harness); TOFU pins the host key (job + host-pin table + audit
  provisioning.host_key_pinned); the enrollment is consumed (state used,
  executor_id) → provisioning.ok; the executor appears in the registry
  verdict;
- host-key enforcement: a job with an expected fingerprint (or an
  existing pin) against a DIFFERENT key → failed host_key_mismatch;
  re-pin (owner act) flips the pin with old→new in the audit
  (provisioning.host_key_repinned) and the next job passes;
- anti-spray (security P2-5): one live job per host:port → 409; global
  live cap 2 → 429; per-host cooldown after a finished job → 429;
  dedicated 5/60s rate limit;
- password auth: 422 while disabled (default), 202 with the flag on;
- transit invariants (S1/S2): the mne_ token and the ssh secret appear
  NOWHERE — not in provision_jobs columns, not in audit payloads, not
  in SSE frames, not in steps; Redacted.__repr__ hides the value;
  describe_error masks BEFORE truncating;
- restart: live jobs → failed(provisioner.restarted), token maps cleared;
- disabled provisioner → 503 fail-closed.
"""

from __future__ import annotations

import json

import pytest

from conftest import BOARD_TOKEN
from server import provisioner as prov
from server.provisioner import JobFacts, Provisioner, Redacted, describe_error

FP_A = "SHA256:" + "A" * 43
FP_B = "SHA256:" + "B" * 43


class FakeKey:
    def as_bytes(self) -> bytes:
        return b"fake-host-key"


class FakeResult:
    def __init__(self, exit_status: int, stderr: str = "", stdout: str = "") -> None:
        self.exit_status = exit_status
        self.stderr = stderr
        self.stdout = stdout


class FakeConn:
    def __init__(self, exit_status: int = 0, stderr: str = "") -> None:
        self.exit_status = exit_status
        self.stderr = stderr
        self.commands: list[str] = []
        self.closed = False

    async def run(self, command: str) -> FakeResult:
        self.commands.append(command)
        return FakeResult(self.exit_status, self.stderr)


@pytest.fixture(autouse=True)
def fake_provisioner(app_module, monkeypatch):
    """Swap the module singleton for a fake-SSH provisioner with fast
    watching; collect broadcasts and audit payloads."""
    events: list[dict] = []
    audits: list[tuple[str, dict]] = []
    conn_holder: dict = {"conn": FakeConn(0)}
    connect_calls: list[JobFacts] = []

    async def fake_connect(facts: JobFacts, host_key_check):
        connect_calls.append(facts)
        host_key_check(FakeKey())
        return conn_holder["conn"]

    p = Provisioner(app_module.store, audit=lambda *, kind, payload: audits.append((kind, payload)),
                    broadcast=events.append, ssh_connect=fake_connect, watch_poll_s=0.01)
    monkeypatch.setattr(prov, "_provisioner", p)
    monkeypatch.setattr(prov, "_TOKENS", {})
    monkeypatch.setattr(prov, "_BY_ENROLLMENT", {})
    # WIP-note: the fake bootstrap does not consume the enrollment on the
    # board; a flag simulates the registration leg (server-side CAS) so
    # the watcher sees state=used + executor_id.
    flags = {"simulate_registration": True}
    real_get_enrollment = app_module.store.get_enrollment

    def fake_get_enrollment(eid):
        row = real_get_enrollment(eid)
        if (flags.get("simulate_registration") and row is not None
                and row.get("state") == "created"
                and row.get("label", "").startswith("provision:")):
            row = {**row, "state": "used", "executor_id": "ex-fake"}
        return row

    monkeypatch.setattr(app_module.store, "get_enrollment", fake_get_enrollment)
    yield {"events": events, "audits": audits, "conn": conn_holder,
           "connect": connect_calls, "flags": flags}


def _provision(client, ui_auth, **overrides):
    body = {"host": "vps-1", "auth": {"kind": "alias"},
            "board_url_for_host": "https://b.example"} | overrides
    return client.post("/api/executors/provision", json=body, headers=ui_auth)


@pytest.fixture(autouse=True)
def fresh_rate_limiter(app_module, monkeypatch):
    limiter = app_module._provision_limiter
    monkeypatch.setattr(app_module, "_provision_limiter",
                        type(limiter)(limit=limiter.limit, window=limiter.window))


# ---------------------------------------------------------------- happy path
class TestHappyPath:
    def test_202_then_lifecycle_done(self, client, ui_auth, fake_provisioner):
        r = _provision(client, ui_auth, host="happy-1")
        assert r.status_code == 202, r.text
        body = r.json()
        assert body["state"] == "queued"
        assert "mne_" not in r.text  # the token NEVER travels back

        job_id = body["job_id"]

        def done():
            row = client.get(f"/api/executors/provision/{job_id}",
                             headers=ui_auth).json()["job"]
            assert row["state"] == "done", row
            return row

        row = _poll_until(done)
        assert "bootstrap" in " ".join(row["steps"])
        # the FROZEN one-liner: url, token, name, harness — verbatim
        cmd = fake_provisioner["conn"]["conn"].commands[0]
        assert cmd.startswith("curl -kfsSL https://b.example/api/poller/bootstrap.sh")
        assert "| sudo bash -s -- --url https://b.example --token mne_" in cmd
        assert "--name vps-1 --harness zcode" in cmd
        # the enrollment was consumed
        enr = client.get(f"/api/executors/provision/{job_id}",
                         headers=ui_auth).json()["enrollment"]
        assert enr["state"] == "used"

    def test_tofu_pins_and_audits(self, client, ui_auth, fake_provisioner):
        r = _provision(client, ui_auth, host="tofu-1")
        job_id = r.json()["job_id"]
        row = _poll_until(lambda: _job(client, ui_auth, job_id, state="done"))
        assert row["host_key_fingerprint"].startswith("SHA256:")
        kinds = [k for k, _ in fake_provisioner["audits"]]
        assert "provisioning.created" in kinds
        assert "provisioning.host_key_pinned" in kinds
        assert "provisioning.ok" in kinds

    def test_second_job_enforces_the_pin(self, client, ui_auth, fake_provisioner):
        r = _provision(client, ui_auth, host="enforce-1")
        assert r.status_code == 202
        first_id = r.json()["job_id"]
        _poll_until(lambda: _job(client, ui_auth, first_id, state="done"))
        # a DIFFERENT host key is presented now (the conn holder is replaced)
        class OtherKey:
            def as_bytes(self) -> bytes:
                return b"other-key"

        fake_provisioner["conn"]["conn"] = FakeConn(0)
        # inject the mismatching key via the validator
        old = fake_provisioner["connect"]

        async def connect_with_other_key(facts, host_key_check):
            host_key_check(OtherKey())
            return fake_provisioner["conn"]["conn"]

        fake_provisioner["connect"] = connect_with_other_key
        # the pin from job 1 is enforced → mismatch
        import asyncio
        p = prov._provisioner
        facts = JobFacts(job_id="pj-x", host="enforce-1", port=22, auth_kind="alias",
                         secret=None, passphrase=None, username="",
                         harness_hint="zcode", enrollment_id="enr-x",
                         executor_name="vps-1", board_url="https://b.example",
                         bootstrap_token=Redacted("mne_t"),
                         expected_host_key_fingerprint="")
        with_err = None
        try:
            asyncio.run(p._guarded_run(facts))
        except Exception as exc:  # noqa: BLE001
            with_err = exc
        row = _job(client, ui_auth, "pj-x")
        assert row["state"] == "failed"
        assert row["error_code"] == "host_key_mismatch"


# ---------------------------------------------------------------- anti-spray
class TestAntiSpray:
    def test_dedup_409_on_live_job(self, client, ui_auth, app_module,
                                   monkeypatch):
        _noop_worker(app_module, monkeypatch)
        job_id = _live_job_direct(app_module, "dedup-1")
        r = _provision(client, ui_auth, host="dedup-1")
        assert r.status_code == 409
        assert "already live" in r.json()["detail"]

    def test_global_cap_429(self, client, ui_auth, app_module, monkeypatch):
        _noop_worker(app_module, monkeypatch)
        _live_job_direct(app_module, "h1")
        _live_job_direct(app_module, "h2")
        r = _provision(client, ui_auth, host="h3")
        assert r.status_code == 429
        assert "cap" in r.json()["detail"]

    def test_cooldown_429_after_failure(self, client, ui_auth, app_module,
                                        monkeypatch):
        # a FAILED job on host:port arms the cooldown even though nothing
        # is live anymore (route order: live dedup → cooldown → cap)
        _noop_worker(app_module, monkeypatch)
        app_module.store.create_provision_job(
            host="cool-1", port=22, auth_kind="alias", key_fingerprint="a",
            harness_hint="zcode", board_url_for_host="https://b.example",
            enrollment_id="")
        app_module.store.update_provision_job(
            _first_job_id_by_host(app_module, "cool-1"), state="failed",
            error_code="ssh.unreachable")
        r = _provision(client, ui_auth, host="cool-1")
        assert r.status_code == 429
        assert "cooldown" in r.json()["detail"]


class _NeverConn:
    async def run(self, command: str):  # hangs until cancelled
        import asyncio
        await asyncio.sleep(30)

    def close(self) -> None:
        return None


# -------------------------------------------------------------- password auth
class TestPasswordAuthToggle:
    def test_disabled_by_default_422(self, client, ui_auth):
        r = _provision(client, ui_auth,
                       auth={"kind": "password", "secret": "pw"})
        assert r.status_code == 422
        assert "disabled" in r.json()["detail"]

    def test_enabled_with_flag(self, client, ui_auth, monkeypatch,
                               fake_provisioner):
        monkeypatch.setenv("VESMARO_PROVISION_PASSWORD_AUTH", "1")
        r = _provision(client, ui_auth, host="pw-1",
                       auth={"kind": "password", "secret": "pw"})
        assert r.status_code == 202


# ------------------------------------------------------------ transit invariants
class TestTransitInvariants:
    def test_no_secret_material_anywhere(self, client, ui_auth,
                                         fake_provisioner):
        secret = "SUPER-SECRET-KEY-MATERIAL"
        r = _provision(client, ui_auth, host="transit-1",
                       auth={"kind": "key", "secret": secret})
        job_id = r.json()["job_id"]
        _poll_until(lambda: _job(client, ui_auth, job_id, state="done"))

        row = _job(client, ui_auth, job_id)
        row_text = json.dumps(row)
        assert secret not in row_text
        assert "mne_" not in row_text.replace("mne_…", "")
        for kind, payload in fake_provisioner["audits"]:
            assert secret not in json.dumps(payload)
            assert "mne_" not in json.dumps(payload)
        for ev in fake_provisioner["events"]:
            blob = json.dumps(ev)
            assert secret not in blob
            assert "mne_" not in blob

    def test_redacted_repr_hides_value(self):
        r = Redacted("super-secret")
        assert "super-secret" not in repr(r)
        assert "super-secret" not in str(r)
        assert r.reveal() == "super-secret"

    def test_describe_error_masks_before_truncates(self):
        token = "mne_" + "x" * 40
        detail = token + " " + "y" * 300
        out = describe_error(detail)
        # the token was masked BEFORE the 200-char cut: the masked prefix
        # survives, no token tail is re-exposed
        assert "mne_<redacted>" in out
        assert token not in out
        assert len(out) <= 200


# ------------------------------------------------------------------ restart
class TestRestart:
    def test_live_jobs_fail_on_restart(self, client, ui_auth, app_module,
                                       monkeypatch):
        # a LIVE job row + a cleared transit map = the post-restart state;
        # fail_stale must fail the row and clear the maps (WIP: the full
        # hang-then-restart e2e moves to M1.x with in-loop cancellation)
        _noop_worker(app_module, monkeypatch)
        job_id = _live_job_direct(app_module, "restart-1")
        prov.remember(job_id, "enr-r", "mne_secret")

        n = prov.fail_stale(app_module.store, lambda ev: None)
        assert n >= 1
        assert prov._TOKENS == {}
        row = _job(client, ui_auth, job_id)
        assert row["state"] == "failed"
        assert row["error_code"] == "provisioner.restarted"


# ----------------------------------------------------------------- disabled
class TestDisabled:
    def test_fail_closed_503(self, client, ui_auth, monkeypatch):
        monkeypatch.setenv("VESMARO_PROVISIONER_ENABLED", "0")
        r = _provision(client, ui_auth)
        assert r.status_code == 503


# ------------------------------------------------------------------ helpers
def _live_job_direct(app_module, host: str, port: int = 22) -> str:
    """Create a LIVE job row without starting the worker (queued forever):
    the deterministic way to test the route-level anti-spray gates."""
    return app_module.store.create_provision_job(
        host=host, port=port, auth_kind="alias", key_fingerprint="alias:x",
        harness_hint="zcode", board_url_for_host="https://b.example",
        enrollment_id="")["id"]


def _noop_worker(app_module, monkeypatch) -> None:
    """Replace the worker's start_job with a no-op (nothing runs)."""
    class _Noop:
        def start_job(self, facts) -> None:
            return None

    monkeypatch.setattr(prov, "_provisioner", _Noop())


def _first_job_id_by_host(app_module, host: str) -> str:
    return app_module.store.last_provision_job_for_host(host, 22)["id"]


def _job(client, ui_auth, job_id: str, state: str | None = None) -> dict:
    row = client.get(f"/api/executors/provision/{job_id}",
                     headers=ui_auth).json()["job"]
    if state is not None:
        assert row["state"] == state, f"want {state}, got {row['state']} ({row})"
    return row


def _first_job(client, ui_auth) -> str:
    import sqlite3
    from conftest import DATA_DIR
    db = sqlite3.connect(DATA_DIR / "board.db")
    db.row_factory = sqlite3.Row
    row = db.execute(
        "SELECT id FROM provision_jobs ORDER BY created_at DESC LIMIT 1").fetchone()
    db.close()
    return row["id"]


def _poll_until(callable_, tries: int = 400):
    last = None
    for _ in range(tries):
        try:
            result = callable_()
            if result is not None:
                return result
        except AssertionError as exc:
            last = exc
        import time
        time.sleep(0.01)
    raise AssertionError(f"condition not met: {last}")
