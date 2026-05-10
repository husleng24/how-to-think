import type {
  MindMapCommand,
  MindMapEditorState,
  MindMapNode,
  NodeId,
} from './domain/mindMap';
import type { MindMapLayoutResult } from './layout';

export interface MindMapCommandAvailability {
  canAddChild: boolean;
  canAddSibling: boolean;
  canRename: boolean;
  canDelete: boolean;
  canCollapse: boolean;
  canExpand: boolean;
  canToggleCollapse: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface MindMapShortcutInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export type MindMapEditorAction =
  | { type: 'command'; command: MindMapCommand }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'begin-edit'; nodeId: NodeId }
  | { type: 'none' };

export function getMindMapCommandAvailability(
  state: MindMapEditorState,
): MindMapCommandAvailability {
  const selectedNode = getSelectedNode(state);
  const isRoot = selectedNode?.id === state.document.rootNodeId;
  const hasChildren = Boolean(selectedNode && selectedNode.childIds.length > 0);

  return {
    canAddChild: Boolean(selectedNode),
    canAddSibling: Boolean(selectedNode && !isRoot && selectedNode.parentId),
    canRename: Boolean(selectedNode),
    canDelete: Boolean(selectedNode && !isRoot),
    canCollapse: Boolean(selectedNode && hasChildren && !selectedNode.collapsed),
    canExpand: Boolean(selectedNode && hasChildren && selectedNode.collapsed),
    canToggleCollapse: hasChildren,
    canUndo: state.history.undoStack.length > 0,
    canRedo: state.history.redoStack.length > 0,
  };
}

export function resolveMindMapShortcut(
  input: MindMapShortcutInput,
  state: MindMapEditorState,
  layout: MindMapLayoutResult,
): MindMapEditorAction {
  const key = normalizeKey(input.key);
  const availability = getMindMapCommandAvailability(state);
  const selectedNodeId = state.selection.selectedNodeId;
  const selectedNode = state.document.nodes[selectedNodeId];
  const systemModifier = Boolean(input.ctrlKey || input.metaKey);

  if (systemModifier && !input.altKey && key === 'z') {
    return input.shiftKey
      ? availability.canRedo
        ? { type: 'redo' }
        : none()
      : availability.canUndo
        ? { type: 'undo' }
        : none();
  }

  if (systemModifier && !input.altKey && key === 'y') {
    return availability.canRedo ? { type: 'redo' } : none();
  }

  if (systemModifier || input.altKey || !selectedNode) {
    return none();
  }

  switch (key) {
    case 'enter':
      return availability.canAddSibling
        ? { type: 'command', command: { type: 'add-sibling', nodeId: selectedNodeId } }
        : none();
    case 'tab':
      return input.shiftKey
        ? parentSelectionAction(state, selectedNode)
        : availability.canAddChild
          ? { type: 'command', command: { type: 'add-child', parentId: selectedNodeId } }
          : none();
    case 'delete':
    case 'backspace':
      return availability.canDelete
        ? { type: 'command', command: { type: 'delete-subtree', nodeId: selectedNodeId } }
        : none();
    case 'f2':
      return availability.canRename ? { type: 'begin-edit', nodeId: selectedNodeId } : none();
    case 'space':
      return collapseAction(state, selectedNode, availability);
    case 'arrowup':
      return visibleSiblingAction(state, layout, -1);
    case 'arrowdown':
      return visibleSiblingAction(state, layout, 1);
    case 'arrowleft':
      return parentSelectionAction(state, selectedNode);
    case 'arrowright':
      return childSelectionOrExpandAction(state, layout, selectedNode);
    default:
      return none();
  }
}

export function getClosestVisibleNodeId(
  layout: MindMapLayoutResult,
  nodes: MindMapEditorState['document']['nodes'],
  selectedNodeId: NodeId,
): NodeId | null {
  const visible = new Set(layout.visibleNodeIds);
  let currentId: NodeId | null = selectedNodeId;

  while (currentId) {
    if (visible.has(currentId)) {
      return currentId;
    }

    currentId = nodes[currentId]?.parentId ?? null;
  }

  return layout.visibleNodeIds[0] ?? null;
}

function getSelectedNode(state: MindMapEditorState): MindMapNode | undefined {
  return state.document.nodes[state.selection.selectedNodeId];
}

function collapseAction(
  state: MindMapEditorState,
  node: MindMapNode,
  availability: MindMapCommandAvailability,
): MindMapEditorAction {
  if (!availability.canToggleCollapse) {
    return none();
  }

  return {
    type: 'command',
    command: {
      type: node.collapsed ? 'expand-node' : 'collapse-node',
      nodeId: state.selection.selectedNodeId,
    },
  };
}

function visibleSiblingAction(
  state: MindMapEditorState,
  layout: MindMapLayoutResult,
  offset: -1 | 1,
): MindMapEditorAction {
  const currentId = getClosestVisibleNodeId(
    layout,
    state.document.nodes,
    state.selection.selectedNodeId,
  );
  const currentIndex = currentId ? layout.visibleNodeIds.indexOf(currentId) : -1;
  const targetId = layout.visibleNodeIds[currentIndex + offset];

  return targetId ? selectAction(targetId) : none();
}

function parentSelectionAction(
  state: MindMapEditorState,
  node: MindMapNode,
): MindMapEditorAction {
  return node.parentId && state.document.nodes[node.parentId] ? selectAction(node.parentId) : none();
}

function childSelectionOrExpandAction(
  state: MindMapEditorState,
  layout: MindMapLayoutResult,
  node: MindMapNode,
): MindMapEditorAction {
  if (node.collapsed && node.childIds.length > 0) {
    return {
      type: 'command',
      command: { type: 'expand-node', nodeId: node.id },
    };
  }

  const visible = new Set(layout.visibleNodeIds);
  const childId = node.childIds.find((candidateId) => visible.has(candidateId));

  return childId ? selectAction(childId) : none();
}

function selectAction(nodeId: NodeId): MindMapEditorAction {
  return {
    type: 'command',
    command: { type: 'select-node', nodeId },
  };
}

function normalizeKey(key: string): string {
  if (key === ' ') {
    return 'space';
  }

  return key.toLowerCase();
}

function none(): MindMapEditorAction {
  return { type: 'none' };
}
