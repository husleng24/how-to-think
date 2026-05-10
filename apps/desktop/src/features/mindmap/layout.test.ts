import { createEmptyMindMapDocument } from './domain/mindMap';
import { layoutMindMapDocument } from './layout';
import type { MindMapDocument, NodeId } from './domain/mindMap';
import type { MindMapLayoutResult } from './layout';

const fixedDate = new Date('2026-01-02T03:04:05.000Z');

function createDocument(): MindMapDocument {
  return createEmptyMindMapDocument({
    now: fixedDate,
    rootText: 'Root topic',
  });
}

function addNode(
  document: MindMapDocument,
  parentId: NodeId,
  nodeId: NodeId,
  text = nodeId,
  collapsed = false,
): MindMapDocument {
  const timestamp = fixedDate.toISOString();
  const parent = document.nodes[parentId];

  return {
    ...document,
    nodes: {
      ...document.nodes,
      [parentId]: {
        ...parent,
        childIds: [...parent.childIds, nodeId],
      },
      [nodeId]: {
        id: nodeId,
        text,
        parentId,
        childIds: [],
        collapsed,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  };
}

function getLayoutNode(
  layout: MindMapLayoutResult,
  nodeId: NodeId,
): MindMapLayoutResult['nodes'][number] {
  const node = layout.nodes.find((candidate) => candidate.id === nodeId);
  expect(node).toBeDefined();
  return node as MindMapLayoutResult['nodes'][number];
}

function expectFiniteLayout(layout: MindMapLayoutResult): void {
  for (const node of layout.nodes) {
    expect(Number.isFinite(node.x)).toBe(true);
    expect(Number.isFinite(node.y)).toBe(true);
    expect(Number.isFinite(node.width)).toBe(true);
    expect(Number.isFinite(node.height)).toBe(true);
  }

  for (const edge of layout.edges) {
    expect(Number.isFinite(edge.source.x)).toBe(true);
    expect(Number.isFinite(edge.source.y)).toBe(true);
    expect(Number.isFinite(edge.target.x)).toBe(true);
    expect(Number.isFinite(edge.target.y)).toBe(true);
  }

  expect(Number.isFinite(layout.bounds.width)).toBe(true);
  expect(Number.isFinite(layout.bounds.height)).toBe(true);
}

function expectNoSameDepthOverlap(layout: MindMapLayoutResult): void {
  const byDepth = new Map<number, typeof layout.nodes>();

  for (const node of layout.nodes) {
    byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), node]);
  }

  for (const nodes of byDepth.values()) {
    const sorted = [...nodes].sort((left, right) => left.y - right.y);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      expect(current.y).toBeGreaterThanOrEqual(previous.y + previous.height);
    }
  }
}

describe('mind map layout', () => {
  it('places a balanced tree with deterministic hierarchy and edges', () => {
    let document = createDocument();
    document = addNode(document, 'root', 'a', 'Alpha');
    document = addNode(document, 'root', 'b', 'Beta');
    document = addNode(document, 'a', 'a-1', 'Alpha one');
    document = addNode(document, 'a', 'a-2', 'Alpha two');
    document = addNode(document, 'b', 'b-1', 'Beta one');

    const layout = layoutMindMapDocument(document);
    const root = getLayoutNode(layout, 'root');
    const alpha = getLayoutNode(layout, 'a');
    const alphaChild = getLayoutNode(layout, 'a-1');

    expect(layout.visibleNodeIds).toEqual(['root', 'a', 'a-1', 'a-2', 'b', 'b-1']);
    expect(layout.edges.map((edge) => edge.id)).toEqual([
      'a->a-1',
      'a->a-2',
      'root->a',
      'b->b-1',
      'root->b',
    ]);
    expect(alpha.x).toBeGreaterThan(root.x);
    expect(alphaChild.x).toBeGreaterThan(alpha.x);
    expect(root.depth).toBe(0);
    expect(alpha.depth).toBe(1);
    expect(alphaChild.depth).toBe(2);
    expectFiniteLayout(layout);
    expectNoSameDepthOverlap(layout);
  });

  it('omits collapsed descendants without deleting them from the document', () => {
    let document = createDocument();
    document = addNode(document, 'root', 'a', 'Alpha', true);
    document = addNode(document, 'root', 'b', 'Beta');
    document = addNode(document, 'a', 'a-1', 'Alpha child');
    document = addNode(document, 'a', 'a-2', 'Alpha second child');
    document = addNode(document, 'a-2', 'a-2-1', 'Hidden grandchild');

    const layout = layoutMindMapDocument(document);
    const alpha = getLayoutNode(layout, 'a');

    expect(layout.visibleNodeIds).toEqual(['root', 'a', 'b']);
    expect(layout.visibleNodeIds).not.toContain('a-1');
    expect(layout.edges.map((edge) => edge.id)).toEqual(['root->a', 'root->b']);
    expect(alpha?.hasHiddenChildren).toBe(true);
    expect(alpha?.hiddenDescendantCount).toBe(3);
    expect(document.nodes['a-2-1']).toBeDefined();

    const expanded = layoutMindMapDocument({
      ...document,
      nodes: {
        ...document.nodes,
        a: {
          ...document.nodes.a,
          collapsed: false,
        },
      },
    });
    expect(expanded.visibleNodeIds).toContain('a-2-1');
  });

  it('keeps deep trees finite and ordered left-to-right', () => {
    let document = createDocument();
    let parentId: NodeId = 'root';

    for (let index = 0; index < 30; index += 1) {
      const nodeId = `deep-${index}`;
      document = addNode(document, parentId, nodeId, `Deep ${index}`);
      parentId = nodeId;
    }

    const layout = layoutMindMapDocument(document);

    expect(layout.visibleNodeIds).toHaveLength(31);
    expectFiniteLayout(layout);
    for (let index = 1; index < layout.nodes.length; index += 1) {
      expect(layout.nodes[index].x).toBeGreaterThan(layout.nodes[index - 1].x);
    }
  });

  it('bounds long text nodes so sibling branches do not overlap', () => {
    let document = createDocument();
    const longText = 'A long thought with enough detail to wrap across several visual lines. '.repeat(8);
    document = addNode(document, 'root', 'long-a', longText);
    document = addNode(document, 'root', 'long-b', longText);

    const layout = layoutMindMapDocument(document);
    const first = getLayoutNode(layout, 'long-a');
    const second = getLayoutNode(layout, 'long-b');

    expect(first?.width).toBe(236);
    expect(first?.height).toBeLessThanOrEqual(136);
    expect(second?.y).toBeGreaterThanOrEqual((first?.y ?? 0) + (first?.height ?? 0));
    expectNoSameDepthOverlap(layout);
  });

  it('lays out a generated 500-node map without blank output or runaway coordinates', () => {
    let document = createDocument();
    const queue: NodeId[] = ['root'];
    let nextNodeNumber = 1;

    while (nextNodeNumber < 500) {
      const parentId = queue.shift();
      if (!parentId) {
        break;
      }

      for (let childIndex = 0; childIndex < 4 && nextNodeNumber < 500; childIndex += 1) {
        const nodeId = `node-${nextNodeNumber}`;
        document = addNode(document, parentId, nodeId, `Generated node ${nextNodeNumber}`);
        queue.push(nodeId);
        nextNodeNumber += 1;
      }
    }

    const layout = layoutMindMapDocument(document);

    expect(layout.nodes).toHaveLength(500);
    expect(layout.edges).toHaveLength(499);
    expect(layout.bounds.width).toBeGreaterThan(0);
    expect(layout.bounds.height).toBeGreaterThan(0);
    expect(layout.bounds.width).toBeLessThan(5000);
    expect(layout.bounds.height).toBeLessThan(70000);
    expectFiniteLayout(layout);
    expectNoSameDepthOverlap(layout);
  });
});
