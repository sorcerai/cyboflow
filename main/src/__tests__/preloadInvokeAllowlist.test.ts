/**
 * Generic-invoke channel allowlist (main/src/preload.ts → GENERIC_INVOKE_CHANNELS).
 *
 * Both contextBridge surfaces expose `invoke(channel, ...args)`. Unconstrained,
 * that hands any renderer-side script the entire `ipcMain.handle` surface — git
 * execution and project-scoped file writes included — so a renderer XSS becomes
 * host code execution. These tests pin three things:
 *
 *   1. the exposed SHAPE is unchanged (contextBridge objects are frozen in the
 *      renderer, so a shape change is not something a call site can work around);
 *   2. an allowlisted channel still reaches `ipcRenderer.invoke` verbatim, and a
 *      non-allowlisted one is rejected LOUDLY, naming the channel;
 *   3. the allowlist COVERS every literal channel the renderer actually passes
 *      to a generic `invoke` — the drift guard, so moving a call site to the
 *      generic form without widening the list fails here rather than in a
 *      packaged build.
 */

// Force the non-production console-override branch OFF so importing preload does
// not monkeypatch the global console under the test runner (same as
// preloadApiParity.test.ts).
process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { exposed, invokeCalls } = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invokeCalls: [] as Array<{ channel: string; args: unknown[] }>,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed.set(key, api);
    },
  },
  ipcRenderer: {
    invoke: vi.fn((channel: string, ...args: unknown[]) => {
      invokeCalls.push({ channel, args });
      return Promise.resolve({ success: true });
    }),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

vi.mock('trpc-electron/main', () => ({ exposeElectronTRPC: vi.fn() }));
vi.mock('@sentry/electron/preload', () => ({}));

type GenericInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

let GENERIC_INVOKE_CHANNELS: readonly string[];

beforeAll(async () => {
  const preload = await import('../preload');
  GENERIC_INVOKE_CHANNELS = preload.GENERIC_INVOKE_CHANNELS;
});

function bridgeInvoke(bridge: 'electronAPI' | 'electron'): GenericInvoke {
  const api = exposed.get(bridge) as Record<string, unknown> | undefined;
  if (!api) throw new Error(`preload never exposed "${bridge}"`);
  const invoke = api.invoke;
  if (typeof invoke !== 'function') throw new Error(`"${bridge}.invoke" is not a function`);
  return invoke as GenericInvoke;
}

describe('exposed bridge shape is unchanged', () => {
  it.each(['electronAPI', 'electron'] as const)('%s.invoke is still a function', (bridge) => {
    expect(typeof bridgeInvoke(bridge)).toBe('function');
  });
});

describe.each(['electronAPI', 'electron'] as const)('%s.invoke allowlist', (bridge) => {
  it('forwards an allowlisted channel to ipcRenderer.invoke with its args intact', async () => {
    invokeCalls.length = 0;
    const result = await bridgeInvoke(bridge)('file:read', { sessionId: 's1', filePath: 'a.ts' });
    expect(result).toEqual({ success: true });
    expect(invokeCalls).toEqual([
      { channel: 'file:read', args: [{ sessionId: 's1', filePath: 'a.ts' }] },
    ]);
  });

  it('rejects a non-allowlisted channel, naming it, without touching ipcRenderer', async () => {
    invokeCalls.length = 0;
    await expect(bridgeInvoke(bridge)('git:execute-project', { projectId: 1, args: ['push'] }))
      .rejects.toThrow(/git:execute-project/);
    expect(invokeCalls).toEqual([]);
  });

  it('points at the allowlist so a legitimate new call site knows what to do', async () => {
    await expect(bridgeInvoke(bridge)('sessions:delete')).rejects.toThrow(
      /GENERIC_INVOKE_CHANNELS/,
    );
  });

  it('rejects rather than silently resolving undefined', async () => {
    await expect(bridgeInvoke(bridge)('made:up')).rejects.toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Drift guard — the allowlist must cover the renderer's real usage.
// ---------------------------------------------------------------------------

const FRONTEND_SRC = join(__dirname, '../../../frontend/src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every LITERAL channel the renderer passes to a generic `invoke`. Non-literal
 * arguments (the two onboarding-detection constants) are not matched here —
 * they are asserted separately below against their imported values, which is
 * stronger than a regex would be.
 */
function collectRendererGenericInvokeChannels(): Set<string> {
  const re = /\.invoke[?!]*\(\s*['"`]([^'"`]+)['"`]/g;
  const channels = new Set<string>();
  for (const file of walk(FRONTEND_SRC)) {
    const text = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) channels.add(m[1]);
  }
  return channels;
}

describe('allowlist covers the renderer’s actual generic-invoke usage', () => {
  it('the extraction is not vacuous', () => {
    expect(collectRendererGenericInvokeChannels().size).toBeGreaterThan(15);
  });

  it('no renderer call site invokes a channel the allowlist omits', () => {
    const used = [...collectRendererGenericInvokeChannels()].sort();
    const missing = used.filter((c) => !GENERIC_INVOKE_CHANNELS.includes(c));
    expect(missing).toEqual([]);
  });

  it('includes the onboarding-detection channel the renderer passes as a constant', async () => {
    const { PROVIDERS_DETECT_CHANNEL } = await import(
      '../../../shared/types/onboarding'
    );
    expect(GENERIC_INVOKE_CHANNELS).toContain(PROVIDERS_DETECT_CHANNEL);
  });

  it('every allowlisted channel has a real ipcMain.handle registration', () => {
    const mainSrc = join(__dirname, '..');
    const handled = new Set<string>();
    const re = /ipcMain\.handle\(\s*[`'"]([^`'"]+)[`'"]/g;
    const walkTs = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          out.push(...walkTs(p));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          out.push(p);
        }
      }
      return out;
    };
    for (const file of walkTs(mainSrc)) {
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) handled.add(m[1]);
    }
    // The detection channel is registered via its imported constant, not a
    // literal, so the regex above cannot see it.
    const registeredViaConstant = new Set(['providers:detect']);
    const orphans = GENERIC_INVOKE_CHANNELS.filter(
      (c) => !handled.has(c) && !registeredViaConstant.has(c),
    );
    expect(orphans).toEqual([]);
  });
});
