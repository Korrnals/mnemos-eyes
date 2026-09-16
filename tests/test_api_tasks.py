"""Board task API: CRUD, move, archive/unarchive, mutation guard
(SEC-3 fail-closed 503 / 401), BE-1 (invalid env -> 422, never 500) and
BE-5 agents validation (pin ADR 0005, separate test class below).

Runs against the in-process app with the conftest-pinned throwaway env;
``VESMARO_BOARD_TOKEN`` is set by default, the fail-closed class switches
it off per test via monkeypatch.
"""

from __future__ import annotations


# ------------------------------------------------------- mutation guard
class TestMutationGuard:
    """SEC-3: with a token configured, mutations need Bearer auth."""

    def test_missing_token_401(self, client):
        r = client.post("/api/tasks", json={"title": "x"})
        assert r.status_code == 401

    def test_wrong_token_401(self, client):
        r = client.post("/api/tasks", json={"title": "x"},
                        headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 401

    def test_correct_token_201_and_shape(self, client, auth):
        r = client.post("/api/tasks", json={"title": "guarded"},
                        headers=auth)
        assert r.status_code == 201, r.text
        body = r.json()
        client.delete(f"/api/tasks/{body['id']}", headers=auth)
        for key in ("id", "title", "col", "env", "position", "agents",
                    "specialists", "created_at", "updated_at"):
            assert key in body


class TestFailClosedNoToken:
    """SEC-3 fail-closed: token NOT configured -> every mutation is 503,
    even with an ad-hoc Bearer. Reads stay open."""

    def test_mutation_without_token_503(self, client, no_board_token):
        r = client.post("/api/tasks", json={"title": "x"})
        assert r.status_code == 503

    def test_mutation_with_adhoc_token_still_503(self, client, no_board_token):
        r = client.post("/api/tasks", json={"title": "x"},
                        headers={"Authorization": "Bearer surprise-token"})
        assert r.status_code == 503

    def test_reads_still_allowed(self, client, no_board_token):
        assert client.get("/api/board").status_code == 200


# ------------------------------------------------------------- CRUD + move
class TestTaskCrudApi:
    def test_create_and_visible_on_board(self, client, auth, make_task):
        task = make_task(title="crud-1", env="laptop")
        board = client.get("/api/board").json()
        assert task["id"] in [t["id"] for t in board["tasks"]]
        assert task["env"] == "laptop"

    def test_create_invalid_col_422(self, client, auth):
        r = client.post("/api/tasks", json={"title": "x", "col": "backlog"},
                        headers=auth)
        assert r.status_code == 422

    def test_create_missing_title_422(self, client, auth):
        r = client.post("/api/tasks", json={}, headers=auth)
        assert r.status_code == 422

    def test_create_empty_title_422(self, client, auth):
        r = client.post("/api/tasks", json={"title": ""}, headers=auth)
        assert r.status_code == 422

    def test_patch_title_and_summary(self, client, auth, make_task):
        task = make_task(title="before")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"title": "after", "summary": "s"},
                         headers=auth)
        assert r.status_code == 200
        assert r.json()["title"] == "after"
        assert r.json()["summary"] == "s"

    def test_patch_unknown_task_404(self, client, auth):
        r = client.patch("/api/tasks/no-such-id", json={"title": "x"},
                         headers=auth)
        assert r.status_code == 404

    def test_move_task_200(self, client, auth, make_task):
        task = make_task(title="mover")
        r = client.post(f"/api/tasks/{task['id']}/move",
                        json={"col": "done"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["col"] == "done"

    def test_move_invalid_col_422(self, client, auth, make_task):
        task = make_task(title="mover2")
        r = client.post(f"/api/tasks/{task['id']}/move",
                        json={"col": "backlog"}, headers=auth)
        assert r.status_code == 422

    def test_move_unknown_task_404(self, client, auth):
        r = client.post("/api/tasks/no-such-id/move", json={"col": "done"},
                        headers=auth)
        assert r.status_code == 404

    def test_delete_then_404(self, client, auth, make_task):
        task = make_task(title="doomed")
        assert client.delete(f"/api/tasks/{task['id']}",
                             headers=auth).status_code == 200
        assert client.delete(f"/api/tasks/{task['id']}",
                             headers=auth).status_code == 404

    def test_archive_unarchive_endpoints(self, client, auth, make_task):
        task = make_task(title="arch-me")
        base = f"/api/tasks/{task['id']}"
        assert client.post(f"{base}/archive", headers=auth).status_code == 200
        board_ids = [t["id"] for t in client.get("/api/board").json()["tasks"]]
        assert task["id"] not in board_ids
        assert client.post(f"{base}/archive", headers=auth).status_code == 404

        assert client.post(f"{base}/unarchive", headers=auth).status_code == 200
        board_ids = [t["id"] for t in client.get("/api/board").json()["tasks"]]
        assert task["id"] in board_ids
        assert client.post(f"{base}/unarchive",
                           headers=auth).status_code == 404

    def test_archive_unknown_task_404(self, client, auth):
        r = client.post("/api/tasks/no-such-id/archive", headers=auth)
        assert r.status_code == 404


class TestBE1InvalidEnvIs422Never500:
    """BE-1: store-level ValueError (unknown env / col) must surface as
    HTTP 422 from POST and PATCH, never as an unhandled 500."""

    def test_post_invalid_env_422(self, client, auth):
        r = client.post("/api/tasks", json={"title": "x", "env": "staging"},
                        headers=auth)
        assert r.status_code == 422

    def test_patch_invalid_env_422(self, client, auth, make_task):
        task = make_task(title="env-patch")
        r = client.patch(f"/api/tasks/{task['id']}", json={"env": "prod"},
                         headers=auth)
        assert r.status_code == 422

    def test_post_invalid_col_422_not_500(self, client, auth):
        r = client.post("/api/tasks", json={"title": "x", "col": "backlog"},
                        headers=auth)
        assert r.status_code == 422


class TestAgentsAreHarnessesNotRoles:
    """pin ADR 0005: ``agents`` holds execution harnesses (zcode, hermes,
    ...). Role-shaped values (@GCW: ... / gcw-*) are SPECIALISTS and must
    be rejected with 422 on create AND patch (BE-5)."""

    def test_create_rejects_gcw_role_slug(self, client, auth):
        r = client.post("/api/tasks", json={"title": "x",
                                            "agents": ["gcw-sre-devops"]},
                        headers=auth)
        assert r.status_code == 422
        assert "specialists" in r.text

    def test_create_rejects_at_role_prefix(self, client, auth):
        r = client.post("/api/tasks", json={"title": "x",
                                            "agents": ["@GCW: SRE/DevOps"]},
                        headers=auth)
        assert r.status_code == 422

    def test_patch_rejects_gcw_role_slug(self, client, auth, make_task):
        task = make_task(title="patch-agents")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"agents": ["gcw-tech-lead"]}, headers=auth)
        assert r.status_code == 422

    def test_create_accepts_harness_name(self, client, auth):
        r = client.post("/api/tasks", json={"title": "harnessed",
                                            "agents": ["zcode"]},
                        headers=auth)
        assert r.status_code == 201
        assert r.json()["agents"] == ["zcode"]
        client.delete(f"/api/tasks/{r.json()['id']}", headers=auth)

    def test_patch_accepts_harness_list(self, client, auth, make_task):
        task = make_task(title="patch-agents-ok")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"agents": ["zcode", "hermes"]}, headers=auth)
        assert r.status_code == 200
        assert r.json()["agents"] == ["zcode", "hermes"]
