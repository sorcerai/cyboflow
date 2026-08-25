/**
 * ideaArtifacts — resolve, for one idea, the idea component ledger's FIVE
 * components each against the concrete artifact (if any) that backs it. The
 * read model behind `cyboflow.artifacts.listForIdea`.
 *
 * Layers on `resolveIdeaComponents` (the ledger's hybrid read model,
 * migration 101) rather than re-deriving anything: for each of the five
 * components, when the ledger names a `sourceRunId`, this module resolves
 * that run's artifacts (via the injected `listForRun` — see
 * {@link IdeaArtifactsDeps}) and maps the component to its concrete atype —
 * idea-spec/arch-design keyed on `source_ref = ideaId` (per-entity atypes);
 * prototype/epics/stories are RUN-SCOPED (one artifact per run, no
 * per-entity filtering). `sourceRunId === null` is the COMMON case (a
 * derived/never-touched component, or most manual overrides — see
 * `resolveIdeaComponents`'s header) and resolves to `artifact: null`
 * immediately, same as every other miss — never an error.
 *
 * DEPENDENCY-INJECTED (`db` + `listForRun`) rather than reaching for the
 * `ArtifactRouter` singleton directly, mirroring `stepTransitionBridge.ts` /
 * `autoMintArtifacts.ts`'s `DatabaseLike`-only discipline — this module is
 * unit-testable with a fake `listForRun` and an in-memory DB, no
 * `ArtifactRouter` boot required.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import type { DatabaseLike } from './types';
import { resolveIdeaComponents } from './ideaComponents/resolveIdeaComponents';
import type { IdeaComponentKey } from '../../../shared/types/ideaComponents';
import type { Artifact, ArtifactType } from '../../../shared/types/artifacts';
import { isCombinedBatchArtifact } from '../../../shared/types/artifacts';
import type { IdeaArtifactLink } from '../../../shared/types/ideaArtifacts';

/**
 * Injected collaborators. `listForRun` mirrors
 * `ArtifactRouter.listForRun`'s signature exactly — production wiring passes
 * `(pid, rid, committed) => ArtifactRouter.getInstance().listForRun(pid, rid, committed)`
 * — so this module never imports the router singleton itself.
 */
export interface IdeaArtifactsDeps {
  db: DatabaseLike;
  listForRun: (projectId: number, runId: string, committed?: boolean) => Promise<Artifact[]>;
}

/**
 * Component -> atype for the two PER-ENTITY atypes (identity includes
 * `source_ref = ideaId`; migrations 063/073). `prototype`/`epics`/`stories`
 * are handled separately below — they carry no per-entity filtering at all.
 */
const PER_ENTITY_COMPONENT_ATYPE: Partial<Record<IdeaComponentKey, ArtifactType>> = {
  'idea-spec': 'idea-spec',
  architecture: 'arch-design',
};

/**
 * `epics` and `stories` both resolve to the SAME run-wide 'decomposed-stories'
 * tab (one artifact per run, not per component, not per entity — see
 * autoMintArtifacts.ts's `mintDecomposedStoriesForIdea`).
 */
const RUN_WIDE_COMPONENT_ATYPE: Partial<Record<IdeaComponentKey, ArtifactType>> = {
  epics: 'decomposed-stories',
  stories: 'decomposed-stories',
};

/**
 * `prototype` preference order: `interactive-prototype` (Design Mode's
 * JS-enabled canvas) wins over the static `ui-prototype` when a run happens
 * to carry both.
 */
const PROTOTYPE_ATYPES: ArtifactType[] = ['interactive-prototype', 'ui-prototype'];

/** Project an `Artifact` down to the link's `artifact` shape. */
function shapeLink(a: Artifact): NonNullable<IdeaArtifactLink['artifact']> {
  return { runId: a.runId, artifactId: a.id, atype: a.atype, committed: a.committed, label: a.label };
}

/**
 * Resolve one component's concrete artifact out of a run's ALREADY-FETCHED
 * artifact list. `ideaId` only matters for the per-entity atypes
 * (idea-spec/arch-design); the run-wide atypes ignore it.
 */
function resolveComponentArtifact(
  component: IdeaComponentKey,
  ideaId: string,
  artifacts: readonly Artifact[],
): Artifact | null {
  const perEntityAtype = PER_ENTITY_COMPONENT_ATYPE[component];
  if (perEntityAtype !== undefined) {
    const direct = artifacts.find((a) => a.atype === perEntityAtype && a.sourceRef === ideaId);
    if (direct) return direct;
    // Multi-idea planner batch: idea-spec ONLY collapses N per-idea tabs into
    // ONE run-scoped combined tab anchored on the batch's FIRST idea's
    // source_ref (COMBINED_BATCH_PAYLOAD_JSON — shared/types/artifacts.ts).
    // A non-first idea in that batch has no direct source_ref hit, but its
    // spec content still lives in the combined document. arch-design has no
    // combined form (mintArchDesignForOwnedIdeas always mints per-idea), so
    // this fallback only ever fires for idea-spec.
    if (perEntityAtype === 'idea-spec') {
      return artifacts.find((a) => a.atype === 'idea-spec' && isCombinedBatchArtifact(a.payloadJson)) ?? null;
    }
    return null;
  }

  const runWideAtype = RUN_WIDE_COMPONENT_ATYPE[component];
  if (runWideAtype !== undefined) {
    return artifacts.find((a) => a.atype === runWideAtype) ?? null;
  }

  // component === 'prototype': interactive-prototype preferred over ui-prototype.
  for (const atype of PROTOTYPE_ATYPES) {
    const found = artifacts.find((a) => a.atype === atype);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve `ideaId`'s five ledger components each against the concrete
 * artifact (if any) backing it — `cyboflow.artifacts.listForIdea`'s read
 * model.
 *
 * For every component: `sourceRunId === null` resolves to `artifact: null`
 * immediately, no lookup attempted. A non-null `sourceRunId` is resolved to a
 * `workflow_runs` row and checked against `projectId` — an unknown run, or
 * one belonging to a DIFFERENT project, is treated exactly like "absent"
 * (never thrown; the cross-project guard `docs/CODE-PATTERNS.md` calls out as
 * unasserted on read paths). At most ONE `listForRun` call is issued per
 * DISTINCT valid run across all five components (results cached), then each
 * component maps to its atype (see the module-level tables above) and a miss
 * resolves to `artifact: null`.
 */
export async function listIdeaArtifactLinks(
  deps: IdeaArtifactsDeps,
  projectId: number,
  ideaId: string,
): Promise<IdeaArtifactLink[]> {
  const states = resolveIdeaComponents(deps.db, ideaId);

  // Resolve run validity + fetch artifacts ONCE per distinct non-null
  // sourceRunId, before mapping any component.
  const runIds = [...new Set(states.map((s) => s.sourceRunId).filter((id): id is string => id !== null))];
  const artifactsByRun = new Map<string, Artifact[]>(); // valid (existing, same-project) runs only
  for (const runId of runIds) {
    const run = deps.db
      .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
      .get(runId) as { projectId: number } | undefined;
    if (!run || run.projectId !== projectId) continue; // unknown / cross-project run -> absent
    artifactsByRun.set(runId, await deps.listForRun(projectId, runId));
  }

  return states.map((state) => {
    const artifacts = state.sourceRunId !== null ? artifactsByRun.get(state.sourceRunId) : undefined;
    const found = artifacts ? resolveComponentArtifact(state.component, ideaId, artifacts) : null;
    return {
      component: state.component,
      state: state.state,
      staleAt: state.staleAt,
      artifact: found ? shapeLink(found) : null,
    };
  });
}
