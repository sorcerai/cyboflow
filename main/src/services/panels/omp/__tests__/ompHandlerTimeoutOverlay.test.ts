/**
 * Tests for the config overlay that raises OMP's `tool_call` extension-handler
 * cap (`ompHandlerTimeoutOverlay.ts`).
 *
 * The invariants under test are the ones whose violation is FATAL to a spawn
 * rather than merely slow: OMP refuses to start when `PI_CONFIG_FILES` names a
 * file it cannot read or parse, so "never return a path we did not just write"
 * and "never emit an empty path segment" are correctness, not tidiness.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composePiConfigFiles,
  ensureHandlerTimeoutOverlay,
  OMP_HANDLER_TIMEOUT_MARGIN_MS,
  OMP_HANDLER_TIMEOUT_MS,
  OMP_OVERLAY_FILENAME,
  OMP_RAISED_DECISION_BUDGET_MS,
  renderHandlerTimeoutOverlay,
} from '../ompHandlerTimeoutOverlay';

describe('renderHandlerTimeoutOverlay', () => {
  it('nests the key under extensionHandlers rather than writing a dotted key', () => {
    const yaml = renderHandlerTimeoutOverlay(1234);
    // OMP resolves settings.get('a.b') against a NESTED object; a literal
    // "extensionHandlers.toolCallTimeoutMs:" key parses fine and is never found,
    // which would silently leave the cap at 30s.
    expect(yaml).toContain('extensionHandlers:\n  toolCallTimeoutMs: 1234');
    expect(yaml).not.toContain('extensionHandlers.toolCallTimeoutMs');
  });

  it('ends with a newline so the file is well-formed YAML', () => {
    expect(renderHandlerTimeoutOverlay(1)).toMatch(/\n$/);
  });
});

describe('the budget constants', () => {
  it('leaves the gate a margin so cyboflow gives up before OMP does', () => {
    // If the gate outlived OMP's cap, the model would see OMP's generic
    // "Extension ... timed out" instead of cyboflow's own explanation.
    expect(OMP_RAISED_DECISION_BUDGET_MS).toBe(
      OMP_HANDLER_TIMEOUT_MS - OMP_HANDLER_TIMEOUT_MARGIN_MS,
    );
    expect(OMP_RAISED_DECISION_BUDGET_MS).toBeLessThan(OMP_HANDLER_TIMEOUT_MS);
    expect(OMP_RAISED_DECISION_BUDGET_MS).toBeGreaterThan(0);
  });
});

describe('ensureHandlerTimeoutOverlay', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-overlay-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes the overlay and returns a path that exists', () => {
    const nested = path.join(dir, 'does', 'not', 'exist', 'yet');
    const result = ensureHandlerTimeoutOverlay(nested, 60_000);

    expect(result).toBe(path.join(nested, OMP_OVERLAY_FILENAME));
    expect(fs.existsSync(result as string)).toBe(true);
    expect(fs.readFileSync(result as string, 'utf8')).toContain('toolCallTimeoutMs: 60000');
  });

  it('repairs the file when something removed it between spawns', () => {
    const first = ensureHandlerTimeoutOverlay(dir, 60_000) as string;
    fs.rmSync(first);
    expect(fs.existsSync(first)).toBe(false);

    const second = ensureHandlerTimeoutOverlay(dir, 60_000);
    expect(second).toBe(first);
    expect(fs.existsSync(first)).toBe(true);
  });

  it('returns null instead of a path it failed to write', () => {
    // The whole point: OMP throws "Config overlay not found" before the session
    // starts, so a path we could not write must never reach PI_CONFIG_FILES.
    // A real EISDIR rather than a mock — `fs.writeFileSync` is non-configurable
    // under vitest, and the genuine failure is the thing worth asserting.
    fs.mkdirSync(path.join(dir, OMP_OVERLAY_FILENAME), { recursive: true });
    const warn = vi.fn();

    const result = ensureHandlerTimeoutOverlay(dir, 60_000, {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      verbose: vi.fn(),
    } as unknown as Parameters<typeof ensureHandlerTimeoutOverlay>[2]);

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('composePiConfigFiles', () => {
  const overlay = '/data/cyboflow/omp/handler-timeout.yml';

  it('is just our path when the user set nothing', () => {
    expect(composePiConfigFiles(undefined, overlay)).toBe(overlay);
    expect(composePiConfigFiles('', overlay)).toBe(overlay);
  });

  it("preserves the user's entries and appends ours last so ours wins", () => {
    const user = ['/a.yml', '/b.yml'].join(path.delimiter);
    expect(composePiConfigFiles(user, overlay)).toBe(
      ['/a.yml', '/b.yml', overlay].join(path.delimiter),
    );
  });

  it('never emits an empty segment from a stray delimiter', () => {
    // An empty path is a file OMP cannot read, and an unreadable overlay takes
    // the entire spawn down rather than being skipped.
    const messy = `${path.delimiter}/a.yml${path.delimiter}${path.delimiter}  ${path.delimiter}`;
    const result = composePiConfigFiles(messy, overlay);

    expect(result.split(path.delimiter).filter((s) => s.trim().length === 0)).toEqual([]);
    expect(result).toBe(['/a.yml', overlay].join(path.delimiter));
  });

  it('does not accumulate duplicates of our own overlay across spawns', () => {
    const once = composePiConfigFiles(undefined, overlay);
    const twice = composePiConfigFiles(once, overlay);
    expect(twice).toBe(overlay);
  });
});
