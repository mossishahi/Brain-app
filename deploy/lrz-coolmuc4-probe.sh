#!/bin/bash
# One-shot deployment probe for LRZ CoolMUC-4: verifies, from a REAL
# serial-cluster compute node, everything the Brainstorm server needs
# before deploy/lrz-coolmuc4-launch.sh can be trusted there.
#
# Submit from a login node:  sbatch deploy/lrz-coolmuc4-probe.sh
# Read the verdicts:         cat brain-probe-<jobid>.log   (one PROBE line each)
#
# What it checks and why:
#  1. outbound HTTPS   — the model API, the Brain Registry, and the Node.js
#                        download all need it from COMPUTE nodes.
#  2. sbatch on node   — the server submits pipeline workers from inside
#                        its own job.
#  3. clean squeue     — the server polls `squeue -h -j <id> -o %T` and
#                        parses the state; a multi-cluster banner line
#                        ("CLUSTER: serial") would corrupt that parse.
#  4. sacct format     — final-state polling parses the first whitespace
#                        token of `sacct -n -j <id> --format=State`.
#  5. proxy variables  — if LRZ routes HTTP through a proxy, the app picks
#                        it up from the environment automatically; we only
#                        need to know it is there.
#  6. ssh to own node  — decides whether the dashboard could bind loopback
#                        with a direct tunnel instead of 0.0.0.0.
#
#SBATCH --job-name=brain-probe
#SBATCH --output=brain-probe-%j.log
#SBATCH --error=brain-probe-%j.log
#SBATCH --clusters=serial
#SBATCH --partition=serial_std
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=1
#SBATCH --time=00:10:00
#SBATCH --get-user-env
#SBATCH --export=NONE

set -uo pipefail
type module >/dev/null 2>&1 && module load slurm_setup 2>/dev/null || true

echo "PROBE node: $(hostname -f)  (job $SLURM_JOB_ID, $(date -u +%FT%TZ))"
echo "PROBE glibc: $(ldd --version 2>/dev/null | head -1)"

echo "PROBE proxy environment (empty = direct):"
env | grep -i -E '^(https?|no)_proxy=' || echo "  (none set)"

check_https() {
  local label=$1 url=$2 code
  # ANY HTTP status (401 included) proves DNS + TLS + outbound routing;
  # only transport failures (code 000) mean the host is unreachable.
  code=$(curl -sS --max-time 20 -o /dev/null -w "%{http_code}" "$url" 2>/tmp/probe-err || true)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    echo "PROBE https $label: OK (HTTP $code — transport works)"
  else
    echo "PROBE https $label: FAILED ($(head -c 200 /tmp/probe-err))"
  fi
}
# Any HTTP status proves DNS + TLS + routing; only transport failures fail.
check_https "api.anthropic.com " "https://api.anthropic.com/v1/models"
check_https "brain registry    " "https://167.172.170.154/health" || true
check_https "nodejs.org        " "https://nodejs.org/dist/index.json"

# Submitting from a compute node: a 1-minute inner job that writes a marker.
MARKER="$PWD/brain-probe-inner-$SLURM_JOB_ID.ok"
INNER_SCRIPT=$(mktemp)
cat >"$INNER_SCRIPT" <<EOF
#!/bin/bash
#SBATCH --job-name=brain-probe-inner
#SBATCH --partition=serial_std
#SBATCH --ntasks=1
#SBATCH --time=00:02:00
#SBATCH --output=/dev/null
echo ok > "$MARKER"
EOF
chmod +x "$INNER_SCRIPT"
SUBMIT_OUTPUT=$(sbatch "$INNER_SCRIPT" 2>&1)
echo "PROBE sbatch from compute node: $SUBMIT_OUTPUT"
INNER_ID=$(echo "$SUBMIT_OUTPUT" | grep -oE 'Submitted batch job [0-9]+' | grep -oE '[0-9]+' || true)

if [ -n "$INNER_ID" ]; then
  # The exact command + parse the server uses for queue polling.
  for _ in $(seq 1 60); do
    STATE=$(squeue -h -j "$INNER_ID" -o %T 2>&1)
    echo "PROBE squeue raw: [$STATE]"
    [ -z "$STATE" ] && break
    sleep 5
  done
  sleep 10
  echo "PROBE sacct raw: [$(sacct -n -j "$INNER_ID" --format=State 2>&1 | head -3)]"
  if [ -f "$MARKER" ]; then
    echo "PROBE inner job: COMPLETED — worker submission from compute nodes works"
    rm -f "$MARKER"
  else
    echo "PROBE inner job: marker missing — check the inner job's fate above"
  fi
else
  echo "PROBE inner job: submission failed — the server cannot launch workers from a compute node"
fi
rm -f "$INNER_SCRIPT"

# Can the job owner ssh to the node the job runs on (for private tunnels)?
if command -v ssh >/dev/null 2>&1; then
  ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no "$(hostname -f)" true 2>/dev/null \
    && echo "PROBE ssh to own compute node: OK (loopback bind + direct tunnel possible)" \
    || echo "PROBE ssh to own compute node: not allowed (keep 0.0.0.0 bind + login-node tunnel)"
fi

echo "PROBE done."
