import { invoke } from '@tauri-apps/api/core';

import type {
  AiContextSnapshot,
  AiContextSnapshotRequest,
  AiConversationRequest,
  AiResponse,
  AiRun,
  AiRunEvent,
  AiSession,
  WorkspaceId,
} from '../types';

export interface AiConversationClient {
  previewContext(request: AiContextSnapshotRequest): Promise<AiContextSnapshot>;
  sendMessage(request: AiConversationRequest): Promise<AiResponse>;
  cancelRun(runId: string): Promise<AiRun>;
  listSessions(workspaceId?: WorkspaceId): Promise<AiSession[]>;
  onRunEvent(handler: (event: AiRunEvent) => void): Promise<() => void>;
}

export const tauriAiConversationClient: AiConversationClient = {
  previewContext(request) {
    ensureTauriRuntime();
    return invoke<AiContextSnapshot>('preview_ai_context_snapshot', { request });
  },

  sendMessage(request) {
    ensureTauriRuntime();
    return invoke<AiResponse>('send_ai_conversation_message', { request });
  },

  cancelRun(runId) {
    ensureTauriRuntime();
    return invoke<AiRun>('cancel_ai_run', { runId });
  },

  listSessions(workspaceId) {
    ensureTauriRuntime();
    return invoke<AiSession[]>('list_ai_sessions', { workspaceId });
  },

  async onRunEvent(handler) {
    if (!canUseTauriInvoke()) {
      return () => undefined;
    }

    const { listen } = await import('@tauri-apps/api/event');
    return listen<AiRunEvent>('ai-run-status', (event) => handler(event.payload));
  },
};

function ensureTauriRuntime(): void {
  if (!canUseTauriInvoke()) {
    throw new Error('AI conversations are only available in the desktop runtime.');
  }
}

function canUseTauriInvoke(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}
