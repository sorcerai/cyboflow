/**
 * Pins planner.md's "The design fork" option labels (step 2, `approve-idea`)
 * to QuestionRouter's `isDesignModeForkAnswer` classifier.
 *
 * The two are independent today: the classifier matches a PRESENTED option
 * label that starts with 'approve' and contains 'design mode' (case
 * insensitive), while planner.md is free-form prose describing what labels
 * the orchestrator should present. Nothing ties them together, so either side
 * can drift silently:
 *
 *  - Renaming the fork label in planner.md (e.g. "Hand off to design mode")
 *    would make the classifier return false for every answer. The failure is
 *    silent: the planner still tells the human "design mode is taking it from
 *    here" and ends the run (see planner.md step 2), but no session launches
 *    and nothing reports the miss — reporting only happens AFTER
 *    classification succeeds (questionRouter.ts's launchDesignModeOnFork).
 *  - Renaming the OTHER options to something that happens to start with
 *    'approve' and contain 'design mode' (e.g. "Approve → keep planning,
 *    skip design mode entirely") would make the classifier misfire on a plain
 *    approval.
 *
 * This test reads planner.md's actual prose, extracts the option labels it
 * instructs the orchestrator to present at that gate, and asserts EXACTLY ONE
 * of them satisfies the real classifier — so a rename on either side fails
 * the suite instead of failing silently at runtime. Modeled on the
 * read-the-prompt-body style established by
 * workflows/__tests__/builtInWorkflows.test.ts and
 * workflows/__tests__/agentParity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QuestionRouter, type QuestionAnswer } from '../questionRouter';
import type { QuestionPayload } from '../../../../shared/types/questions';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';

const PLANNER_MD_PATH = join(__dirname, '..', 'workflows', 'planner.md');

/**
 * Extract the option labels planner.md's "The design fork" subsection (step 2
 * `approve-idea`) instructs the orchestrator to present, from the ACTUAL
 * prose rather than a hardcoded copy — so a label rename in the .md changes
 * what this test asserts against, instead of the test silently continuing to
 * check stale text.
 *
 * Returns the 4 labels in the order planner.md presents them: the two fork
 * bullets (`· **label**`), then `Revise` / `Reject` (named via "keep `Revise`
 * / `Reject` unchanged").
 */
function extractDesignForkOptionLabels(body: string): string[] {
  const sectionMatch = body.match(
    /- \*\*The design fork\.\*\*[\s\S]*?(?=\n\s*- \*\*Batch \(>1 surviving\))/,
  );
  if (!sectionMatch) {
    throw new Error(
      'planner.md: could not find "The design fork" subsection under the approve-idea step — ' +
        'has step 2 been restructured? Update this extractor to match.',
    );
  }
  const section = sectionMatch[0];

  const bulletLabels = [...section.matchAll(/·\s*\*\*([^*]+)\*\*/g)].map((m) => m[1].trim());
  if (bulletLabels.length !== 2) {
    throw new Error(
      `planner.md: expected exactly 2 bulleted fork options, found ${bulletLabels.length}: ` +
        JSON.stringify(bulletLabels),
    );
  }

  const keepMatch = section.match(/keep\s+`([^`]+)`\s*\/\s*`([^`]+)`\s+unchanged/);
  if (!keepMatch) {
    throw new Error(
      'planner.md: could not find the "keep `Revise` / `Reject` unchanged" sentence in the ' +
        'design-fork subsection — has the wording changed? Update this extractor to match.',
    );
  }

  return [...bulletLabels, keepMatch[1], keepMatch[2]];
}

function buildRouter(): QuestionRouter {
  const db = createTestDb();
  return QuestionRouter.initialize(dbAdapter(db));
}

describe('planner.md design-fork labels vs isDesignModeForkAnswer', () => {
  it('presents exactly 4 options at the approve-idea fork, and exactly one satisfies the classifier', () => {
    const body = readFileSync(PLANNER_MD_PATH, 'utf-8');
    const labels = extractDesignForkOptionLabels(body);
    expect(labels, 'design-fork presents exactly 4 options (the question-option cap)').toHaveLength(4);

    const questionText = 'Approve this idea?';
    const questions: QuestionPayload[] = [
      {
        question: questionText,
        header: 'Approve idea',
        multiSelect: false,
        options: labels.map((label) => ({ label })),
      },
    ];

    const router = buildRouter();
    const matches = labels.filter((label) => {
      const answer: QuestionAnswer = { answers: { [questionText]: label } };
      return router.isDesignModeForkAnswer(answer, questions);
    });

    expect(
      matches,
      'exactly one presented label must satisfy isDesignModeForkAnswer — planner.md and ' +
        'questionRouter.ts have drifted if this is 0 (silent no-launch) or >1 (misfire)',
    ).toEqual([labels[0]]);
    // The one match must be the FIRST fork bullet — "Approve → design mode" per
    // planner.md's ordering (design mode first, "keep planning" second).
    expect(labels[0].toLowerCase()).toContain('design mode');
  });

  it('sanity: an unrelated label from the same gate does not satisfy the classifier', () => {
    const questionText = 'Approve this idea?';
    const questions: QuestionPayload[] = [
      {
        question: questionText,
        header: 'Approve idea',
        multiSelect: false,
        options: [{ label: 'Approve' }, { label: 'Revise' }, { label: 'Reject' }],
      },
    ];
    const router = buildRouter();
    for (const label of ['Approve', 'Revise', 'Reject']) {
      const answer: QuestionAnswer = { answers: { [questionText]: label } };
      expect(router.isDesignModeForkAnswer(answer, questions), label).toBe(false);
    }
  });
});
