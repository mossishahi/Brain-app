# The server job's own walltime survival, as sourceable functions.
#
# WHY THIS EXISTS: a run's host job is protected by the server — when a worker
# job nears its walltime the server resubmits it and the run continues from its
# checkpoint. Nothing protected the SERVER's job. It hit its 12-hour limit
# overnight, died, and a worker went on running with nobody watching it: no
# resume when it failed, no dashboard, no scheduler for its credit block. The
# submitter found it in the morning by reading `squeue` by hand.
#
# The shape of the fix: while the job still has plenty of time left, submit the
# NEXT server job. `--dependency=singleton` (in slurm-launch.sh's directives)
# holds it until this one is gone, so the two never fight over the port, and the
# successor is already PENDING when the handover comes — which is what keeps the
# gap down to queue latency instead of however long until somebody notices.
#
# Every function here reads only its environment and the scheduler commands, so
# the logic is testable without a cluster.

# One SLURM timestamp (2026-08-19T22:00:00) as a unix epoch. GNU date first,
# BSD second: the wrapper only ever runs on a Linux compute node, but the logic
# is worth being able to test on the machine it is written on.
brain_epoch_of() {
  local stamp="$1"
  date -d "$stamp" +%s 2>/dev/null && return 0
  date -j -f "%Y-%m-%dT%H:%M:%S" "$stamp" +%s 2>/dev/null && return 0
  return 0
}

# The job's end time as a unix epoch, from ONE scontrol call. Empty when it
# cannot be determined (not under SLURM, no scontrol, unparsable answer) — the
# caller then simply does not renew, which is the pre-existing behaviour.
brain_job_end_epoch() {
  local job_id="${1:-${SLURM_JOB_ID:-}}"
  [ -n "$job_id" ] || return 0
  command -v scontrol >/dev/null 2>&1 || return 0
  local end
  end=$(scontrol -o show job "$job_id" 2>/dev/null | tr ' ' '\n' | sed -n 's/^EndTime=//p' | head -1)
  [ -n "$end" ] && [ "$end" != "Unknown" ] || return 0
  brain_epoch_of "$end"
}

# The job's own time limit as an sbatch flag, so the successor inherits the
# walltime this job was submitted with — including an override the operator
# passed on the command line, which the #SBATCH directives do not know about.
brain_time_limit_flag() {
  local job_id="${1:-${SLURM_JOB_ID:-}}"
  [ -n "$job_id" ] || return 0
  command -v scontrol >/dev/null 2>&1 || return 0
  local limit
  limit=$(scontrol -o show job "$job_id" 2>/dev/null | tr ' ' '\n' | sed -n 's/^TimeLimit=//p' | head -1)
  case "$limit" in
    "" | UNLIMITED | Unknown | INVALID) return 0 ;;
    *) printf -- '--time=%s' "$limit" ;;
  esac
}

# The next generation's name: brain -> brain-2 -> brain-3. The number is what
# makes the handovers countable in one squeue column, which is the whole reason
# the name changes at all; `brain` with no suffix is generation 1.
brain_next_name() {
  local current="${1:-brain}" base generation
  base="${current%%-[0-9]*}"
  [ -n "$base" ] || base=brain
  generation="${current##*-}"
  case "$generation" in
    "$current" | *[!0-9]* | "") generation=1 ;;
  esac
  printf '%s-%s' "$base" "$(( generation + 1 ))"
}

# Our own server jobs, one "<id> <name> <state>" per line. The name is matched by
# PREFIX because each generation carries its own: `--dependency=singleton` keys
# on an exact name, so it stopped being the thing that keeps two servers off one
# port the moment the names started differing.
brain_server_jobs() {
  local base="${1:-brain}"
  command -v squeue >/dev/null 2>&1 || return 0
  squeue -h -u "${USER:-$(id -un)}" -o '%i %j %t' 2>/dev/null |
    awk -v base="$base" '$2 == base || index($2, base "-") == 1'
}

# True when a successor is already waiting, so a second one is never queued.
brain_successor_pending() {
  local base="${1:-brain}" pending
  pending=$(brain_server_jobs "$base" | awk '$3 == "PD"' | wc -l | tr -d ' ')
  [ "${pending:-0}" -gt 0 ]
}

# Another generation of the server already serving. Prints "<id> <name>" for the
# first one found, so the caller can name it in its own refusal.
brain_other_server_running() {
  local base="${1:-brain}" self="${2:-${SLURM_JOB_ID:-}}"
  brain_server_jobs "$base" |
    awk -v self="$self" '$3 == "R" && $1 != self { print $1, $2; exit }'
}

# Submits the next server job and echoes its id. Never fatal: a deployment that
# cannot renew must keep serving and say so, not fall over.
#
# The successor is named for its generation and depends on THIS job by id rather
# than on a shared name: afterany holds it until this one has terminated however
# it terminates, which is the guarantee singleton used to give and does not give
# once every generation has a different name.
brain_submit_successor() {
  local script="$1" base="${2:-brain}" self="${3:-${SLURM_JOB_ID:-}}"
  if brain_successor_pending "$base"; then
    echo "[renew] a successor is already queued; not submitting another" >&2
    return 0
  fi
  command -v sbatch >/dev/null 2>&1 || {
    echo "[renew] sbatch is not available here; this job will NOT be renewed" >&2
    return 0
  }
  local next dependency out
  next=$(brain_next_name "${SLURM_JOB_NAME:-$base}")
  dependency=""
  [ -n "$self" ] && dependency="--dependency=afterany:$self"
  # shellcheck disable=SC2046,SC2086  # each flag is one word or empty by construction
  out=$(sbatch $(brain_time_limit_flag) --job-name="$next" $dependency "$script" 2>&1) || {
    echo "[renew] sbatch refused the successor: $out" >&2
    return 0
  }
  local id
  id=$(printf '%s' "$out" | sed -n 's/^Submitted batch job \([0-9]*\).*/\1/p' | head -1)
  [ -n "$id" ] || { echo "[renew] unrecognized sbatch answer: $out" >&2; return 0; }
  echo "[renew] queued successor job $id as $next (starts when this one ends)" >&2
  printf '%s' "$id"
}

# Whether an arriving TERM is the walltime or an operator's scancel. SLURM sends
# the same signal for both, so a job cancelled by hand would otherwise leave its
# successor behind and the deployment would refuse to die.
#
# The end time is known, so the question is simply how much of it is left.
brain_term_is_walltime() {
  local end="${1:-}" now="${2:-$(date +%s)}" slack="${3:-600}"
  [ -n "$end" ] || return 1
  [ "$(( end - now ))" -le "$slack" ]
}
