# The image GitHub Codespaces runs this repository in. devcontainer.json says how.
#
# Microsoft's Dev Containers image for Node 24 on Debian 12, pinned by digest as the
# actions in .github/workflows are. The digest is the 5.2.6-24-bookworm build: Node
# 24.22.3, published on 2026-11-13, the newest that was two weeks old when this was
# written.
#
# The tag beside it is the floating `24-bookworm`, which that build was until 5.2.7
# replaced it. Docker ignores a tag next to a digest; it is there for Dependabot, which
# follows it. A versioned tag would mislead it: Dependabot reads `5.2.6-24` as one
# version number, and `5.2.7-26`, which is Node 26, as the next one.
#
# A Dockerfile rather than an `image` line in devcontainer.json, so that Dependabot
# sees it at all: its `docker` updater reads Dockerfiles, and its `devcontainers`
# updater only updates Features, of which this configuration has none.
FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm@sha256:3c8ce4987c62687416c86d803e2bef2a193ed25b370ed4378992c3b154dd65d5
