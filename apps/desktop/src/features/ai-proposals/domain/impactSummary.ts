import type {
  LinkId,
  NodeId,
  ProposalAffectedFile,
  ProposalDocumentSnapshot,
  ProposalImpactSummary,
  ProposalOperation,
  ProposalRiskFlag,
  ProposalValidationContext,
  WorkspaceRelativePath,
} from './types';

const LARGE_NODE_CHANGE_THRESHOLD = 20;
const LARGE_FILE_CHANGE_THRESHOLD = 5;
const LARGE_DELETION_THRESHOLD = 10;

export function calculateProposalImpactSummary(
  operations: ProposalOperation[],
  context?: ProposalValidationContext,
): ProposalImpactSummary {
  const changedNodeIds = new Set<NodeId>();
  const addedNodeIds = new Set<NodeId>();
  const deletedNodeIds = new Set<NodeId>();
  const movedBranchRootIds = new Set<NodeId>();
  const affectedLinkIds = new Set<LinkId>();
  const affectedFilePaths = new Set<WorkspaceRelativePath>();
  const documentsByPath = indexDocumentsByPath(context);

  for (const operation of operations) {
    affectedFilePaths.add(operation.targetFilePath);

    switch (operation.type) {
      case 'add-node':
        addedNodeIds.add(operation.nodeId);
        changedNodeIds.add(operation.parentNodeId);
        break;
      case 'update-node':
        changedNodeIds.add(operation.nodeId);
        break;
      case 'delete-node': {
        const document = documentsByPath.get(operation.targetFilePath);
        for (const nodeId of collectSubtreeNodeIds(document, operation.nodeId)) {
          deletedNodeIds.add(nodeId);
        }
        break;
      }
      case 'move-branch':
        movedBranchRootIds.add(operation.nodeId);
        changedNodeIds.add(operation.nodeId);
        changedNodeIds.add(operation.newParentNodeId);
        break;
      case 'reorder-children':
        changedNodeIds.add(operation.parentNodeId);
        break;
      case 'add-link':
      case 'update-link':
      case 'delete-link':
        affectedLinkIds.add(operation.linkId);
        changedNodeIds.add(operation.sourceNodeId);
        break;
    }
  }

  const counts = {
    changedNodes: changedNodeIds.size,
    addedNodes: addedNodeIds.size,
    deletedNodes: deletedNodeIds.size,
    movedBranches: movedBranchRootIds.size,
    affectedLinks: affectedLinkIds.size,
    affectedFiles: affectedFilePaths.size,
  };

  return {
    changedNodeIds: [...changedNodeIds],
    addedNodeIds: [...addedNodeIds],
    deletedNodeIds: [...deletedNodeIds],
    movedBranchRootIds: [...movedBranchRootIds],
    affectedLinkIds: [...affectedLinkIds],
    affectedFilePaths: [...affectedFilePaths],
    counts,
    includesDeletions: counts.deletedNodes > 0,
    includesBranchMoves: counts.movedBranches > 0,
    includesLinkChanges: counts.affectedLinks > 0,
    includesMultiFileChange: counts.affectedFiles > 1,
  };
}

export function detectProposalRiskFlags(
  impactSummary: ProposalImpactSummary,
  affectedFiles: ProposalAffectedFile[],
  operations: ProposalOperation[] = [],
): ProposalRiskFlag[] {
  const flags = new Set<ProposalRiskFlag>();
  const changedNodeCount =
    impactSummary.counts.changedNodes +
    impactSummary.counts.addedNodes +
    impactSummary.counts.deletedNodes;

  if (impactSummary.includesDeletions) {
    flags.add('node_deletion');
  }
  if (impactSummary.includesBranchMoves) {
    flags.add('branch_move');
  }
  if (impactSummary.includesLinkChanges) {
    flags.add('link_change');
  }
  if (impactSummary.includesMultiFileChange) {
    flags.add('multi_file_change');
  }
  if (affectedFiles.some((file) => file.changeKind === 'create')) {
    flags.add('file_creation');
  }
  if (affectedFiles.some((file) => file.changeKind === 'delete')) {
    flags.add('file_deletion');
  }
  if (detectCrossFileMove(operations)) {
    flags.add('cross_file_move');
  }
  if (operations.some(isLinkTargetChangeOperation)) {
    flags.add('link_target_change');
  }
  if (
    changedNodeCount >= LARGE_NODE_CHANGE_THRESHOLD ||
    impactSummary.counts.affectedFiles >= LARGE_FILE_CHANGE_THRESHOLD
  ) {
    flags.add('large_change');
  }
  if (impactSummary.counts.deletedNodes >= LARGE_DELETION_THRESHOLD) {
    flags.add('large_deletion');
  }
  if (affectedFiles.some((file) => (file.markdownSerialization?.diagnostics.length ?? 0) > 0)) {
    flags.add('markdown_serialization_warning');
  }

  return [...flags];
}

function detectCrossFileMove(operations: ProposalOperation[]): boolean {
  const filePaths = new Set(operations.map((operation) => operation.targetFilePath));
  if (filePaths.size < 2) {
    return false;
  }

  if (operations.some((operation) => operation.type === 'move-branch')) {
    return true;
  }

  const addedFilePaths = new Set(
    operations
      .filter((operation) => operation.type === 'add-node')
      .map((operation) => operation.targetFilePath),
  );
  const deletedFilePaths = new Set(
    operations
      .filter((operation) => operation.type === 'delete-node')
      .map((operation) => operation.targetFilePath),
  );

  for (const deletedFilePath of deletedFilePaths) {
    for (const addedFilePath of addedFilePaths) {
      if (deletedFilePath !== addedFilePath) {
        return true;
      }
    }
  }

  return false;
}

function isLinkTargetChangeOperation(operation: ProposalOperation): boolean {
  return (
    (operation.type === 'add-link' && Boolean(operation.target)) ||
    (operation.type === 'update-link' && Boolean(operation.target))
  );
}

function indexDocumentsByPath(
  context: ProposalValidationContext | undefined,
): Map<WorkspaceRelativePath, ProposalDocumentSnapshot> {
  return new Map(
    context?.knownFiles
      .filter((file) => file.document)
      .map((file) => [file.path, file.document as ProposalDocumentSnapshot]) ?? [],
  );
}

function collectSubtreeNodeIds(
  document: ProposalDocumentSnapshot | undefined,
  nodeId: NodeId,
): NodeId[] {
  if (!document?.nodes[nodeId]) {
    return [nodeId];
  }

  const ids: NodeId[] = [];
  const stack = [nodeId];
  while (stack.length > 0) {
    const currentId = stack.pop() as NodeId;
    ids.push(currentId);
    const node = document.nodes[currentId];
    if (node) {
      for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
        stack.push(node.childIds[index]);
      }
    }
  }

  return ids;
}
