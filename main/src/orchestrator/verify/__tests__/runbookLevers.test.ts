import { describe, expect, it } from 'vitest';
import { resolveLeverEnv } from '../runbookLevers';

const BASE = Object.freeze({ VERIFY_PORT: '4300', VERIFY_ATTEST_NONCE: 'nonce-1', VERIFY_MODALITY: 'web' });
const VALUES = { port: '4300', nonce: 'nonce-1' } as const;

describe('resolveLeverEnv', () => {
  it('exports a declared portEnv bound to the leased port', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { portEnv: 'PORT' }, VALUES);
    expect(additions).toEqual({ PORT: '4300' });
    expect(dropped).toEqual([]);
  });

  it('exports a declared nonceEnv bound to this request nonce', () => {
    const { additions } = resolveLeverEnv(BASE, { nonceEnv: 'APP_BUILD_ID' }, VALUES);
    expect(additions).toEqual({ APP_BUILD_ID: 'nonce-1' });
  });

  it('exports both levers at once', () => {
    const { additions } = resolveLeverEnv(
      BASE,
      { portEnv: 'PORT', nonceEnv: 'APP_BUILD_ID', dataDirEnv: 'CYBOFLOW_DIR', cdpPortFlag: '--x' },
      VALUES,
    );
    expect(additions).toEqual({ PORT: '4300', APP_BUILD_ID: 'nonce-1' });
  });

  it('exports nothing when the runbook declares no levers', () => {
    expect(resolveLeverEnv(BASE, undefined, VALUES)).toEqual({ additions: {}, dropped: [] });
  });

  it('skips portEnv when the task implies no server', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { portEnv: 'PORT' }, { port: null, nonce: 'n' });
    expect(additions).toEqual({});
    expect(dropped).toEqual([]);
  });

  // Rule 1 — a lever can never rewrite the harness's own contract.
  it('refuses to shadow a harness variable that carries a different value', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { nonceEnv: 'VERIFY_PORT' }, VALUES);
    expect(additions).toEqual({});
    expect(dropped).toEqual([{ lever: 'nonceEnv', name: 'VERIFY_PORT', reason: 'shadows-harness' }]);
  });

  it('treats a lever naming the harness variable that already carries the value as a silent no-op', () => {
    const { additions, dropped } = resolveLeverEnv(BASE, { portEnv: 'VERIFY_PORT' }, VALUES);
    expect(additions).toEqual({});
    expect(dropped).toEqual([]);
  });

  // Rule 2 — a machine-authored name that configures execution is not a lever.
  it.each(['PATH', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'IFS'])(
    'drops %s as a denied execution-environment name',
    (name) => {
      const { additions, dropped } = resolveLeverEnv(BASE, { portEnv: name }, VALUES);
      expect(additions).toEqual({});
      expect(dropped).toEqual([{ lever: 'portEnv', name, reason: 'denied' }]);
    },
  );

  it.each(['Path', 'port', 'PORT-1', 'PORT ', '', '1PORT', 'PORT=4300'])(
    'drops %o as a malformed env identifier',
    (name) => {
      const { additions, dropped } = resolveLeverEnv(BASE, { portEnv: name }, VALUES);
      expect(additions).toEqual({});
      expect(dropped).toEqual([{ lever: 'portEnv', name, reason: 'malformed' }]);
    },
  );

  it('does not mutate the base env it is given', () => {
    const base = { VERIFY_PORT: '4300' };
    resolveLeverEnv(base, { portEnv: 'PORT', nonceEnv: 'BUILD_ID' }, VALUES);
    expect(base).toEqual({ VERIFY_PORT: '4300' });
  });
});
