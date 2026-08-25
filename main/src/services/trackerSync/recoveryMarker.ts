/**
 * trackerSync/recoveryMarker — the `cyboflow-sync: <clientKey>` line every
 * create stamps into a remote issue's description on a provider whose creates
 * are not natively idempotent (Dart, Plane).
 *
 * ITS OWN MODULE because THREE places now depend on the exact same string and
 * they sit on opposite sides of the adapter seam:
 *
 *   - the adapters WRITE it on create and STRIP it from every description they
 *     return, so it never reaches a local body or a merge baseline;
 *   - `findIssueByClientKey` reads it back, and its whole proof — "no candidate
 *     carries this key ⇒ our create never landed, so a retry is safe" — holds
 *     only because every create writes it;
 *   - the OUTBOUND CONTENT WRITE re-appends it
 *     (docs/proposals/tracker-field-writeback.md invariant 4). A body write-back
 *     that sent the local text verbatim would erase the marker and quietly make
 *     that proof unsound for the link, turning the next lost create response
 *     into a duplicate issue.
 *
 * The third caller lives in outboxWorker, above the seam, and the seam
 * deliberately does NOT compose markers itself (see `IssueContentPatch.description`:
 * the key is link-specific and the adapter is handed only a body). A third copy
 * of the literal is exactly the drift this module exists to prevent.
 *
 * MARKDOWN, NOT HTML. The marker is appended as its own trailing markdown
 * paragraph. Dart stores markdown, so that is what it receives; Plane converts
 * markdown to html on the way in, and its blank-line paragraph split turns this
 * trailing line into the same `<p>cyboflow-sync: …</p>` its create path emits.
 * One composer, both providers.
 */

/** Machine-recognizable prefix — the adapters' strip/read regexes key on it. */
export const RECOVERY_MARKER_PREFIX = 'cyboflow-sync:';

/** The marker line for one client key, with no surrounding whitespace. */
export function recoveryMarkerLine(clientKey: string): string {
  return `${RECOVERY_MARKER_PREFIX} ${clientKey}`;
}

/**
 * `markdown` with the recovery marker as its own trailing paragraph.
 *
 * An EMPTY (or absent) body yields the bare marker rather than a leading blank
 * line: the marker is UNCONDITIONAL — an empty-bodied create must carry it too,
 * or `findIssueByClientKey`'s absence proof stops holding for that issue.
 */
export function appendRecoveryMarker(
  markdown: string | null | undefined,
  clientKey: string,
): string {
  const marker = recoveryMarkerLine(clientKey);
  const body = (markdown ?? '').trim();
  return body.length === 0 ? marker : `${body}\n\n${marker}`;
}
