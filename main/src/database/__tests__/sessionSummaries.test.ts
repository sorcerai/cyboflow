/**
 * Behavioral tests for the session-summary persistence layer on
 * DatabaseService (main/src/database/database.ts): getSessionSummary,
 * upsertSessionSummary, appendSessionSummaryEntries,
 * listSessionSummaryEntries, getConversationMessagesAfter, and the
 * transactional persistSessionSummaryResult (migration 083,
 * docs/proposals/session-summary-plan.md §4).
 *
 * Uses a REAL DatabaseService against a temp-file DB and a full initialize()
 * (folderCrud.test.ts / sessionUpdatedAtSemantics.test.ts pattern) so the
 * session_summaries / session_summary_entries tables and the sessions FK
 * (ON DELETE CASCADE) are exactly as they ship.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const SEEDED_UPDATED_AT = '2026-01-01 00:00:00';

let tmpDir: string;
let db: DatabaseService;
let projectId: number;

function createSession(id: string): void {
  db.createSession({
    id,
    name: id,
    initial_prompt: 'p',
    worktree_name: `w-${id}`,
    worktree_path: join(tmpDir, `w-${id}`),
    project_id: projectId,
  });
  // Pin updated_at to a known past instant so any activity-clock bump shows
  // (sessionUpdatedAtSemantics.test.ts pattern).
  db.getDb()
    .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run(SEEDED_UPDATED_AT, id);
}

function sessionUpdatedAt(id: string): string {
  return (
    db.getDb().prepare('SELECT updated_at FROM sessions WHERE id = ?').get(id) as {
      updated_at: string;
    }
  ).updated_at;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-session-summaries-'));
  db = new DatabaseService(join(tmpDir, 'test.db'));
  db.initialize();
  projectId = db.createProject('Proj', join(tmpDir, 'repo')).id;
});

afterEach(() => {
  db.getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('session summary CRUD round-trip', () => {
  it('getSessionSummary returns undefined before any upsert', () => {
    createSession('s1');
    expect(db.getSessionSummary('s1')).toBeUndefined();
  });

  it('upsertSessionSummary creates a row readable via getSessionSummary', () => {
    createSession('s1');
    db.upsertSessionSummary({ sessionId: 's1', summary: 'Fixed the login bug.', lastTurnId: 5, costUsdDelta: 0.001 });

    const row = db.getSessionSummary('s1');
    expect(row).toBeDefined();
    expect(row?.session_id).toBe('s1');
    expect(row?.summary).toBe('Fixed the login bug.');
    expect(row?.last_turn_id).toBe(5);
    expect(row?.calls_count).toBe(1);
    expect(row?.cost_usd_total).toBeCloseTo(0.001);
  });
});

describe('upsertSessionSummary accumulation', () => {
  it('replaces summary/last_turn_id but accumulates calls_count and cost_usd_total', () => {
    createSession('s1');
    db.upsertSessionSummary({ sessionId: 's1', summary: 'First pass.', lastTurnId: 3, costUsdDelta: 0.002 });
    db.upsertSessionSummary({ sessionId: 's1', summary: 'Second pass, more context.', lastTurnId: 9, costUsdDelta: 0.004 });

    const row = db.getSessionSummary('s1');
    expect(row?.summary).toBe('Second pass, more context.');
    expect(row?.last_turn_id).toBe(9);
    expect(row?.calls_count).toBe(2);
    expect(row?.cost_usd_total).toBeCloseTo(0.006);
  });
});

describe('session_summary_entries append + ordered listing', () => {
  it('appendSessionSummaryEntries adds rows, listed oldest-first by id', () => {
    createSession('s1');
    db.appendSessionSummaryEntries('s1', ['Debugged the parser.']);
    db.appendSessionSummaryEntries('s1', ['Wrote the migration.', 'Fixed a flaky test.']);

    const entries = db.listSessionSummaryEntries('s1');
    expect(entries.map((e) => e.entry)).toEqual([
      'Debugged the parser.',
      'Wrote the migration.',
      'Fixed a flaky test.',
    ]);
    // Ascending id order.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].id).toBeGreaterThan(entries[i - 1].id);
    }
  });

  it('appendSessionSummaryEntries with an empty array is a no-op', () => {
    createSession('s1');
    db.appendSessionSummaryEntries('s1', []);
    expect(db.listSessionSummaryEntries('s1')).toEqual([]);
  });
});

describe('getConversationMessagesAfter', () => {
  it('filters by id > afterId and orders ascending by id', () => {
    createSession('s1');
    db.addConversationMessage('s1', 'user', 'hello');
    db.addConversationMessage('s1', 'assistant', 'hi there');
    db.addConversationMessage('s1', 'user', 'do the thing');
    db.addConversationMessage('s1', 'assistant', 'done');

    const all = db.getConversationMessages('s1');
    expect(all).toHaveLength(4);

    const afterFirst = db.getConversationMessagesAfter('s1', all[0].id);
    expect(afterFirst.map((m) => m.content)).toEqual(['hi there', 'do the thing', 'done']);
    for (let i = 1; i < afterFirst.length; i++) {
      expect(afterFirst[i].id).toBeGreaterThan(afterFirst[i - 1].id);
    }

    // Watermark at the last id: empty delta.
    const afterLast = db.getConversationMessagesAfter('s1', all[all.length - 1].id);
    expect(afterLast).toEqual([]);
  });

  it('scopes to the given session only', () => {
    createSession('s1');
    createSession('s2');
    db.addConversationMessage('s1', 'user', 'from s1');
    db.addConversationMessage('s2', 'user', 'from s2');

    const afterZeroS1 = db.getConversationMessagesAfter('s1', 0);
    expect(afterZeroS1.map((m) => m.content)).toEqual(['from s1']);
  });
});

describe('insertTranscriptConversationMessage (migration 084 PTY ingest)', () => {
  it('inserts with an EXPLICIT timestamp and source_uuid, returning true', () => {
    createSession('s1');
    const ts = '2026-03-04T12:00:00.000Z';
    const inserted = db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'assistant',
      content: 'hello from the transcript',
      timestamp: ts,
      sourceUuid: 'uuid-a',
    });
    expect(inserted).toBe(true);

    const row = db
      .getDb()
      .prepare('SELECT message_type, content, timestamp, source_uuid FROM conversation_messages WHERE session_id = ?')
      .get('s1') as { message_type: string; content: string; timestamp: string; source_uuid: string };
    expect(row.message_type).toBe('assistant');
    expect(row.content).toBe('hello from the transcript');
    expect(row.timestamp).toBe(ts); // explicit, NOT CURRENT_TIMESTAMP
    expect(row.source_uuid).toBe('uuid-a');
  });

  it('dedupes on (session_id, source_uuid) — a re-inserted uuid returns false and adds no row', () => {
    createSession('s1');
    const first = db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'user',
      content: 'first',
      timestamp: '2026-03-04T12:00:00.000Z',
      sourceUuid: 'dupe',
    });
    const second = db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'user',
      content: 'first again (ignored)',
      timestamp: '2026-03-04T12:05:00.000Z',
      sourceUuid: 'dupe',
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(db.getConversationMessageCount('s1')).toBe(1);
  });

  it('scopes the dedupe per-session — the same uuid in another session still inserts', () => {
    createSession('s1');
    createSession('s2');
    expect(
      db.insertTranscriptConversationMessage({
        sessionId: 's1',
        messageType: 'user',
        content: 'in s1',
        timestamp: '2026-03-04T12:00:00.000Z',
        sourceUuid: 'shared-uuid',
      }),
    ).toBe(true);
    expect(
      db.insertTranscriptConversationMessage({
        sessionId: 's2',
        messageType: 'user',
        content: 'in s2',
        timestamp: '2026-03-04T12:00:00.000Z',
        sourceUuid: 'shared-uuid',
      }),
    ).toBe(true);
    expect(db.getConversationMessageCount('s1')).toBe(1);
    expect(db.getConversationMessageCount('s2')).toBe(1);
  });

  it('does not bump sessions.updated_at (activity-clock contract)', () => {
    createSession('s1');
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);
    db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'assistant',
      content: 'x',
      timestamp: '2026-03-04T12:00:00.000Z',
      sourceUuid: 'u',
    });
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);
  });

  it('ingested rows participate in the getConversationMessagesAfter watermark read', () => {
    createSession('s1');
    db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'user',
      content: 'u1',
      timestamp: '2026-03-04T12:00:00.000Z',
      sourceUuid: 'u1',
    });
    db.insertTranscriptConversationMessage({
      sessionId: 's1',
      messageType: 'assistant',
      content: 'a1',
      timestamp: '2026-03-04T12:00:01.000Z',
      sourceUuid: 'a1',
    });
    const delta = db.getConversationMessagesAfter('s1', 0);
    expect(delta.map((m) => m.content)).toEqual(['u1', 'a1']);
  });
});

describe('persistSessionSummaryResult transactionality', () => {
  it('writes the upsert + entries atomically and returns true when the session exists', () => {
    createSession('s1');
    const ok = db.persistSessionSummaryResult({
      sessionId: 's1',
      summary: 'Refactored the parser module.',
      lastTurnId: 12,
      costUsdDelta: 0.0015,
      entries: ['Refactored the parser module.'],
    });

    expect(ok).toBe(true);
    const row = db.getSessionSummary('s1');
    expect(row?.summary).toBe('Refactored the parser module.');
    expect(row?.last_turn_id).toBe(12);
    expect(row?.calls_count).toBe(1);
    expect(db.listSessionSummaryEntries('s1').map((e) => e.entry)).toEqual(['Refactored the parser module.']);
  });

  it('returns false and writes nothing when the session does not exist', () => {
    const ok = db.persistSessionSummaryResult({
      sessionId: 'does-not-exist',
      summary: 'Should never land.',
      lastTurnId: 1,
      costUsdDelta: 0.001,
      entries: ['Should never land.'],
    });

    expect(ok).toBe(false);
    expect(db.getSessionSummary('does-not-exist')).toBeUndefined();
    expect(db.listSessionSummaryEntries('does-not-exist')).toEqual([]);
  });
});

describe('ON DELETE CASCADE from sessions', () => {
  it('removes both the summary row and its entries when the session is deleted', () => {
    createSession('s1');
    db.upsertSessionSummary({ sessionId: 's1', summary: 'Some summary.', lastTurnId: 4, costUsdDelta: 0.001 });
    db.appendSessionSummaryEntries('s1', ['A sitting happened.']);

    expect(db.getSessionSummary('s1')).toBeDefined();
    expect(db.listSessionSummaryEntries('s1')).toHaveLength(1);

    db.getDb().prepare('DELETE FROM sessions WHERE id = ?').run('s1');

    expect(db.getSessionSummary('s1')).toBeUndefined();
    expect(db.listSessionSummaryEntries('s1')).toEqual([]);
  });
});

describe('activity-clock guard', () => {
  it('upsertSessionSummary and persistSessionSummaryResult do not bump sessions.updated_at', () => {
    createSession('s1');
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);

    db.upsertSessionSummary({ sessionId: 's1', summary: 'A summary.', lastTurnId: 2, costUsdDelta: 0.001 });
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);

    db.persistSessionSummaryResult({
      sessionId: 's1',
      summary: 'Another summary.',
      lastTurnId: 6,
      costUsdDelta: 0.001,
      entries: ['A sitting happened.'],
    });
    expect(sessionUpdatedAt('s1')).toBe(SEEDED_UPDATED_AT);
  });
});
