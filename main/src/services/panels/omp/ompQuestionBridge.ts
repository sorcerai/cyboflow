import type { QuestionAnswer, QuestionPayload } from '../../../orchestrator/questionRouter';
import type { Logger } from '../../../utils/logger';
import type { OmpExtensionUiRequestEvent, OmpExtensionUiResponse } from './rpc';

/** The QuestionRouter surface OMP needs; injectable so the bridge stays unit-testable. */
export interface OmpQuestionRouterPort {
  requestQuestion(
    runId: string,
    toolUseId: string,
    questions: QuestionPayload[],
    socketReply: (answer: QuestionAnswer) => void,
  ): Promise<QuestionAnswer>;
}

export interface OmpQuestionBridgeOptions {
  /** The active logical turn's run id. Null while the warm OMP process is parked. */
  getRunId(): string | null;
  getQuestionRouter(): OmpQuestionRouterPort;
  respond(response: OmpExtensionUiResponse): void;
  onError(error: Error): void;
  logger?: Logger;
}

/** OMP's native picker adds this option; Cyboflow's question card already has Other. */
const OMP_OTHER_OPTION = /^Other(?: \(type your own\))?$/i;

/**
 * Bridges OMP's blocking extension-UI dialogs into Cyboflow's durable question
 * surface. One OMP dialog becomes one QuestionRouter gate; the answer is written
 * back on OMP's side-channel control frame, which resumes the native `ask` tool.
 */
export class OmpQuestionBridge {
  private readonly pending = new Set<string>();
  private disposed = false;

  constructor(private readonly options: OmpQuestionBridgeOptions) {}

  handleUiRequest(event: OmpExtensionUiRequestEvent): void {
    if (this.disposed || this.pending.has(event.id)) return;
    this.pending.add(event.id);
    void this.route(event);
  }

  teardown(): void {
    this.disposed = true;
    this.pending.clear();
  }

  private async route(event: OmpExtensionUiRequestEvent): Promise<void> {
    try {
      const runId = this.options.getRunId();
      if (runId === null) {
        throw new Error(`OMP raised a blocking ${event.method} dialog with no active turn`);
      }

      const question = toQuestionPayload(event);
      const answer = await this.options.getQuestionRouter().requestQuestion(
        runId,
        event.id,
        [question],
        () => undefined,
      );
      if (!this.pending.delete(event.id) || this.disposed) return;

      const value = answer.answers[question.question];
      if (value === undefined || value.length === 0) {
        this.options.respond(cancelledResponse(event.id));
        return;
      }
      this.options.respond(toOmpResponse(event, value));
    } catch (cause) {
      if (!this.pending.delete(event.id) || this.disposed) return;
      const error = new Error(
        `OMP question routing failed for ${event.method} request ${event.id}`,
        { cause },
      );
      this.options.onError(error);
      try {
        this.options.respond(cancelledResponse(event.id));
      } catch (respondCause) {
        this.options.logger?.warn(
          `[OmpQuestionBridge] failed to cancel ${event.id} after routing error: ` +
            `${respondCause instanceof Error ? respondCause.message : String(respondCause)}`,
        );
      }
    }
  }
}

export function toQuestionPayload(event: OmpExtensionUiRequestEvent): QuestionPayload {
  switch (event.method) {
    case 'select':
      return {
        header: 'Choose',
        question: nonEmpty(event.title, 'Choose an option'),
        multiSelect: false,
        options: (event.options ?? [])
          .filter((label) => !OMP_OTHER_OPTION.test(label))
          .map((label) => ({ label })),
      };
    case 'confirm':
      return {
        header: 'Confirm',
        question: nonEmpty(event.message, nonEmpty(event.title, 'Continue?')),
        multiSelect: false,
        options: [
          { label: 'Confirm' },
          { label: 'Cancel' },
        ],
      };
    case 'input':
      return {
        header: 'Input',
        question: nonEmpty(event.title, 'Enter a response'),
        multiSelect: false,
        options: [],
      };
    case 'editor':
      return {
        header: 'Response',
        question: nonEmpty(event.title, 'Enter a response'),
        multiSelect: false,
        options: [],
      };
    default:
      throw new Error(`Unsupported OMP question method: ${event.method}`);
  }
}

function toOmpResponse(
  event: OmpExtensionUiRequestEvent,
  value: string,
): OmpExtensionUiResponse {
  if (event.method === 'confirm') {
    return {
      type: 'extension_ui_response',
      id: event.id,
      confirmed: value.trim().toLowerCase() === 'confirm',
    };
  }
  return { type: 'extension_ui_response', id: event.id, value };
}

function cancelledResponse(id: string): OmpExtensionUiResponse {
  return { type: 'extension_ui_response', id, cancelled: true };
}

function nonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}
