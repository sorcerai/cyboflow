/**
 * assertIdeaNotBusy / findIdeaBusyReason — the max-one-running-per-idea backstop
 * (idea sessions plan, Stage 1). Covers all three arms, the multi-idea-batch
 * exemption that keeps `runs.separatePlannerForIdea` working, and the fail-soft
 * paths (corrupt seed JSON, pre-migration schema).
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { assertIdeaNotBusy, findIdeaBusyReason, IdeaBusyError } from '../ideaBusy';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id            TEXT PRIMARY KEY,
      status        TEXT NOT NULL,
      seed_idea_id  TEXT,
      seed_idea_ids TEXT
    );
    CREATE TABLE sessions (
      id             TEXT PRIMARY KEY,
      status         TEXT,
      archived       INTEGER DEFAULT 0,
      home_idea_id   TEXT,
      origin_idea_id TEXT
    );
  `);
  return db;
}

function seedRun(
  db: Database.Database,
  id: string,
  status: string,
  seedIdeaId: string | null,
  seedIdeaIdsRaw: string | null = null,
): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, status, seed_idea_id, seed_idea_ids) VALUES (?, ?, ?, ?)`,
  ).run(id, status, seedIdeaId, seedIdeaIdsRaw);
}

function seedSession(
  db: Database.Database,
  id: string,
  fields: { status?: string; archived?: number; homeIdeaId?: string; originIdeaId?: string } = {},
): void {
  db.prepare(
    `INSERT INTO sessions (id, status, archived, home_idea_id, origin_idea_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.status ?? 'stopped',
    fields.archived ?? 0,
    fields.homeIdeaId ?? null,
    fields.originIdeaId ?? null,
  );
}

describe('findIdeaBusyReason — arm (a): non-terminal runs', () => {
  it('reports busy for a non-terminal run whose singular seed is the idea', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'running', 'idea-1');

    const reason = findIdeaBusyReason(dbAdapter(db), 'idea-1');

    expect(reason).not.toBeNull();
    expect(reason?.arm).toBe('run');
    expect(reason?.holderId).toBe('run-1');
    expect(reason?.message).toMatch(/run-1/);
    db.close();
  });

  it.each(['queued', 'starting', 'running', 'awaiting_review', 'awaiting_input', 'stuck', 'paused'])(
    "treats '%s' as non-terminal",
    (status) => {
      const db = buildDb();
      seedRun(db, 'run-1', status, 'idea-1');

      expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')?.arm).toBe('run');
      db.close();
    },
  );

  it.each(['completed', 'failed', 'canceled'])("treats '%s' as terminal (free)", (status) => {
    const db = buildDb();
    seedRun(db, 'run-1', status, 'idea-1');

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')).toBeNull();
    db.close();
  });

  it('reports busy for a ONE-element seed_idea_ids array (the single-idea path)', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'running', 'idea-1', JSON.stringify(['idea-1']));

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')?.holderId).toBe('run-1');
    db.close();
  });

  // The exemption that keeps runs.separatePlannerForIdea alive: a parked
  // multi-idea planner must not claim every idea it touches, or the "plan this
  // idea separately" fork could never launch.
  it('does NOT report busy for a MULTI-idea batch run, on any of its ideas', () => {
    const db = buildDb();
    seedRun(db, 'run-batch', 'awaiting_review', 'idea-1', JSON.stringify(['idea-1', 'idea-2', 'idea-3']));

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')).toBeNull();
    expect(findIdeaBusyReason(dbAdapter(db), 'idea-2')).toBeNull();
    expect(findIdeaBusyReason(dbAdapter(db), 'idea-3')).toBeNull();
    db.close();
  });

  it('ignores runs seeded with a DIFFERENT idea', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'running', 'idea-other');

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')).toBeNull();
    db.close();
  });

  it('tolerates a corrupt seed_idea_ids row — it falls back to the singular column', () => {
    const db = buildDb();
    seedRun(db, 'run-corrupt', 'running', null, '{not json');
    seedRun(db, 'run-live', 'running', 'idea-1');

    const reason = findIdeaBusyReason(dbAdapter(db), 'idea-1');

    expect(reason?.holderId).toBe('run-live');
    db.close();
  });

  it('a corrupt-JSON row whose singular column IS the idea still reports busy', () => {
    const db = buildDb();
    seedRun(db, 'run-corrupt', 'running', 'idea-1', '[[[');

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')?.holderId).toBe('run-corrupt');
    db.close();
  });

  it('falls back to the singular arm on a pre-061 schema (no seed_idea_ids column)', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, seed_idea_id TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, archived INTEGER, home_idea_id TEXT, origin_idea_id TEXT);
    `);
    db.prepare(`INSERT INTO workflow_runs (id, status, seed_idea_id) VALUES (?, ?, ?)`).run(
      'run-1',
      'running',
      'idea-1',
    );

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')?.holderId).toBe('run-1');
    db.close();
  });
});

describe('findIdeaBusyReason — arms (b)/(c): mid-turn sessions', () => {
  it("reports busy when the idea's HOME session is 'running'", () => {
    const db = buildDb();
    seedSession(db, 'sess-home', { status: 'running', homeIdeaId: 'idea-1' });

    const reason = findIdeaBusyReason(dbAdapter(db), 'idea-1');

    expect(reason?.arm).toBe('home-session');
    expect(reason?.holderId).toBe('sess-home');
    db.close();
  });

  it('reports busy when a session LAUNCHED from the idea is running', () => {
    const db = buildDb();
    seedSession(db, 'sess-child', { status: 'running', originIdeaId: 'idea-1' });

    const reason = findIdeaBusyReason(dbAdapter(db), 'idea-1');

    expect(reason?.arm).toBe('origin-session');
    expect(reason?.holderId).toBe('sess-child');
    db.close();
  });

  it('an IDLE home session does not make the idea busy', () => {
    const db = buildDb();
    seedSession(db, 'sess-home', { status: 'stopped', homeIdeaId: 'idea-1' });

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')).toBeNull();
    db.close();
  });

  it('an ARCHIVED running session does not make the idea busy', () => {
    const db = buildDb();
    seedSession(db, 'sess-home', { status: 'running', archived: 1, homeIdeaId: 'idea-1' });
    seedSession(db, 'sess-child', { status: 'running', archived: 1, originIdeaId: 'idea-1' });

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')).toBeNull();
    db.close();
  });

  it('the run arm wins over the session arms when both apply', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'running', 'idea-1');
    seedSession(db, 'sess-home', { status: 'running', homeIdeaId: 'idea-1' });

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')?.arm).toBe('run');
    db.close();
  });

  it('is fail-soft on a pre-111/112 schema (no idea columns on sessions)', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, seed_idea_id TEXT, seed_idea_ids TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, archived INTEGER);
    `);

    expect(findIdeaBusyReason(dbAdapter(db), 'idea-1')).toBeNull();
    db.close();
  });
});

describe('assertIdeaNotBusy', () => {
  it('is a no-op for a free idea', () => {
    const db = buildDb();

    expect(() => assertIdeaNotBusy(dbAdapter(db), 'idea-1')).not.toThrow();
    db.close();
  });

  it("throws a structured IdeaBusyError carrying code 'idea_busy'", () => {
    const db = buildDb();
    seedSession(db, 'sess-home', { status: 'running', homeIdeaId: 'idea-1' });

    try {
      assertIdeaNotBusy(dbAdapter(db), 'idea-1');
      expect.unreachable('assertIdeaNotBusy should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IdeaBusyError);
      const busy = err as IdeaBusyError;
      expect(busy.code).toBe('idea_busy');
      expect(busy.ideaId).toBe('idea-1');
      expect(busy.arm).toBe('home-session');
      expect(busy.holderId).toBe('sess-home');
    }
    db.close();
  });
});
