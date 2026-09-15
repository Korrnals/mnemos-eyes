# vesmaro-eyes — task board container
#
# Python 3.12 slim, non-root, healthcheck on /api/health.
# Data (SQLite) lives on a mounted volume at /data.

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VESMARO_DATA=/data \
    VESMARO_WEB=/app/web

WORKDIR /app

COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

COPY server/ /app/server/
COPY web/ /app/web/

# Runs as uid 0 inside the container: under rootless podman/k8s this maps to
# the host uid (k8s securityContext pins runAsUser=1000), and on bind mounts
# the SQLite WAL files then land with the host owner instead of root.
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=12s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=10).status==200 else 1)"

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8080"]