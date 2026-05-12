import { FileText } from 'lucide-react';

export interface AiSuggestionPreviewState {
  status: 'candidate' | 'draft';
  warnings: string[];
}

export interface AiSuggestionPreviewActionsProps {
  messageId: string;
  state: AiSuggestionPreviewState;
  onCreatePreview?: (messageId: string) => void;
  onReviewPreview?: (messageId: string) => void;
}

export function AiSuggestionPreviewActions({
  messageId,
  state,
  onCreatePreview,
  onReviewPreview,
}: AiSuggestionPreviewActionsProps) {
  const isDraft = state.status === 'draft';

  return (
    <div className={`ai-message-suggestion ${state.status}`}>
      <div className="ai-message-suggestion-heading">
        <strong>{isDraft ? 'Suggestion preview' : 'Preview-only suggestion'}</strong>
        <button
          className="text-button ai-assistant-compact-action"
          type="button"
          onClick={() => (isDraft ? onReviewPreview?.(messageId) : onCreatePreview?.(messageId))}
          disabled={isDraft ? !onReviewPreview : !onCreatePreview}
        >
          <FileText size={14} />
          {isDraft ? 'Review preview' : 'Create preview'}
        </button>
      </div>
      {state.warnings.length > 0 ? (
        <ul className="ai-message-suggestion-warnings">
          {state.warnings.map((warning, index) => (
            <li key={`${warning}-${index}`}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
