// Mirrors codex-rs/config/src/types.rs MemoriesConfig + defaults (pinned commit).
// Stored at <memory root parent>/memories.json so it survives `reset` of the memory root.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { atomicWrite, readJson } from "../safety.js";

export const PI_HOME = path.join(os.homedir(), ".pi", "agent");
// PI_CODEX_MEMORY_HOME: test/dev override so smoke runs never touch the real memory root or DB.
const HOME_OVERRIDE = process.env.PI_CODEX_MEMORY_HOME;
export const MEMORY_ROOT = path.join(HOME_OVERRIDE ?? PI_HOME, "memories");
export const SESSIONS_DIR = process.env.PI_CODEX_MEMORY_SESSIONS ?? path.join(PI_HOME, "sessions");
export const CONFIG_FILE = path.join(HOME_OVERRIDE ?? PI_HOME, "memories.json");
export const DB_FILE = path.join(HOME_OVERRIDE ?? PI_HOME, "memories_1.sqlite");

export type MemoriesConfig = {
  enabled: boolean;                      // features.memories
  generate_memories: boolean;
  use_memories: boolean;
  dedicated_tools: boolean;
  disable_on_external_context: boolean;
  max_raw_memories_for_consolidation: number;
  max_unused_days: number;
  max_rollout_age_days: number;
  max_rollouts_per_startup: number;
  min_rollout_idle_hours: number;
  extract_model: string | null;          // "provider/model-id"; null = current session model
  consolidation_model: string | null;
  extract_thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  consolidation_thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  consolidation_max_turns: number;       // pi-specific: bound on the consolidation agent tool loop
};

// Codex defaults except: dedicated_tools=true (pi has no exec_command so tools are the only read path),
// max_rollouts_per_startup/max_rollout_age_days raised to the values the public docs now list (16 / 30).
export const DEFAULTS: MemoriesConfig = {
  enabled: true,
  generate_memories: true,
  use_memories: true,
  dedicated_tools: true,
  disable_on_external_context: false,
  max_raw_memories_for_consolidation: 256,
  max_unused_days: 30,
  max_rollout_age_days: 30,
  max_rollouts_per_startup: 16,
  min_rollout_idle_hours: 6,
  extract_model: null,
  consolidation_model: null,
  extract_thinking: "low",       // codex stage_one::REASONING_EFFORT
  consolidation_thinking: "medium", // codex stage_two::REASONING_EFFORT
  consolidation_max_turns: 60,
};

// Codex constants (memories/write/src/lib.rs)
export const STAGE1 = { CONCURRENCY_LIMIT: 8, JOB_LEASE_SECONDS: 3600, JOB_RETRY_DELAY_SECONDS: 3600, THREAD_SCAN_LIMIT: 5000, PRUNE_BATCH_SIZE: 200, DEFAULT_ROLLOUT_TOKEN_LIMIT: 150_000, CONTEXT_WINDOW_PERCENT: 70 };
export const STAGE2 = { JOB_LEASE_SECONDS: 3600, JOB_RETRY_DELAY_SECONDS: 3600, JOB_HEARTBEAT_SECONDS: 90 };
export const WORKSPACE_DIFF = { FILENAME: "phase2_workspace_diff.md", MAX_BYTES: 4 * 1024 * 1024 };
export const EXTENSION_RESOURCES = { RETENTION_DAYS: 7 };
export const SUMMARY_TOKEN_LIMIT = 2_500; // ext/memories MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT

export function loadConfig(): MemoriesConfig {
  const raw = readJson(CONFIG_FILE, {}) as Partial<MemoriesConfig>;
  const cfg: MemoriesConfig = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof MemoriesConfig)[]) {
    if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] === typeof DEFAULTS[k]) (cfg as any)[k] = raw[k];
    else if (raw[k] === null && (k === "extract_model" || k === "consolidation_model")) (cfg as any)[k] = null;
  }
  cfg.max_raw_memories_for_consolidation = Math.min(4096, Math.max(1, cfg.max_raw_memories_for_consolidation));
  cfg.max_rollouts_per_startup = Math.min(128, Math.max(1, cfg.max_rollouts_per_startup));
  return cfg;
}

export function saveConfig(patch: Partial<MemoriesConfig>) {
  const raw = readJson(CONFIG_FILE, {}) as Record<string, unknown>;
  atomicWrite(CONFIG_FILE, JSON.stringify({ ...raw, ...patch }, null, 2) + "\n");
}

export function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) atomicWrite(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + "\n");
}
