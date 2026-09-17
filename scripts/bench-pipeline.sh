#!/usr/bin/env bash
# Runs the full phase-1 + phase-2 pipeline once in an isolated memory home against your real pi
# sessions, then prints token usage from the run log. Makes real model calls — costs money.
# Extensions stay enabled so providers registered by extensions (e.g. proxies) resolve; this extension is loaded from the checkout.
set -euo pipefail
usage() { echo "Usage: $0 <label> <extract_model|null> <consolidation_model|null> <extract_thinking> <consolidation_thinking> <tool_result_token_budget> [provider/model for the pi session]" >&2; }
if [ $# -lt 6 ]; then usage; exit 2; fi
label=${1//[^A-Za-z0-9_-]/_}; em=$2; cm=$3; et=$4; ct=$5; budget=$6; sessionModel=${7:-}
[[ $budget =~ ^(0|[1-9][0-9]*)$ ]] || { echo "tool_result_token_budget must be a non-negative integer, got: $budget" >&2; exit 2; }
# Mirrors the `efforts` list in src/config.ts (source of truth); the extension re-validates on load.
efforts='off|minimal|low|medium|high|xhigh|max'
for v in "$et" "$ct"; do [[ $v =~ ^($efforts)$ ]] || { echo "thinking must be one of $efforts, got: $v" >&2; exit 2; }; done
modelRe='[A-Za-z0-9][A-Za-z0-9._:@-]*/[A-Za-z0-9][A-Za-z0-9._:@/-]*'
for v in "$em" "$cm"; do [[ $v =~ ^(null|$modelRe)$ ]] || { echo "model must be null or provider/model-id, got: $v" >&2; exit 2; }; done
if [ -n "$sessionModel" ]; then [[ $sessionModel =~ ^$modelRe$ ]] || { echo "session model must be provider/model-id, got: $sessionModel" >&2; exit 2; }; fi
home=$(mktemp -d -t pcm-bench-"$label"-XXXX)
command -v cygpath >/dev/null && home=$(cygpath -m "$home") # Git Bash: node must see the Windows path
q() { if [ "$1" = null ]; then echo null; else echo "\"$1\""; fi; }
cat > "$home/memories.json" <<EOF
{ "extract_model": $(q "$em"), "consolidation_model": $(q "$cm"), "extract_thinking": "$et", "consolidation_thinking": "$ct",
  "tool_result_token_budget": $budget, "min_rollout_idle_hours": 1, "max_rollouts_per_startup": 2 }
EOF
echo "home=$home"
ext="$(dirname "$0")/../index.ts"
command -v cygpath >/dev/null && ext=$(cygpath -m "$ext") # MSYS_NO_PATHCONV below disables auto conversion for all args
args=(-p --no-session -ns -np -nc --no-themes -e "$ext")
[ -n "$sessionModel" ] && args+=(--provider "${sessionModel%%/*}" --model "${sessionModel#*/}")
start=$(date +%s)
rc=0; MSYS_NO_PATHCONV=1 PI_CODEX_MEMORY_HOME="$home" pi "${args[@]}" "/memories force" || rc=$?
echo "elapsed=$(( $(date +%s) - start ))s pi_exit=$rc"
echo "--- $home/memories.log"
[ -f "$home/memories.log" ] || { echo "no memories.log written (pi exit $rc)" >&2; exit "$(( rc == 0 ? 1 : rc ))"; }
grep -E "phase1:|phase2:|pipeline:" "$home/memories.log" || cat "$home/memories.log"
exit $rc
