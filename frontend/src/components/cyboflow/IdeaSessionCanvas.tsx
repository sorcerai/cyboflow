/**
 * IdeaSessionCanvas — the home surface of an IDEA SESSION (the durable,
 * in-place session an idea's backlog card "Open" button lands on).
 *
 * The sibling of {@link QuickSessionCanvas}: same pane slot, same Paper-theme
 * node-canvas vocabulary (graph-paper backdrop, 1.4px ink-bordered white node
 * cards, dashed edges between them, wide-tracked uppercase eyebrows). Where the
 * quick canvas answers "what is this session doing?", this one answers "what
 * should this idea do next?":
 *
 *   idea node  →  four direction tiles  →  artifacts + activity
 *
 *   - Idea node: title, the backlog card's tag chips, and the five component
 *     ledger rows (the same `ledgerChipVisualState` the card chips use, so the
 *     two surfaces can never disagree about what "needs review" looks like).
 *   - Directions: Clarify / Design / Full planner / Ship, with the recommended
 *     next one accented. Which one that is — and which are greyed, and why —
 *     comes from the pure `deriveIdeaTileStates` helper, never from JSX
 *     conditionals here.
 *   - Artifacts node: one row per ledger component, linking out to the concrete
 *     deliverable a component was produced by. Those live in OTHER runs, so
 *     they open as EXTERNAL center-pane tabs (see `TabItem.external`).
 *   - Activity node: this session plus every session launched from the idea.
 *
 * Clarify runs IN this session (a chat turn, no run). Design / Planner / Ship
 * launch elsewhere — the design door and `runs.start` respectively — and the
 * server's `assertIdeaNotBusy` backstops the one-live-thing-per-idea rule that
 * the tile greying advertises.
 *
 * Styling note: `GRAPH_PAPER_BACKGROUND` is imported from WorkflowCanvas rather
 * than inlined (QuickSessionCanvas predates the export and still carries its own
 * copy — do not add a third). The node/edge primitives below are local
 * duplicates of QuickSessionCanvas's private ones; extracting them is a
 * cross-file refactor of a surface another lane owns, so v1 keeps them here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { trpc } from '../../trpc/client';
import { GRAPH_PAPER_BACKGROUND } from './WorkflowCanvas';
import { useIdeaSessionData } from '../../hooks/useIdeaSessionData';
import { useEnsureClaudePanel } from '../../hooks/useEnsureClaudePanel';
import { dispatchQuickSessionInput } from '../../hooks/useClaudePanel';
import { useLaunchWorkflow } from '../../hooks/useLaunchWorkflow';
import { useDesignLaunch } from '../../hooks/useDesignLaunch';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { isIdeaChildSessionActive } from '../../utils/ideaSessionGrouping';
import { TypeTag, PriorityTag, ScopeTag, ledgerChipVisualState } from '../Backlog/markers';
import type { LedgerChipVisualState } from '../Backlog/markers';
import {
  deriveIdeaTileStates,
  type IdeaTileKey,
  type IdeaTileState,
} from '../../utils/ideaTileStates';
import { buildClarifyKickoffPrompt } from '../../../../shared/types/ideaSessionKickoff';
import { TaskBatchPickerModal } from './TaskBatchPickerModal';
import { DEFAULT_SUBSTRATE } from '../../../../shared/types/substrate';
import {
  IDEA_COMPONENT_KEYS,
  IDEA_COMPONENT_LABELS,
} from '../../../../shared/types/ideaComponents';
import { ARTIFACT_COLORS } from '../../../../shared/types/artifacts';
import type { WorkflowRow } from '../../../../shared/types/workflows';
import type { IdeaArtifactLink } from '../../../../shared/types/ideaArtifacts';
import type { Session } from '../../types/session';

interface IdeaSessionCanvasProps {
  session: Session;
  projectId: number;
  /** The idea this session is the home of (`session.homeIdeaId`). */
  ideaId: string;
  /** The centerPaneStore key of the hosting pane (artifact tabs + the dock). */
  sessionKey: string;
}

// ---------------------------------------------------------------------------
// Local node/edge primitives — see the file header: duplicated from
// QuickSessionCanvas rather than extracted, since that file is owned elsewhere.
// ---------------------------------------------------------------------------

const NODE_BORDER = '1.4px solid var(--color-text-primary)';

/** Wide-tracked uppercase micro-label (the design's eyebrow). */
function Eyebrow({
  children,
  color = 'var(--color-text-tertiary)',
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color,
      }}
    >
      {children}
    </span>
  );
}

/** Dashed connector between two nodes (no ＋ chip — nothing is added here). */
function IdeaEdge() {
  return (
    <div
      aria-hidden
      data-testid="idea-session-edge"
      style={{
        flex: '0 0 44px',
        marginTop: 40,
        height: 1.4,
        background:
          'repeating-linear-gradient(90deg, var(--color-text-disabled) 0 5px, transparent 5px 10px)',
      }}
    />
  );
}

/** White node card with the ink border and a header strip. */
function NodeCard({
  title,
  width,
  testId,
  headerRight,
  accent,
  children,
}: {
  title: string;
  width: number;
  testId: string;
  headerRight?: React.ReactNode;
  /** Optional accent outline (the live/recommended treatment). */
  accent?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        width,
        flexShrink: 0,
        background: 'var(--color-surface-primary)',
        border: NODE_BORDER,
        ...(accent !== undefined ? { outline: `2px solid ${accent}`, outlineOffset: 2 } : {}),
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: 'var(--color-bg-secondary)',
          borderBottom: '1px solid var(--color-border-primary)',
        }}
      >
        <Eyebrow color="var(--color-text-primary)">{title}</Eyebrow>
        {headerRight !== undefined && <span style={{ marginLeft: 'auto' }}>{headerRight}</span>}
      </div>
      <div style={{ padding: '13px 14px' }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ledger + status vocabularies
// ---------------------------------------------------------------------------

/** Glyph + color per ledger visual state (markers.tsx owns the state itself). */
const LEDGER_GLYPH: Record<LedgerChipVisualState, { glyph: string; color: string }> = {
  complete: { glyph: '✓', color: 'var(--color-status-success)' },
  'needs-review': { glyph: '⟳', color: 'var(--color-status-warning)' },
  'not-started': { glyph: '·', color: 'var(--color-text-tertiary)' },
  skipped: { glyph: '⊘', color: 'var(--color-text-tertiary)' },
};

/**
 * Session status → dot color. A small local map rather than an import:
 * DraggableProjectTreeView's `statusDotClass` is private to that file (and this
 * surface only needs the handful of session statuses an idea's children reach).
 */
const STATUS_DOT_COLOR: Record<string, string> = {
  running: 'var(--color-phase-execute)',
  initializing: 'var(--color-status-info)',
  waiting: 'var(--color-status-warning)',
  awaiting_review: 'var(--color-status-warning)',
  awaiting_input: 'var(--color-status-warning)',
  paused: 'var(--color-status-warning)',
  stuck: 'var(--color-status-error)',
  error: 'var(--color-status-error)',
  failed: 'var(--color-status-error)',
  completed: 'var(--color-status-success)',
  completed_unviewed: 'var(--color-status-success)',
};

function statusDotColor(status: string): string {
  return STATUS_DOT_COLOR[status] ?? 'var(--color-text-tertiary)';
}

// ---------------------------------------------------------------------------
// Direction tiles
// ---------------------------------------------------------------------------

interface TileMeta {
  label: string;
  caption: string;
  dot: string;
}

const TILE_META: Record<IdeaTileKey, TileMeta> = {
  clarify: {
    label: 'Clarify',
    caption: 'Clarify high level requirements',
    dot: 'var(--color-phase-refine)',
  },
  design: {
    label: 'Design',
    caption: 'Create a draft design',
    // The design deliverable's own accent (the rust in the prototype family) —
    // reused so the tile and the artifact it produces read as the same thing.
    dot: ARTIFACT_COLORS['interactive-prototype'],
  },
  planner: {
    label: 'Plan',
    caption: 'Break down the feature into tasks',
    dot: 'var(--color-phase-plan)',
  },
  sprint: {
    label: 'Sprint',
    caption: 'Build the feature',
    dot: 'var(--color-phase-execute)',
  },
  ship: {
    label: 'Ship',
    caption: 'Plan and sprint combined',
    dot: 'var(--color-phase-execute)',
  },
};

function DirectionTile({
  state,
  busy,
  onClick,
}: {
  state: IdeaTileState;
  /** A launch/dispatch this tile fired is still in flight. */
  busy: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const meta = TILE_META[state.key];
  const inert = state.disabled || busy;
  return (
    <button
      type="button"
      data-testid={`idea-tile-${state.key}`}
      data-recommended={state.recommended ? 'true' : 'false'}
      disabled={inert}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        width: '100%',
        textAlign: 'left',
        padding: '9px 11px',
        background: 'var(--color-surface-primary)',
        border: state.recommended
          ? '1.4px solid var(--color-interactive-primary)'
          : `1px solid ${hovered && !inert ? 'var(--color-text-primary)' : 'var(--color-border-primary)'}`,
        boxShadow: hovered && !inert ? '0 2px 0 var(--color-text-primary)' : 'none',
        opacity: state.disabled ? 0.55 : 1,
        cursor: inert ? 'not-allowed' : 'pointer',
        transition: 'box-shadow .12s, border-color .12s',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ width: 6, height: 6, borderRadius: '50%', background: meta.dot, flexShrink: 0 }}
        />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          {meta.label}
        </span>
        {state.recommended && (
          <span
            data-testid={`idea-tile-${state.key}-recommended`}
            style={{
              marginLeft: 'auto',
              fontSize: 8.5,
              fontWeight: 700,
              letterSpacing: '.14em',
              textTransform: 'uppercase',
              color: 'var(--color-interactive-primary)',
              border: '1px solid var(--color-interactive-primary)',
              padding: '1px 5px',
              flexShrink: 0,
            }}
          >
            Recommended
          </span>
        )}
      </span>
      <span style={{ fontSize: 10, lineHeight: 1.4, color: 'var(--color-text-tertiary)' }}>
        {meta.caption}
      </span>
      {state.hint && (
        <span
          data-testid={`idea-tile-${state.key}-hint`}
          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-status-warning)' }}
        >
          {state.hint.text}
        </span>
      )}
      {state.disabled && state.disabledReason !== undefined && (
        <span
          data-testid={`idea-tile-${state.key}-reason`}
          style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}
        >
          {state.disabledReason}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// IdeaSessionCanvas
// ---------------------------------------------------------------------------

export function IdeaSessionCanvas({
  session,
  projectId,
  ideaId,
  sessionKey,
}: IdeaSessionCanvasProps) {
  const { idea, components, artifactLinks, readyTaskIds, loading } = useIdeaSessionData(
    ideaId,
    projectId,
  );

  // ── Liveness (the max-one-running-per-idea rule, UI half) ─────────────────
  // sessions.status is the BASE signal — activeRunsStore is lossy by
  // construction (it excludes the '__quick__' sentinel and drops rail-dismissed
  // rows), so it only ever ADDS a busy signal for a child whose session row has
  // not caught up yet. The store is init'd by the rail; this surface only reads.
  const sessions = useSessionStore((s) => s.sessions);
  const runsForProject = useActiveRunsStore((s) => s.runsByProject[projectId]);
  const children = useMemo(
    () => sessions.filter((s) => s.originIdeaId === ideaId && s.id !== session.id),
    [sessions, ideaId, session.id],
  );
  const clarifyActive = session.status === 'running';
  const anyLaunchedChildActive = useMemo(
    () => children.some((child) => isIdeaChildSessionActive(child, runsForProject)),
    [children, runsForProject],
  );

  const tiles = useMemo(
    () =>
      deriveIdeaTileStates(
        components,
        { clarifyActive, anyLaunchedChildActive },
        { hasReadyTasks: readyTaskIds.length > 0 },
      ),
    [components, clarifyActive, anyLaunchedChildActive, readyTaskIds],
  );

  // ── Actions ──────────────────────────────────────────────────────────────
  const [actionError, setActionError] = useState<string | null>(null);
  const [clarifying, setClarifying] = useState(false);

  const ensureClaudePanel = useEnsureClaudePanel(session, { logTag: 'IdeaSessionCanvas' });
  const { launch, isLaunching, error: launchError } = useLaunchWorkflow(projectId);
  const {
    launchDesign,
    isLaunching: isLaunchingDesign,
    error: designError,
  } = useDesignLaunch(projectId);

  // The workflow catalogue, read for real (never a hardcoded id) — the Planner
  // and Ship tiles resolve their row by name, exactly as QuickSessionCanvas's
  // chips do.
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    trpc.cyboflow.workflows.list
      .query({ projectId })
      .then((rows) => {
        if (!cancelled) setWorkflows(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn('[IdeaSessionCanvas] workflows.list failed:', err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /**
   * Clarify — a chat turn in THIS session, not a run. Ensure the Claude panel
   * (panels are deletable, so "it already exists" is not an invariant), send
   * the kickoff as a real visible user turn, then open the dock so the
   * interview the user just started is on screen.
   */
  const handleClarify = useCallback(() => {
    if (idea === null) return;
    setActionError(null);
    setClarifying(true);
    void (async () => {
      try {
        await ensureClaudePanel();
        const panel = (usePanelStore.getState().panels[session.id] ?? []).find(
          (p) => p.type === 'claude',
        );
        if (!panel) {
          setActionError('Could not open a chat panel for this session.');
          return;
        }
        const result = await dispatchQuickSessionInput(
          session,
          panel.id,
          buildClarifyKickoffPrompt(idea.ref),
          'continue',
        );
        if (!result.success) {
          setActionError(result.error ?? 'Failed to start the clarify interview.');
          return;
        }
        useCenterPaneStore.getState().setTerminalOpen(sessionKey, true);
      } catch (err: unknown) {
        setActionError(
          err instanceof Error ? err.message : 'Failed to start the clarify interview.',
        );
      } finally {
        setClarifying(false);
      }
    })();
  }, [idea, ensureClaudePanel, session, sessionKey]);

  const handleDesign = useCallback(() => {
    setActionError(null);
    void launchDesign(ideaId).catch((err: unknown) => {
      setActionError(err instanceof Error ? err.message : 'Failed to start a design session.');
    });
  }, [launchDesign, ideaId]);

  /**
   * Planner / Ship — the existing idea-seeded launch, always into a FRESH
   * worktree-backed session (this home session is in-place, so it can never
   * host a run). A server rejection (notably `idea_busy`) arrives as
   * useLaunchWorkflow's own `error`, which is surfaced below.
   */
  const handleRunLaunch = useCallback(
    (name: 'planner' | 'ship') => {
      setActionError(null);
      const row = workflows.find((w) => w.name === name);
      if (!row) {
        setActionError(`The ${name} workflow is not available in this project.`);
        return;
      }
      void launch(row.id, { ideaId }, { forceNewSession: true });
    },
    [workflows, launch, ideaId],
  );

  /**
   * Launch sprint — the batch picker first (pre-checked with the idea's ready
   * tasks, adjustable exactly like an epic Run from the backlog), then a
   * taskIds-seeded Sprint into a fresh worktree session. `originIdeaId` rides
   * along so the run's host session nests under this idea and trips the same
   * busy guard/greying as the other launched directions.
   */
  const [sprintPickerOpen, setSprintPickerOpen] = useState(false);
  const handleSprintPicked = useCallback(
    (taskIds: string[]) => {
      setSprintPickerOpen(false);
      setActionError(null);
      const row = workflows.find((w) => w.name === 'sprint');
      if (!row) {
        setActionError('The sprint workflow is not available in this project.');
        return;
      }
      void launch(row.id, { taskIds, originIdeaId: ideaId }, { forceNewSession: true });
    },
    [workflows, launch, ideaId],
  );

  const busyByTile: Record<IdeaTileKey, boolean> = {
    clarify: clarifying,
    design: isLaunchingDesign,
    planner: isLaunching,
    sprint: isLaunching,
    ship: isLaunching,
  };

  const onTileClick = (key: IdeaTileKey): void => {
    if (key === 'clarify') return handleClarify();
    if (key === 'design') return handleDesign();
    if (key === 'sprint') {
      setActionError(null);
      setSprintPickerOpen(true);
      return;
    }
    return handleRunLaunch(key === 'planner' ? 'planner' : 'ship');
  };

  // ── Artifact links ───────────────────────────────────────────────────────
  const openArtifactTab = useCenterPaneStore((s) => s.openArtifactTab);
  const openLink = useCallback(
    (link: IdeaArtifactLink) => {
      const art = link.artifact;
      if (art === null || art.artifactId === null) return;
      // EXTERNAL: the row belongs to the run that produced it, not this
      // session — the pane resolves it via artifacts.get and the tab-sync
      // prune loop leaves it alone.
      openArtifactTab(sessionKey, {
        atype: art.atype,
        label: art.label,
        artifactId: art.artifactId,
        runId: art.runId,
        committed: art.committed,
        external: true,
      });
    },
    [openArtifactTab, sessionKey],
  );

  // One error line for all four tiles. `launchError` is where a server
  // `idea_busy` rejection lands (useLaunchWorkflow's own surfacing — the
  // structured error's human-readable message); `designError` is the design
  // door's equivalent, which resolves rather than throws.
  const error = actionError ?? launchError ?? designError;
  const ref = idea?.ref ?? '';

  return (
    <div className="flex flex-col h-full bg-bg-primary" data-testid="idea-session-canvas">
      {/* ── Pane header — mirrors QuickSessionCanvas's meta row ─────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 10,
          color: 'var(--color-text-secondary)',
          padding: '7px 12px 6px',
          background: 'var(--color-bg-secondary)',
          borderBottom: '1px solid var(--color-border-primary)',
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
        data-testid="idea-session-canvas-header"
      >
        <Eyebrow color="var(--color-text-primary)">Idea session</Eyebrow>
        {ref !== '' && (
          <span style={{ color: 'var(--color-text-tertiary)' }} data-testid="idea-session-header-ref">
            · {ref}
          </span>
        )}
        {session.status === 'running' && (
          <span
            data-testid="idea-session-live-pill"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 9,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              fontWeight: 700,
              color: 'var(--color-phase-execute)',
              border: '1px solid var(--color-phase-execute)',
              padding: '1px 7px',
            }}
          >
            <span
              className="animate-pulse motion-reduce:animate-none"
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: 'var(--color-phase-execute)',
                display: 'inline-block',
              }}
            />
            live
          </span>
        )}
      </div>

      {/* ── Canvas body — graph paper, nodes joined by dashed edges ─────────── */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          alignItems: 'flex-start',
          padding: '26px 30px',
          background: GRAPH_PAPER_BACKGROUND,
        }}
        data-testid="idea-session-canvas-body"
      >
        {/* 1 · Idea node */}
        <NodeCard title="Idea" width={330} testId="idea-session-idea-node" headerRight={
          <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>{ref}</span>
        }>
          {idea === null ? (
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {loading ? 'Loading idea…' : 'This idea is no longer available.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                <TypeTag type={idea.type} />
                <PriorityTag priority={idea.priority} />
                {idea.scope !== null && <ScopeTag scope={idea.scope} />}
              </div>
              <div
                data-testid="idea-session-idea-title"
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: 1.35,
                  color: 'var(--color-text-primary)',
                  marginTop: 9,
                }}
              >
                {idea.title}
              </div>

              {/* Five ledger rows — always all five, so the block reads as a
                  checklist rather than a variable list. */}
              <div
                data-testid="idea-session-ledger"
                style={{
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: '1px solid var(--color-border-primary)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                }}
              >
                <Eyebrow>Components</Eyebrow>
                {IDEA_COMPONENT_KEYS.map((key) => {
                  const entry = components.find((c) => c.component === key);
                  const visual = entry ? ledgerChipVisualState(entry) : 'not-started';
                  const { glyph, color } = LEDGER_GLYPH[visual];
                  return (
                    <div
                      key={key}
                      data-testid={`idea-session-ledger-${key}`}
                      data-ledger-state={visual}
                      style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11 }}
                    >
                      <span style={{ color, fontWeight: 700, width: 10, flexShrink: 0 }}>
                        {glyph}
                      </span>
                      <span style={{ color: 'var(--color-text-secondary)' }}>
                        {IDEA_COMPONENT_LABELS[key]}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </NodeCard>

        <IdeaEdge />

        {/* 2 · Directions node */}
        <NodeCard title="Next direction" width={280} testId="idea-session-directions">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tiles.map((tile) => (
              <DirectionTile
                key={tile.key}
                state={tile}
                busy={busyByTile[tile.key]}
                onClick={() => onTileClick(tile.key)}
              />
            ))}
          </div>
          {error !== null && (
            <p
              role="alert"
              data-testid="idea-session-error"
              style={{ marginTop: 9, fontSize: 10, color: 'var(--color-status-error)' }}
            >
              {error}
            </p>
          )}
        </NodeCard>

        <IdeaEdge />

        {/* 3 · Artifacts + Activity — stacked right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flexShrink: 0 }}>
          <NodeCard title="Artifacts" width={260} testId="idea-session-artifacts">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {artifactLinks.length === 0 && (
                <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>
                  {loading ? 'Loading…' : 'Nothing produced yet.'}
                </span>
              )}
              {artifactLinks.map((link) => {
                const visual = ledgerChipVisualState(link);
                const { glyph, color } = LEDGER_GLYPH[visual];
                const openable = link.artifact !== null && link.artifact.artifactId !== null;
                return (
                  <div
                    key={link.component}
                    data-testid={`idea-session-artifact-${link.component}`}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      fontSize: 11,
                    }}
                  >
                    <span style={{ color, fontWeight: 700, width: 10, flexShrink: 0 }}>
                      {glyph}
                    </span>
                    <span style={{ color: 'var(--color-text-secondary)' }}>
                      {IDEA_COMPONENT_LABELS[link.component]}
                    </span>
                    {openable ? (
                      <button
                        type="button"
                        data-testid={`idea-session-artifact-open-${link.component}`}
                        onClick={() => openLink(link)}
                        style={{
                          marginLeft: 'auto',
                          fontSize: 10,
                          fontWeight: 700,
                          color: 'var(--color-interactive-primary)',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                        }}
                      >
                        open →
                      </button>
                    ) : (
                      <span
                        style={{
                          marginLeft: 'auto',
                          fontSize: 10,
                          color: 'var(--color-text-tertiary)',
                          borderBottom: '1px dashed var(--color-text-disabled)',
                        }}
                      >
                        not yet
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </NodeCard>

          <NodeCard title="Activity" width={260} testId="idea-session-activity">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                data-testid="idea-session-activity-home"
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: statusDotColor(session.status),
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    color: 'var(--color-text-primary)',
                    fontWeight: 700,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {session.name}
                </span>
                <span
                  style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--color-text-tertiary)' }}
                >
                  home
                </span>
              </div>
              {children.map((child) => (
                <div
                  key={child.id}
                  data-testid="idea-session-activity-child"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: statusDotColor(child.status),
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      color: 'var(--color-text-secondary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {child.name}
                  </span>
                </div>
              ))}
              {children.length === 0 && (
                <span style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}>
                  No sessions launched from this idea yet.
                </span>
              )}
            </div>
          </NodeCard>
        </div>
      </div>

      {/* Sprint batch picker — same modal + pre-selection contract as an epic
          Run from the backlog (pass a STABLE ids reference: readyTaskIds is
          hook state). */}
      {sprintPickerOpen && (
        <TaskBatchPickerModal
          isOpen
          projectId={projectId}
          substrate={DEFAULT_SUBSTRATE}
          preselectedTaskIds={readyTaskIds}
          onClose={() => setSprintPickerOpen(false)}
          onPicked={handleSprintPicked}
        />
      )}
    </div>
  );
}
