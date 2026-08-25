/**
 * Mocked-SDK integration coverage for idea-session spawn config
 * (idea-session.md + the per-spawn "Linked idea" line) alongside design-session
 * parity — drives the real `spawnClaudeCode` -> `buildSdkOptions` seam end to
 * end (not a single private method in isolation) so a regression in the
 * design-branch-first ordering, the tools narrowing, or the mcpScope omission
 * would show up here exactly as it would in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createModuleFakeSdk,
  scenario,
  type FakeQueryParams,
} from '../../../../test/fakes/fakeSdk';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';
import type { SessionManager } from '../../../sessionManager';

const fakeSdk = createModuleFakeSdk();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: FakeQueryParams) => fakeSdk.query(params),
}));

vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));

vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));

interface DbSessionStub {
  id: string;
  substrate: 'sdk';
  permission_mode: 'ignore';
  run_id: null;
  chat_run_id: null;
  skip_continue_next: false;
  design_idea_id?: string | null;
  home_idea_id?: string | null;
}

function makeSessionManager(session: DbSessionStub): SessionManager {
  return {
    getDbSession: vi.fn(() => session),
    getPanelClaudeSessionId: vi.fn((panelId: string) => `claude-${panelId}`),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
    addPanelOutput: vi.fn(),
  } as unknown as SessionManager;
}

describe('idea-session spawn config (mocked-SDK integration)', () => {
  let db: Database.Database;

  beforeEach(() => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    fakeSdk.reset();
    db = createTestDb();
    // Minimal `ideas` table (the real schema's columns, no migration replay
    // needed) so resolveLinkedIdeaLine's `SELECT ref, title FROM ideas WHERE
    // id = ?` has a real row to resolve against.
    db.exec(`
      CREATE TABLE ideas (
        id    TEXT PRIMARY KEY,
        ref   TEXT NOT NULL,
        title TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO ideas (id, ref, title) VALUES (?, ?, ?)').run(
      'idea-1',
      'IDEA-009',
      'Idea Session Concept',
    );
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    fakeSdk.setScenario(
      scenario().systemInit({ sessionId: 'sdk-session' }).assistantText('reply').resultSuccess(),
    );
  });

  afterEach(async () => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    delete process.env.CYBOFLOW_DISABLE_WARM_SDK;
    db.close();
    vi.clearAllMocks();
  });

  it('spawns an idea session with Read/Grep/Glob tools, the idea-session prompt + linked-idea line, and no mcpScope', async () => {
    const sessionManager = makeSessionManager({
      id: 'session-idea',
      substrate: 'sdk',
      permission_mode: 'ignore',
      run_id: null,
      chat_run_id: null,
      skip_continue_next: false,
      home_idea_id: 'idea-1',
    });
    const mgr = new ClaudeCodeManager(sessionManager, undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/idea-session-test.sock');

    await mgr.spawnClaudeCode('panel-idea', 'session-idea', '/tmp/idea-worktree', 'hello');

    expect(fakeSdk.calls).toHaveLength(1);
    const opts = fakeSdk.calls[0];
    expect(opts.tools).toEqual(['Read', 'Grep', 'Glob']);

    const systemPrompt = opts.systemPrompt as { append?: string } | undefined;
    expect(systemPrompt?.append).toContain('Idea agent');
    expect(systemPrompt?.append).toContain('Linked idea: IDEA-009 (idea-1) — Idea Session Concept');

    const cyboflow = opts.mcpServers?.['cyboflow'] as { env?: Record<string, string> } | undefined;
    expect(cyboflow).toBeDefined();
    expect(cyboflow?.env?.CYBOFLOW_MCP_SCOPE).toBeUndefined();

    await mgr.killProcess('panel-idea').catch(() => {});
  });

  it('leaves a design session unchanged: mcpScope design, no tools narrowing', async () => {
    const sessionManager = makeSessionManager({
      id: 'session-design',
      substrate: 'sdk',
      permission_mode: 'ignore',
      run_id: null,
      chat_run_id: null,
      skip_continue_next: false,
      design_idea_id: 'idea-1',
    });
    const mgr = new ClaudeCodeManager(sessionManager, undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/design-session-test.sock');

    await mgr.spawnClaudeCode('panel-design', 'session-design', '/tmp/design-worktree', 'hello');

    expect(fakeSdk.calls).toHaveLength(1);
    const opts = fakeSdk.calls[0];
    expect(opts.tools).toBeUndefined();

    const cyboflow = opts.mcpServers?.['cyboflow'] as { env?: Record<string, string> } | undefined;
    expect(cyboflow?.env?.CYBOFLOW_MCP_SCOPE).toBe('design');

    await mgr.killProcess('panel-design').catch(() => {});
  });
});
