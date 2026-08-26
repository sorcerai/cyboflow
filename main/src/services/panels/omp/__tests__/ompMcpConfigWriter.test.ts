import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildOmpCyboflowMcpServerEntry,
  ompMcpConfigPath,
  writeOmpMcpConfig,
} from '../ompMcpConfigWriter';

const NODE_PATH = '/usr/local/bin/node';
const BRIDGE_PATH = '/Applications/Cyboflow.app/Contents/Resources/cyboflowMcpServer.js';

let worktree: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-mcp-writer-test-'));
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
});

describe('buildOmpCyboflowMcpServerEntry', () => {
  it('uses bare-name env values (OMP pre-connect resolution) and disables the MCP timeout', () => {
    expect(buildOmpCyboflowMcpServerEntry(NODE_PATH, BRIDGE_PATH)).toEqual({
      command: NODE_PATH,
      args: [BRIDGE_PATH],
      env: {
        CYBOFLOW_RUN_ID: 'CYBOFLOW_RUN_ID',
        CYBOFLOW_ORCH_SOCKET: 'CYBOFLOW_ORCH_SOCKET',
      },
      timeout: 0,
    });
  });

  it('bakes in the literal ELECTRON_RUN_AS_NODE guard when node resolves to the Electron binary', () => {
    const entry = buildOmpCyboflowMcpServerEntry(process.execPath, BRIDGE_PATH);
    expect(entry.env.ELECTRON_RUN_AS_NODE).toBe('1');
    // The run-id/socket entries stay bare-name even when the guard fires.
    expect(entry.env.CYBOFLOW_RUN_ID).toBe('CYBOFLOW_RUN_ID');
  });
});

describe('writeOmpMcpConfig', () => {
  it('creates .omp/mcp.json with exactly the cyboflow server on a fresh worktree', () => {
    const result = writeOmpMcpConfig({
      worktreeRoot: worktree,
      nodeExecutablePath: NODE_PATH,
      bridgeScriptPath: BRIDGE_PATH,
    });

    expect(result).toEqual({ configPath: ompMcpConfigPath(worktree), wrote: true });
    const written = JSON.parse(fs.readFileSync(result.configPath, 'utf-8'));
    expect(written).toEqual({
      mcpServers: {
        cyboflow: buildOmpCyboflowMcpServerEntry(NODE_PATH, BRIDGE_PATH),
      },
    });
  });

  it('is idempotent: a second identical call does not rewrite the file', () => {
    const first = writeOmpMcpConfig({
      worktreeRoot: worktree,
      nodeExecutablePath: NODE_PATH,
      bridgeScriptPath: BRIDGE_PATH,
    });
    const before = fs.statSync(first.configPath).mtimeMs;

    const second = writeOmpMcpConfig({
      worktreeRoot: worktree,
      nodeExecutablePath: NODE_PATH,
      bridgeScriptPath: BRIDGE_PATH,
    });

    expect(second.wrote).toBe(false);
    expect(fs.statSync(first.configPath).mtimeMs).toBe(before);
  });

  it('rewrites when the resolved node/bridge path actually changes', () => {
    writeOmpMcpConfig({ worktreeRoot: worktree, nodeExecutablePath: NODE_PATH, bridgeScriptPath: BRIDGE_PATH });

    const result = writeOmpMcpConfig({
      worktreeRoot: worktree,
      nodeExecutablePath: '/opt/homebrew/bin/node',
      bridgeScriptPath: BRIDGE_PATH,
    });

    expect(result.wrote).toBe(true);
    const written = JSON.parse(fs.readFileSync(result.configPath, 'utf-8'));
    expect(written.mcpServers.cyboflow.command).toBe('/opt/homebrew/bin/node');
  });

  it('MERGES into an existing file: preserves other servers and top-level keys, owns only the cyboflow key', () => {
    const configPath = ompMcpConfigPath(worktree);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: 'https://example.test/mcp-schema.json',
          mcpServers: {
            filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
          },
          disabledServers: ['github'],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = writeOmpMcpConfig({
      worktreeRoot: worktree,
      nodeExecutablePath: NODE_PATH,
      bridgeScriptPath: BRIDGE_PATH,
    });

    expect(result.wrote).toBe(true);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.$schema).toBe('https://example.test/mcp-schema.json');
    expect(written.disabledServers).toEqual(['github']);
    expect(written.mcpServers.filesystem).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
    });
    expect(written.mcpServers.cyboflow).toEqual(buildOmpCyboflowMcpServerEntry(NODE_PATH, BRIDGE_PATH));
  });

  it('refuses to clobber malformed existing JSON — leaves the file untouched', () => {
    const configPath = ompMcpConfigPath(worktree);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ not valid json', 'utf-8');

    const result = writeOmpMcpConfig({
      worktreeRoot: worktree,
      nodeExecutablePath: NODE_PATH,
      bridgeScriptPath: BRIDGE_PATH,
    });

    expect(result.wrote).toBe(false);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{ not valid json');
  });

  it('excludes .omp/ from the worktree-local git exclude (never the tracked .gitignore)', () => {
    execFileSync('git', ['init', '-q'], { cwd: worktree });

    writeOmpMcpConfig({ worktreeRoot: worktree, nodeExecutablePath: NODE_PATH, bridgeScriptPath: BRIDGE_PATH });

    const excludePath = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim();
    const resolvedExcludePath = path.isAbsolute(excludePath) ? excludePath : path.join(worktree, excludePath);
    const exclude = fs.readFileSync(resolvedExcludePath, 'utf-8');
    expect(exclude).toContain('.omp/');

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' });
    expect(status).toBe('');

    // No tracked .gitignore should have been touched/created.
    expect(fs.existsSync(path.join(worktree, '.gitignore'))).toBe(false);
  });

  it('is fail-soft (still writes the config) when the worktree is not a git repo', () => {
    const result = writeOmpMcpConfig({
      worktreeRoot: worktree,
      nodeExecutablePath: NODE_PATH,
      bridgeScriptPath: BRIDGE_PATH,
    });

    expect(result.wrote).toBe(true);
    expect(fs.existsSync(result.configPath)).toBe(true);
  });
});
