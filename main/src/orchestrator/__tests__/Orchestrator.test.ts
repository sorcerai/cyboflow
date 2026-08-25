/**
 * Unit tests for Orchestrator.
 *
 * All dependencies are fully in-memory: no real DB, no Electron, no file I/O.
 * The tests exercise start()/stop() lifecycle semantics including idempotency
 * and drain behaviour.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Orchestrator } from '../Orchestrator';
import { RunQueueRegistry } from '../RunQueueRegistry';
import type { DatabaseLike, PreparedStatement } from '../types';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

/** Minimal in-memory PreparedStatement that always succeeds. */
function makeFakeStatement(): PreparedStatement {
  return {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: () => [],
  };
}

/** Fake DatabaseLike backed by a Map. No real SQL execution. */
function makeFakeDb(): DatabaseLike {
  return {
    prepare: (_sql: string) => makeFakeStatement(),
    transaction: <T>(fn: (...args: unknown[]) => T) => fn,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deferred promise for controlling async task completion in tests. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator', () => {
  let db: DatabaseLike;
  let logger: ReturnType<typeof makeSpyLogger>;
  let runQueues: RunQueueRegistry;

  beforeEach(() => {
    db = makeFakeDb();
    logger = makeSpyLogger();
    runQueues = new RunQueueRegistry();
  });

  // -------------------------------------------------------------------------
  // Test: instantiates with in-memory dependencies
  // -------------------------------------------------------------------------
  it('instantiates with in-memory dependencies', async () => {
    const orchestrator = new Orchestrator({ db, logger, runQueues });

    expect(orchestrator.isRunning()).toBe(false);

    await orchestrator.start();
    expect(orchestrator.isRunning()).toBe(true);

    await orchestrator.stop();
    expect(orchestrator.isRunning()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test: start is idempotent
  // -------------------------------------------------------------------------
  it('start is idempotent', async () => {
    const orchestrator = new Orchestrator({ db, logger, runQueues });

    await orchestrator.start();
    expect(orchestrator.isRunning()).toBe(true);

    const infoCallsBefore = logger.calls.filter((c) => c.level === 'info').length;

    // Second call while already running — should be a no-op (warn, no re-init)
    await orchestrator.start();
    expect(orchestrator.isRunning()).toBe(true);

    // A warning should have been emitted for the duplicate start
    const warnCalls = logger.calls.filter((c) => c.level === 'warn');
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnCalls.some((c) => c.message.includes('already running'))).toBe(true);

    // No additional info log was emitted (start was short-circuited)
    const infoCallsAfter = logger.calls.filter((c) => c.level === 'info').length;
    expect(infoCallsAfter).toBe(infoCallsBefore);

    await orchestrator.stop();
  });

  // -------------------------------------------------------------------------
  // Test: stop is a no-op when orchestrator is not running
  // -------------------------------------------------------------------------
  it('stop is a no-op when orchestrator has not been started', async () => {
    const orchestrator = new Orchestrator({ db, logger, runQueues });

    // Precondition: not yet started
    expect(orchestrator.isRunning()).toBe(false);

    // stop() should return immediately without logging or touching queues
    await orchestrator.stop();

    expect(orchestrator.isRunning()).toBe(false);

    const stopMessages = logger.calls.map((c) => c.message);
    expect(stopMessages).not.toContain('orchestrator.stop.begin');
    expect(stopMessages).not.toContain('orchestrator.stop.complete');
  });

  // -------------------------------------------------------------------------
  // Test: start() emits expected log message on first call
  // -------------------------------------------------------------------------
  it('start emits orchestrator.start info log on first call', async () => {
    const orchestrator = new Orchestrator({ db, logger, runQueues });

    await orchestrator.start();

    const infoMessages = logger.calls
      .filter((c) => c.level === 'info')
      .map((c) => c.message);
    expect(infoMessages).toContain('orchestrator.start');

    await orchestrator.stop();
  });

  // -------------------------------------------------------------------------
  // Test: stop drains the run queue registry
  // -------------------------------------------------------------------------
  it('stop drains the run queue registry', async () => {
    const orchestrator = new Orchestrator({ db, logger, runQueues });
    await orchestrator.start();

    // Enqueue a blocking task in the registry
    const gate = deferred();
    let taskFinished = false;

    const q = runQueues.getOrCreate('run-drain-test');
    void q.add(async () => {
      await gate.promise;
      taskFinished = true;
    });

    // stop() calls drainAll() — it must wait for the task
    const stopPromise = orchestrator.stop();

    // Task has not finished yet — gate is still locked
    expect(taskFinished).toBe(false);
    expect(orchestrator.isRunning()).toBe(false); // running flag cleared eagerly

    // Unblock the queued task
    gate.resolve();
    await stopPromise;

    expect(taskFinished).toBe(true);

    // Registry was cleared by drainAll()
    expect(runQueues.stats().runs).toBe(0);

    // Logger emitted stop lifecycle messages
    const messages = logger.calls.map((c) => c.message);
    expect(messages).toContain('orchestrator.stop.begin');
    expect(messages).toContain('orchestrator.stop.complete');
  });
});

// ---------------------------------------------------------------------------
// Stuck-event bridge (StuckDetector 'runs:stuck' -> stuckEvents 'detected')
// ---------------------------------------------------------------------------

describe('Orchestrator stuck-event bridge', () => {
  it('forwards a detector runs:stuck onto the injected sink as detected', async () => {
    const sink = new EventEmitter();
    const received: unknown[] = [];
    sink.on('detected', (e: unknown) => received.push(e));

    const orch = new Orchestrator({
      db: makeFakeDb(),
      logger: makeSpyLogger(),
      runQueues: new RunQueueRegistry(),
      stuckEvents: sink,
    });
    await orch.start();

    // Reach the detector's own emitter the way the detector does.
    const detectorEvents = (orch as unknown as { detectorEvents: EventEmitter }).detectorEvents;
    const event = { runId: 'run-1', reason: { kind: 'orphan_pty' }, detectedAt: 1 };
    detectorEvents.emit('runs:stuck', event);

    expect(received).toEqual([event]);

    await orch.stop();
  });

  it('detaches the bridge on stop so a restart does not double-forward', async () => {
    const sink = new EventEmitter();
    const received: unknown[] = [];
    sink.on('detected', (e: unknown) => received.push(e));

    const orch = new Orchestrator({
      db: makeFakeDb(),
      logger: makeSpyLogger(),
      runQueues: new RunQueueRegistry(),
      stuckEvents: sink,
    });

    await orch.start();
    const firstEmitter = (orch as unknown as { detectorEvents: EventEmitter }).detectorEvents;
    await orch.stop();

    // The old emitter is detached: anything it emits now is ignored.
    firstEmitter.emit('runs:stuck', { runId: 'stale', reason: { kind: 'orphan_pty' }, detectedAt: 1 });
    expect(received).toHaveLength(0);

    await orch.start();
    const secondEmitter = (orch as unknown as { detectorEvents: EventEmitter }).detectorEvents;
    secondEmitter.emit('runs:stuck', { runId: 'run-2', reason: { kind: 'orphan_pty' }, detectedAt: 2 });
    expect(received).toHaveLength(1);

    await orch.stop();
  });

  it('warns rather than throwing when no sink is injected', async () => {
    const logger = makeSpyLogger();
    const orch = new Orchestrator({
      db: makeFakeDb(),
      logger,
      runQueues: new RunQueueRegistry(),
    });

    await orch.start();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stuckEvents sink not provided'));
    await orch.stop();
  });
});
