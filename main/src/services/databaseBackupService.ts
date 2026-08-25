/**
 * DatabaseBackupService — daily on-disk snapshots of `sessions.db` with a
 * 7-day retention window.
 *
 * WHY THIS EXISTS. `sessions.db` (better-sqlite3, WAL mode) is the ONLY copy
 * of a user's runs, backlog, and review queue. It can get corrupted — a hard
 * crash mid-write, a disk fault, a future migration bug — and there is
 * currently no recovery path except "hope for a Time Machine snapshot". This
 * service takes an independent, consistent daily snapshot so a corrupted live
 * database is never total loss.
 *
 * WHY HOURLY TICK + FILE-EXISTENCE GUARD, NOT A 24H TIMER. Electron apps
 * sleep and wake with the machine and may not be running at any particular
 * fixed hour — a `setInterval(24h)` armed at 11pm might never fire before the
 * user quits for the night, and after a wake from sleep Node's timers do not
 * reliably "catch up" a missed 24h boundary. Ticking hourly and asking
 * "does today's file already exist?" sidesteps both problems: the daily
 * backup happens on whatever hour the app happens to be running, and the
 * check is cheap (a single `existsSync`) on every tick after the day's
 * backup is already done. The backup FILES are the watermark — there is no
 * separate "last backed up" record to fall out of sync with reality.
 *
 * WHY `db.backup()`, NOT A FILE COPY. A plain copy of `sessions.db` in WAL
 * mode can capture a torn, inconsistent snapshot (the WAL file has pending
 * frames not yet checkpointed into the main file). better-sqlite3's
 * `Database#backup()` uses SQLite's online backup API — it produces a
 * complete, consistent snapshot regardless of WAL state, without blocking
 * writers, and runs on a background thread.
 *
 * WHY THE .partial RENAME. A crash or force-quit mid-backup must never leave
 * a file that looks like a finished backup — if it did, the next day's tick
 * would treat that day as already covered and silently skip it, and a
 * consumer of the backup would open a truncated database. Writing to
 * `<target>.partial` and only `renameSync`-ing to the final name once
 * `db.backup()` resolves means the file at the final name is atomically
 * either absent or complete.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { LoggerLike } from '../orchestrator/types';

/** How often the tick runs. Cheap once today's backup already exists (see file doc). */
export const DATABASE_BACKUP_TICK_INTERVAL_MS = 60 * 60 * 1000;

/** How many daily backup files to keep. */
export const DATABASE_BACKUP_RETAIN_COUNT = 7;

/** Matches a finished daily backup filename exactly — never a `.partial`. */
const BACKUP_FILENAME_RE = /^sessions-\d{4}-\d{2}-\d{2}\.db$/;

export interface DatabaseBackupServiceOptions {
  /** The live better-sqlite3 connection to snapshot. */
  db: Database.Database;
  /** Absolute directory backups are written to. Created recursively as needed. */
  backupsDir: string;
  /** Structured logger. Required — this service's only output is log lines. */
  logger: LoggerLike;
  /** Current wall-clock time. Injectable for deterministic tests. */
  now?: () => Date;
  /** Tick interval override. Defaults to {@link DATABASE_BACKUP_TICK_INTERVAL_MS}. */
  intervalMs?: number;
}

/** Timer handle carrying Node's `unref`, so this service can never keep the process alive. */
interface UnreffableTimer {
  unref?: () => void;
}

/** Zero-padded local-time `YYYY-MM-DD` for `date` — LOCAL day, not UTC. */
function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Shape an arbitrary caught value into a `LoggerLike`-compatible context. */
function errorContext(err: unknown): Record<string, unknown> {
  return { error: err instanceof Error ? err.message : String(err) };
}

export class DatabaseBackupService {
  private readonly db: Database.Database;
  private readonly backupsDir: string;
  private readonly logger: LoggerLike;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(opts: DatabaseBackupServiceOptions) {
    this.db = opts.db;
    this.backupsDir = opts.backupsDir;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => new Date());
    this.intervalMs = opts.intervalMs ?? DATABASE_BACKUP_TICK_INTERVAL_MS;
  }

  /**
   * Fire one tick immediately, then a recurring tick every {@link intervalMs}.
   * The interval is `unref`'d — this service must never be the reason the
   * app's event loop stays alive. Idempotent: a second call while already
   * running is a no-op.
   */
  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    const timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    (timer as unknown as UnreffableTimer).unref?.();
    this.timer = timer;
  }

  /** Cancel the recurring tick. Idempotent. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run one backup pass. Public (not just interval-private) so tests can
   * drive it directly without waiting on the timer. Fail-soft throughout:
   * any error is logged and this returns, never throws — a backup failure
   * must never take down the app that is trying to protect itself.
   */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const today = localDateStamp(this.now());
      const targetPath = path.join(this.backupsDir, `sessions-${today}.db`);

      if (fs.existsSync(targetPath)) return;

      fs.mkdirSync(this.backupsDir, { recursive: true });

      // Sweep stale partials. Only one tick runs at a time in-process
      // (inFlight guard) and the app itself holds a single-instance lock, so
      // any `.partial` present at tick start is a dead leftover from a crash
      // mid-backup, never a concurrent in-progress write.
      this.sweepStalePartials();

      const partialPath = `${targetPath}.partial`;
      try {
        await this.db.backup(partialPath);
        fs.renameSync(partialPath, targetPath);
        this.logger.info(`[DatabaseBackup] wrote daily backup to ${targetPath}`);
      } catch (err) {
        try {
          if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
        } catch {
          // best-effort cleanup only
        }
        this.logger.error('[DatabaseBackup] backup failed', errorContext(err));
        return;
      }

      this.prune();
    } catch (err) {
      this.logger.error('[DatabaseBackup] tick failed', errorContext(err));
    } finally {
      this.inFlight = false;
    }
  }

  /** Delete any leftover `*.partial` files in {@link backupsDir}. */
  private sweepStalePartials(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.backupsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.partial')) continue;
      try {
        fs.unlinkSync(path.join(this.backupsDir, entry));
      } catch (err) {
        this.logger.error(`[DatabaseBackup] failed to sweep stale partial ${entry}`, errorContext(err));
      }
    }
  }

  /** Keep the {@link DATABASE_BACKUP_RETAIN_COUNT} newest daily backups; delete the rest. */
  private prune(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.backupsDir);
    } catch (err) {
      this.logger.error('[DatabaseBackup] failed to list backups dir for pruning', errorContext(err));
      return;
    }

    // ISO date filenames sort correctly lexicographically — descending here
    // puts the newest first.
    const backups = entries.filter((f) => BACKUP_FILENAME_RE.test(f)).sort().reverse();

    for (const stale of backups.slice(DATABASE_BACKUP_RETAIN_COUNT)) {
      // The backup inherits WAL journal mode, so an external tool that opened
      // it (e.g. sqlite3 for a restore dry-run) leaves `-wal`/`-shm` sidecars
      // beside it — prune those with their backup or they orphan forever.
      for (const suffix of ['', '-wal', '-shm']) {
        const target = path.join(this.backupsDir, `${stale}${suffix}`);
        try {
          if (suffix === '' || fs.existsSync(target)) fs.unlinkSync(target);
        } catch (err) {
          this.logger.error(`[DatabaseBackup] failed to prune stale backup ${stale}${suffix}`, errorContext(err));
        }
      }
    }
  }
}
