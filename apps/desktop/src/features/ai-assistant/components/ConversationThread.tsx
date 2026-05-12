import { Bot, User } from 'lucide-react';

import {
  AiRunStateNotice,
  AiSuggestionPreviewActions,
} from '../../ai';
import type { AiSuggestionPreviewState } from '../../ai';
import type { AiError, AiMessage, AiRun } from '../types';

export type ConversationSuggestionDraftState = AiSuggestionPreviewState;

interface ConversationThreadProps {
  messages: AiMessage[];
  activeRun: AiRun | null;
  lastError: AiError | null;
  revisionNotice: string | null;
  suggestionDrafts?: Record<string, ConversationSuggestionDraftState>;
  onSaveSuggestionDraft?: (messageId: string) => void;
  onReviewSuggestionDraft?: (messageId: string) => void;
  onRetry?: () => void;
}

export function ConversationThread({
  messages,
  activeRun,
  lastError,
  revisionNotice,
  suggestionDrafts = {},
  onSaveSuggestionDraft,
  onReviewSuggestionDraft,
  onRetry,
}: ConversationThreadProps) {
  const hasAssistantResult = activeRun?.status === 'completed' && messages.some((message) => message.role === 'assistant');

  return (
    <section className="ai-assistant-thread" aria-label="AI conversation">
      {messages.length === 0 ? (
        <p className="ai-assistant-empty">No messages yet.</p>
      ) : (
        messages.map((message) => (
          <article className={`ai-message ${message.role}`} key={message.id}>
            <span className="ai-message-icon" aria-hidden="true">
              {message.role === 'user' ? <User size={15} /> : <Bot size={15} />}
            </span>
            <div>
              <div className="ai-message-meta">
                <strong>{messageRoleLabel(message.role)}</strong>
                {message.contextLabel ? <span>{message.contextLabel}</span> : null}
              </div>
              <p>{message.content}</p>
              {message.role === 'assistant' && suggestionDrafts[message.id] ? (
                <AiSuggestionPreviewActions
                  messageId={message.id}
                  state={suggestionDrafts[message.id]}
                  onCreatePreview={onSaveSuggestionDraft}
                  onReviewPreview={onReviewSuggestionDraft}
                />
              ) : null}
            </div>
          </article>
        ))
      )}

      <AiRunStateNotice
        activeRun={activeRun}
        lastError={lastError}
        resultMessage={hasAssistantResult ? 'AI response ready.' : null}
        onRetry={onRetry}
      />

      {revisionNotice ? (
        <p className="ai-assistant-revision-note">{revisionNotice}</p>
      ) : null}
    </section>
  );
}

function messageRoleLabel(role: AiMessage['role']): string {
  switch (role) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Assistant';
    case 'error':
      return 'Error';
  }
}
