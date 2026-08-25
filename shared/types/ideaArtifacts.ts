/**
 * IdeaArtifactLink — the per-idea component-ledger-to-artifact resolution
 * (`cyboflow.artifacts.listForIdea`). Layers the idea component ledger's
 * merged hybrid view (`IdeaComponentState`, shared/types/ideaComponents.ts)
 * with, for each of the five tracked components, the CONCRETE run artifact
 * (if any) that backs it — the read model behind an idea-scoped surface that
 * wants to link out to the real deliverable tab (idea spec / prototype /
 * architecture / decomposed stories) a component's state refers to, rather
 * than just showing the checklist in isolation. Resolution logic lives in
 * `main/src/orchestrator/ideaArtifacts.ts`.
 *
 * A component with `artifact: null` is NOT an error — it is the COMMON case:
 * a derived (never-touched-by-a-flow) component, most manual overrides, and a
 * ledger row whose `sourceRunId` names a run that no longer exists or belongs
 * to a different project all resolve here the same way.
 */
import type { ArtifactType } from './artifacts';
import type { IdeaComponentKey, IdeaComponentStateValue } from './ideaComponents';

export interface IdeaArtifactLink {
  component: IdeaComponentKey;
  state: IdeaComponentStateValue;
  /** Mirrors `IdeaComponentState.staleAt` — non-null => prior work exists but needs re-verification. */
  staleAt: string | null;
  artifact: null | {
    runId: string;
    /**
     * The concrete deliverable's id, from ArtifactRouter.listForRun's
     * DB-rows-UNION-committed-snapshots read model (IDEA-039). IN PRACTICE
     * this is always a non-null string: every `Artifact` that read model
     * returns — whether a live DB row (`ArtifactRouter.shapeRow`) or a
     * committed on-disk snapshot (`artifactSnapshot.snapshotManifestToArtifact`)
     * — carries a non-null `id` (the snapshot manifest persists the row's
     * original id at commit time, so a committed artifact whose DB row was
     * since deleted on commit is still identifiable). Kept nullable here
     * defensively rather than widened to `string`, in case a future
     * read-model source resolves an artifact's identity (atype/committed/
     * label) without a stable id attached.
     */
    artifactId: string | null;
    atype: ArtifactType;
    committed: boolean;
    label: string;
  };
}
