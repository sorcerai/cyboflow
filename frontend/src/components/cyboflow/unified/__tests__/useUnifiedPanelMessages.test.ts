import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedMessage } from '../../../../../../shared/types/unifiedMessage';
import {
  mergePanelMessageSources,
  useUnifiedPanelMessages,
} from '../useUnifiedPanelMessages';

const apiMocks = vi.hoisted(() => ({
  getConversationMessages: vi.fn(),
  getJsonMessages: vi.fn(),
}));

vi.mock('../../../../utils/api', () => ({
  API: {
    panels: apiMocks,
  },
}));

beforeEach(() => {
  apiMocks.getConversationMessages.mockReset().mockResolvedValue({ success: true, data: [] });
  apiMocks.getJsonMessages.mockReset().mockResolvedValue({ success: true, data: [] });
});

function user(id: string, text: string, timestamp: string): UnifiedMessage {
  return {
    id,
    role: 'user',
    timestamp,
    segments: [{ type: 'text', content: text }],
  };
}

function assistant(id: string, text: string, timestamp: string): UnifiedMessage {
  return {
    id,
    role: 'assistant',
    timestamp,
    segments: [{ type: 'text', content: text }],
  };
}

describe('mergePanelMessageSources', () => {
  it('prefers one projected Codex user turn over duplicate conversation rows', () => {
    const result = mergePanelMessageSources(
      [
        user('conversation-1', 'same prompt', '2026-07-13T23:19:07Z'),
        user('conversation-2', 'same prompt', '2026-07-13T23:19:09Z'),
      ],
      [
        user('projected-user', 'same prompt', '2026-07-13T23:19:09Z'),
        assistant('projected-assistant', 'done', '2026-07-13T23:19:11Z'),
      ],
    );

    expect(result.map((message) => message.id)).toEqual([
      'projected-user',
      'projected-assistant',
    ]);
  });

  it('preserves repeated projected turns with identical text', () => {
    const result = mergePanelMessageSources(
      [user('conversation', 'retry', '2026-07-13T23:19:07Z')],
      [
        user('projected-1', 'retry', '2026-07-13T23:19:09Z'),
        assistant('assistant-1', 'first', '2026-07-13T23:19:11Z'),
        user('projected-2', 'retry', '2026-07-13T23:20:09Z'),
      ],
    );

    expect(result.filter((message) => message.role === 'user')).toHaveLength(2);
  });

  it('keeps the immediate conversation turn until a provider echo exists', () => {
    const result = mergePanelMessageSources(
      [user('conversation', 'starting now', '2026-07-13T23:19:07Z')],
      [],
    );

    expect(result.map((message) => message.id)).toEqual(['conversation']);
  });
});

describe('useUnifiedPanelMessages', () => {
  it('refetches when output becomes available for its panel', async () => {
    renderHook(() => useUnifiedPanelMessages('panel-1'));

    await waitFor(() => {
      expect(apiMocks.getJsonMessages).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: { sessionId: 'session-1', panelId: 'panel-1' },
      }));
    });

    await waitFor(() => {
      expect(apiMocks.getJsonMessages).toHaveBeenCalledTimes(2);
    }, { timeout: 1_500 });
  });

  it('retries a live refresh that arrives while the initial fetch is still in flight', async () => {
    let resolveInitialConversation!: (value: { success: true; data: [] }) => void;
    const initialConversation = new Promise<{ success: true; data: [] }>((resolve) => {
      resolveInitialConversation = resolve;
    });
    apiMocks.getConversationMessages
      .mockReset()
      .mockReturnValueOnce(initialConversation)
      .mockResolvedValue({
        success: true,
        data: [{
          id: 1,
          session_id: 'session-1',
          message_type: 'user',
          content: 'accepted while loading',
          timestamp: '2026-08-18 18:03:29',
        }],
      });

    const { result } = renderHook(() => useUnifiedPanelMessages('panel-1'));

    await waitFor(() => {
      expect(apiMocks.getJsonMessages).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: { sessionId: 'session-1', panelId: 'panel-1' },
      }));
    });

    // Let the debounced live loader run into the in-flight guard. Before the
    // fix this notification was discarded and no second query ever happened.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(apiMocks.getJsonMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialConversation({ success: true, data: [] });
      await initialConversation;
    });

    await waitFor(() => {
      expect(apiMocks.getJsonMessages).toHaveBeenCalledTimes(2);
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].segments).toEqual([
        { type: 'text', content: 'accepted while loading' },
      ]);
    });
  });
});
