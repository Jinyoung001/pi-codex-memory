#!/usr/bin/env bash
# Runs the full phase-1 + phase-2 pipeline once in an isolated memory home against your real pi
# sessions, then prints token usage from the run log. Makes real model calls — costs money.
# Usage: scripts/bench-pipeline.sh <label> <extract_model|null> <consolidation_model|null> <extract_thinking> <consolidation_thinking> <tool_result_token_budget> [provider/model for the pi session]
# Extensions stay enabled so providers registered by extensions (e.g. proxies) resolve; this extension is loaded from the checkout.
set -euo pipefail
if [ $# -lt 6 ]; then sed -n '4p' "$0" >&2; exit 2; fi
label=${1//[^A-Za-z0-9_-]/_}; em=$2; cm=$3; et=$4; ct=$5; budget=$6; sessionModel=${7:-}
[[ $budget =~ ^[0-9]+$ ]] || { echo "tool_result_token_budget must be a non-negative integer, got: $budget" >&2; exit 2; }
if [ -n "$sessionModel" ]; then case $sessionModel in */*) ;; *) echo "session model must be provider/model, got: $sessionModel" >&2; exit 2;; esac; fi
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
MSYS_NO_PATHCONV=1 PI_CODEX_MEMORY_HOME="$home" pi "${args[@]}" "/memories force" || true
echo "elapsed=$(( $(date +%s) - start ))s"
echo "--- $home/memories.log"
grep -E "phase1:|phase2:|pipeline:" "$home/memories.log" || cat "$home/memories.log"
