import { describe, it, expect } from 'vitest';
import type { Event, Breadcrumb, StackFrame } from '@sentry/electron/main';
import {
  scrubSentryEvent,
  scrubBreadcrumb,
  isBenignStreamWriteEpipe,
  tagCrashSource,
} from '../scrub';

describe('scrubSentryEvent', () => {
  function makeEvent(): Event {
    return {
      message: 'failed reading /Users/alice/secret-repo/src/file.ts',
      server_name: 'alices-macbook.local',
      extra: { prompt: 'write me a function that...' },
      user: { id: 'alice', email: 'alice@example.com' },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'ENOENT at /Users/alice/secret-repo/config.json',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/alice/secret-repo/src/file.ts',
                  abs_path: '/Users/alice/secret-repo/src/file.ts',
                },
                {
                  filename: 'C:\\Users\\bob\\repo\\index.ts',
                  abs_path: 'C:\\Users\\bob\\repo\\index.ts',
                },
              ],
            },
          },
        ],
      },
    };
  }

  it('reduces stack-frame paths to basenames', () => {
    const scrubbed = scrubSentryEvent(makeEvent());
    const frames = scrubbed?.exception?.values?.[0]?.stacktrace?.frames;
    expect(frames?.[0].filename).toBe('file.ts');
    expect(frames?.[0].abs_path).toBe('file.ts');
    // Windows-style separators also collapse to basename.
    expect(frames?.[1].filename).toBe('index.ts');
    expect(frames?.[1].abs_path).toBe('index.ts');
  });

  // Native minidump frames carry their path on `package` and leave
  // filename/abs_path unset, so the basename rules for JS frames never saw
  // them: real events shipped '/Users/<name>/.nvm/.../bin/node' to Sentry.
  it('reduces native frame package paths to basenames', () => {
    // The SDK's StackFrame type omits `package`; the event protocol defines it
    // for native frames and that is what a minidump actually sends.
    type FrameWithPackage = StackFrame & { package?: string };
    const nativeFrames: FrameWithPackage[] = [
      { package: '/Users/alice/.nvm/versions/node/v22.15.1/bin/node' },
      { package: '/usr/lib/system/libdispatch.dylib' },
      { package: '/Applications/Cyboflow.app/Contents/Resources/bin/peekaboo' },
    ];
    const event: Event = {
      platform: 'native',
      exception: {
        values: [{ type: 'Error', stacktrace: { frames: nativeFrames } }],
      },
    };
    const scrubbed = scrubSentryEvent(event)?.exception?.values?.[0]?.stacktrace
      ?.frames as FrameWithPackage[] | undefined;
    // The binary name survives — it is what identifies the crashing process
    // and what server-side grouping rules match on.
    expect(scrubbed?.[0].package).toBe('node');
    expect(scrubbed?.[1].package).toBe('libdispatch.dylib');
    expect(scrubbed?.[2].package).toBe('peekaboo');
    expect(scrubbed?.[0].package).not.toContain('alice');
  });

  it('redacts absolute home paths in message and exception value', () => {
    const scrubbed = scrubSentryEvent(makeEvent());
    expect(scrubbed?.message).not.toContain('/Users/alice');
    expect(scrubbed?.message).toContain('~/');
    const value = scrubbed?.exception?.values?.[0]?.value ?? '';
    expect(value).not.toContain('/Users/alice');
    expect(value).toContain('~/');
  });

  it('removes server_name, extra, and user', () => {
    const scrubbed = scrubSentryEvent(makeEvent());
    expect(scrubbed?.server_name).toBeUndefined();
    expect(scrubbed?.extra).toBeUndefined();
    expect(scrubbed?.user).toBeUndefined();
  });

  it('returns the same (mutated) event instance', () => {
    const event = makeEvent();
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed).toBe(event);
  });
});

describe('isBenignStreamWriteEpipe', () => {
  /** Build a `write EPIPE` event whose stack ends in the given frame functions. */
  function epipeEvent(frameFns: string[], value = 'write EPIPE'): Event {
    return {
      exception: {
        values: [
          {
            type: 'Error',
            value,
            stacktrace: { frames: frameFns.map((function_) => ({ function: function_ })) },
          },
        ],
      },
    };
  }

  it('drops the logger broken-pipe write (CYBOFLOW-APP-D)', () => {
    // Logger.log -> console.log -> Writable.write -> Socket._write -> afterWriteDispatched
    const event = epipeEvent(['Logger.log', 'Writable.write', 'Socket._write', 'afterWriteDispatched']);
    expect(isBenignStreamWriteEpipe(event)).toBe(true);
  });

  it('drops the execSync broken-pipe write (CYBOFLOW-APP-E)', () => {
    const event = epipeEvent(['CommandExecutor.execSync', 'Writable.write', 'Socket._write', 'writeGeneric']);
    expect(isBenignStreamWriteEpipe(event)).toBe(true);
  });

  it('does NOT drop an EPIPE that never went through a stream-write frame', () => {
    // A future EPIPE surfacing from unrelated code still reports — scoped, not blanket.
    const event = epipeEvent(['SomeService.connect', 'process.processTicksAndRejections']);
    expect(isBenignStreamWriteEpipe(event)).toBe(false);
  });

  it('does NOT drop a non-EPIPE error even off a stream-write frame', () => {
    const event = epipeEvent(['Writable.write', 'Socket._write'], 'write ECONNRESET');
    expect(isBenignStreamWriteEpipe(event)).toBe(false);
  });

  it('returns false when the event carries no exception values', () => {
    expect(isBenignStreamWriteEpipe({ message: 'no exception here' })).toBe(false);
  });
});

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs (they contain code/prompts)', () => {
    const breadcrumb: Breadcrumb = {
      category: 'console',
      message: 'console.log("user prompt: write code")',
    };
    expect(scrubBreadcrumb(breadcrumb)).toBeNull();
  });

  it('keeps a non-console breadcrumb and redacts home paths', () => {
    const breadcrumb: Breadcrumb = {
      category: 'navigation',
      message: 'opened /Users/alice/secret-repo/file.ts',
    };
    const result = scrubBreadcrumb(breadcrumb);
    expect(result).not.toBeNull();
    expect(result?.message).not.toContain('/Users/alice');
    expect(result?.message).toContain('~/');
  });

  it('returns a non-console breadcrumb without a message unchanged', () => {
    const breadcrumb: Breadcrumb = { category: 'ui.click' };
    const result = scrubBreadcrumb(breadcrumb);
    expect(result).toBe(breadcrumb);
  });
});

describe('tagCrashSource', () => {
  function nativeCrash(processTag?: string): Event {
    return {
      platform: 'native',
      level: 'fatal',
      tags: {
        'event.environment': 'native',
        ...(processTag === undefined ? {} : { 'event.process': processTag }),
      },
    };
  }

  // The crash families that motivated the tag: a vitest worker an agent forked
  // and the bundled peekaboo binary both land here with no crashpad
  // `process_type`, so the SDK stamps the literal 'unknown'.
  it("marks a minidump with no identified process type as external", () => {
    expect(tagCrashSource(nativeCrash('unknown')).tags?.crash_source).toBe('external-process');
  });

  it('marks a minidump missing the process tag entirely as external', () => {
    expect(tagCrashSource(nativeCrash()).tags?.crash_source).toBe('external-process');
  });

  it.each(['browser', 'renderer', 'gpu', 'utility'])(
    "marks a '%s' process crash as the app's own",
    (processTag) => {
      expect(tagCrashSource(nativeCrash(processTag)).tags?.crash_source).toBe('app');
    },
  );

  // Ambiguity fails TOWARD the app: a renderer named via getRendererName, or a
  // process type a future Electron adds, must never be filed as external noise.
  it('treats an unrecognized but named process type as the app', () => {
    expect(tagCrashSource(nativeCrash('main-window')).tags?.crash_source).toBe('app');
  });

  it('preserves the tags the SDK already set', () => {
    const tagged = tagCrashSource(nativeCrash('unknown'));
    expect(tagged.tags?.['event.environment']).toBe('native');
  });

  it('leaves non-native events untagged', () => {
    const jsError: Event = { platform: 'javascript', tags: { 'event.process': 'browser' } };
    expect(tagCrashSource(jsError).tags?.crash_source).toBeUndefined();
  });

  it('tags a native crash when it flows through beforeSend alongside scrubbing', () => {
    const scrubbed = scrubSentryEvent(tagCrashSource(nativeCrash('unknown')));
    expect(scrubbed?.tags?.crash_source).toBe('external-process');
  });
});
