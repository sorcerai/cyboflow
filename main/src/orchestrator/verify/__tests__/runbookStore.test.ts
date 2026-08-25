/**
 * Unit tests for VerifyRunbookStore — the machine-local half of the runbook
 * contract (docs/proposals/verification-setup-flow.md §5.2 seam 1 + §5.3),
 * against a migration-backed in-memory DB (006 → 011 → 014 → 015 → 016 → 055 →
 * 056 → 095 → 096, extending capabilityStore.test.ts's chain through the new
 * file) so `verify_runbook_local` and the two `verification_requests` pin
 * columns come from the REAL migration 096, not a hand-rolled schema.
 *
 * The suite is organized around the store's ONE non-obvious invariant:
 * `'proven'` is a conjunction re-checked on every read, and the four ways it
 * can stop holding do NOT all mean the same thing.
 *   - portable hash / project input-hash / host fingerprint drift  → DEMOTE.
 *     Something the proof depended on changed; the green badge is now a lie.
 *   - the portable FILE is simply missing from the probed tree      → do NOT
 *     demote. That is the ordinary pre-merge state (the setup flow commits the
 *     runbook on its own branch), and demoting would make the proof evaporate
 *     the first time an unrelated lane asked.
 * Both answer `'unproven-draft'` to the caller; only one of them writes.
 *
 * IO is injected (a fake portable-file map + mutable input-hash/fingerprint
 * values), so these exercise the DB state machine without a filesystem.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VerifyRunbookStore,
  type VerifyRunbookStoreDeps,
} from '../runbookStore';
import { runbookPortableHash } from '../runbookHash';
import {
  parseVerifyRunbookV1,
  type VerifyRunbookV1,
} from '../../../../../shared/types/verifyRunbook';

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

// Mirrors capabilityStore.test.ts's chain — the minimal set that stands up
// workflow_runs + verification_requests (which 096 ALTERs).
const THROUGH_095 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
  '095_verify_failure_classes.sql',
];

function apply(db: Database.Database, files: string[]): void {
  for (const f of files) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
}

function seedProject(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
}

/** Full chain through 096 — the "you get it for free from real migrations" DB. */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_095, '096_verify_runbook_local.sql']);
  return db;
}

/** Same chain WITHOUT 096 — proves fail-soft behavior on a pre-096 DB. */
function buildPre096Db(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, THROUGH_095);
  return db;
}

const WORKTREE = '/tmp/wt-a';

/** The runbook the fake worktree "contains" unless a test rewrites it. */
function baseRunbook(): VerifyRunbookV1 {
  return {
    version: 1,
    modalities: {
      web: {
        build: ['pnpm build:renderer'],
        serve: { cmd: 'pnpm dev --port ${PORT}', readyWhen: { urlPath: '/' } },
        attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
      },
      'cdp-app': {
        serve: { cmd: 'electron . --remote-debugging-port=${PORT}', attach: 'cdp' },
        attestation: { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1' },
      },
    },
  };
}

/** Mutable fake IO — every knob a drift test needs to turn. */
interface Harness {
  store: VerifyRunbookStore;
  db: Database.Database;
  /** dirPath → portable file text (absent key ⇒ readPortableFile resolves null). */
  files: Map<string, string>;
  state: { inputHash: string | null; fingerprint: string };
  warnings: string[];
}

function makeHarness(db: Database.Database = buildDb()): Harness {
  const files = new Map<string, string>([[WORKTREE, JSON.stringify(baseRunbook())]]);
  const state = { inputHash: 'inputs-v1' as string | null, fingerprint: 'host-v1' };
  const warnings: string[] = [];
  const deps: VerifyRunbookStoreDeps = {
    readPortableFile: async (dirPath) => files.get(dirPath) ?? null,
    computeInputHash: async () => state.inputHash,
    hostFingerprint: async () => state.fingerprint,
    logger: {
      info: () => {},
      warn: (message) => {
        warnings.push(message);
      },
      error: () => {},
      debug: () => {},
    },
  };
  return { store: new VerifyRunbookStore(db, deps), db, files, state, warnings };
}

/** Read the persisted status directly — the assertion that separates demote from don't-demote. */
function persistedStatus(db: Database.Database, modality = 'web'): string | undefined {
  const row = db
    .prepare('SELECT status FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
    .get(modality) as { status: string } | undefined;
  return row?.status;
}

/** Drive the happy path to a proven record and return its pin (hash + version). */
async function proveWeb(h: Harness): Promise<{ hash: string; version: number }> {
  const registered = await h.store.registerDraft(1, WORKTREE, 'web');
  if ('error' in registered) throw new Error(`registerDraft failed: ${registered.error}`);
  const proven = h.store.markProven(1, 'web', registered.hash, registered.version, '{"sha":"deadbeef"}');
  expect(proven).toEqual({ ok: true });
  return registered;
}

describe('migration 096', () => {
  it('creates verify_runbook_local and adds the two verification_requests pin columns', () => {
    const db = buildDb();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verify_runbook_local'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('verify_runbook_local');

    const cols = (db.prepare('PRAGMA table_info(verification_requests)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('runbook_hash');
    expect(cols).toContain('runbook_local_version');
    db.close();
  });

  it('constrains status to the two persisted states (an absent row IS the absent state)', () => {
    const db = buildDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, version, status)
           VALUES (1, 'web', 'h', '{}', 1, 'absent')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe('VerifyRunbookStore lifecycle', () => {
  it('registerDraft persists an unproven draft at version 1 with the portable hash', async () => {
    const h = makeHarness();
    const result = await h.store.registerDraft(1, WORKTREE, 'web', '{"chromium":"/usr/bin/chromium"}');
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.version).toBe(1);
    expect(result.hash).toBe(runbookPortableHash(baseRunbook()));

    const row = h.db
      .prepare('SELECT * FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
      .get('web') as {
      status: string;
      portable_hash: string;
      portable_json: string;
      bindings_json: string | null;
      input_hash: string | null;
      host_fingerprint_json: string | null;
      proof_json: string | null;
    };
    expect(row.status).toBe('unproven-draft');
    expect(row.portable_hash).toBe(result.hash);
    expect(row.bindings_json).toBe('{"chromium":"/usr/bin/chromium"}');
    expect(row.input_hash).toBe('inputs-v1');
    expect(row.host_fingerprint_json).toBe('host-v1');
    expect(row.proof_json).toBeNull();
    // The stored JSON is the VALIDATED rebuild, not the raw file text.
    expect(parseVerifyRunbookV1(JSON.parse(row.portable_json)).ok).toBe(true);
    h.db.close();
  });

  it('status reports unproven-draft after registerDraft and proven after markProven', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');

    expect(h.store.markProven(1, 'web', pin.hash, pin.version, '{"sha":"deadbeef"}')).toEqual({ ok: true });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');

    const proof = h.db
      .prepare('SELECT proof_json FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
      .get('web') as { proof_json: string };
    expect(proof.proof_json).toBe('{"sha":"deadbeef"}');
    h.db.close();
  });

  it('tracks modalities independently — proving web says nothing about cdp-app', async () => {
    const h = makeHarness();
    await proveWeb(h);
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    // Declared in the file but never registered ⇒ derived, not proven.
    expect(await h.store.status(1, WORKTREE, 'cdp-app')).toBe('unproven-draft');
    // Not declared at all ⇒ absent.
    expect(await h.store.status(1, WORKTREE, 'native-screen')).toBe('absent');
    h.db.close();
  });

  it('re-registering a new revision bumps the version and drops back to unproven-draft', async () => {
    const h = makeHarness();
    const first = await proveWeb(h);
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');

    const edited = baseRunbook();
    edited.modalities.web = {
      build: ['pnpm build:renderer'],
      serve: { cmd: 'pnpm dev --port ${PORT} --host' },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    };
    h.files.set(WORKTREE, JSON.stringify(edited));

    const second = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in second) throw new Error(second.error);
    expect(second.version).toBe(first.version + 1);
    expect(second.hash).not.toBe(first.hash);
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    h.db.close();
  });
});

describe('VerifyRunbookStore drift → write-through demotion', () => {
  it('demotes when the portable file hashes to something else', async () => {
    const h = makeHarness();
    await proveWeb(h);

    const edited = baseRunbook();
    edited.modalities.web = {
      serve: { cmd: 'pnpm preview --port ${PORT}' },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    };
    h.files.set(WORKTREE, JSON.stringify(edited));

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('demotes when the portable file no longer parses', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.files.set(WORKTREE, '{ not json');

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('demotes on project input-hash drift (an edited dev script)', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.inputHash = 'inputs-v2';

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('demotes on host-fingerprint drift (chromium removed, a TCC grant revoked)', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.fingerprint = 'host-v2';

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('a demotion clears the proof but PRESERVES the record version (the pin stays resolvable)', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);
    h.state.fingerprint = 'host-v2';
    await h.store.status(1, WORKTREE, 'web');

    const row = h.db
      .prepare('SELECT version, proof_json, input_hash FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
      .get('web') as { version: number; proof_json: string | null; input_hash: string | null };
    expect(row.version).toBe(pin.version);
    expect(row.proof_json).toBeNull();
    // The provenance of what the proof WAS taken against is kept, for diagnosis.
    expect(row.input_hash).toBe('inputs-v1');

    // And the runner can still resolve the pin — it just sees an honest status.
    expect(h.store.getByHash(1, 'web', pin.hash)?.status).toBe('unproven-draft');
    h.db.close();
  });

  it('a re-proof after drift recovers proven', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);
    h.state.fingerprint = 'host-v2';
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');

    // Re-register against the new host, then re-prove.
    const re = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in re) throw new Error(re.error);
    expect(re.hash).toBe(pin.hash);
    expect(h.store.markProven(1, 'web', re.hash, re.version, '{"sha":"cafe"}')).toEqual({ ok: true });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    h.db.close();
  });
});

describe('VerifyRunbookStore non-demoting states', () => {
  it('an ABSENT file with a proven record reports unproven-draft WITHOUT demoting (pre-merge)', async () => {
    const h = makeHarness();
    await proveWeb(h);

    // A sibling lane's worktree legitimately lacks the not-yet-merged runbook.
    expect(await h.store.status(1, '/tmp/wt-b', 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBe('proven');

    // The tree that DOES carry it is still proven.
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    h.db.close();
  });

  it('an uncomputable input hash fails soft to absent WITHOUT demoting', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.inputHash = null;

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('absent');
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('no record + no file is absent; no record + a declaring file is unproven-draft', async () => {
    const h = makeHarness();
    expect(await h.store.status(1, '/tmp/empty', 'web')).toBe('absent');
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    // Nothing was written by either read.
    expect(persistedStatus(h.db)).toBeUndefined();
    h.db.close();
  });

  it('an already-unproven record answers unproven-draft without consulting drift', async () => {
    const h = makeHarness();
    await h.store.registerDraft(1, WORKTREE, 'web');
    h.state.inputHash = null; // would fail-soft to 'absent' on a PROVEN record
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    h.db.close();
  });
});

describe('VerifyRunbookStore.markProven CAS', () => {
  it('rejects a stale version as cas-conflict without flipping the record', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);

    expect(h.store.markProven(1, 'web', pin.hash, pin.version + 1, '{}')).toEqual({
      ok: false,
      error: 'cas-conflict',
    });
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('rejects a proof against a different portable hash as hash-mismatch', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);

    expect(h.store.markProven(1, 'web', 'not-the-hash', pin.version, '{}')).toEqual({
      ok: false,
      error: 'hash-mismatch',
    });
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('a registerDraft racing between the proof run and the flip invalidates the proof', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);

    // The human edits + re-registers while the proof run is in flight.
    const edited = baseRunbook();
    edited.modalities.web = {
      serve: { cmd: 'pnpm dev --port ${PORT} --strictPort false' },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    };
    h.files.set(WORKTREE, JSON.stringify(edited));
    await h.store.registerDraft(1, WORKTREE, 'web');

    expect(h.store.markProven(1, 'web', pin.hash, pin.version, '{}')).toEqual({
      ok: false,
      error: 'hash-mismatch',
    });
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('reports not-found when no record exists for the (project, modality)', () => {
    const h = makeHarness();
    expect(h.store.markProven(1, 'web', 'h', 1, '{}')).toEqual({ ok: false, error: 'not-found' });
    h.db.close();
  });
});

describe('VerifyRunbookStore.getByHash', () => {
  it('returns the pinned revision, its version, and its status on a hit', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);

    const found = h.store.getByHash(1, 'web', pin.hash);
    expect(found).not.toBeNull();
    expect(found?.version).toBe(pin.version);
    expect(found?.status).toBe('proven');
    expect(found?.runbook.modalities.web?.serve?.cmd).toBe('pnpm dev --port ${PORT}');
    h.db.close();
  });

  it('misses on an unknown hash, a different modality, and a different project', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);

    expect(h.store.getByHash(1, 'web', 'nope')).toBeNull();
    expect(h.store.getByHash(1, 'cdp-app', pin.hash)).toBeNull();
    expect(h.store.getByHash(2, 'web', pin.hash)).toBeNull();
    h.db.close();
  });

  it('misses (rather than throwing) when the stored portable JSON is corrupt', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);
    h.db
      .prepare('UPDATE verify_runbook_local SET portable_json = ? WHERE project_id = 1 AND modality = ?')
      .run('{ not json', 'web');

    expect(h.store.getByHash(1, 'web', pin.hash)).toBeNull();
    expect(h.warnings.some((w) => w.includes('not valid JSON'))).toBe(true);
    h.db.close();
  });
});

describe('VerifyRunbookStore.registerDraft rejections', () => {
  it('reports an absent portable file rather than persisting an empty record', async () => {
    const h = makeHarness();
    const result = await h.store.registerDraft(1, '/tmp/empty', 'web');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('no portable runbook found');
    expect(persistedStatus(h.db)).toBeUndefined();
    h.db.close();
  });

  it('reports malformed JSON and a failed contract validation with the offending path', async () => {
    const h = makeHarness();
    h.files.set(WORKTREE, '{ not json');
    const bad = await h.store.registerDraft(1, WORKTREE, 'web');
    expect('error' in bad && bad.error).toContain('not valid JSON');

    h.files.set(WORKTREE, JSON.stringify({ version: 1, modalities: { web: { serve: { cmd: 'x' } } } }));
    const invalid = await h.store.registerDraft(1, WORKTREE, 'web');
    expect('error' in invalid && invalid.error).toContain('modalities["web"].attestation: required');
    h.db.close();
  });

  it('refuses a modality the runbook never declared — including the §4-deferred mobile', async () => {
    const h = makeHarness();
    const notDeclared = await h.store.registerDraft(1, WORKTREE, 'native-screen');
    expect('error' in notDeclared && notDeclared.error).toContain('declares no "native-screen" modality');

    const mobile = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in mobile && mobile.error).toContain('declares no "mobile" modality');
    h.db.close();
  });
});

describe('VerifyRunbookStore fail-soft on a pre-096 DB', () => {
  it('degrades to absent / errors / null without throwing when the table is missing', async () => {
    const h = makeHarness(buildPre096Db());

    await expect(h.store.status(1, WORKTREE, 'web')).resolves.toBe('absent');

    const registered = await h.store.registerDraft(1, WORKTREE, 'web');
    expect('error' in registered).toBe(true);

    const proven = h.store.markProven(1, 'web', 'h', 1, '{}');
    expect(proven.ok).toBe(false);

    expect(h.store.getByHash(1, 'web', 'h')).toBeNull();
    h.db.close();
  });
});

/**
 * `statusDetail()` — the situation behind the three-valued answer
 * (lane-runbook-bootstrap.md §4).
 *
 * The suite above proves the ANSWERS are right. This one exists because three
 * distinct situations answer `'unproven-draft'` and two answer `'absent'`, and
 * a caller that intends to WRITE — a bootstrap that would `registerDraft` over
 * the singleton (project, modality) row — has to tell them apart. The load
 * bearing case is `'proven-file-absent-here'`: the record is live, proven, and
 * shared with every other tree, and a caller that read only the collapsed
 * `'unproven-draft'` would overwrite it.
 *
 * Every case also asserts that `status()` projects to the same answer, so the
 * gate's view and a writer's view cannot drift apart.
 */
describe('VerifyRunbookStore.statusDetail', () => {
  it('no record and no file is no-record', async () => {
    const h = makeHarness();
    expect(await h.store.statusDetail(1, '/tmp/empty', 'web')).toEqual({
      status: 'absent',
      reason: 'no-record',
    });
    expect(await h.store.status(1, '/tmp/empty', 'web')).toBe('absent');
    h.db.close();
  });

  it('no record but a declaring file in THIS tree is file-only, not no-record', async () => {
    const h = makeHarness();
    // A teammate's committed runbook, freshly cloned: adopt-and-prove, not
    // author-a-competing-one. Same 'unproven-draft' answer as a draft record.
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'file-only',
    });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBeUndefined();
    h.db.close();
  });

  it('an unproven record is draft', async () => {
    const h = makeHarness();
    await h.store.registerDraft(1, WORKTREE, 'web');
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'draft',
    });
    h.db.close();
  });

  it('a PROVEN record whose file this tree lacks is proven-file-absent-here, and stays proven', async () => {
    const h = makeHarness();
    await proveWeb(h);

    // THE case a writing caller must never act on — the pre-merge state. The
    // collapsed answer is indistinguishable from 'draft'; the reason is not.
    expect(await h.store.statusDetail(1, '/tmp/wt-b', 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'proven-file-absent-here',
    });
    expect(persistedStatus(h.db)).toBe('proven');

    // And the tree that carries it still reads proven, for both views.
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'proven',
      reason: 'proven',
    });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    h.db.close();
  });

  it.each([
    ['portable hash drift', (h: Harness) => h.files.set(WORKTREE, JSON.stringify({
      ...baseRunbook(),
      modalities: { ...baseRunbook().modalities, web: { ...baseRunbook().modalities.web!, build: ['pnpm build:other'] } },
    }))],
    ['project input drift', (h: Harness) => { h.state.inputHash = 'inputs-v2'; }],
    ['host fingerprint drift', (h: Harness) => { h.state.fingerprint = 'host-v2'; }],
    ['an unparseable portable file', (h: Harness) => h.files.set(WORKTREE, '{ not json')],
  ])('%s reports drifted and demotes the record', async (_label, mutate) => {
    const h = makeHarness();
    await proveWeb(h);
    mutate(h);

    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'drifted',
    });
    // 'drifted' is the one reason that has already spent the proof — unlike
    // 'proven-file-absent-here', there is nothing left here to protect.
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('an unobservable input hash is indeterminate, NOT no-record', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.inputHash = null;

    // Both collapse to 'absent', but "I could not look" is not "nothing is
    // there" — and the record is still proven underneath.
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'absent',
      reason: 'indeterminate',
    });
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('a pre-096 DB is indeterminate, NOT no-record', async () => {
    const h = makeHarness(buildPre096Db());
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'absent',
      reason: 'indeterminate',
    });
    h.db.close();
  });
});
