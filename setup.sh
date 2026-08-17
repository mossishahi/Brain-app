#!/usr/bin/env bash
# One-command setup after cloning: get Node, build, launch.
#
#   git clone https://github.com/mossishahi/Brain-app.git
#   cd Brain-app && ./setup.sh
#
# The user never installs Node themselves. The script owns three things:
#
# - NODE: any Node >= 22.13 already on PATH is used as-is. Otherwise the
#   pinned Node v22.13.0 for this OS and CPU is downloaded into ~/opt and
#   used from there — no root, no package manager, and nothing outside
#   ~/opt is touched (the same convention deploy/slurm-launch.sh uses on
#   clusters, so one machine never ends up with two conventions).
# - BUILD: `npm ci` + `npm run build`, skipped when this checkout is
#   already built (the same .build-stamp the SLURM wrapper reads, so the
#   two never rebuild behind each other's back).
# - LAUNCH: every argument is handed to the server, so
#   `./setup.sh --port 9000 --no-open` works exactly like
#   `npm run launch -- --port 9000 --no-open`. `--build-only` stops
#   before launching (for provisioning a machine ahead of first use).
#
# Linux and macOS, x64 and arm64. On Windows, run it inside WSL.

set -euo pipefail

# The same version the SLURM wrapper pins; the repo's enforced floor is 22.13.
NODE_VERSION="v22.13.0"

cd "$(dirname "$0")"

BUILD_ONLY=0
LAUNCH_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--build-only" ]; then
    BUILD_ONLY=1
  else
    LAUNCH_ARGS+=("$arg")
  fi
done

# True when the Node already on PATH satisfies the repo's floor (22.13).
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [M, m] = process.versions.node.split(".").map(Number); process.exit(M > 22 || (M === 22 && m >= 13) ? 0 : 1)' 2>/dev/null
}

if node_ok; then
  echo "[setup] using the Node already installed: $(node --version)"
else
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *)
      echo "[setup] unsupported OS '$(uname -s)' — install Node >= 22.13 yourself, then rerun" >&2
      exit 1
      ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *)
      echo "[setup] unsupported CPU '$(uname -m)' — install Node >= 22.13 yourself, then rerun" >&2
      exit 1
      ;;
  esac
  NODE_DIR="$HOME/opt/node-$NODE_VERSION-$os-$arch"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    command -v curl >/dev/null 2>&1 || { echo "[setup] curl is required to download Node" >&2; exit 1; }
    tarball="node-$NODE_VERSION-$os-$arch.tar.gz"
    echo "[setup] downloading Node $NODE_VERSION ($os-$arch) into $HOME/opt"
    mkdir -p "$HOME/opt"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$tarball" -o "$HOME/opt/$tarball"
    tar -xzf "$HOME/opt/$tarball" -C "$HOME/opt"
    rm -f "$HOME/opt/$tarball"
  fi
  export PATH="$NODE_DIR/bin:$PATH"
  echo "[setup] using Node $(node --version) from $NODE_DIR"
fi

# Build only when this checkout has not been built yet (or moved since).
# `npm ci` never rewrites the lockfile, so the checkout stays clean and the
# in-app self-updater keeps working. A non-git copy (a downloaded archive)
# builds once and then always reads as up to date.
rev=$(git rev-parse HEAD 2>/dev/null || echo "no-git")
if [ ! -d node_modules ] || [ "$(cat .build-stamp 2>/dev/null)" != "$rev" ]; then
  echo "[setup] installing dependencies and building $(git describe --tags --always 2>/dev/null || echo "$rev")"
  npm ci --no-audit --no-fund
  npm run build
  echo "$rev" > .build-stamp
else
  echo "[setup] already built; skipping install and build"
fi

if [ "$BUILD_ONLY" = "1" ]; then
  echo "[setup] build complete. Launch later with: ./setup.sh"
  exit 0
fi

exec node apps/server/dist/src/main.js launch ${LAUNCH_ARGS[@]+"${LAUNCH_ARGS[@]}"}
