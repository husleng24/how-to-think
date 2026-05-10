export type NodeId = string;

export type MindMapCommandType =
  | 'add-child'
  | 'add-sibling'
  | 'rename-node'
  | 'delete-subtree'
  | 'move-subtree'
  | 'reorder-siblings'
  | 'collapse-node'
  | 'expand-node'
  | 'select-node'
  | 'focus-node'
  | 'update-viewport';

export type MindMapCommandErrorCode =
  | 'node_not_found'
  | 'root_operation_forbidden'
  | 'duplicate_node_id'
  | 'invalid_index'
  | 'invalid_sibling_order'
  | 'cannot_move_into_descendant'
  | 'invalid_viewport'
  | 'invariant_violation'
  | 'history_empty';

export interface MindMapNode {
  id: NodeId;
  text: string;
  parentId: NodeId | null;
  childIds: NodeId[];
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MindMapDocument {
  id: string;
  title: string;
  sourcePath: string | null;
  rootNodeId: NodeId;
  version: number;
  nodes: Record<NodeId, MindMapNode>;
  createdAt: string;
  updatedAt: string;
}

export interface SelectionState {
  selectedNodeId: NodeId;
  focusedNodeId: NodeId | null;
}

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface MindMapSnapshot {
  document: MindMapDocument;
  selection: SelectionState;
  viewport: ViewportState;
  contentRevision: number;
}

export interface MindMapHistoryState {
  undoStack: MindMapSnapshot[];
  redoStack: MindMapSnapshot[];
  limit: number;
}

export interface MindMapEditorState extends MindMapSnapshot {
  history: MindMapHistoryState;
  changeRevision: number;
  savedContentRevision: number;
  isDirty: boolean;
}

export interface MindMapChangeSignal {
  command: MindMapCommandType | 'undo' | 'redo' | 'mark-clean';
  changed: boolean;
  documentChanged: boolean;
  changeRevision: number;
  contentRevision: number;
  isDirty: boolean;
  addedNodeId?: NodeId;
  deletedNodeIds?: NodeId[];
}

export interface MindMapCommandError {
  code: MindMapCommandErrorCode;
  message: string;
  command: MindMapCommandType | 'undo' | 'redo';
  nodeId?: NodeId;
  details?: unknown;
}

export type MindMapCommandResult =
  | {
      ok: true;
      state: MindMapEditorState;
      change: MindMapChangeSignal;
    }
  | {
      ok: false;
      state: MindMapEditorState;
      error: MindMapCommandError;
    };

export interface MindMapInvariantError {
  code:
    | 'missing_root'
    | 'node_key_mismatch'
    | 'multiple_roots'
    | 'missing_child'
    | 'duplicate_child'
    | 'parent_mismatch'
    | 'cycle'
    | 'unreachable_node';
  message: string;
  nodeId?: NodeId;
  details?: unknown;
}

export type MindMapValidationResult =
  | { ok: true; errors: [] }
  | { ok: false; errors: MindMapInvariantError[] };

export interface AddChildCommand {
  type: 'add-child';
  parentId: NodeId;
  text?: string;
  index?: number;
  newNodeId?: NodeId;
}

export interface AddSiblingCommand {
  type: 'add-sibling';
  nodeId: NodeId;
  text?: string;
  position?: 'before' | 'after';
  newNodeId?: NodeId;
}

export interface RenameNodeCommand {
  type: 'rename-node';
  nodeId: NodeId;
  text: string;
}

export interface DeleteSubtreeCommand {
  type: 'delete-subtree';
  nodeId: NodeId;
}

export interface MoveSubtreeCommand {
  type: 'move-subtree';
  nodeId: NodeId;
  newParentId: NodeId;
  index?: number;
}

export interface ReorderSiblingsCommand {
  type: 'reorder-siblings';
  parentId: NodeId;
  childIds: NodeId[];
}

export interface CollapseNodeCommand {
  type: 'collapse-node';
  nodeId: NodeId;
}

export interface ExpandNodeCommand {
  type: 'expand-node';
  nodeId: NodeId;
}

export interface SelectNodeCommand {
  type: 'select-node';
  nodeId: NodeId;
}

export interface FocusNodeCommand {
  type: 'focus-node';
  nodeId: NodeId | null;
}

export interface UpdateViewportCommand {
  type: 'update-viewport';
  viewport: Partial<ViewportState>;
}

export type MindMapCommand =
  | AddChildCommand
  | AddSiblingCommand
  | RenameNodeCommand
  | DeleteSubtreeCommand
  | MoveSubtreeCommand
  | ReorderSiblingsCommand
  | CollapseNodeCommand
  | ExpandNodeCommand
  | SelectNodeCommand
  | FocusNodeCommand
  | UpdateViewportCommand;

export type MindMapIdGenerator = () => NodeId;
export type MindMapClock = () => Date;
export type MindMapStoreListener = (state: MindMapEditorState, change: MindMapChangeSignal) => void;

export interface CreateMindMapDocumentOptions {
  id?: string;
  title?: string;
  sourcePath?: string | null;
  rootNodeId?: NodeId;
  rootText?: string;
  now?: Date;
}

export interface CreateMindMapEditorStateOptions extends CreateMindMapDocumentOptions {
  document?: MindMapDocument;
  selection?: Partial<SelectionState>;
  viewport?: Partial<ViewportState>;
  historyLimit?: number;
}

export interface ApplyMindMapCommandOptions {
  generateId?: MindMapIdGenerator;
  now?: Date;
}

export interface CreateMindMapStoreOptions extends CreateMindMapEditorStateOptions {
  generateId?: MindMapIdGenerator;
  clock?: MindMapClock;
}

export interface MindMapEditorStore {
  getState(): MindMapEditorState;
  dispatch(command: MindMapCommand, options?: ApplyMindMapCommandOptions): MindMapCommandResult;
  undo(options?: { now?: Date }): MindMapCommandResult;
  redo(options?: { now?: Date }): MindMapCommandResult;
  markClean(): MindMapEditorState;
  subscribe(listener: MindMapStoreListener): () => void;
}

const DEFAULT_DOCUMENT_ID = 'draft';
const DEFAULT_DOCUMENT_TITLE = 'Untitled map';
const DEFAULT_ROOT_NODE_ID = 'root';
const DEFAULT_ROOT_TEXT = 'Untitled thought';
const DEFAULT_NODE_TEXT = 'New thought';
const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_VIEWPORT: ViewportState = { x: 0, y: 0, zoom: 1 };

let fallbackIdCounter = 0;

export function createSequentialNodeIdGenerator(prefix = 'node'): MindMapIdGenerator {
  let nextId = 1;

  return () => `${prefix}-${nextId++}`;
}

export function createEmptyMindMapDocument(
  input: Date | CreateMindMapDocumentOptions = {},
): MindMapDocument {
  const options = input instanceof Date ? { now: input } : input;
  const timestamp = (options.now ?? new Date()).toISOString();
  const rootNodeId = options.rootNodeId ?? DEFAULT_ROOT_NODE_ID;
  const rootText = options.rootText ?? DEFAULT_ROOT_TEXT;

  return {
    id: options.id ?? DEFAULT_DOCUMENT_ID,
    title: options.title ?? DEFAULT_DOCUMENT_TITLE,
    sourcePath: options.sourcePath ?? null,
    rootNodeId,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: {
      [rootNodeId]: {
        id: rootNodeId,
        text: rootText,
        parentId: null,
        childIds: [],
        collapsed: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  };
}

export function createMindMapEditorState(
  options: CreateMindMapEditorStateOptions = {},
): MindMapEditorState {
  const document = options.document ?? createEmptyMindMapDocument(options);
  const selectedNodeId = options.selection?.selectedNodeId ?? document.rootNodeId;
  const focusedNodeId = options.selection?.focusedNodeId ?? selectedNodeId;
  const viewport = {
    ...DEFAULT_VIEWPORT,
    ...options.viewport,
  };
  const contentRevision = document.version;
  const savedContentRevision = contentRevision;

  return {
    document,
    selection: {
      selectedNodeId,
      focusedNodeId,
    },
    viewport,
    contentRevision,
    history: {
      undoStack: [],
      redoStack: [],
      limit: options.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    },
    changeRevision: 0,
    savedContentRevision,
    isDirty: false,
  };
}

export function getMindMapNode(document: MindMapDocument, nodeId: NodeId): MindMapNode {
  const node = document.nodes[nodeId];

  if (!node) {
    throw new Error(`Mind map node not found: ${nodeId}`);
  }

  return node;
}

export function listChildNodes(document: MindMapDocument, nodeId: NodeId): MindMapNode[] {
  return getMindMapNode(document, nodeId).childIds.map((childId) =>
    getMindMapNode(document, childId),
  );
}

export function validateMindMapDocument(document: MindMapDocument): MindMapValidationResult {
  const errors: MindMapInvariantError[] = [];
  const root = document.nodes[document.rootNodeId];

  if (!root) {
    errors.push({
      code: 'missing_root',
      message: `Root node does not exist: ${document.rootNodeId}`,
      nodeId: document.rootNodeId,
    });
  }

  for (const [nodeId, node] of Object.entries(document.nodes)) {
    if (node.id !== nodeId) {
      errors.push({
        code: 'node_key_mismatch',
        message: `Node key ${nodeId} does not match node id ${node.id}`,
        nodeId,
      });
    }

    if (node.parentId === null && node.id !== document.rootNodeId) {
      errors.push({
        code: 'multiple_roots',
        message: `Only the root node may have a null parent: ${node.id}`,
        nodeId: node.id,
      });
    }

    const seenChildIds = new Set<NodeId>();
    for (const childId of node.childIds) {
      if (seenChildIds.has(childId)) {
        errors.push({
          code: 'duplicate_child',
          message: `Node ${node.id} lists child ${childId} more than once`,
          nodeId: node.id,
          details: { childId },
        });
      }
      seenChildIds.add(childId);

      const child = document.nodes[childId];
      if (!child) {
        errors.push({
          code: 'missing_child',
          message: `Node ${node.id} references missing child ${childId}`,
          nodeId: node.id,
          details: { childId },
        });
        continue;
      }

      if (child.parentId !== node.id) {
        errors.push({
          code: 'parent_mismatch',
          message: `Child ${childId} points to parent ${child.parentId}, expected ${node.id}`,
          nodeId: childId,
        });
      }
    }
  }

  if (root) {
    const visited = new Set<NodeId>();
    const visiting = new Set<NodeId>();

    const visit = (nodeId: NodeId): void => {
      if (visiting.has(nodeId)) {
        errors.push({
          code: 'cycle',
          message: `Cycle detected at node ${nodeId}`,
          nodeId,
        });
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
        errors.push({
          code: 'unreachable_node',
          message: `Node ${nodeId} is not reachable from root ${document.rootNodeId}`,
          nodeId,
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, errors: [] };
}

export function getSubtreeNodeIds(document: MindMapDocument, nodeId: NodeId): NodeId[] {
  assertNodeExists(document, nodeId);

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

export function isDescendantOf(
  document: MindMapDocument,
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

export function applyMindMapCommand(
  state: MindMapEditorState,
  command: MindMapCommand,
  options: ApplyMindMapCommandOptions = {},
): MindMapCommandResult {
  const applied = applyCommandToSnapshot(state, command, options);

  if (!applied.ok) {
    return {
      ok: false,
      state,
      error: applied.error,
    };
  }

  if (!applied.changed) {
    return {
      ok: true,
      state,
      change: {
        command: command.type,
        changed: false,
        documentChanged: false,
        changeRevision: state.changeRevision,
        contentRevision: state.contentRevision,
        isDirty: state.isDirty,
      },
    };
  }

  const undoStack = pushBoundedSnapshot(state.history.undoStack, toSnapshot(state), state.history.limit);
  const nextContentRevision = applied.documentChanged
    ? state.contentRevision + 1
    : state.contentRevision;
  const nextState = completeState({
    snapshot: {
      document: applied.snapshot.document,
      selection: applied.snapshot.selection,
      viewport: applied.snapshot.viewport,
      contentRevision: nextContentRevision,
    },
    history: {
      ...state.history,
      undoStack,
      redoStack: [],
    },
    changeRevision: state.changeRevision + 1,
    savedContentRevision: state.savedContentRevision,
  });

  return {
    ok: true,
    state: nextState,
    change: {
      command: command.type,
      changed: true,
      documentChanged: applied.documentChanged,
      changeRevision: nextState.changeRevision,
      contentRevision: nextState.contentRevision,
      isDirty: nextState.isDirty,
      addedNodeId: applied.addedNodeId,
      deletedNodeIds: applied.deletedNodeIds,
    },
  };
}

export function undoMindMapCommand(
  state: MindMapEditorState,
  options: { now?: Date } = {},
): MindMapCommandResult {
  void options;
  const previous = state.history.undoStack[state.history.undoStack.length - 1];

  if (!previous) {
    return historyError(state, 'undo');
  }

  const undoStack = state.history.undoStack.slice(0, -1);
  const redoStack = pushBoundedSnapshot(state.history.redoStack, toSnapshot(state), state.history.limit);
  const nextState = completeState({
    snapshot: previous,
    history: {
      ...state.history,
      undoStack,
      redoStack,
    },
    changeRevision: state.changeRevision + 1,
    savedContentRevision: state.savedContentRevision,
  });

  return {
    ok: true,
    state: nextState,
    change: {
      command: 'undo',
      changed: true,
      documentChanged: nextState.contentRevision !== state.contentRevision,
      changeRevision: nextState.changeRevision,
      contentRevision: nextState.contentRevision,
      isDirty: nextState.isDirty,
    },
  };
}

export function redoMindMapCommand(
  state: MindMapEditorState,
  options: { now?: Date } = {},
): MindMapCommandResult {
  void options;
  const next = state.history.redoStack[state.history.redoStack.length - 1];

  if (!next) {
    return historyError(state, 'redo');
  }

  const redoStack = state.history.redoStack.slice(0, -1);
  const undoStack = pushBoundedSnapshot(state.history.undoStack, toSnapshot(state), state.history.limit);
  const nextState = completeState({
    snapshot: next,
    history: {
      ...state.history,
      undoStack,
      redoStack,
    },
    changeRevision: state.changeRevision + 1,
    savedContentRevision: state.savedContentRevision,
  });

  return {
    ok: true,
    state: nextState,
    change: {
      command: 'redo',
      changed: true,
      documentChanged: nextState.contentRevision !== state.contentRevision,
      changeRevision: nextState.changeRevision,
      contentRevision: nextState.contentRevision,
      isDirty: nextState.isDirty,
    },
  };
}

export function markMindMapClean(state: MindMapEditorState): MindMapEditorState {
  return {
    ...state,
    savedContentRevision: state.contentRevision,
    isDirty: false,
    changeRevision: state.changeRevision + 1,
  };
}

export function createMindMapEditorStore(
  options: CreateMindMapStoreOptions = {},
): MindMapEditorStore {
  let state = createMindMapEditorState(options);
  const listeners = new Set<MindMapStoreListener>();

  const emit = (change: MindMapChangeSignal): void => {
    for (const listener of listeners) {
      listener(state, change);
    }
  };

  const getNow = (): Date => options.clock?.() ?? new Date();

  return {
    getState() {
      return state;
    },

    dispatch(command, commandOptions = {}) {
      const result = applyMindMapCommand(state, command, {
        generateId: commandOptions.generateId ?? options.generateId,
        now: commandOptions.now ?? getNow(),
      });

      if (result.ok) {
        state = result.state;
        if (result.change.changed) {
          emit(result.change);
        }
      }

      return result;
    },

    undo(commandOptions = {}) {
      const result = undoMindMapCommand(state, commandOptions);

      if (result.ok) {
        state = result.state;
        emit(result.change);
      }

      return result;
    },

    redo(commandOptions = {}) {
      const result = redoMindMapCommand(state, commandOptions);

      if (result.ok) {
        state = result.state;
        emit(result.change);
      }

      return result;
    },

    markClean() {
      state = markMindMapClean(state);
      emit({
        command: 'mark-clean',
        changed: true,
        documentChanged: false,
        changeRevision: state.changeRevision,
        contentRevision: state.contentRevision,
        isDirty: state.isDirty,
      });

      return state;
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function applyCommandToSnapshot(
  state: MindMapEditorState,
  command: MindMapCommand,
  options: ApplyMindMapCommandOptions,
):
  | {
      ok: true;
      snapshot: MindMapSnapshot;
      changed: boolean;
      documentChanged: boolean;
      addedNodeId?: NodeId;
      deletedNodeIds?: NodeId[];
    }
  | { ok: false; error: MindMapCommandError } {
  switch (command.type) {
    case 'add-child':
      return addChild(state, command, options);
    case 'add-sibling':
      return addSibling(state, command, options);
    case 'rename-node':
      return renameNode(state, command, options);
    case 'delete-subtree':
      return deleteSubtree(state, command, options);
    case 'move-subtree':
      return moveSubtree(state, command, options);
    case 'reorder-siblings':
      return reorderSiblings(state, command, options);
    case 'collapse-node':
      return setCollapsed(state, command, true, options);
    case 'expand-node':
      return setCollapsed(state, command, false, options);
    case 'select-node':
      return selectNode(state, command);
    case 'focus-node':
      return focusNode(state, command);
    case 'update-viewport':
      return updateViewport(state, command);
  }
}

function addChild(
  state: MindMapEditorState,
  command: AddChildCommand,
  options: ApplyMindMapCommandOptions,
): ReturnType<typeof applyCommandToSnapshot> {
  const parent = state.document.nodes[command.parentId];
  if (!parent) {
    return commandError('node_not_found', command, `Parent node not found: ${command.parentId}`, command.parentId);
  }

  const childCount = parent.childIds.length;
  const index = command.index ?? childCount;
  if (!Number.isInteger(index) || index < 0 || index > childCount) {
    return commandError('invalid_index', command, `Child index ${index} is outside 0..${childCount}`, command.parentId);
  }

  const newNodeId = command.newNodeId ?? generateNodeId(state.document, options.generateId);
  if (state.document.nodes[newNodeId]) {
    return commandError('duplicate_node_id', command, `Node already exists: ${newNodeId}`, newNodeId);
  }

  const timestamp = getTimestamp(options);
  const nodes = cloneNodes(state.document.nodes);
  nodes[command.parentId] = {
    ...parent,
    childIds: insertAt(parent.childIds, newNodeId, index),
    updatedAt: timestamp,
  };
  nodes[newNodeId] = {
    id: newNodeId,
    text: command.text ?? DEFAULT_NODE_TEXT,
    parentId: command.parentId,
    childIds: [],
    collapsed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const nextDocument = touchDocument(state.document, nodes, timestamp);

  return validateAppliedSnapshot(
    state,
    command,
    {
      document: nextDocument,
      selection: { selectedNodeId: newNodeId, focusedNodeId: newNodeId },
      viewport: state.viewport,
      contentRevision: state.contentRevision,
    },
    true,
    { addedNodeId: newNodeId },
  );
}

function addSibling(
  state: MindMapEditorState,
  command: AddSiblingCommand,
  options: ApplyMindMapCommandOptions,
): ReturnType<typeof applyCommandToSnapshot> {
  const node = state.document.nodes[command.nodeId];
  if (!node) {
    return commandError('node_not_found', command, `Node not found: ${command.nodeId}`, command.nodeId);
  }

  if (node.id === state.document.rootNodeId || !node.parentId) {
    return commandError(
      'root_operation_forbidden',
      command,
      'Cannot add a sibling for the root node',
      command.nodeId,
    );
  }

  const parent = state.document.nodes[node.parentId];
  if (!parent) {
    return commandError('invariant_violation', command, `Parent node not found: ${node.parentId}`, node.parentId);
  }

  const siblingIndex = parent.childIds.indexOf(node.id);
  const index = command.position === 'before' ? siblingIndex : siblingIndex + 1;
  const newNodeId = command.newNodeId ?? generateNodeId(state.document, options.generateId);
  if (state.document.nodes[newNodeId]) {
    return commandError('duplicate_node_id', command, `Node already exists: ${newNodeId}`, newNodeId);
  }

  const timestamp = getTimestamp(options);
  const nodes = cloneNodes(state.document.nodes);
  nodes[parent.id] = {
    ...parent,
    childIds: insertAt(parent.childIds, newNodeId, index),
    updatedAt: timestamp,
  };
  nodes[newNodeId] = {
    id: newNodeId,
    text: command.text ?? DEFAULT_NODE_TEXT,
    parentId: parent.id,
    childIds: [],
    collapsed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const nextDocument = touchDocument(state.document, nodes, timestamp);

  return validateAppliedSnapshot(
    state,
    command,
    {
      document: nextDocument,
      selection: { selectedNodeId: newNodeId, focusedNodeId: newNodeId },
      viewport: state.viewport,
      contentRevision: state.contentRevision,
    },
    true,
    { addedNodeId: newNodeId },
  );
}

function renameNode(
  state: MindMapEditorState,
  command: RenameNodeCommand,
  options: ApplyMindMapCommandOptions,
): ReturnType<typeof applyCommandToSnapshot> {
  const node = state.document.nodes[command.nodeId];
  if (!node) {
    return commandError('node_not_found', command, `Node not found: ${command.nodeId}`, command.nodeId);
  }

  if (node.text === command.text) {
    return unchanged(state);
  }

  const timestamp = getTimestamp(options);
  const nodes = cloneNodes(state.document.nodes);
  nodes[command.nodeId] = {
    ...node,
    text: command.text,
    updatedAt: timestamp,
  };

  return validateAppliedSnapshot(
    state,
    command,
    {
      document: touchDocument(state.document, nodes, timestamp),
      selection: state.selection,
      viewport: state.viewport,
      contentRevision: state.contentRevision,
    },
    true,
  );
}

function deleteSubtree(
  state: MindMapEditorState,
  command: DeleteSubtreeCommand,
  options: ApplyMindMapCommandOptions,
): ReturnType<typeof applyCommandToSnapshot> {
  const node = state.document.nodes[command.nodeId];
  if (!node) {
    return commandError('node_not_found', command, `Node not found: ${command.nodeId}`, command.nodeId);
  }

  if (node.id === state.document.rootNodeId || !node.parentId) {
    return commandError(
      'root_operation_forbidden',
      command,
      'Cannot delete the root node without resetting the document',
      command.nodeId,
    );
  }

  const parent = state.document.nodes[node.parentId];
  if (!parent) {
    return commandError('invariant_violation', command, `Parent node not found: ${node.parentId}`, node.parentId);
  }

  const deletedNodeIds = getSubtreeNodeIds(state.document, command.nodeId);
  const deletedSet = new Set(deletedNodeIds);
  const timestamp = getTimestamp(options);
  const nodes = cloneNodes(state.document.nodes);

  for (const deletedId of deletedNodeIds) {
    delete nodes[deletedId];
  }

  nodes[parent.id] = {
    ...parent,
    childIds: parent.childIds.filter((childId) => childId !== command.nodeId),
    updatedAt: timestamp,
  };

  const selectedNodeId = deletedSet.has(state.selection.selectedNodeId)
    ? parent.id
    : state.selection.selectedNodeId;
  const focusedNodeId =
    state.selection.focusedNodeId && deletedSet.has(state.selection.focusedNodeId)
      ? parent.id
      : state.selection.focusedNodeId;

  return validateAppliedSnapshot(
    state,
    command,
    {
      document: touchDocument(state.document, nodes, timestamp),
      selection: { selectedNodeId, focusedNodeId },
      viewport: state.viewport,
      contentRevision: state.contentRevision,
    },
    true,
    { deletedNodeIds },
  );
}

function moveSubtree(
  state: MindMapEditorState,
  command: MoveSubtreeCommand,
  options: ApplyMindMapCommandOptions,
): ReturnType<typeof applyCommandToSnapshot> {
  const node = state.document.nodes[command.nodeId];
  if (!node) {
    return commandError('node_not_found', command, `Node not found: ${command.nodeId}`, command.nodeId);
  }

  if (node.id === state.document.rootNodeId || !node.parentId) {
    return commandError('root_operation_forbidden', command, 'Cannot move the root node', command.nodeId);
  }

  const oldParent = state.document.nodes[node.parentId];
  const newParent = state.document.nodes[command.newParentId];
  if (!oldParent) {
    return commandError('invariant_violation', command, `Parent node not found: ${node.parentId}`, node.parentId);
  }
  if (!newParent) {
    return commandError('node_not_found', command, `New parent node not found: ${command.newParentId}`, command.newParentId);
  }

  if (newParent.id === node.id || isDescendantOf(state.document, newParent.id, node.id)) {
    return commandError(
      'cannot_move_into_descendant',
      command,
      'Cannot move a node into itself or one of its descendants',
      node.id,
      { newParentId: newParent.id },
    );
  }

  const remainingOldSiblings = oldParent.childIds.filter((childId) => childId !== node.id);
  const newParentChildIds =
    oldParent.id === newParent.id ? remainingOldSiblings : newParent.childIds;
  const index = command.index ?? newParentChildIds.length;

  if (!Number.isInteger(index) || index < 0 || index > newParentChildIds.length) {
    return commandError(
      'invalid_index',
      command,
      `Move index ${index} is outside 0..${newParentChildIds.length}`,
      node.id,
    );
  }

  const nextNewParentChildren = insertAt(newParentChildIds, node.id, index);
  if (oldParent.id === newParent.id && arraysEqual(oldParent.childIds, nextNewParentChildren)) {
    return unchanged(state);
  }

  const timestamp = getTimestamp(options);
  const nodes = cloneNodes(state.document.nodes);
  nodes[node.id] = {
    ...node,
    parentId: newParent.id,
    updatedAt: timestamp,
  };

  if (oldParent.id === newParent.id) {
    nodes[oldParent.id] = {
      ...oldParent,
      childIds: nextNewParentChildren,
      updatedAt: timestamp,
    };
  } else {
    nodes[oldParent.id] = {
      ...oldParent,
      childIds: remainingOldSiblings,
      updatedAt: timestamp,
    };
    nodes[newParent.id] = {
      ...newParent,
      childIds: nextNewParentChildren,
      updatedAt: timestamp,
    };
  }

  return validateAppliedSnapshot(
    state,
    command,
    {
      document: touchDocument(state.document, nodes, timestamp),
      selection: state.selection,
      viewport: state.viewport,
      contentRevision: state.contentRevision,
    },
    true,
  );
}

function reorderSiblings(
  state: MindMapEditorState,
  command: ReorderSiblingsCommand,
  options: ApplyMindMapCommandOptions,
): ReturnType<typeof applyCommandToSnapshot> {
  const parent = state.document.nodes[command.parentId];
  if (!parent) {
    return commandError('node_not_found', command, `Parent node not found: ${command.parentId}`, command.parentId);
  }

  if (!hasSameMembers(parent.childIds, command.childIds)) {
    return commandError(
      'invalid_sibling_order',
      command,
      'Reordered child ids must contain exactly the same siblings once',
      parent.id,
      { expected: parent.childIds, received: command.childIds },
    );
  }

  if (arraysEqual(parent.childIds, command.childIds)) {
    return unchanged(state);
  }

  const timestamp = getTimestamp(options);
  const nodes = cloneNodes(state.document.nodes);
  nodes[parent.id] = {
    ...parent,
    childIds: [...command.childIds],
    updatedAt: timestamp,
  };

  return validateAppliedSnapshot(
    state,
    command,
    {
      document: touchDocument(state.document, nodes, timestamp),
      selection: state.selection,
      viewport: state.viewport,
      contentRevision: state.contentRevision,
    },
    true,
  );
}

function setCollapsed(
  state: MindMapEditorState,
  command: CollapseNodeCommand | ExpandNodeCommand,
  collapsed: boolean,
  options: ApplyMindMapCommandOptions,
): ReturnType<typeof applyCommandToSnapshot> {
  const node = state.document.nodes[command.nodeId];
  if (!node) {
    return commandError('node_not_found', command, `Node not found: ${command.nodeId}`, command.nodeId);
  }

  if (node.collapsed === collapsed) {
    return unchanged(state);
  }

  const timestamp = getTimestamp(options);
  const nodes = cloneNodes(state.document.nodes);
  nodes[node.id] = {
    ...node,
    collapsed,
    updatedAt: timestamp,
  };

  return validateAppliedSnapshot(
    state,
    command,
    {
      document: touchDocument(state.document, nodes, timestamp),
      selection: state.selection,
      viewport: state.viewport,
      contentRevision: state.contentRevision,
    },
    true,
  );
}

function selectNode(
  state: MindMapEditorState,
  command: SelectNodeCommand,
): ReturnType<typeof applyCommandToSnapshot> {
  if (!state.document.nodes[command.nodeId]) {
    return commandError('node_not_found', command, `Node not found: ${command.nodeId}`, command.nodeId);
  }

  if (state.selection.selectedNodeId === command.nodeId) {
    return unchanged(state);
  }

  return {
    ok: true,
    snapshot: {
      document: state.document,
      selection: {
        ...state.selection,
        selectedNodeId: command.nodeId,
      },
      viewport: state.viewport,
      contentRevision: state.contentRevision,
    },
    changed: true,
    documentChanged: false,
  };
}

function focusNode(
  state: MindMapEditorState,
  command: FocusNodeCommand,
): ReturnType<typeof applyCommandToSnapshot> {
  if (command.nodeId !== null && !state.document.nodes[command.nodeId]) {
    return commandError('node_not_found', command, `Node not found: ${command.nodeId}`, command.nodeId);
  }

  if (state.selection.focusedNodeId === command.nodeId) {
    return unchanged(state);
  }

  return {
    ok: true,
    snapshot: {
      document: state.document,
      selection: {
        ...state.selection,
        focusedNodeId: command.nodeId,
      },
      viewport: state.viewport,
      contentRevision: state.contentRevision,
    },
    changed: true,
    documentChanged: false,
  };
}

function updateViewport(
  state: MindMapEditorState,
  command: UpdateViewportCommand,
): ReturnType<typeof applyCommandToSnapshot> {
  const viewport = {
    ...state.viewport,
    ...command.viewport,
  };

  if (!isValidViewport(viewport)) {
    return commandError('invalid_viewport', command, 'Viewport values must be finite and zoom must be greater than zero');
  }

  if (
    viewport.x === state.viewport.x &&
    viewport.y === state.viewport.y &&
    viewport.zoom === state.viewport.zoom
  ) {
    return unchanged(state);
  }

  return {
    ok: true,
    snapshot: {
      document: state.document,
      selection: state.selection,
      viewport,
      contentRevision: state.contentRevision,
    },
    changed: true,
    documentChanged: false,
  };
}

function validateAppliedSnapshot(
  state: MindMapEditorState,
  command: MindMapCommand,
  snapshot: MindMapSnapshot,
  documentChanged: boolean,
  extras: { addedNodeId?: NodeId; deletedNodeIds?: NodeId[] } = {},
): ReturnType<typeof applyCommandToSnapshot> {
  const validation = validateMindMapDocument(snapshot.document);
  if (!validation.ok) {
    return commandError(
      'invariant_violation',
      command,
      'Command produced an invalid mind map document',
      undefined,
      validation.errors,
    );
  }

  if (snapshot === state) {
    return unchanged(state);
  }

  return {
    ok: true,
    snapshot,
    changed: true,
    documentChanged,
    ...extras,
  };
}

function completeState(input: {
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

function toSnapshot(state: MindMapEditorState): MindMapSnapshot {
  return {
    document: state.document,
    selection: state.selection,
    viewport: state.viewport,
    contentRevision: state.contentRevision,
  };
}

function touchDocument(
  document: MindMapDocument,
  nodes: Record<NodeId, MindMapNode>,
  timestamp: string,
): MindMapDocument {
  return {
    ...document,
    nodes,
    version: document.version + 1,
    updatedAt: timestamp,
  };
}

function cloneNodes(nodes: Record<NodeId, MindMapNode>): Record<NodeId, MindMapNode> {
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

function generateNodeId(
  document: MindMapDocument,
  generateId: MindMapIdGenerator | undefined,
): NodeId {
  if (generateId) {
    return generateId();
  }

  let candidate: NodeId;
  do {
    fallbackIdCounter += 1;
    candidate = `node-${fallbackIdCounter}`;
  } while (document.nodes[candidate]);

  return candidate;
}

function getTimestamp(options: ApplyMindMapCommandOptions): string {
  return (options.now ?? new Date()).toISOString();
}

function pushBoundedSnapshot(
  snapshots: MindMapSnapshot[],
  snapshot: MindMapSnapshot,
  limit: number,
): MindMapSnapshot[] {
  const nextSnapshots = [...snapshots, snapshot];

  if (nextSnapshots.length <= limit) {
    return nextSnapshots;
  }

  return nextSnapshots.slice(nextSnapshots.length - limit);
}

function insertAt<T>(items: T[], item: T, index: number): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function arraysEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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

function isValidViewport(viewport: ViewportState): boolean {
  return (
    Number.isFinite(viewport.x) &&
    Number.isFinite(viewport.y) &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom > 0
  );
}

function assertNodeExists(document: MindMapDocument, nodeId: NodeId): void {
  if (!document.nodes[nodeId]) {
    throw new Error(`Mind map node not found: ${nodeId}`);
  }
}

function unchanged(
  state: MindMapEditorState,
): Extract<ReturnType<typeof applyCommandToSnapshot>, { ok: true }> {
  return {
    ok: true,
    snapshot: toSnapshot(state),
    changed: false,
    documentChanged: false,
  };
}

function commandError(
  code: MindMapCommandErrorCode,
  command: MindMapCommand,
  message: string,
  nodeId?: NodeId,
  details?: unknown,
): Extract<ReturnType<typeof applyCommandToSnapshot>, { ok: false }> {
  return {
    ok: false,
    error: {
      code,
      command: command.type,
      message,
      nodeId,
      details,
    },
  };
}

function historyError(state: MindMapEditorState, command: 'undo' | 'redo'): MindMapCommandResult {
  return {
    ok: false,
    state,
    error: {
      code: 'history_empty',
      command,
      message: `Cannot ${command}; history stack is empty`,
    },
  };
}
