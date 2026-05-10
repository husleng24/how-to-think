import type { MindMapDocument, MindMapNode, NodeId } from './domain/mindMap';

export interface MindMapLayoutOptions {
  rootNodeWidth?: number;
  nodeWidth?: number;
  rootMinHeight?: number;
  nodeMinHeight?: number;
  maxNodeHeight?: number;
  horizontalGap?: number;
  siblingGap?: number;
}

export interface MindMapLayoutNode {
  id: NodeId;
  node: MindMapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  subtreeHeight: number;
  childCount: number;
  hiddenDescendantCount: number;
  isRoot: boolean;
  hasHiddenChildren: boolean;
}

export interface MindMapLayoutEdge {
  id: string;
  sourceId: NodeId;
  targetId: NodeId;
  source: { x: number; y: number };
  target: { x: number; y: number };
}

export interface MindMapLayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface MindMapLayoutResult {
  nodes: MindMapLayoutNode[];
  edges: MindMapLayoutEdge[];
  visibleNodeIds: NodeId[];
  bounds: MindMapLayoutBounds;
}

interface LayoutTreeNode {
  source: MindMapNode;
  children: LayoutTreeNode[];
  depth: number;
  width: number;
  height: number;
  subtreeHeight: number;
  hiddenDescendantCount: number;
}

const DEFAULT_OPTIONS: Required<MindMapLayoutOptions> = {
  rootNodeWidth: 292,
  nodeWidth: 236,
  rootMinHeight: 104,
  nodeMinHeight: 76,
  maxNodeHeight: 136,
  horizontalGap: 172,
  siblingGap: 28,
};

const NODE_VERTICAL_PADDING = 34;
const LINE_HEIGHT = 20;
const ROOT_CHARS_PER_LINE = 28;
const NODE_CHARS_PER_LINE = 30;

export function layoutMindMapDocument(
  document: MindMapDocument,
  options: MindMapLayoutOptions = {},
): MindMapLayoutResult {
  const layoutOptions = { ...DEFAULT_OPTIONS, ...options };
  const root = document.nodes[document.rootNodeId];

  if (!root) {
    return emptyLayout();
  }

  const tree = buildLayoutTree(document, root, 0, layoutOptions);
  assignSubtreeHeights(tree, layoutOptions);

  const nodes: MindMapLayoutNode[] = [];
  const edges: MindMapLayoutEdge[] = [];
  placeTree(tree, 0, layoutOptions, nodes, edges);

  const bounds = calculateBounds(nodes);

  return {
    nodes,
    edges,
    visibleNodeIds: nodes.map((node) => node.id),
    bounds,
  };
}

export function getMindMapLayoutNode(
  layout: MindMapLayoutResult,
  nodeId: NodeId,
): MindMapLayoutNode | undefined {
  return layout.nodes.find((node) => node.id === nodeId);
}

function buildLayoutTree(
  document: MindMapDocument,
  node: MindMapNode,
  depth: number,
  options: Required<MindMapLayoutOptions>,
): LayoutTreeNode {
  const width = depth === 0 ? options.rootNodeWidth : options.nodeWidth;
  const height = estimateNodeHeight(node, depth === 0, options);
  const children = node.collapsed
    ? []
    : node.childIds
        .map((childId) => document.nodes[childId])
        .filter((child): child is MindMapNode => Boolean(child))
        .map((child) => buildLayoutTree(document, child, depth + 1, options));

  return {
    source: node,
    children,
    depth,
    width,
    height,
    subtreeHeight: height,
    hiddenDescendantCount: node.collapsed ? countDescendants(document, node.id) : 0,
  };
}

function assignSubtreeHeights(
  tree: LayoutTreeNode,
  options: Required<MindMapLayoutOptions>,
): number {
  if (tree.children.length === 0) {
    tree.subtreeHeight = tree.height;
    return tree.subtreeHeight;
  }

  const childHeight = tree.children.reduce(
    (sum, child) => sum + assignSubtreeHeights(child, options),
    0,
  );
  const childGap = Math.max(0, tree.children.length - 1) * options.siblingGap;

  tree.subtreeHeight = Math.max(tree.height, childHeight + childGap);
  return tree.subtreeHeight;
}

function placeTree(
  tree: LayoutTreeNode,
  subtreeTop: number,
  options: Required<MindMapLayoutOptions>,
  nodes: MindMapLayoutNode[],
  edges: MindMapLayoutEdge[],
): MindMapLayoutNode {
  const x =
    tree.depth === 0
      ? 0
      : options.rootNodeWidth +
        options.horizontalGap +
        (tree.depth - 1) * (options.nodeWidth + options.horizontalGap);
  const y = subtreeTop + tree.subtreeHeight / 2 - tree.height / 2;

  const renderNode: MindMapLayoutNode = {
    id: tree.source.id,
    node: tree.source,
    x,
    y,
    width: tree.width,
    height: tree.height,
    depth: tree.depth,
    subtreeHeight: tree.subtreeHeight,
    childCount: tree.source.childIds.length,
    hiddenDescendantCount: tree.hiddenDescendantCount,
    isRoot: tree.depth === 0,
    hasHiddenChildren: tree.hiddenDescendantCount > 0,
  };
  nodes.push(renderNode);

  const totalChildHeight =
    tree.children.reduce((sum, child) => sum + child.subtreeHeight, 0) +
    Math.max(0, tree.children.length - 1) * options.siblingGap;
  let childTop = subtreeTop + (tree.subtreeHeight - totalChildHeight) / 2;

  for (const child of tree.children) {
    const childNode = placeTree(child, childTop, options, nodes, edges);
    edges.push({
      id: `${tree.source.id}->${child.source.id}`,
      sourceId: tree.source.id,
      targetId: child.source.id,
      source: {
        x: renderNode.x + renderNode.width,
        y: renderNode.y + renderNode.height / 2,
      },
      target: {
        x: childNode.x,
        y: childNode.y + childNode.height / 2,
      },
    });
    childTop += child.subtreeHeight + options.siblingGap;
  }

  return renderNode;
}

function estimateNodeHeight(
  node: MindMapNode,
  isRoot: boolean,
  options: Required<MindMapLayoutOptions>,
): number {
  const text = node.text.trim();
  const normalizedLength = text.length === 0 ? 14 : text.length;
  const charsPerLine = isRoot ? ROOT_CHARS_PER_LINE : NODE_CHARS_PER_LINE;
  const estimatedLines = Math.max(1, Math.ceil(normalizedLength / charsPerLine));
  const unclampedHeight = NODE_VERTICAL_PADDING + estimatedLines * LINE_HEIGHT;
  const minHeight = isRoot ? options.rootMinHeight : options.nodeMinHeight;

  return Math.min(options.maxNodeHeight, Math.max(minHeight, unclampedHeight));
}

function countDescendants(document: MindMapDocument, nodeId: NodeId): number {
  const node = document.nodes[nodeId];
  if (!node) {
    return 0;
  }

  let count = 0;
  const stack = [...node.childIds];

  while (stack.length > 0) {
    const currentId = stack.pop() as NodeId;
    const current = document.nodes[currentId];

    if (!current) {
      continue;
    }

    count += 1;
    stack.push(...current.childIds);
  }

  return count;
}

function calculateBounds(nodes: MindMapLayoutNode[]): MindMapLayoutBounds {
  if (nodes.length === 0) {
    return emptyBounds();
  }

  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function emptyLayout(): MindMapLayoutResult {
  return {
    nodes: [],
    edges: [],
    visibleNodeIds: [],
    bounds: emptyBounds(),
  };
}

function emptyBounds(): MindMapLayoutBounds {
  return {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    width: 0,
    height: 0,
  };
}
