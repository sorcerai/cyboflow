/**
 * trackerSync/provenance — the marker an IMPORTED idea carries in its body, and
 * the split that separates that cyboflow-owned footer from the remote-owned
 * description half.
 *
 * Its own module because BOTH directions need it and they sit on opposite sides
 * of an import edge: inboundSync.ts writes the marker (it is the import's crash
 * recovery key — see that file's IMPORT RECOVERY note) and reads it back, while
 * writeBack.ts must recognize it to keep the PUSH direction from filing a fresh
 * tracker issue for an idea the tracker itself just gave us — and, since the
 * content trigger landed, must also compare the DESCRIPTION half of a body
 * against a link's baseline. inboundSync already imports from writeBack, so
 * exporting any of this from either of them would close a cycle.
 *
 * inboundSync re-exports the three body helpers under their historical names,
 * so every existing call site (and every test) still imports them from there.
 */
import type { TrackerProvider } from '../../../../shared/types/trackerSync';

/** Machine-recognizable marker prefix so the footer can be split back off a body. */
export const PROVENANCE_MARKER_PREFIX = '<!-- cyboflow:tracker';

/**
 * The marker an imported idea's footer opens with. It embeds the issue's
 * `(provider, externalId)` because this is the IMPORT'S RECOVERY KEY: the
 * marker is written in the same statement as the idea, so it is the only
 * durable trace of an import whose link write never happened.
 */
export function provenanceMarker(provider: TrackerProvider, externalId: string): string {
  return `${PROVENANCE_MARKER_PREFIX} ${provider}:${externalId} -->`;
}

/**
 * True when a body carries ANY tracker-import provenance marker — "this idea
 * came FROM a tracker", whichever provider and issue it names.
 *
 * The push direction's third skip case. The actor check ahead of it already
 * catches the ordinary import (inbound applies its writes as `actor: 'linear' |
 * 'plane'`), but an event with no actor at all is merely unattributed, not
 * local — and pushing on one would file a second issue for an issue we are
 * already synced to.
 */
export function carriesTrackerProvenance(body: string | null): boolean {
  return body !== null && body.includes(PROVENANCE_MARKER_PREFIX);
}

// ---------------------------------------------------------------------------
// Body split
// ---------------------------------------------------------------------------

/** The horizontal rule the footer opens with — its own line, hence the newline. */
const FOOTER_FENCE = '---\n';

/** Where a body's cyboflow-owned half begins: the fence immediately followed by the marker. */
const FOOTER_START = FOOTER_FENCE + PROVENANCE_MARKER_PREFIX;

/**
 * Split a stored body into the remote-owned description half and the
 * cyboflow-owned provenance footer half. A body with no footer (a
 * pre-existing entity linked through the wizard's Reconcile step) reads back
 * as description-only, and rejoins without one — we never retro-fit a footer
 * onto an entity the user wrote themselves.
 *
 * Used by the inbound merge, by the service layer's manual conflict-resolution
 * path (which applies a stored `remote_value` description onto an entity and
 * must preserve that entity's footer exactly as a pass would have), and by the
 * outbound content trigger and drain, which compare and SEND only the
 * description half — the footer is ours and belongs in no remote body.
 */
export function splitBody(body: string | null): { description: string | null; footer: string | null } {
  if (body === null) return { description: null, footer: null };
  const at = body.indexOf(FOOTER_START);
  if (at < 0) return { description: body.length > 0 ? body : null, footer: null };
  const description = body.slice(0, at).replace(/\s+$/, '');
  return {
    description: description.length > 0 ? description : null,
    footer: body.slice(at + FOOTER_FENCE.length),
  };
}

/** Inverse of {@link splitBody}. */
export function joinBody(description: string | null, footer: string | null): string | null {
  const desc = description !== null && description.trim().length > 0 ? description : null;
  if (footer === null) return desc;
  const block = `${FOOTER_FENCE}${footer}`;
  return desc === null ? block : `${desc}\n\n${block}`;
}

/**
 * Empty and absent descriptions are the same thing on both sides of a diff.
 *
 * THE single definition of "the same description" for the whole engine: the
 * inbound three-way merge, the outbox worker's post-create/post-write body
 * alignment, and the outbound content trigger's baseline diff all call it.
 * Anything this treats as equal can never become a three-way diff — so writing
 * the local body for it would be a local event with nothing behind it, and
 * ENQUEUING a remote write for it would be a round trip with nothing behind it.
 */
export function normalizeDescription(value: string | null): string {
  return value === null ? '' : value.trim();
}
