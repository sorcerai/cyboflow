/**
 * useDesignLaunch — shared Design-tile launcher: start a Claude-SDK-pinned
 * quick session bound to an idea, auto-fire its kickoff turn, and drop
 * straight into the fullscreen design surface.
 *
 * Extracted from SessionStartWizard.tsx's `launchDesign` (idea sessions plan,
 * Stage 4/5 "useDesignLaunch extraction") so the wizard's Design card and the
 * idea canvas's Design tile (IdeaSessionCanvas, a separate lane) share ONE
 * implementation instead of two hand-kept copies. Hard-pins the exact same
 * design security boundary the wizard's inline version pinned: substrate
 * 'sdk', agentProvider 'claude', agentRuntime 'claude-sdk' — the MCP scope
 * mechanism that limits a design session's toolset exists only on that path
 * (design-mode.md "Session plumbing") — plus DESIGN_KICKOFF_PROMPT as the
 * auto-started first turn and `ideaId` threaded as `designIdeaId` so the
 * server can validate ownership and stamp sessions.design_idea_id.
 *
 * `overrides` (all optional, second arg of `launchDesign`) let a caller with
 * LIVE user-configured launch settings of its own — today only
 * SessionStartWizard's ③ Configure step, which exposes an agent-permission
 * override + model pin for the Design card, plus the shared "Advanced"
 * section (MCP deny / plugin selection / workspace override) for quick +
 * ultracode — thread their EXACT current values through, so the wizard's
 * design launch keeps resolving parameters byte-identically after this
 * extraction (moved, not rewritten: SessionStartWizard.tsx still owns and
 * computes every one of these values itself; this hook only accepts them).
 * A caller with no Configure UI of its own (the idea canvas's Design tile)
 * omits `overrides` entirely and gets this hook's own resolved defaults —
 * the SAME stored-`quick`-default -> global-config-default -> floor ladder
 * `useQuickSession.startWithDefaults` and `useTaskRunLauncher` already use —
 * a normal one-click launch.
 *
 * The `overrides` parameter (and the `error` field on the return value, used
 * to surface a design-door rejection such as the idea-busy guard) sit OUTSIDE
 * the plan's minimal `{ launchDesign: (ideaId: string) => Promise<void>;
 * isLaunching: boolean }` contract another lane codes against — but purely
 * additively: `overrides` is optional, so a caller that only ever passes
 * `ideaId` is unaffected, and TypeScript's structural typing means that lane
 * can still destructure just `{ launchDesign, isLaunching }` and never see it.
 *
 * Owns its OWN `useQuickSession` instance, used for nothing but design
 * launches — unlike the wizard's original single instance (shared with quick
 * + ultracode, and gated by an `isDesignLaunchRef` flag so ITS ONE `onSuccess`
 * could tell a design success apart from the other two). Every success on
 * THIS dedicated instance is, by construction, a design launch, so
 * `onSuccess` here calls `enterDesignMode` unconditionally — no gate is
 * needed to tell it apart from anything else.
 *
 * A caller with its own post-launch side effects (SessionStartWizard's
 * success toast + onboarding telemetry + navigation — none of which belong in
 * a hook shared with a caller that has no wizard UI of its own) passes
 * `overrides.onSuccess`. It rides the SAME race-free pattern the wizard's
 * original `isDesignLaunchRef` used: stashed in a ref set synchronously,
 * BEFORE `start` is invoked, in the same tick `launchDesign` runs — so it
 * survives to the async success callback without depending on a stale
 * closure — then read and cleared the moment that callback fires, right
 * after `enterDesignMode`, preserving the original ordering.
 *
 * `launchDesign` never rejects; a failure lands in `error` instead (mirrors
 * every other launch hook in this codebase — useQuickSession,
 * useTaskRunLauncher). A design-door server rejection (e.g. the idea-busy
 * guard) arrives as an ordinary `createQuick` failure and surfaces here
 * exactly the way any other create-quick error does.
 */
import { useCallback, useRef } from 'react';
import { useQuickSession } from './useQuickSession';
import { useConfigStore } from '../stores/configStore';
import { useDesignModeStore } from '../stores/designModeStore';
import {
  QUICK_RUN_TYPE_KEY,
  resolveRunTypeLaunchDefaults,
  type RunTypeLaunchGlobals,
} from '../../../shared/types/sessionDefaults';
import { DESIGN_KICKOFF_PROMPT } from '../../../shared/types/designKickoff';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import type { ReasoningEffort } from '../../../shared/types/reasoningEffort';

/**
 * Live Configure-step values a caller with its own launch UI threads through
 * so its design launch keeps resolving parameters EXACTLY as it did before
 * the extraction. Every field is optional; an omitted field falls back to
 * this hook's own resolved default (see the file header).
 */
export interface DesignLaunchOverrides {
  permissionMode?: PermissionMode;
  model?: string;
  fastMode?: boolean;
  disabledMcpServers?: string[];
  /** Already the diffed-against-baseline selection (`undefined` = inherit). */
  enabledPlugins?: string[];
  /** Already resolved off the wizard's 'inherit' sentinel (`undefined` = inherit). */
  worktreeModeOverride?: QuickSessionWorktreeMode;
  reasoningEffort?: ReasoningEffort;
  /**
   * Extra success side effect a caller with its own launch UI wants to run
   * AFTER `enterDesignMode` fires — e.g. SessionStartWizard's launch toast,
   * onboarding telemetry, and post-launch navigation. Invoked with the new
   * (or reused) session's id.
   */
  onSuccess?: (sessionId: string) => void;
}

export interface UseDesignLaunchResult {
  /**
   * `overrides` is optional and additive over the plan's minimal
   * `(ideaId: string) => Promise<void>` contract text — a caller that only
   * ever passes `ideaId` (the idea canvas's Design tile) is unaffected.
   */
  launchDesign: (ideaId: string, overrides?: DesignLaunchOverrides) => Promise<void>;
  isLaunching: boolean;
  /**
   * Last launch failure, or null. Not part of the plan's minimal contract
   * text, but required by it in substance ("make sure the hook surfaces the
   * server error message") — a caller that only destructures `launchDesign`/
   * `isLaunching` is unaffected by this extra field.
   */
  error: string | null;
}

export function useDesignLaunch(projectId: number | null): UseDesignLaunchResult {
  // See the file header — set synchronously in launchDesign, BEFORE start is
  // invoked, and consumed+cleared in onSuccess right after enterDesignMode.
  const pendingOnSuccessRef = useRef<((sessionId: string) => void) | null>(null);

  const {
    start,
    isStarting,
    error,
  } = useQuickSession({
    projectId,
    onSuccess: (sessionId) => {
      useDesignModeStore.getState().enterDesignMode(sessionId);
      const extra = pendingOnSuccessRef.current;
      pendingOnSuccessRef.current = null;
      extra?.(sessionId);
    },
  });

  const launchDesign = useCallback(
    (ideaId: string, overrides?: DesignLaunchOverrides): Promise<void> => {
      // Set BEFORE invoking start — see the file header's race-free reasoning.
      pendingOnSuccessRef.current = overrides?.onSuccess ?? null;
      // No override supplied (the idea canvas's one-click Design tile) — resolve
      // this hook's own sensible defaults through the SAME ladder every other
      // un-configured launch surface uses, rather than sending `undefined` and
      // hoping the server's own floor matches.
      let permissionMode = overrides?.permissionMode;
      let model = overrides?.model;
      if (overrides === undefined) {
        const config = useConfigStore.getState().config;
        const globals: RunTypeLaunchGlobals = {
          ...(config?.defaultAgentPermissionMode !== undefined
            ? { permissionMode: config.defaultAgentPermissionMode }
            : {}),
          ...(config?.defaultLaunchModel?.trim()
            ? { model: config.defaultLaunchModel.trim() }
            : {}),
        };
        const resolved = resolveRunTypeLaunchDefaults(QUICK_RUN_TYPE_KEY, config?.runTypeDefaults, globals);
        permissionMode = resolved.permissionMode;
        model = resolved.model;
      }
      return start(
        permissionMode,
        'sdk',
        undefined,
        model,
        overrides?.fastMode,
        overrides?.disabledMcpServers,
        overrides?.enabledPlugins,
        overrides?.worktreeModeOverride,
        'claude',
        'claude-sdk',
        overrides?.reasoningEffort,
        ideaId,
        DESIGN_KICKOFF_PROMPT,
      );
    },
    [start],
  );

  return { launchDesign, isLaunching: isStarting, error };
}
