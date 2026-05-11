import { calculateProposalImpactSummary, detectProposalRiskFlags } from './impactSummary';
import { validateAiChangeProposalInput } from './validators';
import type {
  AiChangeProposal,
  AiChangeProposalInput,
  NormalizedAiSuggestion,
  ProposalConstructionResult,
  ProposalConversionResult,
  ProposalValidationContext,
} from './types';

export function createAiChangeProposal(
  input: AiChangeProposalInput,
  context: ProposalValidationContext,
): ProposalConstructionResult {
  const validation = validateAiChangeProposalInput(input, context);

  if (!validation.ok) {
    return {
      ok: false,
      validation,
    };
  }

  const affectedFiles = input.affectedFiles ?? [];
  const operations = input.operations ?? [];
  const impactSummary = calculateProposalImpactSummary(operations, context);
  const proposal: AiChangeProposal = {
    proposalId: input.proposalId as string,
    sourceConversationId: input.sourceConversationId as string,
    createdAt: input.createdAt as string,
    targetScope: input.targetScope as AiChangeProposal['targetScope'],
    baseDocumentVersion: input.baseDocumentVersion as number,
    affectedFiles,
    operations,
    riskFlags: detectProposalRiskFlags(impactSummary, affectedFiles, operations),
    validationStatus: 'valid',
    validationErrors: [],
    impactSummary,
    reviewMode: 'whole-proposal',
    summary: input.summary,
  };

  return { ok: true, proposal, validation };
}

export function convertNormalizedAiSuggestionToProposal(
  suggestion: NormalizedAiSuggestion,
  context: ProposalValidationContext,
): ProposalConversionResult {
  const construction = createAiChangeProposal(
    {
      proposalId: suggestion.proposalId ?? suggestion.suggestionId,
      sourceConversationId: suggestion.sourceConversationId,
      createdAt: suggestion.createdAt,
      targetScope: suggestion.targetScope,
      baseDocumentVersion: suggestion.baseDocumentVersion,
      affectedFiles: suggestion.affectedFiles,
      operations: suggestion.operations,
      summary: suggestion.summary,
    },
    context,
  );

  if (construction.ok) {
    return { ok: true, proposal: construction.proposal };
  }

  return {
    ok: false,
    rejection: {
      code: 'proposal_validation_failed',
      message: 'Normalized AI suggestion failed proposal validation.',
      errors: construction.validation.errors,
    },
  };
}
