import {
  isDescendantOf,
  type MindMapCommand,
  type MindMapEditorState,
  type MindMapNode,
  type NodeId,
} from './domain/mindMap';
import type { MindMapLayoutNode, MindMapLayoutResult } from './layout';

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
  canMoveUp: boolean;
  canMoveDown: boolean;
  canPromote: boolean;
  canDemote: boolean;
}

export interface MindMapShortcutInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface MindMapDropPoint {
  x: number;
  y: number;
}

export interface MindMapDropIntentInput {
  draggedNodeId: NodeId;
  point: MindMapDropPoint;
}

export type MindMapInvalidDropReason =
  | 'missing-node'
  | 'root'
  | 'self'
  | 'descendant'
  | 'invalid-index'
  | 'outside'
  | 'no-op';

export type MindMapDropIntent =
  | {
      type: 'move-as-child' | 'reorder-before' | 'reorder-after';
      draggedNodeId: NodeId;
      targetNodeId: NodeId;
      newParentId: NodeId;
      index: number;
    }
  | {
      type: 'invalid';
      draggedNodeId: NodeId;
      reason: MindMapInvalidDropReason;
      targetNodeId?: NodeId;
    };

export type MindMapEditorAction =
  | { type: 'command'; command: MindMapCommand }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'begin-edit'; nodeId: NodeId }
  | { type: 'none' };

interface SiblingContext {
  parentId: NodeId;
  siblingIds: NodeId[];
  index: number;
}

const NODE_REORDER_ZONE_RATIO = 0.28;
const SIBLING_LANE_X_MARGIN = 56;
const SIBLING_LANE_Y_MARGIN = 24;

export function getMindMapCommandAvailability(
  state: MindMapEditorState,
): MindMapCommandAvailability {
  const selectedNode = getSelectedNode(state);
  const isRoot = selectedNode?.id === state.document.rootNodeId;
  const hasChildren = Boolean(selectedNode && selectedNode.childIds.length > 0);
  const siblingContext = selectedNode ? getSiblingContext(state, selectedNode) : null;
  const selectedParent = selectedNode?.parentId
    ? state.document.nodes[selectedNode.parentId]
    : undefined;

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
    canMoveUp: Boolean(siblingContext && siblingContext.index > 0),
    canMoveDown: Boolean(
      siblingContext && siblingContext.index < siblingContext.siblingIds.length - 1,
    ),
    canPromote: Boolean(selectedParent?.parentId),
    canDemote: Boolean(siblingContext && siblingContext.index > 0),
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

  if (!selectedNode) {
    return none();
  }

  if (input.altKey && !systemModifier) {
    return resolveKeyboardMoveShortcut(key, state, selectedNode);
  }

  if (systemModifier || input.altKey) {
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

export function resolveMindMapDropIntent(
  state: MindMapEditorState,
  layout: MindMapLayoutResult,
  input: MindMapDropIntentInput,
): MindMapDropIntent {
  const draggedNode = state.document.nodes[input.draggedNodeId];
  if (!draggedNode) {
    return invalidDropIntent(input.draggedNodeId, 'missing-node');
  }

  if (draggedNode.id === state.document.rootNodeId || !draggedNode.parentId) {
    return invalidDropIntent(input.draggedNodeId, 'root');
  }

  const hitNode = findLayoutNodeAtPoint(layout, input.point);
  if (hitNode) {
    if (hitNode.isRoot) {
      return createChildDropIntent(state, input.draggedNodeId, hitNode);
    }

    const relativeY = input.point.y - hitNode.y;
    if (relativeY <= hitNode.height * NODE_REORDER_ZONE_RATIO) {
      return createSiblingDropIntent(state, input.draggedNodeId, hitNode, 'before');
    }

    if (relativeY >= hitNode.height * (1 - NODE_REORDER_ZONE_RATIO)) {
      return createSiblingDropIntent(state, input.draggedNodeId, hitNode, 'after');
    }

    return createChildDropIntent(state, input.draggedNodeId, hitNode);
  }

  return (
    resolveSiblingLaneDropIntent(state, layout, input.draggedNodeId, input.point) ??
    invalidDropIntent(input.draggedNodeId, 'outside')
  );
}

export function mindMapDropIntentToCommand(
  intent: MindMapDropIntent,
): MindMapCommand | null {
  if (intent.type === 'invalid') {
    return null;
  }

  return {
    type: 'move-subtree',
    nodeId: intent.draggedNodeId,
    newParentId: intent.newParentId,
    index: intent.index,
  };
}

function getSelectedNode(state: MindMapEditorState): MindMapNode | undefined {
  return state.document.nodes[state.selection.selectedNodeId];
}

function resolveKeyboardMoveShortcut(
  key: string,
  state: MindMapEditorState,
  selectedNode: MindMapNode,
): MindMapEditorAction {
  const context = getSiblingContext(state, selectedNode);

  switch (key) {
    case 'arrowup':
      return context && context.index > 0
        ? moveAction(selectedNode.id, context.parentId, context.index - 1)
        : none();
    case 'arrowdown':
      return context && context.index < context.siblingIds.length - 1
        ? moveAction(selectedNode.id, context.parentId, context.index + 1)
        : none();
    case 'arrowleft':
      return promoteAction(state, selectedNode);
    case 'arrowright':
      return context && context.index > 0
        ? moveAction(selectedNode.id, context.siblingIds[context.index - 1])
        : none();
    default:
      return none();
  }
}

function promoteAction(
  state: MindMapEditorState,
  selectedNode: MindMapNode,
): MindMapEditorAction {
  if (!selectedNode.parentId) {
    return none();
  }

  const parent = state.document.nodes[selectedNode.parentId];
  if (!parent?.parentId) {
    return none();
  }

  const grandParent = state.document.nodes[parent.parentId];
  if (!grandParent) {
    return none();
  }

  const parentIndex = grandParent.childIds.indexOf(parent.id);
  return parentIndex >= 0
    ? moveAction(selectedNode.id, grandParent.id, parentIndex + 1)
    : none();
}

function moveAction(
  nodeId: NodeId,
  newParentId: NodeId,
  index?: number,
): MindMapEditorAction {
  return {
    type: 'command',
    command: {
      type: 'move-subtree',
      nodeId,
      newParentId,
      index,
    },
  };
}

function getSiblingContext(
  state: MindMapEditorState,
  node: MindMapNode,
): SiblingContext | null {
  if (!node.parentId) {
    return null;
  }

  const parent = state.document.nodes[node.parentId];
  if (!parent) {
    return null;
  }

  const index = parent.childIds.indexOf(node.id);
  if (index < 0) {
    return null;
  }

  return {
    parentId: parent.id,
    siblingIds: parent.childIds,
    index,
  };
}

function findLayoutNodeAtPoint(
  layout: MindMapLayoutResult,
  point: MindMapDropPoint,
): MindMapLayoutNode | undefined {
  return [...layout.nodes]
    .reverse()
    .find((node) => isPointInsideLayoutNode(point, node));
}

function isPointInsideLayoutNode(
  point: MindMapDropPoint,
  node: MindMapLayoutNode,
): boolean {
  return (
    point.x >= node.x &&
    point.x <= node.x + node.width &&
    point.y >= node.y &&
    point.y <= node.y + node.height
  );
}

function resolveSiblingLaneDropIntent(
  state: MindMapEditorState,
  layout: MindMapLayoutResult,
  draggedNodeId: NodeId,
  point: MindMapDropPoint,
): MindMapDropIntent | null {
  const layoutNodesById = new Map(layout.nodes.map((node) => [node.id, node]));
  let closest:
    | {
        distance: number;
        intent: MindMapDropIntent;
      }
    | null = null;

  for (const parent of Object.values(state.document.nodes)) {
    const visibleChildren = parent.childIds
      .map((childId) => layoutNodesById.get(childId))
      .filter((node): node is MindMapLayoutNode => Boolean(node));

    if (visibleChildren.length === 0) {
      continue;
    }

    const minX = Math.min(...visibleChildren.map((node) => node.x));
    const maxX = Math.max(...visibleChildren.map((node) => node.x + node.width));
    if (point.x < minX - SIBLING_LANE_X_MARGIN || point.x > maxX + SIBLING_LANE_X_MARGIN) {
      continue;
    }

    const first = visibleChildren[0];
    const last = visibleChildren[visibleChildren.length - 1];
    if (
      point.y < first.y - SIBLING_LANE_Y_MARGIN ||
      point.y > last.y + last.height + SIBLING_LANE_Y_MARGIN
    ) {
      continue;
    }

    let insertionIndex = visibleChildren.findIndex(
      (node) => point.y < node.y + node.height / 2,
    );
    if (insertionIndex === -1) {
      insertionIndex = visibleChildren.length;
    }

    const targetNode =
      insertionIndex < visibleChildren.length
        ? visibleChildren[insertionIndex]
        : visibleChildren[visibleChildren.length - 1];
    const position = insertionIndex < visibleChildren.length ? 'before' : 'after';
    const laneY = position === 'before' ? targetNode.y : targetNode.y + targetNode.height;
    const intent = createSiblingDropIntent(state, draggedNodeId, targetNode, position);
    const distance = Math.abs(point.y - laneY);

    if (!closest || distance < closest.distance) {
      closest = { distance, intent };
    }
  }

  return closest?.intent ?? null;
}

function createChildDropIntent(
  state: MindMapEditorState,
  draggedNodeId: NodeId,
  targetNode: MindMapLayoutNode,
): MindMapDropIntent {
  const newParent = state.document.nodes[targetNode.id];
  const index = newParent
    ? newParent.childIds.filter((childId) => childId !== draggedNodeId).length
    : 0;

  return createMoveDropIntent(state, {
    type: 'move-as-child',
    draggedNodeId,
    targetNodeId: targetNode.id,
    newParentId: targetNode.id,
    index,
  });
}

function createSiblingDropIntent(
  state: MindMapEditorState,
  draggedNodeId: NodeId,
  targetNode: MindMapLayoutNode,
  position: 'before' | 'after',
): MindMapDropIntent {
  if (targetNode.id === draggedNodeId) {
    return invalidDropIntent(draggedNodeId, 'self', targetNode.id);
  }

  const targetParentId = targetNode.node.parentId;
  if (!targetParentId) {
    return invalidDropIntent(draggedNodeId, 'root', targetNode.id);
  }

  const parent = state.document.nodes[targetParentId];
  if (!parent) {
    return invalidDropIntent(draggedNodeId, 'missing-node', targetNode.id);
  }

  const childIdsWithoutDragged = parent.childIds.filter((childId) => childId !== draggedNodeId);
  const targetIndex = childIdsWithoutDragged.indexOf(targetNode.id);
  if (targetIndex < 0) {
    return invalidDropIntent(draggedNodeId, 'invalid-index', targetNode.id);
  }

  return createMoveDropIntent(state, {
    type: position === 'before' ? 'reorder-before' : 'reorder-after',
    draggedNodeId,
    targetNodeId: targetNode.id,
    newParentId: parent.id,
    index: position === 'before' ? targetIndex : targetIndex + 1,
  });
}

function createMoveDropIntent(
  state: MindMapEditorState,
  intent: Extract<MindMapDropIntent, { type: 'move-as-child' | 'reorder-before' | 'reorder-after' }>,
): MindMapDropIntent {
  const draggedNode = state.document.nodes[intent.draggedNodeId];
  const newParent = state.document.nodes[intent.newParentId];

  if (!draggedNode || !newParent) {
    return invalidDropIntent(intent.draggedNodeId, 'missing-node', intent.targetNodeId);
  }

  if (intent.newParentId === draggedNode.id) {
    return invalidDropIntent(intent.draggedNodeId, 'self', intent.targetNodeId);
  }

  if (isDescendantOf(state.document, intent.newParentId, draggedNode.id)) {
    return invalidDropIntent(intent.draggedNodeId, 'descendant', intent.targetNodeId);
  }

  const nextSiblingIds = newParent.childIds.filter((childId) => childId !== draggedNode.id);
  if (!Number.isInteger(intent.index) || intent.index < 0 || intent.index > nextSiblingIds.length) {
    return invalidDropIntent(intent.draggedNodeId, 'invalid-index', intent.targetNodeId);
  }

  if (
    draggedNode.parentId === newParent.id &&
    arraysEqual(newParent.childIds, insertAt(nextSiblingIds, draggedNode.id, intent.index))
  ) {
    return invalidDropIntent(intent.draggedNodeId, 'no-op', intent.targetNodeId);
  }

  return intent;
}

function invalidDropIntent(
  draggedNodeId: NodeId,
  reason: MindMapInvalidDropReason,
  targetNodeId?: NodeId,
): MindMapDropIntent {
  return {
    type: 'invalid',
    draggedNodeId,
    reason,
    targetNodeId,
  };
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

function insertAt<T>(items: T[], item: T, index: number): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

function arraysEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function none(): MindMapEditorAction {
  return { type: 'none' };
}
