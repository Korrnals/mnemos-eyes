# vesmaro-eyes — task board container
#
# Multi-stage (ADR 0011 Ф0a): the React viewer is built from viewer/ in a
# Node stage and its dist/ ships inside the board image at /app/app
# (VESMARO_APP_DIR) — one Deployment/Ingress/NetPol serves both the board
# at / and the viewer at /app. Codegen for the viewer runs off the
# committed viewer/openapi-snapshot.json (offline: no mnemos access, no
# network API calls at build time). npm ci needs the registry; that is the
# only network dependency of the build.
#
# Runtime: Python 3.12 slim, data (SQLite) on a mounted volume at /data.

FROM node:22-alpine AS viewer-builder

WORKDIR /build

# Manifests first for layer caching; .dockerignore keeps node_modules and
# a stale dist/ out of the context, so npm ci is the single dependency
# source of truth.
COPY viewer/package.json viewer/package-lock.json ./
RUN npm ci

COPY viewer/ ./
RUN npm run build

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VESMARO_DATA=/data \
    VESMARO_WEB=/app/web \
    VESMARO_APP_DIR=/app/app \
    VESMARO_POLLER_DIR=/app/poller

WORKDIR /app

COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

COPY server/ /app/server/
COPY web/ /app/web/
COPY --from=viewer-builder /build/dist/ /app/app/
# Poller bootstrap artifacts (wave 3D): the board serves its own installer
# (GET /api/poller/*) from these packaged files — always in sync with the
# running board. The lab CA is NOT here: it mounts from the k8s TLS secret
# (chart values pollerBootstrap.caFile -> VESMARO_TLS_CA_FILE).
COPY scripts/assignment_poller.py /app/poller/assignment_poller.py
COPY deploy/poller/bootstrap.sh \
     deploy/poller/vesmaro-assignment-poller.service \
     deploy/poller/poller.example.yaml \
     /app/poller/

# Runs as uid 0 inside the container: under rootless podman/k8s this maps to
# the host uid (k8s securityContext pins runAsUser=1000), and on bind mounts
# the SQLite WAL files then land with the host owner instead of root.
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=12s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=10).status==200 else 1)"

# --proxy-headers: behind the k3s traefik ingress the socket peer is the
# ingress pod, not the client — without this, client-IP keyed controls
# (pairing source-IP binding, per-IP rate limits) see one shared address.
# Whom to trust is scoped by FORWARDED_ALLOW_IPS (values.yaml extraEnv):
# "*" is safe because the chart NetPol admits ingress traffic from the
# traefik namespace only (the LAN diagnostics window ships disabled).
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8080", \
     "--proxy-headers"]
