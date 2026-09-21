# Sandbox image for cloudflare/security-audit-skill target execution.
# The audit workflow runs UNTRUSTED target code (builds, tests, fuzzers) inside
# this image; run it only through run-audit-sandbox.sh, which applies the
# network, filesystem, and resource restrictions the skill requires.
FROM node:22-bookworm-slim

# Minimal toolchain for audits: shell, build tools, git, python for target
# projects; nothing that requires outbound access at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential python3 python3-pip ripgrep jq \
  && rm -rf /var/lib/apt/lists/*

# Run as the non-root sandbox user; /work is the only writable path.
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /work
