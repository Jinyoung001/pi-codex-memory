// SQLite-backed memory state. Mirrors codex-rs/state/memory_migrations/0001_memories.sql
// and the claim/lease/heartbeat semantics in codex-rs/state/src/runtime/memories.rs.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { redact } from "../safety.js";

const JOB_STAGE1 = "memory_stage1";
const JOB_PHASE2 = "memory_consolidate_global";
const PHASE2_KEY = "global";
const PHASE2_SUCCESS_COOLDOWN_S = 6 * 60 * 60;
const DEFAULT_RETRY_REMAINING = 3;

export type Stage1Output = {
  threadId: string;
  sourceUpdatedAt: number; // unix seconds
  rawMemory: string;
  rolloutSummary: string;
  rolloutSlug: string | null;
  generatedAt: number;
  usageCount: number;
  lastUsage: number | null;
  cwd: string;
  rolloutPath: string;
  gitBranch: string | null;
};

export type ThreadRow = {
  id: string;
  rolloutPath: string;
  cwd: string;
  updatedAtMs: number;
  memoryMode: "enabled" | "disabled" | "polluted";
  gitBranch: string | null;
  source?: "interactive" | "exec" | "subagent";
  archived?: boolean;
};

export type Stage1Claim = { thread: ThreadRow; ownershipToken: string };
export type Phase2Claim =
  | { outcome: "claimed"; ownershipToken: string; inputWatermark: number }
  | { outcome: "skipped_running" | "skipped_cooldown" | "skipped_retry_unavailable" };

const now = () => Math.floor(Date.now() / 1000);
const n = (v: number | bigint) => Number(v);

export class MemoryStore {
  private db: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const existing = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'").get();
    if (existing) {
      const columns = new Set((this.db.prepare("PRAGMA table_info(threads)").all() as any[]).map(r=>r.name));
      const progress = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='consolidation_progress'").get();
      const jobs=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get();
      const legacyErrors=jobs && this.db.prepare("SELECT 1 FROM jobs WHERE status='failed' LIMIT 1").get();
      if (!columns.has("source") || !columns.has("archived") || !progress || legacyErrors) {
        const backup=file+".before-codex-schema.bak";
        if (!fs.existsSync(backup)) {
          try { this.db.prepare("VACUUM INTO ?").run(backup); }
          catch(e) { this.db.close(); throw e; }
        }
      }
    }
    this.migrate();
  }
  close() { this.db.close(); }

  private migrate() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  memory_mode TEXT NOT NULL DEFAULT 'enabled',
  git_branch TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at_ms DESC);
CREATE TABLE IF NOT EXISTS stage1_outputs (
  thread_id TEXT PRIMARY KEY,
  source_updated_at INTEGER NOT NULL,
  raw_memory TEXT NOT NULL,
  rollout_summary TEXT NOT NULL,
  rollout_slug TEXT,
  generated_at INTEGER NOT NULL,
  usage_count INTEGER,
  last_usage INTEGER,
  selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
  selected_for_phase2_source_updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stage1_outputs_source_updated_at ON stage1_outputs(source_updated_at DESC, thread_id DESC);
CREATE TABLE IF NOT EXISTS jobs (
  kind TEXT NOT NULL,
  job_key TEXT NOT NULL,
  status TEXT NOT NULL,
  worker_id TEXT,
  ownership_token TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  retry_at INTEGER,
  retry_remaining INTEGER NOT NULL,
  last_error TEXT,
  input_watermark INTEGER,
  last_success_watermark INTEGER,
  PRIMARY KEY (kind, job_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_kind_status_retry_lease ON jobs(kind, status, retry_at, lease_until);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consolidation_progress (singleton INTEGER PRIMARY KEY CHECK(singleton=1), max_thread_count INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO consolidation_progress(singleton) VALUES(1);
`);
    const columns = new Set((this.db.prepare("PRAGMA table_info(threads)").all() as any[]).map(row => row.name));
    if (!columns.has("source")) this.db.exec("ALTER TABLE threads ADD COLUMN source TEXT NOT NULL DEFAULT 'interactive'");
    if (!columns.has("archived")) this.db.exec("ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    this.db.exec("UPDATE jobs SET status='error' WHERE status='failed'; COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  // ---------- threads (pi has no thread DB; we index session files) ----------
  upsertThread(t: ThreadRow) {
    this.db.prepare(`INSERT INTO threads (id, rollout_path, cwd, updated_at_ms, git_branch, memory_mode, source, archived) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 'interactive'), ?)
      ON CONFLICT(id) DO UPDATE SET rollout_path = excluded.rollout_path, cwd = excluded.cwd,
        updated_at_ms = excluded.updated_at_ms, git_branch = COALESCE(excluded.git_branch, threads.git_branch),
        source = COALESCE(?, threads.source), archived = excluded.archived`)
      .run(t.id, t.rolloutPath, t.cwd, t.updatedAtMs, t.gitBranch, t.memoryMode, t.source ?? null, Number(t.archived ?? false), t.source ?? null);
  }
  /** Pi deletes sessions rather than archiving them. Keep their evidence, but stop new extraction. */
  archiveMissingThreadFiles() {
    const rows = this.db.prepare("SELECT id, rollout_path FROM threads WHERE archived=0").all() as any[];
    const archive = this.db.prepare("UPDATE threads SET archived=1 WHERE id=?");
    this.withMutation(() => {
      for (const row of rows) {
        try { if (fs.lstatSync(row.rollout_path).isFile()) continue; }
        catch (e: any) { if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e; }
        archive.run(row.id);
      }
    });
  }
  setThreadMemoryMode(id: string, mode: ThreadRow["memoryMode"]) {
    // Mirrors mark_thread_memory_mode_polluted: only escalates, never re-enables a polluted thread implicitly.
    if (mode === "polluted") {
      const changed = this.db.prepare(`UPDATE threads SET memory_mode = 'polluted' WHERE id = ? AND memory_mode != 'polluted'`).run(id).changes > 0;
      const selected = this.db.prepare(`SELECT selected_for_phase2 FROM stage1_outputs WHERE thread_id=?`).get(id) as any;
      if (selected?.selected_for_phase2) this.enqueueGlobalConsolidation(now());
      return changed;
    }
    return this.db.prepare(`UPDATE threads SET memory_mode = ? WHERE id = ?`).run(mode, id).changes > 0;
  }
  threadMemoryMode(id: string): ThreadRow["memoryMode"] | undefined {
    const r = this.db.prepare(`SELECT memory_mode FROM threads WHERE id = ?`).get(id) as any;
    return r?.memory_mode;
  }

  // ---------- phase 1 ----------
  claimStage1JobsForStartup(p: { currentThreadId: string; scanLimit: number; maxClaimed: number; maxAgeDays: number; minIdleHours: number; leaseSeconds: number }): Stage1Claim[] {
    if (p.scanLimit === 0 || p.maxClaimed === 0) return [];
    const nowMs = Date.now();
    const maxAgeCutoff = nowMs - p.maxAgeDays * 86400e3;
    const idleCutoff = nowMs - p.minIdleHours * 3600e3;
    const candidates = this.db.prepare(`
      SELECT id, rollout_path, cwd, updated_at_ms, memory_mode, git_branch FROM threads
      WHERE memory_mode = 'enabled' AND source = 'interactive' AND archived = 0 AND id != ? AND updated_at_ms >= ? AND updated_at_ms <= ?
      ORDER BY updated_at_ms DESC LIMIT ?`).all(p.currentThreadId, maxAgeCutoff, idleCutoff, p.scanLimit) as any[];
    const claims: Stage1Claim[] = [];
    for (const c of candidates) {
      if (claims.length >= p.maxClaimed) break;
      const thread: ThreadRow = { id: c.id, rolloutPath: c.rollout_path, cwd: c.cwd, updatedAtMs: c.updated_at_ms, memoryMode: c.memory_mode, gitBranch: c.git_branch };
      const token = this.tryClaimStage1Job(thread, p.currentThreadId, p.leaseSeconds, p.maxClaimed, maxAgeCutoff, idleCutoff);
      if (token) claims.push({ thread, ownershipToken: token });
    }
    return claims;
  }

  private tryClaimStage1Job(thread: ThreadRow, workerId: string, leaseSeconds: number, maxRunning: number, maxAgeCutoff: number, idleCutoff: number): string | null {
    const t = now(), leaseUntil = t + leaseSeconds, token = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(`SELECT id, rollout_path, cwd, updated_at_ms, memory_mode, git_branch FROM threads WHERE id=? AND id!=? AND memory_mode='enabled' AND source='interactive' AND archived=0 AND updated_at_ms>=? AND updated_at_ms<=?`).get(thread.id, workerId, maxAgeCutoff, idleCutoff) as { id: string; rollout_path: string; cwd: string; updated_at_ms: number; memory_mode: ThreadRow['memoryMode']; git_branch: string | null } | undefined;
      if (!current) { this.db.exec('COMMIT'); return null; }
      Object.assign(thread, { rolloutPath: current.rollout_path, cwd: current.cwd, updatedAtMs: current.updated_at_ms, memoryMode: current.memory_mode, gitBranch: current.git_branch });
      const watermark = Math.floor(thread.updatedAtMs / 1000);
      const active = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind=? AND status='running' AND lease_until > ?`).get(JOB_STAGE1, t) as any;
      if (active.n >= maxRunning) { this.db.exec("COMMIT"); return null; }
      // Up to date already?
      const out = this.db.prepare(`SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?`).get(thread.id) as any;
      const job = this.db.prepare(`SELECT status, lease_until, retry_at, retry_remaining, input_watermark, last_success_watermark FROM jobs WHERE kind = ? AND job_key = ?`).get(JOB_STAGE1, thread.id) as any;
      const upToDate = (out && out.source_updated_at >= watermark) || (job && job.last_success_watermark != null && job.last_success_watermark >= watermark);
      if (upToDate) { this.db.exec("COMMIT"); return null; }
      if (job) {
        const advanced = watermark > (job.input_watermark ?? -1);
        if (!advanced && job.retry_at != null && job.retry_at > t) { this.db.exec("COMMIT"); return null; }
        if (job.status === "running" && job.lease_until != null && job.lease_until > t) { this.db.exec("COMMIT"); return null; }
        if (!advanced && job.retry_remaining <= 0) { this.db.exec("COMMIT"); return null; }
        this.db.prepare(`UPDATE jobs SET status='running', worker_id=?, ownership_token=?, started_at=?, finished_at=NULL, lease_until=?, retry_at=NULL, input_watermark=?, retry_remaining=?, last_error=NULL WHERE kind=? AND job_key=?`)
          .run(workerId, token, t, leaseUntil, watermark, advanced ? DEFAULT_RETRY_REMAINING : job.retry_remaining, JOB_STAGE1, thread.id);
      } else {
        this.db.prepare(`INSERT INTO jobs (kind, job_key, status, worker_id, ownership_token, started_at, finished_at, lease_until, retry_at, retry_remaining, last_error, input_watermark, last_success_watermark)
          VALUES (?, ?, 'running', ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, NULL)`).run(JOB_STAGE1, thread.id, workerId, token, t, leaseUntil, DEFAULT_RETRY_REMAINING, watermark);
      }
      this.db.exec("COMMIT");
      return token;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  markStage1JobSucceeded(threadId: string, token: string, sourceUpdatedAt: number, rawMemory: string, rolloutSummary: string, rolloutSlug: string | null): boolean {
    const t = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ch = this.db.prepare(`UPDATE jobs SET status='done', finished_at=?, lease_until=NULL, last_error=NULL, retry_remaining=?, last_success_watermark=input_watermark
        WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`).run(t, DEFAULT_RETRY_REMAINING, JOB_STAGE1, threadId, token).changes;
      if (!ch) { this.db.exec("COMMIT"); return false; }
      // Preserve usage + previous phase-2 selection baseline (Codex: upsert keeps selected_for_phase2 until next phase 2).
      this.db.prepare(`INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at, usage_count, last_usage)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(thread_id) DO UPDATE SET source_updated_at=excluded.source_updated_at, raw_memory=excluded.raw_memory,
          rollout_summary=excluded.rollout_summary, rollout_slug=excluded.rollout_slug, generated_at=excluded.generated_at
        WHERE excluded.source_updated_at >= stage1_outputs.source_updated_at`)
        .run(threadId, sourceUpdatedAt, rawMemory, rolloutSummary, rolloutSlug, t);
      this.enqueueGlobalConsolidation(sourceUpdatedAt);
      this.db.exec("COMMIT");
      return true;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  markStage1JobSucceededNoOutput(threadId: string, token: string): boolean {
    const t = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ch = this.db.prepare(`UPDATE jobs SET status='done', finished_at=?, lease_until=NULL, last_error=NULL, last_success_watermark=input_watermark
        WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`).run(t, JOB_STAGE1, threadId, token).changes;
      if (!ch) { this.db.exec("COMMIT"); return false; }
      const wm = (this.db.prepare(`SELECT input_watermark FROM jobs WHERE kind=? AND job_key=?`).get(JOB_STAGE1, threadId) as any).input_watermark ?? 0;
      const del = this.db.prepare(`DELETE FROM stage1_outputs WHERE thread_id = ?`).run(threadId).changes;
      if (del > 0) this.enqueueGlobalConsolidation(wm);
      this.db.exec("COMMIT");
      return true;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  markStage1JobFailed(threadId: string, token: string, reason: string, retryDelaySeconds: number): boolean {
    reason = redact(reason);
    const t = now();
    return this.db.prepare(`UPDATE jobs SET status='error', finished_at=?, lease_until=NULL, retry_at=?, retry_remaining=MAX(retry_remaining - 1, 0), last_error=?
      WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`).run(t, t + retryDelaySeconds, reason.slice(0, 500), JOB_STAGE1, threadId, token).changes > 0;
  }

  heartbeatStage1Job(threadId: string, token: string, leaseSeconds: number): boolean {
    return this.db.prepare(`UPDATE jobs SET lease_until=? WHERE kind=? AND job_key=? AND status='running' AND ownership_token=? AND EXISTS(SELECT 1 FROM threads WHERE id=? AND memory_mode='enabled' AND source='interactive' AND archived=0)`).run(now() + leaseSeconds, JOB_STAGE1, threadId, token, threadId).changes > 0;
  }

  releaseStage1Job(threadId: string, token: string): boolean {
    return this.db.prepare(`UPDATE jobs SET status='pending', lease_until=NULL, ownership_token=NULL, retry_at=NULL WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`).run(JOB_STAGE1, threadId, token).changes > 0;
  }

  deleteThreadMemory(threadId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const del = this.db.prepare(`DELETE FROM stage1_outputs WHERE thread_id = ?`).run(threadId).changes;
      this.db.prepare(`DELETE FROM jobs WHERE kind = ? AND job_key = ?`).run(JOB_STAGE1, threadId);
      if (del) this.enqueueGlobalConsolidation(now());
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  pruneStage1OutputsForRetention(maxUnusedDays: number, limit: number): number {
    if (limit === 0) return 0;
    const cutoff = now() - Math.max(0, maxUnusedDays) * 86400;
    return n(this.db.prepare(`DELETE FROM stage1_outputs WHERE thread_id IN (
      SELECT thread_id FROM stage1_outputs WHERE selected_for_phase2 = 0 AND COALESCE(last_usage, source_updated_at) < ?
      ORDER BY COALESCE(last_usage, source_updated_at) ASC, source_updated_at ASC, thread_id ASC LIMIT ?)`).run(cutoff, limit).changes);
  }

  recordStage1OutputUsage(threadIds: string[]): number {
    if (!threadIds.length) return 0;
    const t = now();
    const st = this.db.prepare(`UPDATE stage1_outputs SET usage_count = COALESCE(usage_count, 0) + 1, last_usage = ? WHERE thread_id = ?`);
    let count = 0;
    for (const id of threadIds) count += n(st.run(t, id).changes);
    return count;
  }

  // ---------- phase 2 ----------
  private enqueueGlobalConsolidation(watermark: number) {
    // Insert-or-bump input watermark; never touches a running lease.
    this.db.prepare(`INSERT INTO jobs (kind, job_key, status, retry_remaining, input_watermark, last_success_watermark)
      VALUES (?, ?, 'pending', ?, ?, 0)
      ON CONFLICT(kind, job_key) DO UPDATE SET
        status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'pending' END,
        retry_at = CASE WHEN jobs.status = 'running' THEN jobs.retry_at ELSE NULL END,
        retry_remaining = MAX(jobs.retry_remaining, excluded.retry_remaining),
        input_watermark = CASE WHEN excluded.input_watermark > COALESCE(jobs.input_watermark, 0)
          THEN excluded.input_watermark ELSE COALESCE(jobs.input_watermark, 0) + 1 END`)
      .run(JOB_PHASE2, PHASE2_KEY, DEFAULT_RETRY_REMAINING, watermark);
  }

  getPhase2InputSelection(n: number, maxUnusedDays: number): Stage1Output[] {
    if (n === 0) return [];
    const cutoff = now() - Math.max(0, maxUnusedDays) * 86400;
    const rows = this.db.prepare(`
      SELECT so.*, th.cwd, th.rollout_path, th.git_branch FROM stage1_outputs so
      JOIN threads th ON th.id = so.thread_id AND th.memory_mode = 'enabled' AND th.source = 'interactive'
      WHERE (length(trim(so.raw_memory)) > 0 OR length(trim(so.rollout_summary)) > 0)
        AND ((so.last_usage IS NOT NULL AND so.last_usage >= ?) OR (so.last_usage IS NULL AND so.source_updated_at >= ?))
      ORDER BY COALESCE(so.usage_count, 0) DESC, COALESCE(so.last_usage, so.source_updated_at) DESC, so.source_updated_at DESC, so.thread_id DESC
      LIMIT ?`).all(cutoff, cutoff, n) as any[];
    return rows.map(r => ({
      threadId: r.thread_id, sourceUpdatedAt: r.source_updated_at, rawMemory: r.raw_memory, rolloutSummary: r.rollout_summary,
      rolloutSlug: r.rollout_slug, generatedAt: r.generated_at, usageCount: r.usage_count ?? 0, lastUsage: r.last_usage,
      cwd: r.cwd, rolloutPath: r.rollout_path, gitBranch: r.git_branch,
    })).sort((a, b) => a.threadId.localeCompare(b.threadId));
  }

  tryClaimGlobalPhase2Job(workerId: string, leaseSeconds: number, opts: { ignoreCooldown?: boolean } = {}): Phase2Claim {
    const t = now(), leaseUntil = t + leaseSeconds, cooldownCutoff = t - PHASE2_SUCCESS_COOLDOWN_S, token = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.db.prepare(`SELECT status, lease_until, retry_at, retry_remaining, input_watermark, finished_at, last_error FROM jobs WHERE kind=? AND job_key=?`).get(JOB_PHASE2, PHASE2_KEY) as any;
      if (!job) {
        this.db.prepare(`INSERT INTO jobs (kind, job_key, status, worker_id, ownership_token, started_at, finished_at, lease_until, retry_at, retry_remaining, last_error, input_watermark, last_success_watermark)
          VALUES (?, ?, 'running', ?, ?, ?, NULL, ?, NULL, ?, NULL, 0, 0)`).run(JOB_PHASE2, PHASE2_KEY, workerId, token, t, leaseUntil, DEFAULT_RETRY_REMAINING);
        this.db.exec("COMMIT");
        return { outcome: "claimed", ownershipToken: token, inputWatermark: 0 };
      }
      if (!opts.ignoreCooldown && job.retry_at != null && job.retry_at > t) { this.db.exec("COMMIT"); return { outcome: "skipped_retry_unavailable" }; }
      if (job.status === "running" && job.lease_until != null && job.lease_until > t) { this.db.exec("COMMIT"); return { outcome: "skipped_running" }; }
      if (!opts.ignoreCooldown && job.last_error == null && job.finished_at != null && job.finished_at > cooldownCutoff) { this.db.exec("COMMIT"); return { outcome: "skipped_cooldown" }; }
      this.db.prepare(`UPDATE jobs SET status='running', worker_id=?, ownership_token=?, started_at=?, finished_at=NULL, lease_until=?, retry_at=NULL WHERE kind=? AND job_key=?`)
        .run(workerId, token, t, leaseUntil, JOB_PHASE2, PHASE2_KEY);
      this.db.exec("COMMIT");
      return { outcome: "claimed", ownershipToken: token, inputWatermark: job.input_watermark ?? 0 };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  heartbeatGlobalPhase2Job(token: string, leaseSeconds: number): boolean {
    return this.db.prepare(`UPDATE jobs SET lease_until=? WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`).run(now() + leaseSeconds, JOB_PHASE2, PHASE2_KEY, token).changes > 0;
  }

  markGlobalPhase2JobSucceeded(token: string, completedWatermark: number, selected: Stage1Output[]): boolean {
    const t = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ch = this.db.prepare(`UPDATE jobs SET status='done', finished_at=?, lease_until=NULL, retry_at=NULL, last_error=NULL, retry_remaining=?, last_success_watermark=?
        WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`).run(t, DEFAULT_RETRY_REMAINING, completedWatermark, JOB_PHASE2, PHASE2_KEY, token).changes;
      if (!ch) { this.db.exec("COMMIT"); return false; }
      this.db.prepare(`UPDATE stage1_outputs SET selected_for_phase2=0, selected_for_phase2_source_updated_at=NULL WHERE selected_for_phase2 != 0 OR selected_for_phase2_source_updated_at IS NOT NULL`).run();
      const st = this.db.prepare(`UPDATE stage1_outputs SET selected_for_phase2=1, selected_for_phase2_source_updated_at=? WHERE thread_id=? AND source_updated_at=?`);
      for (const o of selected) st.run(o.sourceUpdatedAt, o.threadId, o.sourceUpdatedAt);
      this.db.prepare(`UPDATE consolidation_progress SET max_thread_count=MAX(max_thread_count, ?)`).run(selected.length);
      this.db.exec("COMMIT");
      return true;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /** Clean workspace path: mark success but keep the previous selection snapshot untouched (Codex PR #19812). */
  markGlobalPhase2JobSucceededPreservingSelection(token: string, completedWatermark: number): boolean {
    return this.db.prepare(`UPDATE jobs SET status='done', finished_at=?, lease_until=NULL, retry_at=NULL, last_error=NULL, retry_remaining=?, last_success_watermark=?
      WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`).run(now(), DEFAULT_RETRY_REMAINING, completedWatermark, JOB_PHASE2, PHASE2_KEY, token).changes > 0;
  }

  markGlobalPhase2JobFailed(token: string, reason: string, retryDelaySeconds: number): boolean {
    reason = redact(reason);
    const t = now();
    const ch = this.db.prepare(`UPDATE jobs SET status='error', finished_at=?, lease_until=NULL, retry_at=?, retry_remaining=MAX(retry_remaining - 1, 0), last_error=?
      WHERE kind=? AND job_key=? AND status='running' AND ownership_token=?`).run(t, t + retryDelaySeconds, reason.slice(0, 500), JOB_PHASE2, PHASE2_KEY, token).changes;
    if (ch) return true;
    // Codex failed_if_unowned: never overwrite another owner's row or a terminal state.
    return this.db.prepare(`UPDATE jobs SET status='error', finished_at=?, lease_until=NULL, retry_at=?, retry_remaining=MAX(retry_remaining - 1, 0), last_error=?
      WHERE kind=? AND job_key=? AND status='running' AND (ownership_token=? OR ownership_token IS NULL)`).run(t, t + retryDelaySeconds, reason.slice(0, 500), JOB_PHASE2, PHASE2_KEY, token).changes > 0;
  }

  phase2Status() {
    return this.db.prepare(`SELECT status, started_at, finished_at, lease_until, retry_at, last_error, input_watermark, last_success_watermark FROM jobs WHERE kind=? AND job_key=?`).get(JOB_PHASE2, PHASE2_KEY) as any;
  }
  stage1Count(): number { return (this.db.prepare(`SELECT COUNT(*) AS n FROM stage1_outputs`).get() as any).n; }
  maxConsolidatedThreadCount(): number { return (this.db.prepare(`SELECT max_thread_count FROM consolidation_progress WHERE singleton=1`).get() as any).max_thread_count; }

  // ---------- settings ----------
  getSetting(key: string): string | undefined { return (this.db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as any)?.value; }
  setSetting(key: string, value: string) { this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value); }

  /** Serialize synchronous filesystem mutations with reset and all job claims. No async callbacks. */
  withMutation<T>(mutate: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = mutate(); this.db.exec("COMMIT"); return result; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  clearAll(clearFiles: () => void = () => {}) {
    this.withMutation(() => {
      // Fail closed even on expired leases: a detached writer may still be alive.
      const active = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='running'`).get() as any;
      if (active.n) throw new Error("reset refused: memory jobs are still running; finish or recover them first");
      clearFiles();
      this.db.exec("DELETE FROM stage1_outputs; DELETE FROM jobs; DELETE FROM threads; UPDATE consolidation_progress SET max_thread_count=0;");
    });
  }
}
