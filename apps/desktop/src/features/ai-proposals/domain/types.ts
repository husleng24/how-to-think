export type ProposalId = string;
export type AiConversationId = string;
export type IsoDateTimeString = string;
export type WorkspaceId = string;
export type WorkspaceRelativePath = string;
export type NodeId = string;
export type LinkId = string;

export interface ProposalFileVersionAnchor {
  token: string;
  modifiedAt?: IsoDateTimeString;
  byteSize?: number;
  contentHash?: string;
}

export interface ProposalNodeLinkSnapshot {
  id: LinkId;
  label?: string;
  target:
    | { type: 'url'; href: string }
    | { type: 'file'; filePath: WorkspaceRelativePath }
    | { type: 'node'; nodeId: NodeId; filePath?: WorkspaceRelativePath };
}

export interface ProposalNodeSnapshot {
  id: NodeId;
  text: string;
  parentId: NodeId | null;
  childIds: NodeId[];
  links?: ProposalNodeLinkSnapshot[];
}

export interface ProposalDocumentSnapshot {
  id: string;
  version: number;
  rootNodeId: NodeId;
  nodes: Record<NodeId, ProposalNodeSnapshot>;
}

export interface ProposalKnownFile {
  path: WorkspaceRelativePath;
  version: ProposalFileVersionAnchor;
  document?: ProposalDocumentSnapshot;
}

export interface ProposalValidationContext {
  workspaceId: WorkspaceId;
  baseDocumentVersion: number;
  activeFilePath: WorkspaceRelativePath;
  knownFiles: ProposalKnownFile[];
}

export type ProposalTargetScope =
  | {
      type: 'node';
      filePath: WorkspaceRelativePath;
      nodeId: NodeId;
    }
  | {
      type: 'branch';
      filePath: WorkspaceRelativePath;
      rootNodeId: NodeId;
    }
  | {
      type: 'current-file';
      filePath: WorkspaceRelativePath;
    }
  | {
      type: 'multi-file';
      filePaths: WorkspaceRelativePath[];
    };

interface BaseProposalOperation {
  operationId: string;
  targetFilePath: WorkspaceRelativePath;
  description?: string;
}

export interface AddNodeProposalOperation extends BaseProposalOperation {
  type: 'add-node';
  nodeId: NodeId;
  parentNodeId: NodeId;
  text: string;
  index?: number;
}

export interface UpdateNodeProposalOperation extends BaseProposalOperation {
  type: 'update-node';
  nodeId: NodeId;
  text: string;
}

export interface DeleteNodeProposalOperation extends BaseProposalOperation {
  type: 'delete-node';
  nodeId: NodeId;
}

export interface MoveBranchProposalOperation extends BaseProposalOperation {
  type: 'move-branch';
  nodeId: NodeId;
  newParentNodeId: NodeId;
  index?: number;
}

export interface ReorderChildrenProposalOperation extends BaseProposalOperation {
  type: 'reorder-children';
  parentNodeId: NodeId;
  childNodeIds: NodeId[];
}

export type ProposalLinkTarget =
  | { type: 'url'; href: string }
  | { type: 'file'; filePath: WorkspaceRelativePath }
  | { type: 'node'; nodeId: NodeId; filePath?: WorkspaceRelativePath };

export interface AddLinkProposalOperation extends BaseProposalOperation {
  type: 'add-link';
  linkId: LinkId;
  sourceNodeId: NodeId;
  target: ProposalLinkTarget;
  label?: string;
}

export interface UpdateLinkProposalOperation extends BaseProposalOperation {
  type: 'update-link';
  linkId: LinkId;
  sourceNodeId: NodeId;
  target?: ProposalLinkTarget;
  label?: string;
}

export interface DeleteLinkProposalOperation extends BaseProposalOperation {
  type: 'delete-link';
  linkId: LinkId;
  sourceNodeId: NodeId;
}

export type ProposalOperation =
  | AddNodeProposalOperation
  | UpdateNodeProposalOperation
  | DeleteNodeProposalOperation
  | MoveBranchProposalOperation
  | ReorderChildrenProposalOperation
  | AddLinkProposalOperation
  | UpdateLinkProposalOperation
  | DeleteLinkProposalOperation;

export interface ProposalMarkdownSerializationResult {
  status: 'valid' | 'invalid';
  markdown?: string;
  diagnostics: string[];
}

export interface ProposalAffectedFile {
  path: WorkspaceRelativePath;
  baseFileVersion: ProposalFileVersionAnchor;
  changeKind: 'modify' | 'create' | 'delete' | 'rename';
  previousPath?: WorkspaceRelativePath;
  markdownSerialization?: ProposalMarkdownSerializationResult;
}

export type ProposalRiskFlag =
  | 'node_deletion'
  | 'branch_move'
  | 'link_change'
  | 'multi_file_change'
  | 'large_change'
  | 'markdown_serialization_warning';

export interface ProposalImpactSummary {
  changedNodeIds: NodeId[];
  addedNodeIds: NodeId[];
  deletedNodeIds: NodeId[];
  movedBranchRootIds: NodeId[];
  affectedLinkIds: LinkId[];
  affectedFilePaths: WorkspaceRelativePath[];
  counts: {
    changedNodes: number;
    addedNodes: number;
    deletedNodes: number;
    movedBranches: number;
    affectedLinks: number;
    affectedFiles: number;
  };
  includesDeletions: boolean;
  includesBranchMoves: boolean;
  includesLinkChanges: boolean;
  includesMultiFileChange: boolean;
}

export type ProposalValidationStatus = 'valid';

export type ProposalValidationErrorCode =
  | 'missing_proposal_id'
  | 'missing_source_conversation_id'
  | 'missing_created_at'
  | 'missing_target_scope'
  | 'unsupported_target_scope'
  | 'workspace_scope_forbidden'
  | 'missing_base_document_version'
  | 'unresolved_base_document_version'
  | 'missing_affected_file'
  | 'missing_affected_file_anchor'
  | 'missing_multi_file_metadata'
  | 'empty_operations'
  | 'duplicate_operation_id'
  | 'unknown_operation_type'
  | 'malformed_operation'
  | 'invalid_file_path'
  | 'unsupported_file_type'
  | 'out_of_workspace_file'
  | 'unknown_file_path'
  | 'unknown_target'
  | 'unknown_node_id'
  | 'operation_outside_target_scope'
  | 'unresolved_base_file_version'
  | 'invalid_markdown_serialization'
  | 'duplicate_node_id'
  | 'root_operation_forbidden'
  | 'cannot_move_into_descendant'
  | 'invalid_sibling_order'
  | 'tree_invariant_violation';

export interface ProposalValidationError {
  code: ProposalValidationErrorCode;
  message: string;
  field?: string;
  operationId?: string;
  filePath?: WorkspaceRelativePath;
  nodeId?: NodeId;
  details?: Record<string, string | number | boolean | null>;
}

export type ProposalValidationResult =
  | { ok: true; errors: [] }
  | { ok: false; errors: ProposalValidationError[] };

export interface AiChangeProposalInput {
  proposalId?: ProposalId;
  sourceConversationId?: AiConversationId;
  createdAt?: IsoDateTimeString;
  targetScope?: ProposalTargetScope;
  baseDocumentVersion?: number;
  affectedFiles?: ProposalAffectedFile[];
  operations?: ProposalOperation[];
  summary?: string;
}

export interface AiChangeProposal {
  proposalId: ProposalId;
  sourceConversationId: AiConversationId;
  createdAt: IsoDateTimeString;
  targetScope: ProposalTargetScope;
  baseDocumentVersion: number;
  affectedFiles: ProposalAffectedFile[];
  operations: ProposalOperation[];
  riskFlags: ProposalRiskFlag[];
  validationStatus: ProposalValidationStatus;
  validationErrors: [];
  impactSummary: ProposalImpactSummary;
  reviewMode: 'whole-proposal';
  summary?: string;
}

export type ProposalConstructionResult =
  | {
      ok: true;
      proposal: AiChangeProposal;
      validation: Extract<ProposalValidationResult, { ok: true }>;
    }
  | {
      ok: false;
      validation: Extract<ProposalValidationResult, { ok: false }>;
    };

export type ProposalReviewDecision =
  | {
      type: 'accept-proposal';
      proposalId: ProposalId;
      decidedAt: IsoDateTimeString;
    }
  | {
      type: 'reject-proposal';
      proposalId: ProposalId;
      decidedAt: IsoDateTimeString;
      reason?: string;
    };

export interface NormalizedAiSuggestion extends AiChangeProposalInput {
  suggestionId?: string;
}

export type ProposalConversionResult =
  | { ok: true; proposal: AiChangeProposal }
  | {
      ok: false;
      rejection: {
        code: 'proposal_validation_failed';
        message: string;
        errors: ProposalValidationError[];
      };
    };
