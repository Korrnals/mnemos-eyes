"""bootstrap.sh trust anchor (AGW-9, АРХКОМ-8 В1) — bash harness.

The REAL script runs against a fake world: stub ``curl`` (serves a real
openssl-generated CA), stub ``id`` (fake root — CI is not root), stub
``systemctl``, a ``python3`` shim that fakes ONLY the version probe and
execs the real interpreter otherwise (normalize_fp rides real python).
openssl stays REAL: the fingerprint pipeline and the CA:TRUE check must
be the production ones.

Happy-path runs stop at the venv step: ``python3 -m venv /opt/mnemos-eyes``
fails for a non-root CI user — a deterministic, assertable proof the run
got PAST the anchor gate (die message names the venv, exit 3).

QA matrix:
- anchor flag: mismatch → abort, downloaded CA discarded; match → gate
  passed (and the bash-computed canon equals the python canon — the
  openssl pipeline is cross-checked against provisioner);
- env synonym VESMARO_EXPECT_FP ≡ --expect-fp;
- pre-placed CA: no curl at all; a matching anchor still verifies; a
  MISMATCHING anchor aborts but PRESERVES the owner's file;
- no anchor, no tty (setsid) → honest abort naming --expect-fp;
- interactive TOFU via a real pty (util-linux ``script``): typing the
  canon (or the openssl hex form — normalize parity) passes, garbage or
  empty aborts with the CA discarded;
- garbage --expect-fp shape → exit 2 before any network.
"""

from __future__ import annotations

import hashlib
import os
import pty
import shlex
import shutil
import ssl
import subprocess
import threading
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
BOOTSTRAP_SH = REPO / "deploy" / "poller" / "bootstrap.sh"

VENV_DIE = "could not create the venv"


def _canon(der: bytes) -> str:
    from server.provisioner import fingerprint_of_bytes
    return fingerprint_of_bytes(der)


@pytest.fixture(scope="module")
def lab_ca(tmp_path_factory):
    """A real self-signed CA (CA:TRUE) + its canon fingerprint."""
    d = tmp_path_factory.mktemp("agw9-ca")
    ca = d / "ca.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-days", "1", "-subj", "/CN=vesmaro-agw9-test-ca",
         "-addext", "basicConstraints=critical,CA:TRUE",
         "-keyout", str(d / "key.pem"), "-out", str(ca)],
        check=True, capture_output=True)
    der = ssl.PEM_cert_to_DER_cert(ca.read_text())
    return {"pem": ca, "der": der, "canon": _canon(der),
            "hex": hashlib.sha256(der).hexdigest()}


@pytest.fixture()
def stubs(tmp_path, lab_ca):
    """The fake world: PATH-first stub dir + per-test CA target + curl log."""
    d = tmp_path / "stubs"
    d.mkdir()
    log = tmp_path / "curl.log"
    ca_target = tmp_path / "lab-ca.crt"
    (d / "curl").write_text(
        "#!/usr/bin/env bash\n"
        'LOG="${VESMARO_CURL_LOG:-/dev/null}"\n'
        'echo "$*" >> "$LOG"\n'
        'out=""; skip=0\n'
        'for a in "$@"; do\n'
        "  if [[ $skip -eq 1 ]]; then out=\"$a\"; skip=0; continue; fi\n"
        '  [[ "$a" == "-o" ]] && skip=1\n'
        "done\n"
        'if [[ "$*" == *"/api/poller/artifacts/ca.crt"* && -n "$out" ]]; then\n'
        f'  cat "{lab_ca["pem"]}" > "$out"\n'
        "  exit 0\n"
        "fi\n"
        "exit 1\n")
    (d / "curl").chmod(0o755)
    (d / "id").write_text("#!/usr/bin/env bash\necho 0\n")
    (d / "id").chmod(0o755)
    (d / "systemctl").write_text("#!/usr/bin/env bash\nexit 0\n")
    (d / "systemctl").chmod(0o755)
    # The python3 shim: fake ONLY the preflight version probe; everything
    # else (normalize_fp heredoc, venv attempt) goes to the real one.
    real_python = shutil.which("python3")
    (d / "python3").write_text(
        "#!/usr/bin/env bash\n"
        'if [[ "$1" == "-c" && "$2" == *version_info* ]]; then echo 310; exit 0; fi\n'
        f'exec "{real_python}" "$@"\n')
    (d / "python3").chmod(0o755)
    return {"dir": d, "log": log, "ca_target": ca_target}


def _run(stubs, *args, env_extra=None, use_pty=False, feed=None,
         detach_tty=False):
    env = {"PATH": f"{stubs['dir']}:{__import__('os').environ['PATH']}",
           "VESMARO_CA_FILE": str(stubs["ca_target"]),
           "VESMARO_CURL_LOG": str(stubs["log"]),
           "HOME": os.environ.get("HOME", "/root")}
    env.update(env_extra or {})
    cmd = ["bash", str(BOOTSTRAP_SH),
           "--url", "https://board.agw9.test",
           "--token", "mne_agw9_testtoken", *args]
    if use_pty:
        # A REAL interactive contour: a fresh pty whose slave the child
        # (setsid → session leader) opens itself — that open both wires
        # stdio and ACQUIRES the pty as the controlling terminal, so
        # /dev/tty resolves in-script. The parent keeps its slave fd open
        # until the child exits: closing earlier races the child's own
        # open and the master read errors out (EIO) mid-run.
        assert feed is not None
        master, slave = pty.openpty()
        dev = os.ttyname(slave)
        inner = (f"exec 0<{dev} 1>{dev} 2>&1; "
                 + " ".join(shlex.quote(c) for c in cmd))
        proc = subprocess.Popen(["setsid", "bash", "-c", inner],
                                close_fds=True, env=env)
        out: list[bytes] = []

        def _reader() -> None:
            while True:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                out.append(chunk)

        reader = threading.Thread(target=_reader)
        reader.start()
        time.sleep(0.3)                     # let the child reach the prompt
        os.write(master, feed.encode())
        proc.wait(timeout=60)
        os.close(slave)                     # release → reader drains → EIO
        reader.join(timeout=10)
        os.close(master)
        return subprocess.CompletedProcess(
            cmd, proc.returncode, b"".join(out).decode(errors="replace"), "")
    if detach_tty:
        # setsid: no controlling terminal at all → /dev/tty unopenable.
        return subprocess.run(
            ["setsid", "--", *cmd], stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=60, env=env)
    return subprocess.run(cmd, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=60, env=env)


# ------------------------------------------------------------ anchor flag
class TestAnchorFlag:
    def test_mismatch_aborts_and_discards_downloaded_ca(self, stubs, lab_ca):
        wrong = lab_ca["canon"][:8] + ("A" if lab_ca["canon"][8] != "A" else "B") + lab_ca["canon"][9:]
        r = _run(stubs, "--expect-fp", wrong, detach_tty=True)
        assert r.returncode == 3
        assert "MISMATCH" in r.stdout + r.stderr
        assert not stubs["ca_target"].exists()      # fail-closed: discarded

    def test_match_passes_gate_and_bash_canon_equals_python(self, stubs,
                                                            lab_ca):
        r = _run(stubs, "--expect-fp", lab_ca["canon"], detach_tty=True)
        # gate passed: the anchor line names the bash-computed canon …
        assert f"verified against the anchor: {lab_ca['canon']}" in r.stdout
        # … which equals the python canon (openssl pipeline cross-check)
        assert stubs["ca_target"].exists()
        # … and the run continued past TLS into the venv step
        assert r.returncode == 3 and VENV_DIE in r.stdout + r.stderr

    def test_env_synonym_vesmaro_expect_fp(self, stubs, lab_ca):
        r = _run(stubs, env_extra={"VESMARO_EXPECT_FP": lab_ca["canon"]},
                 detach_tty=True)
        assert f"verified against the anchor: {lab_ca['canon']}" in r.stdout
        assert VENV_DIE in r.stdout + r.stderr

    def test_hex_form_accepted_via_normalize(self, stubs, lab_ca):
        r = _run(stubs, "--expect-fp", lab_ca["hex"], detach_tty=True)
        assert f"verified against the anchor: {lab_ca['canon']}" in r.stdout

    def test_garbage_shape_is_arg_error_before_network(self, stubs):
        r = _run(stubs, "--expect-fp", "definitely-not-a-fingerprint")
        assert r.returncode == 2
        assert "expect-fp" in r.stdout + r.stderr
        assert not stubs["log"].exists()            # no curl happened


# ------------------------------------------------------------ pre-placed CA
class TestPrePlacedCa:
    def test_no_fetch_and_anchor_still_verified(self, stubs, lab_ca):
        shutil.copyfile(lab_ca["pem"], stubs["ca_target"])
        r = _run(stubs, "--expect-fp", lab_ca["canon"], detach_tty=True)
        assert "pre-placed" in r.stdout
        assert not stubs["log"].exists() or stubs["log"].read_text() == ""
        assert f"verified against the anchor: {lab_ca['canon']}" in r.stdout
        assert VENV_DIE in r.stdout + r.stderr

    def test_mismatch_aborts_but_preserves_owner_file(self, stubs, lab_ca):
        shutil.copyfile(lab_ca["pem"], stubs["ca_target"])
        wrong = lab_ca["canon"][:8] + ("A" if lab_ca["canon"][8] != "A" else "B") + lab_ca["canon"][9:]
        r = _run(stubs, "--expect-fp", wrong, detach_tty=True)
        assert r.returncode == 3 and "MISMATCH" in r.stdout + r.stderr
        # the pre-placed file is the OWNER's — never deleted, install aborts
        assert stubs["ca_target"].read_bytes() == lab_ca["pem"].read_bytes()

    def test_no_anchor_pre_placed_skips_prompt(self, stubs, lab_ca):
        """Placement IS the out-of-band act: unattended re-run stays
        non-interactive (no prompt, no abort) on the pre-placed path."""
        shutil.copyfile(lab_ca["pem"], stubs["ca_target"])
        r = _run(stubs, detach_tty=True)
        assert "no prompt" in r.stdout
        assert VENV_DIE in r.stdout + r.stderr


# --------------------------------------------------------- interactive TOFU
class TestInteractiveTofu:
    @pytest.mark.skipif(shutil.which("script") is None,
                        reason="util-linux script(1) not available")
    def test_typed_canon_confirmed(self, stubs, lab_ca):
        r = _run(stubs, use_pty=True, feed=lab_ca["canon"] + "\n")
        assert lab_ca["canon"] in r.stdout                # printed for TOFU
        assert "confirmed by the operator" in r.stdout
        assert VENV_DIE in r.stdout + r.stderr

    @pytest.mark.skipif(shutil.which("script") is None,
                        reason="util-linux script(1) not available")
    def test_typed_openssl_hex_form_confirmed(self, stubs, lab_ca):
        r = _run(stubs, use_pty=True, feed=lab_ca["hex"] + "\n")
        assert "confirmed by the operator" in r.stdout

    @pytest.mark.skipif(shutil.which("script") is None,
                        reason="util-linux script(1) not available")
    def test_typed_garbage_aborts_and_discards(self, stubs, lab_ca):
        r = _run(stubs, use_pty=True, feed="SHA256:garbage\n")
        assert r.returncode == 3
        assert "does not match" in r.stdout + r.stderr
        assert not stubs["ca_target"].exists()

    @pytest.mark.skipif(shutil.which("script") is None,
                        reason="util-linux script(1) not available")
    def test_empty_enter_is_a_refusal(self, stubs, lab_ca):
        r = _run(stubs, use_pty=True, feed="\n")
        assert r.returncode == 3
        assert "does not match" in r.stdout + r.stderr
        assert not stubs["ca_target"].exists()


# ------------------------------------------------------------------ no tty
class TestNoTty:
    def test_no_anchor_no_tty_honest_abort(self, stubs, lab_ca):
        r = _run(stubs, detach_tty=True)
        assert r.returncode == 3
        assert "--expect-fp" in r.stdout + r.stderr
        assert "/dev/tty" in r.stdout + r.stderr
        assert not stubs["ca_target"].exists()
