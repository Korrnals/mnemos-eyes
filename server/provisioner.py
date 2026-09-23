"""Provisioning worker — the install-time SSH channel (wave 4, blocks
A/B/D, variant α).

The board drives ONE fixed command over SSH to a remote machine:

    curl --cacert /tmp/vesmaro-lab-ca-<job>.crt -fsSL \
        {board_url}/api/poller/bootstrap.sh | sudo bash -s -- \
        --url {board_url} --token mne_… --name {name} [--harness {hint}]

The CA is delivered to the target OVER THE SSH CHANNEL (SFTP into a
job-scoped /tmp file, 0600) — the provisioner path never fetches over
unpinned TLS (no -k; TL decision 2026-09-23). See the design-doc
addendum for the manual Путь 1 deviation.

ADR 0009 Amendment 3: this is an INSTALL-TIME channel, not the execution
channel — the board→host SSH carries exactly this provisioning template
and NEVER arbitrary exec; the runtime stays outbound-only.

Security invariants implemented here:
- transit-only credentials: the mne_ token and the ssh secret live in the
  worker task's context (a Redacted wrapper) and in the module-level
  in-memory map keyed by job id; they NEVER touch SQLite, the audit
  payload or an SSE frame; a board restart fails every live job
  (provisioner.restarted) because the context is gone — honest; the
  per-job state (task handle, token maps) is dropped the moment the job
  ends — residence = job lifetime;
- mask → truncate, in that order — FIRST the protocol token patterns,
  THEN the job's own transit material, THEN the 200-char cut (truncation
  must never re-expose a masked tail);
- host-key TOFU + pin: the first connect pins the fingerprint into the
  job and the host-pin table (audit provisioning.host_key_pinned); later
  jobs ENFORCE the pin (mismatch → host_key_mismatch); re-pinning is a
  separate owner action with old→new in the audit
  (provisioning.host_key_repinned). The decision rides an SSHClient
  subclass — validate_host_public_key(host, addr, port, key) is the ONLY
  arity asyncssh actually calls (P1-2: the previous 1-arg callable as
  known_hosts= TypeError-d on every connect and could never see the key);
- the asyncssh transport is the ONLY place credentials exist as plain
  values — passed as Redacted objects unwrapped at the last moment.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import os
import re
import shlex
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from .security import mask_secrets

logger = logging.getLogger("vesmaro.provisioner")

# In-memory transit credential map: job_id → mne_ enrollment token.
# Cleared on board start (stale jobs are failed — the context is gone).
_TOKENS: dict[str, str] = {}

JOB_TIMEOUT_S = 600.0          # the whole job: 10 min
CONNECT_TIMEOUT_S = 10.0       # tcp+auth: 10 s
INSTALL_TIMEOUT_S = 300.0      # the bootstrap install leg: 5 min (P2-4 —
                               # own timeout, own code; not the job timeout)
WATCH_POLL_S = 3.0
WATCH_TIMEOUT_S = 300.0        # bootstrap install + first polls
REMOTE_CA_PATH_FMT = "/tmp/vesmaro-lab-ca-{job_id}.crt"   # 0600, job-scoped
TLS_CA_FILE_ENV = "VESMARO_TLS_CA_FILE"   # same source the ca.crt route serves


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


def mask_with_secrets(detail: str, secrets: Iterable[str], cap: int = 200) -> str:
    """describe_error plus the JOB's own transit material (the ssh
    password/key, the mne_ token): a remote shell error echoing the
    command line must never carry the values into steps, audit or SSE.
    Same hygiene order: protocol patterns, job values, THEN truncate."""
    out = mask_secrets(detail or "")
    for value in secrets:
        if value and value in out:
            out = out.replace(value, "<redacted>")
    return out[:cap]


def job_secrets(facts: JobFacts) -> list[str]:
    """The transit values of one job (Redacted unwrapped ONLY here, for
    masking — never for logging)."""
    return [wrapper.reveal() for wrapper in
            (facts.secret, facts.passphrase, facts.bootstrap_token)
            if wrapper is not None]


def read_board_ca() -> bytes:
    """The board's TLS CA — the same file the /api/poller/artifacts/ca.crt
    route serves (VESMARO_TLS_CA_FILE mount). b"" when not configured or
    unreadable: the caller fails the job honestly, it NEVER falls back to
    unpinned TLS."""
    path = os.environ.get(TLS_CA_FILE_ENV, "").strip()
    if not path:
        return b""
    try:
        return Path(path).read_bytes()
    except OSError:
        return b""


_FP_CANON_RE = re.compile(r"^SHA256:[A-Za-z0-9+/]{43}$")
_FP_HEX_RE = re.compile(r"^(?:SHA256:)?([a-fA-F0-9]{64})$")


def fingerprint_of_bytes(data: bytes) -> str:
    """The ssh-keygen standard host/key fingerprint: 'SHA256:' +
    UNPADDED base64 of sha256(blob) — byte-for-byte what `ssh-keygen -lf`
    prints (verified equal to asyncssh SSHKey.get_fingerprint())."""
    return ("SHA256:"
            + base64.b64encode(hashlib.sha256(data).digest()).decode().rstrip("="))


def normalize_fingerprint(fp: str) -> str:
    """Canonical form of an owner-supplied fingerprint (P1-3: the worker
    used to compute hex while the route accepted ssh-keygen base64 — a
    split brain that made owner-strict mode a guaranteed false mismatch
    and TOFU pins un-enterable). Accepts the standard SHA256:base64,
    'SHA256:<hex64>' and a bare hex64; anything else → '' (reject). The
    hex form IS the sha256 digest — it is re-encoded, never re-hashed."""
    fp = (fp or "").strip()
    if _FP_CANON_RE.match(fp):
        return fp
    hex_match = _FP_HEX_RE.match(fp)
    if hex_match:
        return ("SHA256:" + base64.b64encode(
            bytes.fromhex(hex_match.group(1).lower())).decode().rstrip("="))
    return ""


def host_key_fingerprint(key) -> str:
    """The presented host key's fingerprint in the canonical ssh-keygen
    form — computed over the key's wire blob (asyncssh exposes it as
    public_data; the test fake stands in with as_bytes)."""
    data = getattr(key, "public_data", None)
    if data is None:
        data = key.as_bytes()  # type: ignore[attr-defined]
    return fingerprint_of_bytes(data)


def public_key_fingerprint(private_material: str, passphrase: str = "") -> str:
    """Display fingerprint of the PUBLIC half of a private key (the job
    row material the UI shows). Best-effort: '' when the material cannot
    be parsed or asyncssh is unavailable — the route must never fail on
    display data. NEVER derives anything from a password (P2-2,
    CWE-759: the old code stored sha256(password) unsalted and returned
    it to the owner)."""
    try:
        import asyncssh  # noqa: PLC0415 — deliberate lazy import
        key = asyncssh.import_private_key(
            private_material, passphrase=(passphrase or None))
    except Exception:  # noqa: BLE001 — display material, never fatal
        return ""
    return fingerprint_of_bytes(key.public_data)


class HostKeyPolicy:
    """The TOFU/pin decision shared by the worker and the SSH transport.

    The transport calls validate() with the REAL asyncssh arity —
    (host, addr, port, key), the signature of
    SSHClient.validate_host_public_key (P1-2: a 1-arg callable passed as
    known_hosts= is called as known_hosts(host, addr, port) and crashes
    every connect; through a callable known_hosts the key never reaches
    our code at all). The validator NEVER raises: asyncssh turns a False
    return into HostKeyNotVerifiable, which the real transport maps to
    the typed host_key_mismatch ProvisioningError. The worker reads
    presented_fingerprint for the TOFU pin and rejected for diagnosis.
    """

    def __init__(self, expected: str) -> None:
        self.expected = expected
        self.presented_fingerprint = ""
        self.rejected = False

    def validate(self, host: str, addr: str, port: int, key) -> bool:
        fp = host_key_fingerprint(key)
        self.presented_fingerprint = fp
        if self.expected and fp != self.expected:
            self.rejected = True
            return False
        return True


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
        live = [t for t in self._tasks.values() if not t.done()]
        if live:
            await asyncio.wait(live, timeout=timeout)

    async def _guarded_run(self, facts: JobFacts) -> None:
        try:
            await asyncio.wait_for(self._run(facts), timeout=JOB_TIMEOUT_S)
        except ProvisioningError as exc:
            self._finish_failed(facts, exc.code, exc.detail)
        except asyncio.TimeoutError:
            self._finish_failed(facts, "timeout", "job exceeded 10 min")
        except Exception as exc:  # defensive: a worker must never crash the loop
            logger.exception("provision job %s crashed", facts.job_id)
            self._finish_failed(facts, "internal", describe_error(str(exc)))
        finally:
            # residence = job lifetime: the task handle and the transit
            # maps are dropped the moment the job ends (P3: _tasks used to
            # grow forever; the enrollment→token material used to outlive
            # the job it was minted for)
            self._tasks.pop(facts.job_id, None)
            forget(facts.job_id, facts.enrollment_id)

    # --------------------------------------------------------------- steps
    def _step(self, job_id: str, state: str | None, text: str) -> None:
        row = self._store.update_provision_job(job_id, state=state, step=text)
        if row is not None:
            self._broadcast({"kind": "provisioning.progress", "job_id": job_id,
                             "state": row["state"], "step": text[:200]})

    def _finish_failed(self, facts: JobFacts, code: str, detail: str) -> None:
        safe = mask_with_secrets(detail, job_secrets(facts))
        self._store.update_provision_job(facts.job_id, state="failed", error_code=code)
        self._audit(kind="provisioning.failed", payload={
            "job_id": facts.job_id, "error_code": code, "detail": safe})
        self._broadcast({"kind": "provisioning.failed", "job_id": facts.job_id,
                         "error_code": code, "detail": safe})
        _TOKENS.pop(facts.job_id, None)

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
        secrets = job_secrets(facts)

        def step(state: str | None, text: str) -> None:
            self._step(facts.job_id, state, mask_with_secrets(text, secrets))

        self._audit(kind="provisioning.created", payload={
            "job_id": facts.job_id, "host": facts.host, "port": facts.port,
            "auth_kind": facts.auth_kind, "enrollment_id": facts.enrollment_id})
        step("connecting", f"ssh connect {facts.host}:{facts.port}")

        known_pin = self._store.get_host_pin(facts.host)
        expected = facts.expected_host_key_fingerprint or (
            known_pin["fingerprint"] if known_pin else "")
        policy = HostKeyPolicy(expected=expected)

        try:
            session = await asyncio.wait_for(
                self._ssh_connect(facts, policy), timeout=CONNECT_TIMEOUT_S)
        except ProvisioningError:
            raise
        except (asyncio.TimeoutError, TimeoutError):
            raise ProvisioningError(
                "ssh.unreachable", f"{facts.host}:{facts.port} timed out") from None
        except Exception as exc:
            # auth/unreachable classification for transports that do not
            # map it themselves (asyncssh maps PermissionDenied at the
            # boundary — see _asyncssh_connect)
            detail = describe_error(str(exc))
            code = "ssh.auth_failed" if "auth" in detail.lower() else "ssh.unreachable"
            raise ProvisioningError(code, detail) from exc

        try:
            if not expected:
                # TOFU: first contact — pin what the host presented.
                fp = policy.presented_fingerprint
                if fp:
                    self._store.set_host_pin(facts.host, fp)
                    self._store.update_provision_job(
                        facts.job_id, host_key_fingerprint=fp)
                    self._audit(kind="provisioning.host_key_pinned", payload={
                        "job_id": facts.job_id, "host": facts.host,
                        "fingerprint": fp})
                    step(None, f"host key pinned (TOFU): {fp}")

            # Sudo preflight (design §A, P2-4): the bootstrap is a root
            # operation — a typed, separate exec BEFORE the install gives
            # the owner ssh.sudo_required instead of a bootstrap exit N.
            pre = await session.run("sudo -n true")
            if pre.exit_status != 0:
                raise ProvisioningError(
                    "ssh.sudo_required",
                    "sudo -n preflight failed — passwordless root is required "
                    "for the bootstrap install")

            # P2-3 (TL decision): the CA rides the SSH channel into a
            # job-scoped 0600 tmp file; the install fetches everything
            # over PINNED TLS. No -k on this path, ever.
            ca = read_board_ca()
            if not ca:
                raise ProvisioningError(
                    "ca.unavailable",
                    f"the board CA is not configured ({TLS_CA_FILE_ENV}) — the "
                    "provisioner never fetches over unpinned TLS")
            remote_ca = REMOTE_CA_PATH_FMT.format(job_id=facts.job_id)
            await session.upload_file(remote_ca, ca)

            step("installing", "running the bootstrap one-liner (pinned TLS)")
            command = self.bootstrap_command(facts, _TOKENS.get(facts.job_id, ""),
                                             ca_path=remote_ca)
            try:
                result = await asyncio.wait_for(session.run(command),
                                                timeout=INSTALL_TIMEOUT_S)
            except (asyncio.TimeoutError, TimeoutError):
                raise ProvisioningError(
                    "bootstrap.timeout",
                    f"the install leg exceeded {int(INSTALL_TIMEOUT_S)}s") from None
            finally:
                with contextlib.suppress(Exception, asyncio.TimeoutError):
                    await asyncio.wait_for(
                        session.run(f"rm -f {shlex.quote(remote_ca)}"), timeout=10.0)
            out = mask_with_secrets((result.stderr or "") + (result.stdout or ""),
                                    secrets)
            if result.exit_status != 0:
                raise ProvisioningError(
                    f"bootstrap.exit.{result.exit_status}",
                    f"bootstrap exit {result.exit_status}: {out}")

            step("watching", "bootstrap finished — watching the enrollment")
        finally:
            with contextlib.suppress(Exception):
                session.close()

        deadline = time.monotonic() + WATCH_TIMEOUT_S
        while time.monotonic() < deadline:
            row = self._store.get_enrollment(facts.enrollment_id)
            if row is not None and row.get("state") == "used" and row.get("executor_id"):
                step("done",
                     f"executor {row['executor_id']} registered — awaiting owner approval")
                self._finish_ok(facts.job_id, row["executor_id"])
                return
            await asyncio.sleep(self._watch_poll_s)
        raise ProvisioningError(
            "register.timeout",
            "the enrollment token was not consumed in time — did the bootstrap run?")

    # ------------------------------------------------- the FROZEN template
    @staticmethod
    def bootstrap_command(facts: JobFacts, token: str, ca_path: str) -> str:
        """The one-liner of REMOTE-EXECUTOR.md Путь 1 with every argument
        shlex.quote-d and the fetch pinned to the SSH-delivered CA (P2-3:
        no -k on the provisioner path). The token is mne_-shaped by
        construction; the command line is not logged."""
        parts = [f"--url {shlex.quote(facts.board_url)}",
                 f"--token {shlex.quote(token)}",
                 f"--name {shlex.quote(facts.executor_name)}"]
        if facts.harness_hint:
            parts.append(f"--harness {shlex.quote(facts.harness_hint)}")
        return (f"curl --cacert {shlex.quote(ca_path)}"
                f" -fsSL {shlex.quote(facts.board_url)}/api/poller/bootstrap.sh"
                f" | sudo bash -s -- " + " ".join(parts))

    # ------------------------------------------------------- real transport
    @staticmethod
    async def _asyncssh_connect(facts: JobFacts, policy: HostKeyPolicy):
        """Production transport (asyncssh, pinned in requirements.txt).

        Host-key validation rides a client_factory SSHClient subclass:
        asyncssh calls validate_host_public_key(host, addr, port, key) —
        the exact arity HostKeyPolicy.validate exposes. The known_hosts
        matcher trusts NOTHING by itself, so every presented key reaches
        the policy (P1-2: known_hosts=None would silently DISABLE the
        validator — _trusted_host_keys becomes None — and a 1-arg
        callable in that slot TypeError-d on every connect). asyncssh
        turns a policy False into HostKeyNotVerifiable, mapped here to
        the typed host_key_mismatch; PermissionDenied maps to
        ssh.auth_failed (P2-4). Imported lazily so tests and
        non-provisioning installs do not pay for asyncssh."""
        import asyncssh  # noqa: PLC0415 — deliberate lazy import

        kwargs: dict[str, Any] = {
            "port": facts.port,
            "known_hosts": _trust_nothing,
            "client_factory": _pinned_client_factory(policy),
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
        try:
            conn = await asyncssh.connect(facts.host, **kwargs)
        except asyncssh.HostKeyNotVerifiable as exc:
            if policy.rejected:
                raise ProvisioningError(
                    "host_key_mismatch",
                    f"host key {policy.presented_fingerprint} does not match "
                    f"the pinned/expected {policy.expected}") from exc
            raise ProvisioningError(
                "host_key_mismatch", describe_error(str(exc))) from exc
        except asyncssh.PermissionDenied as exc:
            raise ProvisioningError(
                "ssh.auth_failed", describe_error(str(exc))) from exc
        return _RemoteSession(conn)


def _trust_nothing(host: str, addr: str, port: int | None):
    """known_hosts matcher that pins NOTHING itself — the SSHClient
    validator (HostKeyPolicy) is the single decision point. Returning no
    trusted keys keeps asyncssh's internal trusted set empty, which is
    exactly the state in which every presented key is routed to
    validate_host_public_key (verified against asyncssh 2.24.0 source:
    connection.py _validate_host_key / known_hosts.py match_known_hosts)."""
    return [], [], []


def _pinned_client_factory(policy: HostKeyPolicy):
    """client_factory (called with NO arguments by asyncssh) producing a
    client class bound to this job's host-key policy."""
    from asyncssh import SSHClient  # noqa: PLC0415 — lazy like the transport

    class _PinnedHostClient(SSHClient):
        def validate_host_public_key(self, host: str, addr: str,
                                     port: int, key) -> bool:
            return policy.validate(host, addr, port, key)

    return _PinnedHostClient


class _RemoteResult:
    """The exec-result surface the worker codes against."""

    def __init__(self, exit_status: int, stderr: str, stdout: str) -> None:
        self.exit_status = exit_status
        self.stderr = stderr
        self.stdout = stdout


class _RemoteSession:
    """The connection surface the worker codes against: run(command),
    upload_file(path, data) (SFTP; the CA leg, P2-3), close(). Wraps an
    asyncssh SSHClientConnection; the test fake implements the same trio
    so the worker logic stays transport-agnostic."""

    def __init__(self, conn) -> None:
        self._conn = conn

    async def run(self, command: str) -> _RemoteResult:
        result = await self._conn.run(command)
        return _RemoteResult(result.exit_status,
                             result.stderr or "", result.stdout or "")

    async def upload_file(self, remote_path: str, data: bytes) -> None:
        """SFTP upload creating the file 0600 AT OPEN TIME (attrs ride
        the open request), chmod again after write as belt-and-braces for
        servers that ignore create-attrs."""
        from asyncssh.sftp import SFTPAttrs  # noqa: PLC0415 — lazy import

        async with self._conn.start_sftp_client() as sftp:
            async with sftp.open(remote_path, "wb",
                                 attrs=SFTPAttrs(permissions=0o600)) as handle:
                await handle.write(data)
            with contextlib.suppress(Exception):
                await sftp.chmod(remote_path, 0o600)

    def close(self) -> None:
        self._conn.close()


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
        # Transport hygiene (design §B): asyncssh logs handshake and host-
        # key details at DEBUG/INFO — never in prod (its own logger is
        # namespaced, the board's log config is untouched).
        logging.getLogger("asyncssh").setLevel(logging.WARNING)
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
