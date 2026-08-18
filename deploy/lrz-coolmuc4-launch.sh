#!/bin/bash
# The Brainstorm server on LRZ CoolMUC-4 — LOGIN-NODE launch wrapper.
#
# WHY the login node (probed on the real system, 2026-08-10, job 5397996):
# CoolMUC-4 DENIES `sbatch` from compute nodes ("Batch job submission
# failed: Access/permission denied"), so a server running as a SLURM job
# could never launch its pipeline workers. The server therefore runs on a
# login node — the same place workflow orchestrators (Nextflow, Snakemake)
# conventionally live — and submits workers to the serial cluster from
# there. The server itself is a lightweight HTTP + orchestration process;
# all heavy work happens inside SLURM worker jobs. Outbound HTTPS works
# from both login and compute nodes (no proxy), verified by the probe.
#
# START (from the repository root, ON a login node — note which one, the
# load balancer cool.hpc.lrz.de has two):
#   mkdir -p logs
#   nohup deploy/lrz-coolmuc4-launch.sh >> logs/server.log 2>&1 &
#   tail -f logs/server.log        # prints the exact tunnel command
#
# REACH THE DASHBOARD from your laptop (server binds 127.0.0.1 — private,
# tunnel-only, because login nodes are shared):
#   ssh -L 8787:localhost:8787 <user>@<the login node from the log>
#   # if that node is not directly reachable, jump through the balancer:
#   ssh -J <user>@cool.hpc.lrz.de -L 8787:localhost:8787 <user>@<node>
#   then open http://localhost:8787
#
# STOP:  kill "$(cat .server.pid)"   (state lives in the workspace; a
# relaunch adopts every job. A login-node reboot behaves the same way —
# just start the wrapper again.)
#
# What the wrapper owns (same contract as deploy/slurm-launch.sh):
# - RELEASE CHANNEL: checks out the newest app/v* tag on every (re)start,
#   stashing local modifications recoverably, and builds with `npm ci`.
# - UPDATE HANDOFF: after the in-app updater checks out a new release, the
#   loop below rebuilds and relaunches it.
# - SINGLE INSTANCE: a lock file guarantees two copies never fight over
#   the port (the SLURM wrapper used --dependency=singleton for this).

set -uo pipefail  # deliberately no -e: the relaunch loop must survive failures

NODE_VERSION="v24.19.0"
NODE_DIR="$HOME/opt/node-$NODE_VERSION-linux-x64"
APP="${BRAIN_APP_DIR:-$PWD}"
PORT="${BRAIN_PORT:-8787}"
BIND_IP="${BRAIN_BIND_IP:-127.0.0.1}"
# Extra PATH entries (e.g. a python env backing the code-execution
# capability); colon-separated, optional.
EXTRA_PATH="${BRAIN_EXTRA_PATH:-}"

if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$HOME/opt" && cd "$HOME/opt"
  curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz"
fi
export PATH="$NODE_DIR/bin${EXTRA_PATH:+:$EXTRA_PATH}:$PATH"
cd "$APP" || { echo "[wrapper] no app at $APP"; exit 1; }

# One server per checkout: the lock outlives every relaunch iteration.
exec 9>".server.lock"
if ! flock -n 9; then
  echo "[wrapper] another instance already runs from $APP (see .server.pid)"
  exit 1
fi
echo $$ > .server.pid

# Keep the log directory bounded; the active log is always newer.
mkdir -p logs && find logs -name 'slurm_brain_*.log' -mtime +30 -delete 2>/dev/null

# Follow the release channel: newest app/v* tag, never a branch. Local
# modifications are stashed recoverably first — same policy as the in-app
# updater.
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
      stash push --quiet -m "lrz-launch $(date -u +%FT%TZ)"
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
  echo "[wrapper] stopping the server"
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  rm -f .server.pid
  exit 0
}
trap finish TERM INT

sync_to_latest_release
build_if_needed || { echo "[wrapper] initial build failed"; exit 1; }
NODE_HOST=$(hostname -f)
echo "[wrapper] server on login node: $NODE_HOST (bind $BIND_IP:$PORT)"
echo "[wrapper] from your laptop:  ssh -L $PORT:localhost:$PORT ${USER}@$NODE_HOST"
echo "[wrapper]         fallback:  ssh -J ${USER}@cool.hpc.lrz.de -L $PORT:localhost:$PORT ${USER}@$NODE_HOST"
echo "[wrapper] then open:         http://localhost:$PORT"

while true; do
  node apps/server/dist/src/main.js launch --ip "$BIND_IP" --port "$PORT" --no-open &
  SERVER_PID=$!
  wait "$SERVER_PID"
  code=$?
  SERVER_PID=""
  echo "[wrapper] server exited (code $code)"
  # An in-app update may be mid-flight: it stashes + checks out the new
  # release, then exits and leaves rebuild + relaunch to this loop.
  while pgrep -u "$USER" -f "self-update/update-.*\.sh" >/dev/null 2>&1; do sleep 5; done
  if ! build_if_needed; then
    previous=$(cat .build-stamp 2>/dev/null)
    echo "[wrapper] rebuild failed; restoring last built revision ${previous:-<none>}"
    [ -n "$previous" ] && git checkout --quiet "$previous" && build_if_needed
  fi
  sleep 5
done

# ---------------------------------------------------------------------------
# REQUIRED in-app SLURM template for pipeline WORKERS on CoolMUC-4
# (Settings -> Execution -> SLURM template). Login nodes default to the cm4
# cluster, so the --clusters line is what routes workers to the serial
# cluster; sbatch reports the landing cluster and the app tracks it for all
# later polling. Workers are API-orchestration processes: light CPU, and
# serial_std allows up to 24h per job.
#
#   #!/usr/bin/env bash
#   #SBATCH --job-name=brain
#   #SBATCH --clusters=serial
#   #SBATCH --partition=serial_std
#   #SBATCH --time=24:00:00
#   #SBATCH --cpus-per-task=4
#   #SBATCH --mem=16G
#   #SBATCH --output=logs/slurm-%j.out
#
#   set -euo pipefail
#   {{BRAIN_COMMAND}}
# ---------------------------------------------------------------------------
