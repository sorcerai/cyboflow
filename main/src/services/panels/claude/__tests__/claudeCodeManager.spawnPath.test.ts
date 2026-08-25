/**
 * The SDK spawn's PATH (composeRunEnv → resolveSpawnPath).
 *
 * The SDK substrate used to hand the spawn a bare `...process.env`, so the child
 * `claude` process — and therefore every stdio MCP server it starts plus the
 * agent's own Bash tool — inherited whatever PATH Electron was born with. Under a
 * Finder/Dock launch that is `launchd`'s minimal `/usr/bin:/bin:/usr/sbin:/sbin`:
 * no homebrew, no `/usr/local/bin`, no nvm. Observed fallout (dev 0.1.34 smoke,
 * 2026-07-31): all three `npx`/`maestro`-command stdio servers silently absent
 * while all five http servers loaded, and `command -v node npx` empty inside the
 * agent's shell. Only the injected 'cyboflow' entry survived, because
 * composeMcpServers builds it with an ABSOLUTE interpreter.
 *
 * The interactive substrate never had the bug — AbstractCliManager.
 * getSystemEnvironment composes `getShellPath()` + the resolved node dir. This
 * suite pins the SDK substrate to that same composition, and pins the two
 * properties that make it safe: node dir FIRST, and fail-soft when the node path
 * cannot be resolved.
 *
 * Launching from a terminal masks the bug entirely (Electron inherits the
 * shell's PATH), which is why these assertions drive `process.env.PATH` to the
 * launchd value explicitly rather than trusting the ambient one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { makeProdLoggerSpy } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { ClaudeCodeManager } from '../claudeCodeManager';
import { findNodeExecutable } from '../../../../utils/nodeFinder';
import { getShellPath } from '../../../../utils/shellPath';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

/** The PATH `launchd` hands a Finder-launched app — the bug's repro condition. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** What getShellPath() recovers by sourcing the user's shell config. */
const SHELL_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const NODE_BIN = '/Users/test/.nvm/versions/node/v22.15.1/bin/node';
const NODE_DIR = '/Users/test/.nvm/versions/node/v22.15.1/bin';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* () {
    yield { type: 'result', subtype: 'success' } as unknown;
  }),
}));
vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => NODE_BIN),
}));
vi.mock('../../../../utils/shellPath', () => ({
  getShellPath: vi.fn(() => SHELL_PATH),
}));
vi.mock('../../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));
vi.mock('../../../../orchestrator/permissionRules', async (orig) => {
  const actual = await orig<typeof import('../../../../orchestrator/permissionRules')>();
  return { ...actual, loadMergedPermissionRules: vi.fn(() => ({ allow: [], deny: [], ask: [] })) };
});

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => ({ id: 'stub-session' })),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function makeConfigManager(): import('../../../configManager').ConfigManager {
  return {
    getSystemPromptAppend: vi.fn(() => undefined),
    getConfig: vi.fn(() => ({ verbose: false })),
    getDefaultAgentPermissionMode: vi.fn(() => 'default'),
  } as unknown as import('../../../configManager').ConfigManager;
}

class TestableClaudeCodeManager extends ClaudeCodeManager {
  protected override getInstalledPluginIds(): string[] {
    return [];
  }

  publicBuildSdkOptions(options: {
    panelId: string;
    sessionId: string;
    worktreePath: string;
    prompt: string;
  }): Promise<Options> {
    return (
      this as unknown as { buildSdkOptions(o: unknown): Promise<Options> }
    ).buildSdkOptions(options);
  }
}

describe('ClaudeCodeManager — SDK spawn PATH', () => {
  let db: Database.Database;
  let logger: ReturnType<typeof makeProdLoggerSpy>;
  let mgr: TestableClaudeCodeManager;
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    // Reproduce the Finder/Dock launch: the app process itself has the stripped
    // PATH. A terminal launch would hide the regression this suite guards.
    process.env.PATH = LAUNCHD_PATH;

    db = createTestDb({ includeSubstrate: true });
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
    logger = makeProdLoggerSpy();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new TestableClaudeCodeManager(
      createMockSessionManager(),
      logger as unknown as Logger,
      makeConfigManager(),
      db,
    );
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  function spawnEnv(opts: Options): Record<string, string | undefined> {
    return (opts.env ?? {}) as Record<string, string | undefined>;
  }

  async function build(): Promise<Options> {
    return mgr.publicBuildSdkOptions({
      panelId: 'panel-1',
      sessionId: 'sess-1',
      worktreePath: '/tmp/w',
      prompt: 'hi',
    });
  }

  it('composes the node dir FIRST, then the shell-resolved PATH', async () => {
    const env = spawnEnv(await build());
    expect(env.PATH).toBe(`${NODE_DIR}:${SHELL_PATH}`);
  });

  it('does NOT inherit the launchd PATH — the homebrew/nvm entries a Finder launch strips are restored', async () => {
    const env = spawnEnv(await build());
    expect(env.PATH).not.toBe(LAUNCHD_PATH);
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.PATH).toContain('/usr/local/bin');
    expect(env.PATH).toContain(NODE_DIR);
  });

  it('resolves the shell PATH and the node path exactly once each per spawn', async () => {
    await build();
    expect(vi.mocked(getShellPath)).toHaveBeenCalledTimes(1);
    // findNodeExecutable rides cachedNodePathPromise, shared with the injected
    // cyboflow MCP entry — one resolution serves both.
    expect(vi.mocked(findNodeExecutable)).toHaveBeenCalledTimes(1);
  });

  it('leaves the rest of the environment intact (process.env passthrough + the run keys)', async () => {
    process.env.CYBOFLOW_SPAWN_PATH_PROBE = 'preserved';
    try {
      const env = spawnEnv(await build());
      expect(env.CYBOFLOW_SPAWN_PATH_PROBE).toBe('preserved');
      expect(env.CYBOFLOW_RUN_ARTIFACTS_DIR).toBeTruthy();
    } finally {
      delete process.env.CYBOFLOW_SPAWN_PATH_PROBE;
    }
  });

  it('fail-soft: an unresolvable node path still applies the shell PATH and warns', async () => {
    vi.mocked(findNodeExecutable).mockRejectedValueOnce(new Error('no node on PATH'));
    const env = spawnEnv(await build());
    expect(env.PATH).toBe(SHELL_PATH);
    expect(env.PATH).not.toBe(LAUNCHD_PATH);
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.some((call) => String(call[0]).includes('spawn PATH')),
    ).toBe(true);
  });
});
