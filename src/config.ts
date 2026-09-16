// Mirrors codex-rs/config/src/types.rs MemoriesConfig + defaults (pinned commit).
// Stored at <memory root parent>/memories.json so it survives `reset` of the memory root.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { atomicWrite, readJson, withFileLock } from "../safety.js";

export const PI_HOME = path.join(os.homedir(), ".pi", "agent");
// PI_CODEX_MEMORY_HOME: test/dev override so smoke runs never touch the real memory root or DB.
const HOME_OVERRIDE = process.env.PI_CODEX_MEMORY_HOME;
export const MEMORY_ROOT = path.join(HOME_OVERRIDE ?? PI_HOME, "memories");
export const SESSIONS_DIR = process.env.PI_CODEX_MEMORY_SESSIONS ?? path.join(PI_HOME, "sessions");
export const CONFIG_FILE = path.join(HOME_OVERRIDE ?? PI_HOME, "memories.json");
export const DB_FILE = path.join(HOME_OVERRIDE ?? PI_HOME, "memories_1.sqlite");

export type MemoryVersion = "v1" | "v2";
export const memoryRootFor = (version: MemoryVersion) => path.join(HOME_OVERRIDE ?? PI_HOME, version === "v2" ? "memories_v2" : "memories");
export const memoryDbFor = (version: MemoryVersion) => path.join(HOME_OVERRIDE ?? PI_HOME, version === "v2" ? "memories_2.sqlite" : "memories_1.sqlite");

export type MemoriesConfig = {
  version: MemoryVersion;
  dual_write: boolean;
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
};

// Pinned V1 defaults. Installing the extension enables the feature in pi.
export const DEFAULTS: MemoriesConfig = {
  version: "v1",
  dual_write: false,
  enabled: true,
  generate_memories: true,
  use_memories: true,
  dedicated_tools: false,
  disable_on_external_context: false,
  max_raw_memories_for_consolidation: 256,
  max_unused_days: 30,
  max_rollout_age_days: 10,
  max_rollouts_per_startup: 2,
  min_rollout_idle_hours: 6,
  extract_model: null,
  consolidation_model: null,
  extract_thinking: "low",       // codex stage_one::REASONING_EFFORT
  consolidation_thinking: "medium", // codex stage_two::REASONING_EFFORT
};

// Codex constants (memories/write/src/lib.rs)
export const STAGE1 = { CONCURRENCY_LIMIT: 8, JOB_LEASE_SECONDS: 3600, JOB_HEARTBEAT_SECONDS: 90, REQUEST_TIMEOUT_SECONDS: 55 * 60, JOB_RETRY_DELAY_SECONDS: 3600, THREAD_SCAN_LIMIT: 5000, PRUNE_BATCH_SIZE: 200, DEFAULT_ROLLOUT_TOKEN_LIMIT: 150_000, CONTEXT_WINDOW_PERCENT: 70 };
export const STAGE2 = { JOB_LEASE_SECONDS: 3600, JOB_RETRY_DELAY_SECONDS: 3600, JOB_HEARTBEAT_SECONDS: 90 };
export const WORKSPACE_DIFF = { FILENAME: "phase2_workspace_diff.md", MAX_BYTES: 4 * 1024 * 1024 };
export const EXTENSION_RESOURCES = { RETENTION_DAYS: 7 };
export const SUMMARY_TOKEN_LIMIT = 2_500; // ext/memories MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT

export function loadConfig(): MemoriesConfig {
  return validateConfig(readConfigObject());
}
function readConfigObject(): Record<string, unknown> {
  const raw: unknown = readJson(CONFIG_FILE, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("memories config must be an object");
  return raw as Record<string, unknown>;
}
function validateConfig(raw: Record<string, unknown>): MemoriesConfig {
  const cfg: MemoriesConfig = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof MemoriesConfig)[]) {
    if (k === "extract_model" || k === "consolidation_model") {
      const model = raw[k];
      if (model === undefined) continue;
      if (model !== null && (typeof model !== "string" || !model.trim())) {
        throw new Error(`${k} must be a non-empty provider/model string or null`);
      }
      cfg[k] = model;
    } else if (raw[k] !== undefined) {
      if (typeof raw[k] !== typeof DEFAULTS[k]) throw new Error(`${k} must be ${typeof DEFAULTS[k]}`);
      // Runtime checks above establish the default's primitive type; enum/integer checks follow.
      Object.assign(cfg, { [k]: raw[k] });
    }
  }
  if (cfg.version !== "v1" && cfg.version !== "v2") throw new Error("version must be v1 or v2");
  for (const [key, value] of Object.entries(cfg)) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`${key} must be an integer`);
  }
  cfg.max_unused_days = Math.min(365, Math.max(0, cfg.max_unused_days));
  cfg.max_rollout_age_days = Math.min(90, Math.max(0, cfg.max_rollout_age_days));
  cfg.min_rollout_idle_hours = Math.min(48, Math.max(1, cfg.min_rollout_idle_hours));
  const efforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!efforts.includes(cfg.extract_thinking) || !efforts.includes(cfg.consolidation_thinking)) throw new Error("invalid memory reasoning effort");
  cfg.max_raw_memories_for_consolidation = Math.min(4096, Math.max(1, cfg.max_raw_memories_for_consolidation));
  cfg.max_rollouts_per_startup = Math.min(128, Math.max(1, cfg.max_rollouts_per_startup));
  return cfg;
}

const withConfigLock = <T>(fn: () => T): T => withFileLock(CONFIG_FILE + '.lock', fn);

export function saveConfig(patch: Partial<MemoriesConfig>) {
  return withConfigLock(() => {
    const merged = { ...readConfigObject(), ...patch };
    validateConfig(merged);
    atomicWrite(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n");
  });
}

export function migrateLegacyConfig(): string[] {
  return withConfigLock(() => {
    const raw = readConfigObject();
    const removed = ["consolidation_max_turns","profile","recall_max_bytes","recall_max_tokens","recall_semantic","core_max_tokens","memory_auto_tidy","memory_daily_calls"].filter(k => Object.hasOwn(raw,k));
    if (!removed.length) return [];
    let backup = CONFIG_FILE + ".before-codex-only.bak";
    for(let i=1;fs.existsSync(backup);i++)backup=CONFIG_FILE+`.before-codex-only.${i}.bak`;
    fs.copyFileSync(CONFIG_FILE,backup,fs.constants.COPYFILE_EXCL);
    for (const k of removed) delete raw[k];
    atomicWrite(CONFIG_FILE,JSON.stringify(raw,null,2)+"\n");
    return removed;
  });
}

export function ensureConfigFile() {
  withConfigLock(() => {
    // Lock serialises writers; atomicWrite keeps unlocked readers from seeing a partial file.
    if (!fs.existsSync(CONFIG_FILE)) atomicWrite(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
  });
}
