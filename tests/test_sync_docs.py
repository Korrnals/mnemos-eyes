"""Pipeline tests for scripts/sync_docs.py (docs upstream import, W1a).

The pipeline is exercised against a throwaway fake upstream git repo built
in tmp_path — never against the real ../mnemos / ../mnemos-mesh clones.
Covers the ARCHCOM-7 contract §6 gates: link rewriting, chrome stripping,
frontmatter injection, overlay anchors (success + DRIFT fail), idempotency,
provenance completeness, selection purity, image vendoring.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sync_docs.py"
_spec = importlib.util.spec_from_file_location("sync_docs_under_test", _SCRIPT)
sync_docs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync_docs)

SyncError = sync_docs.SyncError

EN_GETTING_STARTED = """\
# Getting started

**🌐 Language / Язык:** English · [Русский](../../ru/user/getting-started.md)

<!-- build-note -->

Start here. See the [CLI reference](cli-reference.md) and
[security](../admin/security.md#keys), plus
[architecture](../architecture/overview.md) (not imported).
Repo files: [CONTRIBUTING](../../../CONTRIBUTING.md),
[config](../../../config.example.yaml).
Image: ![logo](../assets/logo.svg)
External: [site](https://example.com/x). Jump: [intro](#intro).
Escaped: [elsewhere](../../../../../other/repo.md).
"""

RU_GETTING_STARTED = """\
# Начало работы

**🌐 Language / Язык:** [English](../../en/user/getting-started.md) · Русский

Начните здесь: [справочник CLI](cli-reference.md).
"""

SVG = "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>\n"

REPO_FILES: dict[str, str] = {
    "docs/en/user/getting-started.md": EN_GETTING_STARTED,
    "docs/en/user/cli-reference.md": "# CLI reference\n\nEvery command.\n",
    "docs/en/admin/security.md": "# Security\n\nKeys and certs.\n",
    "docs/en/architecture/overview.md": "# Architecture\n\nSystem shape.\n",
    "docs/en/assets/logo.svg": SVG,
    "docs/ru/user/getting-started.md": RU_GETTING_STARTED,
    "docs/ru/user/cli-reference.md": "# Справочник CLI\n\nВсе команды.\n",
    "CONTRIBUTING.md": "# Contributing\n",
    "config.example.yaml": "provider: ollama\n",
}


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    )
    return proc.stdout.strip()


@pytest.fixture(scope="module")
def upstream_repo(tmp_path_factory: pytest.TempPathFactory) -> dict[str, object]:
    """A minimal fake upstream clone with two locale mirrors and an asset."""
    repo = tmp_path_factory.mktemp("upstream") / "fakeproj"
    (repo / "docs").mkdir(parents=True)
    for rel, text in REPO_FILES.items():
        dest = repo / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "153223100+Korrnals@users.noreply.github.com")
    _git(repo, "config", "user.name", "Korrnals")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "docs: fake upstream snapshot")
    return {
        "repo": repo,
        "sha": _git(repo, "rev-parse", "HEAD"),
        "commit_date": _git(repo, "log", "-1", "--format=%cI", "HEAD"),
    }


CURATED_TRANSLATION = """\
---
title: "Начало работы (fakemesh)"
curator_note: перевод проверен писарем
---

# Начало работы

Переведённое вводное руководство узла fakemesh.
"""

CURATED_TRANSLATION_PATH = (
    "viewer/src/features/docs/curated/fakemesh/ru/user/getting-started.md"
)


@pytest.fixture()
def config(upstream_repo: dict[str, object]) -> dict[str, object]:
    return {
        "projects": {
            "fakeproj": {
                "repo": str(upstream_repo["repo"]),
                "ref": upstream_repo["sha"],
                "web_base": "https://github.com/example/fakeproj/blob/{sha}",
                "locale_dirs": {"en": "docs/en", "ru": "docs/ru"},
                "include": [
                    {
                        "path": "user/getting-started.md",
                        "category": "fake-user",
                        "order": 1,
                    },
                    {
                        "path": "user/cli-reference.md",
                        "category": "fake-user",
                        "order": 2,
                    },
                    {
                        "path": "admin/security.md",
                        "category": "fake-admin",
                        "order": 1,
                    },
                ],
                "exclude": [
                    {"path": "architecture/", "reason": "not selected in v1"}
                ],
                "overlays": [
                    {
                        "file": "en/user/getting-started.md",
                        "find": "Start here.",
                        "replace": "Curated for the board.",
                        "reason": "demo overlay",
                    }
                ],
            },
            # mirrors the mnemos-mesh shape: en-only upstream, ru comes from
            # a curated translation (our layer, survives re-sync)
            "fakemesh": {
                "repo": str(upstream_repo["repo"]),
                "ref": upstream_repo["sha"],
                "web_base": "https://github.com/example/fakemesh/blob/{sha}",
                "locale_dirs": {"en": "docs/en"},
                "include": [
                    {
                        "path": "user/getting-started.md",
                        "category": "fake-mesh",
                        "order": 1,
                    }
                ],
                "translations": {
                    "ru": [
                        {
                            "source_of": "user/getting-started.md",
                            "source": CURATED_TRANSLATION_PATH,
                            "translator_note": "Кураторский перевод; оригинал en",
                        }
                    ]
                },
            },
        },
        "normalize": {
            "strip_lines_matching": ["*🌐 Language / Язык:*"],
            "strip_html_comment_lines": True,
            "collapse_blank_lines": 2,
        },
    }


@pytest.fixture()
def synced(
    tmp_path: Path, config: dict[str, object]
) -> tuple[Path, Path, dict[str, object]]:
    curated = tmp_path / CURATED_TRANSLATION_PATH
    curated.parent.mkdir(parents=True, exist_ok=True)
    curated.write_text(CURATED_TRANSLATION, encoding="utf-8")
    content_out = tmp_path / "content_upstream"
    assets_out = tmp_path / "assets_upstream"
    report = sync_docs.sync(
        config, content_out=content_out, assets_out=assets_out, repo_root=tmp_path
    )
    return content_out, assets_out, report


def read_page(content_out: Path, locale: str, rel: str = "user/getting-started.md") -> str:
    return (content_out / "fakeproj" / locale / rel).read_text(encoding="utf-8")


def tree_snapshot(root: Path) -> dict[str, bytes]:
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def parse_frontmatter(page: str) -> dict[str, str]:
    assert page.startswith("---\n")
    end = page.index("\n---\n", 3)
    fields: dict[str, str] = {}
    for line in page[4:end].splitlines():
        key, _, value = line.partition(": ")
        fields[key] = value
    return fields


# --- link rewriting (contract §6.1) -----------------------------------------


def test_relative_md_links_rewritten_to_board_slugs(synced) -> None:
    content_out, _, _ = synced
    page = read_page(content_out, "en")
    assert "](fakeproj/user/cli-reference)" in page
    assert "](fakeproj/admin/security#keys)" in page
    assert "](cli-reference.md)" not in page
    assert "../admin/security.md" not in page


def test_link_to_excluded_page_becomes_dangling_slug(synced) -> None:
    content_out, _, report = synced
    page = read_page(content_out, "en")
    assert "](fakeproj/architecture/overview)" in page
    dangling = report["projects"]["fakeproj"]["dangling_slugs"]
    assert "fakeproj/architecture/overview" in dangling


def test_repo_file_links_rewritten_to_pinned_github_urls(synced, upstream_repo) -> None:
    content_out, _, _ = synced
    sha = upstream_repo["sha"]
    page = read_page(content_out, "en")
    assert f"https://github.com/example/fakeproj/blob/{sha}/CONTRIBUTING.md" in page
    assert f"https://github.com/example/fakeproj/blob/{sha}/config.example.yaml" in page


def test_external_and_pure_anchor_links_untouched(synced) -> None:
    content_out, _, _ = synced
    page = read_page(content_out, "en")
    assert "](https://example.com/x)" in page
    assert "](#intro)" in page


def test_link_escaping_the_clone_is_kept_and_reported(synced) -> None:
    content_out, _, report = synced
    page = read_page(content_out, "en")
    assert "](../../../../../other/repo.md)" in page
    assert "../../../../../other/repo.md" in report["projects"]["fakeproj"]["escapes"]


# --- chrome stripping --------------------------------------------------------


def test_upstream_chrome_stripped_content_preserved(synced) -> None:
    content_out, _, _ = synced
    en = read_page(content_out, "en")
    ru = read_page(content_out, "ru")
    assert "🌐" not in en and "🌐" not in ru
    assert "build-note" not in en  # chrome comment line is gone (banner stays)
    assert "Every command." in read_page(content_out, "en", "user/cli-reference.md")
    assert "Начните здесь" in ru


# --- frontmatter + banner -----------------------------------------------------


def test_frontmatter_injected(synced, upstream_repo) -> None:
    content_out, _, _ = synced
    fields = parse_frontmatter(read_page(content_out, "en"))
    assert fields["title"] == "Getting started"  # first H1 fallback
    assert fields["slug"] == "fakeproj/user/getting-started"
    assert fields["category"] == "fake-user"
    assert fields["order"] == "1"
    assert fields["last_verified"] == str(upstream_repo["commit_date"])[:10]


def test_banner_marks_generated_with_pinned_sha(synced, upstream_repo) -> None:
    content_out, _, _ = synced
    page = read_page(content_out, "en")
    assert f"GENERATED by sync_docs from fakeproj@{str(upstream_repo['sha'])[:12]}" in page


def test_overlay_applied_to_matching_locale_only(synced) -> None:
    content_out, _, report = synced
    assert "Curated for the board." in read_page(content_out, "en")
    assert "Curated for the board." not in read_page(content_out, "ru")
    assert report["projects"]["fakeproj"]["overlays_applied"] == ["demo overlay"]


# --- overlay DRIFT gate (contract §6.3) --------------------------------------


def test_overlay_anchor_drift_fails_the_sync(tmp_path, config) -> None:
    broken = copy.deepcopy(config)
    broken["projects"]["fakeproj"]["overlays"][0]["find"] = "NO SUCH ANCHOR"
    with pytest.raises(SyncError, match="DRIFT"):
        sync_docs.sync(
            broken,
            content_out=tmp_path / "c",
            assets_out=tmp_path / "a",
        )


def test_overlay_anchor_matching_twice_fails_the_sync(tmp_path, config) -> None:
    ambiguous = copy.deepcopy(config)
    ambiguous["projects"]["fakeproj"]["overlays"][0]["find"] = "e"
    with pytest.raises(SyncError, match="matched 2 times|matched \\d+ times"):
        sync_docs.sync(
            ambiguous,
            content_out=tmp_path / "c2",
            assets_out=tmp_path / "a2",
        )


# --- idempotency --------------------------------------------------------------


def test_double_run_is_byte_identical(tmp_path, config) -> None:
    content_out = tmp_path / "c"
    assets_out = tmp_path / "a"
    sync_docs.sync(config, content_out=content_out, assets_out=assets_out)
    first = {content_out.name: tree_snapshot(content_out), assets_out.name: tree_snapshot(assets_out)}
    report = sync_docs.sync(config, content_out=content_out, assets_out=assets_out)
    second = {content_out.name: tree_snapshot(content_out), assets_out.name: tree_snapshot(assets_out)}
    assert first == second
    assert report["skipped"] == [] or isinstance(report["skipped"], list)


# --- provenance + sidecar (contract §6.5) ------------------------------------


def test_provenance_complete_for_every_generated_page(synced, upstream_repo) -> None:
    content_out, _, _ = synced
    provenance = json.loads((content_out / "provenance.json").read_text(encoding="utf-8"))
    generated = [
        path.relative_to(content_out)
        for path in sorted(content_out.rglob("*.md"))
    ]
    for path in generated:
        parts = path.parts  # <project>/<locale>/<entry path>
        slug = f"{parts[0]}/{Path(*parts[2:]).with_suffix('')}"
        for locale_file, entry in provenance["files"][slug].items():
            assert entry["repo"] == parts[0]
            assert entry["sha"] == upstream_repo["sha"]
            assert entry["commit_date"] == upstream_repo["commit_date"]
            assert entry["locale"] == locale_file
            assert entry["kind"] in ("upstream", "curated-translation")
            if entry["kind"] == "upstream":
                assert entry["source_path"] == f"docs/{locale_file}/{Path(*parts[2:])}"


def test_sidecar_mirrors_docpage_shape(synced, upstream_repo) -> None:
    content_out, _, _ = synced
    sidecar = json.loads(
        (content_out / "manifest.sidecar.json").read_text(encoding="utf-8")
    )
    assert sidecar["source_shas"] == {
        "fakeproj": upstream_repo["sha"],
        "fakemesh": upstream_repo["sha"],
    }
    pages = {page["slug"]: page for page in sidecar["pages"]}
    assert set(pages) == {
        "fakeproj/user/getting-started",
        "fakeproj/user/cli-reference",
        "fakeproj/admin/security",
        "fakemesh/user/getting-started",
    }
    getting = pages["fakeproj/user/getting-started"]
    assert set(getting) == {
        "slug",
        "titles",
        "category",
        "order",
        "lastVerified",
        "locales",
        "provenance",
    }
    assert getting["locales"] == ["en", "ru"]
    assert getting["titles"]["en"] == "Getting started"
    assert getting["titles"]["ru"] == "Начало работы"
    assert getting["provenance"]["sha"] == upstream_repo["sha"]


# --- selection purity (contract §6.6) ----------------------------------------


def test_selection_only_includes_listed_files(synced) -> None:
    content_out, _, report = synced
    corpus = {
        str(path.relative_to(content_out / "fakeproj"))
        for path in (content_out / "fakeproj").rglob("*.md")
    }
    assert corpus == {
        "en/user/getting-started.md",
        "en/user/cli-reference.md",
        "en/admin/security.md",
        "ru/user/getting-started.md",
        "ru/user/cli-reference.md",
    }
    assert not (content_out / "fakeproj" / "en" / "architecture").exists()


def test_missing_locale_source_is_skipped_not_fatal(synced) -> None:
    _, _, report = synced  # docs/ru/admin/security.md does not exist upstream
    assert {
        "project": "fakeproj",
        "locale": "ru",
        "path": "admin/security.md",
        "why": "source file missing in pinned clone",
    } in report["skipped"]


# --- image vendoring (contract §6.4) -----------------------------------------


def test_images_vendored_and_refs_rewritten(synced, upstream_repo) -> None:
    content_out, assets_out, report = synced
    vendored = assets_out / "fakeproj" / "docs/en/assets/logo.svg"
    assert vendored.is_file()
    assert vendored.read_text(encoding="utf-8") == SVG
    page = read_page(content_out, "en")
    assert "![logo](upstream/fakeproj/docs/en/assets/logo.svg)" in page
    assert "../assets/logo.svg" not in page
    assert report["projects"]["fakeproj"]["images"] == ["docs/en/assets/logo.svg"]


# --- mermaid label normalization (L1, ME-010, ADR-0020) -----------------------


def test_mermaid_literal_newline_labels_become_br() -> None:
    """Literal `\n` inside mermaid labels → `<br/>` in place."""
    src = (
        "```mermaid\n"
        "flowchart LR\n"
        "    A[Сырой текст] --> B[Сжатие\\n5-ступенчатый фильтр]\n"
        "    B --> C[Кэш оригинала\\nпо SHA-256]\n"
        "```\n"
    )
    fixed = sync_docs.normalize_mermaid_labels(src)
    assert "B[Сжатие<br/>5-ступенчатый фильтр]" in fixed
    assert "C[Кэш оригинала<br/>по SHA-256]" in fixed
    assert "\\n" not in fixed


def test_mermaid_labels_never_requoted() -> None:
    """Shape syntax must survive: a cylinder `[(x)]` stays unquoted."""
    src = (
        "```mermaid\n"
        "flowchart TB\n"
        "    L1[scanner\\nruns] -->|tag| DB[(mnemos store)]\n"
        "```\n"
    )
    fixed = sync_docs.normalize_mermaid_labels(src)
    assert "DB[(mnemos store)]" in fixed  # cylinder shape preserved
    assert '"' not in fixed  # no label gained quotes
    assert "L1[scanner<br/>runs]" in fixed


def test_mermaid_block_without_breaks_untouched() -> None:
    src = "```mermaid\nflowchart TB\n    A[plain] --> B[x]\n```\n"
    assert sync_docs.normalize_mermaid_labels(src) == src


def test_non_mermaid_fences_untouched() -> None:
    """The `\n` sequence in json/yaml/text fences is DATA — must not change."""
    json_fence = (
        "```json\n"
        '{\n  "compressed_text": "[compressed: a1b2... | 30000→900 chars]\\n'
        'отфильтрованный контент..."\n}\n'
        "```\n"
    )
    assert sync_docs.normalize_mermaid_labels(json_fence) == json_fence
    yaml_fence = "```yaml\nccr:\n  ttl_days: 7  # literal \\n stays\n```\n"
    assert sync_docs.normalize_mermaid_labels(yaml_fence) == yaml_fence
    text_fence = "```text\n[compressed: <hash> | 1→2]\\n retrieve\n```\n"
    assert sync_docs.normalize_mermaid_labels(text_fence) == text_fence


def test_mermaid_decision_and_edge_labels_untouched() -> None:
    """Node labels gain `<br/>`; edge labels `|...|` and shapes `{...}` stay."""
    src = (
        "```mermaid\n"
        "flowchart LR\n"
        "    F[mnemos_retrieve\\nхеш] --> G{query?}\n"
        "    G -->|да\\nнет| I[FTS5-сниппеты\\nранжированные]\n"
        "```\n"
    )
    fixed = sync_docs.normalize_mermaid_labels(src)
    assert "F[mnemos_retrieve<br/>хеш]" in fixed
    assert "{query?}" in fixed
    # Edge labels: `|да<br/>нет|` is valid mermaid (verified against
    # mermaid@11.17.2); delimiters stay untouched.
    assert "|да<br/>нет|" in fixed
    assert "I[FTS5-сниппеты<br/>ранжированные]" in fixed


def test_mermaid_label_transform_is_idempotent() -> None:
    src = (
        "```mermaid\n"
        "flowchart LR\n"
        "    A[Сырой текст] --> B[Сжатие\\n5-ступенчатый фильтр]\n"
        "```\n"
    )
    once = sync_docs.normalize_mermaid_labels(src)
    assert sync_docs.normalize_mermaid_labels(once) == once


def test_mermaid_normalization_applied_by_sync(tmp_path, config) -> None:
    repo = tmp_path / "mermaid-upstream"
    shutil.copytree(str(config["projects"]["fakeproj"]["repo"]), repo)
    (repo / "docs/en/user/cli-reference.md").write_text(
        "# CLI reference\n\n"
        "```mermaid\n"
        "flowchart LR\n"
        "    A[Raw text] --> B[Compress\\n5-stage filter]\n"
        "```\n",
        encoding="utf-8",
    )
    _git(repo, "config", "user.email", "153223100+Korrnals@users.noreply.github.com")
    _git(repo, "config", "user.name", "Korrnals")
    _git(repo, "commit", "-qam", "docs: mermaid fence")
    cfg = copy.deepcopy(config)
    cfg["projects"]["fakeproj"]["repo"] = str(repo)
    cfg["projects"]["fakeproj"]["ref"] = _git(repo, "rev-parse", "HEAD")
    content_out = tmp_path / "c-mermaid"
    sync_docs.sync(cfg, content_out=content_out, assets_out=tmp_path / "a-mermaid")
    page = (content_out / "fakeproj" / "en" / "user" / "cli-reference.md").read_text(
        encoding="utf-8"
    )
    assert "B[Compress<br/>5-stage filter]" in page
    fence = page.split("```mermaid")[1].split("```")[0]
    assert "\\n" not in fence
    assert '"' not in fence


def test_curated_translation_mermaid_labels_normalized(tmp_path, config) -> None:
    curated_text = CURATED_TRANSLATION.replace(
        "Переведённое вводное руководство узла fakemesh.",
        "```mermaid\nflowchart LR\n    A[Узел\\nфакмеш] --> B[Готово]\n```\n",
    )
    _make_curated(tmp_path, curated_text)
    _run_sync(tmp_path, config)
    slot = tmp_path / "c" / "fakemesh" / "ru" / "user" / "getting-started.md"
    page = slot.read_text(encoding="utf-8")
    assert "A[Узел<br/>факмеш]" in page
    fence = page.split("```mermaid")[1].split("```")[0]
    assert "\\n" not in fence


# --- clone integrity + drift ---------------------------------------------------


def test_dirty_clone_refuses_sync(tmp_path, config, upstream_repo) -> None:
    dirty = tmp_path / "dirty-clone"
    shutil.copytree(str(upstream_repo["repo"]), dirty)
    (dirty / "docs/en/user/getting-started.md").write_text(
        EN_GETTING_STARTED + "\nuncommitted edit\n", encoding="utf-8"
    )
    dirty_cfg = copy.deepcopy(config)
    dirty_cfg["projects"]["fakeproj"]["repo"] = str(dirty)
    with pytest.raises(SyncError, match="tracked modifications"):
        sync_docs.sync(
            dirty_cfg, content_out=tmp_path / "c", assets_out=tmp_path / "a"
        )


def test_check_drift_detects_new_commits(tmp_path, config, upstream_repo) -> None:
    moved = tmp_path / "drift-clone"
    shutil.copytree(str(upstream_repo["repo"]), moved)
    (moved / "docs/en/user/cli-reference.md").write_text(
        "# CLI reference\n\nEvery command. Updated.\n", encoding="utf-8"
    )
    _git(moved, "config", "user.email", "153223100+Korrnals@users.noreply.github.com")
    _git(moved, "config", "user.name", "Korrnals")
    _git(moved, "commit", "-qam", "docs: upstream moved on")

    moved_cfg = copy.deepcopy(config)
    moved_cfg["projects"]["fakeproj"]["repo"] = str(moved)
    drifted = sync_docs.check_drift(moved_cfg)
    entry = drifted["projects"]["fakeproj"]
    assert entry["drift"] is True
    assert entry["new_doc_commits"] and "docs: upstream moved on" in entry["new_doc_commits"][0]

    repin = copy.deepcopy(config)
    repin["projects"]["fakeproj"]["ref"] = _git(moved, "rev-parse", "HEAD")
    repin["projects"]["fakeproj"]["repo"] = str(moved)
    assert sync_docs.check_drift(repin)["projects"]["fakeproj"]["drift"] is False


# --- config sanity -------------------------------------------------------------


def test_include_exclude_overlap_is_refused(tmp_path, config) -> None:
    broken = copy.deepcopy(config)
    broken["projects"]["fakeproj"]["exclude"].append(
        {"path": "admin/security.md", "reason": "clash"}
    )
    with pytest.raises(SyncError, match="overlaps exclude"):
        sync_docs.sync(
            broken,
            content_out=tmp_path / "c3",
            assets_out=tmp_path / "a3",
        )


# --- curated translations (our layer, re-sync-proof) --------------------------


def _make_curated(tmp_path: Path, text: str = CURATED_TRANSLATION) -> Path:
    curated = tmp_path / CURATED_TRANSLATION_PATH
    curated.parent.mkdir(parents=True, exist_ok=True)
    curated.write_text(text, encoding="utf-8")
    return curated


def _run_sync(tmp_path: Path, config: dict[str, object]) -> dict[str, object]:
    return sync_docs.sync(
        config,
        content_out=tmp_path / "c",
        assets_out=tmp_path / "a",
        repo_root=tmp_path,
    )


def test_curated_translation_published_with_full_provenance(
    tmp_path, config, upstream_repo
) -> None:
    _make_curated(tmp_path)
    report = _run_sync(tmp_path, config)
    slot = tmp_path / "c" / "fakemesh" / "ru" / "user" / "getting-started.md"
    assert slot.is_file()
    page = slot.read_text(encoding="utf-8")
    fields = parse_frontmatter(page)
    # writer's title survives; slot identity is enforced from the en entry
    assert fields["title"] == "Начало работы (fakemesh)"
    assert fields["slug"] == "fakemesh/user/getting-started"
    assert fields["category"] == "fake-mesh"
    assert fields["order"] == "1"
    assert fields["last_verified"] == str(upstream_repo["commit_date"])[:10]
    assert "Переведённое вводное руководство" in page
    assert "GENERATED by sync_docs (curated translation" in page
    provenance = json.loads(
        (tmp_path / "c" / "provenance.json").read_text(encoding="utf-8")
    )
    entry = provenance["files"]["fakemesh/user/getting-started"]["ru"]
    assert entry["kind"] == "curated-translation"
    assert entry["source_sha"] == upstream_repo["sha"]
    assert entry["source_path"] == CURATED_TRANSLATION_PATH
    assert entry["translator_note"] == "Кураторский перевод; оригинал en"
    sidecar = json.loads(
        (tmp_path / "c" / "manifest.sidecar.json").read_text(encoding="utf-8")
    )
    mesh_page = next(
        p for p in sidecar["pages"] if p["slug"] == "fakemesh/user/getting-started"
    )
    assert mesh_page["locales"] == ["en", "ru"]
    assert mesh_page["kinds"] == {"ru": "curated-translation"}
    assert report["projects"]["fakemesh"]["translations"] == [
        "ru/user/getting-started.md"
    ]


def test_translation_survives_resync_byte_identical(tmp_path, config) -> None:
    _make_curated(tmp_path)
    _run_sync(tmp_path, config)
    slot = tmp_path / "c" / "fakemesh" / "ru" / "user" / "getting-started.md"
    first = slot.read_bytes()
    _run_sync(tmp_path, config)  # full wipe + regenerate happens in between
    assert slot.read_bytes() == first


def test_missing_translation_file_is_warning_not_failure(tmp_path, config) -> None:
    # curated file intentionally NOT created
    report = _run_sync(tmp_path, config)
    assert not (tmp_path / "c" / "fakemesh" / "ru").exists()
    assert {
        "project": "fakemesh",
        "locale": "ru",
        "path": CURATED_TRANSLATION_PATH,
        "why": "curated translation file missing",
    } in report["skipped"]
