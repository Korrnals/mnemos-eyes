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

import asyncio
import base64
import hashlib
import inspect
import json
import shlex

import pytest

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
    def __init__(self, exit_status: int = 0, stderr: str = "",
                 preflight_exit: int = 0) -> None:
        self.exit_status = exit_status
        self.stderr = stderr
        self.preflight_exit = preflight_exit
        self.commands: list[str] = []
        self.uploads: list[tuple[str, bytes]] = []
        self.closed = False
        # simulated registration leg: set per connect by the fixture —
        # running the bootstrap spends the enrollment IN THE STORE exactly
        # like the real script, which keeps the live-enrollment quota
        # honest across the whole file (was the cross-test pollution root)
        self.registration: dict = {}

    async def run(self, command: str) -> FakeResult:
        self.commands.append(command)
        if command == "sudo -n true":  # typed sudo preflight (P2-4)
            return FakeResult(self.preflight_exit)
        if self.registration.get("enrollment_id"):
            import sqlite3
            from conftest import DATA_DIR
            db = sqlite3.connect(DATA_DIR / "board.db")
            db.execute(
                "UPDATE enrollment_tokens SET state='used', executor_id='ex-fake' "
                "WHERE id=?", (self.registration["enrollment_id"],))
            db.commit()
            db.close()
        return FakeResult(self.exit_status, self.stderr)

    async def upload_file(self, remote_path: str, data: bytes) -> None:
        self.uploads.append((remote_path, data))  # the CA leg (P2-3)

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def fake_provisioner(app_module, monkeypatch):
    """Swap the module singleton for a fake-SSH provisioner with fast
    watching; collect broadcasts and audit payloads."""
    events: list[dict] = []
    audits: list[tuple[str, dict]] = []
    conn_holder: dict = {"conn": FakeConn(0)}
    connect_calls: list[JobFacts] = []
    flags = {"simulate_registration": True}

    async def fake_connect(facts: JobFacts, policy):
        # the REAL contract arity (P1-2): the transport decides the host
        # key via a policy exposing validate(host, addr, port, key) —
        # the SSHClient.validate_host_public_key signature asyncssh calls;
        # a policy False is what asyncssh turns into HostKeyNotVerifiable,
        # which the real transport maps to the typed mismatch error
        connect_calls.append(facts)
        if not policy.validate(facts.host, "127.0.0.1", facts.port, FakeKey()):
            raise prov.ProvisioningError(
                "host_key_mismatch",
                f"host key {policy.presented_fingerprint} does not match "
                f"the pinned/expected {policy.expected}")
        if flags.get("simulate_registration"):
            conn_holder["conn"].registration = {"enrollment_id": facts.enrollment_id}
        return conn_holder["conn"]

    p = Provisioner(app_module.store, audit=lambda *, kind, payload: audits.append((kind, payload)),
                    broadcast=events.append, ssh_connect=fake_connect, watch_poll_s=0.01)
    monkeypatch.setattr(prov, "_provisioner", p)
    monkeypatch.setattr(prov, "_TOKENS", {})
    monkeypatch.setattr(prov, "_BY_ENROLLMENT", {})
    yield {"events": events, "audits": audits, "conn": conn_holder,
           "connect": connect_calls, "flags": flags}


@pytest.fixture(autouse=True)
def board_ca_file(app_module, monkeypatch):
    """The install leg delivers the board CA over the SSH channel from
    VESMARO_TLS_CA_FILE (P2-3): point the env at a synthetic PEM."""
    from conftest import DATA_DIR
    ca_path = DATA_DIR / "test-lab-ca.crt"
    ca_path.write_bytes(b"-----BEGIN CERTIFICATE-----\nQA\n-----END CERTIFICATE-----\n")
    monkeypatch.setenv("VESMARO_TLS_CA_FILE", str(ca_path))
    yield str(ca_path)


def _provision(client, ui_auth, **overrides):
    body = {"host": "vps-1", "auth": {"kind": "alias"},
            "board_url_for_host": "https://b.example"} | overrides
    return client.post("/api/executors/provision", json=body, headers=ui_auth)


@pytest.fixture(autouse=True)
def fresh_rate_limiter(app_module, monkeypatch):
    limiter = app_module._provision_limiter
    monkeypatch.setattr(app_module, "_provision_limiter",
                        type(limiter)(limit=limiter.limit, window=limiter.window))
    yield
    # no-op-worker tests leave eternal queued rows — clean them so the
    # global live-cap, the enrollment quota and the TOFU pin state do not
    # leak across tests
    import sqlite3
    from conftest import DATA_DIR
    db = sqlite3.connect(DATA_DIR / "board.db")
    db.execute("DELETE FROM provision_jobs")
    db.execute("DELETE FROM provision_host_pins")
    db.execute("DELETE FROM enrollment_tokens")
    db.commit()
    db.close()


# ---------------------------------------------------------------- happy path
class TestHappyPath:
    def test_202_then_lifecycle_done(self, client, ui_auth, fake_provisioner):
        r = _provision(client, ui_auth, host="happy-1", name="vps-1")
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
        steps_text = " ".join(json.loads(row["steps"]))
        assert "bootstrap" in steps_text
        # the FROZEN one-liner over PINNED TLS (P2-3): the CA rides the
        # SSH channel, curl carries --cacert and never -k
        conn = fake_provisioner["conn"]["conn"]
        cmd = _bootstrap_command(conn)
        assert cmd.startswith("curl --cacert /tmp/vesmaro-lab-ca-")
        assert " -fsSL https://b.example/api/poller/bootstrap.sh" in cmd
        curl_part = cmd.split("|")[0]
        assert "-kfsSL" not in curl_part and " -k " not in curl_part
        assert "| sudo bash -s -- --url https://b.example --token mne_" in cmd
        assert "--name vps-1 --harness zcode" in cmd
        # the CA upload happened over the SSH channel: job-scoped tmp path
        assert conn.uploads and conn.uploads[0][0].startswith("/tmp/vesmaro-lab-ca-")
        assert conn.uploads[0][1].startswith(b"-----BEGIN CERTIFICATE-----")
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

    def test_second_job_enforces_the_pin(self, client, ui_auth,
                                         fake_provisioner, app_module):
        # the TOFU core: job 1 pins the presented key; job 2 on the same
        # host presents a DIFFERENT key — the policy rejects it and the
        # transport (mimicking asyncssh's False -> HostKeyNotVerifiable)
        # fails the job with the typed host_key_mismatch
        r = _provision(client, ui_auth, host="enforce-1")
        assert r.status_code == 202
        first_id = r.json()["job_id"]
        _poll_until(lambda: _job(client, ui_auth, first_id, state="done"))

        class OtherKey:
            def as_bytes(self) -> bytes:
                return b"other-key"

        async def connect_other_key(facts, policy):
            if not policy.validate(facts.host, "127.0.0.1", facts.port,
                                   OtherKey()):
                raise prov.ProvisioningError(
                    "host_key_mismatch",
                    f"host key {policy.presented_fingerprint} does not match "
                    f"the pinned/expected {policy.expected}")
            return fake_provisioner["conn"]["conn"]

        p = prov._provisioner
        p._ssh_connect = connect_other_key
        # the job ROW must exist for the verdict (the route normally mints
        # it atomically with the facts)
        row0 = app_module.store.create_provision_job(
            host="enforce-1", port=22, auth_kind="alias", key_fingerprint="",
            harness_hint="zcode", board_url_for_host="https://b.example",
            enrollment_id="enr-x")
        asyncio.run(p._guarded_run(_facts(job_id=row0["id"], host="enforce-1",
                                          enrollment_id="enr-x")))
        row = _job(client, ui_auth, row0["id"])
        assert row["state"] == "failed"
        assert row["error_code"] == "host_key_mismatch"
        kinds = [k for k, _ in fake_provisioner["audits"]]
        assert "provisioning.failed" in kinds


# --------------------------------------------------- transport (P1-2/P2-3/P2-4)
class TestTransport:
    def test_sudo_preflight_fail_is_typed(self, client, ui_auth,
                                          fake_provisioner):
        fake_provisioner["conn"]["conn"] = FakeConn(preflight_exit=1)
        r = _provision(client, ui_auth, host="sudo-fail-1")
        job_id = r.json()["job_id"]
        row = _poll_until(lambda: _job(client, ui_auth, job_id,
                                       state="failed"))
        assert row["error_code"] == "ssh.sudo_required"
        # nothing was installed: the bootstrap command never ran
        assert not [c for c in
                    fake_provisioner["conn"]["conn"].commands
                    if c.startswith("curl")]

    def test_missing_ca_fails_closed_without_unpinned_tls(
            self, client, ui_auth, fake_provisioner, monkeypatch):
        monkeypatch.delenv("VESMARO_TLS_CA_FILE")
        r = _provision(client, ui_auth, host="no-ca-1")
        job_id = r.json()["job_id"]
        row = _poll_until(lambda: _job(client, ui_auth, job_id,
                                       state="failed"))
        assert row["error_code"] == "ca.unavailable"
        assert not fake_provisioner["conn"]["conn"].uploads

    def test_install_timeout_is_bootstrap_timeout(self, client, ui_auth,
                                                  fake_provisioner,
                                                  app_module, monkeypatch):
        # NOTE: the worker task only progresses inside the loop of the
        # request that spawned it (TestClient without a context manager
        # runs a fresh portal per request) — a 30s-hanging install leg
        # started via the ROUTE would simply be cancelled at request end.
        # The deterministic way: drive the worker on the test's own loop.
        conn = FakeConn()

        async def hanging_run(command: str):
            if command == "sudo -n true":
                return FakeResult(0)
            conn.commands.append(command)
            if command.startswith("rm -f "):  # the tmp-CA cleanup (P2-3)
                return FakeResult(0)
            await asyncio.sleep(30)  # the install leg hangs until cancelled

        conn.run = hanging_run  # type: ignore[method-assign]
        fake_provisioner["conn"]["conn"] = conn
        monkeypatch.setattr(prov, "INSTALL_TIMEOUT_S", 0.05)
        row0 = app_module.store.create_provision_job(
            host="install-timeout-1", port=22, auth_kind="alias",
            key_fingerprint="", harness_hint="zcode",
            board_url_for_host="https://b.example", enrollment_id="enr-it")
        prov.remember(row0["id"], "enr-it", "mne_t")
        asyncio.run(prov._provisioner._guarded_run(
            _facts(job_id=row0["id"], host="install-timeout-1",
                   enrollment_id="enr-it")))
        row = _job(client, ui_auth, row0["id"])
        assert row["error_code"] == "bootstrap.timeout"


# --------------------------------------------------- input validation (P1-1)
class TestInputValidation:
    """Shell-injection boundary: strict charsets at the route (422) plus
    shlex.quote in the worker as the second, charset-agnostic layer."""

    @pytest.mark.parametrize("field,value", [
        ("host", "vps-1; rm -rf /"),
        ("host", "vps-1$(reboot)"),
        ("host", "VPS-1"),                # charset is lowercase
        ("host", "vps-1.example."),       # no trailing dot
        ("host", "-leading-dash"),
        ("name", "x; reboot"),
        ("name", "x$(touch /tmp/pwned)"),
        ("name", "-nope"),
        ("name", ".nope"),
    ])
    def test_shell_meta_rejected_422(self, client, ui_auth, field, value):
        body = {"host": "val-1", "auth": {"kind": "alias"},
                "board_url_for_host": "https://b.example", field: value}
        r = client.post("/api/executors/provision", json=body, headers=ui_auth)
        assert r.status_code == 422, r.text

    def test_board_url_with_path_rejected_422(self, client, ui_auth):
        r = _provision(client, ui_auth,
                       board_url_for_host="https://b.example/evil;x=1")
        assert r.status_code == 422, r.text

    def test_board_url_with_port_accepted(self, client, ui_auth,
                                          fake_provisioner):
        r = _provision(client, ui_auth, host="val-port-1",
                       board_url_for_host="https://b.example:8443")
        assert r.status_code == 202, r.text
        _poll_until(lambda: _job(client, ui_auth, r.json()["job_id"],
                                 state="done"))
        cmd = _bootstrap_command(fake_provisioner["conn"]["conn"])
        assert "--url https://b.example:8443" in cmd

    def test_unknown_harness_hint_rejected_422(self, client, ui_auth):
        r = _provision(client, ui_auth, harness_hint="not-in-dictionary")
        assert r.status_code == 422
        assert "unknown harness" in r.json()["detail"]

    def test_reuse_branch_validates_harness_hint(self, client, ui_auth,
                                                 app_module):
        # the reuse path skips create_enrollment entirely — the dictionary
        # gate must hold BEFORE the raw hint can reach JobFacts (P1-1)
        row, _token = app_module.store.create_enrollment(
            label="provision:val-reuse", harness_hint="zcode")
        r = _provision(client, ui_auth, host="val-reuse",
                       reuse_enrollment_id=row["enrollment_id"],
                       harness_hint="not-in-dictionary")
        assert r.status_code == 422
        assert "unknown harness" in r.json()["detail"]

    def test_bootstrap_command_quotes_adversarial_values(self):
        # unit-level second layer: whatever slips past the boundary cannot
        # break the argument quoting
        facts = _facts(job_id="pj-quote", executor_name="x; reboot",
                       harness_hint="z; rm -rf /",
                       board_url="https://b.example/evil $(calc)")
        cmd = Provisioner.bootstrap_command(
            facts, "mne_t", ca_path="/tmp/vesmaro-lab-ca-pj-quote.crt")
        # every adversarial value appears ONLY inside single quotes
        assert "--name x; reboot" not in cmd
        assert "--harness z; rm -rf /" not in cmd
        assert "-fsSL https://b.example/evil $(calc)" not in cmd
        assert shlex.quote("x; reboot") in cmd
        assert shlex.quote("z; rm -rf /") in cmd
        assert shlex.quote("https://b.example/evil $(calc)") in cmd


# ------------------------------------------------- fingerprints (P1-3/P2-2)
class TestFingerprints:
    """One canonical format everywhere (ssh-keygen SHA256:unpadded-b64);
    zero secret derivations in the DB or the API."""

    def test_strict_hex_owner_input_normalized(self, client, ui_auth,
                                               fake_provisioner):
        # the owner may paste hex64 (or ssh-keygen base64) — both land in
        # the job row in the ONE canonical form the worker compares
        canonical = prov.fingerprint_of_bytes(b"fake-host-key")
        assert canonical == "SHA256:" + base64.b64encode(
            hashlib.sha256(b"fake-host-key").digest()).decode().rstrip("=")
        hex_fp = hashlib.sha256(b"fake-host-key").hexdigest()
        r = _provision(client, ui_auth, host="strict-hex-1",
                       expected_host_key_fingerprint=hex_fp)
        assert r.status_code == 202, r.text
        row = _poll_until(lambda: _job(client, ui_auth,
                                       r.json()["job_id"], state="done"))
        assert row["host_key_fingerprint"] == canonical

    def test_strict_mismatch_fails_typed(self, client, ui_auth):
        r = _provision(client, ui_auth, host="strict-mm-1",
                       expected_host_key_fingerprint=FP_B)
        job_id = r.json()["job_id"]
        row = _poll_until(lambda: _job(client, ui_auth, job_id,
                                       state="failed"))
        assert row["error_code"] == "host_key_mismatch"

    def test_garbage_fingerprint_rejected_422(self, client, ui_auth):
        r = _provision(client, ui_auth,
                       expected_host_key_fingerprint="SHA256:zzz-not-b64")
        assert r.status_code == 422

    def test_password_has_zero_secret_derivations(self, client, ui_auth,
                                                  monkeypatch):
        monkeypatch.setenv("VESMARO_PROVISION_PASSWORD_AUTH", "1")
        pw = "hunter2-super-secret"
        derived_b64 = "SHA256:" + base64.b64encode(
            hashlib.sha256(pw.encode()).digest()).decode().rstrip("=")
        derived_hex = hashlib.sha256(pw.encode()).hexdigest()
        r = _provision(client, ui_auth, host="pw-fp-1",
                       auth={"kind": "password", "secret": pw})
        assert r.status_code == 202, r.text
        row = _poll_until(lambda: _job(client, ui_auth,
                                       r.json()["job_id"], state="done"))
        assert row["key_fingerprint"] == "password"
        blob = json.dumps(row)
        assert derived_b64 not in blob and derived_hex not in blob
        assert pw not in blob


# ------------------------------------------- asyncssh contract smoke (P1-2)
class TestAsyncsshContract:
    """The transport contract against the INSTALLED asyncssh — the exact
    mistake class the review caught (1-arg validator as known_hosts=).
    Skipped where asyncssh is not installed."""

    def test_validate_host_public_key_arity(self):
        asyncssh = pytest.importorskip("asyncssh")
        params = list(inspect.signature(
            asyncssh.SSHClient.validate_host_public_key).parameters)
        assert params == ["self", "host", "addr", "port", "key"]
        assert issubclass(asyncssh.PermissionDenied, Exception)
        assert issubclass(asyncssh.HostKeyNotVerifiable, Exception)

    def test_trust_nothing_matcher_shape(self):
        pytest.importorskip("asyncssh")
        trusted, ca, revoked = prov._trust_nothing("h", "127.0.0.1", 22)
        assert (trusted, ca, revoked) == ([], [], [])

    def test_fingerprint_formula_matches_asyncssh(self):
        asyncssh = pytest.importorskip("asyncssh")
        key = asyncssh.generate_private_key("ssh-ed25519")
        assert (prov.fingerprint_of_bytes(key.public_data)
                == key.get_fingerprint())

    def test_public_key_fingerprint_best_effort(self):
        asyncssh = pytest.importorskip("asyncssh")
        key = asyncssh.generate_private_key("ssh-ed25519")
        material = key.export_private_key().decode()
        assert prov.public_key_fingerprint(material) == key.get_fingerprint()
        assert prov.public_key_fingerprint("definitely not a key") == ""


# ---------------------------------------------------------------- anti-spray
class TestAntiSpray:
    def test_dedup_409_on_live_job(self, client, ui_auth, app_module,
                                   monkeypatch):
        _noop_worker(app_module, monkeypatch)
        _live_job_direct(app_module, "dedup-1")
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
    """Kept for the M1.x in-loop cancellation fixture (hang scenarios)."""

    async def run(self, command: str):  # hangs until cancelled
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


# ------------------------------------------------------- pins/repin (P2-1)
class TestPinsAndRepin:
    """Pin identity is (host, port); repin is an owner act with old→new
    in the audit and invalidates live jobs of that identity."""

    def _pin_row(self, app_module, host: str, port: int = 22):
        import sqlite3
        from conftest import DATA_DIR
        db = sqlite3.connect(DATA_DIR / "board.db")
        db.row_factory = sqlite3.Row
        row = db.execute(
            "SELECT * FROM provision_host_pins WHERE host=? AND port=?",
            (host, port)).fetchone()
        db.close()
        return dict(row) if row else None

    def test_tofu_pins_host_port(self, client, ui_auth, app_module):
        r = _provision(client, ui_auth, host="pin-hp-1", port=2222)
        job_id = r.json()["job_id"]
        row = _poll_until(lambda: _job(client, ui_auth, job_id, state="done"))
        fp = row["host_key_fingerprint"]
        assert fp and fp.startswith("SHA256:")
        assert self._pin_row(app_module, "pin-hp-1", 2222)["fingerprint"] == fp
        assert self._pin_row(app_module, "pin-hp-1", 22) is None  # no bleed

    def _board_events(self, app_module, kind: str) -> list[dict]:
        import json as json_mod
        import sqlite3
        from conftest import DATA_DIR
        db = sqlite3.connect(DATA_DIR / "board.db")
        db.row_factory = sqlite3.Row
        rows = db.execute("SELECT payload FROM events WHERE kind=? "
                          "ORDER BY id", (kind,)).fetchall()
        db.close()
        return [json_mod.loads(r["payload"]) for r in rows]

    def test_repin_port_scoped_old_new_and_invalidation(self, client, ui_auth,
                                                        app_module,
                                                        fake_provisioner):
        canonical = prov.fingerprint_of_bytes(b"fake-host-key")
        r = _provision(client, ui_auth, host="repin-hp-1", port=2200)
        job_id = r.json()["job_id"]
        _poll_until(lambda: _job(client, ui_auth, job_id, state="done"))

        # a live job on the same identity gets invalidated by the repin
        live_id = _live_job_direct(app_module, "repin-hp-1", 2200)
        new_fp = FP_B
        rr = client.post("/api/executors/provision/host/repin-hp-1/repin"
                         "?port=2200", json={"fingerprint": new_fp},
                         headers=ui_auth)
        assert rr.status_code == 200, rr.text
        assert self._pin_row(app_module, "repin-hp-1", 2200)["fingerprint"] == new_fp
        repins = self._board_events(app_module, "provisioning.host_key_repinned")
        assert repins and repins[-1]["old"] == canonical
        assert repins[-1]["new"] == new_fp
        assert repins[-1]["port"] == 2200
        live_row = _job(client, ui_auth, live_id)
        assert live_row["state"] == "failed"
        assert live_row["error_code"] == "pin.invalidated"

    def test_repin_hex_input_normalized(self, client, ui_auth, app_module):
        hex_fp = "b" * 64  # the digest in hex form
        expected = "SHA256:" + base64.b64encode(
            bytes.fromhex(hex_fp)).decode().rstrip("=")
        rr = client.post("/api/executors/provision/host/repin-hex-1/repin",
                         json={"fingerprint": hex_fp}, headers=ui_auth)
        assert rr.status_code == 200, rr.text
        assert (self._pin_row(app_module, "repin-hex-1", 22)["fingerprint"]
                == expected)

    def test_repin_bad_host_charset_422(self, client, ui_auth):
        rr = client.post("/api/executors/provision/host/x%3B%20reboot/repin",
                         json={"fingerprint": FP_B}, headers=ui_auth)
        assert rr.status_code == 422

    def test_terminal_job_not_resurrected(self, app_module):
        job_id = _live_job_direct(app_module, "terminal-1")
        app_module.store.update_provision_job(job_id, state="failed",
                                              error_code="ssh.unreachable")
        row = app_module.store.update_provision_job(job_id, state="done")
        assert row["state"] == "failed"  # terminal is terminal


# ------------------------------------------------------- cooldown TZ (P3)
class TestCooldownTimezone:
    def test_cooldown_is_host_tz_neutral(self, client, ui_auth, app_module,
                                         monkeypatch):
        # a failed job arms the 90 s cooldown; on a non-UTC host the old
        # mktime+timezone math drifted by multiples of the offset and the
        # gate disarmed (age went negative). With TZ set to UTC+10 the
        # gate must STILL hold right after the job.
        _noop_worker(app_module, monkeypatch)
        job_id = _live_job_direct(app_module, "tz-cool-1")
        app_module.store.update_provision_job(job_id, state="failed",
                                              error_code="ssh.unreachable")
        import os
        import time as time_mod
        old_tz = os.environ.get("TZ")
        os.environ["TZ"] = "Asia/Vladivostok"
        time_mod.tzset()
        try:
            r = _provision(client, ui_auth, host="tz-cool-1")
            assert r.status_code == 429
            assert "cooldown" in r.json()["detail"]
        finally:
            if old_tz is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old_tz
            time_mod.tzset()


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
def _facts(**overrides) -> JobFacts:
    """A valid JobFacts for unit-level worker tests."""
    base = dict(job_id="pj-t", host="unit-1", port=22, auth_kind="alias",
                secret=None, passphrase=None, username="",
                harness_hint="zcode", enrollment_id="enr-t",
                executor_name="unit-1", board_url="https://b.example",
                bootstrap_token=Redacted("mne_t"),
                expected_host_key_fingerprint="")
    base |= overrides
    return JobFacts(**base)


def _bootstrap_command(conn) -> str:
    """The install command among the session's exec calls (the sudo
    preflight runs first, the CA cleanup last — P2-4/P2-3)."""
    matches = [c for c in conn.commands if c.startswith("curl")]
    assert matches, f"no bootstrap command in {conn.commands!r}"
    return matches[0]


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
