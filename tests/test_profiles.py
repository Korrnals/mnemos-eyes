"""BE-9: per-agent profile scoping, shared dedup, refresh idempotency.

The unit contour builds a synthetic GCW plugin tree (two agents sharing
one plugin — the exact shape that made scripts/sync-gcw-profiles.py
duplicate every skill across every card) and asserts:

- sections carry ONLY the agent's own file + explicitly referenced
  skills/instructions (no cross-agent duplication),
- plugin-level material lands once in ``shared`` with shared=true and
  never leaks into per-agent sections,
- the builder is deterministic and the refresh-all endpoint upserts a
  single stable cache row per specialist (repeat runs do not dupe).
"""

from __future__ import annotations

from pathlib import Path

import pytest

import server.profiles as profiles

ALPHA_MD = """---
name: "GCW: Alpha"
description: (GCW) Test agent alpha.
agents:
  - "GCW: Beta"
---

# GCW: Alpha

Apply skill `ref-skill`.
Apply `gamma-rule` for grounding. Delegate deep work to `@GCW: Beta`.
"""

BETA_MD = """---
name: "GCW: Beta"
description: (GCW) Test agent beta.
---

# GCW: Beta

Apply skill `beta-skill`.
"""


@pytest.fixture()
def fake_gcw(tmp_path: Path) -> Path:
    """Synthetic GCW repo: one plugin, two agents, three skills, prompts,
    canon instructions — mirroring the real gcw-engineering layout."""
    root = tmp_path / "gcw"
    plugins = root / "plugins" / "fake-eng"
    (plugins / "agents").mkdir(parents=True)
    (plugins / "skills" / "ref-skill").mkdir(parents=True)
    (plugins / "skills" / "beta-skill").mkdir(parents=True)
    (plugins / "skills" / "lonely-skill").mkdir(parents=True)
    (plugins / "prompts").mkdir(parents=True)
    instr = root / "instructions"
    instr.mkdir(parents=True)

    (plugins / "agents" / "alpha.agent.md").write_text(ALPHA_MD)
    (plugins / "agents" / "beta.agent.md").write_text(BETA_MD)
    for skill in ("ref-skill", "beta-skill", "lonely-skill"):
        (plugins / "skills" / skill / "SKILL.md").write_text(
            f"# {skill}\n\n{skill} body text.\n")
    (plugins / "prompts" / "run-x.prompt.md").write_text("# run-x\n")
    (plugins / "plugin.json").write_text('{"name": "fake-eng"}')
    (instr / "gamma-rule.instructions.md").write_text("# gamma rule\n")
    (instr / "core-rule.instructions.md").write_text("# core rule\n")
    return root


@pytest.fixture()
def scoped_builder(fake_gcw: Path, monkeypatch):
    monkeypatch.setattr(profiles, "GCW_PLUGINS_DIR", fake_gcw / "plugins")
    monkeypatch.setattr(profiles, "GCW_INSTRUCTIONS_DIR",
                        fake_gcw / "instructions")
    return profiles.build_profile


@pytest.fixture()
def scoped_app(fake_gcw: Path, monkeypatch):
    """Point the app-imported builder at the synthetic tree."""
    monkeypatch.setattr(profiles, "GCW_PLUGINS_DIR", fake_gcw / "plugins")
    monkeypatch.setattr(profiles, "GCW_INSTRUCTIONS_DIR",
                        fake_gcw / "instructions")


def _names(entries):
    return sorted(e["title"] for e in entries)


class TestPerAgentScoping:
    def test_own_agent_file_is_the_instruction_entry(self, scoped_builder):
        p = scoped_builder("GCW: Alpha")
        assert p is not None
        instr = p["sections"]["instructions"]
        assert len(instr) == 1
        assert instr[0]["kind"] == "agent-file"
        assert instr[0]["scope"] == "agent"
        assert instr[0]["shared"] is False
        assert "alpha.agent.md" in instr[0]["title"]
        assert p["meta"]["name"] == "GCW: Alpha"
        assert p["meta"]["delegates_to"] == ["GCW: Beta"]

    def test_referenced_skill_scoped_to_referencing_agent(self, scoped_builder):
        alpha = scoped_builder("GCW: Alpha")
        beta = scoped_builder("GCW: Beta")
        assert _names(alpha["sections"]["skills"]) == \
            ["[skills] ref-skill — fake-eng/skills/ref-skill/SKILL.md"]
        assert _names(beta["sections"]["skills"]) == \
            ["[skills] beta-skill — fake-eng/skills/beta-skill/SKILL.md"]

    def test_no_cross_agent_skill_duplication(self, scoped_builder):
        alpha_titles = _names(scoped_builder("GCW: Alpha")["sections"]["skills"])
        beta_titles = _names(scoped_builder("GCW: Beta")["sections"]["skills"])
        assert not any("beta-skill" in t for t in alpha_titles)
        assert not any("ref-skill" in t for t in beta_titles)

    def test_referenced_instruction_lands_in_rules(self, scoped_builder):
        alpha = scoped_builder("GCW: Alpha")
        rules = alpha["sections"]["rules"]
        assert [e["kind"] for e in rules] == ["instruction"]
        assert "gamma-rule" in rules[0]["title"]
        assert rules[0]["shared"] is False
        assert rules[0]["scope"] == "agent"

    def test_slug_and_stem_aliases_resolve(self, scoped_builder):
        p1 = scoped_builder("GCW: Alpha")
        # specialist / meta.role / (meta.)slug echo the REQUESTED name by
        # design (cache key + legacy mnemos tag); the payload itself and
        # the resolved agent must be identical
        def payload(p):
            meta = {k: v for k, v in p["meta"].items() if k != "role"}
            meta.pop("slug", None)
            return {k: v for k, v in p.items()
                    if k not in ("specialist", "slug")} | {"meta": meta}
        assert payload(scoped_builder("gcw-alpha")) == payload(p1)
        assert payload(scoped_builder("alpha")) == payload(p1)

    def test_unknown_agent_returns_none(self, scoped_builder):
        assert scoped_builder("gcw-nobody") is None


class TestSharedDedup:
    def test_unreferenced_plugin_skills_are_shared_not_per_agent(
            self, scoped_builder):
        for name in ("GCW: Alpha", "GCW: Beta"):
            p = scoped_builder(name)
            per_agent = " ".join(_names(p["sections"]["skills"]))
            assert "lonely-skill" not in per_agent
            shared = p["shared"]["sections"]["skills"]
            lonely = [e for e in shared if "lonely-skill" in e["title"]]
            assert len(lonely) == 1
            assert lonely[0]["shared"] is True
            assert lonely[0]["scope"] == "plugin"

    def test_shared_block_summary_and_counts(self, scoped_builder):
        p = scoped_builder("GCW: Alpha")
        shared = p["shared"]
        assert shared["plugin"] == "fake-eng"
        assert shared["total"] == sum(shared["counts"].values())
        assert shared["counts"]["skills"] == 2  # lonely + beta-skill
        assert "+2 plugin skills" in shared["summary"]
        # prompts and the unreferenced canon rule are shared too
        assert shared["counts"]["triggers"] == 1
        assert any("core-rule" in e["title"]
                   for e in shared["sections"]["rules"])

    def test_manifest_is_shared_rule(self, scoped_builder):
        p = scoped_builder("GCW: Alpha")
        manifests = [e for e in p["shared"]["sections"]["rules"]
                     if e["kind"] == "manifest"]
        assert len(manifests) == 1
        assert "plugin.json" in manifests[0]["title"]

    def test_shared_excerpts_bounded(self, scoped_builder):
        # BE-6 cache-size guard: shared listings are summaries, not dumps.
        p = scoped_builder("GCW: Alpha")
        for entries in p["shared"]["sections"].values():
            for e in entries:
                assert len(e["excerpt"]) <= profiles.SHARED_EXCERPT_LIMIT


class TestDeterminism:
    def test_repeated_build_is_byte_stable(self, scoped_builder):
        p1 = scoped_builder("GCW: Alpha")
        p2 = scoped_builder("GCW: Alpha")
        assert p1 == p2

    def test_refresh_all_idempotent_no_duplicate_cache(
            self, client, auth, app_module, scoped_app, make_task):
        make_task(title="be9 idempotency", specialists=["GCW: Alpha"])

        r1 = client.post("/api/specialists/refresh-all", headers=auth)
        assert r1.status_code == 200
        assert r1.json()["built"] == 1
        assert r1.json()["failed"] == 0

        # the board specialist string is the cache key — the SPA queries
        # the same display name via the slash-safe query-param route
        p1 = client.get("/api/specialists/profile",
                        params={"name": "GCW: Alpha"}).json()
        assert p1["cached"] is True
        assert p1["indexed"] is True

        # second run: same content, cache stays a single upserted row
        r2 = client.post("/api/specialists/refresh-all", headers=auth)
        assert r2.json()["built"] == 1
        p2 = client.get("/api/specialists/profile",
                        params={"name": "GCW: Alpha"}).json()
        assert p1["sections"] == p2["sections"]
        assert p1["shared"] == p2["shared"]

    def test_profile_route_contract(self, client, scoped_app):
        p = client.get("/api/specialists/profile?name=gcw-alpha").json()
        assert p["ok"] is True
        assert p["specialist"] == "gcw-alpha"
        assert p["builder"] == profiles.BUILDER_VERSION
        for entry in p["sections"]["skills"]:
            assert {"title", "source_url", "excerpt",
                    "shared", "scope", "kind"} <= set(entry)

    def test_openapi_exposes_profile_models(self, client):
        spec = client.get("/openapi.json").json()
        schemas = spec.get("components", {}).get("schemas", {})
        assert "SpecialistProfileOut" in schemas
        assert "RefreshAllOut" in schemas
        get_schema = (spec["paths"]["/api/specialists/{name}/profile"]["get"]
                      ["responses"]["200"]["content"]["application/json"]
                      ["schema"])
        assert get_schema["$ref"].endswith("SpecialistProfileOut")
        post_schema = (spec["paths"]["/api/specialists/refresh-all"]["post"]
                       ["responses"]["200"]["content"]["application/json"]
                       ["schema"])
        assert post_schema["$ref"].endswith("RefreshAllOut")
