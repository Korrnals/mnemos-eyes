"""Provisioning worker — the install-time SSH channel (wave 4, blocks
A/B/D, variant α).

The board drives ONE fixed command over SSH to a remote machine:

    curl -kfsSL {board_url}/api/poller/bootstrap.sh | sudo bash -s -- \
        --url {board_url} --token mne_… --name {name} [--harness {hint}]

ADR 0009 Amendment 3: this is an INSTALL-TIME channel, not the execution
channel — the board→host SSH carries exactly this provisioning template
and NEVER arbitrary exec; the runtime stays outbound-only.

Security invariants implemented here:
- transit-only credentials: the mne_ token and the ssh secret live in the
  worker task's context (a Redacted wrapper) and in the module-level
  in-memory map keyed by job id; they NEVER touch SQLite, the audit
  payload or an SSE frame; a board restart fails every live job
  (provisioner.restarted) because the context is gone — honest;
- mask → truncate, in that order: command output is mask_secrets()-ed
  FIRST, then truncated to 200 chars (truncation must never re-expose a
  masked tail);
- host-key TOFU + pin: the first connect pins sha256(fingerprint) into
  the job and the host-pin table (audit provisioning.host_key_pinned);
  later jobs ENFORCE the pin (mismatch → host_key_mismatch); re-pinning
  is a separate owner action with old→new in the audit
  (provisioning.host_key_repinned);
- the asyncssh transport is the ONLY place credentials exist as plain
  values — passed as Redacted objects unwrapped at the last moment.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import shlex
import time
from dataclasses import dataclass
from typing import Any, Callable

from .security import mask_secrets

logger = logging.getLogger("vesmaro.provisioner")

# In-memory transit credential map: job_id → mne_ enrollment token.
# Cleared on board start (stale jobs are failed — the context is gone).
_TOKENS: dict[str, str] = {}

JOB_TIMEOUT_S = 600.0          # the whole job: 10 min
CONNECT_TIMEOUT_S = 10.0       # tcp+auth: 10 s
WATCH_POLL_S = 3.0
WATCH_TIMEOUT_S = 300.0        # bootstrap install + first polls


class ProvisioningError(Exception):
    """A typed step failure; code feeds provision_jobs.error_code."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


@dataclass
class Redacted:
    """A transit credential wrapper: the value exists, the repr never
    shows it (loggers, tracebacks, f-string accidents all see
    'Redacted(…)'). Unwrapped ONLY at the asyncssh call boundary."""

    value: str

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return "Redacted(<masked>)"

    def __str__(self) -> str:
        return "Redacted(<masked>)"

    def reveal(self) -> str:
        return self.value


def describe_error(detail: str, cap: int = 200) -> str:
    """Mask FIRST, truncate SECOND (protocol hygiene order)."""
    return mask_secrets(detail or "")[:cap]


def host_key_fingerprint(key) -> str:
    """sha256 of the ssh host key in the standard SHA256:b64 form."""
    return f"SHA256:{hashlib.sha256(key.as_bytes()).digest().hex()}"  # type: ignore[attr-defined]


@dataclass
class JobFacts:
    """Everything the worker needs for one job — assembled by the route
    (which owns the anti-spray gates and the enrollment mint)."""

    job_id: str
    host: str
    port: int
    auth_kind: str                 # password | key | alias
    secret: Redacted | None        # password or private key material
    passphrase: Redacted | None
    username: str
    harness_hint: str
    enrollment_id: str
    executor_name: str
    board_url: str
    bootstrap_token: Redacted      # the mne_ token for the bootstrap command
    expected_host_key_fingerprint: str


class Provisioner:
    """Drives provision jobs: an asyncio task per job, a worker-side
    injectable `ssh_connect` (tests substitute a fake; production wires
    asyncssh)."""

    def __init__(self, store, audit, broadcast, ssh_connect: Callable | None = None,
                 watch_poll_s: float = WATCH_POLL_S) -> None:
        self._store = store
        self._audit = audit
        self._broadcast = broadcast
        self._ssh_connect = ssh_connect or self._asyncssh_connect
        self._watch_poll_s = watch_poll_s
        self._tasks: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------- worker
    def start_job(self, facts: JobFacts) -> None:
        task = asyncio.create_task(self._guarded_run(facts))
        self._tasks[facts.job_id] = task

    async def drain(self, timeout: float = 5.0) -> None:
        """Test/lifecycle helper: wait for all running job tasks."""
        if not self._tasks:
            return
        await asyncio.wait(asyncio.all_tasks(
            [t for t in self._tasks.values() if not t.done()]), timeout=timeout)

    def fail_live_jobs_on_restart(self) -> int:
        rows = self._store.fail_live_provision_jobs()
        _TOKENS.clear()
        for row in rows:
            self._broadcast({"kind": "provisioning.failed",
                             "job_id": row["id"], "error_code": "provisioner.restarted"})
        return len(rows)

    async def _guarded_run(self, facts: JobFacts) -> None:
        try:
            await asyncio.wait_for(self._run(facts), timeout=JOB_TIMEOUT_S)
        except ProvisioningError as exc:
            self._finish_failed(facts.job_id, exc.code, exc.detail)
        except asyncio.TimeoutError:
            self._finish_failed(facts.job_id, "timeout", "job exceeded 10 min")
        except Exception as exc:  # defensive: a worker must never crash the loop
            logger.exception("provision job %s crashed", facts.job_id)
            self._finish_failed(facts.job_id, "internal", describe_error(str(exc)))

    # --------------------------------------------------------------- steps
    def _step(self, job_id: str, state: str | None, text: str) -> None:
        row = self._store.update_provision_job(job_id, state=state, step=text)
        if row is not None:
            self._broadcast({"kind": "provisioning.progress", "job_id": job_id,
                             "state": row["state"], "step": text[:200]})

    def _finish_failed(self, job_id: str, code: str, detail: str) -> None:
        safe = describe_error(detail)
        self._store.update_provision_job(job_id, state="failed", error_code=code)
        self._audit(kind="provisioning.failed", payload={
            "job_id": job_id, "error_code": code, "detail": safe})
        self._broadcast({"kind": "provisioning.failed", "job_id": job_id,
                         "error_code": code, "detail": safe})
        _TOKENS.pop(job_id, None)

    def _finish_ok(self, job_id: str, executor_id: str) -> None:
        self._store.update_provision_job(job_id, state="done")
        self._audit(kind="provisioning.ok", payload={
            "job_id": job_id, "executor_id": executor_id})
        self._broadcast({"kind": "provisioning.ok", "job_id": job_id,
                         "executor_id": executor_id})
        _TOKENS.pop(job_id, None)

    def _audit(self, *, kind: str, payload: dict[str, Any]) -> None:
        self._store.log_board_event(kind, payload)

    # ------------------------------------------------------------ the job
    async def _run(self, facts: JobFacts) -> None:
        self._audit(kind="provisioning.created", payload={
            "job_id": facts.job_id, "host": facts.host, "port": facts.port,
            "auth_kind": facts.auth_kind, "enrollment_id": facts.enrollment_id})
        self._step(facts.job_id, "connecting", f"ssh connect {facts.host}:{facts.port}")

        known_pin = self._store.get_host_pin(facts.host)
        expected = facts.expected_host_key_fingerprint or (
            known_pin["fingerprint"] if known_pin else "")
        got_fp = {"value": ""}

        def host_key_check(key) -> bool:  # asyncssh host key validator
            fp = host_key_fingerprint(key)
            got_fp["value"] = fp
            if expected and fp != expected:
                raise ProvisioningError(
                    "host_key_mismatch",
                    f"host key {fp} does not match the pinned/expected {expected}")
            return True

        try:
            conn = await asyncio.wait_for(
                self._ssh_connect(facts, host_key_check), timeout=CONNECT_TIMEOUT_S)
        except ProvisioningError:
            raise
        except (asyncio.TimeoutError, TimeoutError):
            raise ProvisioningError("ssh.unreachable", f"{facts.host}:{facts.port} timed out")
        except Exception as exc:
            detail = describe_error(str(exc))
            code = "ssh.auth_failed" if "auth" in detail.lower() else "ssh.unreachable"
            raise ProvisioningError(code, detail) from exc

        try:
            if not expected:
                # TOFU: first contact — pin what the host presented.
                fp = got_fp["value"] or ""
                if fp:
                    self._store.set_host_pin(facts.host, fp)
                    self._store.update_provision_job(
                        facts.job_id, host_key_fingerprint=fp)
                    self._audit(kind="provisioning.host_key_pinned", payload={
                        "job_id": facts.job_id, "host": facts.host,
                        "fingerprint": fp})
                    self._step(facts.job_id, None,
                               f"host key pinned (TOFU): {fp}")

            self._step(facts.job_id, "installing", "running the frozen bootstrap one-liner")
            command = self.bootstrap_command(facts, _TOKENS.get(facts.job_id, ""))
            result = await conn.run(command)
            out = describe_error((result.stderr or "") + (result.stdout or ""))
            if result.exit_status != 0:
                raise ProvisioningError(
                    f"bootstrap.exit.{result.exit_status}",
                    f"bootstrap exit {result.exit_status}: {out}")

            self._step(facts.job_id, "watching",
                       "bootstrap finished — watching the enrollment")
        finally:
            with contextlib.suppress(Exception):
                conn.close()

        deadline = time.monotonic() + WATCH_TIMEOUT_S
        while time.monotonic() < deadline:
            row = self._store.get_enrollment(facts.enrollment_id)
            if row is not None and row.get("state") == "used" and row.get("executor_id"):
                self._step(facts.job_id, "done",
                           f"executor {row['executor_id']} registered — awaiting owner approval")
                self._finish_ok(facts.job_id, row["executor_id"])
                return
            await asyncio.sleep(self._watch_poll_s)
        raise ProvisioningError(
            "register.timeout",
            "the enrollment token was not consumed in time — did the bootstrap run?")

    # ------------------------------------------------- the FROZEN template
    @staticmethod
    def bootstrap_command(facts: JobFacts, token: str) -> str:
        """The one-liner of REMOTE-EXECUTOR.md Путь 1 with EVERY argument
        shlex.quote-d — layer two of the injection defence (design §B):
        the route boundary enforces strict charsets, this quoting keeps
        the command safe even if a value ever slips past it (the
        reuse_enrollment_id path skipped enrollment validation once —
        the quote is the layer that must not care). The token is
        mne_-shaped by construction; the command line is never logged."""
        parts = [f"--url {shlex.quote(facts.board_url)}",
                 f"--token {shlex.quote(token)}",
                 f"--name {shlex.quote(facts.executor_name)}"]
        if facts.harness_hint:
            parts.append(f"--harness {shlex.quote(facts.harness_hint)}")
        return (f"curl -kfsSL {shlex.quote(facts.board_url)}/api/poller/bootstrap.sh"
                f" | sudo bash -s -- " + " ".join(parts))

    # ------------------------------------------------------- real transport
    @staticmethod
    async def _asyncssh_connect(facts: JobFacts, host_key_check: Callable):
        """Production transport. Imported lazily so tests and
        non-provisioning installs do not pay for asyncssh."""
        import asyncssh  # noqa: PLC0415 — deliberate lazy import

        kwargs: dict[str, Any] = {
            "port": facts.port,
            "known_hosts": host_key_check,  # asyncssh validator callable
            "login_timeout": CONNECT_TIMEOUT_S,
            "client_keys": None,
            "allow_agent": False,
        }
        if facts.username:
            kwargs["username"] = facts.username
        kind = facts.auth_kind
        if kind == "password":
            kwargs["password"] = facts.secret.reveal()
            if facts.passphrase is not None:
                kwargs["passphrase"] = facts.passphrase.reveal()
        elif kind == "key":
            kwargs["client_keys"] = [
                asyncssh.import_private_key(facts.secret.reveal(),
                                            passphrase=(facts.passphrase.reveal()
                                                        if facts.passphrase else None))]
        elif kind == "alias":
            # "alias" = use the running ssh-agent / default keys; the host
            # and port are REAL values (the config-file alias resolution is
            # NOT provided by asyncssh — documented deviation).
            kwargs["allow_agent"] = True
        return await asyncssh.connect(facts.host, **kwargs)


# ------------------------------------------------------ module-level wiring
# One Provisioner per process (the board app wires it with its store and
# its SSE broadcast). The transit-token maps are module-level BY DESIGN:
# they die with the process, which is what makes a restart's stale jobs
# honestly failed.
_provisioner: Provisioner | None = None
_BY_ENROLLMENT: dict[str, str] = {}


def get(store, broadcast) -> Provisioner:
    """Lazy singleton wired to the app's store and broadcast."""
    global _provisioner
    if _provisioner is None:
        _provisioner = Provisioner(store, audit=store.log_board_event,
                                   broadcast=broadcast)
    return _provisioner


def remember(job_id: str, enrollment_id: str, token: str) -> None:
    """Transit map write (the ONLY place a token is stored): job→token for
    the worker, enrollment→token for reuse of a live token by a retry."""
    _TOKENS[job_id] = token
    _BY_ENROLLMENT[enrollment_id] = token


def reveal_by_enrollment(enrollment_id: str) -> str:
    """Material of a LIVE provisioning-minted token (a UI-minted token has
    no material here — hash-only storage means reuse is impossible for
    those, by design)."""
    return _BY_ENROLLMENT.get(enrollment_id, "")


def forget(job_id: str, enrollment_id: str) -> None:
    _TOKENS.pop(job_id, None)
    _BY_ENROLLMENT.pop(enrollment_id, None)


def fail_stale(store, broadcast) -> int:
    """Board-start housekeeping: live jobs die with the old process."""
    rows = store.fail_live_provision_jobs()
    for row in rows:
        _TOKENS.pop(row["id"], None)
        _BY_ENROLLMENT.pop(row.get("enrollment_id", ""), None)
        broadcast({"kind": "provisioning.failed", "job_id": row["id"],
                   "error_code": "provisioner.restarted"})
    return len(rows)
