import type {
  AiChangeProposal,
  ProposalRiskFlag,
  ProposalValidationError,
  ProposalValidationErrorCode,
} from '../domain/types';
import type {
  ProposalReview,
  ProposalReviewEditorSnapshot,
  ProposalReviewMessage,
  ProposalReviewMessageCode,
} from './types';

export const HIGH_RISK_CONFIRMATION_FLAGS: ProposalRiskFlag[] = [
  'node_deletion',
  'branch_move',
  'multi_file_change',
  'markdown_serialization_warning',
];

const validationMessageCopy: Partial<
  Record<ProposalValidationErrorCode, { title: string; detail: string }>
> = {
  missing_proposal_id: {
    title: 'Missing proposal id',
    detail: 'Ask the AI conversation layer to resend a proposal with a stable proposal id.',
  },
  missing_source_conversation_id: {
    title: 'Missing conversation source',
    detail: 'The proposal must include the AI conversation id it came from before review.',
  },
  missing_created_at: {
    title: 'Missing proposal timestamp',
    detail: 'The proposal needs a created timestamp so stale output can be detected.',
  },
  missing_target_scope: {
    title: 'Missing target scope',
    detail: 'The proposal must say whether it affects a node, branch, current file, or multiple files.',
  },
  unsupported_target_scope: {
    title: 'Unsupported target scope',
    detail: 'This review surface only supports node, branch, current-file, and multi-file proposals.',
  },
  workspace_scope_forbidden: {
    title: 'Workspace-wide proposal blocked',
    detail: 'Narrow the request to a node, branch, current file, or explicit file list.',
  },
  missing_base_document_version: {
    title: 'Missing document version',
    detail: 'Regenerate the proposal with the current document version anchor.',
  },
  unresolved_base_document_version: {
    title: 'Document changed since AI context',
    detail: 'Regenerate the proposal against the current document before accepting it.',
  },
  missing_affected_file: {
    title: 'Missing affected file',
    detail: 'The proposal must list every Markdown file it would change.',
  },
  missing_affected_file_anchor: {
    title: 'Missing file version anchor',
    detail: 'Each affected file needs a backend-controlled base version before review.',
  },
  missing_multi_file_metadata: {
    title: 'Missing multi-file metadata',
    detail: 'Multi-file proposals must explicitly list each target file and its base version.',
  },
  empty_operations: {
    title: 'Empty proposal',
    detail: 'There are no structured operations to review. Ask the AI to generate a concrete change.',
  },
  duplicate_operation_id: {
    title: 'Duplicate operation id',
    detail: 'Operation ids must be unique so diagnostics can identify the exact change.',
  },
  unknown_operation_type: {
    title: 'Unsupported operation',
    detail: 'The proposal contains an operation this client cannot review.',
  },
  malformed_operation: {
    title: 'Malformed operation',
    detail: 'One or more structured operations are missing required fields.',
  },
  invalid_file_path: {
    title: 'Invalid file path',
    detail: 'Proposal paths must be normalized workspace-relative Markdown paths.',
  },
  unsupported_file_type: {
    title: 'Unsupported file type',
    detail: 'AI proposal review only accepts Markdown file targets.',
  },
  out_of_workspace_file: {
    title: 'Path outside workspace',
    detail: 'The proposal references a file outside the active workspace and cannot be accepted.',
  },
  unknown_file_path: {
    title: 'Unknown file',
    detail: 'The target file is not part of the workspace context captured for AI.',
  },
  unknown_target: {
    title: 'Unknown target',
    detail: 'The proposal target no longer matches the active review context.',
  },
  unknown_node_id: {
    title: 'Unknown node',
    detail: 'A referenced node is missing from the baseline document.',
  },
  operation_outside_target_scope: {
    title: 'Operation outside scope',
    detail: 'At least one operation touches content outside the selected target scope.',
  },
  unresolved_base_file_version: {
    title: 'File changed since AI context',
    detail: 'Regenerate the proposal against the current file version before accepting it.',
  },
  invalid_markdown_serialization: {
    title: 'Markdown preview invalid',
    detail: 'The Markdown compatibility layer reported an invalid serialization result.',
  },
  duplicate_node_id: {
    title: 'Duplicate node id',
    detail: 'The proposal would create a node id that already exists in the base document.',
  },
  root_operation_forbidden: {
    title: 'Root operation blocked',
    detail: 'The proposal tries to delete or move the root node, which is not supported.',
  },
  cannot_move_into_descendant: {
    title: 'Invalid branch move',
    detail: 'A branch cannot be moved into itself or one of its descendants.',
  },
  invalid_sibling_order: {
    title: 'Invalid sibling order',
    detail: 'A reorder operation must contain the existing sibling set exactly once.',
  },
  tree_invariant_violation: {
    title: 'Tree invariant violation',
    detail: 'Applying the proposal would break mind map tree invariants.',
  },
};

const riskMessageCopy: Record<ProposalRiskFlag, { title: string; detail: string }> = {
  node_deletion: {
    title: 'Deletion warning',
    detail: 'This proposal deletes one or more nodes. Confirm the deletion before accepting.',
  },
  branch_move: {
    title: 'Branch move warning',
    detail: 'This proposal moves a branch. Confirm the new location before accepting.',
  },
  link_change: {
    title: 'Link change',
    detail: 'This proposal adds, edits, or removes links attached to nodes.',
  },
  multi_file_change: {
    title: 'Multi-file warning',
    detail: 'This proposal affects more than one Markdown file. Confirm the scope before accepting.',
  },
  large_change: {
    title: 'Large change',
    detail: 'This proposal changes enough nodes or files to deserve extra review.',
  },
  markdown_serialization_warning: {
    title: 'Markdown serialization warning',
    detail: 'The Markdown preview includes serializer diagnostics. Review them before accepting.',
  },
};

export function mapValidationErrorsToMessages(
  errors: ProposalValidationError[],
): ProposalReviewMessage[] {
  return errors.map((error) => {
    const copy = validationMessageCopy[error.code];

    return {
      code: error.code,
      title: copy?.title ?? 'Proposal validation failed',
      detail: copy?.detail ?? error.message,
      severity: 'error',
      field: error.field,
      operationId: error.operationId,
      filePath: error.filePath,
    };
  });
}

export function mapRiskFlagToMessage(riskFlag: ProposalRiskFlag): ProposalReviewMessage {
  const copy = riskMessageCopy[riskFlag];
  const needsConfirmation = HIGH_RISK_CONFIRMATION_FLAGS.includes(riskFlag);

  return {
    code: riskFlag,
    title: copy.title,
    detail: copy.detail,
    severity: needsConfirmation ? 'warning' : 'info',
  };
}

export function getUnconfirmedRiskFlags(review: ProposalReview): ProposalRiskFlag[] {
  if (!review.proposal) {
    return [];
  }

  return review.proposal.riskFlags.filter(
    (riskFlag) =>
      HIGH_RISK_CONFIRMATION_FLAGS.includes(riskFlag) &&
      !review.confirmedRiskFlags.includes(riskFlag),
  );
}

export function getAcceptDisabledMessages(review: ProposalReview): ProposalReviewMessage[] {
  if (review.status !== 'ready') {
    return [
      {
        code: 'proposal_not_ready',
        title: 'Proposal not ready',
        detail: statusNotReadyDetail(review.status),
        severity: review.status === 'conflict' || review.status === 'failed' ? 'error' : 'info',
      },
    ];
  }

  const unconfirmedRiskFlags = getUnconfirmedRiskFlags(review);
  if (unconfirmedRiskFlags.length === 0) {
    return [];
  }

  return unconfirmedRiskFlags.map((riskFlag) => ({
    ...mapRiskFlagToMessage(riskFlag),
    code: 'proposal_high_risk_unconfirmed',
    title: 'Confirmation required',
  }));
}

export function canAcceptProposalReview(review: ProposalReview): boolean {
  return review.status === 'ready' && getAcceptDisabledMessages(review).length === 0;
}

export function createReadyMessages(proposal: AiChangeProposal): ProposalReviewMessage[] {
  return [
    {
      code: 'proposal_ready',
      title: 'Ready for review',
      detail: 'The proposal is isolated from the active editor until the whole proposal is accepted.',
      severity: 'info',
    },
    ...proposal.riskFlags.map(mapRiskFlagToMessage),
  ];
}

export function createConflictMessages(
  proposal: AiChangeProposal,
  editorSnapshot: ProposalReviewEditorSnapshot,
): ProposalReviewMessage[] {
  const messages: ProposalReviewMessage[] = [];

  if (proposal.baseDocumentVersion !== editorSnapshot.documentVersion) {
    messages.push({
      code: 'proposal_stale_document',
      title: 'Document changed since proposal',
      detail: `Proposal was based on document version ${proposal.baseDocumentVersion}; current version is ${editorSnapshot.documentVersion}. Regenerate it before accepting.`,
      severity: 'error',
    });
  }

  for (const affectedFile of proposal.affectedFiles) {
    const currentVersion =
      editorSnapshot.fileVersions[affectedFile.path] ??
      (affectedFile.path === editorSnapshot.activeFilePath ? editorSnapshot.fileVersion : undefined);

    if (!currentVersion || currentVersion.token !== affectedFile.baseFileVersion.token) {
      messages.push({
        code: 'proposal_stale_file',
        title: 'File changed since proposal',
        detail: `The base version for ${affectedFile.path} no longer matches the current file version. Regenerate the proposal before accepting.`,
        severity: 'error',
        filePath: affectedFile.path,
      });
    }
  }

  return messages;
}

export function createStatusMessage(
  code: ProposalReviewMessageCode,
  title: string,
  detail: string,
  severity: ProposalReviewMessage['severity'] = 'info',
): ProposalReviewMessage {
  return { code, title, detail, severity };
}

function statusNotReadyDetail(status: ProposalReview['status']): string {
  switch (status) {
    case 'draft':
      return 'The proposal is still being prepared for validation.';
    case 'validating':
      return 'Validation is still running.';
    case 'rejected':
      return 'The proposal has already been rejected.';
    case 'applying':
      return 'The proposal is already in an apply operation.';
    case 'applied':
      return 'The proposal was already accepted.';
    case 'failed':
      return 'The proposal has a validation or apply failure that must be resolved first.';
    case 'conflict':
      return 'The proposal is stale or conflicts with the current editor snapshot.';
    case 'ready':
      return 'The proposal is ready.';
  }
}
