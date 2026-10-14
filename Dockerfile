# syntax=docker/dockerfile:1
# Python comes from uv's managed builds (pinned by .python-version), so the
# image runs the same interpreter as local development.

FROM ghcr.io/astral-sh/uv:0.13.0 AS uv

# The dependency manifests with our own version number blanked out, so a release
# bump doesn't invalidate the dependency layers below (the project itself isn't
# installed into the venv, so its version doesn't matter there).
FROM debian:trixie-slim AS manifest
WORKDIR /m
COPY pyproject.toml uv.lock .python-version ./
RUN sed -i 's/^version = .*/version = "0"/' pyproject.toml \
    && sed -i '/^name = "supply-planner"$/{n;s/^version = .*/version = "0"/}' uv.lock

FROM debian:trixie-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_INSTALL_DIR=/python \
    UV_PYTHON_PREFERENCE=only-managed
WORKDIR /app
COPY --from=manifest /m/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv python install && uv sync --frozen --no-dev --no-install-project

FROM debian:trixie-slim
RUN useradd --system --uid 10001 --no-create-home --home-dir /app app \
    && mkdir /data && chown app:app /data
# Interpreter and dependencies first: these layers only change with uv.lock, so
# a code-only release builds and pushes just the small layers after them.
COPY --from=build /python /python
COPY --from=build /app/.venv /app/.venv
COPY app /app/app
COPY static /app/static
ENV PATH=/app/.venv/bin:$PATH \
    DATA_DIR=/data \
    PYTHONUNBUFFERED=1
WORKDIR /app
USER app
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/revision', timeout=3)"]
# Single worker on purpose: storage relies on one in-process lock and cache.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
