# Tracker sync integration — Linear + Plane (v1 design)

Status: **proposal, decisions settled** (design conversation 2026-07-30). Rev 2 folds in the Codex adversarial-review hardening: outbox-backed idempotent remote writes, crash-safe cursor semantics, and a deletion-detection sweep.
Source design: `~/Downloads/Linear integration prototype.zip` — high-fidelity HTML prototype + handoff README (Settings → Integrations modal: catalog → 6-step wizard → connected view). The prototype's visual language matches the live Protoflow paper theme exactly; recreate it with the real design tokens and Tailwind utilities, not the prototype's `<x-dc>` runtime.

## Intent

Two-way sync between cyboflow's backlog and external issue trackers. Issues import into cyboflow's normal planning pipeline; cyboflow's progress writes back to the tracker. **Linear and Plane both ship first-class in v1** behind a single provider-adapter seam.

## Decisions log

| Decision | Ruling |
|---|---|
| Imported issues become | **Ideas** (orphaned items, i.e. no existing cyboflow counterpart). V2 adds an agent-driven "smart import" that decides entity type/nesting. |
| Decomposition write-back | **Sub-issue mirroring, per-connection toggle (default on)**: planner-minted tasks are created as sub-issues under the origin issue; each task then writes back to its own sub-issue. |
| Parent completion | Shared "close parent when all mirrored children done" write in the provider-agnostic sync core. Idempotent no-op where Linear's native auto-close automation already fired; primary mechanism for Plane (no native equivalent). |
| Auth (v1) | **Personal API keys**, no OAuth: Linear personal API key; Plane personal access token (`X-API-Key`) + instance base URL for self-hosted. OAuth can slot behind the same wizard step later. |
| Plane scope | **First-class in v1** — two live adapters day one. |
| Catalog rows | **Linear + Plane only** in v1 (Dart added later — see "Provider adapter seam"). Drop the prototype's GitHub/Jira/Slack rows. Existing Claude/Codex provider rows in the Integrations tab stay as they are. |
| Conflict resolution | Per-connection mode: **Auto** or **Manual** (see below). |
| Local delete of a linked entity | **Prompt the user** for what happens to the tracker issue. |
| Remote delete of a linked issue | Routed through conflict resolution: Auto → archive the cyboflow idea/task; Manual → per-item decision. |
| Sync cadence | Fixed 5-minute poll while the app runs, plus a manual "Sync now". |

## UX

Follow the prototype's three views, extended to seven wizard steps (Connect · Project · Source · Tasks · States · Reconcile · Review), with these deviations:

- **Step 0 (Connect)** — replace the OAuth authorize animation with a paste-your-key card (Linear: API key; Plane: API key + base URL, defaulting to `https://api.plane.so`). Keep the scopes card as documentation of what we read/write. Key is validated with a live `viewer`/workspace probe before Continue enables.
- **Step 1 (Project)** — added post-prototype: pick the TARGET cyboflow project explicitly (seeded from the active project, marked "Active"). One connection = one cyboflow project × one tracker source; the reconcile preview and the persisted connection both follow this choice.
- **Step 3 (Tasks)** — ship the **Toggle** layout only; drop the prototype's layout switch.
- **Step 4 (States)** — ship the **Table** layout only; drop the switch. Below the mapping table sit the **three direction-mode rows** (see Direction modes below), the **sub-issue mirroring toggle**, and the **conflict mode** selector (Auto / Manual) — all always visible.
- **Step 2 (Source)** — hierarchy comes from the adapter: Linear = team → whole team / project / view / cycle; Plane = project → whole project / cycle / module.
- **Catalog** — two rows (Linear, Plane). Drop the `preview connected state →` prototype affordance. Each provider row lists connections ACROSS all cyboflow projects (project chip + honest status — paused renders as a warning); Connect stays available while the active project lacks a connection for that provider.
- **Connected view** — as designed; Sync-settings card gains the three direction-mode rows plus conflict mode and mirroring; the log gains conflict/mirror/held-direction lines.

## Direction modes (supersedes the single two-way toggle)

The original `two_way` boolean conflated three independent directions; it is retired (column kept, permanently unread — migration 094) in favour of three per-connection modes, each `'auto' | 'manual'` (`TrackerDirectionMode`):

- **`status_sync_mode`** — status flow for LINKED items, BOTH directions: outbound stage write-back and inbound remote-state application.
- **`pull_mode`** — importing NEW remote issues as ideas.
- **`push_mode`** — an idea created locally after the connection exists gets a TOP-LEVEL issue created in the connection's source container (Linear: idempotent client-supplied id; Plane: `cyboflow-sync` marker paragraph for crash recovery). The draft is composed at drain time, not enqueue time. Skips: provider-authored creates, already-linked ideas, import-provenance bodies, experiment-sandbox rows.

`'auto'` runs on the 5-minute tick + live entity events; `'manual'` DEFERS that direction until an explicit "Sync now" — intents still enqueue durably (modes gate the DRAIN, never the enqueue), and a deferred inbound application HOLDS the cursor so nothing is silently dropped. "Sync now" and the connect-time initial pass always run every direction. Backfill for pre-094 rows: status per old `two_way`, pull auto, push **manual** (net-new behaviour must not surprise-write into a shared workspace).

## Data model

- **Entity-scoped external links.** `task_external_links` (mig 014, dormant, task-only) generalizes to link **ideas and tasks**: `entity_type`, `entity_id`, `provider` (`linear` | `plane`), `external_id`, `external_url`, `external_parent_id`, `synced_cursor`, `baseline_json`, plus connection id. `baseline_json` stores the last-synced field snapshot for three-way merge.
- **Connections table.** One row per provider connection: provider, workspace/instance identity, base URL (Plane), selected source, selection mode, state mapping, the three direction modes + mirroring + conflict-mode flags, cursor/timestamps. **Secrets are not stored in this table** — see Auth.
- **Migration numbering**: several in-flight worktrees claim 090–092; take the next free number at implementation time (≈093).
- All entity writes go through `TaskChangeRouter.applyChange` with a provider actor. `'linear'` is already reserved in the `TaskActor` union; add `'plane'` (or generalize to `tracker:<provider>`), and remove the defensive `actor === 'linear'` → `agent:unknown` fallback in `mcpQueryHandler`.

## Import & state mapping

- An issue with no matching cyboflow entity imports as an **idea** whose body carries title/description and a provenance footer (issue ref + URL). Stage comes from the mapping table.
- Cyboflow's four writable stages are the mapping targets: `Idea`, `Ready for development`, `Done`, `Won't do`, plus `— Don't import`. (The derived `In development` stage is orchestrator-owned and never a mapping target.)
- Default inbound mapping, Linear: Triage → Don't import; Backlog → Idea; Todo / In Progress / In Review → Ready for development; Done → Done; Canceled → Won't do. Custom states seed by their state type.
- Default inbound mapping, Plane (seeded from the canonical state `group`): backlog → Idea; unstarted / started → Ready for development; completed → Done; cancelled → Won't do.
- **Reconcile step** covers pre-existing backlog items (ideas and tasks): Keep / Link / Discard per row, with suggested matches. Link writes an external-link row; linking a pre-existing *task* to an issue is supported even though fresh imports are ideas.

## Write-back & sub-issue mirroring

Pre-decomposition, the idea itself writes back: `Done → Done`, `Won't do → Canceled/cancelled`. (`Ready for development` intentionally writes nothing — readiness isn't started.)

When the planner decomposes a linked idea (mirroring toggle on):

1. Each minted task is created as a **sub-issue** of the origin issue (Linear `parentId` / Plane `parent`), and gets its own external-link row.
2. Per-task write-back from then on: task enters derived `In development` → sub-issue "In Progress"/started-group state; task `Done` → done-state; `Won't do` → canceled-state.
3. When all mirrored children are done, the sync core closes the parent (idempotent vs. Linear's native auto-close; sole path for Plane).

With mirroring off, decomposition writes "In Progress" to the origin issue and the all-children-done rollup closes it — same seams, no sub-issue fan-out.

**Echo suppression is a correctness requirement**: mirrored sub-issues must never re-import as new ideas, and our own status writes must never bounce back as remote changes. Both are guaranteed by the outbox (see *Durability & failure semantics*): every remote write has a durable local record **before** the API call is attempted, so the poller can always recognize our own artifacts — even mid-create, even across a crash — and inbound changes diff against `baseline_json` so our own writes are ignored. The inbound cursor never advances past an item whose outbox record is still unresolved.

## Conflict resolution

Per-connection mode, set in the wizard and editable from the connected view:

- **Auto**: three-way merge per field against `baseline_json`. Only-one-side-changed → that side wins. Both-changed → tracker wins content fields (title/description); cyboflow wins stage/status. Every auto-resolution that overrode a change files a non-blocking review-queue finding for spot-checking.
- **Manual**: conflicting items queue for the user, who decides **per item** which side to accept (side-by-side diff, Accept-theirs / Accept-ours per row — reuse the reconcile table treatment). Sync of *that item* pauses until resolved; everything else keeps flowing.

Remote deletions route through the same machinery: Auto → archive the linked idea/task (in-place archive, never hard delete) and mark the link orphaned; Manual → the deletion appears as a conflict row (keep local copy vs. archive).

Local deletion/discard of a linked entity prompts immediately: leave the tracker issue untouched (unlink), or cancel it in the tracker. We never hard-delete on the remote side.

## Sync engine

- Runs in the Electron main process; 5-minute interval while the app is running (desktop app — no sync when closed), immediate pass on connect and on "Sync now".
- Inbound: incremental fetch per connection with the cursor semantics below; changes apply via `TaskChangeRouter` with the provider actor.
- Outbound: entity-event driven (stage changes on linked entities), debounced, executed through the outbox below; failures retry with backoff and surface in the connected view's log.
- Rate limits: Linear GraphQL complexity budget and Plane REST limits both comfortably fit a 5-minute incremental poll; batch writes where the API allows.

### Durability & failure semantics (adversarial-review hardening)

1. **Outbox for every remote write.** No API call without a durable `tracker_outbox` row written first (kind: create-sub-issue / update-state / close-parent; state: `pending → in-flight → done | failed | ambiguous`). Each create carries a **client-generated key**: Linear's `issueCreate` accepts a client-supplied issue id, making creates natively idempotent — recovery is a lookup by that id; Plane has no idempotency key, so an ambiguous create (response lost, crash mid-flight) is reconciled by listing the parent's sub-issues and matching against the pending record before any retry. The external-link row is finalized from the completed outbox record, and the inbound cursor cannot advance past an item with an unresolved outbox entry — so a half-created sub-issue can never be double-created or re-imported.
2. **Crash-safe cursor.** The inbound high-water mark is compound — `(updatedAt, externalId)` — not a bare timestamp, fetched with an overlap window and deduplicated by external id, so same-timestamp neighbors are never skipped. A fetched page is applied in one sqlite transaction **together with** the cursor update; a crash mid-page rewinds to the last durable cursor and the overlap window makes the replay idempotent.
3. **Deletion sweep.** Polling only sees issues that still exist, so remote hard-deletes are invisible to the incremental path. Every Nth poll (and on every "Sync now"), a reconciliation sweep compares the remote ID set for the connection's source scope against active external links; IDs that have vanished become deletion events feeding the conflict machinery (Auto → archive local + orphan the link; Manual → conflict row). Where the provider distinguishes archived from deleted (Linear `archivedAt`/trash), archived issues are treated as remote archives rather than deletions.

## Auth & secrets

No existing pattern for app-owned third-party secrets exists (no keytar/safeStorage usage today). Introduce one: **Electron `safeStorage`-encrypted blobs** stored in sqlite alongside the connection row, decrypted only in the main process. Keys never cross the IPC boundary; the renderer sees connection status only.

## Provider adapter seam

```ts
interface TrackerAdapter {
  provider: 'linear' | 'plane' | 'dart';
  validateCredentials(creds): Promise<WorkspaceIdentity>;
  listHierarchy(): Promise<SourceTree>;            // teams/projects → narrows (views, cycles, modules)
  listStates(source): Promise<TrackerState[]>;     // id, name, color, canonical group
  listIssues(source, since?): Promise<TrackerIssue[]>;      // incremental, overlap-windowed
  listIssueIds(source): Promise<string[]>;         // full ID set — deletion sweep
  getIssue(externalId): Promise<TrackerIssue | null>;       // point lookup — outbox recovery
  createSubIssue(parentExternalId, draft, clientKey): Promise<TrackerIssue>;
  updateIssueState(externalId, stateId): Promise<void>;
  capabilities: {
    nativeParentAutoClose: boolean;   // Linear true; Plane and Dart false
    selfHostedBaseUrl: boolean;       // Plane true; Linear and Dart cloud-only
    idempotentCreate: boolean;        // Linear true (client-supplied issue id); Plane and Dart false → reconcile-by-lookup
  };
}
```

Linear = GraphQL client; Plane = REST client (`X-API-Key`, configurable base URL); Dart = REST client (`Bearer` token, cloud-only). The wizard, sync engine, mapping table, conflict machinery, and mirroring logic are all provider-agnostic above this seam.

**Dart (added after v1)** exercised the seam for the first time and cost one adapter plus eight mechanical widenings — no change to the wizard, the sync engine, or any frontend component beyond a row in `TRACKER_PROVIDERS`. Three things about its API have no Linear or Plane analogue and are worth knowing before touching `dartAdapter.ts`:

- **Titles, not ids.** `GET /config` is the only discovery endpoint and returns dartboards and statuses as bare strings, so `TrackerSourceContainer.id` and `TrackerState.id` *are* those titles. A rename in Dart therefore invalidates a connection's stored source selection and state-mapping keys. Since `GET /tasks/list` answers a vanished dartboard with an empty page — which `listIssueIds` would hand the deletion sweep as "everything was deleted remotely" — the adapter guards every pass with `assertContainerExists` and fails loudly instead.
- **List responses omit the description.** Dart's list shape (`ConciseTask`) drops `description`, which the three-way merge and the recovery marker both need, so `listIssues` hydrates every row through `GET /tasks/{id}` at bounded concurrency. `listIssueIds` deliberately does not, keeping the deletion sweep cheap.
- **No state grouping.** Dart publishes no state type or category, so `inferStateGroup` guesses `TrackerStateGroup` from the status name. Low-stakes by construction: the group only seeds the wizard's mapping defaults, which the user then overrides.
- **Sub-issue placement is not inherited.** A `parentId`-only create lands the child on the API user's *default* dartboard, not the parent's — where this connection's dartboard-scoped reads can never see it. `createSubIssue` therefore reads the parent's board and names it explicitly. This one contradicted the obvious reading of the spec and was only caught by running it.

Dart also exposes no workspace identity (`/me` returns only the user, and `/config` carries no space id or name), so `TrackerWorkspaceIdentity.workspaceId` binds to the *account*. The rotation guard (`TrackerIdentityMismatchError`) is correspondingly weaker there: it catches a token pasted from a different account, but not the same user's token for a different space. **Open risk**: if Dart tokens are space-scoped, that gap lets a rotation retain links whose issues the new token cannot see, and the sweep's `getIssue` confirmation would then read them as genuinely deleted. Verifying it needs a second space on one account.

**Measured against a live space (2026-08-18)**, since the spec leaves these open and each one is load-bearing:

| Behaviour | Result |
| --- | --- |
| `updated_at_after` bound | **Inclusive** (gte) — the contract's requirement, met natively |
| `description` list filter | **Contains** — the client-key fast path does hit |
| Unknown dartboard title | **200 + empty page**, never an error — `assertContainerExists` is load-bearing |
| Empty `dartboard=` | Filter dropped: returns the **whole space** |
| Trashed task | **404s** on `GET /tasks/{id}`, absent from listings unless `in_trash=true` |
| Default filters | `meta.defaultsApplied: false` on a fresh space; `no_defaults=true` changes nothing |
| `ids` filter | **Silently ignored** in every serialization — a documented param that does nothing |

That last row is the general lesson: Dart drops filters it does not honour rather than erroring, so a test that only asserts "the row I wanted came back" can pass against a filter that never ran. The adapter's own filters (`dartboard`, `parent_id`, `description`, `updated_at_after`) were each re-checked with a negative control.

## Implementation notes (v1 as landed)

Where the build refined the design above — the spec stands, these are the deltas:

- **Cursor advance is per-item, not per-page.** `TaskChangeRouter.applyChange` is async and queue-serialized, so a page cannot share one sqlite transaction with the cursor write. Inbound applies items in ascending `(updatedAt, externalId)` order and advances the compound cursor after each; the overlap window + idempotent re-apply give the same crash guarantee.
- **The tRPC router reaches the engine through a facade bridge** (`main/src/orchestrator/trackerSyncBridge.ts`): router files must standalone-typecheck (no `electron`/`better-sqlite3`/`services/*` imports), so `TrackerSyncService` registers itself as a `TrackerSyncFacade` at boot.
- **Linear custom views are not a v1 narrow** (team → whole / project / cycle only): the customViews issue-filter API is too awkward for the payoff. Plane narrows: project → whole / cycle / module.
- **Outbox failure policy gained a third branch**: non-retryable 4xx (not 408/429) settles terminally instead of retrying every 32 minutes forever. Auth errors pause the connection; 5xx/network use capped exponential backoff.
- **An unresolved outbox row halts inbound cursor advance at that issue** (not just echo-skips it) — the batch resumes once the row settles.
- **Mirroring semantics**: sibling terminality for the close-parent rollup counts Won't do as settled (a cancelled story must not strand the parent open); decomposition never writes 'started' over an already-terminal idea's state.
- **Deletion sweep cadence**: the first pass after every boot sweeps (deletes are most likely to have been missed while the app was closed), then every 12th pass (~hourly) and on every "Sync now".
- **Reconcile links** are created with a null baseline — the first inbound pass adopts the issue's current snapshot without applying anything; the wizard carries the issue's identifier + URL so the ref chip lands at connect time.
- **Connected-view edit shortcuts are v1-read-only** for source/selection/mapping (changing them means re-running the wizard); direction, mirroring, and conflict mode toggle live via `updateSettings`. Deep-links would require a credential re-prompt since keys never return to the renderer.
- **Plane flags for the live smoke**: docs are mid-rename `/issues/` → `/work-items/` (adapter uses `/issues/`; one-line segment swap if a real instance disagrees); assignees need `expand=assignees`; the workspace slug is part of credentials.
- **Local-delete flow (shipped, staged-ruling design)**: archiving/deleting a linked entity from the board's card menu interposes a two-choice dialog — "Keep in <provider>" or "Cancel in <provider>" — that only STAGES the ruling (10-minute in-memory TTL, mutates nothing). The real delete/archive event consumes it server-side: cascade members inherit the root's ruling (cancel enqueues before each orphan), an inbound-applied archive never stages so provider actors can't trigger it, and a zombie sweep orphans any link whose entity vanished without an event. Backing out of the final confirm leaves everything untouched. The cancel choice enqueues like any other write — a direct per-issue instruction recorded as durable intent, drained under the status direction's mode. Known residual: an unlinked epic with linked mirrored children cleans their links on cascade but offers no cancel/keep prompt for them.

## Multi-project mapping (rev 4, 2026-08-20)

Replaces the wizard's single "target cyboflow project" pick (old Step 1) and single source
pick (old Step 2) with one **Map** step: the tracker's project-level groupings map N:1 onto
cyboflow projects, so one connect flow routes issues into several cyboflow projects. The
grouping unit per provider (Krishna's ruling): **Linear → projects** (plus whole teams as a
fallback section, since many Linear workspaces don't use projects), **Plane → projects**,
**Dart → spaces**.

### Shape: N sibling connection rows, not a join table

A mapping is persisted as **one `tracker_connections` row per (tracker group → cyboflow
project) pair**, minted by the wizard in one pass, all sharing the same credentials (each row
stores its own safeStorage blob). This was chosen over a `tracker_project_mappings` join table
because every durability seam — the compound crash-safe cursor, outbox scoping and ambiguous
recovery, StateCache, the deletion sweep's remote-id set, the zombie-link sweep (which cannot
read a project off a deleted entity), echo suppression, and revival identity — keys off one
connection row = one (project, source) pair. N rows preserve all of those invariants per
mapping for free, give per-group state mappings (Linear states are per-team, Plane per-project),
and require **zero data migration for existing connections** — they already ARE the new model
with one mapping.

### Groups (adapter seam)

New `TrackerAdapter.listGroups(): Promise<TrackerGroupTree>` — sections of
`TrackerGroup { id, name, key, sourceLabel, selection, stateScopeKey, pushContainerId? }`.
The group carries its READY-MADE `TrackerSourceSelection`, so the engine consumes it with no
new scope concepts except Dart's:

- **Linear**: "Projects" section from a new root `projects` query with `teams` — one group per
  (project × team) pair when a project spans teams (selection `{containerId: teamId,
  narrowId: projectId, narrowKind: 'project'}` — the existing team+project filter, so no
  engine change and no cross-team state ambiguity); "Whole teams" section (`narrowKind: 'all'`).
  `stateScopeKey` = team id. Issues in no project only import via a team group.
- **Plane**: one group per project (existing container), `stateScopeKey` = project id.
- **Dart**: spaces derived from the `/config` dartboard-title prefix before the first `/`
  (`"Engineering/Sprint"` → space `Engineering`); a title with no `/` becomes its own
  single-board group with the plain dartboard selection. Space groups use the new
  `narrowKind: 'space'`: the adapter resolves member boards from `/config` at call time and
  unions per-board fetches (list/ids/recovery); `assertContainerExists` becomes "space still
  has ≥1 board". Creates need a concrete board, so the group carries `pushContainerId`
  (default: the space's first board), persisted inside `source_json` and threaded through
  `TrackerSourceSelection.pushContainerId?`. NOTE: the `/`-prefix convention is observed, not
  documented by Dart — degrades gracefully to per-board groups.

### Engine deltas (small, additive)

- `tracker_connections.push_target INTEGER NOT NULL DEFAULT 1` (migration; ALTER ADD COLUMN,
  replay-safe). When several mappings target the same cyboflow project, exactly one row per
  provider has it set; `handleIdeaPush` skips rows with `push_target = 0` — otherwise a new
  idea would enqueue one `create_issue` per sibling row and duplicate remotely.
- **Cross-row duplicate-import guard**: before `importIssueAsIdea`, skip (with a log line) any
  issue whose `external_id` is already linked by another connection with the same
  (provider, workspace_id, base_url) — covers overlapping scopes (a Linear team group + a
  project group under it) and issues moved between mapped groups remotely.
- **Revival identity gains the source**: `findDisconnectedConnection` also matches
  `source_json.containerId`, so reviving one mapping can't grab a sibling's row.
- **`updateCredentials` fans out** to every row sharing (provider, workspace_id, base_url)
  after the identity probe passes — one paste resumes all mappings.
- **`connect()` idempotency**: a live row matching (project, provider, workspace, and the FULL
  source scope — containerId + narrowId + narrowKind, since every Linear project group under one
  team shares the team's containerId) makes `connect` a no-op returning the existing id, so
  re-submitting a partially failed multi-mapping wizard never duplicates rows. The no-op still
  applies what a re-submit legitimately carries fresh: the just-validated key (resuming a paused
  row) and the push-target choice. Revival matches the same scope, widening-only (a
  whole-container scope claims its narrows; a Dart space claims member boards), so legacy rows
  revive without sibling capture. `connect` claims the push target atomically per (project,
  provider) — demoting armed siblings across wizard runs — and boot demotes replay-manufactured
  duplicates.

### Wizard (Connect · Map · Tasks · States · Reconcile · Review)

Map lists `wizardGroups` sections with a cyboflow-project select per group (default unmapped =
don't import) and a push-target radio where N groups share a project. Tasks keeps the three
selection modes chosen once, with issues fetched per mapping (`wizardIssues` per selection) and
manual picks grouped by mapping. States renders one table per distinct `stateScopeKey`.
Reconcile runs `reconcilePreview` per mapped cyboflow project; a link decision routes to the
mapping whose issue set contains it. Review calls the existing `connect` once per mapping,
sequentially, with per-mapping progress and retry (safe via connect idempotency). Narrow
filters (Linear views/cycles, Plane cycles/modules) are not offered by the Map step; existing
narrowed connections keep working untouched.

## V2 (explicitly out of v1 scope)

- **Smart import**: an agent classifies incoming issues (idea vs. task, nesting, epic assignment) instead of ideas-by-default.
- OAuth flows (hosted token exchange), further providers (Jira, GitHub — Dart has since landed), assignee/estimate/priority mapping (v1 imports them as display metadata only), configurable cadence, real-time webhooks.
- Multi-project mapping follow-ups: per-mapping direction modes, a Linear "no project" pseudo-group. (SHIPPED since rev 4: mapping management from Settings — a "Project mappings" card on the connected view listing every sibling of the workspace identity with per-row remove + push-target control (`mappings`/`setPushTarget` procs), an "Add mapping" wizard mode that reuses the stored key (`credentials` XOR `connectionId` on the probes and `sourceConnectionId` on connect — no key re-paste, nothing key-shaped crosses IPC), and the catalog's Connect CTA now rendered only for providers with no live connection. Push-target invariants hardened alongside: disconnect promotes the oldest surviving sibling, setPushTarget refuses a paused row while an active sibling pushes, and the add-mapping wizard defers to an incumbent pusher instead of silently claiming.)
