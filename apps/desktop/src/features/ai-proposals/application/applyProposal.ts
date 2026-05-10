import {
  applyMindMapCommand,
  validateMindMapDocument,
  type MindMapCommand,
  type MindMapCommandError,
  type MindMapDocument,
  type MindMapEditorState,
  type MindMapHistoryState,
  type MindMapNode,
  type MindMapSnapshot,
  type SelectionState,
  type ViewportState,
} from '../../../domain/mindMap';
import { mergeEditorDocumentIntoMarkdownDocument } from '../../../services/markdownLifecycle';
import type {
  CompatibilityDiagnostic,
  MarkdownMindMapDocument,
  SaveMarkdownMindMapResult,
  SerializeMindMapResult,
  WorkspaceId,
} from '../../../types/markdownLifecycle';
import { mapWorkspaceError, saveStatusFromBlockedResult } from '../../workspace/errorMapping';
import type { SaveStatus } from '../../workspace/types';
import type {
  AiChangeProposal,
  ProposalFileVersionAnchor,
  ProposalOperation,
  WorkspaceRelativePath,
} from '../domain/types';
import { createStatusMessage } from './messageMapping';
import type {
  ProposalReviewMessage,
  ProposalReviewStore,
} from './types';

const HISTORY_LABEL = 'Apply AI proposal';

export interface ApplyProposalActiveState {
  workspaceId?: WorkspaceId;
  activeFilePath: WorkspaceRelativePath;
  fileVersion: ProposalFileVersionAnchor;
  editorState: MindMapEditorState;
  markdownDocument: MarkdownMindMapDocument;
  markdownBuffer: string;
  saveStatus: SaveStatus;
  proposalHistory?: ApplyProposalHistoryState;
}

export interface ApplyProposalHistoryState {
  undoStack: ApplyProposalTransaction[];
  redoStack: ApplyProposalTransaction[];
  limit: number;
}

export interface ApplyProposalTransaction {
  label: string;
  proposalId: string;
  filePath: WorkspaceRelativePath;
  before: ApplyProposalUndoSnapshot;
  after: ApplyProposalUndoSnapshot;
}

export interface ApplyProposalUndoSnapshot {
  editorState: MindMapEditorState;
  markdownDocument: MarkdownMindMapDocument;
  markdownBuffer: string;
  fileVersion: ProposalFileVersionAnchor;
  saveStatus: SaveStatus;
}

export interface ApplyProposalSerializeInput {
  document: MarkdownMindMapDocument;
  targetPath: WorkspaceRelativePath;
}

export type ApplyProposalSerializeAdapter = (
  input: ApplyProposalSerializeInput,
) => Promise<SerializeMindMapResult> | SerializeMindMapResult;

export interface ApplyProposalSaveInput {
  workspaceId?: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  expectedVersion: ProposalFileVersionAnchor;
  markdownDocument: MarkdownMindMapDocument;
  markdownBuffer: string;
  editorDocument: MindMapDocument;
  proposal: AiChangeProposal;
}

export type ApplyProposalSaveAdapter = (
  input: ApplyProposalSaveInput,
) => Promise<SaveMarkdownMindMapResult> | SaveMarkdownMindMapResult;

type PreparedSaveResult = {
  ok: true;
  fileVersion: ProposalFileVersionAnchor;
  saveStatus: SaveStatus;
  saveResult?: SaveMarkdownMindMapResult & { status: 'saved' };
};

export interface ApplyAiProposalInput {
  proposal: AiChangeProposal;
  active: ApplyProposalActiveState;
  serializeMarkdown: ApplyProposalSerializeAdapter;
  conditionalSave?: ApplyProposalSaveAdapter;
  now?: Date;
}

export type ApplyAiProposalErrorCode =
  | 'unsupported_scope'
  | 'stale_document_version'
  | 'stale_file_version'
  | 'unsupported_operation'
  | 'operation_failed'
  | 'invalid_document'
  | 'markdown_serialization_failed'
  | 'markdown_compatibility_failed'
  | 'save_conflict'
  | 'save_failed'
  | 'history_empty'
  | 'review_not_ready';

export interface ApplyAiProposalError {
  code: ApplyAiProposalErrorCode;
  message: string;
  filePath?: WorkspaceRelativePath;
  operationId?: string;
  diagnostics?: CompatibilityDiagnostic[];
  commandError?: MindMapCommandError;
  cause?: unknown;
}

export type ApplyAiProposalResult =
  | {
      ok: true;
      state: ApplyProposalActiveState;
      transaction: ApplyProposalTransaction;
      markdownDiagnostics: CompatibilityDiagnostic[];
      saveResult?: SaveMarkdownMindMapResult & { status: 'saved' };
    }
  | {
      ok: false;
      state: ApplyProposalActiveState;
      error: ApplyAiProposalError;
    };

export type UndoAiProposalResult =
  | {
      ok: true;
      state: ApplyProposalActiveState;
      transaction: ApplyProposalTransaction;
    }
  | {
      ok: false;
      state: ApplyProposalActiveState;
      error: ApplyAiProposalError;
    };

export interface ApplyActiveProposalReviewInput {
  store: ProposalReviewStore;
  active: ApplyProposalActiveState;
  serializeMarkdown: ApplyProposalSerializeAdapter;
  conditionalSave?: ApplyProposalSaveAdapter;
  reviewId?: string;
  now?: Date;
}

export interface ApplyActiveProposalReviewResult {
  applyResult: ApplyAiProposalResult;
  messages: ProposalReviewMessage[];
}

export async function applyAiProposal(
  input: ApplyAiProposalInput,
): Promise<ApplyAiProposalResult> {
  const proposalScope = validateSingleFileScope(input.proposal, input.active);
  if (!proposalScope.ok) {
    return failed(input.active, proposalScope.error);
  }

  const activeDocumentVersion = input.active.editorState.document.version;
  if (input.proposal.baseDocumentVersion !== activeDocumentVersion) {
    return failed(input.active, {
      code: 'stale_document_version',
      message: `Proposal was based on document version ${input.proposal.baseDocumentVersion}; current version is ${activeDocumentVersion}.`,
      filePath: input.active.activeFilePath,
    });
  }

  const affectedFile = input.proposal.affectedFiles[0];
  if (affectedFile.baseFileVersion.token !== input.active.fileVersion.token) {
    return failed(input.active, {
      code: 'stale_file_version',
      message: `Proposal base file version ${affectedFile.baseFileVersion.token} does not match current version ${input.active.fileVersion.token}.`,
      filePath: affectedFile.path,
    });
  }

  const prepared = prepareNextEditorState(input);
  if (!prepared.ok) {
    return failed(input.active, prepared.error);
  }

  const documentValidation = validateMindMapDocument(prepared.editorState.document);
  if (!documentValidation.ok) {
    return failed(input.active, {
      code: 'invalid_document',
      message: 'Applying the proposal would create an invalid mind map document.',
      filePath: input.active.activeFilePath,
      diagnostics: documentValidation.errors.map((error) => ({
        code: error.code,
        severity: 'error',
        message: error.message,
        origin: null,
        nodeId: error.nodeId ?? null,
      })),
    });
  }

  const nextMarkdownDocument = mergeEditorDocumentIntoMarkdownDocument(
    prepared.editorState.document,
    input.active.markdownDocument,
  );
  const serialization = await input.serializeMarkdown({
    document: nextMarkdownDocument,
    targetPath: input.active.activeFilePath,
  });
  const serializationFailure = validateSerialization(serialization, input.active.activeFilePath);
  if (serializationFailure) {
    return failed(input.active, serializationFailure);
  }

  const nextMarkdownBuffer = serialization.markdown;
  if (typeof nextMarkdownBuffer !== 'string') {
    return failed(input.active, {
      code: 'markdown_serialization_failed',
      message: 'The Markdown serializer did not return a Markdown snapshot.',
      filePath: input.active.activeFilePath,
      diagnostics: serialization.diagnostics,
    });
  }
  const savePreparation = input.conditionalSave
    ? await prepareConditionalSave(input, prepared.editorState.document, nextMarkdownDocument, nextMarkdownBuffer)
    : noSavePrepared(input.active.activeFilePath);

  if (!savePreparation.ok) {
    return failed(input.active, savePreparation.error);
  }

  const nextState = commitPreparedApply({
    active: input.active,
    proposal: input.proposal,
    editorState: prepared.editorState,
    markdownDocument: nextMarkdownDocument,
    markdownBuffer: nextMarkdownBuffer,
    fileVersion: savePreparation.fileVersion,
    saveStatus: savePreparation.saveStatus,
  });

  return {
    ok: true,
    state: nextState.state,
    transaction: nextState.transaction,
    markdownDiagnostics: serialization.diagnostics,
    saveResult: savePreparation.saveResult,
  };
}

export function undoAiProposalApply(state: ApplyProposalActiveState): UndoAiProposalResult {
  const history = state.proposalHistory ?? emptyProposalHistory();
  const transaction = history.undoStack[history.undoStack.length - 1];

  if (!transaction) {
    return {
      ok: false,
      state,
      error: {
        code: 'history_empty',
        message: 'Cannot undo AI proposal apply; history is empty.',
        filePath: state.activeFilePath,
      },
    };
  }

  return {
    ok: true,
    transaction,
    state: {
      ...state,
      fileVersion: transaction.before.fileVersion,
      editorState: transaction.before.editorState,
      markdownDocument: transaction.before.markdownDocument,
      markdownBuffer: transaction.before.markdownBuffer,
      saveStatus: transaction.before.saveStatus,
      proposalHistory: {
        ...history,
        undoStack: history.undoStack.slice(0, -1),
        redoStack: pushBoundedTransaction(history.redoStack, transaction, history.limit),
      },
    },
  };
}

export async function applyActiveProposalReview(
  input: ApplyActiveProposalReviewInput,
): Promise<ApplyActiveProposalReviewResult> {
  const review = input.store.getState().activeReview;
  if (!review || (input.reviewId && review.reviewId !== input.reviewId) || !review.proposal) {
    const error: ApplyAiProposalError = {
      code: 'review_not_ready',
      message: 'There is no active proposal review ready to apply.',
      filePath: input.active.activeFilePath,
    };
    return {
      applyResult: failed(input.active, error),
      messages: [messageForApplyError(error)],
    };
  }

  const applying = input.store.beginApply(review.reviewId);
  if (!applying || applying.status !== 'applying') {
    const error: ApplyAiProposalError = {
      code: 'review_not_ready',
      message: 'The active proposal review cannot be accepted in its current state.',
      filePath: input.active.activeFilePath,
    };
    input.store.markFailed('proposal_apply_failed', error.message, review.reviewId);
    return {
      applyResult: failed(input.active, error),
      messages: [messageForApplyError(error)],
    };
  }

  const applyResult = await applyAiProposal({
    proposal: review.proposal,
    active: input.active,
    serializeMarkdown: input.serializeMarkdown,
    conditionalSave: input.conditionalSave,
    now: input.now,
  });

  const messages = applyResult.ok
    ? [
        createStatusMessage(
          'proposal_applied',
          'Proposal accepted',
          'The proposal was applied to the active Markdown file as one undoable transaction.',
        ),
      ]
    : [messageForApplyError(applyResult.error)];

  if (applyResult.ok) {
    input.store.markApplied(review.reviewId);
  } else if (isConflictError(applyResult.error)) {
    input.store.markConflict(messages, review.reviewId);
  } else {
    input.store.markFailed('proposal_apply_failed', applyResult.error.message, review.reviewId);
  }

  return { applyResult, messages };
}

function validateSingleFileScope(
  proposal: AiChangeProposal,
  active: ApplyProposalActiveState,
): { ok: true } | { ok: false; error: ApplyAiProposalError } {
  if (proposal.targetScope.type !== 'current-file' || proposal.targetScope.filePath !== active.activeFilePath) {
    return {
      ok: false,
      error: {
        code: 'unsupported_scope',
        message: 'Only current-file AI proposals for the active Markdown file can be applied here.',
        filePath:
          proposal.targetScope.type === 'multi-file'
            ? proposal.targetScope.filePaths[0]
            : 'filePath' in proposal.targetScope
              ? proposal.targetScope.filePath
              : active.activeFilePath,
      },
    };
  }

  if (
    proposal.affectedFiles.length !== 1 ||
    proposal.affectedFiles[0].path !== active.activeFilePath ||
    proposal.affectedFiles[0].changeKind !== 'modify'
  ) {
    return {
      ok: false,
      error: {
        code: 'unsupported_scope',
        message: 'The apply service only supports modifying the active Markdown file.',
        filePath: active.activeFilePath,
      },
    };
  }

  if (proposal.operations.some((operation) => operation.targetFilePath !== active.activeFilePath)) {
    return {
      ok: false,
      error: {
        code: 'unsupported_scope',
        message: 'Every proposal operation must target the active Markdown file.',
        filePath: active.activeFilePath,
      },
    };
  }

  return { ok: true };
}

function prepareNextEditorState(
  input: ApplyAiProposalInput,
): { ok: true; editorState: MindMapEditorState } | { ok: false; error: ApplyAiProposalError } {
  const now = input.now ?? new Date();
  let workingState = input.active.editorState;
  let sawDocumentChange = false;

  for (const operation of input.proposal.operations) {
    const command = commandForOperation(operation);
    if (!command.ok) {
      return { ok: false, error: command.error };
    }

    const result = applyMindMapCommand(workingState, command.command, { now });
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: 'operation_failed',
          message: result.error.message,
          filePath: operation.targetFilePath,
          operationId: operation.operationId,
          commandError: result.error,
        },
      };
    }

    workingState = result.state;
    sawDocumentChange = sawDocumentChange || result.change.documentChanged;
  }

  if (!sawDocumentChange) {
    workingState = {
      ...workingState,
      document: {
        ...workingState.document,
        version: input.active.editorState.document.version + 1,
        updatedAt: now.toISOString(),
      },
    };
  }

  const document = {
    ...workingState.document,
    version: input.active.editorState.document.version + 1,
  };
  const nextContentRevision = input.active.editorState.contentRevision + 1;

  return {
    ok: true,
    editorState: completeEditorState({
      snapshot: {
        document,
        selection: workingState.selection,
        viewport: input.active.editorState.viewport,
        contentRevision: nextContentRevision,
      },
      history: commitMindMapHistory(input.active.editorState.history, toMindMapSnapshot(input.active.editorState)),
      changeRevision: input.active.editorState.changeRevision + 1,
      savedContentRevision: input.active.editorState.savedContentRevision,
    }),
  };
}

function commandForOperation(
  operation: ProposalOperation,
): { ok: true; command: MindMapCommand } | { ok: false; error: ApplyAiProposalError } {
  switch (operation.type) {
    case 'add-node':
      return {
        ok: true,
        command: {
          type: 'add-child',
          parentId: operation.parentNodeId,
          newNodeId: operation.nodeId,
          text: operation.text,
          index: operation.index,
        },
      };
    case 'update-node':
      return {
        ok: true,
        command: {
          type: 'rename-node',
          nodeId: operation.nodeId,
          text: operation.text,
        },
      };
    case 'delete-node':
      return {
        ok: true,
        command: {
          type: 'delete-subtree',
          nodeId: operation.nodeId,
        },
      };
    case 'move-branch':
      return {
        ok: true,
        command: {
          type: 'move-subtree',
          nodeId: operation.nodeId,
          newParentId: operation.newParentNodeId,
          index: operation.index,
        },
      };
    case 'reorder-children':
      return {
        ok: true,
        command: {
          type: 'reorder-siblings',
          parentId: operation.parentNodeId,
          childIds: operation.childNodeIds,
        },
      };
    case 'add-link':
    case 'update-link':
    case 'delete-link':
      return {
        ok: false,
        error: {
          code: 'unsupported_operation',
          message: 'Link proposal operations are not supported by the current editor document model.',
          filePath: operation.targetFilePath,
          operationId: operation.operationId,
        },
      };
  }
}

function validateSerialization(
  serialization: SerializeMindMapResult,
  filePath: WorkspaceRelativePath,
): ApplyAiProposalError | null {
  if (serialization.status !== 'serialized' || typeof serialization.markdown !== 'string') {
    return {
      code: 'markdown_serialization_failed',
      message: 'The Markdown serializer could not produce a safe Markdown snapshot for this proposal.',
      filePath,
      diagnostics: serialization.diagnostics,
    };
  }

  const errorDiagnostics = serialization.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errorDiagnostics.length > 0) {
    return {
      code: 'markdown_compatibility_failed',
      message: 'The serialized Markdown has blocking compatibility diagnostics.',
      filePath,
      diagnostics: errorDiagnostics,
    };
  }

  return null;
}

async function prepareConditionalSave(
  input: ApplyAiProposalInput,
  nextEditorDocument: MindMapDocument,
  nextMarkdownDocument: MarkdownMindMapDocument,
  nextMarkdownBuffer: string,
): Promise<PreparedSaveResult | { ok: false; error: ApplyAiProposalError }> {
  if (!input.conditionalSave) {
    return noSavePrepared(input.active.activeFilePath);
  }

  try {
    const result = await input.conditionalSave({
      workspaceId: input.active.workspaceId,
      relativePath: input.active.activeFilePath,
      expectedVersion: input.active.fileVersion,
      markdownDocument: nextMarkdownDocument,
      markdownBuffer: nextMarkdownBuffer,
      editorDocument: nextEditorDocument,
      proposal: input.proposal,
    });

    if (result.status !== 'saved' || !result.save) {
      const blockedStatus = saveStatusFromBlockedResult(result);
      return {
        ok: false,
        error: {
          code: 'save_failed',
          message: blockedStatus.message,
          filePath: input.active.activeFilePath,
          diagnostics: result.diagnostics,
        },
      };
    }

    return {
      ok: true,
      fileVersion: result.save.version,
      saveStatus: {
        kind: 'saved',
        message: 'Saved',
        savedAt: result.save.savedAt,
        diagnostics: result.diagnostics,
      },
      saveResult: result as SaveMarkdownMindMapResult & { status: 'saved' },
    };
  } catch (cause) {
    const userMessage = mapWorkspaceError(cause);
    const workspaceCode =
      cause && typeof cause === 'object' && 'code' in cause
        ? (cause as { code?: unknown }).code
        : undefined;

    return {
      ok: false,
      error: {
        code: workspaceCode === 'version_conflict' ? 'save_conflict' : 'save_failed',
        message: userMessage.detail,
        filePath: input.active.activeFilePath,
        cause,
      },
    };
  }
}

function noSavePrepared(filePath: WorkspaceRelativePath): PreparedSaveResult {
  return {
    ok: true,
    fileVersion: {
      token: '',
    },
    saveStatus: {
      kind: 'unsaved',
      message: `Unsaved changes in ${filePath}`,
    },
  };
}

function commitPreparedApply(input: {
  active: ApplyProposalActiveState;
  proposal: AiChangeProposal;
  editorState: MindMapEditorState;
  markdownDocument: MarkdownMindMapDocument;
  markdownBuffer: string;
  fileVersion: ProposalFileVersionAnchor;
  saveStatus: SaveStatus;
}): { state: ApplyProposalActiveState; transaction: ApplyProposalTransaction } {
  const fileVersion = input.fileVersion.token ? input.fileVersion : input.active.fileVersion;
  const isSaved = input.saveStatus.kind === 'saved';
  const editorState = isSaved
    ? {
        ...input.editorState,
        savedContentRevision: input.editorState.contentRevision,
        isDirty: false,
      }
    : input.editorState;

  const before = snapshotForUndo(input.active);
  const after: ApplyProposalUndoSnapshot = {
    editorState,
    markdownDocument: input.markdownDocument,
    markdownBuffer: input.markdownBuffer,
    fileVersion,
    saveStatus: input.saveStatus,
  };
  const transaction: ApplyProposalTransaction = {
    label: HISTORY_LABEL,
    proposalId: input.proposal.proposalId,
    filePath: input.active.activeFilePath,
    before,
    after,
  };
  const proposalHistory = input.active.proposalHistory ?? emptyProposalHistory();

  return {
    transaction,
    state: {
      ...input.active,
      editorState,
      markdownDocument: input.markdownDocument,
      markdownBuffer: input.markdownBuffer,
      fileVersion,
      saveStatus: input.saveStatus,
      proposalHistory: {
        ...proposalHistory,
        undoStack: pushBoundedTransaction(proposalHistory.undoStack, transaction, proposalHistory.limit),
        redoStack: [],
      },
    },
  };
}

function failed(
  state: ApplyProposalActiveState,
  error: ApplyAiProposalError,
): Extract<ApplyAiProposalResult, { ok: false }> {
  return { ok: false, state, error };
}

function messageForApplyError(error: ApplyAiProposalError): ProposalReviewMessage {
  switch (error.code) {
    case 'stale_document_version':
      return createStatusMessage('proposal_stale_document', 'Document changed since proposal', error.message, 'error');
    case 'stale_file_version':
    case 'save_conflict':
      return createStatusMessage('proposal_stale_file', 'File changed since proposal', error.message, 'error');
    default:
      return createStatusMessage('proposal_apply_failed', 'Proposal failed', error.message, 'error');
  }
}

function isConflictError(error: ApplyAiProposalError): boolean {
  return (
    error.code === 'stale_document_version' ||
    error.code === 'stale_file_version' ||
    error.code === 'save_conflict'
  );
}

function completeEditorState(input: {
  snapshot: MindMapSnapshot;
  history: MindMapHistoryState;
  changeRevision: number;
  savedContentRevision: number;
}): MindMapEditorState {
  return {
    ...input.snapshot,
    history: input.history,
    changeRevision: input.changeRevision,
    savedContentRevision: input.savedContentRevision,
    isDirty: input.snapshot.contentRevision !== input.savedContentRevision,
  };
}

function commitMindMapHistory(history: MindMapHistoryState, snapshot: MindMapSnapshot): MindMapHistoryState {
  return {
    ...history,
    undoStack: pushBoundedSnapshot(history.undoStack, snapshot, history.limit),
    redoStack: [],
  };
}

function toMindMapSnapshot(state: MindMapEditorState): MindMapSnapshot {
  return {
    document: cloneDocument(state.document),
    selection: { ...state.selection },
    viewport: { ...state.viewport },
    contentRevision: state.contentRevision,
  };
}

function snapshotForUndo(state: ApplyProposalActiveState): ApplyProposalUndoSnapshot {
  return {
    editorState: cloneEditorState(state.editorState),
    markdownDocument: cloneMarkdownDocument(state.markdownDocument),
    markdownBuffer: state.markdownBuffer,
    fileVersion: { ...state.fileVersion },
    saveStatus: { ...state.saveStatus },
  };
}

function cloneEditorState(state: MindMapEditorState): MindMapEditorState {
  return {
    ...state,
    document: cloneDocument(state.document),
    selection: { ...state.selection },
    viewport: { ...state.viewport },
    history: {
      ...state.history,
      undoStack: state.history.undoStack.map(cloneSnapshot),
      redoStack: state.history.redoStack.map(cloneSnapshot),
    },
  };
}

function cloneSnapshot(snapshot: MindMapSnapshot): MindMapSnapshot {
  return {
    document: cloneDocument(snapshot.document),
    selection: cloneSelection(snapshot.selection),
    viewport: cloneViewport(snapshot.viewport),
    contentRevision: snapshot.contentRevision,
  };
}

function cloneDocument(document: MindMapDocument): MindMapDocument {
  return {
    ...document,
    nodes: cloneNodes(document.nodes),
  };
}

function cloneNodes(nodes: Record<string, MindMapNode>): Record<string, MindMapNode> {
  return Object.fromEntries(
    Object.entries(nodes).map(([nodeId, node]) => [
      nodeId,
      {
        ...node,
        childIds: [...node.childIds],
      },
    ]),
  );
}

function cloneSelection(selection: SelectionState): SelectionState {
  return { ...selection };
}

function cloneViewport(viewport: ViewportState): ViewportState {
  return { ...viewport };
}

function cloneMarkdownDocument(document: MarkdownMindMapDocument): MarkdownMindMapDocument {
  return {
    ...document,
    nodes: Object.fromEntries(
      Object.entries(document.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          ...node,
          children: [...node.children],
          links: node.links.map((link) => ({ ...link, origin: { ...link.origin, span: { ...link.origin.span } } })),
          listMarker: node.listMarker ? { ...node.listMarker } : null,
          origin: { ...node.origin, span: { ...node.origin.span } },
        },
      ]),
    ),
    diagnostics: document.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      origin: diagnostic.origin ? { ...diagnostic.origin, span: { ...diagnostic.origin.span } } : null,
    })),
    unmappedBlocks: document.unmappedBlocks.map((block) => ({
      ...block,
      origin: { ...block.origin, span: { ...block.origin.span } },
      placement: { ...block.placement },
    })),
  };
}

function emptyProposalHistory(): ApplyProposalHistoryState {
  return {
    undoStack: [],
    redoStack: [],
    limit: 100,
  };
}

function pushBoundedSnapshot<T extends MindMapSnapshot>(items: T[], item: T, limit: number): T[] {
  const nextItems = [...items, item];
  return nextItems.length <= limit ? nextItems : nextItems.slice(nextItems.length - limit);
}

function pushBoundedTransaction(
  items: ApplyProposalTransaction[],
  item: ApplyProposalTransaction,
  limit: number,
): ApplyProposalTransaction[] {
  const nextItems = [...items, item];
  return nextItems.length <= limit ? nextItems : nextItems.slice(nextItems.length - limit);
}
