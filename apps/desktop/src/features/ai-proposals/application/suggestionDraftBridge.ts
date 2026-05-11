import {
  createAiSuggestionDraftReviewMetadata,
} from '../../ai-assistant/application/suggestionDrafts';
import type { AiSuggestionDraft, AiSuggestionDraftWarning } from '../../ai-assistant/types';
import type { ProposalReviewDraftSource, ProposalReviewMessage } from './types';

export function createProposalReviewDraftSourceFromAiSuggestionDraft(
  draft: AiSuggestionDraft,
): ProposalReviewDraftSource {
  const metadata = createAiSuggestionDraftReviewMetadata(draft);

  return {
    proposalId: metadata.draftId,
    sourceConversationId: metadata.sourceConversationId,
    sourceMessageId: metadata.sourceMessageId,
    summary: metadata.summary,
    rawAssistantContent: metadata.rawAssistantContent,
    targetScopeLabel: metadata.targetScopeLabel,
    documentId: metadata.documentId,
    documentPath: metadata.documentPath,
    baseDocumentRevision: metadata.baseDocumentRevision,
    baseDocumentContentHash: metadata.baseDocumentContentHash,
    messages: metadata.warnings.map(mapSuggestionDraftWarningToReviewMessage),
    createdAt: metadata.createdAt,
  };
}

function mapSuggestionDraftWarningToReviewMessage(
  warning: AiSuggestionDraftWarning,
): ProposalReviewMessage {
  const isRevisionWarning =
    warning.code === 'document_revision_mismatch' ||
    warning.code === 'document_content_hash_mismatch';

  return {
    code: isRevisionWarning ? 'suggestion_draft_revision_mismatch' : 'suggestion_draft_warning',
    title: isRevisionWarning ? 'Document changed since suggestion' : 'Suggestion warning',
    detail: warning.message,
    severity: isRevisionWarning ? 'warning' : 'info',
    filePath: warning.relativePath,
  };
}
