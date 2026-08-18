#!/bin/bash
# LRZ CoolMUC-4 runway: pre-queue the server SHIFTS and the held worker
# PILOTS that let the Brainstorm server run as a SLURM job and still
# "submit" jobs — with zero sbatch and zero ssh at runtime.
#
# WHY (probed on the real system, jobs 5397996 + 5398779):
#   - sbatch is DENIED from compute nodes, but scontrol release, scancel,
#     squeue and sacct all WORK there. So everything that needs sbatch
#     happens HERE, on a login node, ahead of time:
#       * N server shifts  — chained back-to-back with --dependency=singleton
#       * M held pilots    — generic 24h worker jobs queued with --hold
#   - The running server claims a pilot (atomic marker rename), writes its
#     assignment into the pool's spool/, and `scontrol release`s it.
#
# RUN (on a login node, from the app repository root):
#   deploy/lrz-queue-runway.sh                # top up to 2 shifts / 6 pilots
#   deploy/lrz-queue-runway.sh --shifts 4 --pilots 10
#
# Idempotent: counts what is already queued and only tops up the difference.
# Re-run it whenever the dashboard warns the runway is low (default runway:
# 2 shifts x 24h = 2 days). It also syncs the checkout to the newest app/v*
# release tag and builds it, so new shifts always run the latest release —
# shifts themselves never rebuild (in-app self-update is disabled there).
#
# DASHBOARD: each shift writes its node to .server.host and prints the exact
# tunnel command into its log (logs/shift-<jobid>.out):
#   ssh -J $USER@cool.hpc.lrz.de -L 8787:localhost:8787 $USER@$(cat .server.host)
#
# STOP EVERYTHING:
#   scancel -M serial -n brain -u $USER      # the shift chain
#   scancel -M serial -n brnpilot -u $USER   # the held pilots

set -uo pipefail

SHIFTS_TARGET=2
PILOTS_TARGET=6
while [ $# -gt 0 ]; do
  case "$1" in
    --shifts) SHIFTS_TARGET="$2"; shift 2 ;;
    --pilots) PILOTS_TARGET="$2"; shift 2 ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
done

NODE_VERSION="v24.19.0"
NODE_DIR="$HOME/opt/node-$NODE_VERSION-linux-x64"
APP="${BRAIN_APP_DIR:-$PWD}"
PORT="${BRAIN_PORT:-8787}"
POOL="${BRAIN_PILOT_POOL:-$HOME/.brainstorm-agentic/pilot-pool}"

cd "$APP" || { echo "[runway] no app at $APP"; exit 1; }
# Fail fast with one clear line when $APP is not the app checkout (the
# classic miss: running the script from $HOME, where it was scp'd to).
if [ ! -f package.json ] || [ ! -d apps/server ] \
  || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[runway] $APP is not the brainstorm app checkout (needs package.json, apps/server/, and .git)."
  echo "[runway] cd into the app repository root first, or set BRAIN_APP_DIR:"
  echo "[runway]   BRAIN_APP_DIR=/path/to/app bash $0"
  exit 1
fi
mkdir -p "$POOL/available" "$POOL/claimed" "$POOL/spool" logs

if [ ! -x "$NODE_DIR/bin/node" ]; then
  mkdir -p "$HOME/opt" && (cd "$HOME/opt" \
    && curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" \
    && tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz")
fi
export PATH="$NODE_DIR/bin:$PATH"

# --- release sync + build (same policy as the login wrapper) --------------
git fetch --tags --quiet \
  || echo "[runway] tag fetch failed; staying on $(git rev-parse --short HEAD)"
LATEST=$(git tag -l 'app/v*' --sort=version:refname | tail -1)
if [ -n "$LATEST" ] && [ "$(git rev-parse HEAD)" != "$(git rev-parse "$LATEST^{commit}")" ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "[runway] stashing local modifications (git stash list to inspect)"
    git -c user.name=brainstorm -c user.email=brainstorm@local \
      stash push --quiet -m "runway $(date -u +%FT%TZ)"
  fi
  git checkout --quiet "$LATEST" && echo "[runway] checked out $LATEST"
fi
REV=$(git rev-parse HEAD)
if [ ! -d node_modules ] || [ "$(cat .build-stamp 2>/dev/null)" != "$REV" ]; then
  echo "[runway] building $(git describe --tags --always)"
  npm ci --no-audit --no-fund && npm run build && echo "$REV" > .build-stamp \
    || { echo "[runway] build failed"; exit 1; }
fi

# --- the SHIFT job: one <24h server term in the singleton chain -----------
SHIFT_SCRIPT="$POOL/shift.sh"
cat > "$SHIFT_SCRIPT" <<EOF
#!/bin/bash
#SBATCH --job-name=brain
#SBATCH --clusters=serial
#SBATCH --partition=serial_std
#SBATCH --time=23:50:00
#SBATCH --cpus-per-task=2
#SBATCH --mem=8G
#SBATCH --dependency=singleton
#SBATCH --signal=B:TERM@900
#SBATCH --get-user-env
#SBATCH --export=NONE
#SBATCH --output=$APP/logs/shift-%j.out
module load slurm_setup 2>/dev/null || true
export PATH="$NODE_DIR/bin:\$PATH"
cd "$APP" || exit 1

# Crash-loop guard: singleton releases the next shift the moment this one
# dies, so a broken deploy could burn the whole chain in minutes (and spray
# sub-2-minute jobs, which LRZ treats as misuse). Three rapid starts pause
# this shift instead of churning submissions.
STARTS="$POOL/shift-starts"
NOW=\$(date +%s)
echo "\$NOW" >> "\$STARTS"
RECENT=\$(awk -v now="\$NOW" 'now - \$1 < 900' "\$STARTS" 2>/dev/null | wc -l)
if [ "\$RECENT" -ge 3 ]; then
  echo "[shift] \$RECENT starts within 15 min — pausing this shift for 1h instead of churning the chain"
  sleep 3600
  exit 1
fi

NODE_HOST=\$(hostname -f)
echo "\$NODE_HOST" > "$APP/.server.host"
echo "[shift] server on compute node \$NODE_HOST (job \$SLURM_JOB_ID)"
echo "[shift] from your laptop (two-stage: the login sshd refuses forwarded"
echo "[shift] jump channels to compute nodes, and compute sshd accepts only"
echo "[shift] the cluster-internal key in ~/.ssh/internal):"
echo "[shift]   ssh -t -L $PORT:localhost:1$PORT \$USER@cool.hpc.lrz.de \\\\"
echo "[shift]     'ssh -L 1$PORT:localhost:$PORT \$(cat Brain-app/.server.host)'"
echo "[shift] then open http://localhost:$PORT"

# exec so the walltime TERM (B:TERM@900) reaches the server itself: it
# checkpoints, closes, and the next queued shift adopts every job from the
# shared workspace. Self-update is off — releases apply via this script.
exec node apps/server/dist/src/main.js launch \\
  --ip 127.0.0.1 --port "$PORT" --no-open --no-self-update \\
  --slurm-pilot-pool "$POOL"
EOF
chmod +x "$SHIFT_SCRIPT"

# --- the PILOT job: a held, generic 24h worker ----------------------------
PILOT_SCRIPT="$POOL/pilot.sh"
cat > "$PILOT_SCRIPT" <<EOF
#!/bin/bash
#SBATCH --job-name=brnpilot
#SBATCH --clusters=serial
#SBATCH --partition=serial_std
#SBATCH --time=24:00:00
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --get-user-env
#SBATCH --export=NONE
#SBATCH --output=$APP/logs/pilot-%j.out
module load slurm_setup 2>/dev/null || true
export PATH="$NODE_DIR/bin:\$PATH"

# The server wrote our assignment BEFORE releasing us; the bounded wait only
# covers shared-filesystem visibility lag.
ASSIGNMENT="$POOL/spool/\$SLURM_JOB_ID.sh"
for _ in \$(seq 1 30); do
  [ -f "\$ASSIGNMENT" ] && break
  sleep 2
done
if [ ! -f "\$ASSIGNMENT" ]; then
  echo "[pilot] no assignment at \$ASSIGNMENT — released without a claim?"
  exit 1
fi
exec bash "\$ASSIGNMENT"
EOF
chmod +x "$PILOT_SCRIPT"

# --- top up the shift chain ------------------------------------------------
QUEUED_SHIFTS=$(squeue -M serial -h -u "$USER" -n brain -o "%i" 2>/dev/null | grep -c '^[0-9]' || true)
echo "[runway] shifts queued/running: $QUEUED_SHIFTS (target $SHIFTS_TARGET)"
i=$QUEUED_SHIFTS
while [ "$i" -lt "$SHIFTS_TARGET" ]; do
  OUT=$(sbatch "$SHIFT_SCRIPT" 2>&1) || { echo "[runway] shift sbatch failed: $OUT"; exit 1; }
  echo "[runway] queued shift: $OUT"
  i=$((i + 1))
done

# --- prune stale pilot markers, then top up the pool ----------------------
MARKERS=$(ls "$POOL/available" 2>/dev/null | grep -E '^[0-9]+$' || true)
LIVE_PILOTS=0
if [ -n "$MARKERS" ]; then
  IDS=$(echo "$MARKERS" | paste -sd, -)
  ALIVE=$(squeue -M serial -h -j "$IDS" -o "%i %T" 2>/dev/null || true)
  for id in $MARKERS; do
    STATE=$(echo "$ALIVE" | awk -v id="$id" '$1 == id { print $2 }')
    if [ "$STATE" = "PENDING" ]; then
      LIVE_PILOTS=$((LIVE_PILOTS + 1))
    else
      echo "[runway] pruning stale pilot marker $id (state: ${STATE:-gone})"
      rm -f "$POOL/available/$id"
    fi
  done
fi
echo "[runway] held pilots available: $LIVE_PILOTS (target $PILOTS_TARGET)"
i=$LIVE_PILOTS
while [ "$i" -lt "$PILOTS_TARGET" ]; do
  OUT=$(sbatch --hold "$PILOT_SCRIPT" 2>&1) || { echo "[runway] pilot sbatch failed: $OUT"; exit 1; }
  ID=$(echo "$OUT" | grep -oE 'Submitted batch job [0-9]+' | grep -oE '[0-9]+')
  CLUSTER=$(echo "$OUT" | grep -oE 'on cluster \S+' | awk '{print $3}')
  [ -n "$ID" ] || { echo "[runway] could not parse pilot id from: $OUT"; exit 1; }
  printf '%s' "${CLUSTER:-}" > "$POOL/available/$ID"
  echo "[runway] queued held pilot $ID${CLUSTER:+ on cluster $CLUSTER}"
  i=$((i + 1))
done

echo "[runway] done — runway: $SHIFTS_TARGET shift(s) x 24h, $PILOTS_TARGET pilot(s)."
echo "[runway] watch the newest shift log for the tunnel command: ls -t logs/shift-*.out | head -1"
