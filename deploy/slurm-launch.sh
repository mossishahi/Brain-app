#!/bin/bash
# The Brainstorm server as a SLURM job — the canonical launch wrapper.
#
# Submit from the repository root: `sbatch deploy/slurm-launch.sh`
# (or export BRAIN_APP_DIR to point elsewhere). Copy the #SBATCH lines you
# need to adjust into your own copy; partition/qos/mail are site-specific.
#
# What this wrapper owns — and why it must, under SLURM:
# - RELEASE CHANNEL: on every (re)start it checks out the newest app/v* tag
#   (the same channel the in-app "Update now" button uses; never `main`),
#   with local modifications stashed recoverably, and builds with `npm ci`
#   (which never rewrites the lockfile — `npm install` does, and a dirtied
#   checkout is what update failures are made of).
# - UPDATE HANDOFF: the in-app updater detects SLURM and only checks out the
#   new release, because a detached relauncher would die with the job's
#   cgroup the moment this script exited. The loop below waits for the
#   updater to finish, rebuilds, and relaunches — the browser tab reloads
#   itself into the new version exactly like on a workstation.
# - GRACEFUL WALLTIME: --signal delivers an early TERM so the server closes
#   cleanly before the hard kill; resubmitting simply adopts all jobs and
#   state from the workspace. --dependency=singleton guarantees two copies
#   never fight over the port.
#
#SBATCH --job-name=brain
# Logs land in the repo's git-kept logs/ dir (relative to the submit dir);
# the wrapper prunes entries older than 30 days on each start.
#SBATCH --output=logs/slurm_brain_%j.log
#SBATCH --error=logs/slurm_brain_%j.log
#SBATCH --partition=cpu_p
#SBATCH --qos=cpu_normal
#SBATCH --mem=16G
#SBATCH --cpus-per-task=8
# Set --time to your QOS ceiling (query it: sacctmgr show qos <qos> format=Name,MaxWall).
# Override per submission without editing: sbatch --time=... deploy/slurm-launch.sh
#SBATCH --time=12:00:00
#SBATCH --signal=B:TERM@120
#SBATCH --dependency=singleton
#SBATCH --nice=10000
##SBATCH --nodelist=cpusrv20        # optional: pin the node so the URL never changes
##SBATCH --mail-type=ALL
##SBATCH --mail-user=you@example.org

set -uo pipefail  # deliberately no -e: the relaunch loop must survive failures

NODE_VERSION="v22.13.0"
NODE_DIR="$HOME/opt/node-$NODE_VERSION-linux-x64"
APP="${BRAIN_APP_DIR:-${SLURM_SUBMIT_DIR:-$PWD}}"
PORT="${BRAIN_PORT:-8787}"
# Extra PATH entries (e.g. the python env backing the code-execution
# capability); colon-separated, optional.
EXTRA_PATH="${BRAIN_EXTRA_PATH:-}"

if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$HOME/opt" && cd "$HOME/opt"
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz"
fi
export PATH="$NODE_DIR/bin${EXTRA_PATH:+:$EXTRA_PATH}:$PATH"
cd "$APP" || { echo "[wrapper] no app at $APP"; exit 1; }
# Keep the log directory bounded; the active job's own log is always newer.
mkdir -p logs && find logs -name 'slurm_brain_*.log' -mtime +30 -delete 2>/dev/null

# Follow the release channel: newest app/v* tag, never a branch. Local
# modifications (a lockfile rewritten by an old `npm install`, a stray edit)
# are stashed recoverably first — the same policy as the in-app updater.
sync_to_latest_release() {
  git fetch --tags --quiet \
    || { echo "[wrapper] tag fetch failed; staying on $(git rev-parse --short HEAD)"; return 0; }
  local latest
  latest=$(git tag -l 'app/v*' --sort=version:refname | tail -1)
  [ -n "$latest" ] || return 0
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "$latest^{commit}")" ] && return 0
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "[wrapper] stashing local modifications (git stash list to inspect)"
    git -c user.name=brainstorm -c user.email=brainstorm@local \
      stash push --quiet -m "slurm-launch $(date -u +%FT%TZ)"
  fi
  git checkout --quiet "$latest" && echo "[wrapper] checked out $latest"
}

# Build only when the checkout moved. `npm ci` keeps the tree clean forever.
build_if_needed() {
  local rev
  rev=$(git rev-parse HEAD)
  if [ ! -d node_modules ] || [ "$(cat .build-stamp 2>/dev/null)" != "$rev" ]; then
    echo "[wrapper] building $(git describe --tags --always)"
    npm ci --no-audit --no-fund && npm run build && echo "$rev" > .build-stamp
    return $?
  fi
  return 0
}

SERVER_PID=""
finish() {
  echo "[wrapper] job ending; stopping the server"
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  exit 0
}
trap finish TERM INT

sync_to_latest_release
build_if_needed || { echo "[wrapper] initial build failed"; exit 1; }
echo "[wrapper] dashboard: http://$(hostname -f):$PORT"

while true; do
  node apps/server/dist/src/main.js launch --ip 0.0.0.0 --port "$PORT" --no-open &
  SERVER_PID=$!
  wait "$SERVER_PID"
  code=$?
  SERVER_PID=""
  echo "[wrapper] server exited (code $code)"
  # An in-app update may be mid-flight: it stashes + checks out the new
  # release, then exits and leaves rebuild + relaunch to this loop.
  while pgrep -f "self-update/update-.*\.sh" >/dev/null 2>&1; do sleep 5; done
  if ! build_if_needed; then
    previous=$(cat .build-stamp 2>/dev/null)
    echo "[wrapper] rebuild failed; restoring last built revision ${previous:-<none>}"
    [ -n "$previous" ] && git checkout --quiet "$previous" && build_if_needed
  fi
  sleep 5
done
