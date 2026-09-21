#!/usr/bin/env bash
# Declarative, auditable install script: gVisor runsc on Debian/Ubuntu.
# Invoked only after explicit user approval via the plugin's probe→authorize→fix flow.
set -euo pipefail
. /etc/os-release
ARCH="$(dpkg --print-architecture)"
URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
sudo mkdir -p /etc/apt/sources.list.d /usr/local/bin
curl -fsSL "${URL}/runsc" -o /tmp/runsc && curl -fsSL "${URL}/runsc.sha512" -o /tmp/runsc.sha512
echo "$(cat /tmp/runsc.sha512)  /tmp/runsc" | sha512sum -c -
sudo install -o root -g root -m 0755 /tmp/runsc /usr/local/bin/runsc
rm -f /tmp/runsc /tmp/runsc.sha512
echo "runsc installed: $(/usr/local/bin/runsc --version)"
echo "NOTE: docker runtime registration (runsc runtime) still requires manual dockerd config review."
