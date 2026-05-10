import { createEmptyMindMapDocument } from './domain/mindMap';
import type { MindMapDocument, MindMapNode, NodeId } from './domain/mindMap';
import type { MindMapLayoutNode, MindMapLayoutResult } from './layout';

export type MindMapFixtureKind =
  | 'balanced'
  | 'deep'
  | 'wide'
  | 'long-text'
  | 'empty-text'
  | 'collapsed'
  | 'large-500';

export interface MindMapFixtureOptions {
  now?: Date;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface FitViewportOptions extends ViewportSize {
  contentPadding?: number;
  viewportMargin?: number;
  minZoom?: number;
  maxZoom?: number;
}

export interface FitViewportResult {
  x: number;
  y: number;
  zoom: number;
}

export interface LayoutOverlap {
  first: MindMapLayoutNode;
  second: MindMapLayoutNode;
}

const DEFAULT_FIXTURE_DATE = new Date('2026-01-02T03:04:05.000Z');
const DEFAULT_CONTENT_PADDING = 160;
const DEFAULT_VIEWPORT_MARGIN = 72;
const DEFAULT_MIN_ZOOM = 0.35;
const DEFAULT_MAX_ZOOM = 1.25;

export function createMindMapFixtureDocument(
  kind: MindMapFixtureKind,
  options: MindMapFixtureOptions = {},
): MindMapDocument {
  switch (kind) {
    case 'balanced':
      return createBalancedMindMapFixture(options);
    case 'deep':
      return createDeepMindMapFixture(options);
    case 'wide':
      return createWideMindMapFixture(options);
    case 'long-text':
      return createLongTextMindMapFixture(options);
    case 'empty-text':
      return createEmptyTextMindMapFixture(options);
    case 'collapsed':
      return createCollapsedMindMapFixture(options);
    case 'large-500':
      return createLargeMindMapFixture(options);
  }
}

export function findMindMapLayoutOverlaps(
  layout: MindMapLayoutResult,
): LayoutOverlap[] {
  const overlaps: LayoutOverlap[] = [];
  const nodesByDepth = new Map<number, MindMapLayoutNode[]>();

  for (const node of layout.nodes) {
    nodesByDepth.set(node.depth, [...(nodesByDepth.get(node.depth) ?? []), node]);
  }

  for (const depthNodes of nodesByDepth.values()) {
    const sorted = [...depthNodes].sort((left, right) => left.y - right.y);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];

      if (current.y < previous.y + previous.height) {
        overlaps.push({ first: previous, second: current });
      }
    }
  }

  return overlaps;
}

export function calculateMindMapFitViewport(
  layout: MindMapLayoutResult,
  options: FitViewportOptions,
): FitViewportResult {
  const contentPadding = options.contentPadding ?? DEFAULT_CONTENT_PADDING;
  const viewportMargin = options.viewportMargin ?? DEFAULT_VIEWPORT_MARGIN;
  const minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
  const maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM;
  const contentWidth = Math.max(1, layout.bounds.width + contentPadding * 2);
  const contentHeight = Math.max(1, layout.bounds.height + contentPadding * 2);
  const availableWidth = Math.max(1, options.width - viewportMargin * 2);
  const availableHeight = Math.max(1, options.height - viewportMargin * 2);
  const zoom = clamp(
    Math.min(maxZoom, availableWidth / contentWidth, availableHeight / contentHeight),
    minZoom,
    maxZoom,
  );

  return {
    x: (options.width - contentWidth * zoom) / 2,
    y: (options.height - contentHeight * zoom) / 2,
    zoom,
  };
}

export function getNodeViewportFrame(
  node: MindMapLayoutNode,
  viewport: FitViewportResult,
  contentPadding = DEFAULT_CONTENT_PADDING,
): { left: number; top: number; right: number; bottom: number } {
  const left = (node.x + contentPadding) * viewport.zoom + viewport.x;
  const top = (node.y + contentPadding) * viewport.zoom + viewport.y;

  return {
    left,
    top,
    right: left + node.width * viewport.zoom,
    bottom: top + node.height * viewport.zoom,
  };
}

export function isNodeInViewport(
  node: MindMapLayoutNode,
  viewport: FitViewportResult,
  size: ViewportSize,
  contentPadding = DEFAULT_CONTENT_PADDING,
): boolean {
  const frame = getNodeViewportFrame(node, viewport, contentPadding);

  return (
    frame.left >= 0 &&
    frame.top >= 0 &&
    frame.right <= size.width &&
    frame.bottom <= size.height
  );
}

function createBalancedMindMapFixture(options: MindMapFixtureOptions): MindMapDocument {
  const builder = createFixtureBuilder(options, 'Balanced editing map');

  builder.addNode('root', 'planning', 'Planning');
  builder.addNode('root', 'execution', 'Execution');
  builder.addNode('root', 'review', 'Review');
  builder.addNode('planning', 'goals', 'Goals');
  builder.addNode('planning', 'risks', 'Risks');
  builder.addNode('execution', 'draft', 'Draft');
  builder.addNode('execution', 'iterate', 'Iterate');
  builder.addNode('review', 'retro', 'Retrospective');

  return builder.document;
}

function createDeepMindMapFixture(options: MindMapFixtureOptions): MindMapDocument {
  const builder = createFixtureBuilder(options, 'Deep editing map');
  let parentId: NodeId = 'root';

  for (let index = 1; index <= 36; index += 1) {
    const nodeId = `deep-${index}`;
    builder.addNode(parentId, nodeId, `Deep level ${index}`);
    parentId = nodeId;
  }

  return builder.document;
}

function createWideMindMapFixture(options: MindMapFixtureOptions): MindMapDocument {
  const builder = createFixtureBuilder(options, 'Wide editing map');

  for (let index = 1; index <= 40; index += 1) {
    builder.addNode('root', `wide-${index}`, `Wide branch ${index}`);
  }

  return builder.document;
}

function createLongTextMindMapFixture(options: MindMapFixtureOptions): MindMapDocument {
  const builder = createFixtureBuilder(options, 'Long text editing map');
  const longText = 'Long thought with enough context to wrap across several visual lines. '.repeat(10);

  builder.addNode('root', 'long-a', longText);
  builder.addNode('root', 'long-b', `${longText}Adjacent branch text must stay readable.`);
  builder.addNode('long-a', 'long-a-detail', `${longText}Nested detail.`);

  return builder.document;
}

function createEmptyTextMindMapFixture(options: MindMapFixtureOptions): MindMapDocument {
  const builder = createFixtureBuilder(options, 'Empty text editing map');

  builder.addNode('root', 'empty-a', '');
  builder.addNode('root', 'empty-b', 'Named sibling');
  builder.addNode('empty-a', 'empty-child', '');

  return builder.document;
}

function createCollapsedMindMapFixture(options: MindMapFixtureOptions): MindMapDocument {
  const builder = createFixtureBuilder(options, 'Collapsed branch editing map');

  builder.addNode('root', 'visible-a', 'Visible branch', true);
  builder.addNode('root', 'visible-b', 'Visible sibling');
  builder.addNode('visible-a', 'hidden-a', 'Hidden child');
  builder.addNode('hidden-a', 'hidden-b', 'Hidden grandchild');
  builder.addNode('hidden-b', 'hidden-c', 'Hidden great grandchild');

  return builder.document;
}

function createLargeMindMapFixture(options: MindMapFixtureOptions): MindMapDocument {
  const builder = createFixtureBuilder(options, 'Large 500-node editing map');
  const queue: NodeId[] = ['root'];
  let nextNodeNumber = 1;

  while (nextNodeNumber < 500) {
    const parentId = queue.shift();
    if (!parentId) {
      break;
    }

    for (let childIndex = 0; childIndex < 4 && nextNodeNumber < 500; childIndex += 1) {
      const nodeId = `node-${nextNodeNumber}`;
      builder.addNode(parentId, nodeId, `Generated node ${nextNodeNumber}`);
      queue.push(nodeId);
      nextNodeNumber += 1;
    }
  }

  return builder.document;
}

function createFixtureBuilder(options: MindMapFixtureOptions, title: string) {
  const now = options.now ?? DEFAULT_FIXTURE_DATE;
  const document = createEmptyMindMapDocument({
    now,
    rootText: title,
    title,
  });
  const timestamp = now.toISOString();

  return {
    document,
    addNode(parentId: NodeId, nodeId: NodeId, text: string, collapsed = false): void {
      const parent = document.nodes[parentId];

      if (!parent) {
        throw new Error(`Fixture parent does not exist: ${parentId}`);
      }

      const node: MindMapNode = {
        id: nodeId,
        text,
        parentId,
        childIds: [],
        collapsed,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      document.nodes[parentId] = {
        ...parent,
        childIds: [...parent.childIds, nodeId],
        updatedAt: timestamp,
      };
      document.nodes[nodeId] = node;
      document.version += 1;
      document.updatedAt = timestamp;
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
