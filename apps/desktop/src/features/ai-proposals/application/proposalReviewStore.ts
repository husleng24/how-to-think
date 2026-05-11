import { convertNormalizedAiSuggestionToProposal } from '../domain/conversion';
import type {
  AiChangeProposal,
  NormalizedAiSuggestion,
  ProposalRiskFlag,
  ProposalValidationContext,
} from '../domain/types';
import {
  canAcceptProposalReview,
  createConflictMessages,
  createReadyMessages,
  createStatusMessage,
  mapValidationErrorsToMessages,
} from './messageMapping';
import { buildGuardedApplyConfirmation } from './guardedApplyConfirmation';
import type {
  InvalidProposalReviewSource,
  ProposalReview,
  ProposalReviewChange,
  ProposalReviewChangeType,
  ProposalReviewDraftSource,
  ProposalReviewEditorSnapshot,
  ProposalReviewMessage,
  ProposalReviewMessageCode,
  ProposalReviewState,
  ProposalReviewStore,
  ProposalReviewStoreListener,
} from './types';

export interface CreateProposalReviewOptions {
  reviewId?: string;
  now?: Date;
}

export interface ReceiveAiConversationProposalInput {
  suggestion: NormalizedAiSuggestion;
  validationContext: ProposalValidationContext;
  editorSnapshot: ProposalReviewEditorSnapshot;
  now?: Date;
}

export function createProposalReview(
  proposal: AiChangeProposal,
  editorSnapshot: ProposalReviewEditorSnapshot,
  options: CreateProposalReviewOptions = {},
): ProposalReview {
  const timestamp = toIsoString(options.now);
  const conflictMessages = createConflictMessages(proposal, editorSnapshot);
  const status = conflictMessages.length > 0 ? 'conflict' : 'ready';

  return {
    reviewId: options.reviewId ?? proposal.proposalId,
    proposalId: proposal.proposalId,
    sourceConversationId: proposal.sourceConversationId,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    proposal,
    editorSnapshot,
    messages: status === 'conflict' ? conflictMessages : createReadyMessages(proposal),
    confirmedRiskFlags: [],
    guardedApplyConfirmation: buildGuardedApplyConfirmation(proposal),
  };
}

export function createInvalidProposalReview(
  invalidSource: InvalidProposalReviewSource,
  editorSnapshot: ProposalReviewEditorSnapshot,
  options: CreateProposalReviewOptions = {},
): ProposalReview {
  const timestamp = toIsoString(options.now);

  return {
    reviewId: options.reviewId ?? invalidSource.proposalId,
    proposalId: invalidSource.proposalId,
    sourceConversationId: invalidSource.sourceConversationId,
    status: 'failed',
    createdAt: timestamp,
    updatedAt: timestamp,
    invalidSource,
    editorSnapshot,
    messages: [
      createStatusMessage(
        'proposal_validation_failed',
        'Proposal validation failed',
        'The AI output is shown for review diagnostics only and cannot be accepted.',
        'error',
      ),
      ...mapValidationErrorsToMessages(invalidSource.errors),
    ],
    confirmedRiskFlags: [],
    failure: {
      code: 'proposal_validation_failed',
      message: 'Proposal validation failed.',
    },
  };
}

export function createSuggestionDraftReview(
  draftSource: ProposalReviewDraftSource,
  editorSnapshot: ProposalReviewEditorSnapshot,
  options: CreateProposalReviewOptions = {},
): ProposalReview {
  const timestamp = toIsoString(options.now);

  return {
    reviewId: options.reviewId ?? draftSource.proposalId,
    proposalId: draftSource.proposalId,
    sourceConversationId: draftSource.sourceConversationId,
    status: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
    draftSource,
    editorSnapshot,
    messages: [
      createStatusMessage(
        'suggestion_draft_saved',
        'Suggestion draft saved',
        'The draft is isolated from the editor and has not changed the mind map or Markdown file.',
      ),
      ...draftSource.messages,
    ],
    confirmedRiskFlags: [],
  };
}

export function createDraftProposalReview(
  proposal: AiChangeProposal,
  editorSnapshot: ProposalReviewEditorSnapshot,
  options: CreateProposalReviewOptions = {},
): ProposalReview {
  const timestamp = toIsoString(options.now);

  return {
    reviewId: options.reviewId ?? proposal.proposalId,
    proposalId: proposal.proposalId,
    sourceConversationId: proposal.sourceConversationId,
    status: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
    proposal,
    editorSnapshot,
    messages: [
      createStatusMessage(
        'proposal_not_ready',
        'Draft proposal',
        'The proposal is isolated from the editor while review validation is prepared.',
      ),
    ],
    confirmedRiskFlags: [],
  };
}

export function markProposalReviewValidating(
  review: ProposalReview,
  now: Date = new Date(),
): ProposalReview {
  return updateReview(review, {
    status: 'validating',
    updatedAt: now.toISOString(),
    messages: [
      createStatusMessage(
        'proposal_not_ready',
        'Validating proposal',
        'The proposal is being checked against the captured editor snapshot.',
      ),
    ],
  });
}

export function markProposalReviewReady(
  review: ProposalReview,
  now: Date = new Date(),
): ProposalReview {
  if (!review.proposal) {
    return review;
  }

  const conflictMessages = createConflictMessages(review.proposal, review.editorSnapshot);
  if (conflictMessages.length > 0) {
    return markProposalReviewConflict(review, conflictMessages, now);
  }

  return updateReview(review, {
    status: 'ready',
    updatedAt: now.toISOString(),
    messages: createReadyMessages(review.proposal),
  });
}

export function markProposalReviewConflict(
  review: ProposalReview,
  messages: ProposalReviewMessage[] = review.proposal
    ? createConflictMessages(review.proposal, review.editorSnapshot)
    : [],
  now: Date = new Date(),
): ProposalReview {
  return updateReview(review, {
    status: 'conflict',
    updatedAt: now.toISOString(),
    messages:
      messages.length > 0
        ? messages
        : [
            createStatusMessage(
              'proposal_stale_document',
              'Proposal conflict',
              'The proposal conflicts with the current editor snapshot.',
              'error',
            ),
          ],
  });
}

export function confirmProposalRiskFlag(
  review: ProposalReview,
  riskFlag: ProposalRiskFlag,
  now: Date = new Date(),
): ProposalReview {
  if (review.confirmedRiskFlags.includes(riskFlag)) {
    return review;
  }

  return updateReview(review, {
    updatedAt: now.toISOString(),
    confirmedRiskFlags: [...review.confirmedRiskFlags, riskFlag],
  });
}

export function clearProposalRiskConfirmation(
  review: ProposalReview,
  riskFlag: ProposalRiskFlag,
  now: Date = new Date(),
): ProposalReview {
  if (!review.confirmedRiskFlags.includes(riskFlag)) {
    return review;
  }

  return updateReview(review, {
    updatedAt: now.toISOString(),
    confirmedRiskFlags: review.confirmedRiskFlags.filter((confirmedFlag) => confirmedFlag !== riskFlag),
  });
}

export function confirmGuardedApplyConfirmation(
  review: ProposalReview,
  token: string,
  now: Date = new Date(),
): ProposalReview {
  if (!review.guardedApplyConfirmation?.required || review.confirmedGuardedApplyToken === token) {
    return review;
  }

  return updateReview(review, {
    updatedAt: now.toISOString(),
    confirmedGuardedApplyToken: token,
  });
}

export function clearGuardedApplyReviewConfirmation(
  review: ProposalReview,
  now: Date = new Date(),
): ProposalReview {
  if (!review.confirmedGuardedApplyToken) {
    return review;
  }

  return updateReview(review, {
    updatedAt: now.toISOString(),
    confirmedGuardedApplyToken: undefined,
  });
}

export function rejectProposalReview(
  review: ProposalReview,
  reason?: string,
  now: Date = new Date(),
): ProposalReview {
  return updateReview(review, {
    status: 'rejected',
    updatedAt: now.toISOString(),
    decision: {
      type: 'reject-proposal',
      decidedAt: now.toISOString(),
      reason,
    },
    messages: [
      createStatusMessage(
        'proposal_rejected',
        'Proposal rejected',
        'The active editor document, Markdown buffer, dirty state, selection, and undo history were left unchanged.',
      ),
    ],
  });
}

export function beginApplyingProposalReview(
  review: ProposalReview,
  now: Date = new Date(),
): ProposalReview {
  if (!canAcceptProposalReview(review)) {
    return review;
  }

  return updateReview(review, {
    status: 'applying',
    updatedAt: now.toISOString(),
    decision: {
      type: 'accept-proposal',
      decidedAt: now.toISOString(),
    },
    messages: [
      createStatusMessage(
        'proposal_applying',
        'Applying proposal',
        'The whole proposal has been accepted. The active editor document remains unchanged.',
      ),
    ],
  });
}

export function markProposalReviewApplied(
  review: ProposalReview,
  now: Date = new Date(),
): ProposalReview {
  if (review.status === 'applied') {
    return review;
  }

  return updateReview(review, {
    status: 'applied',
    updatedAt: now.toISOString(),
    messages: [
      createStatusMessage(
        'proposal_applied',
        'Proposal accepted',
        'The whole proposal was accepted by the review flow.',
      ),
    ],
  });
}

export function markProposalReviewFailed(
  review: ProposalReview,
  code: ProposalReviewMessageCode,
  message: string,
  now: Date = new Date(),
): ProposalReview {
  return updateReview(review, {
    status: 'failed',
    updatedAt: now.toISOString(),
    failure: {
      code,
      message,
    },
    messages: [createStatusMessage(code, 'Proposal failed', message, 'error')],
  });
}

export function receiveAiConversationProposal(
  input: ReceiveAiConversationProposalInput,
): ProposalReview {
  const conversion = convertNormalizedAiSuggestionToProposal(input.suggestion, input.validationContext);

  if (conversion.ok) {
    return createProposalReview(conversion.proposal, input.editorSnapshot, { now: input.now });
  }

  return createInvalidProposalReview(
    {
      proposalId: input.suggestion.proposalId ?? input.suggestion.suggestionId ?? 'invalid-proposal',
      sourceConversationId: input.suggestion.sourceConversationId,
      summary: input.suggestion.summary,
      errors: conversion.rejection.errors,
    },
    input.editorSnapshot,
    { now: input.now },
  );
}

export function createProposalReviewStore(
  initialState: Partial<ProposalReviewState> = {},
): ProposalReviewStore {
  let state: ProposalReviewState = {
    activeReview: initialState.activeReview ?? null,
    archivedReviews: initialState.archivedReviews ?? [],
    changeRevision: initialState.changeRevision ?? 0,
  };
  const listeners = new Set<ProposalReviewStoreListener>();

  const emit = (change: Omit<ProposalReviewChange, 'changeRevision'>): void => {
    state = {
      ...state,
      changeRevision: state.changeRevision + 1,
    };
    const fullChange: ProposalReviewChange = {
      ...change,
      changeRevision: state.changeRevision,
    };

    for (const listener of listeners) {
      listener(state, fullChange);
    }
  };

  const replaceActive = (review: ProposalReview, changeType: ProposalReviewChangeType): ProposalReview => {
    state = {
      ...state,
      activeReview: review,
      archivedReviews: state.activeReview
        ? [state.activeReview, ...state.archivedReviews]
        : state.archivedReviews,
    };
    emit({ type: changeType, review });

    return review;
  };

  const updateActive = (
    changeType: ProposalReviewChangeType,
    updater: (review: ProposalReview) => ProposalReview,
    reviewId?: string,
  ): ProposalReview | null => {
    const activeReview = state.activeReview;
    if (!activeReview || (reviewId && activeReview.reviewId !== reviewId)) {
      return null;
    }

    const nextReview = updater(activeReview);
    if (nextReview === activeReview) {
      return activeReview;
    }

    state = {
      ...state,
      activeReview: nextReview,
    };
    emit({ type: changeType, review: nextReview });

    return nextReview;
  };

  const archiveActive = (
    changeType: ProposalReviewChangeType,
    updater: (review: ProposalReview) => ProposalReview,
  ): ProposalReview | null => {
    const activeReview = state.activeReview;
    if (!activeReview) {
      return null;
    }

    const archivedReview = updater(activeReview);
    state = {
      ...state,
      activeReview: null,
      archivedReviews: [archivedReview, ...state.archivedReviews],
    };
    emit({ type: changeType, review: archivedReview });

    return archivedReview;
  };

  return {
    getState() {
      return state;
    },

    receiveProposal(proposal, editorSnapshot) {
      return replaceActive(createProposalReview(proposal, editorSnapshot), 'receive-proposal');
    },

    receiveInvalidProposal(invalidSource, editorSnapshot) {
      return replaceActive(
        createInvalidProposalReview(invalidSource, editorSnapshot),
        'receive-invalid-proposal',
      );
    },

    receiveSuggestionDraft(draftSource, editorSnapshot) {
      return replaceActive(
        createSuggestionDraftReview(draftSource, editorSnapshot),
        'receive-suggestion-draft',
      );
    },

    startValidation(reviewId) {
      return updateActive('start-validation', markProposalReviewValidating, reviewId);
    },

    markReady(reviewId) {
      return updateActive('mark-ready', markProposalReviewReady, reviewId);
    },

    markConflict(messages, reviewId) {
      return updateActive(
        'mark-conflict',
        (review) => markProposalReviewConflict(review, messages),
        reviewId,
      );
    },

    confirmRiskFlag(riskFlag, reviewId) {
      return updateActive(
        'confirm-risk',
        (review) => confirmProposalRiskFlag(review, riskFlag),
        reviewId,
      );
    },

    clearRiskConfirmation(riskFlag, reviewId) {
      return updateActive(
        'clear-risk-confirmation',
        (review) => clearProposalRiskConfirmation(review, riskFlag),
        reviewId,
      );
    },

    confirmGuardedApply(token, reviewId) {
      return updateActive(
        'confirm-guarded-apply',
        (review) => confirmGuardedApplyConfirmation(review, token),
        reviewId,
      );
    },

    clearGuardedApplyConfirmation(reviewId) {
      return updateActive(
        'clear-guarded-apply-confirmation',
        clearGuardedApplyReviewConfirmation,
        reviewId,
      );
    },

    rejectActive(reason) {
      return archiveActive('reject', (review) => rejectProposalReview(review, reason));
    },

    beginApply(reviewId) {
      return updateActive('begin-apply', beginApplyingProposalReview, reviewId);
    },

    markApplied(reviewId) {
      return updateActive('mark-applied', markProposalReviewApplied, reviewId);
    },

    markFailed(code, message, reviewId) {
      return updateActive(
        'mark-failed',
        (review) => markProposalReviewFailed(review, code, message),
        reviewId,
      );
    },

    dismissActive() {
      return archiveActive('dismiss', (review) => review);
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function updateReview(review: ProposalReview, patch: Partial<ProposalReview>): ProposalReview {
  return {
    ...review,
    ...patch,
  };
}

function toIsoString(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}
