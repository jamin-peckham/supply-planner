#!/usr/bin/env bash
# Build the image for linux/amd64 and push :<version> and :latest to Docker Hub.
# Usage: scripts/docker-publish.sh   (requires `docker login` first)
set -euo pipefail

REPO="${REPO:-ouoertheo/supply-planner}"
cd "$(dirname "$0")/.."
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml | head -1)"

docker build --platform linux/amd64 -t "$REPO:$VERSION" -t "$REPO:latest" .
docker push "$REPO:$VERSION"
docker push "$REPO:latest"
echo "Pushed $REPO:$VERSION and $REPO:latest"
