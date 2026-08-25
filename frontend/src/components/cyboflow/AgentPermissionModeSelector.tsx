/**
 * AgentPermissionModeSelector — the 4-button agent-permission picker, mirroring
 * the global control in Settings.tsx. Presentational (controlled value/onChange);
 * the seed-from-global + touched-guard state lives in each caller's own
 * `useSeededSelection` (frontend/src/hooks/useSeededSelection.ts), keyed per run
 * type.
 *
 * Shared by WorkflowPicker (legacy modal) and SessionStartWizard step 3 so the
 * options + button markup are single-sourced (no drift in labels/hints/styling).
 */
import type { PermissionMode } from '../../../../shared/types/workflows';
import type { AgentProvider, SessionAgentRuntime } from '../../../../shared/types/agentRuntime';

/**
 * The session agent-permission options. Selecting one writes the host session's
 * sessions.agent_permission_mode: directly for a quick session, and — when an
 * explicit mode is supplied at launch — permanently for a workflow run's host
 * session too (the launch still stamps workflow_runs.permission_mode_snapshot as a
 * launch-time audit value that may diverge). The session column is the sole
 * execution authority.
 */
type PermissionModeOption = Readonly<{ id: PermissionMode; label: string; hint: string }>;

export const PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption> = [
  { id: 'default', label: 'Ask before edits', hint: 'Prompt for each edit' },
  { id: 'acceptEdits', label: 'Allow edits', hint: 'Auto-allow edits, safe reads & git' },
  { id: 'auto', label: 'Auto', hint: 'Native Claude classifier' },
  { id: 'dontAsk', label: "Don't ask", hint: 'No prompts · skip permissions' },
];

const CODEX_SDK_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption> = [
  { id: 'default', label: 'Ask before edits', hint: 'Read-only · asks to write' },
  { id: 'acceptEdits', label: 'Allow edits', hint: 'Workspace writes · asks when needed' },
  { id: 'auto', label: 'Auto', hint: 'Workspace writes · Codex auto-reviews' },
  { id: 'dontAsk', label: "Don't ask", hint: 'Full access · approvals off' },
];

const CODEX_PTY_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption> = [
  { id: 'default', label: 'Ask before edits', hint: 'Read-only · asks to write' },
  { id: 'acceptEdits', label: 'Allow edits', hint: 'Workspace writes · asks when needed' },
  { id: 'auto', label: 'Auto', hint: 'Currently same as Allow edits' },
  { id: 'dontAsk', label: "Don't ask", hint: 'Full access · approvals off' },
];

/**
 * OMP's structured lane has no approval classifier of its own, so Cyboflow's own
 * PreToolUse gate is what decides and all four modes route the same way; they
 * differ in what that gate auto-allows.
 *
 * `auto` is the one that inverts the gate's posture — allow unless the call
 * trips a hazard list, rather than ask unless it is provably safe — which is
 * what makes it the stand-in for Claude's native auto classifier. The hint says
 * "allow unless risky" rather than the old "Same routing · fewer prompts",
 * which described the routing accurately and the ALLOWANCE not at all: `auto`
 * used to be `acceptEdits` plus permission rules, so every ordinary build
 * command still prompted.
 *
 * `dontAsk` is the one mode that hands the decision to OMP — whose own default
 * is approval-free ("yolo"), which is why it is spelled out rather than sharing
 * Claude's milder "No prompts · skip permissions".
 */
const OMP_SDK_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption> = [
  { id: 'default', label: 'Ask before edits', hint: 'Prompt for each edit' },
  { id: 'acceptEdits', label: 'Allow edits', hint: 'Auto-allow edits, safe reads & git' },
  { id: 'auto', label: 'Auto', hint: 'Allow unless risky · asks for hazards' },
  { id: 'dontAsk', label: "Don't ask", hint: 'OMP runs approval-free (yolo)' },
];

/**
 * The OMP TUI owns its own approval prompts, exactly as the Codex one does, so
 * the modes here are CLI flags rather than gate policy and nothing reaches the
 * Cyboflow review queue.
 */
const OMP_PTY_PERMISSION_MODE_OPTIONS: ReadonlyArray<PermissionModeOption> = [
  { id: 'default', label: 'Ask before edits', hint: 'Read-only · asks to write' },
  { id: 'acceptEdits', label: 'Allow edits', hint: 'Workspace writes · asks when needed' },
  { id: 'auto', label: 'Auto', hint: 'Currently same as Allow edits' },
  { id: 'dontAsk', label: "Don't ask", hint: 'Full access · approvals off' },
];

function permissionModeOptionsForProvider(
  agentProvider: AgentProvider,
  agentRuntime?: SessionAgentRuntime,
): ReadonlyArray<PermissionModeOption> {
  if (agentProvider === 'codex') {
    return agentRuntime === 'codex-pty'
      ? CODEX_PTY_PERMISSION_MODE_OPTIONS
      : CODEX_SDK_PERMISSION_MODE_OPTIONS;
  }
  // Mirrors the Codex arm, including its default: an OMP session whose runtime
  // prop is absent gets the structured set, not the terminal one.
  if (agentProvider === 'omp') {
    return agentRuntime === 'omp-pty'
      ? OMP_PTY_PERMISSION_MODE_OPTIONS
      : OMP_SDK_PERMISSION_MODE_OPTIONS;
  }
  return PERMISSION_MODE_OPTIONS;
}

interface AgentPermissionModeSelectorProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  /** Provider whose runtime will execute the next launch/message. */
  agentProvider?: AgentProvider;
  /** Distinguishes structured Codex auto-review from Codex PTY CLI flags. */
  agentRuntime?: SessionAgentRuntime;
  /** Heading text above the buttons; pass null to omit the heading. */
  label?: string | null;
  /** Extra classes on the wrapper. */
  className?: string;
}

export function AgentPermissionModeSelector({
  value,
  onChange,
  agentProvider = 'claude',
  agentRuntime,
  label = 'Session permission',
  className,
}: AgentPermissionModeSelectorProps): React.JSX.Element {
  const options = permissionModeOptionsForProvider(agentProvider, agentRuntime);

  return (
    <div className={`flex flex-col gap-1.5${className ? ` ${className}` : ''}`}>
      {label !== null && <span className="text-xs font-medium text-text-secondary">{label}</span>}
      {options.map(({ id, label: optLabel, hint }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          aria-pressed={value === id}
          aria-label={`Permission mode: ${optLabel}`}
          className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
            value === id
              ? 'border-interactive bg-interactive-surface'
              : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
          }`}
        >
          <span className="text-text-primary font-medium text-sm">{optLabel}</span>
          <span className="text-xs text-text-tertiary">{hint}</span>
        </button>
      ))}
      {agentProvider === 'codex' && (
        <p className="text-xs text-text-tertiary">
          {agentRuntime === 'codex-pty'
            ? 'Codex prompts appear in its terminal; they do not enter the Cyboflow review queue.'
            : 'Auto lets Codex review approval requests; other requested approvals use the Cyboflow review queue.'}
        </p>
      )}
      {agentProvider === 'omp' && (
        <p className="text-xs text-text-tertiary">
          {agentRuntime === 'omp-pty'
            ? 'OMP prompts appear in its terminal; they do not enter the Cyboflow review queue.'
            : "Cyboflow's own gate decides these; requests appear in the review queue. Don't ask hands the decision to OMP, which runs approval-free."}
        </p>
      )}
    </div>
  );
}
