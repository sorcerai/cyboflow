/**
 * IPC sender validation (main/src/ipc/senderGuard.ts).
 *
 * `ipcMain.handle` dispatches on channel name alone, so without this guard any
 * frame that can reach `ipcRenderer.invoke` is served every one of cyboflow's
 * ~194 channels. The frames that must NOT be served all exist today: the
 * `about:srcdoc` static-mockup artifact frame and the `http://127.0.0.1:<port>`
 * design-prototype OOPIF. These tests pin the accept/reject matrix, and pin
 * that a rejected call comes back as an IPCResponse rather than a thrown error
 * (a throw crosses the bridge as an opaque "Error invoking remote method").
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false },
}));

import {
  isTrustedRendererFrameUrl,
  isTrustedSender,
  senderRejection,
  type SenderGuardConfig,
} from '../senderGuard';
import type { IpcMainInvokeEvent } from 'electron';

const PROD: SenderGuardConfig = { isDevelopment: false, devRendererPort: '4521' };
const DEV: SenderGuardConfig = { isDevelopment: true, devRendererPort: '4521' };

/** Minimal IpcMainInvokeEvent stand-in — the guard reads only `senderFrame`. */
function eventFrom(frame: { url: string; parent: unknown } | null): IpcMainInvokeEvent {
  return { senderFrame: frame } as unknown as IpcMainInvokeEvent;
}

describe('isTrustedRendererFrameUrl — production (file:// bundle)', () => {
  it('accepts the packaged renderer document inside app.asar', () => {
    expect(
      isTrustedRendererFrameUrl(
        'file:///Applications/Cyboflow.app/Contents/Resources/app.asar/frontend/dist/index.html',
        PROD,
      ),
    ).toBe(true);
  });

  it('accepts the unpackaged e2e launch from a repo checkout', () => {
    expect(
      isTrustedRendererFrameUrl('file:///Users/dev/cyboflow/frontend/dist/index.html', PROD),
    ).toBe(true);
  });

  it('accepts a path with percent-encoded spaces', () => {
    expect(
      isTrustedRendererFrameUrl(
        'file:///Users/dev/My%20Projects/cyboflow/frontend/dist/index.html',
        PROD,
      ),
    ).toBe(true);
  });

  it('accepts a hash route appended by the renderer', () => {
    expect(
      isTrustedRendererFrameUrl('file:///app/frontend/dist/index.html#/sessions/42', PROD),
    ).toBe(true);
  });

  it('rejects any other file:// document', () => {
    expect(isTrustedRendererFrameUrl('file:///etc/passwd', PROD)).toBe(false);
    expect(isTrustedRendererFrameUrl('file:///tmp/evil/index.html', PROD)).toBe(false);
    // A lookalike that only ENDS in index.html under a different directory.
    expect(isTrustedRendererFrameUrl('file:///tmp/dist/index.html', PROD)).toBe(false);
  });

  it('rejects the artifact and prototype frame identities', () => {
    expect(isTrustedRendererFrameUrl('about:srcdoc', PROD)).toBe(false);
    expect(isTrustedRendererFrameUrl('about:blank', PROD)).toBe(false);
    expect(isTrustedRendererFrameUrl('http://127.0.0.1:51733/', PROD)).toBe(false);
    expect(isTrustedRendererFrameUrl('http://localhost:8081/', PROD)).toBe(false);
  });

  it('rejects data:, blob: and unparseable urls', () => {
    expect(isTrustedRendererFrameUrl('data:text/html,<script>1</script>', PROD)).toBe(false);
    expect(isTrustedRendererFrameUrl('blob:file:///abc', PROD)).toBe(false);
    expect(isTrustedRendererFrameUrl('not a url', PROD)).toBe(false);
    expect(isTrustedRendererFrameUrl('', PROD)).toBe(false);
  });
});

describe('isTrustedRendererFrameUrl — development (Vite dev server)', () => {
  it('accepts the dev renderer on its configured port', () => {
    expect(isTrustedRendererFrameUrl('http://localhost:4521/', DEV)).toBe(true);
    expect(isTrustedRendererFrameUrl('http://localhost:4521/index.html', DEV)).toBe(true);
  });

  it('honors a leased CYBOFLOW_VITE_PORT', () => {
    const leased: SenderGuardConfig = { isDevelopment: true, devRendererPort: '4599' };
    expect(isTrustedRendererFrameUrl('http://localhost:4599/', leased)).toBe(true);
    expect(isTrustedRendererFrameUrl('http://localhost:4521/', leased)).toBe(false);
  });

  it('rejects 127.0.0.1 even on the dev port — that host is the prototype loopback', () => {
    expect(isTrustedRendererFrameUrl('http://127.0.0.1:4521/', DEV)).toBe(false);
  });

  it('rejects other ports, https, and the prod file:// document', () => {
    expect(isTrustedRendererFrameUrl('http://localhost:5173/', DEV)).toBe(false);
    expect(isTrustedRendererFrameUrl('https://localhost:4521/', DEV)).toBe(false);
    expect(isTrustedRendererFrameUrl('file:///app/frontend/dist/index.html', DEV)).toBe(false);
  });
});

describe('isTrustedSender — frame identity', () => {
  it('accepts the top-level renderer frame', () => {
    const event = eventFrom({ url: 'file:///app/frontend/dist/index.html', parent: null });
    expect(isTrustedSender(event, PROD)).toBe(true);
  });

  it('rejects a SUB-frame even when its url would otherwise pass', () => {
    const event = eventFrom({
      url: 'file:///app/frontend/dist/index.html',
      parent: { url: 'file:///app/frontend/dist/index.html' },
    });
    expect(isTrustedSender(event, PROD)).toBe(false);
  });

  it('rejects a destroyed/absent frame rather than assuming it was ours', () => {
    expect(isTrustedSender(eventFrom(null), PROD)).toBe(false);
  });

  it('rejects the design-prototype loopback sub-frame', () => {
    const event = eventFrom({
      url: 'http://127.0.0.1:51733/index.html',
      parent: { url: 'file:///app/frontend/dist/index.html' },
    });
    expect(isTrustedSender(event, PROD)).toBe(false);
  });
});

describe('senderRejection', () => {
  it('is the IPCResponse failure shape, naming the channel', () => {
    const rejection = senderRejection('git:execute-project');
    expect(rejection.success).toBe(false);
    expect(rejection.error).toContain('git:execute-project');
  });
});
