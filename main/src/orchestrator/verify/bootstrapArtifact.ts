/**
 * The human-facing surfaces the runbook bootstrap owes its reviewer
 * (docs/proposals/lane-runbook-bootstrap.md §8.1, §12 step 10).
 *
 * WHY THIS IS NOT DECORATION. §15A records the user's decision to keep the
 * rung-1 config edit and accept a REVIEW-BACKED rather than structural safety
 * guarantee for it. That trade only pays if the review actually happens, which
 * means the design owes the human a surface worth reviewing — the proposal is
 * explicit that "a rung-1 bootstrap that produced no visible review surface
 * would be the failure mode this whole section exists to prevent". This module
 * is that surface: the artifact renders what was derived and what was proven,
 * and the finding names the edited file in the review queue where a human is
 * already looking.
 *
 * IT ALSO REPORTS THE FAILURES. A bootstrap that drafted, committed, and then
 * failed its proof has left real state on the branch — an unproven runbook, a
 * spent verification budget, possibly a config edit that bought nothing (§10).
 * v1 claimed failure was "byte-identical to today", which it is not, and hiding
 * an unproven draft would be the same overclaim in a different place. So the
 * artifact is reported on BOTH terminal outcomes, and the unproven one says
 * plainly what is on the branch and what to do about it.
 *
 * PURE — markdown from values, so what a reviewer actually reads is assertable.
 */
import { VERIFY_RUNBOOK_RELATIVE_PATH } from '../../../../shared/types/verifyRunbook';

/** What the artifact describes. Mirrors the runner's terminal outcomes. */
export interface BootstrapArtifactInput {
  modality: string;
  /** The lane that paid for the bootstrap, so a reader knows where it came from. */
  laneTaskRef: string;
  proven: boolean;
  /**
   * The runbook JSON as committed, pretty-printed — or null when the bootstrap
   * was abandoned before it ever committed one. The abandoned case still renders
   * an artifact, because a rung-1 config edit may already be on the branch and
   * that is precisely the case a human must not have to discover from a log.
   */
  runbookJson: string | null;
  /** The drafting agent's derivation notes, when it wrote any. */
  notes: string | null;
  commitSha: string | null;
  runbookHash: string | null;
  runbookVersion: number | null;
  /** The applied rung-1 edit, when there was one. */
  rung1: { path: string; description: string; commitSha: string | null } | null;
  /** Why the proof did not pass; null on the proven path. */
  failureDetail: string | null;
  /** How many draft rounds it took (or spent). */
  rounds: number;
}

function shortSha(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 10);
}

/**
 * Render the `verify-runbook` artifact for a bootstrap.
 *
 * ORDERED FOR THE REVIEWER, not for the machine: what happened, then what a
 * human is being asked to look at, then the evidence. The rung-1 edit comes
 * BEFORE the runbook body on purpose — it is the part of this that changes the
 * project rather than describing it, and burying it under a JSON blob is exactly
 * how a review surface becomes decorative.
 */
export function renderBootstrapArtifact(input: BootstrapArtifactInput): string {
  const parts: string[] = [];

  parts.push(
    `# Verification runbook — derived by this run\n\n` +
      `This run had no proven verification runbook for its \`${input.modality}\` surface, so its UI ` +
      `changes could not be verified. Lane **${input.laneTaskRef}** derived one, committed it, and the ` +
      `engine attempted to prove it by actually standing this project up.`,
  );

  if (input.proven) {
    parts.push(
      `## Result: PROVEN\n\n` +
        'The derived runbook built and served this project, and the running surface identified itself as ' +
        `this deliverable. Verification runs normally from here — in this run and in every later one, ` +
        'unless the project or this machine changes in a way that invalidates the proof.\n\n' +
        `| | |\n|---|---|\n` +
        `| Runbook | \`${VERIFY_RUNBOOK_RELATIVE_PATH}\` |\n` +
        `| Commit | \`${shortSha(input.commitSha)}\` |\n` +
        `| Content hash | \`${input.runbookHash ?? '—'}\` |\n` +
        `| Record version | ${input.runbookVersion ?? '—'} |\n` +
        `| Draft rounds | ${input.rounds} |`,
    );
  } else {
    parts.push(
      `## Result: NOT PROVEN\n\n` +
        'The derived runbook did **not** stand this project up, so nothing was verified and the lane ' +
        'advanced unverified. What is on this branch now:\n\n' +
        (input.commitSha !== null
          ? `- \`${VERIFY_RUNBOOK_RELATIVE_PATH}\` — committed as \`${shortSha(input.commitSha)}\`, ` +
            'registered as an **unproven draft**. It is a starting point, not a working configuration.\n'
          : '- no runbook — the bootstrap was abandoned before it committed one.\n') +
        (input.rung1 !== null
          ? `- \`${input.rung1.path}\` — a configuration change that bought nothing. Reverting it is ` +
            'safe and probably right.\n'
          : '') +
        `\nThe failure, verbatim:\n\n> ${(input.failureDetail ?? 'no detail was recorded').split('\n').join('\n> ')}\n\n` +
        'To fix it properly, run the **Verify Setup** flow: it asks a human to review the runbook before ' +
        'anything is proven, which is the right shape for a project this could not work out on its own.',
    );
  }

  if (input.rung1 !== null) {
    parts.push(
      `## A configuration file was changed — please review it\n\n` +
        `**\`${input.rung1.path}\`** — ${input.rung1.description}.\n\n` +
        `Committed on its own as \`${shortSha(input.rung1.commitSha)}\`, so you can revert it ` +
        'independently of the runbook.\n\n' +
        'This is the one part of this change a machine made to your project rather than about it. It was ' +
        'narrowed as far as it can be automatically — a single typed operation against a single file, ' +
        'refusing anything ambiguous — but a configuration file is executable, so this one asks for your ' +
        'eyes rather than promising it did not need them.',
    );
  }

  if (input.notes !== null && input.notes.trim().length > 0) {
    parts.push(`## How it was derived\n\n${input.notes.trim()}`);
  }

  if (input.runbookJson !== null) {
    parts.push(
      `## The runbook, as committed\n\n\`\`\`json\n${input.runbookJson.trim()}\n\`\`\`\n\n` +
        'It was derived by reading this project — its `package.json` scripts above all — and every command ' +
        'in it had to resolve to a script this project already declares. Nothing here was invented.',
    );
  }

  return parts.join('\n\n');
}

/**
 * The review-queue finding for an applied rung-1 edit.
 *
 * Filed SEPARATELY from the artifact, and non-blocking, because the two reach
 * different readers: the artifact is a tab someone opens when they are curious,
 * the finding is a row in the queue a human works through at the merge gate.
 * §8.1 requires the second one specifically — "a finding is filed naming the
 * file that was auto-edited, worded as something to review, not as an FYI" —
 * and an artifact alone would satisfy the letter of that while missing its point.
 */
export function renderRung1Finding(input: {
  laneTaskRef: string;
  modality: string;
  proven: boolean;
  rung1: { path: string; description: string; commitSha: string | null };
}): { title: string; body: string } {
  return {
    title: `Review a configuration change made automatically: ${input.rung1.path}`,
    body:
      `While deriving a \`${input.modality}\` verification runbook for lane **${input.laneTaskRef}**, the ` +
      `harness changed one configuration file in this branch:\n\n` +
      `**\`${input.rung1.path}\`** — ${input.rung1.description}.\n\n` +
      `It is committed on its own (\`${shortSha(input.rung1.commitSha)}\`), so it can be reverted ` +
      'without touching anything else.\n\n' +
      (input.proven
        ? 'The change worked: verification now stands this project up and runs. Keeping it is the ' +
          'reason verification will keep working here.\n\n'
        : 'The change did **not** achieve what it was for — the runbook still failed to stand this ' +
          'project up — so it bought nothing and reverting it is probably right.\n\n') +
      'Please look at it before merging. Every automatic edit here is a single typed operation against a ' +
      'single file, and anything ambiguous is refused outright — but a configuration file decides what ' +
      'gets built and what gets served, and that is not something a machine gets to change unreviewed.',
  };
}
