import type {
  AiChangeProposal,
  ProposalAffectedFile,
  ProposalOperation,
  ProposalRiskFlag,
  ProposalTargetScope,
  WorkspaceRelativePath,
} from '../domain/types';
import type {
  ProposalGuardedAffectedFileSummary,
  ProposalGuardedApplyConfirmation,
  ProposalGuardedHighRiskOperationSummary,
  ProposalReview,
} from './types';

export const GUARDED_APPLY_CONFIRMATION_FLAGS: ProposalRiskFlag[] = [
  'multi_file_change',
  'file_creation',
  'file_deletion',
  'cross_file_move',
  'link_target_change',
  'large_deletion',
  'markdown_serialization_warning',
];

export function buildGuardedApplyConfirmation(
  proposal: AiChangeProposal,
): ProposalGuardedApplyConfirmation {
  const guardedRiskFlags = proposal.riskFlags.filter((riskFlag) =>
    GUARDED_APPLY_CONFIRMATION_FLAGS.includes(riskFlag),
  );
  const affectedFiles = proposal.affectedFiles.map((file) =>
    summarizeAffectedFile(file, proposal.operations),
  );
  const highRiskOperations = [
    ...proposal.affectedFiles.flatMap(fileLevelHighRiskOperation),
    ...proposal.operations.flatMap((operation) => summarizeHighRiskOperation(operation, proposal)),
  ];
  const required =
    isMultiFileScope(proposal.targetScope) ||
    proposal.affectedFiles.length > 1 ||
    affectedFiles.some((file) => file.highRiskFlags.length > 0) ||
    guardedRiskFlags.length > 0;

  return {
    required,
    token: createGuardedConfirmationToken({
      proposal,
      affectedFiles,
      highRiskOperations,
      guardedRiskFlags,
    }),
    affectedFiles,
    highRiskOperations,
    riskFlags: guardedRiskFlags,
    linkImpactSummary: summarizeProposalLinkImpact(proposal.operations),
  };
}

export function isGuardedApplyConfirmed(review: ProposalReview): boolean {
  const confirmation = review.guardedApplyConfirmation;
  if (!confirmation?.required) {
    return true;
  }

  return isGuardedApplyTokenConfirmed(confirmation, review.confirmedGuardedApplyToken);
}

export function isGuardedApplyTokenConfirmed(
  confirmation: ProposalGuardedApplyConfirmation,
  token: string | undefined,
): boolean {
  return !confirmation.required || token === confirmation.token;
}

function summarizeAffectedFile(
  file: ProposalAffectedFile,
  operations: ProposalOperation[],
): ProposalGuardedAffectedFileSummary {
  return {
    path: file.path,
    operationType: file.changeKind,
    baseVersionToken: file.baseFileVersion.token,
    previousPath: file.previousPath,
    linkImpact: summarizeFileLinkImpact(file.path, operations),
    highRiskFlags: highRiskFlagsForAffectedFile(file),
  };
}

function fileLevelHighRiskOperation(
  file: ProposalAffectedFile,
): ProposalGuardedHighRiskOperationSummary[] {
  const riskFlags = highRiskFlagsForAffectedFile(file);
  if (riskFlags.length === 0) {
    return [];
  }

  return [
    {
      operationId: `file:${file.changeKind}:${file.path}`,
      operationType:
        file.changeKind === 'create'
          ? 'create-file'
          : file.changeKind === 'delete'
            ? 'delete-file'
            : 'rename-file',
      filePath: file.path,
      description: fileLevelDescription(file),
      riskFlags,
    },
  ];
}

function summarizeHighRiskOperation(
  operation: ProposalOperation,
  proposal: AiChangeProposal,
): ProposalGuardedHighRiskOperationSummary[] {
  const riskFlags = highRiskFlagsForOperation(operation, proposal);
  if (riskFlags.length === 0) {
    return [];
  }

  return [
    {
      operationId: operation.operationId,
      operationType: operation.type,
      filePath: operation.targetFilePath,
      description: operation.description ?? operationDescription(operation),
      riskFlags,
      linkImpact: isLinkOperation(operation) ? linkOperationImpact(operation) : undefined,
    },
  ];
}

function highRiskFlagsForAffectedFile(file: ProposalAffectedFile): ProposalRiskFlag[] {
  switch (file.changeKind) {
    case 'create':
      return ['file_creation'];
    case 'delete':
      return ['file_deletion'];
    case 'rename':
      return ['cross_file_move'];
    case 'modify':
      return [];
  }
}

function highRiskFlagsForOperation(
  operation: ProposalOperation,
  proposal: AiChangeProposal,
): ProposalRiskFlag[] {
  const riskFlags: ProposalRiskFlag[] = [];

  if (operation.type === 'delete-node') {
    riskFlags.push('node_deletion');
    if (proposal.riskFlags.includes('large_deletion')) {
      riskFlags.push('large_deletion');
    }
  }

  if (operation.type === 'move-branch') {
    riskFlags.push('branch_move');
    if (proposal.riskFlags.includes('cross_file_move')) {
      riskFlags.push('cross_file_move');
    }
  }

  if (isLinkTargetChangeOperation(operation)) {
    riskFlags.push('link_target_change');
  }

  if (proposal.riskFlags.includes('cross_file_move') && isDeleteOrAddAcrossFiles(operation, proposal)) {
    riskFlags.push('cross_file_move');
  }

  return riskFlags.filter((riskFlag, index) => riskFlags.indexOf(riskFlag) === index);
}

function isDeleteOrAddAcrossFiles(operation: ProposalOperation, proposal: AiChangeProposal): boolean {
  if (operation.type !== 'add-node' && operation.type !== 'delete-node') {
    return false;
  }

  const filePaths = new Set(proposal.operations.map((proposalOperation) => proposalOperation.targetFilePath));
  return filePaths.size > 1;
}

function summarizeFileLinkImpact(
  filePath: WorkspaceRelativePath,
  operations: ProposalOperation[],
): string {
  const linkOperations = operations.filter(
    (operation) => operation.targetFilePath === filePath && isLinkOperation(operation),
  );
  const outboundTargets = operations
    .filter((operation) => operation.targetFilePath === filePath && isLinkTargetChangeOperation(operation))
    .map((operation) => linkOperationImpact(operation));

  if (linkOperations.length === 0 && outboundTargets.length === 0) {
    return 'No link changes';
  }

  const parts = [`${linkOperations.length} link operation${linkOperations.length === 1 ? '' : 's'}`];
  if (outboundTargets.length > 0) {
    parts.push(`targets ${outboundTargets.join(', ')}`);
  }

  return parts.join('; ');
}

function summarizeProposalLinkImpact(operations: ProposalOperation[]): string {
  const linkOperations = operations.filter(isLinkOperation);
  if (linkOperations.length === 0) {
    return 'No cross-file link changes';
  }

  const targetChanges = linkOperations.filter(isLinkTargetChangeOperation).length;
  return `${linkOperations.length} link operation${linkOperations.length === 1 ? '' : 's'}; ${targetChanges} target change${targetChanges === 1 ? '' : 's'}`;
}

function linkOperationImpact(operation: ProposalOperation): string {
  if (!isLinkTargetChangeOperation(operation)) {
    return 'link metadata only';
  }

  const target = operation.target;
  if (!target) {
    return 'link metadata only';
  }

  switch (target.type) {
    case 'url':
      return target.href;
    case 'file':
      return target.filePath;
    case 'node':
      return target.filePath ? `${target.filePath}#${target.nodeId}` : target.nodeId;
  }
}

function fileLevelDescription(file: ProposalAffectedFile): string {
  switch (file.changeKind) {
    case 'create':
      return `Create ${file.path}.`;
    case 'delete':
      return `Delete ${file.path}.`;
    case 'rename':
      return `Move ${file.previousPath ?? 'a Markdown file'} to ${file.path}.`;
    case 'modify':
      return `Modify ${file.path}.`;
  }
}

function operationDescription(operation: ProposalOperation): string {
  switch (operation.type) {
    case 'add-node':
      return `Add node ${operation.nodeId} under ${operation.parentNodeId}.`;
    case 'update-node':
      return `Update node ${operation.nodeId}.`;
    case 'delete-node':
      return `Delete node ${operation.nodeId}.`;
    case 'move-branch':
      return `Move branch ${operation.nodeId} under ${operation.newParentNodeId}.`;
    case 'reorder-children':
      return `Reorder children under ${operation.parentNodeId}.`;
    case 'add-link':
      return `Add link ${operation.linkId}.`;
    case 'update-link':
      return `Update link ${operation.linkId}.`;
    case 'delete-link':
      return `Delete link ${operation.linkId}.`;
  }
}

function createGuardedConfirmationToken(input: {
  proposal: AiChangeProposal;
  affectedFiles: ProposalGuardedAffectedFileSummary[];
  highRiskOperations: ProposalGuardedHighRiskOperationSummary[];
  guardedRiskFlags: ProposalRiskFlag[];
}): string {
  const fileParts = input.affectedFiles.map((file) =>
    [
      file.path,
      file.previousPath ?? '',
      file.operationType,
      file.baseVersionToken,
      file.highRiskFlags.join(','),
      file.linkImpact,
    ].join('@'),
  );
  const operationParts = input.highRiskOperations.map((operation) =>
    [
      operation.operationId,
      operation.operationType,
      operation.filePath,
      operation.riskFlags.join(','),
      operation.linkImpact ?? '',
    ].join('@'),
  );

  return [
    input.proposal.proposalId,
    input.proposal.baseDocumentVersion,
    input.guardedRiskFlags.join(','),
    ...fileParts,
    ...operationParts,
  ].join('|');
}

function isMultiFileScope(scope: ProposalTargetScope): boolean {
  return scope.type === 'multi-file';
}

function isLinkOperation(operation: ProposalOperation): boolean {
  return operation.type === 'add-link' || operation.type === 'update-link' || operation.type === 'delete-link';
}

function isLinkTargetChangeOperation(
  operation: ProposalOperation,
): operation is Extract<ProposalOperation, { type: 'add-link' | 'update-link' }> {
  return (
    (operation.type === 'add-link' && Boolean(operation.target)) ||
    (operation.type === 'update-link' && Boolean(operation.target))
  );
}
