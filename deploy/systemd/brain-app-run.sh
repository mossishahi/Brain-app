#!/usr/bin/env bash
# Brain app systemd wrapper: owns REBUILD + LAUNCH, the same division of
# labor as deploy/slurm-launch.sh. With it, the in-app one-click update works
# under systemd:
#
#   1. the user clicks "Update now" in the webapp;
#   2. the server detects it runs under systemd (INVOCATION_ID) and applies
#      the release CHECKOUT in-process, before exiting — a detached updater
#      would die with the unit's cgroup the moment the server exits;
#   3. the server exits; the unit's Restart=always brings it back THROUGH
#      THIS SCRIPT, which installs and builds the new checkout and launches
#      it — the browser tab reconnects and reloads into the new version.
#
# Building on every service start also self-heals a half-built tree after a
# power cut, at the cost of ~a minute per (rare) restart.
set -euo pipefail

cd "$(dirname "$0")/../.."
echo "[brain-app-run] checkout: $(git describe --tags --always 2>/dev/null || echo unknown)"
echo "[brain-app-run] installing dependencies"
npm ci --no-audit --no-fund
echo "[brain-app-run] building"
npm run build
echo "[brain-app-run] launching"
exec node apps/server/dist/src/main.js launch "$@"
