#!/bin/bash
# The Brainstorm server as a SLURM job on LRZ CoolMUC-4 (Linux Cluster).
#
# Submit FROM A LOGIN NODE (cool.hpc.lrz.de), from the repository root:
#   sbatch deploy/lrz-coolmuc4-launch.sh
# Keep-alive across the 168h walltime: submit it TWICE — the singleton
# dependency queues the second copy until the first ends, so the server
# resumes seamlessly (all jobs and state live in the workspace on $HOME).
#
# Reach the dashboard from your laptop (the URL is printed in the job log):
#   ssh -L 8787:<node printed in the log>:8787 <user>@cool.hpc.lrz.de
#   then open http://localhost:8787
#
# LRZ specifics this wrapper encodes (doku.lrz.de, "Job Processing on the
# Linux-Cluster", March 2026):
# - CoolMUC-4 is MULTI-CLUSTER SLURM: login nodes default to the cm4
#   cluster, so the --clusters/--partition/--qos trio below is mandatory.
#   The server job runs ON the serial cluster; slurm commands executed on
#   its node (the server submits pipeline workers, polls them, cancels
#   them) default to the serial cluster's controller — which is exactly
#   why the WHOLE deployment stays on `serial`, and why the in-app SLURM
#   template (Settings -> Execution) must NOT carry a --clusters line
#   pointing anywhere else.
# - serial_long: 1-16 physical cores, max 168h walltime, shared nodes,
#   --qos=cm4_serial_long mandatory (rejected without it since 2026-07-06),
#   user-wide 100 GB memory cap across running serial_long jobs.
# - Pipeline workers submitted by the server default to partition
#   serial_std (24h, up to 96 cores per user across running jobs) through
#   the in-app template; see the recommended template in the repo README
#   section for LRZ or at the bottom of this file.
# - Outgoing ssh (port 22) is blocked cluster-wide; outbound HTTPS must be
#   verified once per deployment with deploy/lrz-coolmuc4-probe.sh — the
#   model API, the Brain Registry, and web search all need it.
#
# What the wrapper owns (same contract as deploy/slurm-launch.sh):
# - RELEASE CHANNEL: checks out the newest app/v* tag on every (re)start,
#   stashing local modifications recoverably, and builds with `npm ci`.
# - UPDATE HANDOFF: the in-app updater under SLURM only checks out the new
#   release; the loop below rebuilds and relaunches it.
# - GRACEFUL WALLTIME: --signal delivers an early TERM so the server exits
#   cleanly; the queued singleton twin (or the next manual submission)
#   adopts all state from the workspace.
#
#SBATCH --job-name=brain
# Logs land in the repo's logs/ dir (relative to the submit dir); the
# wrapper prunes entries older than 30 days on each start.
#SBATCH --output=logs/slurm_brain_%j.log
#SBATCH --error=logs/slurm_brain_%j.log
#SBATCH --clusters=serial
#SBATCH --partition=serial_long
#SBATCH --qos=cm4_serial_long
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=16G
#SBATCH --time=168:00:00
#SBATCH --get-user-env
#SBATCH --export=NONE
#SBATCH --signal=B:TERM@120
#SBATCH --dependency=singleton
##SBATCH --mail-type=END,FAIL
##SBATCH --mail-user=you@example.org

set -uo pipefail  # deliberately no -e: the relaunch loop must survive failures

# LRZ job-script boilerplate: with --export=NONE this restores the SLURM
# environment inside the job. Guarded: harmless where absent.
type module >/dev/null 2>&1 && module load slurm_setup 2>/dev/null || true

NODE_VERSION="v22.13.0"
NODE_DIR="$HOME/opt/node-$NODE_VERSION-linux-x64"
APP="${BRAIN_APP_DIR:-${SLURM_SUBMIT_DIR:-$PWD}}"
PORT="${BRAIN_PORT:-8787}"
# Extra PATH entries (e.g. a python env backing the code-execution
# capability); colon-separated, optional.
EXTRA_PATH="${BRAIN_EXTRA_PATH:-}"

# Node.js: prefer a pre-installed copy under $HOME/opt (install it once
# from a LOGIN node if compute nodes turn out to have no outbound HTTPS:
#   mkdir -p ~/opt && cd ~/opt \
#     && curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" \
#     && tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz"
# $HOME is the shared DSS filesystem, so compute nodes see it immediately).
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
  echo "[wrapper] job ending; stopping the server"
  [ -n "$SERVER_PID" ] && kill -TERM "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  exit 0
}
trap finish TERM INT

sync_to_latest_release
build_if_needed || { echo "[wrapper] initial build failed"; exit 1; }
NODE_HOST=$(hostname -f)
echo "[wrapper] dashboard on the cluster: http://$NODE_HOST:$PORT"
echo "[wrapper] from your laptop:  ssh -L $PORT:$NODE_HOST:$PORT ${USER}@cool.hpc.lrz.de"
echo "[wrapper] then open:         http://localhost:$PORT"

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

# ---------------------------------------------------------------------------
# Recommended in-app SLURM template for pipeline WORKERS on CoolMUC-4
# (Settings -> Execution -> SLURM template). Workers are API-orchestration
# processes: light CPU, long-ish wall time. serial_std allows 24h and up to
# 96 concurrently running cores per user. No --clusters line: submissions
# happen on a serial-cluster node, which already talks to the serial
# controller — and the readiness panel's SLURM check verifies this whole
# path end to end on first launch.
#
#   #!/usr/bin/env bash
#   #SBATCH --job-name=brain
#   #SBATCH --partition=serial_std
#   #SBATCH --time=24:00:00
#   #SBATCH --cpus-per-task=4
#   #SBATCH --mem=16G
#   #SBATCH --output=logs/slurm-%j.out
#
#   set -euo pipefail
#   {{BRAIN_COMMAND}}
# ---------------------------------------------------------------------------
