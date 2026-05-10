import { validateWorkspaceRelativeMarkdownPath } from './pathSafety';
import type {
  AiChangeProposalInput,
  NodeId,
  ProposalAffectedFile,
  ProposalDocumentSnapshot,
  ProposalFileVersionAnchor,
  ProposalKnownFile,
  ProposalNodeSnapshot,
  ProposalOperation,
  ProposalTargetScope,
  ProposalValidationContext,
  ProposalValidationError,
  ProposalValidationErrorCode,
  ProposalValidationResult,
  WorkspaceRelativePath,
} from './types';

type MutableDocument = ProposalDocumentSnapshot;

const SUPPORTED_OPERATION_TYPES = new Set<string>([
  'add-node',
  'update-node',
  'delete-node',
  'move-branch',
  'reorder-children',
  'add-link',
  'update-link',
  'delete-link',
]);

export function validateAiChangeProposalInput(
  input: AiChangeProposalInput,
  context: ProposalValidationContext,
): ProposalValidationResult {
  const errors: ProposalValidationError[] = [];
  const knownFilesByPath = indexKnownFiles(context.knownFiles);
  const documentsByPath = indexDocuments(context.knownFiles);
  const affectedFilePaths = validateAffectedFiles(input.affectedFiles, knownFilesByPath, errors);
  const targetScopePaths = validateTargetScope(input.targetScope, context, knownFilesByPath, errors);
  const operations = validateOperations(
    input.operations,
    input.targetScope,
    targetScopePaths,
    affectedFilePaths,
    documentsByPath,
    errors,
  );

  validateEnvelope(input, context, errors);
  validateMultiFileMetadata(input.targetScope, input.affectedFiles, operations, errors);
  validateTreeOperations(operations, documentsByPath, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, errors: [] };
}

function validateEnvelope(
  input: AiChangeProposalInput,
  context: ProposalValidationContext,
  errors: ProposalValidationError[],
): void {
  if (!isNonEmptyString(input.proposalId)) {
    errors.push(error('missing_proposal_id', 'A proposal id is required.', 'proposalId'));
  }

  if (!isNonEmptyString(input.sourceConversationId)) {
    errors.push(
      error(
        'missing_source_conversation_id',
        'A source conversation id is required.',
        'sourceConversationId',
      ),
    );
  }

  if (!isNonEmptyString(input.createdAt)) {
    errors.push(error('missing_created_at', 'A proposal creation timestamp is required.', 'createdAt'));
  }

  if (!Number.isInteger(input.baseDocumentVersion) || (input.baseDocumentVersion ?? 0) <= 0) {
    errors.push(
      error(
        'missing_base_document_version',
        'A positive base document version is required.',
        'baseDocumentVersion',
      ),
    );
    return;
  }

  if (input.baseDocumentVersion !== context.baseDocumentVersion) {
    errors.push(
      error(
        'unresolved_base_document_version',
        'Proposal base document version does not match the current context baseline.',
        'baseDocumentVersion',
        { expected: context.baseDocumentVersion, received: input.baseDocumentVersion ?? null },
      ),
    );
  }
}

function validateAffectedFiles(
  affectedFiles: ProposalAffectedFile[] | undefined,
  knownFilesByPath: Map<WorkspaceRelativePath, ProposalKnownFile>,
  errors: ProposalValidationError[],
): Set<WorkspaceRelativePath> {
  const affectedFilePaths = new Set<WorkspaceRelativePath>();

  if (!affectedFiles || affectedFiles.length === 0) {
    errors.push(error('missing_affected_file', 'At least one affected file is required.', 'affectedFiles'));
    return affectedFilePaths;
  }

  for (const [index, file] of affectedFiles.entries()) {
    const field = `affectedFiles.${index}`;
    const pathValidation = validateWorkspaceRelativeMarkdownPath(file.path);
    if (!pathValidation.ok) {
      errors.push(
        error(pathValidation.error.code, pathValidation.error.message, `${field}.path`, {
          filePath: file.path,
        }),
      );
      continue;
    }

    affectedFilePaths.add(file.path);
    const knownFile = knownFilesByPath.get(file.path);
    if (!knownFile) {
      errors.push(
        error(
          'unknown_file_path',
          'Affected file is not part of the selected workspace file index.',
          `${field}.path`,
          { filePath: file.path },
        ),
      );
    }

    if (!hasFileVersionAnchor(file.baseFileVersion)) {
      errors.push(
        error(
          'missing_affected_file_anchor',
          'Every affected file must include a backend-controlled base file version.',
          `${field}.baseFileVersion`,
          { filePath: file.path },
        ),
      );
    } else if (knownFile && !fileVersionsEqual(file.baseFileVersion, knownFile.version)) {
      errors.push(
        error(
          'unresolved_base_file_version',
          'Affected file version does not match the current workspace baseline.',
          `${field}.baseFileVersion`,
          { filePath: file.path },
        ),
      );
    }

    if (
      file.markdownSerialization?.status === 'invalid' ||
      (file.markdownSerialization?.status === 'valid' &&
        typeof file.markdownSerialization.markdown !== 'string')
    ) {
      errors.push(
        error(
          'invalid_markdown_serialization',
          'Markdown serialization output must be valid before a proposal can be reviewed.',
          `${field}.markdownSerialization`,
          { filePath: file.path },
        ),
      );
    }
  }

  return affectedFilePaths;
}

function validateTargetScope(
  targetScope: ProposalTargetScope | undefined,
  context: ProposalValidationContext,
  knownFilesByPath: Map<WorkspaceRelativePath, ProposalKnownFile>,
  errors: ProposalValidationError[],
): Set<WorkspaceRelativePath> {
  const targetScopePaths = new Set<WorkspaceRelativePath>();

  if (!targetScope) {
    errors.push(error('missing_target_scope', 'A target scope is required.', 'targetScope'));
    return targetScopePaths;
  }

  const scopeType = readType(targetScope);
  if (scopeType === 'workspace') {
    errors.push(
      error(
        'workspace_scope_forbidden',
        'Workspace-wide AI proposals are not supported by this contract.',
        'targetScope.type',
      ),
    );
    return targetScopePaths;
  }

  switch (targetScope.type) {
    case 'node':
      validateScopedFilePath(targetScope.filePath, 'targetScope.filePath', knownFilesByPath, errors);
      targetScopePaths.add(targetScope.filePath);
      validateNodeExists(targetScope.filePath, targetScope.nodeId, context, 'targetScope.nodeId', errors);
      break;
    case 'branch':
      validateScopedFilePath(targetScope.filePath, 'targetScope.filePath', knownFilesByPath, errors);
      targetScopePaths.add(targetScope.filePath);
      validateNodeExists(
        targetScope.filePath,
        targetScope.rootNodeId,
        context,
        'targetScope.rootNodeId',
        errors,
      );
      break;
    case 'current-file':
      validateScopedFilePath(targetScope.filePath, 'targetScope.filePath', knownFilesByPath, errors);
      targetScopePaths.add(targetScope.filePath);
      if (targetScope.filePath !== context.activeFilePath) {
        errors.push(
          error(
            'unknown_target',
            'Current-file scope must target the active file captured with AI context.',
            'targetScope.filePath',
            { expected: context.activeFilePath, received: targetScope.filePath },
          ),
        );
      }
      break;
    case 'multi-file':
      if (!Array.isArray(targetScope.filePaths) || targetScope.filePaths.length === 0) {
        errors.push(
          error(
            'missing_multi_file_metadata',
            'Multi-file scope must explicitly list target file paths.',
            'targetScope.filePaths',
          ),
        );
        break;
      }
      for (const [index, filePath] of targetScope.filePaths.entries()) {
        validateScopedFilePath(filePath, `targetScope.filePaths.${index}`, knownFilesByPath, errors);
        targetScopePaths.add(filePath);
      }
      break;
    default:
      errors.push(
        error(
          'unsupported_target_scope',
          'Target scope type is not supported by the AI proposal contract.',
          'targetScope.type',
          { received: readType(targetScope as unknown) ?? null },
        ),
      );
  }

  return targetScopePaths;
}

function validateOperations(
  operations: ProposalOperation[] | undefined,
  targetScope: ProposalTargetScope | undefined,
  targetScopePaths: Set<WorkspaceRelativePath>,
  affectedFilePaths: Set<WorkspaceRelativePath>,
  documentsByPath: Map<WorkspaceRelativePath, ProposalDocumentSnapshot>,
  errors: ProposalValidationError[],
): ProposalOperation[] {
  const validOperations: ProposalOperation[] = [];
  const operationIds = new Set<string>();

  if (!operations || operations.length === 0) {
    errors.push(error('empty_operations', 'AI proposal must include at least one operation.', 'operations'));
    return validOperations;
  }

  for (const [index, operation] of operations.entries()) {
    const field = `operations.${index}`;
    const operationType = readType(operation);
    const operationId = readStringProperty(operation, 'operationId');

    if (!SUPPORTED_OPERATION_TYPES.has(operationType ?? '')) {
      errors.push(
        operationError(
          'unknown_operation_type',
          'Operation type is not supported by the AI proposal contract.',
          field,
          operationId,
          undefined,
          undefined,
          { received: operationType ?? null },
        ),
      );
      continue;
    }

    if (!isNonEmptyString(operationId)) {
      errors.push(
        operationError(
          'malformed_operation',
          'Operation id is required.',
          `${field}.operationId`,
          undefined,
        ),
      );
    } else if (operationIds.has(operationId)) {
      errors.push(
        operationError(
          'duplicate_operation_id',
          'Operation ids must be unique within a proposal.',
          `${field}.operationId`,
          operationId,
        ),
      );
    }
    if (isNonEmptyString(operationId)) {
      operationIds.add(operationId);
    }

    const targetFilePath = readStringProperty(operation, 'targetFilePath');
    const pathValidation = validateWorkspaceRelativeMarkdownPath(targetFilePath);
    if (!pathValidation.ok) {
      errors.push(
        operationError(
          pathValidation.error.code,
          pathValidation.error.message,
          `${field}.targetFilePath`,
          operationId,
          targetFilePath,
        ),
      );
      continue;
    }
    const checkedTargetFilePath = pathValidation.path;

    if (!affectedFilePaths.has(checkedTargetFilePath)) {
      errors.push(
        operationError(
          'missing_affected_file_anchor',
          'Every operation target file must be listed in affectedFiles with a file version anchor.',
          `${field}.targetFilePath`,
          operationId,
          checkedTargetFilePath,
        ),
      );
    }

    if (targetScopePaths.size > 0 && !targetScopePaths.has(checkedTargetFilePath)) {
      errors.push(
        operationError(
          'operation_outside_target_scope',
          'Operation targets a file outside the proposal target scope.',
          `${field}.targetFilePath`,
          operationId,
          checkedTargetFilePath,
        ),
      );
    }

    validateOperationShape(operation, field, errors);
    validateOperationNodeTargets(operation, documentsByPath, errors);
    validateOperationTargetScope(operation, targetScope, documentsByPath, errors);
    validOperations.push(operation);
  }

  return validOperations;
}

function validateOperationShape(
  operation: ProposalOperation,
  field: string,
  errors: ProposalValidationError[],
): void {
  const operationId = operation.operationId;
  const malformed = (message: string, subfield: string): void => {
    errors.push(
      operationError(
        'malformed_operation',
        message,
        `${field}.${subfield}`,
        operationId,
        operation.targetFilePath,
      ),
    );
  };

  switch (operation.type) {
    case 'add-node':
      if (!isNonEmptyString(operation.nodeId)) {
        malformed('Added node id is required.', 'nodeId');
      }
      if (!isNonEmptyString(operation.parentNodeId)) {
        malformed('Parent node id is required.', 'parentNodeId');
      }
      if (typeof operation.text !== 'string') {
        malformed('Added node text must be a string.', 'text');
      }
      if (operation.index !== undefined && (!Number.isInteger(operation.index) || operation.index < 0)) {
        malformed('Insert index must be a non-negative integer.', 'index');
      }
      break;
    case 'update-node':
      if (!isNonEmptyString(operation.nodeId)) {
        malformed('Updated node id is required.', 'nodeId');
      }
      if (typeof operation.text !== 'string') {
        malformed('Updated node text must be a string.', 'text');
      }
      break;
    case 'delete-node':
      if (!isNonEmptyString(operation.nodeId)) {
        malformed('Deleted node id is required.', 'nodeId');
      }
      break;
    case 'move-branch':
      if (!isNonEmptyString(operation.nodeId)) {
        malformed('Moved branch node id is required.', 'nodeId');
      }
      if (!isNonEmptyString(operation.newParentNodeId)) {
        malformed('New parent node id is required.', 'newParentNodeId');
      }
      if (operation.index !== undefined && (!Number.isInteger(operation.index) || operation.index < 0)) {
        malformed('Move index must be a non-negative integer.', 'index');
      }
      break;
    case 'reorder-children':
      if (!isNonEmptyString(operation.parentNodeId)) {
        malformed('Reordered parent node id is required.', 'parentNodeId');
      }
      if (!Array.isArray(operation.childNodeIds)) {
        malformed('Reordered child node ids must be an array.', 'childNodeIds');
      }
      break;
    case 'add-link':
      if (!isNonEmptyString(operation.linkId)) {
        malformed('Added link id is required.', 'linkId');
      }
      if (!isNonEmptyString(operation.sourceNodeId)) {
        malformed('Link source node id is required.', 'sourceNodeId');
      }
      if (!operation.target) {
        malformed('Link target is required.', 'target');
      }
      break;
    case 'update-link':
      if (!isNonEmptyString(operation.linkId)) {
        malformed('Updated link id is required.', 'linkId');
      }
      if (!isNonEmptyString(operation.sourceNodeId)) {
        malformed('Link source node id is required.', 'sourceNodeId');
      }
      if (!operation.target && operation.label === undefined) {
        malformed('Updated link must include a target or label change.', 'target');
      }
      break;
    case 'delete-link':
      if (!isNonEmptyString(operation.linkId)) {
        malformed('Deleted link id is required.', 'linkId');
      }
      if (!isNonEmptyString(operation.sourceNodeId)) {
        malformed('Link source node id is required.', 'sourceNodeId');
      }
      break;
  }
}

function validateOperationNodeTargets(
  operation: ProposalOperation,
  documentsByPath: Map<WorkspaceRelativePath, ProposalDocumentSnapshot>,
  errors: ProposalValidationError[],
): void {
  const document = documentsByPath.get(operation.targetFilePath);
  if (!document) {
    return;
  }

  const checkNode = (nodeId: NodeId, field: string): void => {
    if (!document.nodes[nodeId]) {
      errors.push(
        operationError(
          'unknown_node_id',
          'Operation references a node that does not exist in the base document.',
          field,
          operation.operationId,
          operation.targetFilePath,
          nodeId,
        ),
      );
    }
  };

  switch (operation.type) {
    case 'add-node':
      checkNode(operation.parentNodeId, 'parentNodeId');
      break;
    case 'update-node':
    case 'delete-node':
      checkNode(operation.nodeId, 'nodeId');
      break;
    case 'move-branch':
      checkNode(operation.nodeId, 'nodeId');
      checkNode(operation.newParentNodeId, 'newParentNodeId');
      break;
    case 'reorder-children':
      checkNode(operation.parentNodeId, 'parentNodeId');
      for (const childNodeId of operation.childNodeIds) {
        checkNode(childNodeId, 'childNodeIds');
      }
      break;
    case 'add-link':
    case 'update-link':
    case 'delete-link':
      checkNode(operation.sourceNodeId, 'sourceNodeId');
      break;
  }
}

function validateOperationTargetScope(
  operation: ProposalOperation,
  targetScope: ProposalTargetScope | undefined,
  documentsByPath: Map<WorkspaceRelativePath, ProposalDocumentSnapshot>,
  errors: ProposalValidationError[],
): void {
  if (!targetScope) {
    return;
  }

  switch (targetScope.type) {
    case 'node':
      if (operation.targetFilePath !== targetScope.filePath) {
        return;
      }
      if (!operationTouchesNode(operation, targetScope.nodeId)) {
        errors.push(
          operationError(
            'operation_outside_target_scope',
            'Operation does not touch the selected node target scope.',
            'operations',
            operation.operationId,
            operation.targetFilePath,
          ),
        );
      }
      break;
    case 'branch': {
      if (operation.targetFilePath !== targetScope.filePath) {
        return;
      }
      const document = documentsByPath.get(targetScope.filePath);
      const scopedNodeIds = new Set(collectSubtreeNodeIds(document, targetScope.rootNodeId));
      if (!operationTouchesAnyNode(operation, scopedNodeIds)) {
        errors.push(
          operationError(
            'operation_outside_target_scope',
            'Operation does not touch the selected branch target scope.',
            'operations',
            operation.operationId,
            operation.targetFilePath,
          ),
        );
      }
      break;
    }
    case 'current-file':
    case 'multi-file':
      break;
  }
}

function validateMultiFileMetadata(
  targetScope: ProposalTargetScope | undefined,
  affectedFiles: ProposalAffectedFile[] | undefined,
  operations: ProposalOperation[],
  errors: ProposalValidationError[],
): void {
  const affectedFilePaths = new Set((affectedFiles ?? []).map((file) => file.path));
  const operationFilePaths = new Set(operations.map((operation) => operation.targetFilePath));
  const isMultiFile = affectedFilePaths.size > 1 || operationFilePaths.size > 1;

  if (isMultiFile && targetScope?.type !== 'multi-file') {
    errors.push(
      error(
        'missing_multi_file_metadata',
        'Multi-file proposals must use an explicit multi-file target scope.',
        'targetScope',
      ),
    );
  }

  if (targetScope?.type === 'multi-file') {
    for (const filePath of targetScope.filePaths) {
      if (!affectedFilePaths.has(filePath)) {
        errors.push(
          error(
            'missing_multi_file_metadata',
            'Every multi-file target must have affected file metadata.',
            'affectedFiles',
            { filePath },
          ),
        );
      }
    }
  }
}

function validateTreeOperations(
  operations: ProposalOperation[],
  documentsByPath: Map<WorkspaceRelativePath, ProposalDocumentSnapshot>,
  errors: ProposalValidationError[],
): void {
  const operationsByPath = groupOperationsByPath(operations);

  for (const [filePath, fileOperations] of operationsByPath) {
    const document = documentsByPath.get(filePath);
    if (!document) {
      continue;
    }

    let nextDocument = cloneDocument(document);
    for (const operation of fileOperations) {
      const applyResult = applyTreeOperation(nextDocument, operation);
      if (!applyResult.ok) {
        errors.push(applyResult.error);
        continue;
      }

      nextDocument = applyResult.document;
      const invariantErrors = validateDocumentTree(nextDocument);
      for (const invariantError of invariantErrors) {
        errors.push(
          operationError(
            'tree_invariant_violation',
            invariantError,
            'operations',
            operation.operationId,
            operation.targetFilePath,
          ),
        );
      }
    }
  }
}

function applyTreeOperation(
  document: MutableDocument,
  operation: ProposalOperation,
):
  | { ok: true; document: MutableDocument }
  | { ok: false; error: ProposalValidationError } {
  switch (operation.type) {
    case 'add-node':
      return applyAddNode(document, operation);
    case 'update-node':
      return applyUpdateNode(document, operation);
    case 'delete-node':
      return applyDeleteNode(document, operation);
    case 'move-branch':
      return applyMoveBranch(document, operation);
    case 'reorder-children':
      return applyReorderChildren(document, operation);
    case 'add-link':
    case 'update-link':
    case 'delete-link':
      return document.nodes[operation.sourceNodeId]
        ? { ok: true, document }
        : {
            ok: false,
            error: operationError(
              'unknown_node_id',
              'Link operation source node does not exist.',
              'sourceNodeId',
              operation.operationId,
              operation.targetFilePath,
              operation.sourceNodeId,
            ),
          };
  }
}

function applyAddNode(
  document: MutableDocument,
  operation: Extract<ProposalOperation, { type: 'add-node' }>,
): ReturnType<typeof applyTreeOperation> {
  if (document.nodes[operation.nodeId]) {
    return {
      ok: false,
      error: operationError(
        'duplicate_node_id',
        'Added node id already exists in the base document.',
        'nodeId',
        operation.operationId,
        operation.targetFilePath,
        operation.nodeId,
      ),
    };
  }

  const parent = document.nodes[operation.parentNodeId];
  if (!parent) {
    return unknownNode(operation, operation.parentNodeId, 'parentNodeId');
  }

  const index = operation.index ?? parent.childIds.length;
  if (!Number.isInteger(index) || index < 0 || index > parent.childIds.length) {
    return malformedTreeOperation(operation, 'Insert index is outside the parent child range.');
  }

  const nodes = cloneNodes(document.nodes);
  nodes[parent.id] = {
    ...parent,
    childIds: insertAt(parent.childIds, operation.nodeId, index),
  };
  nodes[operation.nodeId] = {
    id: operation.nodeId,
    text: operation.text,
    parentId: parent.id,
    childIds: [],
  };

  return { ok: true, document: { ...document, nodes } };
}

function applyUpdateNode(
  document: MutableDocument,
  operation: Extract<ProposalOperation, { type: 'update-node' }>,
): ReturnType<typeof applyTreeOperation> {
  const node = document.nodes[operation.nodeId];
  if (!node) {
    return unknownNode(operation, operation.nodeId, 'nodeId');
  }

  return {
    ok: true,
    document: {
      ...document,
      nodes: {
        ...document.nodes,
        [node.id]: {
          ...node,
          text: operation.text,
        },
      },
    },
  };
}

function applyDeleteNode(
  document: MutableDocument,
  operation: Extract<ProposalOperation, { type: 'delete-node' }>,
): ReturnType<typeof applyTreeOperation> {
  const node = document.nodes[operation.nodeId];
  if (!node) {
    return unknownNode(operation, operation.nodeId, 'nodeId');
  }

  if (node.id === document.rootNodeId || node.parentId === null) {
    return {
      ok: false,
      error: operationError(
        'root_operation_forbidden',
        'Deleting the root node is not supported by the proposal contract.',
        'nodeId',
        operation.operationId,
        operation.targetFilePath,
        operation.nodeId,
      ),
    };
  }

  const parent = document.nodes[node.parentId];
  if (!parent) {
    return malformedTreeOperation(operation, 'Deleted node parent is missing.');
  }

  const deletedNodeIds = new Set(collectSubtreeNodeIds(document, node.id));
  const nodes = cloneNodes(document.nodes);
  for (const nodeId of deletedNodeIds) {
    delete nodes[nodeId];
  }
  nodes[parent.id] = {
    ...parent,
    childIds: parent.childIds.filter((childId) => childId !== node.id),
  };

  return { ok: true, document: { ...document, nodes } };
}

function applyMoveBranch(
  document: MutableDocument,
  operation: Extract<ProposalOperation, { type: 'move-branch' }>,
): ReturnType<typeof applyTreeOperation> {
  const node = document.nodes[operation.nodeId];
  if (!node) {
    return unknownNode(operation, operation.nodeId, 'nodeId');
  }

  if (node.id === document.rootNodeId || node.parentId === null) {
    return {
      ok: false,
      error: operationError(
        'root_operation_forbidden',
        'Moving the root node is not supported by the proposal contract.',
        'nodeId',
        operation.operationId,
        operation.targetFilePath,
        operation.nodeId,
      ),
    };
  }

  const oldParent = document.nodes[node.parentId];
  const newParent = document.nodes[operation.newParentNodeId];
  if (!oldParent) {
    return malformedTreeOperation(operation, 'Moved node parent is missing.');
  }
  if (!newParent) {
    return unknownNode(operation, operation.newParentNodeId, 'newParentNodeId');
  }
  if (newParent.id === node.id || isDescendantOf(document, newParent.id, node.id)) {
    return {
      ok: false,
      error: operationError(
        'cannot_move_into_descendant',
        'Cannot move a branch into itself or one of its descendants.',
        'newParentNodeId',
        operation.operationId,
        operation.targetFilePath,
        operation.nodeId,
      ),
    };
  }

  const remainingOldSiblings = oldParent.childIds.filter((childId) => childId !== node.id);
  const targetChildren = oldParent.id === newParent.id ? remainingOldSiblings : newParent.childIds;
  const index = operation.index ?? targetChildren.length;
  if (!Number.isInteger(index) || index < 0 || index > targetChildren.length) {
    return malformedTreeOperation(operation, 'Move index is outside the target parent child range.');
  }

  const nodes = cloneNodes(document.nodes);
  nodes[node.id] = { ...node, parentId: newParent.id };
  if (oldParent.id === newParent.id) {
    nodes[oldParent.id] = {
      ...oldParent,
      childIds: insertAt(targetChildren, node.id, index),
    };
  } else {
    nodes[oldParent.id] = { ...oldParent, childIds: remainingOldSiblings };
    nodes[newParent.id] = {
      ...newParent,
      childIds: insertAt(targetChildren, node.id, index),
    };
  }

  return { ok: true, document: { ...document, nodes } };
}

function applyReorderChildren(
  document: MutableDocument,
  operation: Extract<ProposalOperation, { type: 'reorder-children' }>,
): ReturnType<typeof applyTreeOperation> {
  const parent = document.nodes[operation.parentNodeId];
  if (!parent) {
    return unknownNode(operation, operation.parentNodeId, 'parentNodeId');
  }

  if (!hasSameMembers(parent.childIds, operation.childNodeIds)) {
    return {
      ok: false,
      error: operationError(
        'invalid_sibling_order',
        'Reordered child node ids must match the existing sibling set exactly once.',
        'childNodeIds',
        operation.operationId,
        operation.targetFilePath,
        operation.parentNodeId,
      ),
    };
  }

  return {
    ok: true,
    document: {
      ...document,
      nodes: {
        ...document.nodes,
        [parent.id]: {
          ...parent,
          childIds: [...operation.childNodeIds],
        },
      },
    },
  };
}

function validateDocumentTree(document: ProposalDocumentSnapshot): string[] {
  const errors: string[] = [];
  const root = document.nodes[document.rootNodeId];
  if (!root) {
    errors.push(`Root node does not exist: ${document.rootNodeId}`);
    return errors;
  }
  if (root.parentId !== null) {
    errors.push('Root node parent must be null.');
  }

  for (const [nodeId, node] of Object.entries(document.nodes)) {
    if (node.id !== nodeId) {
      errors.push(`Node key ${nodeId} does not match node id ${node.id}.`);
    }
    if (node.parentId === null && node.id !== document.rootNodeId) {
      errors.push(`Only the root node may have a null parent: ${node.id}.`);
    }

    const childIds = new Set<NodeId>();
    for (const childId of node.childIds) {
      if (childIds.has(childId)) {
        errors.push(`Node ${node.id} lists child ${childId} more than once.`);
      }
      childIds.add(childId);

      const child = document.nodes[childId];
      if (!child) {
        errors.push(`Node ${node.id} references missing child ${childId}.`);
      } else if (child.parentId !== node.id) {
        errors.push(`Child ${childId} points to parent ${child.parentId}, expected ${node.id}.`);
      }
    }
  }

  const visited = new Set<NodeId>();
  const visiting = new Set<NodeId>();
  const visit = (nodeId: NodeId): void => {
    if (visiting.has(nodeId)) {
      errors.push(`Cycle detected at node ${nodeId}.`);
      return;
    }
    if (visited.has(nodeId)) {
      return;
    }

    const node = document.nodes[nodeId];
    if (!node) {
      return;
    }

    visiting.add(nodeId);
    for (const childId of node.childIds) {
      visit(childId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(document.rootNodeId);

  for (const nodeId of Object.keys(document.nodes)) {
    if (!visited.has(nodeId)) {
      errors.push(`Node ${nodeId} is not reachable from root ${document.rootNodeId}.`);
    }
  }

  return errors;
}

function validateScopedFilePath(
  filePath: WorkspaceRelativePath,
  field: string,
  knownFilesByPath: Map<WorkspaceRelativePath, ProposalKnownFile>,
  errors: ProposalValidationError[],
): void {
  const validation = validateWorkspaceRelativeMarkdownPath(filePath);
  if (!validation.ok) {
    errors.push(error(validation.error.code, validation.error.message, field, { filePath }));
    return;
  }

  if (!knownFilesByPath.has(filePath)) {
    errors.push(
      error(
        'unknown_file_path',
        'Target file is not part of the selected workspace file index.',
        field,
        { filePath },
      ),
    );
  }
}

function validateNodeExists(
  filePath: WorkspaceRelativePath,
  nodeId: NodeId,
  context: ProposalValidationContext,
  field: string,
  errors: ProposalValidationError[],
): void {
  const document = context.knownFiles.find((file) => file.path === filePath)?.document;
  if (document && !document.nodes[nodeId]) {
    errors.push(
      error(
        'unknown_node_id',
        'Target scope references a node that does not exist in the base document.',
        field,
        { filePath, nodeId },
      ),
    );
  }
}

function operationTouchesNode(operation: ProposalOperation, nodeId: NodeId): boolean {
  switch (operation.type) {
    case 'add-node':
      return operation.parentNodeId === nodeId || operation.nodeId === nodeId;
    case 'update-node':
    case 'delete-node':
    case 'move-branch':
      return operation.nodeId === nodeId;
    case 'reorder-children':
      return operation.parentNodeId === nodeId || operation.childNodeIds.includes(nodeId);
    case 'add-link':
    case 'update-link':
    case 'delete-link':
      return operation.sourceNodeId === nodeId;
  }
}

function operationTouchesAnyNode(operation: ProposalOperation, nodeIds: Set<NodeId>): boolean {
  switch (operation.type) {
    case 'add-node':
      return nodeIds.has(operation.parentNodeId) || nodeIds.has(operation.nodeId);
    case 'update-node':
    case 'delete-node':
    case 'move-branch':
      return nodeIds.has(operation.nodeId);
    case 'reorder-children':
      return nodeIds.has(operation.parentNodeId) || operation.childNodeIds.some((nodeId) => nodeIds.has(nodeId));
    case 'add-link':
    case 'update-link':
    case 'delete-link':
      return nodeIds.has(operation.sourceNodeId);
  }
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

function isDescendantOf(
  document: ProposalDocumentSnapshot,
  nodeId: NodeId,
  ancestorId: NodeId,
): boolean {
  let current = document.nodes[nodeId]?.parentId ?? null;
  while (current) {
    if (current === ancestorId) {
      return true;
    }
    current = document.nodes[current]?.parentId ?? null;
  }

  return false;
}

function groupOperationsByPath(
  operations: ProposalOperation[],
): Map<WorkspaceRelativePath, ProposalOperation[]> {
  const grouped = new Map<WorkspaceRelativePath, ProposalOperation[]>();
  for (const operation of operations) {
    grouped.set(operation.targetFilePath, [...(grouped.get(operation.targetFilePath) ?? []), operation]);
  }

  return grouped;
}

function indexKnownFiles(
  knownFiles: ProposalKnownFile[],
): Map<WorkspaceRelativePath, ProposalKnownFile> {
  return new Map(knownFiles.map((file) => [file.path, file]));
}

function indexDocuments(
  knownFiles: ProposalKnownFile[],
): Map<WorkspaceRelativePath, ProposalDocumentSnapshot> {
  return new Map(
    knownFiles
      .filter((file) => file.document)
      .map((file) => [file.path, file.document as ProposalDocumentSnapshot]),
  );
}

function cloneDocument(document: ProposalDocumentSnapshot): ProposalDocumentSnapshot {
  return {
    ...document,
    nodes: cloneNodes(document.nodes),
  };
}

function cloneNodes(
  nodes: Record<NodeId, ProposalNodeSnapshot>,
): Record<NodeId, ProposalNodeSnapshot> {
  return Object.fromEntries(
    Object.entries(nodes).map(([nodeId, node]) => [
      nodeId,
      {
        ...node,
        childIds: [...node.childIds],
        links: node.links ? [...node.links] : undefined,
      },
    ]),
  );
}

function fileVersionsEqual(
  left: ProposalFileVersionAnchor,
  right: ProposalFileVersionAnchor,
): boolean {
  return left.token === right.token;
}

function hasFileVersionAnchor(version: ProposalFileVersionAnchor | undefined): boolean {
  return Boolean(version && isNonEmptyString(version.token));
}

function hasSameMembers(left: NodeId[], right: NodeId[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const counts = new Map<NodeId, number>();
  for (const item of left) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }

  for (const item of right) {
    const count = counts.get(item);
    if (!count) {
      return false;
    }
    if (count === 1) {
      counts.delete(item);
    } else {
      counts.set(item, count - 1);
    }
  }

  return counts.size === 0;
}

function insertAt<T>(items: T[], item: T, index: number): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function unknownNode(
  operation: ProposalOperation,
  nodeId: NodeId,
  field: string,
): { ok: false; error: ProposalValidationError } {
  return {
    ok: false,
    error: operationError(
      'unknown_node_id',
      'Operation references a node that does not exist in the base document.',
      field,
      operation.operationId,
      operation.targetFilePath,
      nodeId,
    ),
  };
}

function malformedTreeOperation(
  operation: ProposalOperation,
  message: string,
): { ok: false; error: ProposalValidationError } {
  return {
    ok: false,
    error: operationError(
      'malformed_operation',
      message,
      'operations',
      operation.operationId,
      operation.targetFilePath,
    ),
  };
}

function readType(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return undefined;
  }

  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return undefined;
  }

  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function error(
  code: ProposalValidationErrorCode,
  message: string,
  field?: string,
  details?: Record<string, string | number | boolean | null>,
): ProposalValidationError {
  return {
    code,
    message,
    field,
    details,
  };
}

function operationError(
  code: ProposalValidationErrorCode,
  message: string,
  field?: string,
  operationId?: string,
  filePath?: WorkspaceRelativePath,
  nodeId?: NodeId,
  details?: Record<string, string | number | boolean | null>,
): ProposalValidationError {
  return {
    code,
    message,
    field,
    operationId,
    filePath,
    nodeId,
    details,
  };
}
