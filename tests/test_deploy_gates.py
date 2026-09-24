"""scripts/deploy.sh — the ONLY door to prod (AGW-10, АРХКОМ-8 В3).

Bash gates tested as UNITS (the script is source-able: the dispatch is
source-guarded) plus subcommand end-to-end runs against a fake world —
stub git/helm/podman/sync-version recording every call. No real helm,
no cluster, no image build EVER runs here.

QA matrix:
- preflight: HEAD==origin/main + clean tree; drift/dirty refuse;
- version gate: sync-version --check failure refuses;
- lock: free lock acquires, a held lock refuses (holder identified);
- history gate: deployed passes; failed / pending-upgrade refuse with
  the repair/rollback hint; --skip-history-gate is repair+rollback-only
  (deploy/verify: arg error; rollback on a failed release: passes);
- values gate: live==git+intent passes; rootApp fallback / stale tag /
  diagnostics-window keys / missing keys refuse; RELEASE-BUMP
  FORGIVENESS (1.33.0 battle): an image.tag-only drift where live ==
  appVersion of the deployed revision (helm history) is auto-waived
  with an audit note, no flag; a foreign manually-pinned tag refuses
  (and still passes via --allow-drift); secret-class values are
  never printed (key names only); --allow-drift waives NON-SECRET drift
  only (deploy subcommand, mandatory reason journaled; secret-class and
  every other gate still refuse);
- tag resolution: values image.tag, appVersion fallback;
- journal: append-only line format, header on create; the git
  add/commit/push branch exercised with a real tmp git repo (branch
  checkout AND detached-HEAD worktree — the push goes out HEAD:main);
- subcommands: verify (gates only, no helm upgrade), deploy (podman
  build+push with the resolved tag, helm upgrade --atomic -f values
  --set image.tag --set rootApp=app, journal), rollback (helm rollback
  <rev> + journal with the TARGET revision's live tag, not git's),
  repair (no podman, skip-history allowed).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[1]
DEPLOY_SH = REPO / "scripts" / "deploy.sh"
VALUES = REPO / "deploy" / "chart" / "vesmaro-eyes" / "values.yaml"
CHART = REPO / "deploy" / "chart" / "vesmaro-eyes" / "Chart.yaml"


def _resolved_tag() -> str:
    tag = re.search(r'^\s*tag:\s*"?([^"#\s]+)"?', VALUES.read_text(), re.M)
    if tag:
        return tag.group(1)
    app = re.search(r'^appVersion:\s*"?([^"#\s]+)"?', CHART.read_text(), re.M)
    assert app
    return app.group(1)


def _image_repo() -> str:
    return re.search(r"^\s*repository:\s*(\S+)", VALUES.read_text(),
                     re.M).group(1)


class FakeWorld:
    """Stub git/helm/podman/sync-version + deploy.sh env knobs."""

    def __init__(self, tmp_path: Path):
        self.dir = tmp_path
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.state = tmp_path / "state"
        self.state.mkdir()
        # git stub state
        (self.state / "head").write_text("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111")
        (self.state / "origin_main").write_text(
            "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111")
        (self.state / "dirty").write_text("")
        # helm stub state
        (self.state / "hist.json").write_text(json.dumps([
            {"revision": 39, "status": "superseded"},
            {"revision": 40, "status": "deployed"},
        ]))
        live = yaml.safe_load(VALUES.read_text())
        live["rootApp"] = "app"
        live.setdefault("image", {})["tag"] = _resolved_tag()
        live.setdefault("image", {})["repository"] = _image_repo()
        (self.state / "live.yaml").write_text(yaml.safe_dump(live))
        (self.state / "sync-rc").write_text("0")

        self._write("git", textwrap.dedent(f"""\
            #!/usr/bin/env bash
            S="{self.state}"
            case "$1" in
              fetch) exit 0 ;;
              rev-parse)
                if [[ "$2" == "--short" ]]; then echo deadbee; exit 0; fi
                if [[ "$2" == "HEAD" ]]; then cat "$S/head"; exit 0; fi
                if [[ "$2" == "origin/main" ]]; then cat "$S/origin_main"; exit 0; fi
                exit 1 ;;
              status) cat "$S/dirty" ;;
              add|commit|push) echo "git $*" >> "$S/git.log"; exit 0 ;;
              *) exit 1 ;;
            esac"""))
        # plain strings + placeholder replace: the stubs embed python
        # bodies whose braces must NOT go through f-string interpolation
        self._write("helm", textwrap.dedent("""\
            #!/usr/bin/env bash
            S="__STATE__"
            echo "helm $*" >> "$S/helm.log"
            case "$1" in
              history) cat "$S/hist.json" ;;
              get)
                # `get values ... --revision N` serves a per-revision
                # snapshot when the test planted one (live-rev-N.yaml),
                # else the current live.yaml
                rev=""; prev=""
                for a in "$@"; do
                  if [[ "$prev" == "--revision" ]]; then rev="$a"; fi
                  prev="$a"
                done
                if [[ -n "$rev" && -f "$S/live-rev-$rev.yaml" ]]; then
                  cat "$S/live-rev-$rev.yaml"
                else
                  cat "$S/live.yaml"
                fi ;;
              upgrade)
                python3 - "$S/hist.json" <<'PYB'
            import json, sys
            rows = json.load(open(sys.argv[1]))
            rev = (max(r["revision"] for r in rows) + 1) if rows else 1
            rows.append({"revision": rev, "status": "deployed"})
            json.dump(rows, open(sys.argv[1], "w"))
            PYB
                exit 0 ;;
              rollback) exit 0 ;;
              *) exit 1 ;;
            esac""").replace("__STATE__", str(self.state)))
        self._write("podman-stub", (
            "#!/usr/bin/env bash\n"
            f'echo "podman $*" >> "{self.state}/podman.log"\n'
            "exit 0\n"))
        self._write("sync-stub", textwrap.dedent(f"""\
            #!/usr/bin/env bash
            if [[ "$1" == "--check" ]] && grep -qx 1 "{self.state}/sync-rc"; then
              echo "version drift (stub)" >&2; exit 1
            fi
            echo "source version: stub (ok)"
            exit 0"""))

    def _write(self, name: str, body: str) -> None:
        p = self.bin / name
        p.write_text(body)
        p.chmod(0o755)

    def env(self, **extra: str) -> dict[str, str]:
        env = dict(os.environ)
        env.update({
            "VESMARO_DEPLOY_GIT": str(self.bin / "git"),
            "VESMARO_DEPLOY_HELM": str(self.bin / "helm"),
            "VESMARO_DEPLOY_SYNC_VERSION": str(self.bin / "sync-stub"),
            "VESMARO_DEPLOY_PODMAN_HOST": f"bash {self.bin / 'podman-stub'}",
            "VESMARO_DEPLOY_LOCK": str(self.state / "deploy.lock"),
            "VESMARO_DEPLOY_JOURNAL": str(self.state / "JOURNAL.md"),
            "VESMARO_DEPLOY_ACTOR": "test-actor",
            "VESMARO_DEPLOY_PYTHON": sys.executable,
        })
        env.update(extra)
        return env

    def run_subcommand(self, *args: str, env_extra: dict[str, str] | None = None
                       ) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["bash", str(DEPLOY_SH), *args], capture_output=True,
            text=True, timeout=60, env=self.env(**(env_extra or {})))

    def run_function(self, fn: str) -> subprocess.CompletedProcess:
        """Source the script (inert: dispatch is source-guarded) and call
        one gate/function by name."""
        return subprocess.run(
            ["bash", "-c", f"source '{DEPLOY_SH}' && {fn}"],
            capture_output=True, text=True, timeout=60, env=self.env())

    # ------------------------------------------------------ state twiddles
    def set_history(self, *rows: tuple[int, ...]) -> None:
        # each row: (revision, status[, app_version]) — app_version is
        # what the release-bump forgiveness compares the live tag against
        out = []
        for row in rows:
            entry = {"revision": row[0], "status": row[1]}
            if len(row) > 2:
                entry["app_version"] = row[2]
            out.append(entry)
        (self.state / "hist.json").write_text(json.dumps(out))

    def set_live(self, **overrides) -> None:
        live = yaml.safe_load((self.state / "live.yaml").read_text())
        for dotted, value in overrides.items():
            node = live
            parts = dotted.split(".")
            for part in parts[:-1]:
                node = node.setdefault(part, {})
            node[parts[-1]] = value
        (self.state / "live.yaml").write_text(yaml.safe_dump(live))

    def logs(self) -> dict[str, str]:
        out = {}
        for name in ("helm.log", "podman.log", "git.log"):
            p = self.state / name
            out[name] = p.read_text() if p.exists() else ""
        return out


@pytest.fixture()
def world(tmp_path):
    return FakeWorld(tmp_path)


# ------------------------------------------------------------------ gates
class TestPreflightGate:
    def test_clean_and_on_main_passes(self, world):
        r = world.run_function("gate_preflight")
        assert r.returncode == 0

    def test_dirty_tree_refuses(self, world):
        (world.state / "dirty").write_text(" M deploy/chart/vesmaro-eyes/values.yaml")
        r = world.run_function("gate_preflight")
        assert r.returncode == 1
        assert "dirty" in r.stderr

    def test_not_on_main_refuses(self, world):
        (world.state / "origin_main").write_text("bbbb2222" * 5)
        r = world.run_function("gate_preflight")
        assert r.returncode == 1
        assert "origin/main" in r.stderr


class TestVersionGate:
    def test_check_ok_passes(self, world):
        assert world.run_function("gate_version_drift").returncode == 0

    def test_drift_refuses(self, world):
        (world.state / "sync-rc").write_text("1")
        r = world.run_function("gate_version_drift")
        assert r.returncode == 1
        assert "drift" in r.stderr


class TestLockGate:
    def test_free_lock_acquires(self, world):
        assert world.run_function("acquire_lock").returncode == 0
        assert (world.state / "deploy.lock").exists()

    def test_held_lock_refuses(self, world):
        lock = world.state / "deploy.lock"
        holder = subprocess.Popen(
            ["bash", "-c",
             f'exec 9>"{lock}"; flock 9; echo ready > "{world.state}/holder-ready"; sleep 30'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(50):
                if (world.state / "holder-ready").exists():
                    break
                import time
                time.sleep(0.1)
            r = world.run_function("acquire_lock")
            assert r.returncode == 1
            assert "another deploy holds" in r.stderr
        finally:
            holder.kill()
            holder.wait()


class TestHistoryGate:
    def test_deployed_passes(self, world):
        world.set_history((38, "superseded"), (39, "deployed"))
        r = world.run_function("gate_helm_history")
        assert r.returncode == 0
        assert "39: deployed" in r.stdout

    def test_failed_refuses_with_repair_hint(self, world):
        world.set_history((39, "deployed"), (40, "failed"))
        r = world.run_function("gate_helm_history")
        assert r.returncode == 1
        assert "failed" in r.stderr
        assert "repair --skip-history-gate" in r.stderr

    def test_pending_upgrade_refuses(self, world):
        world.set_history((40, "pending-upgrade"))
        r = world.run_function("gate_helm_history")
        assert r.returncode == 1
        assert "pending-upgrade" in r.stderr


class TestValuesGate:
    def test_live_matches_git_and_intent(self, world):
        r = world.run_function("gate_values_drift")
        assert r.returncode == 0, r.stderr

    def test_rootapp_fallback_refuses(self, world):
        # the 1.11.x / 2026-09-21+22 fallback incidents: live release
        # quietly rolled back to the legacy board UI
        world.set_live(rootApp="board")
        r = world.run_function("gate_values_drift")
        assert r.returncode == 1
        assert "rootApp" in r.stderr

    def test_stale_image_tag_refuses(self, world):
        world.set_live(**{"image.tag": "0.0.1-stale"})
        r = world.run_function("gate_values_drift")
        assert r.returncode == 1
        assert "image.tag" in r.stderr

    # --------------------------- release-bump forgiveness (1.33.0 battle)
    def test_release_bump_tag_only_drift_auto_waived(self, world):
        # the 1.33.0 battle (deploy rev 67>68): git bumped the tag, live
        # still runs the PREVIOUS release — the gate recognizes it via
        # the deployed revision's appVersion (helm history) and passes
        # WITHOUT --allow-drift
        prev = "1.32.0" if _resolved_tag() != "1.32.0" else "1.31.0"
        world.set_history((39, "superseded", "0.9.9"), (40, "deployed", prev))
        world.set_live(**{"image.tag": prev})
        r = world.run_function("gate_values_drift")
        assert r.returncode == 0, r.stderr
        assert "WAIVED" in r.stdout
        assert "previous release, not manual drift" in r.stdout

    def test_foreign_manual_tag_refuses_despite_known_appversion(self, world):
        # same tag-only shape, but the live tag matches NEITHER git nor
        # the deployed revision's appVersion = a manual --set of a
        # foreign tag: auto-waive explicitly does not apply
        world.set_history((40, "deployed", "1.32.0"))
        world.set_live(**{"image.tag": "9.9.9-hax"})
        r = world.run_function("gate_values_drift")
        assert r.returncode == 1
        assert "NOT the previous release" in r.stderr
        assert "9.9.9-hax" in r.stderr

    def test_diagnostics_window_left_on_refuses(self, world):
        world.set_live(**{"networkPolicy.ingress.allowLan": {"enabled": True}})
        r = world.run_function("gate_values_drift")
        assert r.returncode == 1
        assert "allowLan.enabled" in r.stderr

    def test_secret_values_never_printed(self, world):
        secret_value = "mnk_do_not_print_me_12345"
        world.set_live(rootApp="board", **{"boardToken": {"existingSecret":
                                                          secret_value}})
        r = world.run_function("gate_values_drift")
        assert r.returncode == 1
        assert "rootApp" in r.stderr                    # the real drift named
        assert secret_value not in r.stderr + r.stdout  # secrets never echoed

    def test_secret_key_missing_in_live_reports_key_only(self, world):
        live = yaml.safe_load((world.state / "live.yaml").read_text())
        del live["mnemos"]["cluster"]["existingSecret"]
        (world.state / "live.yaml").write_text(yaml.safe_dump(live))
        r = world.run_function("gate_values_drift")
        assert r.returncode == 1
        assert "mnemos.cluster.existingSecret" in r.stderr
        assert "value not compared" in r.stderr


# ------------------------------------------------------------ tag helpers
class TestTagResolution:
    def test_resolve_image_tag_from_values(self, world):
        r = world.run_function("resolve_image_tag")
        assert r.stdout.strip() == _resolved_tag()

    def test_appversion_fallback(self, world, tmp_path):
        values = tmp_path / "values.yaml"
        text = VALUES.read_text().replace(
            f'tag: "{_resolved_tag()}"', 'tag: ""')
        values.write_text(text)
        app = re.search(r'^appVersion:\s*"?([^"#\s]+)"?', CHART.read_text(),
                        re.M).group(1)
        r = subprocess.run(
            ["bash", "-c",
             f"source '{DEPLOY_SH}' && VALUES_FILE='{values}' resolve_image_tag"],
            capture_output=True, text=True, timeout=30,
            env=world.env())
        assert r.stdout.strip() == app


# ---------------------------------------------------------------- journal
class TestJournal:
    def test_append_only_line_format(self, world):
        r = world.run_function("journal_append deploy 40 41 9.9.9")
        assert r.returncode == 0
        line = (world.state / "JOURNAL.md").read_text().strip().splitlines()[-1]
        assert re.match(
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+\d{4} \| test-actor \| deploy \| rev 40>41 \| image 9\.9\.9 \| chart \S+ \| HEAD \S+$",
            line)

    def test_header_created_once(self, world):
        world.run_function("journal_append deploy 1 2 1.1.1")
        world.run_function("journal_append rollback 2 3 1.1.1")
        text = (world.state / "JOURNAL.md").read_text()
        assert text.count("# vesmaro-eyes deploy JOURNAL") == 1
        # data lines only (the format-sample comment line also has pipes)
        data = [l for l in text.splitlines()
                if "|" in l and not l.startswith("#")]
        assert len(data) == 2

    def test_note_suffix_appended_to_line(self, world):
        world.run_function(
            'journal_append deploy 7 8 2.0.0 "allow-drift: post-rollback realign"')
        line = (world.state / "JOURNAL.md").read_text().strip().splitlines()[-1]
        assert line.endswith('| allow-drift: post-rollback realign')

    def test_journal_committed_and_pushed_when_inside_repo(self, world, tmp_path):
        """The git add/commit/push branch of journal_append (the journal
        travels with the repo) — one-shot with a REAL tmp git repo and a
        REPO_ROOT override; the stub git cannot execute it."""
        repo = tmp_path / "repo"
        (repo / "deploy").mkdir(parents=True)
        origin = tmp_path / "origin.git"

        def git(*args: str, cwd=None, git_dir=None) -> subprocess.CompletedProcess:
            cmd = ["git"]
            if git_dir:
                cmd += ["--git-dir", str(git_dir)]
            else:
                cmd += ["-C", str(cwd or repo)]
            return subprocess.run(cmd + list(args), capture_output=True,
                                  text=True, check=True)

        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
        subprocess.run(["git", "init", "-q", "--bare", str(origin)], check=True)
        # isolate from machine-global hooks (identity guards etc.) — the
        # tmp repo must behave identically on every machine
        git("config", "core.hooksPath", "")
        git("config", "user.email", "deploy-test@example.com")
        git("config", "user.name", "deploy-test")
        (repo / "README.md").write_text("tmp repo\n")
        git("add", "-A")
        git("commit", "-q", "-m", "init")
        git("remote", "add", "origin", str(origin))
        git("push", "-q", "origin", "main")

        env = world.env(VESMARO_DEPLOY_JOURNAL=str(repo / "deploy" / "JOURNAL.md"))
        env["VESMARO_DEPLOY_GIT"] = "git"          # REAL git for this one
        r = subprocess.run(
            ["bash", "-c",
             f"cd '{repo}' && source '{DEPLOY_SH}' "
             f"&& REPO_ROOT='{repo}' journal_append deploy 5 6 1.2.3"],
            capture_output=True, text=True, timeout=60, env=env)
        assert r.returncode == 0, r.stderr

        journal = repo / "deploy" / "JOURNAL.md"
        assert "| deploy | rev 5>6 | image 1.2.3 |" in journal.read_text()
        # committed: the working tree is clean afterwards
        assert git("status", "--porcelain").stdout == ""
        subject = git("log", "-1", "--format=%s").stdout.strip()
        assert subject == "chore(deploy): journal — deploy rev 5>6 image 1.2.3"
        # pushed: the bare origin advanced to the journal commit
        head = git("rev-parse", "HEAD").stdout.strip()
        pushed = git("rev-parse", "main", git_dir=origin).stdout.strip()
        assert pushed == head

    def test_journal_push_lands_on_main_from_detached_head(self, world,
                                                           tmp_path):
        """The 1.33.0 battle shape: deploys run from a worktree on a
        DETACHED HEAD at main's tip (gate 1 only needs HEAD ==
        origin/main; the main checkout owns the branch). `git push
        origin main` would push the STALE local main and silently
        strand the journal commit — the push must go out as HEAD:main.
        One-shot tmp repo + linked worktree, detached HEAD."""
        repo = tmp_path / "repo"
        wt = tmp_path / "wt"
        (repo / "deploy").mkdir(parents=True)
        origin = tmp_path / "origin.git"

        def git(*args: str, cwd=None, git_dir=None) -> subprocess.CompletedProcess:
            cmd = ["git"]
            if git_dir:
                cmd += ["--git-dir", str(git_dir)]
            else:
                cmd += ["-C", str(cwd or repo)]
            return subprocess.run(cmd + list(args), capture_output=True,
                                  text=True, check=True)

        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
        subprocess.run(["git", "init", "-q", "--bare", str(origin)], check=True)
        # isolate from machine-global hooks; identity for the commits
        git("config", "core.hooksPath", "")
        git("config", "user.email", "deploy-test@example.com")
        git("config", "user.name", "deploy-test")
        (repo / "README.md").write_text("tmp repo\n")
        git("add", "-A")
        git("commit", "-q", "-m", "init")
        git("remote", "add", "origin", str(origin))
        git("push", "-q", "origin", "main")
        base = git("rev-parse", "HEAD").stdout.strip()
        # the battle shape: a linked worktree on a DETACHED HEAD — it
        # cannot check out main (the main repo owns it)
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q",
                        "--detach", str(wt), base], check=True)
        (wt / "deploy").mkdir()   # journal_append writes the file, not the dir

        env = world.env(VESMARO_DEPLOY_JOURNAL=str(wt / "deploy" / "JOURNAL.md"))
        env["VESMARO_DEPLOY_GIT"] = "git"          # REAL git for this one
        r = subprocess.run(
            ["bash", "-c",
             f"cd '{wt}' && source '{DEPLOY_SH}' "
             f"&& REPO_ROOT='{wt}' journal_append deploy 5 6 1.2.3"],
            capture_output=True, text=True, timeout=60, env=env)
        assert r.returncode == 0, r.stderr

        assert "| deploy | rev 5>6 | image 1.2.3 |" in \
            (wt / "deploy" / "JOURNAL.md").read_text()
        # the journal commit sits on the worktree's detached HEAD...
        head = git("rev-parse", "HEAD", cwd=wt).stdout.strip()
        assert head != base
        # ...and reached origin/main — via HEAD:main, NOT the stale
        # local main (which is still at base and would have pushed
        # nothing new under the old `push origin main`)
        pushed = git("rev-parse", "main", git_dir=origin).stdout.strip()
        assert pushed == head
        assert git("rev-parse", "main").stdout.strip() == base


# ------------------------------------------------------------ subcommands
class TestSubcommands:
    def test_verify_runs_gates_without_deploy(self, world):
        r = world.run_subcommand("verify")
        assert r.returncode == 0, r.stderr
        assert "no deploy was performed" in r.stdout
        # verify READS history/values via helm but never mutates anything
        helm = world.logs()["helm.log"]
        assert "history" in helm and "get values" in helm
        assert "upgrade" not in helm and "rollback" not in helm
        assert world.logs()["podman.log"] == ""

    def test_deploy_full_path(self, world):
        r = world.run_subcommand("deploy")
        assert r.returncode == 0, r.stderr
        helm = world.logs()["helm.log"]
        assert re.search(
            rf"upgrade vesmaro-eyes \S*deploy/chart/vesmaro-eyes -n kube-agents "
            rf"-f \S*values\.yaml --set image\.tag={_resolved_tag()} "
            rf"--set rootApp=app --atomic --timeout 5m", helm)
        podman = world.logs()["podman.log"]
        assert f"build -t {_image_repo()}:{_resolved_tag()}" in podman
        assert f"push {_image_repo()}:{_resolved_tag()}" in podman
        journal = (world.state / "JOURNAL.md").read_text()
        assert "| deploy | rev 40>41 |" in journal

    def test_deploy_blocked_by_broken_history(self, world):
        world.set_history((39, "deployed"), (40, "failed"))
        r = world.run_subcommand("deploy")
        assert r.returncode == 1
        assert "upgrade" not in world.logs()["helm.log"]
        assert world.logs()["podman.log"] == ""
        assert not (world.state / "JOURNAL.md").exists()

    def test_deploy_blocked_by_values_drift(self, world):
        world.set_live(rootApp="board")
        r = world.run_subcommand("deploy")
        assert r.returncode == 1
        assert "upgrade" not in world.logs()["helm.log"]
        assert world.logs()["podman.log"] == ""

    # --------------------------- release-bump forgiveness (1.33.0 battle)
    def test_release_bump_deploys_without_allow_drift(self, world):
        # AGW-10 battle fix (deploy 1.33.0, rev 67>68): a release bump
        # must NOT require --allow-drift — the gate itself recognizes
        # the previous release via the deployed revision's appVersion
        prev = "1.32.0" if _resolved_tag() != "1.32.0" else "1.31.0"
        world.set_history((39, "superseded", "0.9.9"), (40, "deployed", prev))
        world.set_live(**{"image.tag": prev})
        r = world.run_subcommand("deploy")
        assert r.returncode == 0, r.stderr
        assert "WAIVED" in r.stdout
        assert "previous release, not manual drift" in r.stdout
        assert "upgrade" in world.logs()["helm.log"]   # deploy proceeds
        journal = (world.state / "JOURNAL.md").read_text()
        assert "| deploy | rev 40>41 |" in journal
        # the auto-waiver is audited in the JOURNAL line itself
        assert "auto-waived: image.tag drift = previous release" in journal
        assert "allow-drift:" not in journal            # no escape flag used

    def test_manual_tag_drift_requires_allow_drift(self, world):
        # tag-only drift that is NOT the previous release (manual --set
        # of a foreign tag): refuses bare; --allow-drift still waives it
        # (non-secret) — pinned both ways
        world.set_history((40, "deployed", "1.32.0"))
        world.set_live(**{"image.tag": "9.9.9-hax"})
        r = world.run_subcommand("deploy")
        assert r.returncode == 1
        assert "NOT the previous release" in r.stderr
        assert "upgrade" not in world.logs()["helm.log"]
        assert world.logs()["podman.log"] == ""
        assert not (world.state / "JOURNAL.md").exists()
        r = world.run_subcommand("deploy", "--allow-drift",
                                 "deliberate pin to 9.9.9-hax")
        assert r.returncode == 0, r.stderr
        assert "WAIVED (--allow-drift)" in r.stdout
        assert "upgrade" in world.logs()["helm.log"]
        journal = (world.state / "JOURNAL.md").read_text()
        assert "allow-drift: deliberate pin to 9.9.9-hax" in journal
        assert "auto-waived" not in journal              # flag, not auto

    def test_redeploy_same_version_is_quiet(self, world):
        # the pre-existing case: re-deploying the SAME version (no
        # drift at all) stays silent — no WAIVED lines anywhere
        r = world.run_subcommand("deploy")
        assert r.returncode == 0, r.stderr
        assert "WAIVED" not in r.stdout
        journal = (world.state / "JOURNAL.md").read_text()
        assert "waived" not in journal

    def test_rollback(self, world):
        # post-rollback the live release carries the TARGET revision's
        # tag — the JOURNAL line must record that live tag, not git's
        # resolve_image_tag() (which would lie in the audit trail)
        (world.state / "live-rev-40.yaml").write_text(
            'image:\n  tag: "1.31.0"\n')
        r = world.run_subcommand("rollback", "39")
        assert r.returncode == 0, r.stderr
        assert re.search(r"rollback vesmaro-eyes 39 -n kube-agents "
                         r"--wait --timeout 5m", world.logs()["helm.log"])
        journal = (world.state / "JOURNAL.md").read_text()
        assert "| rollback |" in journal
        assert "| rollback | rev 40>40 | image 1.31.0 |" in journal
        assert f"image {_resolved_tag()} |" not in journal
        assert world.logs()["podman.log"] == ""   # rollback builds nothing

    def test_rollback_tag_falls_back_when_live_rev_has_no_tag(self, world):
        # a revision snapshot without a parsable image.tag → warning +
        # fallback to the git tag (still better than journaling nothing)
        (world.state / "live-rev-40.yaml").write_text("rootApp: board\n")
        r = world.run_subcommand("rollback", "39")
        assert r.returncode == 0, r.stderr
        assert "WARNING" in r.stdout
        journal = (world.state / "JOURNAL.md").read_text()
        assert f"| rollback | rev 40>40 | image {_resolved_tag()} |" in journal

    def test_rollback_with_skip_history_gate_on_failed_release(self, world):
        world.set_history((39, "deployed"), (40, "failed"))
        r = world.run_subcommand("rollback", "39", "--skip-history-gate")
        assert r.returncode == 0, r.stderr
        assert "SKIPPED" in r.stdout
        assert re.search(r"rollback vesmaro-eyes 39 -n kube-agents "
                         r"--wait --timeout 5m", world.logs()["helm.log"])
        assert "| rollback |" in (world.state / "JOURNAL.md").read_text()

    def test_repair_skips_history_and_rebuilds_nothing(self, world):
        world.set_history((39, "deployed"), (40, "failed"))
        r = world.run_subcommand("repair", "--skip-history-gate")
        assert r.returncode == 0, r.stderr
        assert "upgrade" in world.logs()["helm.log"]
        assert world.logs()["podman.log"] == ""   # tag must already exist
        assert "| repair |" in (world.state / "JOURNAL.md").read_text()

    def test_repair_without_flag_still_gated(self, world):
        world.set_history((40, "failed"))
        r = world.run_subcommand("repair")
        assert r.returncode == 1
        assert "upgrade" not in world.logs()["helm.log"]

    def test_skip_history_gate_is_repair_and_rollback_only(self, world):
        for args in (("deploy", "--skip-history-gate"),
                     ("verify", "--skip-history-gate")):
            assert world.run_subcommand(*args).returncode == 2

    def test_rollback_requires_rev(self, world):
        assert world.run_subcommand("rollback").returncode == 2

    # ------------------------------------------- deploy --allow-drift (P2-A)
    def test_deploy_allow_drift_passes_and_journals_reason(self, world):
        # the post-rollback deadlock scenario: live carries the old
        # revision's values (stale tag + legacy rootApp)
        world.set_live(rootApp="board", **{"image.tag": "1.31.0"})
        reason = "post-rollback realign: live carries rev 39 values (AGW-10 P2-A)"
        r = world.run_subcommand("deploy", "--allow-drift", reason)
        assert r.returncode == 0, r.stderr
        assert "WAIVED" in r.stdout
        helm = world.logs()["helm.log"]
        assert "upgrade" in helm                       # realigns live to git
        assert "--set rootApp=app" in helm
        assert f"push {_image_repo()}:{_resolved_tag()}" in world.logs()["podman.log"]
        journal = (world.state / "JOURNAL.md").read_text()
        assert f"allow-drift: {reason}" in journal     # reason is audited
        assert "| deploy | rev 40>41 |" in journal

    def test_deploy_allow_drift_requires_nonempty_reason(self, world):
        assert world.run_subcommand("deploy", "--allow-drift", "").returncode == 2
        assert world.run_subcommand("deploy", "--allow-drift").returncode == 2
        assert not (world.state / "JOURNAL.md").exists()

    def test_allow_drift_is_deploy_only(self, world):
        for args in (("verify", "--allow-drift", "why"),
                     ("rollback", "39", "--allow-drift", "why"),
                     ("repair", "--allow-drift", "why")):
            assert world.run_subcommand(*args).returncode == 2

    def test_deploy_allow_drift_does_not_cover_secret_class(self, world):
        live = yaml.safe_load((world.state / "live.yaml").read_text())
        del live["mnemos"]["cluster"]["existingSecret"]
        (world.state / "live.yaml").write_text(yaml.safe_dump(live))
        r = world.run_subcommand("deploy", "--allow-drift", "try to waive secrets")
        assert r.returncode == 1
        assert "SECRET-CLASS" in r.stderr
        assert "upgrade" not in world.logs()["helm.log"]
        assert world.logs()["podman.log"] == ""
        assert not (world.state / "JOURNAL.md").exists()

    def test_deploy_allow_drift_does_not_cover_broken_history(self, world):
        # the waiver is values-gate-ONLY: every other gate still refuses
        world.set_history((39, "deployed"), (40, "failed"))
        world.set_live(rootApp="board")
        r = world.run_subcommand("deploy", "--allow-drift", "cannot waive this")
        assert r.returncode == 1
        assert "upgrade" not in world.logs()["helm.log"]
        assert world.logs()["podman.log"] == ""
