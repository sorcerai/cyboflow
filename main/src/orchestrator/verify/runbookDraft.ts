/**
 * The runbook-bootstrap drafting agent's OUTPUT CONTRACT
 * (docs/proposals/lane-runbook-bootstrap.md §8, §8.1).
 *
 * WHY THE AGENT'S OUTPUT IS A PARSED DATA STRUCTURE AND NOT A DIFF. v1 handed
 * the drafting agent `Write`/`Edit`/`Bash` in the shared lane worktree and
 * validated what it had already committed. Both adversarial reviews destroyed
 * that: a post-hoc guard sees only the committed diff — not deletions, not
 * ignored files, not what a sibling lane had staged and the bare `git commit`
 * swept in — and the files it was allowed to touch are EXECUTABLE, so "twenty
 * lines of config" can change the build entry or serve a canned attested
 * surface. v2 inverts the trust direction: the agent has no writing tool at all
 * and PROPOSES, in this shape, what it thinks should be written. Every mutation
 * is performed by the controller against a parsed or narrowly-matched target,
 * so the blast radius is what the proposal NAMES and nothing else.
 *
 * WHAT `NOT-POSSIBLE` MEANS HERE. It is a SUCCESS for the drafting agent, not a
 * failure — the honest answer for a project that cannot be stood up with levers
 * it already honors. The whole feature is allowed to convert "skipped" into
 * "actually ran"; it is never allowed to manufacture a pass, and an agent that
 * felt obliged to return *something* is exactly how it would. So the union has a
 * first-class member for it, the schema requires a reason, and the reason
 * reaches the human on the degrade path.
 *
 * PURE. No IO, no SDK, no DB — this module is the contract and its validator, so
 * the shapes can be tested exhaustively without deploying anything.
 */
import {
  parseVerifyRunbookV1,
  VERIFY_RUNBOOK_MODALITIES,
  type VerifyRunbookModality,
  type VerifyRunbookV1,
} from '../../../../shared/types/verifyRunbook';

/**
 * The RUNG-1 repo change, as a TYPED OPERATION rather than a diff (§8.1).
 *
 * There are exactly three, and the constraint that makes them safe(r) is not
 * their size: it is that each names a STRUCTURAL edit the controller performs
 * against a parsed or uniquely-matched target. "≤20 lines of config" was v1's
 * rule and it is a size limit, not a semantic one — size was never what made
 * v1's guard unsound. Anything the agent cannot express in these three (a new
 * plugin, an import, a changed build entry, a conditional) is
 * `NOT-POSSIBLE`, and that project goes to Verify Setup where a human designs
 * the change.
 *
 * §15A records that this path is REVIEW-BACKED rather than structurally safe:
 * a config file is executable and no validator short of understanding the
 * project can rule out a change altering what is built or served. The
 * compensating controls are all downstream of this type — a separate commit, the
 * artifact, and a finding that names the edited file — and they are the
 * guarantee, not decoration.
 */
export type Rung1Operation =
  /**
   * Add a NEW `scripts` key to the project's root `package.json`. Addition only
   * — an operation naming a script that already exists is a validation error,
   * never an overwrite, because overwriting `build` is precisely the "change
   * what gets built" hazard this rung is fenced against.
   *
   * There is no `file` parameter on purpose: the target is always the root
   * `package.json`, so there is no channel through which this operation could
   * be aimed at another file.
   */
  | { kind: 'add-script'; scriptName: string; command: string }
  /**
   * Replace a hardcoded port LITERAL with a read of an environment variable, at
   * the single site where that literal occurs. This is the lever the harness
   * actually needs: the scheduler leases a port per request and substitutes it,
   * and a project that hardcodes 5173 cannot honor the lease.
   */
  | { kind: 'port-from-env'; file: string; port: number; envVar: string }
  /**
   * Flip a `strictPort`-style boolean literal from `true` to `false`, so a dev
   * server offered a busy port falls forward instead of exiting. Named by its
   * setting rather than by a line number, and applied only when the setting
   * occurs exactly once.
   */
  | { kind: 'relax-strict-port'; file: string; setting: string };

/** The three operation discriminants, for iteration and validation messages. */
export const RUNG1_OPERATION_KINDS: readonly Rung1Operation['kind'][] = [
  'add-script',
  'port-from-env',
  'relax-strict-port',
] as const;

/**
 * What the drafting agent returns. `'not-possible'` carries the reason a human
 * reads on the degrade path; `'runbook'` carries the portable half for ONE
 * modality plus, optionally, the single rung-1 operation that makes it work.
 */
export type RunbookDraftResult =
  | {
      decision: 'runbook';
      modality: VerifyRunbookModality;
      runbook: VerifyRunbookV1;
      /** At most ONE, touching exactly one file (§8.1). */
      operation?: Rung1Operation;
      /** The agent's derivation notes, for the artifact. */
      notes?: string;
    }
  | { decision: 'not-possible'; reason: string };

export type ParsedRunbookDraft =
  | { ok: true; result: RunbookDraftResult }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the `operation` member. Returns the parsed operation, `null` when the
 * key is absent (the ordinary rung-0 case), or an error string.
 *
 * REJECTS AN UNKNOWN `kind` rather than ignoring it. An operation this build
 * does not understand is not "no operation" — the agent proposed a change it
 * believes is necessary, and silently dropping it would register a runbook whose
 * commands cannot work while reporting success.
 */
function parseOperation(value: unknown): { ok: true; operation: Rung1Operation | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, operation: null };
  if (!isRecord(value)) return { ok: false, error: 'operation: expected an object' };

  const kind = value.kind;
  if (kind === 'add-script') {
    if (!isNonEmptyString(value.scriptName)) {
      return { ok: false, error: 'operation.scriptName: expected a non-empty string' };
    }
    if (!isNonEmptyString(value.command)) {
      return { ok: false, error: 'operation.command: expected a non-empty string' };
    }
    return {
      ok: true,
      operation: { kind: 'add-script', scriptName: value.scriptName.trim(), command: value.command.trim() },
    };
  }
  if (kind === 'port-from-env') {
    if (!isNonEmptyString(value.file)) return { ok: false, error: 'operation.file: expected a non-empty string' };
    if (typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port <= 0) {
      return { ok: false, error: 'operation.port: expected a positive integer' };
    }
    if (!isNonEmptyString(value.envVar)) return { ok: false, error: 'operation.envVar: expected a non-empty string' };
    return {
      ok: true,
      operation: {
        kind: 'port-from-env',
        file: value.file.trim(),
        port: value.port,
        envVar: value.envVar.trim(),
      },
    };
  }
  if (kind === 'relax-strict-port') {
    if (!isNonEmptyString(value.file)) return { ok: false, error: 'operation.file: expected a non-empty string' };
    if (!isNonEmptyString(value.setting)) {
      return { ok: false, error: 'operation.setting: expected a non-empty string' };
    }
    return {
      ok: true,
      operation: { kind: 'relax-strict-port', file: value.file.trim(), setting: value.setting.trim() },
    };
  }
  return {
    ok: false,
    error: `operation.kind: expected one of ${RUNG1_OPERATION_KINDS.join(', ')} (got ${JSON.stringify(kind)})`,
  };
}

/**
 * Strict validator for whatever the drafting agent returned.
 *
 * Rejects on the FIRST structural problem, naming the offending path, in the
 * house style of `parseVerificationTaskV1` / `parseVerifyRunbookV1` — the error
 * reaches a log and the degrade finding, and "invalid draft" would tell nobody
 * anything. Unknown extra keys are tolerated at the top level for the same
 * forward-compat reason the sibling validators tolerate them; the members this
 * module acts on are all checked.
 *
 * The runbook half is delegated to `parseVerifyRunbookV1` rather than
 * re-implemented, so the file the controller is about to WRITE is validated by
 * the exact same parser the store uses when it later READS it. A draft that
 * passed here and failed at `registerDraft` would be a contract split with
 * nothing to gain.
 */
export function parseRunbookDraftResult(value: unknown): ParsedRunbookDraft {
  if (!isRecord(value)) return { ok: false, error: 'expected an object' };

  const decision = value.decision;
  if (decision === 'not-possible') {
    if (!isNonEmptyString(value.reason)) {
      // The reason is the ONLY thing a NOT-POSSIBLE draft produces, and it is
      // what the human reads instead of a verification. An empty one turns an
      // honest decline into an unexplained one.
      return { ok: false, error: 'reason: expected a non-empty string on a not-possible draft' };
    }
    return { ok: true, result: { decision: 'not-possible', reason: value.reason.trim() } };
  }
  if (decision !== 'runbook') {
    return { ok: false, error: `decision: expected 'runbook' or 'not-possible' (got ${JSON.stringify(decision)})` };
  }

  const modality = value.modality;
  if (typeof modality !== 'string' || !VERIFY_RUNBOOK_MODALITIES.includes(modality as VerifyRunbookModality)) {
    return {
      ok: false,
      error: `modality: expected one of ${VERIFY_RUNBOOK_MODALITIES.join(', ')} (got ${JSON.stringify(modality)})`,
    };
  }

  const parsed = parseVerifyRunbookV1(value.runbook);
  if (!parsed.ok) return { ok: false, error: `runbook: ${parsed.error}` };

  // A runbook that does not declare the modality it was drafted FOR would
  // register a record no execution path could satisfy — the store rejects it at
  // `registerDraft`, and catching it here means the controller never writes or
  // commits a file it is about to be told is useless.
  if (parsed.runbook.modalities[modality as VerifyRunbookModality] === undefined) {
    return { ok: false, error: `runbook: declares no "${modality}" modality, which is the one being drafted` };
  }

  const operation = parseOperation(value.operation);
  if (!operation.ok) return { ok: false, error: operation.error };

  const notes = isNonEmptyString(value.notes) ? value.notes.trim() : undefined;
  return {
    ok: true,
    result: {
      decision: 'runbook',
      modality: modality as VerifyRunbookModality,
      runbook: parsed.runbook,
      ...(operation.operation !== null ? { operation: operation.operation } : {}),
      ...(notes !== undefined ? { notes } : {}),
    },
  };
}

/**
 * The single file an operation touches — the thing the denylist is checked
 * against, the thing the finding names, and the thing the eval-diff excision
 * subtracts. `add-script` carries no `file` because its target is fixed; this is
 * where that fact is stated once rather than re-derived at each call site.
 */
export function targetFileForOperation(operation: Rung1Operation): string {
  return operation.kind === 'add-script' ? 'package.json' : operation.file;
}
