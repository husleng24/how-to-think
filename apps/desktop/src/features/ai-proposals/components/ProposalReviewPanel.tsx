import {
  AlertTriangle,
  Check,
  CircleAlert,
  FileText,
  GitBranch,
  Layers3,
  LoaderCircle,
  X,
} from 'lucide-react';
import { useMemo } from 'react';

import { HIGH_RISK_CONFIRMATION_FLAGS } from '../application/messageMapping';
import { createProposalPreviewModel } from '../application/proposalPreviewAdapter';
import type { ProposalRiskFlag } from '../domain/types';
import type { ProposalReview } from '../application/types';

export interface ProposalReviewPanelProps {
  review: ProposalReview | null;
  onAccept?: (review: ProposalReview) => void;
  onReject?: (review: ProposalReview) => void;
  onDismiss?: (review: ProposalReview) => void;
  onConfirmRiskFlag?: (riskFlag: ProposalRiskFlag, review: ProposalReview) => void;
  onClearRiskConfirmation?: (riskFlag: ProposalRiskFlag, review: ProposalReview) => void;
}

export function ProposalReviewPanel({
  review,
  onAccept,
  onReject,
  onDismiss,
  onConfirmRiskFlag,
  onClearRiskConfirmation,
}: ProposalReviewPanelProps) {
  const preview = useMemo(() => (review ? createProposalPreviewModel(review) : null), [review]);

  if (!review || !preview) {
    return (
      <section className="proposal-panel empty" aria-label="AI proposal review">
        <div className="proposal-panel-heading">
          <p className="panel-kicker">AI proposal</p>
          <span className="proposal-status">No draft</span>
        </div>
        <p className="proposal-empty">AI suggestions will appear here before they touch the editor.</p>
      </section>
    );
  }

  const canReject = review.status !== 'applying' && review.status !== 'applied' && review.status !== 'rejected';
  const canDismiss = review.status === 'applied' || review.status === 'rejected' || review.status === 'failed';
  const riskFlags = review.proposal?.riskFlags.filter((riskFlag) =>
    HIGH_RISK_CONFIRMATION_FLAGS.includes(riskFlag),
  ) ?? [];

  return (
    <section className="proposal-panel" aria-label="AI proposal review" aria-live="polite">
      <div className="proposal-panel-heading">
        <div>
          <p className="panel-kicker">AI proposal</p>
          <h2>{preview.title}</h2>
        </div>
        <span className={`proposal-status ${review.status}`}>{preview.statusLabel}</span>
      </div>

      <dl className="proposal-summary">
        <div>
          <dt>Source</dt>
          <dd>{preview.source}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{preview.scopeLabel}</dd>
        </div>
        <div>
          <dt>Review</dt>
          <dd>Whole proposal</dd>
        </div>
      </dl>

      {preview.messages.length > 0 ? (
        <div className="proposal-message-list" aria-label="Proposal status messages">
          {preview.messages.map((message) => (
            <article className={`proposal-message ${message.severity}`} key={messageKey(message)}>
              {message.severity === 'error' ? <CircleAlert size={16} /> : <AlertTriangle size={16} />}
              <div>
                <strong>{message.title}</strong>
                <p>{message.detail}</p>
                {message.field || message.operationId || message.filePath ? (
                  <small>
                    {[message.field, message.operationId, message.filePath].filter(Boolean).join(' | ')}
                  </small>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {riskFlags.length > 0 ? (
        <fieldset className="proposal-risk-confirmations">
          <legend>Confirm high-risk changes</legend>
          {riskFlags.map((riskFlag) => {
            const checked = review.confirmedRiskFlags.includes(riskFlag);

            return (
              <label key={riskFlag}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    event.currentTarget.checked
                      ? onConfirmRiskFlag?.(riskFlag, review)
                      : onClearRiskConfirmation?.(riskFlag, review)
                  }
                />
                <span>{formatRiskFlag(riskFlag)}</span>
              </label>
            );
          })}
        </fieldset>
      ) : null}

      <div className="proposal-impact-grid" aria-label="Proposal impact">
        <div>
          <span className="proposal-impact-icon" aria-hidden="true">
            <Layers3 size={15} />
          </span>
          <strong>{preview.affectedNodes.length}</strong>
          <span>nodes</span>
        </div>
        <div>
          <span className="proposal-impact-icon" aria-hidden="true">
            <FileText size={15} />
          </span>
          <strong>{preview.affectedFiles.length}</strong>
          <span>files</span>
        </div>
        <div>
          <span className="proposal-impact-icon" aria-hidden="true">
            <GitBranch size={15} />
          </span>
          <strong>{preview.operations.length}</strong>
          <span>operations</span>
        </div>
      </div>

      {preview.affectedFiles.length > 0 ? (
        <section className="proposal-section" aria-label="Affected files">
          <h3>Affected files</h3>
          <ul className="proposal-file-list">
            {preview.affectedFiles.map((file) => (
              <li key={file.path}>
                <span>{file.path}</span>
                <small>{file.changeKind}</small>
                {file.diagnostics.length > 0 ? (
                  <em>{file.diagnostics.join(' ')}</em>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {preview.operations.length > 0 ? (
        <section className="proposal-section" aria-label="Structured changes">
          <h3>Structured changes</h3>
          <ol className="proposal-operation-list">
            {preview.operations.map((operation) => (
              <li key={operation.operationId}>
                <strong>{operation.label}</strong>
                <span>{operation.target}</span>
                <p>{operation.description}</p>
                <small>{operation.filePath}</small>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {preview.rawDraftContent ? (
        <section className="proposal-section" aria-label="Suggestion draft content">
          <h3>Suggestion draft</h3>
          <pre className="proposal-draft-content">{preview.rawDraftContent}</pre>
        </section>
      ) : null}

      {preview.affectedFiles.some((file) => file.beforeMarkdown || file.afterMarkdown) ? (
        <section className="proposal-section" aria-label="Markdown preview">
          <h3>Markdown preview</h3>
          {preview.affectedFiles
            .filter((file) => file.beforeMarkdown || file.afterMarkdown)
            .map((file) => (
              <div className="proposal-markdown-preview" key={file.path}>
                <strong>{file.path}</strong>
                <div>
                  <pre aria-label={`Before ${file.path}`}>{file.beforeMarkdown ?? 'No baseline preview'}</pre>
                  <pre aria-label={`After ${file.path}`}>{file.afterMarkdown ?? 'No generated preview'}</pre>
                </div>
              </div>
            ))}
        </section>
      ) : null}

      {preview.acceptDisabledMessages.length > 0 ? (
        <div className="proposal-disabled-reasons" aria-label="Accept disabled reasons">
          {preview.acceptDisabledMessages.map((message) => (
            <span key={messageKey(message)}>{message.detail}</span>
          ))}
        </div>
      ) : null}

      <div className="proposal-actions">
        <button
          className="text-button reject"
          type="button"
          disabled={!canReject}
          onClick={() => onReject?.(review)}
        >
          <X size={16} />
          Reject
        </button>
        {canDismiss ? (
          <button className="text-button" type="button" onClick={() => onDismiss?.(review)}>
            Dismiss
          </button>
        ) : null}
        <button
          className="text-button accept"
          type="button"
          disabled={!preview.canAccept}
          onClick={() => onAccept?.(review)}
        >
          {review.status === 'applying' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
          Accept whole proposal
        </button>
      </div>
    </section>
  );
}

function messageKey(message: { code: string; field?: string; operationId?: string; filePath?: string }): string {
  return [message.code, message.field, message.operationId, message.filePath].filter(Boolean).join(':');
}

function formatRiskFlag(riskFlag: ProposalRiskFlag): string {
  return riskFlag.replace(/_/g, ' ');
}
