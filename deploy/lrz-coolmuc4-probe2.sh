#!/bin/bash
# Decision probe #2 for LRZ CoolMUC-4: "server as a SLURM job that submits jobs".
#
# Probe #1 proved only that `sbatch` is DENIED from serial compute nodes.
# This probe settles every remaining fact the design hangs on:
#
#   A. Which scheduler verbs DO work from a serial compute node:
#      squeue / sacct / scontrol show / scontrol release / scancel / srun step.
#      -> If `scontrol release` + `scancel` work, the held-pilot design needs
#         NO ssh and NO sbatch at runtime: the server releases pre-queued
#         held worker jobs and cancels them directly.
#   B. Whether non-interactive ssh from a compute node back to the login
#      node works (hostbased/GSSAPI), i.e. whether an ssh submission channel
#      is even possible without a (policy-forbidden) passphrase-less key.
#   C. Whether `scrontab` exists (login AND compute side) — if slurmctld
#      hosts cron, chain top-up needs neither ssh nor a login-node daemon.
#   D. Live partition limits (`sinfo`) — the doc pages contradict each other
#      on serial walltimes (24h/168h vs 8h/60h) — and whether serial_long
#      accepts/requires --qos=cm4_serial_long (checked via --test-only,
#      nothing is actually queued for that check).
#
# HOW TO RUN (on a login node, from any shared-FS directory):
#   bash deploy/lrz-coolmuc4-probe2.sh
# Wait for it to finish (~5-15 min, bounded), then send back the whole
# results directory it names (login.log + compute-<jobid>.log).
#
# Cost: one 1-core/15-min probe job + two held 1-core/5-min targets (one is
# released and runs `true`, one is cancelled). Everything is cleaned up.

set -uo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
DIR="$PWD/brain-probe2-$STAMP"
mkdir -p "$DIR"
LOGIN_LOG="$DIR/login.log"

say() { echo "PROBE $*" | tee -a "$LOGIN_LOG"; }
line() { echo "$*" | tee -a "$LOGIN_LOG"; }

line "== brain probe 2: login-side checks =="
say "login node: $(hostname -f)  at $(date -u +%FT%TZ)"
say "results dir: $DIR"

# --- C. scrontab on the login node --------------------------------------
if command -v scrontab >/dev/null 2>&1; then
  OUT=$(scrontab -l 2>&1); RC=$?
  say "scrontab (login): PRESENT, 'scrontab -l' exit $RC: $(echo "$OUT" | head -2 | tr '\n' ' / ')"
else
  say "scrontab (login): command NOT installed"
fi

# --- D. live partition limits -------------------------------------------
say "sinfo serial: $(sinfo --clusters=serial -h -o '%P time=%l cores=%c mem=%m' 2>&1 | tr '\n' ' | ')"
say "sinfo inter : $(sinfo --clusters=inter  -h -o '%P time=%l' 2>&1 | tr '\n' ' | ')"
say "sinfo cm4   : $(sinfo --clusters=cm4    -h -o '%P time=%l' 2>&1 | tr '\n' ' | ')"

# --- D. serial_long QOS acceptance (--test-only: validates, queues nothing)
NOOP="$DIR/noop.sh"
printf '#!/bin/bash\ntrue\n' > "$NOOP"
OUT=$(sbatch --test-only --clusters=serial --partition=serial_long --qos=cm4_serial_long \
      --time=48:00:00 --job-name=brnqost "$NOOP" 2>&1)
say "serial_long WITH  --qos=cm4_serial_long (test-only): $(echo "$OUT" | head -2 | tr '\n' ' / ')"
OUT=$(sbatch --test-only --clusters=serial --partition=serial_long \
      --time=48:00:00 --job-name=brnqost "$NOOP" 2>&1)
say "serial_long WITHOUT qos (test-only): $(echo "$OUT" | head -2 | tr '\n' ' / ')"

# --- held targets the compute probe acts on ------------------------------
TGT="$DIR/target.sh"
cat > "$TGT" <<EOF
#!/bin/bash
#SBATCH --get-user-env
#SBATCH --export=NONE
echo ok > "$DIR/released-target-ran.ok"
EOF

submit_held() { # job-name -> job id on stdout, empty on failure
  local out
  out=$(sbatch --hold --clusters=serial --partition=serial_std --ntasks=1 \
        --time=00:05:00 --job-name="$1" --output=/dev/null "$TGT" 2>&1)
  echo "$out" >> "$LOGIN_LOG"
  echo "$out" | grep -oE 'Submitted batch job [0-9]+' | grep -oE '[0-9]+' || true
}

A_ID=$(submit_held brnptgta)   # to be RELEASED from the compute node
B_ID=$(submit_held brnptgtb)   # to be CANCELLED from the compute node
if [ -z "$A_ID" ] || [ -z "$B_ID" ]; then
  say "FATAL: could not queue the held targets (see $LOGIN_LOG); aborting"
  exit 1
fi
say "held targets queued: A=$A_ID (release test), B=$B_ID (cancel test)"

# --- the compute-side probe job ------------------------------------------
PROBE="$DIR/compute-probe.sh"
cat > "$PROBE" <<'EOF'
#!/bin/bash
#SBATCH --get-user-env
#SBATCH --export=NONE
#SBATCH --clusters=serial
#SBATCH --partition=serial_std
#SBATCH --ntasks=1
#SBATCH --time=00:15:00
set -uo pipefail
type module >/dev/null 2>&1 && module load slurm_setup 2>/dev/null || true

A_ID=$1; B_ID=$2; DIR=$3
say() { echo "PROBE $*"; }

say "== compute-side checks on $(hostname -f) (job $SLURM_JOB_ID, $(date -u +%FT%TZ)) =="

try() { # try <label> <command...> ; prints OK/FAILED with 2 lines of output
  local label=$1; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    say "$label: OK — $(echo "$out" | head -2 | tr '\n' ' / ')"
  else
    say "$label: FAILED (exit $rc) — $(echo "$out" | head -2 | tr '\n' ' / ')"
  fi
  return $rc
}

# A. read verbs, with and without -M (login default cluster is cm4, so
#    whether -M is required from a serial node is itself a finding)
try "squeue -M serial (own job)"  squeue --clusters=serial -h -j "$SLURM_JOB_ID" -o "%T"
try "squeue without -M (own job)" squeue -h -j "$SLURM_JOB_ID" -o "%T"
try "sacct -M serial (own job)"   sacct --clusters=serial -n -j "$SLURM_JOB_ID" --format=State
try "scontrol show (own job)"     scontrol --clusters=serial show job "$SLURM_JOB_ID"

# A. THE DECISIVE VERB: release the held target from a compute node
say "target A before release: $(squeue --clusters=serial -h -j "$A_ID" -o '%T reason=%r' 2>&1)"
try "scontrol release (held target A)" scontrol --clusters=serial release "$A_ID"
sleep 5
say "target A after release: $(squeue --clusters=serial -h -j "$A_ID" -o '%T reason=%r' 2>&1)"

# A. cancel from a compute node
try "scancel (held target B)" scancel --clusters=serial "$B_ID"
sleep 5
say "target B after scancel: sacct says '$(sacct --clusters=serial -n -j "$B_ID" --format=State 2>&1 | head -1 | tr -s ' ')'"

# A. sbatch re-confirmation (expected: denied — for the record)
printf '#!/bin/bash\ntrue\n' > "$DIR/noop2.sh"
try "sbatch from compute (expect denial)" sbatch --clusters=serial --partition=serial_std \
    --ntasks=1 --time=00:02:00 --job-name=brnnoop --output=/dev/null "$DIR/noop2.sh"
scancel --clusters=serial --jobname=brnnoop 2>/dev/null || true  # citizenship, if it worked

# A. srun job step inside this allocation (informs the fallback design)
try "srun job step (-n1 true)" srun -n 1 true

# C. scrontab reachability from a compute node
if command -v scrontab >/dev/null 2>&1; then
  try "scrontab -l from compute" scrontab -l
else
  say "scrontab (compute): command NOT installed"
fi

# B. non-interactive ssh back to the login alias
say "kerberos ticket on compute node: $(klist -s 2>/dev/null && echo PRESENT || echo none)"
try "ssh BatchMode -> cool.hpc.lrz.de" ssh -o BatchMode=yes -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new cool.hpc.lrz.de true
say "ssh auth methods offered: $(ssh -v -o BatchMode=yes -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new cool.hpc.lrz.de true 2>&1 \
    | grep -i 'Authentications that can continue' | head -1)"

# bonus: did released target A actually run? (file polling only, bounded)
for _ in $(seq 1 30); do
  [ -f "$DIR/released-target-ran.ok" ] && break
  sleep 10
done
if [ -f "$DIR/released-target-ran.ok" ]; then
  say "released target A RAN to completion (marker present) — release works end to end"
else
  say "released target A: marker not seen within 5 min (queue wait? its state above is the real evidence)"
fi

say "compute-side done."
EOF

OUT=$(sbatch --output="$DIR/compute-%j.log" "$PROBE" "$A_ID" "$B_ID" "$DIR" 2>&1)
line "$OUT"
JOB_ID=$(echo "$OUT" | grep -oE 'Submitted batch job [0-9]+' | grep -oE '[0-9]+' || true)
if [ -z "$JOB_ID" ]; then
  say "FATAL: could not submit the compute probe; cleaning up targets"
  scancel --clusters=serial "$A_ID" "$B_ID" 2>/dev/null || true
  exit 1
fi
COMPUTE_LOG="$DIR/compute-$JOB_ID.log"
say "compute probe submitted: job $JOB_ID; waiting for $COMPUTE_LOG (up to 20 min, file polling only)"

# Wait on the LOG FILE, not the scheduler (polling policy).
DEADLINE=$(( $(date +%s) + 1200 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$COMPUTE_LOG" ] && grep -q "compute-side done." "$COMPUTE_LOG" 2>/dev/null; then
    break
  fi
  sleep 15
done

# Best-effort cleanup of anything still queued (probe died early, long queue).
scancel --clusters=serial "$A_ID" "$B_ID" 2>/dev/null || true

line ""
if [ -f "$COMPUTE_LOG" ] && grep -q "compute-side done." "$COMPUTE_LOG" 2>/dev/null; then
  line "== compute-side results =="
  tee -a "$LOGIN_LOG" < "$COMPUTE_LOG"
  line ""
  say "ALL DONE. Send back this whole directory (or both logs): $DIR"
else
  say "compute probe not finished within 20 min (long queue?)."
  say "Check later with:  cat $COMPUTE_LOG"
  say "Then send back: $LOGIN_LOG and $COMPUTE_LOG"
fi

# --- how to read the results ---------------------------------------------
# scontrol release OK + scancel OK  -> held-pilot design: no ssh, no sbatch
#                                      needed at runtime. Best case.
# ssh BatchMode OK                  -> an ssh submission channel is possible
#                                      (hardened internal key or hostbased);
#                                      needed only if release/cancel FAILED.
# scrontab PRESENT                  -> slurmctld-hosted cron can top up the
#                                      shift chain / drain a submit spool.
# sinfo lines                       -> pin the real serial walltimes in docs.
# serial_long test-only lines       -> whether the qos flag is required yet.
