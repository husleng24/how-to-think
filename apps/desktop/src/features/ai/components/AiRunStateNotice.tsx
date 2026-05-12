import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Loader2,
} from 'lucide-react';

import type {
  AiError,
  AiRun,
} from '../../ai-assistant/types';

export interface AiRunStateNoticeProps {
  activeRun: AiRun | null;
  lastError: AiError | null;
  resultMessage?: string | null;
  onRetry?: () => void;
}

export function AiRunStateNotice({
  activeRun,
  lastError,
  resultMessage,
  onRetry,
}: AiRunStateNoticeProps) {
  const runStatus = activeRun?.status ?? null;
  const isInFlight = runStatus === 'queued' || runStatus === 'running' || runStatus === 'streaming';

  if (isInFlight) {
    return (
      <div className="ai-run-state running" role="status">
        <Loader2 className="spin" size={16} aria-hidden="true" />
        <span>{runStatus === 'streaming' ? 'Streaming response.' : 'AI run in progress.'}</span>
      </div>
    );
  }

  if (activeRun?.status === 'cancelled') {
    return (
      <div className="ai-run-state cancelled" role="status">
        <CircleStop size={16} aria-hidden="true" />
        <span>AI run cancelled.</span>
      </div>
    );
  }

  if (lastError) {
    return (
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
    );
  }

  if (activeRun?.status === 'completed' && resultMessage) {
    return (
      <div className="ai-run-state completed" role="status">
        <CheckCircle2 size={16} aria-hidden="true" />
        <span>{resultMessage}</span>
      </div>
    );
  }

  return null;
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
