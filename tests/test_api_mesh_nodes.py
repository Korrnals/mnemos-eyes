"""Mesh-node registry API (W5, ROADMAP-v2 §5): CRUD against the W5
healthz contract, honest-offline health, SEC-1 egress reuse for
``base_url`` (SSRF tripwire via the Decoy), SSE ``mesh.node.changed``
on mutations, and the ``/api/health`` mesh block.

The node double is conftest's FakeMeshNode (a separate healthz double —
the mnemos FakeMnemos speaks the memory-server contract, not the mesh
one). No token exists anywhere in the node path: probes must carry no
Authorization header, and the API surface must stay token-free.
"""

from __future__ import annotations


def _add(client, auth, payload):
    return client.post("/api/mesh/nodes", json=payload, headers=auth)


def _allow(fake_mesh_node, allow_hosts):
    allow_hosts(f"127.0.0.1:{fake_mesh_node.port}")


# ------------------------------------------------------------- CRUD + health
class TestMeshNodeCrud:
    def test_add_probes_healthz_and_parses_contract(
            self, client, auth, fake_mesh_node, allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        r = _add(client, auth, {"name": "cluster-a",
                                "base_url": fake_mesh_node.base_url,
                                "description": "кластерный узел"})
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["probe_status"] == 200
        assert body["status"] == "ok"
        assert body["ok"] is True
        assert body["health"]["version"] == "v1.2.3"
        assert body["health"]["node_id"] == "node-qa-1"
        assert body["health"]["uptime_seconds"] == 3661
        assert body["health"]["core_connected"] is True
        assert body["health"]["peers_total"] == 2
        assert body["health"]["peers_reachable"] == 1

        listed = {n["name"]: n for n in
                  client.get("/api/mesh/nodes").json()["nodes"]}
        assert listed["cluster-a"]["status"] == "ok"
        assert listed["cluster-a"]["health"]["peers_reachable"] == 1
        client.delete("/api/mesh/nodes/cluster-a", headers=auth)

    def test_duplicate_name_409(self, client, auth, fake_mesh_node,
                                allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        payload = {"name": "dup-node", "base_url": fake_mesh_node.base_url}
        assert _add(client, auth, payload).status_code == 201
        assert _add(client, auth, payload).status_code == 409
        client.delete("/api/mesh/nodes/dup-node", headers=auth)

    def test_patch_updates_and_disables(self, client, auth, fake_mesh_node,
                                        allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        assert _add(client, auth, {"name": "patch-node",
                                   "base_url": fake_mesh_node.base_url,
                                   "description": "до"}).status_code == 201
        r = client.patch("/api/mesh/nodes/patch-node",
                         json={"name": "patch-node",
                               "base_url": fake_mesh_node.base_url,
                               "description": "после", "enabled": False},
                         headers=auth)
        assert r.status_code == 200, r.text
        assert r.json()["description"] == "после"
        assert r.json()["enabled"] is False
        # disabled rows are never probed: the fake sees no new healthz hit
        before = len(fake_mesh_node.healthz_requests())
        listed = {n["name"]: n for n in
                  client.get("/api/mesh/nodes").json()["nodes"]}
        assert listed["patch-node"]["status"] == "disabled"
        assert listed["patch-node"]["ok"] is None
        assert len(fake_mesh_node.healthz_requests()) == before
        client.delete("/api/mesh/nodes/patch-node", headers=auth)

    def test_patch_unknown_404(self, client, auth, fake_mesh_node,
                               allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        r = client.patch("/api/mesh/nodes/ghost",
                         json={"name": "ghost",
                               "base_url": fake_mesh_node.base_url},
                         headers=auth)
        assert r.status_code == 404

    def test_delete_and_redelete_404(self, client, auth, fake_mesh_node,
                                     allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        _add(client, auth, {"name": "doomed-node",
                            "base_url": fake_mesh_node.base_url})
        assert client.delete("/api/mesh/nodes/doomed-node",
                             headers=auth).status_code == 200
        assert client.delete("/api/mesh/nodes/doomed-node",
                             headers=auth).status_code == 404

    def test_no_token_field_anywhere(self, client, auth, fake_mesh_node,
                                     allow_hosts):
        """A mesh node holds no secret by contract — the API surface must
        not even model one."""
        _allow(fake_mesh_node, allow_hosts)
        _add(client, auth, {"name": "tokcheck", "base_url": fake_mesh_node.base_url})
        r = client.get("/api/mesh/nodes")
        assert "token" not in r.text
        client.delete("/api/mesh/nodes/tokcheck", headers=auth)


# ------------------------------------------------------- honest-offline probes
class TestHealthzFailureModes:
    def test_probe_carries_no_authorization(self, client, auth,
                                            fake_mesh_node, allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        _add(client, auth, {"name": "noauth-node",
                            "base_url": fake_mesh_node.base_url})
        client.get("/api/mesh/nodes")
        probes = fake_mesh_node.healthz_requests()
        assert probes, "healthz probe must have been sent"
        assert not any(p["auth_present"] for p in probes), \
            "healthz is unauthenticated by contract — no Authorization header"
        client.delete("/api/mesh/nodes/noauth-node", headers=auth)

    def test_unreachable_node_is_offline_not_error(
            self, client, auth, allow_hosts):
        """Connection-refused port (allowlisted): the registry keeps the
        node, health honestly says offline (store error-state pattern)."""
        allow_hosts("127.0.0.1:1")   # nothing listens there
        r = _add(client, auth, {"name": "dead-node",
                                "base_url": "http://127.0.0.1:1"})
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["status"] == "offline"
        assert body["ok"] is False
        assert body["probe_status"] == 503
        assert body["error"]
        listed = {n["name"]: n for n in
                  client.get("/api/mesh/nodes").json()["nodes"]}
        assert listed["dead-node"]["status"] == "offline"
        client.delete("/api/mesh/nodes/dead-node", headers=auth)

    def test_degraded_status_passthrough(self, client, auth, fake_mesh_node,
                                         allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        _add(client, auth, {"name": "deg-node",
                            "base_url": fake_mesh_node.base_url})
        fake_mesh_node.degraded = True
        listed = {n["name"]: n for n in
                  client.get("/api/mesh/nodes").json()["nodes"]}
        assert listed["deg-node"]["status"] == "degraded"
        assert listed["deg-node"]["ok"] is True
        assert listed["deg-node"]["health"]["core_connected"] is False
        client.delete("/api/mesh/nodes/deg-node", headers=auth)

    def test_non_json_healthz_is_offline(self, client, auth, fake_mesh_node,
                                         allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        _add(client, auth, {"name": "garbage-node",
                            "base_url": fake_mesh_node.base_url})
        fake_mesh_node.non_json = True
        listed = {n["name"]: n for n in
                  client.get("/api/mesh/nodes").json()["nodes"]}
        assert listed["garbage-node"]["status"] == "offline"
        assert listed["garbage-node"]["error"]
        client.delete("/api/mesh/nodes/garbage-node", headers=auth)

    def test_http_500_healthz_is_offline(self, client, auth, fake_mesh_node,
                                         allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        _add(client, auth, {"name": "fivehundred",
                            "base_url": fake_mesh_node.base_url})
        fake_mesh_node.fail_healthz = True
        listed = {n["name"]: n for n in
                  client.get("/api/mesh/nodes").json()["nodes"]}
        assert listed["fivehundred"]["status"] == "offline"
        client.delete("/api/mesh/nodes/fivehundred", headers=auth)


# ------------------------------------------------------- SEC-1 egress (SSRF)
class TestMeshNodeEgressPolicy:
    def test_rejected_base_url_never_connects(self, client, auth,
                                              fake_mesh_node, decoy,
                                              allow_hosts):
        """422 + decoy stays silent for every attacker-shaped base_url —
        same SEC-1 boundary as memory servers, decided pre-network."""
        _allow(fake_mesh_node, allow_hosts)
        cases = [
            ("http://10.255.255.1:9999", "private v4 host"),
            (f"http://127.0.0.1:{decoy.port}", "port outside allowlist"),
            ("http://user:pw@example.com", "userinfo in URL"),
            ("ftp://example.com", "non-http scheme"),
        ]
        for url, label in cases:
            r = _add(client, auth, {"name": "evil-node", "base_url": url})
            assert r.status_code == 422, f"{label}: {r.status_code} {r.text}"
            assert decoy.connections() == 0, \
                f"{label}: rejected base_url was actually contacted"

    def test_patch_to_disallowed_host_422(self, client, auth, fake_mesh_node,
                                          allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        assert _add(client, auth, {"name": "patch-egress",
                                   "base_url": fake_mesh_node.base_url}
                    ).status_code == 201
        r = client.patch("/api/mesh/nodes/patch-egress",
                         json={"name": "patch-egress",
                               "base_url": "http://10.255.255.1"},
                         headers=auth)
        assert r.status_code == 422
        client.delete("/api/mesh/nodes/patch-egress", headers=auth)


# ---------------------------------------------------------------- SSE events
class TestMeshNodeSse:
    def test_mutations_broadcast_mesh_node_changed(self, client, auth,
                                                   fake_mesh_node,
                                                   allow_hosts, app_module,
                                                   monkeypatch):
        _allow(fake_mesh_node, allow_hosts)
        captured: list[dict] = []
        monkeypatch.setattr(app_module, "_broadcast", captured.append)
        _add(client, auth, {"name": "sse-node",
                            "base_url": fake_mesh_node.base_url})
        client.patch("/api/mesh/nodes/sse-node",
                     json={"name": "sse-node",
                           "base_url": fake_mesh_node.base_url},
                     headers=auth)
        client.delete("/api/mesh/nodes/sse-node", headers=auth)
        kinds = [(e["kind"], e.get("node")) for e in captured]
        assert ("mesh.node.changed", "sse-node") in kinds
        assert kinds.count(("mesh.node.changed", "sse-node")) == 3, \
            "every mutation (create/patch/delete) must broadcast once"


# ------------------------------------------------------------ /api/health mesh
class TestHealthBlock:
    def test_health_carries_mesh_nodes(self, client, auth, fake_mesh_node,
                                       allow_hosts):
        _allow(fake_mesh_node, allow_hosts)
        _add(client, auth, {"name": "health-node",
                            "base_url": fake_mesh_node.base_url})
        h = client.get("/api/health").json()
        mesh = h.get("mesh", {}).get("nodes", [])
        entry = next((n for n in mesh if n["name"] == "health-node"), None)
        assert entry is not None, "mesh block missing from /api/health"
        assert entry["status"] == "ok"
        assert entry["health"]["version"] == "v1.2.3"
        client.delete("/api/mesh/nodes/health-node", headers=auth)

    def test_health_mesh_empty_when_no_nodes(self, client):
        h = client.get("/api/health").json()
        assert h["mesh"]["nodes"] == []


# ------------------------------------------------------------- auth boundary
class TestMeshNodeAuth:
    def test_mutation_requires_token(self, client, no_board_token):
        """Fail-closed (SEC-3): with no token class configured, every
        mesh-node mutation answers 503; reads stay open."""
        r = client.post("/api/mesh/nodes",
                        json={"name": "x", "base_url": "http://example.com"})
        assert r.status_code == 503
        assert client.get("/api/mesh/nodes").status_code == 200
