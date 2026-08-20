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
#   cleanly before the hard kill, and the job SUBMITS ITS OWN SUCCESSOR well
#   before that (see deploy/slurm-renew.sh) so the deployment survives its
#   walltime unattended — a run's host job is protected by the server, and this
#   is what protects the server. --dependency=singleton guarantees two copies
#   never fight over the port: the successor waits in PD until this one is gone.
#   An operator's scancel is told apart from the walltime and takes the queued
#   successor with it, so stopping the deployment still stops it.
# - SELF-UPDATING: the loop below restarts the SERVER when a release lands, but a
#   running bash keeps the code it was started with, so a change to THIS script
#   would otherwise only take effect one job later — and the first job after such
#   a change is the one that runs without it. Observed exactly that: a 12-hour job
#   started before the walltime handover existed rebuilt the server five times as
#   releases landed, ran the new server all day, and still died at its walltime
#   with no successor. So when its own sources change on disk, the wrapper execs
#   the new copy IN PLACE — same job, same allocation, watchdog re-armed.
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
# Holds a hand-submitted `brain` behind another one. Each successor is named for
# its generation instead (brain-2, brain-3, ...) so handovers are countable in
# the queue, and carries --dependency=afterany:<predecessor> — which is the same
# guarantee by job id rather than by name. The wrapper also refuses to serve when
# another generation is already running.
#SBATCH --dependency=singleton
#SBATCH --nice=10000
##SBATCH --nodelist=cpusrv20        # optional: pin the node so the URL never changes
##SBATCH --mail-type=ALL
##SBATCH --mail-user=you@example.org

set -uo pipefail  # deliberately no -e: the relaunch loop must survive failures

NODE_VERSION="v24.19.0"
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

# shellcheck source=deploy/slurm-renew.sh
. "$(dirname "$0")/slurm-renew.sh" 2>/dev/null || . "$APP/deploy/slurm-renew.sh"

# How long before the walltime the successor is queued. Generous on purpose: the
# successor only has to be PENDING by the handover, and queue latency on a busy
# partition is minutes, not seconds.
RENEW_LEAD_S="${BRAIN_RENEW_LEAD_S:-1800}"
JOB_END_EPOCH="$(brain_job_end_epoch || true)"
SUCCESSOR_ID=""
# Survives a re-exec, so a successor queued before an update is still known to
# the trap afterwards (and is never queued twice).
SUCCESSOR_FILE="${BRAIN_SUCCESSOR_FILE:-$(mktemp -t brain-successor.XXXXXX)}"
export BRAIN_SUCCESSOR_FILE="$SUCCESSOR_FILE"
# What this script IS, as of now. Compared after every rebuild; see the loop.
WRAPPER_SOURCES=("$APP/deploy/slurm-launch.sh" "$APP/deploy/slurm-renew.sh")
WRAPPER_FINGERPRINT="$(brain_wrapper_fingerprint "${WRAPPER_SOURCES[@]}")"

# One server per port, still. Generations carry different names, so
# --dependency=singleton no longer answers this question and the check is
# explicit: another generation already serving means this job has nothing to do
# except get out of the way — quietly, because a duplicate that keeps trying is
# worse than one that says which job holds the port.
OTHER_SERVER="$(brain_other_server_running brain || true)"
if [ -n "$OTHER_SERVER" ]; then
  echo "[wrapper] another server is already running (job $OTHER_SERVER); exiting"
  exit 0
fi

# Queues the successor once, at the lead point, from a background subshell: the
# wrapper itself must stay in `wait` on the server. One scontrol call has already
# told us when this job ends, so this costs the scheduler nothing further.
renew_watchdog() {
  [ -n "$JOB_END_EPOCH" ] || {
    echo "[renew] no SLURM end time visible; this job will not renew itself" >&2
    return 0
  }
  local wait_s=$(( JOB_END_EPOCH - RENEW_LEAD_S - $(date +%s) ))
  if [ "$wait_s" -le 0 ]; then
    # A job shorter than the lead is a probe or a hand-limited run, not a
    # deployment: renewing it immediately would chain short jobs forever.
    echo "[renew] this job ends within the ${RENEW_LEAD_S}s lead; not renewing" >&2
    return 0
  fi
  if [ -s "$SUCCESSOR_FILE" ]; then
    echo "[renew] a successor was already queued before this restart ($(cat "$SUCCESSOR_FILE"))" >&2
    return 0
  fi
  echo "[renew] will queue the successor in ${wait_s}s (job ends $(date -d "@$JOB_END_EPOCH" 2>/dev/null || echo "@$JOB_END_EPOCH"))"
  sleep "$wait_s"
  # The REPO's copy, never "$0": under SLURM the batch script runs from a
  # per-job spool copy that disappears with the job.
  brain_submit_successor "$APP/deploy/slurm-launch.sh" brain "${SLURM_JOB_ID:-}" > "$SUCCESSOR_FILE"
}
renew_watchdog &
RENEW_PID=$!

SERVER_PID=""
finish() {
  # SLURM sends TERM for the walltime AND for scancel. Only the walltime hands
  # over; a cancelled deployment must not be replaced by its own successor.
  [ -f "$SUCCESSOR_FILE" ] && SUCCESSOR_ID="$(cat "$SUCCESSOR_FILE" 2>/dev/null)"
  if brain_term_is_walltime "$JOB_END_EPOCH"; then
    echo "[wrapper] walltime reached; stopping the server${SUCCESSOR_ID:+ (successor $SUCCESSOR_ID takes over)}"
  else
    echo "[wrapper] cancelled; stopping the server"
    if [ -n "$SUCCESSOR_ID" ]; then
      echo "[wrapper] cancelling the queued successor $SUCCESSOR_ID"
      scancel "$SUCCESSOR_ID" 2>/dev/null || true
    fi
  fi
  kill "$RENEW_PID" 2>/dev/null || true
  rm -f "$SUCCESSOR_FILE" 2>/dev/null || true
  unset BRAIN_SUCCESSOR_FILE
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
  # The release may have changed THIS script. A running bash cannot adopt that by
  # itself, so hand the job over to the new copy: exec replaces the process image
  # inside the same allocation, which re-arms the walltime watchdog from the new
  # code instead of leaving it a job behind. The successor already queued (if any)
  # travels in the environment; the watchdog is stopped first so only one runs.
  current_fingerprint="$(brain_wrapper_fingerprint "${WRAPPER_SOURCES[@]}")"
  if [ "$current_fingerprint" != "$WRAPPER_FINGERPRINT" ]; then
    if [ -x "$APP/deploy/slurm-launch.sh" ]; then
      echo "[wrapper] the launcher's own script changed; re-executing it in this job"
      kill "$RENEW_PID" 2>/dev/null || true
      trap - TERM INT
      exec "$APP/deploy/slurm-launch.sh"
    fi
    echo "[wrapper] the launcher changed but $APP/deploy/slurm-launch.sh is not executable; staying on the running copy"
    WRAPPER_FINGERPRINT="$current_fingerprint"
  fi
  sleep 5
done
