# syntax=docker/dockerfile:1
# Python comes from uv's managed builds (pinned by .python-version), so the
# image runs the same interpreter as local development.

FROM ghcr.io/astral-sh/uv:0.13.0 AS uv

FROM debian:trixie-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_INSTALL_DIR=/python \
    UV_PYTHON_PREFERENCE=only-managed
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv python install && uv sync --frozen --no-dev --no-install-project
COPY app ./app
COPY static ./static

FROM debian:trixie-slim
RUN useradd --system --uid 10001 --no-create-home --home-dir /app app \
    && mkdir /data && chown app:app /data
COPY --from=build /python /python
COPY --from=build /app /app
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
