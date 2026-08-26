/**
 * workflowMeta — pure metadata helper for the landing-experience workflow
 * picker (the "warm paper / monospace terminal" wizard).
 *
 * Projects the two tRPC list queries the wizard already fetches —
 * `cyboflow.workflows.list` (workflow rows: id / name / spec_json) and
 * `cyboflow.runs.list` (run-list rows: id / workflow_id / created_at) — into a
 * flat per-workflow card model the React wizard renders. No React, no tRPC
 * calls, no Node built-ins: a single pure function over the two row arrays so it
 * is trivially unit-testable.
 *
 * Step / phase counts come from `resolveWorkflowDefinition` (the same READ-path
 * resolver the canvas and the active-runs rail use): a row's `spec_json` wins,
 * else the built-in fallback for a `CyboflowWorkflowName`, else null → zero
 * counts (a custom flow with a missing/broken spec).
 */
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../../../shared/types/trpc';
import { resolveWorkflowDefinition } from '../../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Types inferred from the router output — never a local mirror.
// (Mirrors the alias pattern in stores/activeRunsStore.ts.)
// ---------------------------------------------------------------------------

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** A workflow row from `cyboflow.workflows.list` (has id, name, spec_json). */
export type WorkflowListRow = RouterOutputs['cyboflow']['workflows']['list'][number];

/** A run-list row from `cyboflow.runs.list` (has id, workflow_id, created_at). */
export type RunListRow = RouterOutputs['cyboflow']['runs']['list'][number];

/**
 * Flat card model for one workflow, consumed by the wizard's picker cards.
 */
export interface WorkflowCardMeta {
  /** Workflow row id (`workflows.id`). */
  id: string;
  /** Raw workflow name (e.g. `'sprint'`). */
  name: string;
  /** Display title (tight-cased), e.g. `'Sprint'`. */
  title: string;
  /** One-line description of what the flow does. `''` for unknown custom flows. */
  subtitle: string;
  /** Slash-command form shown as an eyebrow, e.g. `'/sprint'`. */
  slashCommand: string;
  /** True for the single default workflow ({@link DEFAULT_WORKFLOW_NAME}). */
  isDefault: boolean;
  /**
   * True for a SETUP flow ({@link SETUP_WORKFLOW_NAMES}) — one that configures
   * the project rather than doing project work, and therefore does not belong
   * in the wizard's "or run a workflow" list beside planner/sprint/ship.
   *
   * This is a PRESENTATION flag, deliberately not a registry filter. The
   * `__quick__` / legacy-name exclusions in `WorkflowRegistry.listByProject`
   * drop rows from `workflows.list` outright, which here would ALSO remove the
   * flow from the Workflows gallery/editor and break the active-runs rail's
   * `workflow_id → name` resolution (`activeRunsStore` builds its label map
   * from that same list). The row must stay listed; only the launcher hides it.
   *
   * Consumers must filter at the RENDER site, not on the meta array: the
   * wizard indexes `workflowMetas` by id on five other paths (launch, banner,
   * CTA label, planner check), and a setup flow launched from its own surface
   * still has to resolve its meta there.
   */
  hiddenFromLauncher: boolean;
  /** Total step count across all phases of the effective definition (0 if none). */
  stepCount: number;
  /** Phase count of the effective definition (0 if none). */
  phaseCount: number;
  /** ISO timestamp of the most recent run of this workflow, or null if never run. */
  lastUsedAt: string | null;
}

/** The workflow pre-selected by the wizard on open. */
export const DEFAULT_WORKFLOW_NAME = 'sprint';

/**
 * The visual-verification setup flow, launched from the Verify Queue's health
 * panel (docs/proposals/verification-setup-flow.md §6). Exported so the panel's
 * CTA and this module's hide-list name the same string — the launcher hides
 * exactly what that CTA is the entry point for, and two copies of the literal
 * could drift into a flow that is hidden with no way in.
 */
export const VERIFY_SETUP_WORKFLOW_NAME = 'verify-setup';

/**
 * Flows that configure the PROJECT rather than doing project work. They are
 * hidden from the wizard's flow list and launched from the surface they
 * configure — `verify-setup` from the Verify Queue, which is where a user who
 * needs it is already standing (docs/proposals/verification-setup-flow.md §6).
 *
 * Hiding a flow here removes it from the wizard, which is the launch path most
 * users would reach for. `slashCommand` on this model is a display eyebrow, not
 * a command registry — nothing dispatches on it — so the remaining ways in are
 * the flow's OWN surface and the Workflows gallery's Run action (which
 * preselects by unambiguous row id). A name added to this set MUST have an
 * affordance on its own surface, and that affordance must not be conditional on
 * state the flow itself is meant to repair.
 */
export const SETUP_WORKFLOW_NAMES: ReadonlySet<string> = new Set([VERIFY_SETUP_WORKFLOW_NAME]);

/**
 * The wizard's "or run a workflow" list: every meta EXCEPT the setup flows.
 *
 * A function rather than a filter written inline at the JSX, so the rule is
 * assertable without mounting the wizard — and so the render site cannot
 * quietly lose the filter while every test stays green.
 */
export function launcherWorkflowMetas(metas: WorkflowCardMeta[]): WorkflowCardMeta[] {
  return metas.filter((meta) => !meta.hiddenFromLauncher);
}

/**
 * Static one-line subtitles keyed by built-in workflow name. Custom flows fall
 * back to `''` (no canned description).
 */
const SUBTITLE_BY_NAME: Record<string, string> = {
  launch: 'Interview a brand-new project into a brief, an ordered idea set, and first epics and tasks.',
  planner: 'Idea → epics → tasks (plan + refine, no execute)',
  sprint: 'Parallel task fan-out → sprint review',
  compound: 'Mine merged work for learnings → tasks + review items',
  ship: 'Idea → epics → tasks → execute → integrate (planner + sprint, end to end)',
  'verify-setup': 'Derive → prove → persist this project\'s visual-verification runbook',
};

/**
 * Static display titles keyed by built-in workflow name. Custom flows fall back
 * to a title-cased rendering of the raw name.
 */
const TITLE_BY_NAME: Record<string, string> = {
  launch: 'Launch',
  planner: 'Planner',
  sprint: 'Sprint',
  compound: 'Compound',
  ship: 'Ship',
  'verify-setup': 'Verify Setup',
};

/** Title-case a raw workflow name for display when no static title exists. */
function titleCase(name: string): string {
  if (name.length === 0) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The display title for a raw workflow name — the static map, else the
 * title-cased name. Exported because surfaces that hold only the RAW name (the
 * top-bar WorkflowPicker, whose rows carry `name` and never build a
 * {@link WorkflowCardMeta}) still have to label a flow the way the wizard does.
 * {@link buildWorkflowMeta} calls it too, so the two can never drift.
 */
export function workflowTitleForName(name: string): string {
  return TITLE_BY_NAME[name] ?? titleCase(name);
}

/**
 * Build the per-workflow card models for the wizard.
 *
 * For each workflow row:
 *   - Resolve its effective definition (`spec_json` → built-in fallback → null).
 *   - `phaseCount` = number of phases; `stepCount` = total steps across phases;
 *     both 0 when resolution is null (custom flow, missing/broken spec).
 *   - `subtitle` / `title` come from the static maps (title falls back to
 *     title-cased name; subtitle falls back to `''`).
 *   - `lastUsedAt` = the newest `created_at` among runs whose `workflow_id`
 *     matches this row's id, or null when the workflow has no runs.
 *   - `hiddenFromLauncher` = the row names a {@link SETUP_WORKFLOW_NAMES} flow.
 *
 * Every row is returned, hidden ones included — this builds the full model and
 * the launcher filters it. See {@link WorkflowCardMeta.hiddenFromLauncher}.
 */
export function buildWorkflowMeta(
  rows: WorkflowListRow[],
  runs: RunListRow[],
): WorkflowCardMeta[] {
  return rows.map((row) => {
    const def = resolveWorkflowDefinition(row.name, row.spec_json);
    const phaseCount = def ? def.phases.length : 0;
    const stepCount = def
      ? def.phases.reduce((sum, phase) => sum + phase.steps.length, 0)
      : 0;

    let lastUsedAt: string | null = null;
    for (const run of runs) {
      if (run.workflow_id !== row.id) continue;
      if (lastUsedAt === null || run.created_at > lastUsedAt) {
        lastUsedAt = run.created_at;
      }
    }

    return {
      id: row.id,
      name: row.name,
      title: workflowTitleForName(row.name),
      subtitle: SUBTITLE_BY_NAME[row.name] ?? '',
      slashCommand: `/${row.name}`,
      isDefault: row.name === DEFAULT_WORKFLOW_NAME,
      hiddenFromLauncher: SETUP_WORKFLOW_NAMES.has(row.name),
      stepCount,
      phaseCount,
      lastUsedAt,
    };
  });
}
