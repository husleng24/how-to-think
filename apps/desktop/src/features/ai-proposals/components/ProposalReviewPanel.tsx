import { useMemo } from 'react';

import { AiProposalDetailPanel } from '../../ai';
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
  onConfirmGuardedApply?: (token: string, review: ProposalReview) => void;
  onClearGuardedApplyConfirmation?: (review: ProposalReview) => void;
}

export function ProposalReviewPanel({
  review,
  onAccept,
  onReject,
  onDismiss,
  onConfirmRiskFlag,
  onClearRiskConfirmation,
  onConfirmGuardedApply,
  onClearGuardedApplyConfirmation,
}: ProposalReviewPanelProps) {
  const preview = useMemo(() => (review ? createProposalPreviewModel(review) : null), [review]);

  return (
    <AiProposalDetailPanel
      review={review}
      preview={preview}
      highRiskConfirmationFlags={HIGH_RISK_CONFIRMATION_FLAGS}
      onAccept={onAccept}
      onReject={onReject}
      onDismiss={onDismiss}
      onConfirmRiskFlag={onConfirmRiskFlag}
      onClearRiskConfirmation={onClearRiskConfirmation}
      onConfirmGuardedApply={onConfirmGuardedApply}
      onClearGuardedApplyConfirmation={onClearGuardedApplyConfirmation}
    />
  );
}
