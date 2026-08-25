/**
 * OrchSocketServer — the orchestrator-side half of the Cyboflow MCP IPC link.
 *
 * Stands up a Unix-domain `net.Server` that listens on a socket path under
 * `~/.cyboflow/sockets/`, accepts connections from spawned `cyboflowMcpServer`
 * subprocesses, parses the newline-delimited JSON wire protocol those
 * subprocesses emit, and routes each message through a real `McpQueryHandler`
 * (constructed with the injected cyboflow DB). This is what makes the three
 * `cyboflow_*` tools routable for the first time.
 *
 * Standalone-typecheck invariant (mirrors orchestrator/types.ts and
 * orchestrator/runLauncher.ts): this module must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The socket
 * path is resolved by the caller (TASK-799 passes
 * getCyboflowSubdirectory('sockets', 'orch.sock')) and injected as a
 * constructor argument, so this file never imports the electron-backed
 * cyboflow-directory helper.
 *
 * Transport boundary: this class owns *only* the transport layer — framing,
 * connection lifecycle, and malformed-line handling. `McpQueryHandler` owns the
 * application layer (it never throws and writes its own error responses), so a
 * malformed (non-JSON) line is logged and dropped here and never reaches the
 * handler. The framing mirrors the rolling-buffer logic the subprocess uses on
 * its side (cyboflowMcpServer.ts:66-90), so a JSON message split across multiple
 * 'data' events — or batched without a trailing newline in the first chunk —
 * reassembles correctly.
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { McpQueryHandler, type McpQueryMessage, type McpQueryHandlerDeps } from './mcpQueryHandler';
import type { DatabaseLike, LoggerLike } from '../types';

// ---------------------------------------------------------------------------
// Wire-envelope narrowing
// ---------------------------------------------------------------------------

/**
 * The minimal envelope every message on this socket shares. A line must be a
 * JSON object carrying a string `type` and a string `requestId`; `runId` is
 * present on every message the subprocess emits (cyboflowMcpServer.ts:126) and,
 * when present, binds the originating socket to that run so `hasClientForRun`
 * can report it.
 */
interface McpQueryEnvelope {
  type: string;
  requestId: string;
  runId?: string;
}

function isMcpQueryEnvelope(v: unknown): v is McpQueryEnvelope {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.type !== 'string') return false;
  if (typeof obj.requestId !== 'string') return false;
  if (obj.runId !== undefined && typeof obj.runId !== 'string') return false;
  return true;
}

// ---------------------------------------------------------------------------
// OrchSocketServer
// ---------------------------------------------------------------------------

/**
 * Structurally satisfies `OrchSocketProvider` (runLauncher.ts) via
 * `getSocketPath`. The `OrchSocketProvider` interface is not imported here
 * because runLauncher.ts drags concrete service types (WorktreeManager,
 * RunExecutor, …) that would violate the standalone-typecheck invariant; the
 * structural match is asserted in the unit test instead.
 */
export class OrchSocketServer {
  private readonly handler: McpQueryHandler;
  private server: net.Server | null = null;
  private readonly clientsByRun = new Map<string, Set<net.Socket>>();
  /**
   * Every live connection, regardless of whether it has bound a runId. Held so
   * stop() can actively destroy in-flight sockets — net.Server.close() does NOT
   * resolve while connections remain open, so without this stop() would hang
   * whenever a subprocess is still connected.
   */
  private readonly connections = new Set<net.Socket>();
  /**
   * Inode of the socket file THIS server bound, captured right after a
   * successful listen(). stop() unlinks the path only while it still resolves
   * to this inode — see the ownership check there for why an unconditional
   * unlink is unsafe on a fixed, cross-instance path.
   */
  private boundInode: number | null = null;

  constructor(
    private readonly socketPath: string,
    db: DatabaseLike,
    private readonly logger: LoggerLike,
    deps: McpQueryHandlerDeps = {},
  ) {
    this.handler = new McpQueryHandler(db, logger, deps);
  }

  /**
   * Create the sockets directory if missing, unlink any stale socket file at
   * the path (a leftover file makes `listen` fail with EADDRINUSE), then create
   * the server and resolve once it is listening.
   */
  async start(): Promise<void> {
    // Any inode from a prior bind is stale the moment we re-enter start().
    this.boundInode = null;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

    // A unix socket fails to bind onto a leftover file from a prior run, so a
    // stale file must be unlinked first. But unlink-before-bind must NOT clobber
    // a socket a LIVE peer is still listening on — that is exactly the
    // two-instance orch.sock clobber that stranded every subsequent MCP
    // subprocess (the file was replaced out from under a running server). The
    // single-instance-per-kind lock (index.ts) should already prevent a second
    // server here; this probe is defense-in-depth if that guard ever fails open.
    if (fs.existsSync(this.socketPath)) {
      if (await this.isSocketAlive(this.socketPath)) {
        this.server = null;
        this.logger.error('[Cyboflow Orch IPC] live socket already in use — refusing to clobber', {
          socketPath: this.socketPath,
        });
        throw new Error(
          `[Cyboflow Orch IPC] refusing to bind ${this.socketPath}: another server is already listening on it`,
        );
      }
      // No live listener answered — a stale leftover file. Safe to remove.
      fs.rmSync(this.socketPath, { force: true });
    }

    const server = net.createServer((socket) => this.onConnection(socket));
    this.server = server;

    // Bind, recovering ONCE from EADDRINUSE. The pre-bind probe above is a
    // synchronous check against an async listen(), so a socket file that
    // (re)appears in that window — or a peer that binds the path between our
    // probe and this listen() — throws EADDRINUSE at bind time. The previous
    // log-only error handler left the server dead and this promise unresolved
    // forever, so the MCP subprocess (a pure client) hit ECONNREFUSED and
    // exhausted its restart budget: a permanent outbound-MCP outage until app
    // restart. Recovery must NOT blindly unlink, though — a live peer may own the
    // path now (the clobber this class exists to prevent), so re-probe first:
    // a LIVE listener rejects as an ownership conflict; only a stale/dead file is
    // unlinked and retried once. Then reject so the caller sees a real fatal
    // instead of a hang.
    await new Promise<void>((resolve, reject) => {
      let retriedAddrInUse = false;
      const onListening = (): void => {
        server.removeListener('error', onError);
        // Runtime errors after a successful bind must be logged, not crash boot.
        server.on('error', (err: Error) => {
          this.logger.error('[Cyboflow Orch IPC] server error', { error: err.message });
        });
        // Record the inode we just bound so stop() can prove ownership before
        // unlinking. A failed stat leaves it null, which makes stop() skip the
        // unlink — strictly the safe direction (a stale file is reclaimed by the
        // next start()'s probe; a clobbered live socket is not recoverable).
        try {
          this.boundInode = fs.statSync(this.socketPath).ino;
        } catch (err) {
          this.boundInode = null;
          this.logger.debug('[Cyboflow Orch IPC] could not stat bound socket', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this.logger.info('[Cyboflow Orch IPC] listening', { socketPath: this.socketPath });
        resolve();
      };
      const failOwnershipConflict = (): void => {
        server.removeListener('listening', onListening);
        this.server = null;
        this.logger.error('[Cyboflow Orch IPC] EADDRINUSE on a LIVE socket — refusing to clobber', {
          socketPath: this.socketPath,
        });
        reject(
          new Error(
            `[Cyboflow Orch IPC] refusing to bind ${this.socketPath}: another server is already listening on it`,
          ),
        );
      };
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === 'EADDRINUSE' && !retriedAddrInUse) {
          retriedAddrInUse = true;
          // A peer may have bound the path in the probe→listen window. Never
          // unlink a live socket — reject; only reclaim a stale/dead file.
          void this.isSocketAlive(this.socketPath).then((alive) => {
            if (alive) {
              failOwnershipConflict();
              return;
            }
            this.logger.warn('[Cyboflow Orch IPC] EADDRINUSE — unlinking stale socket and retrying once', {
              socketPath: this.socketPath,
            });
            try {
              fs.rmSync(this.socketPath, { force: true });
            } catch {
              /* best-effort — the retry surfaces any genuine failure */
            }
            server.listen(this.socketPath);
          });
          return;
        }
        server.removeListener('listening', onListening);
        this.server = null;
        this.logger.error('[Cyboflow Orch IPC] server error', { error: err.message });
        reject(err);
      };
      server.once('listening', onListening);
      server.on('error', onError);
      server.listen(this.socketPath);
    });
  }

  /**
   * Close the server and resolve once closed — unless the socket path has been
   * rebound by another instance, in which case we deliberately leave the handle
   * open rather than take their socket down with us.
   *
   * The path is fixed and shared across instances (~/.cyboflow/sockets/orch.sock),
   * so "we are shutting down" does not imply "the file at that path is ours". An
   * older build that unlink-and-rebinds without probing (every build before the
   * start() guard above) leaves the path owned by someone else while our server
   * object is still non-null.
   *
   * The subtle part: it is not enough to guard our own `fs.rmSync`. **libuv
   * unlinks a unix socket BY PATH inside `close()`**, so merely closing a server
   * whose path was rebound deletes the *other* instance's live socket — before
   * any check of ours could run, and with no way to suppress it from JS. The only
   * way not to perform that unlink is not to call close() at all. So when the path
   * is foreign we destroy our connections, unref the handle (it must never hold
   * the event loop open) and drop it; the process is shutting down and the kernel
   * reclaims the fd without libuv's unlink path ever running.
   *
   * This is the failure mode that stranded every MCP subprocess spawned after
   * 2026-07-28: the file vanished while the owning app kept its bound-but-unlinked
   * inode and all existing connections, so health stayed green while every new
   * connect() got ENOENT until the app restarted.
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    const boundInode = this.boundInode;
    this.boundInode = null;

    // Destroy any in-flight connections first; net.Server.close() resolves only
    // once every open connection has ended.
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    // Ownership check must happen BEFORE close() — see the libuv note above.
    if (this.pathBelongsToAnotherInstance(boundInode)) {
      server.unref();
      this.logger.warn(
        '[Cyboflow Orch IPC] socket path was rebound by another instance — leaving it and our handle untouched',
        { socketPath: this.socketPath, boundInode },
      );
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // close() already unlinked our own socket; this is a belt-and-braces sweep
    // for the case where it did not (e.g. never fully bound). ENOENT is expected.
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch (err) {
      this.logger.debug('[Cyboflow Orch IPC] socket file unlink skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * True when a file exists at the socket path but does NOT resolve to the inode
   * we bound — i.e. a different instance owns it now and we must not disturb it.
   *
   * An absent path returns false: there is nothing to protect, and stop() should
   * still close normally to release the handle. A null `boundInode` (stat failed
   * at bind time) with a file present is treated as foreign — the safe direction,
   * since leaking a handle costs nothing next to clobbering a live socket.
   */
  private pathBelongsToAnotherInstance(boundInode: number | null): boolean {
    try {
      return fs.statSync(this.socketPath).ino !== boundInode;
    } catch {
      return false;
    }
  }

  /**
   * Probe whether a live server is currently accepting connections on
   * `socketPath`. Resolves `true` iff a client connection succeeds; `false` when
   * the path is absent (ENOENT), refuses (ECONNREFUSED — a stale socket file
   * whose owning server is gone), errors otherwise, or does not connect within a
   * short timeout. Never rejects, so start()'s reclaim path is deterministic.
   */
  private isSocketAlive(socketPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const probe = net.createConnection(socketPath);
      let settled = false;
      const done = (alive: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probe.destroy();
        resolve(alive);
      };
      const timer = setTimeout(() => done(false), 500);
      timer.unref?.();
      probe.once('connect', () => done(true));
      probe.once('error', () => done(false));
    });
  }

  /** The socket path this server listens on (satisfies OrchSocketProvider). */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Whether the socket path still resolves to the inode this server bound.
   *
   * False means we are in the silent-outage state: the server object is alive
   * and every ALREADY-open connection keeps working (a unix socket survives
   * unlink), but the path is gone or now belongs to someone else, so every NEW
   * connect() fails with ENOENT. Health surfaces read this to avoid reporting
   * green while no subprocess can actually reach us — the exact way the
   * 2026-07-28 outage stayed invisible for two days.
   *
   * Sync and cheap (one stat), so it can be polled from a health snapshot.
   */
  isSocketPathIntact(): boolean {
    if (!this.server || this.boundInode === null) return false;
    try {
      return fs.statSync(this.socketPath).ino === this.boundInode;
    } catch {
      return false;
    }
  }

  /**
   * Whether a client connection bound to `runId` is currently open.
   *
   * DIAGNOSTIC ONLY — nothing consumes this for control flow. It formerly
   * backed StuckDetector's `stale_socket` rung, retired on 2026-08-21 (the
   * reasoning lives at that rung's tombstone in stuckDetector.ts). Two traps
   * for any future caller: binding is LAZY, happening on the first envelope
   * that carries a runId, so a live run that has sent nothing reads false; and
   * the claude-sdk lane decides permissions in-process and never connects at
   * all, so false there means nothing.
   */
  hasClientForRun(runId: string): boolean {
    return (this.clientsByRun.get(runId)?.size ?? 0) > 0;
  }

  /**
   * Deny-and-close every in-flight shell-approval socket for `runId`. Public
   * boot-wired affordance (IDEA-030 / TASK-819): the interactive manager's
   * teardown seam (setShellApprovalCanceller) invokes this BEFORE killing the
   * PTY so a blocked PreToolUse hook subprocess unblocks with a deny rather than
   * leaking a held-open socket. Delegates to the handler's shipped twin
   * (mcpQueryHandler.cancelInFlightShellApprovals, TASK-810) — the deny logic is
   * NOT re-implemented here.
   *
   * @returns the number of sockets denied/closed.
   */
  cancelInFlightShellApprovals(runId: string): number {
    return this.handler.cancelInFlightShellApprovals(runId);
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  /**
   * Per-connection handler. Owns a rolling receive buffer mirroring
   * cyboflowMcpServer.ts:66-90 so messages that span multiple 'data' events,
   * or arrive without a trailing newline, parse correctly. The set of runIds
   * this socket has bound (so it can be unregistered on close/error) is tracked
   * locally.
   */
  private onConnection(socket: net.Socket): void {
    let recvBuffer = '';
    const boundRuns = new Set<string>();
    this.connections.add(socket);

    socket.on('data', (buf: Buffer) => {
      recvBuffer += buf.toString('utf8');
      let nl: number;
      while ((nl = recvBuffer.indexOf('\n')) !== -1) {
        const line = recvBuffer.slice(0, nl).trim();
        recvBuffer = recvBuffer.slice(nl + 1);
        if (!line) continue;
        this.routeLine(line, socket, boundRuns);
      }
    });

    socket.on('error', (err: Error) => {
      this.logger.warn('[Cyboflow Orch IPC] client socket error', { error: err.message });
      this.connections.delete(socket);
      this.unbindSocket(socket, boundRuns);
    });

    socket.on('close', () => {
      this.logger.debug('[Cyboflow Orch IPC] client disconnected');
      this.connections.delete(socket);
      this.unbindSocket(socket, boundRuns);
    });
  }

  /**
   * Parse and route a single complete line. A non-JSON line is logged and
   * dropped — it must never throw out of the 'data' handler.
   */
  private routeLine(line: string, socket: net.Socket, boundRuns: Set<string>): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.logger.warn('[Cyboflow Orch IPC] failed to parse line', {
        line,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!isMcpQueryEnvelope(parsed)) {
      this.logger.warn('[Cyboflow Orch IPC] dropped malformed envelope', { line });
      return;
    }

    if (parsed.runId !== undefined && !boundRuns.has(parsed.runId)) {
      this.bindSocket(parsed.runId, socket);
      boundRuns.add(parsed.runId);
    }

    // The envelope is validated; the handler's exhaustive-default fallback
    // covers any type not in the current union, so the cast is safe.
    const msg = parsed as McpQueryMessage;
    void this.handler.handleMessage(msg, socket);
  }

  private bindSocket(runId: string, socket: net.Socket): void {
    let set = this.clientsByRun.get(runId);
    if (!set) {
      set = new Set<net.Socket>();
      this.clientsByRun.set(runId, set);
    }
    set.add(socket);
  }

  private unbindSocket(socket: net.Socket, boundRuns: Set<string>): void {
    for (const runId of boundRuns) {
      const set = this.clientsByRun.get(runId);
      if (!set) continue;
      set.delete(socket);
      if (set.size === 0) this.clientsByRun.delete(runId);
    }
    boundRuns.clear();
  }
}
