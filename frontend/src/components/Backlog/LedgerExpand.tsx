/**
 * LedgerExpand — the idea component ledger's inline detail strip, revealed by
 * TaskBody's `ledger-expand` toggle (ideas only; see TaskCard.tsx). One row
 * per tracked component (shared/types/ideaComponents.ts's IDEA_COMPONENT_KEYS,
 * in display order): its name, its resolved state, provenance text (when a
 * complete component was done; for a stale one, that prior work exists and
 * needs re-verification — the whole point of the staleness axis, see the
 * file's header comment), and a manual-override control wired to
 * `cyboflow.ideaComponents.setState`.
 *
 * Visual language mirrors WorkflowSummaryPanel's breakdown strip
 * (frontend/src/components/cyboflow/WorkflowSummaryPanel.tsx ~968-1042) — a
 * compact bordered per-row grid, not a modal.
 *
 * `setState` returns the full merged hybrid snapshot for the idea (mirrors
 * `IdeaComponentChangedEvent`'s payload), so a successful override updates
 * this strip immediately without waiting on a subscription round-trip. The
 * `components` prop still wins when its identity changes (a fresh task-list
 * fetch), via the sync effect below.
 */
import { useEffect, useState } from 'react';
import {
  IDEA_COMPONENT_KEYS,
  IDEA_COMPONENT_LABELS,
} from '../../../../shared/types/ideaComponents';
import type {
  IdeaComponentKey,
  IdeaComponentState,
  IdeaComponentStateValue,
} from '../../../../shared/types/ideaComponents';
import { trpc } from '../../trpc/client';
import { compactAgo } from './backlogSelectors';
import { ledgerChipVisualState, LEDGER_STATE_LABEL, type LedgerChipVisualState } from './markers';
import { ConfirmDialog } from '../ConfirmDialog';

interface LedgerExpandProps {
  ideaId: string;
  components: IdeaComponentState[];
  /** Compact "now" basis so all cards share one clock tick (mirrors TaskBody). */
  now: number;
}

/** A component with no ledger row yet — matches the 'derived'/not-started fallback (see resolveIdeaComponents.ts). */
function fallbackEntry(component: IdeaComponentKey): IdeaComponentState {
  return {
    component,
    state: 'incomplete',
    source: 'derived',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt: null,
    staleReason: null,
    updatedAt: null,
  };
}

function provenanceText(entry: IdeaComponentState, visual: LedgerChipVisualState, now: number): string {
  switch (visual) {
    case 'complete':
      return entry.updatedAt ? `Done ${compactAgo(entry.updatedAt, now)}` : 'Complete';
    case 'needs-review':
      // Explicit + legible: prior work exists, it just needs re-verification —
      // never let this read like "not started".
      return entry.staleReason
        ? `Needs review — ${entry.staleReason}`
        : 'Needs review — prior work exists, re-verify before trusting it';
    case 'skipped':
      return entry.updatedAt ? `Skipped ${compactAgo(entry.updatedAt, now)}` : 'Skipped';
    case 'not-started':
    default:
      return 'Not started';
  }
}

// Labelled for exactly what the write path does, not what a fourth visual
// state might suggest. `setComponentState` (ideaComponentRouter.ts) ALWAYS
// clears `stale_at`/`stale_reason` on an explicit write — an intentional
// invariant (every explicit set is a reaffirmation, see the router's own
// JSDoc), but its consequence is that a manual override can only ever
// PRODUCE 'not started', never 'needs review'. That state is flow/staleness
// -only (see shared/types/ideaComponents.ts's header) — there is no manual
// path to it, so the option must not claim to offer one.
const OVERRIDE_OPTIONS: { value: IdeaComponentStateValue; label: string }[] = [
  { value: 'incomplete', label: 'Not started' },
  { value: 'complete', label: 'Complete' },
  { value: 'skipped', label: 'Skipped' },
];

/**
 * Display-only `<select>` value for a row whose visual state is "needs review".
 *
 * A needs-review row is `state='incomplete'` PLUS a stale marker, so binding the
 * control to `entry.state` would park it on the "Not started" option — which both
 * misreports the row (the strip beside it says "Needs review") and makes the
 * demote-to-not-started transition UNSELECTABLE: re-picking the option a select
 * already sits on fires no `change` event in any browser, so the confirm below
 * could never open and the destructive write could never be requested. Binding to
 * this sentinel instead keeps the two distinguishable, so choosing "Not started"
 * is a real change. It is rendered as a DISABLED option (displayable, never
 * choosable) and only for rows that are actually stale — the ledger has three
 * states, and this is not a fourth one, just how the fourth VISUAL state shows up
 * in a control that writes `state`.
 */
const NEEDS_REVIEW_OPTION_VALUE = '__needs-review__';

export function LedgerExpand({ ideaId, components, now }: LedgerExpandProps): React.JSX.Element {
  const [rows, setRows] = useState<IdeaComponentState[]>(components);
  const [pending, setPending] = useState<IdeaComponentKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Staged confirmation for the one destructive override: demoting a row
  // that is CURRENTLY "needs review" to "Not started". The write path has no
  // way to keep the stale marker on an explicit set (see OVERRIDE_OPTIONS'
  // comment), so that specific transition silently discards "prior work
  // exists, re-verify it" — surface the loss instead of eating it quietly.
  // Holding the pending component (rather than committing on `onChange`)
  // also lets the native `<select>` snap back to `entry.state` on Cancel,
  // since its `value` stays controlled by the untouched row state.
  const [confirmDemote, setConfirmDemote] = useState<{ component: IdeaComponentKey; label: string; reason: string | null } | null>(
    null,
  );

  // The incoming prop wins on identity change (a fresh task fetch) — an
  // in-flight local override still shows immediately via the mutation's own
  // returned snapshot below.
  useEffect(() => {
    setRows(components);
  }, [components]);

  const handleOverride = async (component: IdeaComponentKey, state: IdeaComponentStateValue): Promise<void> => {
    setPending(component);
    setError(null);
    try {
      const updated = await trpc.cyboflow.ideaComponents.setState.mutate({ ideaId, component, state });
      setRows(updated);
    } catch {
      setError('Could not update — try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className="mt-1.5 rounded-card border border-border-tertiary bg-bg-tertiary/50 px-2 py-1"
      data-testid="ledger-expand-content"
      // stopPropagation: this strip sits inside draggable/clickable card ancestors.
      onClick={(e) => e.stopPropagation()}
    >
      {IDEA_COMPONENT_KEYS.map((key) => {
        const entry = rows.find((r) => r.component === key) ?? fallbackEntry(key);
        const visual = ledgerChipVisualState(entry);
        return (
          <div
            key={key}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border-tertiary/50 py-1 last:border-b-0"
            data-testid={`ledger-row-${key}`}
          >
            <div className="min-w-0">
              <div className="truncate text-[11px] font-medium text-text-primary">{IDEA_COMPONENT_LABELS[key]}</div>
              <div className="truncate text-[10px] text-text-tertiary">{provenanceText(entry, visual, now)}</div>
            </div>
            <span className="eyebrow whitespace-nowrap text-[9.5px] text-text-tertiary">
              {LEDGER_STATE_LABEL[visual]}
            </span>
            <select
              value={visual === 'needs-review' ? NEEDS_REVIEW_OPTION_VALUE : entry.state}
              disabled={pending === key}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                // Unreachable via the UI (the sentinel's option is disabled), but
                // it is never a state the write path accepts — refuse it rather
                // than casting it into an IdeaComponentStateValue.
                if (e.target.value === NEEDS_REVIEW_OPTION_VALUE) return;
                const nextState = e.target.value as IdeaComponentStateValue;
                // Gate the one destructive transition — see confirmDemote's
                // comment above — behind a confirm instead of committing it
                // straight away. Every other transition (including demoting
                // a NON-stale row, or moving to complete/skipped) commits
                // immediately, matching the prior behavior.
                if (visual === 'needs-review' && nextState === 'incomplete') {
                  setConfirmDemote({ component: key, label: IDEA_COMPONENT_LABELS[key], reason: entry.staleReason });
                  return;
                }
                void handleOverride(key, nextState);
              }}
              aria-label={`Override ${IDEA_COMPONENT_LABELS[key]} state`}
              data-testid={`ledger-override-${key}`}
              className="rounded-button border border-border-primary bg-surface-primary px-1 py-0.5 text-[10px] text-text-secondary disabled:opacity-50"
            >
              {visual === 'needs-review' && (
                <option value={NEEDS_REVIEW_OPTION_VALUE} disabled>
                  {LEDGER_STATE_LABEL['needs-review']}
                </option>
              )}
              {OVERRIDE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {error !== null && (
        <p role="alert" className="mt-1 text-[10px] text-status-error">
          {error}
        </p>
      )}
      {confirmDemote !== null && (
        <ConfirmDialog
          isOpen
          onClose={() => setConfirmDemote(null)}
          onConfirm={() => void handleOverride(confirmDemote.component, 'incomplete')}
          title={`Mark ${confirmDemote.label} as not started?`}
          message={
            `${confirmDemote.label} currently needs review — prior work exists` +
            (confirmDemote.reason ? ` (${confirmDemote.reason})` : '') +
            ` and is flagged for re-verification. The prior work itself is untouched, but this` +
            ` will discard that flag: the ledger will no longer show that anything was ever done here.`
          }
          confirmText="Mark not started"
        />
      )}
    </div>
  );
}
