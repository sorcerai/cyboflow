/**
 * validateIdeaSessionLink — the idea-liveness gate for the open-idea-session
 * door. Exercises every rejection plus the two ACCEPT cases that distinguish it
 * from its design-mode sibling: a live idea, and a DECOMPOSED one (whose home
 * stays reopenable even though its board card is gone).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { validateIdeaSessionLink } from '../ideaSessionValidation';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ideas (
      id            TEXT PRIMARY KEY,
      project_id    INTEGER NOT NULL,
      decomposed_at TEXT,
      archived_at   TEXT
    )
  `);
  return db;
}

describe('validateIdeaSessionLink', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
  });

  afterEach(() => {
    db.close();
  });

  function insertIdea(id: string, projectId: number, decomposedAt: string | null, archivedAt: string | null): void {
    db.prepare(`INSERT INTO ideas (id, project_id, decomposed_at, archived_at) VALUES (?, ?, ?, ?)`).run(
      id,
      projectId,
      decomposedAt,
      archivedAt,
    );
  }

  it("rejects with 'not_found' when no idea row exists for the id", () => {
    const result = validateIdeaSessionLink(db, 'idea-missing', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.error).toMatch(/idea-missing/);
    }
  });

  // Epics/tasks live in their own tables, so an epic id is simply absent here —
  // existence in `ideas` IS the type check.
  it("rejects an epic/task id with 'not_found' (type check by table)", () => {
    insertIdea('idea-1', 42, null, null);

    const result = validateIdeaSessionLink(db, 'task-1', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it("rejects with 'wrong_project' when the idea belongs to another project", () => {
    insertIdea('idea-1', 999, null, null);

    const result = validateIdeaSessionLink(db, 'idea-1', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('wrong_project');
      expect(result.error).toMatch(/different project/i);
    }
  });

  it("rejects with 'archived' when the idea is archived", () => {
    insertIdea('idea-1', 42, null, '2026-07-01T00:00:00Z');

    const result = validateIdeaSessionLink(db, 'idea-1', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('archived');
      expect(result.error).toMatch(/archived/i);
    }
  });

  it('accepts a live idea owned by the project', () => {
    insertIdea('idea-1', 42, null, null);

    expect(validateIdeaSessionLink(db, 'idea-1', 42)).toEqual({ ok: true });
  });

  // The ONE deliberate divergence from validateDesignIdeaLink, which rejects
  // decomposed ideas: an idea's home is a place to keep talking about it.
  it('ACCEPTS a decomposed idea (unlike the design gate)', () => {
    insertIdea('idea-1', 42, '2026-07-01T00:00:00Z', null);

    expect(validateIdeaSessionLink(db, 'idea-1', 42)).toEqual({ ok: true });
  });

  it('rejects a decomposed AND archived idea (archived still wins)', () => {
    insertIdea('idea-1', 42, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z');

    const result = validateIdeaSessionLink(db, 'idea-1', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('archived');
  });
});
