import type {
  AiChangeProposal,
  IsoDateTimeString,
  ProposalAffectedFile,
  ProposalFileVersionAnchor,
  ProposalId,
  ProposalOperation,
  ProposalRiskFlag,
  ProposalValidationError,
  WorkspaceRelativePath,
} from '../domain/types';

export type ProposalReviewStatus =
  | 'draft'
  | 'validating'
  | 'ready'
  | 'rejected'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'conflict';

export type ProposalReviewMessageSeverity = 'info' | 'warning' | 'error';

export type ProposalReviewMessageCode =
  | 'suggestion_draft_saved'
  | 'suggestion_draft_warning'
  | 'suggestion_draft_revision_mismatch'
  | 'proposal_ready'
  | 'proposal_rejected'
  | 'proposal_applying'
  | 'proposal_applied'
  | 'proposal_apply_failed'
  | 'proposal_validation_failed'
  | 'proposal_stale_document'
  | 'proposal_stale_file'
  | 'proposal_high_risk_unconfirmed'
  | 'proposal_guarded_confirmation_required'
  | 'proposal_not_ready'
  | 'node_deletion'
  | 'branch_move'
  | 'link_change'
  | 'multi_file_change'
  | 'file_creation'
  | 'file_deletion'
  | 'cross_file_move'
  | 'link_target_change'
  | 'large_change'
  | 'large_deletion'
  | 'markdown_serialization_warning'
  | ProposalValidationError['code'];

export interface ProposalReviewMessage {
  code: ProposalReviewMessageCode;
  title: string;
  detail: string;
  severity: ProposalReviewMessageSeverity;
  field?: string;
  operationId?: string;
  filePath?: WorkspaceRelativePath;
}

export interface ProposalReviewEditorSnapshot {
  document: unknown;
  markdownBuffer: string;
  markdownBuffersByPath?: Record<WorkspaceRelativePath, string>;
  fileVersion: ProposalFileVersionAnchor;
  fileVersions: Record<WorkspaceRelativePath, ProposalFileVersionAnchor>;
  activeFilePath: WorkspaceRelativePath;
  documentVersion: number;
  isDirty: boolean;
  undoHistory: unknown;
  selection: unknown;
  capturedAt: IsoDateTimeString;
}

export interface ProposalGuardedAffectedFileSummary {
  path: WorkspaceRelativePath;
  operationType: ProposalAffectedFile['changeKind'];
  baseVersionToken: string;
  previousPath?: WorkspaceRelativePath;
  linkImpact: string;
  highRiskFlags: ProposalRiskFlag[];
}

export interface ProposalGuardedHighRiskOperationSummary {
  operationId: string;
  operationType: ProposalOperation['type'] | 'create-file' | 'delete-file' | 'rename-file';
  filePath: WorkspaceRelativePath;
  description: string;
  riskFlags: ProposalRiskFlag[];
  linkImpact?: string;
}

export interface ProposalGuardedApplyConfirmation {
  required: boolean;
  token: string;
  affectedFiles: ProposalGuardedAffectedFileSummary[];
  highRiskOperations: ProposalGuardedHighRiskOperationSummary[];
  riskFlags: ProposalRiskFlag[];
  linkImpactSummary: string;
}

export interface InvalidProposalReviewSource {
  proposalId: ProposalId;
  sourceConversationId?: string;
  summary?: string;
  errors: ProposalValidationError[];
}

export interface ProposalReviewDraftSource {
  proposalId: ProposalId;
  sourceConversationId?: string;
  sourceMessageId?: string;
  summary?: string;
  rawAssistantContent: string;
  targetScopeLabel: string;
  documentId?: string;
  documentPath?: WorkspaceRelativePath;
  baseDocumentRevision?: string;
  baseDocumentContentHash?: string;
  messages: ProposalReviewMessage[];
  createdAt: IsoDateTimeString;
}

export interface ProposalReview {
  reviewId: string;
  proposalId: ProposalId;
  sourceConversationId?: string;
  status: ProposalReviewStatus;
  createdAt: IsoDateTimeString;
  updatedAt: IsoDateTimeString;
  proposal?: AiChangeProposal;
  invalidSource?: InvalidProposalReviewSource;
  draftSource?: ProposalReviewDraftSource;
  editorSnapshot: ProposalReviewEditorSnapshot;
  messages: ProposalReviewMessage[];
  confirmedRiskFlags: ProposalRiskFlag[];
  guardedApplyConfirmation?: ProposalGuardedApplyConfirmation;
  confirmedGuardedApplyToken?: string;
  decision?: {
    type: 'accept-proposal' | 'reject-proposal';
    decidedAt: IsoDateTimeString;
    reason?: string;
  };
  failure?: {
    code: ProposalReviewMessageCode;
    message: string;
  };
}

export interface ProposalReviewState {
  activeReview: ProposalReview | null;
  archivedReviews: ProposalReview[];
  changeRevision: number;
}

export type ProposalReviewChangeType =
  | 'receive-proposal'
  | 'receive-invalid-proposal'
  | 'receive-suggestion-draft'
  | 'start-validation'
  | 'mark-ready'
  | 'mark-conflict'
  | 'confirm-risk'
  | 'clear-risk-confirmation'
  | 'confirm-guarded-apply'
  | 'clear-guarded-apply-confirmation'
  | 'reject'
  | 'begin-apply'
  | 'mark-applied'
  | 'mark-failed'
  | 'dismiss';

export interface ProposalReviewChange {
  type: ProposalReviewChangeType;
  review: ProposalReview | null;
  changeRevision: number;
}

export type ProposalReviewStoreListener = (
  state: ProposalReviewState,
  change: ProposalReviewChange,
) => void;

export interface ProposalReviewStore {
  getState(): ProposalReviewState;
  receiveProposal(proposal: AiChangeProposal, editorSnapshot: ProposalReviewEditorSnapshot): ProposalReview;
  receiveInvalidProposal(
    invalidSource: InvalidProposalReviewSource,
    editorSnapshot: ProposalReviewEditorSnapshot,
  ): ProposalReview;
  receiveSuggestionDraft(
    draftSource: ProposalReviewDraftSource,
    editorSnapshot: ProposalReviewEditorSnapshot,
  ): ProposalReview;
  startValidation(reviewId?: string): ProposalReview | null;
  markReady(reviewId?: string): ProposalReview | null;
  markConflict(messages?: ProposalReviewMessage[], reviewId?: string): ProposalReview | null;
  confirmRiskFlag(riskFlag: ProposalRiskFlag, reviewId?: string): ProposalReview | null;
  clearRiskConfirmation(riskFlag: ProposalRiskFlag, reviewId?: string): ProposalReview | null;
  confirmGuardedApply(token: string, reviewId?: string): ProposalReview | null;
  clearGuardedApplyConfirmation(reviewId?: string): ProposalReview | null;
  rejectActive(reason?: string): ProposalReview | null;
  beginApply(reviewId?: string): ProposalReview | null;
  markApplied(reviewId?: string): ProposalReview | null;
  markFailed(code: ProposalReviewMessageCode, message: string, reviewId?: string): ProposalReview | null;
  dismissActive(): ProposalReview | null;
  subscribe(listener: ProposalReviewStoreListener): () => void;
}
