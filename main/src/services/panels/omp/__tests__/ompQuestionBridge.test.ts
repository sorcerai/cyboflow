import { describe, expect, it, vi } from 'vitest';
import {
  OmpQuestionBridge,
  type OmpQuestionRouterPort,
  toQuestionPayload,
} from '../ompQuestionBridge';
import type { OmpExtensionUiRequestEvent, OmpExtensionUiResponse } from '../rpc';

function request(
  method: string,
  overrides: Partial<OmpExtensionUiRequestEvent> = {},
): OmpExtensionUiRequestEvent {
  return { type: 'extension_ui_request', id: 'ui-1', method, ...overrides };
}

function harness(answer: { answers: Record<string, string> } = { answers: {} }): {
  bridge: OmpQuestionBridge;
  requestQuestion: ReturnType<typeof vi.fn>;
  responses: OmpExtensionUiResponse[];
  errors: Error[];
} {
  const requestQuestion = vi.fn(async () => answer);
  const responses: OmpExtensionUiResponse[] = [];
  const errors: Error[] = [];
  const bridge = new OmpQuestionBridge({
    getRunId: () => 'run-1',
    getQuestionRouter: () => ({ requestQuestion } satisfies OmpQuestionRouterPort),
    respond: (response) => responses.push(response),
    onError: (error) => errors.push(error),
  });
  return { bridge, requestQuestion, responses, errors };
}

describe('OmpQuestionBridge', () => {
  it('surfaces a select through QuestionRouter and resumes OMP with the answer', async () => {
    const title = 'Where should the Blog card link?';
    const fake = harness({ answers: { [title]: '/changelog (Recommended)' } });
    fake.bridge.handleUiRequest(request('select', {
      title,
      options: ['/changelog (Recommended)', '/blog', 'Other (type your own)'],
    }));

    await vi.waitFor(() => expect(fake.responses).toHaveLength(1));
    expect(fake.requestQuestion).toHaveBeenCalledWith(
      'run-1',
      'ui-1',
      [{
        header: 'Choose',
        question: title,
        multiSelect: false,
        options: [
          { label: '/changelog (Recommended)' },
          { label: '/blog' },
        ],
      }],
      expect.any(Function),
    );
    expect(fake.responses).toEqual([{
      type: 'extension_ui_response',
      id: 'ui-1',
      value: '/changelog (Recommended)',
    }]);
    expect(fake.errors).toEqual([]);
  });

  it('maps confirm answers to the protocol boolean response', async () => {
    const fake = harness({ answers: { 'Apply these changes?': 'Confirm' } });
    fake.bridge.handleUiRequest(request('confirm', {
      title: 'Confirmation',
      message: 'Apply these changes?',
    }));

    await vi.waitFor(() => expect(fake.responses).toHaveLength(1));
    expect(fake.responses[0]).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      confirmed: true,
    });
  });

  it.each(['input', 'editor'])('returns free text for %s dialogs', async (method) => {
    const fake = harness({ answers: { 'Describe the destination': 'https://example.com/blog' } });
    fake.bridge.handleUiRequest(request(method, { title: 'Describe the destination' }));

    await vi.waitFor(() => expect(fake.responses).toHaveLength(1));
    expect(fake.responses[0]).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      value: 'https://example.com/blog',
    });
  });

  it('cancels an OMP dialog when run teardown settles the gate with no answer', async () => {
    const fake = harness({ answers: {} });
    fake.bridge.handleUiRequest(request('select', { title: 'Pick', options: ['A', 'B'] }));

    await vi.waitFor(() => expect(fake.responses).toHaveLength(1));
    expect(fake.responses[0]).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      cancelled: true,
    });
    expect(fake.errors).toEqual([]);
  });

  it('reports routing failure and cancels the native dialog', async () => {
    const fake = harness();
    fake.requestQuestion.mockRejectedValueOnce(new Error('run is not active'));
    fake.bridge.handleUiRequest(request('select', { title: 'Pick', options: ['A', 'B'] }));

    await vi.waitFor(() => expect(fake.errors).toHaveLength(1));
    expect(fake.errors[0].message).toContain('OMP question routing failed');
    expect(fake.errors[0].cause).toEqual(new Error('run is not active'));
    expect(fake.responses[0]).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      cancelled: true,
    });
  });

  it('ignores duplicate request ids while one question is pending', async () => {
    let resolveAnswer!: (answer: { answers: Record<string, string> }) => void;
    const fake = harness();
    fake.requestQuestion.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAnswer = resolve;
    }));
    const event = request('select', { title: 'Pick', options: ['A', 'B'] });

    fake.bridge.handleUiRequest(event);
    fake.bridge.handleUiRequest(event);
    expect(fake.requestQuestion).toHaveBeenCalledOnce();
    resolveAnswer({ answers: { Pick: 'A' } });
    await vi.waitFor(() => expect(fake.responses).toHaveLength(1));
  });

  it('does not write a late answer after teardown', async () => {
    let resolveAnswer!: (answer: { answers: Record<string, string> }) => void;
    const fake = harness();
    fake.requestQuestion.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAnswer = resolve;
    }));
    fake.bridge.handleUiRequest(request('select', { title: 'Pick', options: ['A', 'B'] }));

    fake.bridge.teardown();
    resolveAnswer({ answers: { Pick: 'A' } });
    await Promise.resolve();
    expect(fake.responses).toEqual([]);
  });
});

describe('toQuestionPayload', () => {
  it('uses confirm message text and supplies explicit choices', () => {
    expect(toQuestionPayload(request('confirm', {
      title: 'Confirm',
      message: 'Continue deployment?',
    }))).toEqual({
      header: 'Confirm',
      question: 'Continue deployment?',
      multiSelect: false,
      options: [{ label: 'Confirm' }, { label: 'Cancel' }],
    });
  });
});
