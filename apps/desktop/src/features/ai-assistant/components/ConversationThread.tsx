import { AlertTriangle, Bot, CircleStop, Loader2, User } from 'lucide-react';

import type { AiError, AiMessage, AiRun } from '../types';

interface ConversationThreadProps {
  messages: AiMessage[];
  activeRun: AiRun | null;
  lastError: AiError | null;
  revisionNotice: string | null;
  onRetry?: () => void;
}

export function ConversationThread({
  messages,
  activeRun,
  lastError,
  revisionNotice,
  onRetry,
}: ConversationThreadProps) {
  const runStatus = activeRun?.status ?? null;
  const isInFlight = runStatus === 'queued' || runStatus === 'running' || runStatus === 'streaming';

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
            </div>
          </article>
        ))
      )}

      {isInFlight ? (
        <div className="ai-run-state running" role="status">
          <Loader2 className="spin" size={16} aria-hidden="true" />
          <span>{runStatus === 'streaming' ? 'Streaming response.' : 'AI run in progress.'}</span>
        </div>
      ) : null}

      {activeRun?.status === 'cancelled' ? (
        <div className="ai-run-state cancelled" role="status">
          <CircleStop size={16} aria-hidden="true" />
          <span>AI run cancelled.</span>
        </div>
      ) : null}

      {lastError ? (
        <div className="ai-run-state failed" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <strong>{errorTitle(lastError)}</strong>
            <span>{lastError.message}</span>
            {lastError.guidance ? <span>{lastError.guidance}</span> : null}
            {onRetry && lastError.recoverable ? (
              <button className="text-button ai-assistant-compact-action" type="button" onClick={onRetry}>
                Retry
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

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

function errorTitle(error: AiError): string {
  switch (error.code) {
    case 'provider_timed_out':
      return 'Timed out';
    case 'provider_unavailable':
    case 'provider_not_configured':
    case 'provider_disabled':
    case 'provider_config_invalid':
      return 'Provider unavailable';
    case 'provider_cancelled':
      return 'Cancelled';
    default:
      return 'AI run failed';
  }
}
