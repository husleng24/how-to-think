import type {
  AiChangeProposal,
  ProposalAffectedFile,
  ProposalOperation,
  ProposalTargetScope,
} from '../domain/types';
import { getAcceptDisabledMessages, getUnconfirmedRiskFlags } from './messageMapping';
import type {
  ProposalGuardedApplyConfirmation,
  ProposalReview,
  ProposalReviewMessage,
} from './types';

export interface ProposalPreviewOperation {
  operationId: string;
  type: ProposalOperation['type'];
  label: string;
  target: string;
  filePath: string;
  description: string;
}

export interface ProposalPreviewFile {
  path: string;
  changeKind: ProposalAffectedFile['changeKind'];
  baseVersionToken: string;
  diagnostics: string[];
  beforeMarkdown?: string;
  afterMarkdown?: string;
}

export interface ProposalPreviewModel {
  title: string;
  source: string;
  statusLabel: string;
  scopeLabel: string;
  summary: string;
  affectedNodes: string[];
  affectedFiles: ProposalPreviewFile[];
  operations: ProposalPreviewOperation[];
  messages: ProposalReviewMessage[];
  acceptDisabledMessages: ProposalReviewMessage[];
  unconfirmedRiskFlags: string[];
  guardedApplyConfirmation?: ProposalGuardedApplyConfirmation;
  isGuardedApplyConfirmed: boolean;
  canAccept: boolean;
  hasPartialAcceptance: false;
  rawDraftContent?: string;
}

export function createProposalPreviewModel(review: ProposalReview): ProposalPreviewModel {
  const proposal = review.proposal;
  const affectedFiles = proposal
    ? proposal.affectedFiles.map((file) => createPreviewFile(file, review))
    : [];

  return {
    title: proposal?.summary ?? review.invalidSource?.summary ?? review.draftSource?.summary ?? 'AI proposal',
    source: review.sourceConversationId
      ? `Conversation ${review.sourceConversationId}`
      : 'AI conversation',
    statusLabel: toStatusLabel(review.status),
    scopeLabel: proposal
      ? describeScope(proposal.targetScope)
      : review.draftSource?.targetScopeLabel ?? 'Invalid proposal',
    summary:
      proposal?.summary ??
      review.invalidSource?.summary ??
      review.draftSource?.summary ??
      'Proposal could not be validated.',
    affectedNodes: proposal ? listAffectedNodes(proposal) : [],
    affectedFiles,
    operations: proposal ? proposal.operations.map(createPreviewOperation) : [],
    messages: review.messages,
    acceptDisabledMessages: getAcceptDisabledMessages(review),
    unconfirmedRiskFlags: getUnconfirmedRiskFlags(review),
    guardedApplyConfirmation: review.guardedApplyConfirmation,
    isGuardedApplyConfirmed:
      !review.guardedApplyConfirmation?.required ||
      review.confirmedGuardedApplyToken === review.guardedApplyConfirmation.token,
    canAccept: getAcceptDisabledMessages(review).length === 0,
    hasPartialAcceptance: false,
    rawDraftContent: review.draftSource?.rawAssistantContent,
  };
}

function createPreviewFile(file: ProposalAffectedFile, review: ProposalReview): ProposalPreviewFile {
  const beforeMarkdown =
    review.editorSnapshot.markdownBuffersByPath?.[file.path] ??
    (file.path === review.editorSnapshot.activeFilePath ? review.editorSnapshot.markdownBuffer : undefined);

  return {
    path: file.path,
    changeKind: file.changeKind,
    baseVersionToken: file.baseFileVersion.token,
    diagnostics: file.markdownSerialization?.diagnostics ?? [],
    beforeMarkdown,
    afterMarkdown: file.markdownSerialization?.markdown,
  };
}

function createPreviewOperation(operation: ProposalOperation): ProposalPreviewOperation {
  return {
    operationId: operation.operationId,
    type: operation.type,
    label: operationLabel(operation),
    target: operationTarget(operation),
    filePath: operation.targetFilePath,
    description: operation.description ?? operationDescription(operation),
  };
}

function describeScope(scope: ProposalTargetScope): string {
  switch (scope.type) {
    case 'node':
      return `Node ${scope.nodeId} in ${scope.filePath}`;
    case 'branch':
      return `Branch ${scope.rootNodeId} in ${scope.filePath}`;
    case 'current-file':
      return `Current file ${scope.filePath}`;
    case 'multi-file':
      return `Multiple files (${scope.filePaths.length})`;
  }
}

function listAffectedNodes(proposal: AiChangeProposal): string[] {
  return [
    ...proposal.impactSummary.changedNodeIds,
    ...proposal.impactSummary.addedNodeIds,
    ...proposal.impactSummary.deletedNodeIds,
    ...proposal.impactSummary.movedBranchRootIds,
  ].filter((nodeId, index, nodes) => nodes.indexOf(nodeId) === index);
}

function operationLabel(operation: ProposalOperation): string {
  switch (operation.type) {
    case 'add-node':
      return 'Add node';
    case 'update-node':
      return 'Update node';
    case 'delete-node':
      return 'Delete node';
    case 'move-branch':
      return 'Move branch';
    case 'reorder-children':
      return 'Reorder children';
    case 'add-link':
      return 'Add link';
    case 'update-link':
      return 'Update link';
    case 'delete-link':
      return 'Delete link';
  }
}

function operationTarget(operation: ProposalOperation): string {
  switch (operation.type) {
    case 'add-node':
      return `${operation.nodeId} under ${operation.parentNodeId}`;
    case 'update-node':
    case 'delete-node':
    case 'move-branch':
      return operation.nodeId;
    case 'reorder-children':
      return operation.parentNodeId;
    case 'add-link':
    case 'update-link':
    case 'delete-link':
      return `${operation.linkId} on ${operation.sourceNodeId}`;
  }
}

function operationDescription(operation: ProposalOperation): string {
  switch (operation.type) {
    case 'add-node':
      return `Add "${operation.text}" to ${operation.parentNodeId}.`;
    case 'update-node':
      return `Change ${operation.nodeId} to "${operation.text}".`;
    case 'delete-node':
      return `Delete ${operation.nodeId}.`;
    case 'move-branch':
      return `Move ${operation.nodeId} under ${operation.newParentNodeId}.`;
    case 'reorder-children':
      return `Reorder ${operation.childNodeIds.length} children under ${operation.parentNodeId}.`;
    case 'add-link':
      return `Add link ${operation.linkId} to ${operation.sourceNodeId}.`;
    case 'update-link':
      return `Update link ${operation.linkId} on ${operation.sourceNodeId}.`;
    case 'delete-link':
      return `Delete link ${operation.linkId} from ${operation.sourceNodeId}.`;
  }
}

function toStatusLabel(status: ProposalReview['status']): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'validating':
      return 'Validating';
    case 'ready':
      return 'Ready';
    case 'rejected':
      return 'Rejected';
    case 'applying':
      return 'Applying';
    case 'applied':
      return 'Applied';
    case 'failed':
      return 'Failed';
    case 'conflict':
      return 'Conflict';
  }
}
