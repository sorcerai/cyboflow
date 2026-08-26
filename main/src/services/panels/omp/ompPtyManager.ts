import type { AgentProvider } from '../../../../../shared/types/agentRuntime';
import { AsyncLocalStorage } from 'node:async_hooks';
import type * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { ConversationMessage } from '../../../database/models';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { probeCliVersion, type CliVersionProbeResult } from '../cli/cliVersionProbe';
import { evaluateOmpVersionPolicy, OMP_MIN_SUPPORTED_VERSION, OMP_TESTED_VERSION } from './ompVersions';
import { isPermissionMode, type PermissionMode } from '../../../../../shared/types/workflows';

interface OmpPtySpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  permissionMode?: 'approve' | 'ignore';
  agentPermissionMode?: PermissionMode;
  model?: string;
  runId?: string;
  /**
   * Set by {@link OmpPtyManager.continuePanel} to request `--continue`
   * (OMP's per-cwd most-recent-session resume) on the respawn. Never set by
   * `startPanel` — a fresh panel always starts a fresh OMP session.
   */
  isContinue?: boolean;
  [key: string]: unknown;
}

/**
 * OMP's `--approval-mode` values this manager ever emits. `'write'` (OMP's
 * auto-approve-write-tier mode) is deliberately never one of them — see
 * {@link ompApprovalModeForMode}.
 */
type OmpApprovalMode = 'always-ask' | 'yolo';

interface OmpPtySpawnContext {
  panelId: string;
  sessionId: string;
  runId: string;
}

const PTY_BACKLOG_CAP_BYTES = 200_000;

/**
 * Every flag {@link OmpPtyManager.buildCommandArgs} must NEVER omit, checked
 * by {@link assertOmpRequiredSpawnFlags} right before the argv is returned.
 * This is the §8.1/§8.2 security invariant made mechanical: `--approval-mode`
 * is the antidote to OMP's yolo-by-default (proposal fact §2.5 / §8.1), and
 * `--no-extensions`/`--no-skills` are the discovery-lockdown that stops a
 * project's own `.omp/extensions`, `.omp/hooks`, `.omp/tools` from executing
 * arbitrary TS at startup before any gate exists (§8.2, adversarial-review
 * finding #2 — critical). A refactor that drops one of these must fail a
 * test, not ship silently.
 */
const OMP_REQUIRED_SPAWN_FLAGS = ['--approval-mode', '--no-extensions', '--no-skills'] as const;

/**
 * Map a cyboflow permission mode onto OMP's PTY-lane `--approval-mode`.
 *
 * Only two OMP values are ever used, never OMP's `write` tier: this lane has
 * no gating hook (unlike the future `omp-sdk` RPC lane, which applies
 * cyboflow's own predicate via a `tool_call` extension — proposal §5.3), so
 * there is nothing here to intercept a call OMP's own approval mode would
 * auto-allow. `write` auto-approves every write-tier tool, including OMP's
 * (over-broad) MCP classification — using it would silently widen cyboflow's
 * trust boundary to OMP's. Instead: `dontAsk` → `yolo` (the user explicitly
 * asked for no prompts), every other mode → `always-ask` (the user answers
 * approval prompts in the TUI they are already sitting in — that IS the
 * approval surface for this interactive lane, same explicit boundary
 * `codex-pty`'s approvals draw: they do not enter the review queue either).
 */
export function ompApprovalModeForMode(mode: PermissionMode): OmpApprovalMode {
  switch (mode) {
    case 'default':
    case 'acceptEdits':
    case 'auto':
      return 'always-ask';
    case 'dontAsk':
      return 'yolo';
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled OMP permission mode: ${_exhaustive}`);
    }
  }
}

/**
 * Throws if `args` is missing any of {@link OMP_REQUIRED_SPAWN_FLAGS}. Exported
 * (rather than kept module-private) specifically so the security invariant can
 * be unit-tested directly, independent of `buildCommandArgs`'s own call site —
 * a subclass override that REPLACES `buildCommandArgs` would otherwise bypass
 * the inline call and prove nothing.
 */
export function assertOmpRequiredSpawnFlags(args: readonly string[]): void {
  const missing = OMP_REQUIRED_SPAWN_FLAGS.filter((flag) => !args.includes(flag));
  if (missing.length > 0) {
    throw new Error(
      `[OMP] refusing to spawn: buildCommandArgs dropped required flag(s) ${missing.join(', ')}. This is the security invariant from docs/proposals/omp-provider-integration.md §8.1/§8.2 (explicit approval mode, discovery lockdown) — a refactor must not silently ship without them.`,
    );
  }
}

export class OmpPtyManager extends AbstractCliManager {
  private resolvedExecutablePath: string | null = null;
  private readonly panelRunIds = new Map<string, string>();
  private readonly ptyBacklog = new Map<string, string>();
  private readonly ptySpawnContext = new AsyncLocalStorage<OmpPtySpawnContext>();

  protected getCliToolName(): string {
    return 'OMP';
  }

  /** Vendor for the provider-access guard (Settings → Integrations). */
  protected getAgentProvider(): AgentProvider {
    return 'omp';
  }

  /**
   * Resolve the OMP CLI: an explicit custom path first, else
   * `findExecutableInPath('omp')`. Unlike {@link CodexPtyManager}, there is no
   * bundled-binary rung — v1 ships no vendored OMP distribution (proposal
   * §3.3: "No bundling in v1"), so PATH is the only real source. `customPath`
   * is shaped exactly like Codex's (and Claude's) so a later Settings field
   * (none exists yet — no `ompExecutablePath` config key today) plugs straight
   * in without touching this method.
   *
   * The version probe applies the floor+tested policy from `ompVersions.ts`:
   * a binary below `OMP_MIN_SUPPORTED_VERSION` is reported unavailable (with
   * its version still attached, so the UI can explain why) rather than
   * treated as usable.
   */
  protected async testCliAvailability(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    const configuredPath = customPath?.trim();

    getShellPath();
    const resolvedPath = configuredPath || findExecutableInPath('omp');
    if (!resolvedPath) {
      this.resolvedExecutablePath = null;
      return { available: false, error: 'omp executable not found in PATH' };
    }

    try {
      const probe = await this.probeVersion(resolvedPath);
      if (probe.usedNodeFallback) {
        this.markNeedsNodeFallback();
      }

      const verdict = evaluateOmpVersionPolicy(probe.version);
      if (!verdict.ok) {
        this.resolvedExecutablePath = null;
        const reason =
          verdict.reason === 'below-floor'
            ? `omp ${probe.version} is older than the minimum supported version ${OMP_MIN_SUPPORTED_VERSION}`
            : `could not parse omp version output "${probe.version}"`;
        return { available: false, error: reason, version: probe.version, path: resolvedPath };
      }
      if (verdict.aboveTested) {
        this.logger?.warn(
          `[OMP] detected version ${probe.version} is newer than the last version this integration was tested against (${OMP_TESTED_VERSION}); proceeding, but behavior beyond the tested version is unverified.`,
        );
      }

      this.resolvedExecutablePath = resolvedPath;
      return { available: true, version: probe.version, path: resolvedPath };
    } catch (err) {
      this.resolvedExecutablePath = null;
      return {
        available: false,
        error: `Failed to run "${resolvedPath} --version": ${err instanceof Error ? err.message : String(err)}`,
        path: resolvedPath,
      };
    }
  }

  /**
   * Probe `--version` with the SAME environment the spawn will use. Seam kept
   * protected so tests can drive availability without touching the real
   * filesystem or shelling out.
   */
  protected async probeVersion(executablePath: string): Promise<CliVersionProbeResult> {
    return probeCliVersion(executablePath, await this.getSystemEnvironment());
  }

  protected async getCliExecutablePath(): Promise<string> {
    if (this.resolvedExecutablePath) {
      return this.resolvedExecutablePath;
    }
    const availability = await this.testCliAvailability();
    if (!availability.available || !availability.path) {
      throw new Error(`OMP CLI not available: ${availability.error ?? 'unknown error'}`);
    }
    return availability.path;
  }

  /**
   * §5.2's PTY argv: `--approval-mode <mapped> --no-extensions --no-skills
   * [--model <selection>] [--continue] [-- <prompt>]`.
   *
   * No `--thinking` flag: effort is unsupported on this lane (RUNTIME_CAPABILITIES
   * — the PTY substrate has no turn-options channel to carry it, same reason
   * `CodexPtyManager` stores but never emits `reasoningEffort`; OMP's PTY lane
   * does not even store it, since there is nothing parity-worthy to preserve
   * yet). `options.model` is passed through VERBATIM — the selection arrives
   * already in OMP's canonical `<provider>/<id>` form, so there is no
   * per-provider alias resolution step (unlike Codex's
   * `resolveAgentModelAlias`).
   *
   * {@link assertOmpRequiredSpawnFlags} runs on every call, right before
   * returning — the §8.1/§8.2 security invariant as a spawn-time assertion,
   * not just a code-review convention.
   */
  protected buildCommandArgs(options: OmpPtySpawnOptions): string[] {
    const args: string[] = [];
    const mode = options.agentPermissionMode ?? this.resolveSessionAgentPermissionMode(options.sessionId, options.permissionMode);
    args.push('--approval-mode', ompApprovalModeForMode(mode));
    args.push('--no-extensions', '--no-skills');

    if (options.model && options.model.trim().length > 0) {
      args.push('--model', options.model);
    }

    if (options.isContinue) {
      args.push('--continue');
    }

    if (options.prompt.trim().length > 0) {
      args.push('--', options.prompt);
    }

    assertOmpRequiredSpawnFlags(args);
    return args;
  }

  protected parseCliOutput(data: string, panelId: string, sessionId: string): Array<{ panelId: string; sessionId: string; type: 'json' | 'stdout' | 'stderr'; data: unknown; timestamp: Date }> {
    return [{
      panelId,
      sessionId,
      type: 'stdout',
      data,
      timestamp: new Date(),
    }];
  }

  protected async initializeCliEnvironment(_options: OmpPtySpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async getCliEnvironment(_options: OmpPtySpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async cleanupCliResources(sessionId: string): Promise<void> {
    for (const [panelId, process] of this.processes.entries()) {
      if (process.sessionId !== sessionId) continue;
      const runId = this.panelRunIds.get(panelId);
      this.panelRunIds.delete(panelId);
      if (runId) {
        this.ptyBacklog.delete(runId);
      }
    }
  }

  override async spawnCliProcess(options: OmpPtySpawnOptions): Promise<void> {
    const runId = options.runId ?? options.panelId;
    this.panelRunIds.set(options.panelId, runId);
    try {
      await this.runWithPtySpawnContext(
        { panelId: options.panelId, sessionId: options.sessionId, runId },
        () => super.spawnCliProcess({ ...options, runId }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit('pty-output', {
        panelId: options.panelId,
        sessionId: options.sessionId,
        runId,
        type: 'pty',
        data: `\r\n\x1b[31mOMP failed to start: ${message}\x1b[0m\r\n`,
        timestamp: new Date(),
      });
      this.emit('exit', {
        panelId: options.panelId,
        sessionId: options.sessionId,
        exitCode: 1,
        signal: null,
      });
      this.panelRunIds.delete(options.panelId);
      this.ptyBacklog.delete(runId);
      throw err;
    }
  }

  protected override async spawnPtyProcess(command: string, args: string[], cwd: string, env: { [key: string]: string }): Promise<pty.IPty> {
    const ptyProcess = await super.spawnPtyProcess(command, args, cwd, env);
    const context = this.ptySpawnContext.getStore();
    if (context) {
      ptyProcess.onData((data: string) => {
        this.recordPtyBacklog(context.runId, data);
        this.emit('pty-output', {
          panelId: context.panelId,
          sessionId: context.sessionId,
          runId: context.runId,
          type: 'pty',
          data,
          timestamp: new Date(),
        });
      });
    }
    return ptyProcess;
  }

  async startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    permissionMode?: 'approve' | 'ignore',
    model?: string,
    runId?: string,
  ): Promise<void> {
    await this.spawnCliProcess({
      panelId,
      sessionId,
      worktreePath,
      prompt,
      permissionMode,
      agentPermissionMode: this.resolveSessionAgentPermissionMode(sessionId, permissionMode),
      model,
      runId,
    });
  }

  /**
   * Respawn with `--continue`, scoped to `worktreePath` as the OMP process
   * cwd. This is a REAL resume, unlike `CodexPtyManager.continuePanel` (which
   * kills and starts a blank conversation) — OMP persists sessions per-cwd
   * (`~/.omp/agent/sessions/<encoded-cwd>/…jsonl`, proposal fact §2.6) and
   * `--continue` picks up that worktree's most-recent session, so the prior
   * turns are genuinely still there for the model, not just visually replayed
   * in the terminal.
   */
  async continuePanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    _conversationHistory: ConversationMessage[],
    permissionMode?: 'approve' | 'ignore',
    model?: string,
  ): Promise<void> {
    await this.killProcess(panelId);
    await this.spawnCliProcess({
      panelId,
      sessionId,
      worktreePath,
      prompt,
      permissionMode,
      agentPermissionMode: this.resolveSessionAgentPermissionMode(sessionId, permissionMode),
      model,
      isContinue: true,
    });
  }

  relayUserTurn(panelId: string, input: string): void {
    this.sendInput(panelId, `${input}\r`);
  }

  relayRawInput(panelId: string, input: string): void {
    this.sendInput(panelId, input);
  }

  resizePanel(panelId: string, cols: number, rows: number): void {
    const process = this.getProcess(panelId);
    if (!process) return;
    process.process.resize(cols, rows);
  }

  getPtyBacklog(runId: string): string {
    return this.ptyBacklog.get(runId) ?? '';
  }

  async stopPanel(panelId: string): Promise<void> {
    const runId = this.panelRunIds.get(panelId);
    await this.killProcess(panelId);
    this.panelRunIds.delete(panelId);
    if (runId) {
      this.ptyBacklog.delete(runId);
    }
  }

  async restartPanelWithHistory(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    initialPrompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    await this.killProcess(panelId);
    const permissionMode = this.sessionManager.getDbSession(sessionId)?.permission_mode;
    await this.startPanel(panelId, sessionId, worktreePath, initialPrompt, permissionMode);
  }

  protected getCliNotAvailableMessage(error?: string): string {
    const interpreterAdvice = this.missingInterpreterAdvice(error);
    if (interpreterAdvice) {
      return [`Error: ${error}`, '', interpreterAdvice].join('\n');
    }
    if (error && /older than the minimum supported version/.test(error)) {
      return [
        `Error: ${error}`,
        '',
        'OMP is installed but too old for this integration. Update it with:',
        '  curl -fsSL https://omp.sh/install | sh',
        'or:',
        '  brew upgrade can1357/tap/omp',
      ].join('\n');
    }
    return [
      `Error: ${error}`,
      '',
      'OMP CLI is not available.',
      '',
      'Install OMP with:',
      '  curl -fsSL https://omp.sh/install | sh',
      'or:',
      '  brew install can1357/tap/omp',
      '',
      'Then verify `omp --version` works in your shell.',
    ].join('\n');
  }

  private resolveSessionAgentPermissionMode(
    sessionId: string,
    legacyPermissionMode?: 'approve' | 'ignore',
  ): PermissionMode {
    if (legacyPermissionMode === 'ignore') return 'dontAsk';
    const stored = this.sessionManager.getDbSession(sessionId)?.agent_permission_mode;
    if (isPermissionMode(stored)) return stored;
    return this.configManager?.getDefaultAgentPermissionMode() ?? 'default';
  }

  private recordPtyBacklog(runId: string, data: string): void {
    const next = (this.ptyBacklog.get(runId) ?? '') + data;
    this.ptyBacklog.set(
      runId,
      next.length > PTY_BACKLOG_CAP_BYTES ? next.slice(-PTY_BACKLOG_CAP_BYTES) : next,
    );
  }

  protected runWithPtySpawnContext<T>(
    context: OmpPtySpawnContext,
    operation: () => T,
  ): T {
    return this.ptySpawnContext.run(context, operation);
  }

  protected getActivePtySpawnContext(): OmpPtySpawnContext | undefined {
    return this.ptySpawnContext.getStore();
  }
}
