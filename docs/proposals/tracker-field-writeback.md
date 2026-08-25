# Tracker field write-back — implementation plan

Status: PLAN (Codex-adversarially reviewed 2026-08-21; all 6 findings addressed inline — see "Review
findings absorbed" at the end; not started)
Scope owner decisions (locked 2026-08-21):

- Local priority widens from `P0-P2` to **`P0-P6`** (7 levels), then a per-connection priority mapping.
- Entity category (`feature|bug|chore`) syncs to **Dart's native task type only**; Linear/Plane render "unsupported by this provider". No label emulation in v1.
- Outbound archive/delete both become **remote trash/archive — never a hard delete**. Cyboflow never permanently deletes in someone else's workspace.
- Scope: **tasks AND pushed ideas** (planner body rewrites flow back too, gated by mode).
- Field write-back ("Sync task fields") and archive sync are **separate per-connection modes**, both defaulting OFF.

Non-goals (v1): Linear/Plane label emulation for category; widening the *findings* priority axis
(`review_items.priority` stays P0-P2 — same shape, different concept, mig 034); any inbound trigger /
webhook work (that is the separate "Dart manages" track); Plane hard-delete under any circumstance.

Prior art this plan builds on (already merged to main): the parent-guard fix, the
post-create `alignLocalDescription` body alignment, and the recovery-scan bounds
(`fd296c46`/`c483bc3f`/`6b8f729c`).

---

## Design invariants (every phase must respect these)

1. **Echo suppression by baseline stamping, from the write response.** Every successful outbound
   content write stamps the fields it wrote onto the link's `baseline_json` (merge, never replace —
   `composeBaselineJson` discipline, `inboundSync.ts:549-572`), using the **provider-returned
   (post-normalizer) values**, so the next inbound pass diffs our own write to "no change". Dart PUT
   and Plane PATCH already return the updated object; Linear's `UPDATE_ISSUE_STATE_MUTATION` selects
   only `success` and the new content mutation must select `issue { …ISSUE_NODE_FIELDS }`.
2. **Priority comparisons happen in PROVIDER space.** `TrackerIssue.priority` and the baseline store
   the provider-raw token (Linear `'0'..'4'`, Plane `urgent|high|medium|low|none`, Dart
   `Critical|High|Medium|Low|null`). The local mapping is applied only at the merge/compose edge.
   Rationale: P0-P6 → 4-5 provider levels is lossy (P3→medium→P2), so a local-space diff would flap
   a user's P3 down to P2 on every pass.
3. **The `undefined`-baseline backfill arm.** A baseline written before this feature carries no
   priority/category. `baseline.priority === undefined` ⇒ **do nothing** (no diff, no conflict, no
   apply): `composeBaselineJson`'s unconditional overlay at the end of the same pass self-heals the
   baseline, and merging starts from the next change. Falling through to the ordinary diff would
   open a conflict (or auto-overwrite local priority) on every linked entity in one pass.
4. **Body writes re-append the recovery marker.** Dart/Plane embed `cyboflow-sync: <uuid>` in the
   description at create and strip it on read. A body write-back that sends the local text verbatim
   destroys the marker and makes `findIssueByClientKey`'s "no candidate carries it ⇒ create never
   landed" proof unsound → duplicated creates. Every `update_content` description send re-appends the
   link's marker (Dart markdown line / Plane `<p>` paragraph).
5. **Enqueue unconditionally for `manual`, gate the enqueue for `off`.** `writeBack.ts`'s header
   contract ("nothing here is gated on a direction mode") survives for `auto|manual`; `off` is the
   one exception and gates at the ENQUEUE, because `collectOutboxBlockers` is kind-agnostic and
   `runInboundSync` `break`s on a blocked issue — a queued row a direction will never drain is a
   **permanent inbound stall**, not a delay. `directionRuns()` short-circuits `'off'` BEFORE the
   `trigger === 'manual'` escape, or "Sync now" would drain an off direction. **This gate applies to
   EVERY `update_content`/`archive_issue` enqueue site, including conflict resolution** — under
   `'off'`, accepting the local side of a conflict stamps the baseline only (today's behavior),
   because an enqueued row would be undrainable even by "Sync now" and would wedge inbound forever.
6. **Actor filter AND baseline diff on every new trigger.** All inbound applies run with
   `actor: connection.provider`; the trigger skips those. The baseline diff is the correctness
   backstop for unattributed events. Neither alone suffices (recon: `writeBack.ts:531-534`,
   `stampRemoteGroup` precedent).
7. **Archive idempotency: a 404 on an archive write is SUCCESS,** not a terminal failure (the twin
   was already trashed/deleted). Plane's `DELETE` (hard delete) is never called by any path.
8. **Exhaustiveness over grep.** Every per-provider table is typed `Record<TrackerProvider, …>`;
   every kind dispatch gets an explicit branch (the `processRow` fall-through treats unknown kinds
   as state writes and fails them terminally). One test drains one row of every kind in
   `TrackerOutboxRow['kind']`.
9. **IPC type parity** (docs/CODE-PATTERNS.md): every change to `shared/types/trackerSync.ts` /
   `shared/types/tasks.ts` lands in the same commit as its zod schema, row type, and store
   allowlist counterparts. New event/summary fields are optional; `undefined` means "unknown",
   never "nothing changed".
10. **The Dart task-detail memo cache is invalidated by every Dart write** (`updateIssueState`
    already does `taskCache.delete`; `updateIssueContent` and `archiveIssue` must too).

---

## Phase 0 — Live probes (no code; blocks phases 4-5, not 1-3)

Dart silently drops fields/filters it does not honour, so every probe pairs a positive with a
negative control (set a value the task demonstrably did not hold; send a garbage value).

| # | Probe | Decides |
|---|---|---|
| D1 | `PUT {item:{id, priority:'High'}}` persists; `priority:'Bogus'` → 400 or silent no-op | whether invalid mappings fail loud; pre-flight membership check needed |
| D2 | `PUT {item:{id, priority: null}}` clears priority | the P6 ⇄ unset round-trip arm |
| D3 | `PUT {item:{id, type:'Bug'}}` persists; a type absent from `/config.types` → behavior | category write viability; pre-flight `/config.types` check |
| D4 | `PUT {item:{id, title/description}}` persists; marker survives normalization | body write-back + marker re-append |
| D5 | `DELETE /tasks/{id}` → 200+item; GET 404s; visible under `in_trash=true`; second DELETE → 404 or 200 | archive semantics + idempotent-404 handling |
| D6 | `GET /config` returns `types[]` + `priorities[]`; values on a real workspace | mapping-table seeds (spec says yes; adapter never read them) |
| D7 | priority-only PUT bumps `updatedAt`? | echo/cursor interaction; stamp source |
| D8 | `/tasks/list` concise rows carry `priority`/`type` in practice | inbound rides the list for free vs. needs hydration |
| L1 | `issueArchive(id, trash:true)` vs `issueUpdate({trashed:true})`: which sets `archivedAt`; still visible under `includeArchived:true`? | Linear archive route + inbound echo visibility |
| L2 | personal API key scope covers `issueArchive` | route choice fallback |
| L3 | priority-only `issueUpdate` bumps `updatedAt`? | same as D7 |
| P1 | `PATCH {archived_at:'YYYY-MM-DD'}` archives; GET then 404s; `archived_at:null` restores | **whether Plane gets outbound archive at all** (no archive endpoint exists in its public v1) |
| P2 | `PATCH {priority:'urgent'}` persists; `'URGENT'`/`'critical'` → 400 | case handling in the mapping |
| P3 | `PATCH {description_html}` survives `validate_html_content` with the marker `<p>` intact | body write-back on Plane |

Deliverable: a probe transcript appended to this doc. P1 failing ⇒ Plane ships with
`archive: 'none'` capability and the UI renders "unsupported"; the plan does not change shape.

## Phase 1 — Widen local priority to P0-P6 (self-contained; no tracker coupling)

Migration **111** (`117_widen_entity_priority.sql`): widen the CHECK on `ideas`/`epics`/`tasks` per
the **103 recipe** (add shadow column → copy → drop → re-add with `CHECK (priority IN
('P0','P1','P2','P3','P4','P5','P6'))` + `DEFAULT 'P2'` → copy back → drop shadow; no
table-recreate — the column has no index/FK/view entanglement). Migration test mirrors
`migration034.test.ts`'s "(c)" pattern inverted: accepts P0-P6, rejects P7.

Code sites (the shared type does NOT propagate to most of these — they are independent literals):

- `shared/types/tasks.ts:32` `Priority` union (canonical).
- `main/src/database/models.ts:317,341,367,426` inline row-type literals ×3 (+1).
- `main/src/orchestrator/trpc/routers/tasks.ts:94` `prioritySchema` z.enum.
- `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts:577,604` JSON-schema enums;
  `:1525-1526,1745,1894` runtime guards; **`:463-466` the design-scope create-task schema's
  prose/description advertising only P0-P2** (Codex finding — easy to miss because it is text,
  not an enum array).
- `main/src/orchestrator/mcpServer/mcpQueryHandler.ts:1107` `isAgentPriority`.
- **`main/src/orchestrator/taskMutationHandler.ts:59`** — the monitor-mutation priority coercer
  accepts only P0-P2 and silently returns `undefined` otherwise (→ the P2 default applies).
  Widen to P0-P6 and revisit its alias table (HIGH/URGENT/CRITICAL→P0 etc.) for the new scale.
- `main/src/orchestrator/taskListing.ts:161`, `runExecutor.ts:121,1951` — **verify axis first**:
  edit only if these are entity priority, not finding priority.
- Closing step: a repo-wide `'P0'|'P1'|'P2'` literal audit (non-test, non-trackerSync) diffed
  against this inventory, preserving the findings axis — the two sites above were caught by
  exactly such an audit, not by the type checker.
- Frontend: `Backlog/markers.tsx:51-56` `PRIORITY_CLASS` (TS hard-fails on widen — design a 7-level
  color ramp, P0 hottest → P6 muted); `NewTaskDialog.tsx:42` + `EpicDetailEditor.tsx:31`
  `PRIORITIES` arrays; `agentRail/ProposalCardBodies.tsx:114-123` glyph semantics (P0-P1 promoted /
  P2-P3 neutral / P4-P6 lowered; update the doc comment).
- Do NOT touch: `shared/types/reviews.ts:109` `FINDING_PRIORITIES`, `reviewItems.ts` zod,
  `insightsStore.ts` ranks, mig 034 CHECK — the findings axis.
- Gate: `entitySchemaParity.test.ts` + new migration test + widened MCP tests (P0-P6 accepted).

## Phase 2 — Inbound read + mapping modules (still no outbound writes)

1. **Wire shapes.** `shared/types/trackerSync.ts` `TrackerIssue` gains
   `priority: string | null` (provider-raw token) and `category: string | null` (Dart type title;
   Linear/Plane always null). IPC-parity commit.
2. **Adapters populate them.** Dart: add `type`/`priority` to `DartConciseTaskWire` (spec says the
   concise list already carries both — zero extra requests; D8 confirms). Linear: add `priority` (+
   `priorityLabel`, `trashed`) to `ISSUE_NODE_FIELDS` — one edit reaches list/get/create; note read
   is `Float`, write is `Int`; `0` is a real "No priority" value. Plane: add
   `priority?: string|null` to `PlaneIssueWire` + `mapIssue`.
3. **Field-option discovery seam** (provider-agnostic, so the wizard and the rename check have a
   real path to the data — a private wire-shape extension alone reaches neither). New
   `TrackerAdapter` method:
   `listFieldOptions(): Promise<{ priorities: string[] | null; categories: string[] | null }>` —
   `null` = "static scale / unsupported" (Linear returns its fixed 0-4 labels, Plane its fixed
   enum, both with `categories: null`; Dart returns the live `/config.types` + `/config.priorities`
   lists). Threaded like `wizardStates`: service probe → `tracker.wizardFieldOptions` tRPC
   mutation → shared IPC types → wizard loading/error states. `DartConfigWire` gains `types` and
   `priorities` — AND the `getConfig` cache-rebuild literal (`dartAdapter.ts:844-853`), which
   silently drops any key not repeated there. The sync-pass rename check reads the same adapter
   method, not the tRPC surface.
4. **Mapping modules** (`priorityMapping.ts`, `categoryMapping.ts` beside `stateMapping.ts`), each
   with `seedDefault*Mapping` + `resolveEffective*Mapping` (seed → overlay persisted JSON → defend
   against corrupt JSON, exactly the `resolveEffectiveMapping` contract). Shape:
   `{ toProvider: Record<Priority, string|null>, toLocal: Record<string, Priority> }`.
   Default priority seed (stable round trip beats even spread; P6 ⇄ unset is the identity that
   keeps unprioritized imports unprioritized):

   | local | Linear | Plane | Dart |
   |---|---|---|---|
   | P0 | 1 Urgent | urgent | Critical |
   | P1 | 2 High | high | High |
   | P2 / P3 | 3 Medium | medium | Medium |
   | P4 / P5 | 4 Low | low | Low |
   | P6 | 0 No priority | none | null |

   Inbound: Urgent/Critical→P0, High→P1, Medium→P2, Low→P4, unset→P6. Dart seeds from the live
   `/config.priorities` (workspace list), not the spec enum. Category seed: case-insensitive match
   of `feature|bug|chore` against `/config.types`; no match ⇒ omit the field (never invent a type).
   Dart types/priorities are addressed by TITLE (title-is-the-id), so a rename invalidates a
   persisted mapping — reuse the loud-failure convention and surface a "renamed value, confirm
   mapping" sync-log line rather than writing a value Dart would silently drop.
5. **Merge arms.** `TrackerBaseline` gains OPTIONAL `priority?`/`category?`; `parseBaseline` reads
   absent as `undefined` (never a default); `snapshotOf` emits them (baselines self-heal via the
   overlay); `LocalEntity`/`readLocalEntity` SELECT gains `priority, category`;
   `mergeLinkedIssue` gains two arms mirroring the title arm **plus the backfill arm (invariant
   3)**, comparing in provider space via the effective mapping; `FieldConflict.field` union gains
   `'priority' | 'category'`; Auto-mode remote-wins branch gains the two applies;
   `applyRemoteFieldValue` gains priority/category arms (stamp-before-apply ordering, per the
   stage arm's documented reasoning). `tracker_conflicts.field` has no CHECK — no migration.
   Conflict UI is already generic (`conflict.field ?? conflict.kind`); polish only.
6. Category inbound applies only from Dart; a null category from Linear/Plane is "absent", never a
   diff.

## Phase 3 — Migration 118 + direction modes + outbox kinds

One migration, **094-ordered** (idempotent ALTERs first, backfill second, recreate LAST):

1. `ALTER TABLE tracker_connections ADD COLUMN content_sync_mode TEXT NOT NULL DEFAULT 'off'
   CHECK (content_sync_mode IN ('auto','manual','off'))`; same for `archive_sync_mode`;
   `priority_mapping_json TEXT NOT NULL DEFAULT '{}'`; `category_mapping_json TEXT NOT NULL DEFAULT
   '{}'` (empty map = seeded defaults; no backfill UPDATE needed for the JSON columns; the mode
   columns' DEFAULT 'off' is itself the backfill — existing connections did not consent).
2. Recreate `tracker_outbox` with `kind` CHECK widened to include **`update_content`** and
   **`archive_issue`** (094 recipe verbatim; explicit column list; index recreate; note 110's
   warning — the recreate must carry `push_target` and every 093/094/105/110 column forward).
3. `TrackerDirectionMode` grows `'off'` — as a **separate** schema/type for the two new modes if we
   keep the existing three binary (`tracker.ts:219-225` explicitly warns against coupling; decision:
   new `TrackerContentSyncMode = 'auto'|'manual'|'off'` type + `contentModeSchema`, leaving the
   existing three untouched). `directionRuns` equivalent for the new modes short-circuits `'off'`.
4. Plumbing (5 places, from recon): `TrackerConnectionRow`; `ConnectionSettingsPatch` +
   `CONNECTION_SETTINGS_COLUMNS` + `insertConnection` list; `drainKinds` gains
   `CONTENT_OUTBOX_KINDS = ['update_content']` and `ARCHIVE_OUTBOX_KINDS = ['archive_issue']` arms +
   `summarizeConnection` + `updateSettings` + `appendHeldDirectionLines` (two new held lines);
   `shared/types/trackerSync.ts` summary/connect/patch; `tracker.ts` zod.
5. Migration 118 test: every kind inserts; a bogus kind throws `/CHECK/i`; column list pinned;
   mode CHECKs accept the three values and reject others.

Numbering: 111/112 are next-free today; renumber-at-merge is the established convention if a
sibling worktree claims them first.

## Phase 4 — Adapter seam: `updateIssueContent` + `archiveIssue`

`adapterTypes.ts`:

```ts
interface IssueContentPatch { title?: string; description?: string | null;
  priority?: string | null;      // provider-raw token, already mapped
  category?: string | null; }    // Dart type title; others reject via capability
updateIssueContent(externalId: string, patch: IssueContentPatch): Promise<TrackerIssue | null>;
archiveIssue(externalId: string): Promise<void>;
```

`TrackerAdapterCapabilities` gains `contentWrite: { title: boolean; description: boolean;
priority: boolean; category: boolean }` and `archive: 'trash' | 'archive' | 'none'`, typed so the
`defaultAdapterFactory` `never`-guard enumerates providers.

- **Dart**: `PUT /tasks/{id}` `{item:{id, title?, description?, priority?, type?}}`; parse and
  RETURN the updated wire (stamp source); re-append marker to descriptions; `taskCache.delete`;
  pre-flight `/config` membership check for priority/type values (D1/D3-gated). Archive:
  `DELETE /tasks/{id}` (real trash, one-way; 404 ⇒ success). `IssueDraft` gains optional
  `priority`/`category` so creates carry them too.
- **Linear**: one generalized `issueUpdate` mutation with `issue { …ISSUE_NODE_FIELDS }` selected;
  priority as `Int`; archive via the L1-winning route (`issueArchive(trash:true)` or
  `issueUpdate({trashed:true})`); never `issueDelete`.
- **Plane**: `PATCH` `{name?, description_html?, priority?}`; body through
  `toCreateDescriptionHtml`-style conversion + marker `<p>`; returns the updated object (stamp
  source). Archive: `PATCH {archived_at}` if P1 passes, else `archive: 'none'`. `DELETE` is never
  reachable from any write-back path (add a test asserting the adapter has no delete call).
- Note for Plane body semantics: Plane's description round-trip is plaintext-ified HTML (not
  markdown); the stamp-from-response invariant is what keeps that from generating phantom edits.

## Phase 5 — Outbound triggers, drain, conflict flips

1. **Content trigger** in `writeBack.route()` (new arm after the stage arm): predicate =
   actor is not a provider AND entity is linked AND the link's `baseline_json` differs from the
   local entity on any synced field (title, `splitBody(body).description`, mapped priority,
   mapped category-when-Dart). Gated on `content_sync_mode !== 'off'` at the ENQUEUE (invariant 5;
   amend the writeBack header contract: "`manual` delays, `off` declines"). Enqueue
   `update_content` with **empty payload + drain-time compose** (the `create_issue` precedent —
   a held row files the CURRENT fields, and bursts collapse). **Multi-provider: the new arms do NOT
   use `resolveLinked`** (which returns only the FIRST active provider link, `writeBack.ts:240-258`)
   — add `resolveAllLinked` enumerating every active link/connection pair for the entity, and
   evaluate mode, capability, mapping, and baseline **per link** (an idea pushed to two trackers
   gets two independent decisions). The existing stage arm keeps `resolveLinked` unchanged — its
   single-link behavior is pre-existing and out of scope; record it as an explicit follow-up.
   Test: one idea linked to two providers with different modes/mappings.
   **Dedupe collapses only `pending` rows.** `listUnresolvedOutbox` includes `in_flight`/
   `ambiguous`, and an edit that lands while a content write is on the wire must not be swallowed —
   the in-flight row already composed its payload from the pre-edit entity, so suppressing the new
   enqueue loses the edit with no row left to represent it. Rule: skip the enqueue only when a
   `pending` `update_content` row exists for that (connection, external_id); if the newest
   unresolved row is `in_flight` or `ambiguous`, enqueue a successor (the supersession sweep and
   drain-time compose then collapse it safely). Supersession sweep scoped to
   `kind = 'update_content'` only (kind-set table refactor of `isSuperseded` — content and state
   writes are orthogonal; never cross-supersede).
2. **Archive: two entry points, and the removal pipeline changes explicitly.** The naive
   "listener arm keyed on `archived_at`" is unreachable for the dialog flow:
   `TrackerSyncService.handleTaskChanged` runs `handleLocalRemoval` BEFORE the listener, and a
   staged ruling's `dropLink` orphans the link — after which `resolveLinked`/`resolveAllLinked`
   skip it. And a delete's ruling today enqueues a *cancelled-state* write, which contradicts the
   locked archive-means-trash decision. So:
   - **(a) Plain archive, no staged ruling** (`handleLocalRemoval` returns early at the
     `ruling === null` arm): the new listener arm fires on the `archived_at: null → non-null`
     transition, gated on `archive_sync_mode !== 'off'`, per link via `resolveAllLinked`.
   - **(b) Staged-ruling removal (archive or delete via the dialog)**: `dropLink`'s remote action
     becomes `archive_issue` **instead of** the cancelled-state write when the provider's
     capability is `trash`/`archive` (cancelled-state write remains the fallback for
     `archive: 'none'` providers, i.e. Plane if probe P1 fails). The enqueue happens INSIDE
     `handleLocalRemoval`/`dropLink` **before** the link is orphaned (outbox rows address
     (connection, external_id), so the drain does not need a live link), and the ruling dialog's
     wording changes from "cancel in the tracker" to "archive/trash in the tracker" where
     applicable. Delete events carry the pre-delete snapshot, so (b) is also the only viable path
     for deletes. The `handleLocalRemoval → listener → scheduleWriteBackDrain` ordering itself is
     preserved — with (b) owning ruling-flows, the listener arm firing afterward finds the link
     already orphaned and correctly does nothing, so no duplicate archive is possible.
   - End-to-end service tests run the REAL `handleLocalRemoval → listener` order for: plain
     archive, ruled archive, ruled delete, and an `archive:'none'` provider.
   Idempotence via an `archivedWrittenAt` stamp on `WriteBackBaselineStamp`. `archive_issue`
   supersedes every queued kind for that external_id (the one legitimate cross-kind sweep) —
   explicit test. Unarchive in v1: no remote write; clear the stamp so a later re-archive fires;
   document the per-provider asymmetry (Linear restorable, Dart one-way, Plane probe-dependent).
3. **Drain**: explicit `processContentWrite` / `processArchive` branches in `processRow` (never
   the fall-through). `processContentWrite` composes from the current entity + effective mappings,
   sends, then stamps `baseline_json` with the RESPONSE values (title/description/priority/
   category + `lastWrittenAt`) — merge onto the blob; if the provider returned nothing (Linear
   without the selection — must not happen; assert), fall back to re-running description alignment.
   `processArchive` treats 404 as success and marks the link orphaned after a confirmed archive.
4. **Conflict resolution flips**: `acceptLocalFieldValue`'s title/description (+ new
   priority/category) arms keep the baseline stamp AND now also enqueue `update_content` —
   stamp-then-enqueue, mirroring the stage arm, **but gated on `content_sync_mode !== 'off'`**:
   `auto`/`manual` say WHEN the ruling reaches the tracker (copy `enqueueStageWriteBack`'s
   documented rule); `'off'` says WHETHER, and an off-mode ruling stamps only (an enqueued row
   would be undrainable — invariant 5). Drain nudge stays mode-aware (`scheduleWriteBackDrain`
   only arms auto-owned kinds; manual waits for "Sync now").
5. **Docblock updates that become lies otherwise**: `alignLocalDescription`'s "NO OUTBOUND ECHO"
   (now true only because of the actor filter — say so); `resolveAmbiguous`'s kind note;
   `outcomeForParkedLink` gains a content arm so a held content change keeps the cursor honest.
6. Idea scope: the same trigger covers `entityType === 'idea'` linked/pushed rows (title/body
   only — ideas have priority too; include it; category applies to both).

## Phase 6 — Wizard + settings UI

- **Wizard Step 4 (States/Mapping card)**: priority mapping table (7 local rows → provider value
  pickers seeded from the effective mapping) + category table (3 rows, Dart only). Provider gating
  via a new `TrackerProviderMeta.supportsCategorySync` boolean (the house pattern — no
  provider-string branches in tracker UI; unsupported renders an inline caption, not a hidden row).
  The two new mode controls join the existing direction-mode block (`Segmented`, three states —
  fix `directionLabel`'s binary ternary before it mislabels `'off'` as "Manual").
- **TrackerConnectedView**: two new settings rows (same useState-mirror → `patchSettings` →
  `onChanged` shape as the existing triplet); summary strings updated; mappings card shows
  read-only "N of 7 priorities mapped" counts (wizard-only editing, per house convention).
- Fixture updates: the three tracker UI test files' connection-summary fixtures gain the new
  fields.

## Phase 7 — Verification gate

- Unit: mapping modules (seed/overlay/corrupt-JSON/rename-loud), merge arms incl. backfill arm and
  provider-space comparison, supersession matrix (incl. archive-supersedes-all and
  content-never-supersedes-state), drain-one-row-of-every-kind, echo suite (outbound write → stamp
  → synthetic inbound pass diffs to no-change, per provider fixture), marker re-append, archive
  404-is-success, `'off'` gating (no enqueue; "Sync now" does not drain; no inbound stall).
- Migration 117/112 tests; `entitySchemaParity`; full `pnpm test:unit` on the settled tree.
- Live smokes, one per provider: edit title/body/priority (+category on Dart) locally → Sync now →
  verify remote + no phantom conflict on the following two passes; archive locally → remote
  trashed; Dart rename-a-type → loud sync-log line, no silent drop.

## Sequencing / parallelism

Phase 1 is independent and can land first (it is also the only phase touching frontend backlog
UI). Phase 0 runs concurrently with 1-3. Phases 2→3→4→5 are ordered (shared files:
`inboundSync.ts`, `outboxWorker.ts`, adapters). Phase 6 depends on 3 (types) but only loosely on
4-5, and can proceed in parallel with 5 in a separate lane if the sprint partitions by file. Each
phase is one reviewable PR-sized change with its own tests green before the next starts.

## Review findings absorbed (Codex adversarial review, 2026-08-21)

All six findings were accepted and folded into the sections above:

1. **[high] Conflict resolution vs `'off'`** — invariant 5 + Phase 5.4: off-mode rulings stamp
   only; enqueue is gated at every site, including conflict resolution.
2. **[high] In-flight dedupe race** — Phase 5.1: dedupe collapses `pending` rows only; an
   `in_flight`/`ambiguous` incumbent gets a successor row instead of suppression.
3. **[high] Archive trigger unreachable through the removal pipeline** — Phase 5.2 redesigned as
   two entry points; `dropLink`'s remote action becomes `archive_issue` (cancelled-state write
   only as the `archive:'none'` fallback), enqueued before orphaning; dialog wording updated;
   real-ordering E2E tests.
4. **[high] `resolveLinked` is single-provider** — Phase 5.1: new arms use `resolveAllLinked`
   with per-link mode/capability/mapping/baseline evaluation; stage arm's pre-existing
   single-link behavior recorded as a follow-up, not silently changed.
5. **[medium] No discovery seam for Dart field options** — Phase 2.3: provider-agnostic
   `listFieldOptions()` on the adapter seam, threaded service → tRPC → shared types → wizard.
6. **[medium] Missed P0-P2 validators** — Phase 1: `taskMutationHandler.ts:59` coercer +
   `cyboflowMcpServer.ts:463-466` schema prose added (both verified in source), plus a closing
   repo-wide literal audit.

## Open items carried from probes

- P1 fails ⇒ Plane archive = unsupported (capability `'none'`, UI caption); revisit if Plane ships
  the archive endpoint in public v1.
- D3 fails (type silently ignored) ⇒ category write-back ships behind the pre-flight membership
  check only, with a loud sync-log line when the check fails.
- D7/L3 (self-write bumps `updatedAt`): if yes, nothing extra — the stamp absorbs it; if no, the
  stamp is still correct (it just never gets exercised by the echo).

## Phase 0 probe transcript (run 2026-08-21, live workspaces, self-created probe tasks only)

**Dart — all probes green.** Against the real `Personal/Tutorial tasks` board; probe tasks
trashed at the end (which doubled as D5).

- **D1** `PUT {priority:'High'}` → 200, echoed and persisted. Negative: `priority:'Bogus'` →
  **400 with the valid-value list in the error body** (`Valid values are: [null, critical, high,
  low, medium]`). Invalid mappings fail LOUD — the pre-flight `/config` membership check is a UX
  nicety, not a correctness requirement.
- **D2** `priority: null` → 200; the cleared field comes back as an **absent key**, not
  `null` — Dart omits null fields from every payload (create echo, detail GET, concise list).
  Inbound must read absent-as-null. P6 ⇄ unset round-trip viable.
- **D3** `type:'Subtask'` → 200 persisted; bogus type → 400 loud with valid values. Category
  write-back viable.
- **D4** title+description PUT → 200; the `cyboflow-sync:` marker line survived verbatim.
- **D5** `DELETE` → 200 + full item echo; GET → 404; visible under `in_trash=true`; second
  DELETE → **404** (`Task with ID … not found`) — the 404-is-success arm is required.
- **D6** `/config` carries `types: [Task, Subtask, Project, Milestone]` and
  `priorities: [critical, high, medium, low]` (plus dartboards/statuses/assignees/tags/sizes/
  skills/customProperties). Mapping seeds have a live source.
- **D7** priority-only PUT bumps `updatedAt` (~3s delta observed) — the response stamp absorbs
  the echo; nothing extra needed.
- **D8** the concise `/tasks/list` row **does carry `priority` and `type` when set**
  (omit-when-null: a null-priority row has no `priority` key at all; a Critical row does).
  Inbound rides the existing list — zero extra requests, no hydration change.
- **Casing (follow-up probe)**: writes are case-insensitive (`priority:'critical'` accepted) but
  every read returns **Title case** (`Critical`), while `/config.priorities` lists **lowercase**
  (`critical`). The priority/category mappings MUST match case-insensitively on the toLocal side
  and stamp baselines from the (Title-case) response values.

**Linear — all probes green.** Two probe issues (BAHV-39/40) in the synced team; both ended
trashed (their cleanup IS the archive probe).

- **L1** route locked: `issueArchive(id, trash: true)` → `success`, entity returns
  `archivedAt` set AND `trashed: true`, selectable in the mutation payload (stamp source works).
  The alternative `issueUpdate({trashed:true})` is **rejected** (`invalid trashed state`) — it is
  not a valid trash entry point. Post-archive: direct `issue(id)` still resolves (archived
  entities reachable by id), `issues(includeArchived:true)` includes it, `includeArchived:false`
  excludes it — inbound echo visibility exactly as the deletion sweep expects.
- **L2** the personal API key executed `issueArchive` — scope covers it.
- **L3** priority-only `issueUpdate` bumps `updatedAt` — stamp absorbs, like Dart.

**Plane — UNPROBED: the stored token is invalid** (403 `Given API token is not valid`; the
connection has been `paused`, its key evidently revoked). Consequences, per the pre-agreed
fallbacks: Plane ships with `archive: 'none'` (UI caption "unsupported"), and the Plane
content-write arm is implemented from the documented lowercase priority enum + the existing
create-path `description_html` precedent, with P1–P3 re-run before any Plane live smoke once a
fresh token is connected. No plan-shape change.

## Review findings absorbed (Codex adversarial round 3, final tree, 2026-08-24)

Both findings were confirmed against the code and fixed:

1. **[high] Outbound content writes overwrote unobserved remote changes.** The drain composed its
   patch against the last stamped baseline and sent blind; a tracker edit landing between the
   inbound stamp and the send was overwritten, and the response stamp erased the evidence. Fix:
   `drainContentWrite` re-reads the issue (`adapter.getIssue`) before sending and compares every
   patched field against the baseline with `composeContentPatch`'s own semantics
   (`contentDivergence`); any divergence settles the row unsent WITHOUT stamping, so
   local ≠ baseline ≠ remote survives for the inbound conflict machinery (auto: remote wins;
   manual: queued). Withheld writes surface in the sync log ("held back N writes · concurrent
   tracker edit"). A gone-remotely pre-read settles done unsent; a failed pre-read retries with
   backoff (nothing was sent). The accept-LOCAL conflict ruling still converges: it stamps the
   ADJUDICATED remote value, which the guard correctly treats as non-divergent — only a FURTHER
   remote edit after the ruling withholds. The read-to-send window remains a race (no provider
   offers conditional writes), but it is milliseconds where the pass cadence was minutes.

2. **[high] The removal dialog promised an archive the default configuration never performs.**
   Under `archive_sync_mode = 'off'` (the migration default) a ruled "Archive in <tracker>"
   fell back to the cancelled-state write — correctly, since an `archive_issue` row is
   undrainable while the direction is off (invariant 5's claim filter) — but the dialog never
   disclosed it. Fix (disclosure, not behavior — mirrors round 2's finding 4): the decision now
   lives once in `removalWriteBackAction(provider, archiveSyncMode)`, consulted by BOTH
   `enqueueRemovalWriteBack` and `linksForEntity`, which stamps each `TrackerEntityLinkRef` with
   `removalAction: 'archive' | 'cancel'`; the dialog's fine print, per-issue list, and confirm
   button ("Archive in X" / "Mark cancelled in X" / "Archive / mark cancelled") are built from
   it. Treating an explicit ruling as consent to pierce the 'off' gate was considered and
   rejected for now: it would need a drain-filter exemption for ruled rows and weakens
   invariant 5's "off means never" — recorded as a possible follow-up.
