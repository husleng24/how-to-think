import {
  createMindMapFixtureDocument,
  calculateMindMapFitViewport,
  findMindMapLayoutOverlaps,
  isNodeInViewport,
  type MindMapFixtureKind,
} from './testFixtures';
import { getMindMapLayoutNode, layoutMindMapDocument } from './layout';
import { validateMindMapDocument } from './domain/mindMap';

const fixtureKinds: MindMapFixtureKind[] = [
  'balanced',
  'deep',
  'wide',
  'long-text',
  'empty-text',
  'collapsed',
  'large-500',
];

describe('mind map regression fixtures', () => {
  it.each(fixtureKinds)('generates a valid %s fixture document', (kind) => {
    const document = createMindMapFixtureDocument(kind);

    expect(validateMindMapDocument(document)).toEqual({ ok: true, errors: [] });
    expect(document.nodes[document.rootNodeId]).toBeDefined();
    expect(Object.keys(document.nodes).length).toBeGreaterThan(0);
  });

  it('creates the expected deep, wide, empty, collapsed, and 500-node fixture shapes', () => {
    const deep = createMindMapFixtureDocument('deep');
    const wide = createMindMapFixtureDocument('wide');
    const empty = createMindMapFixtureDocument('empty-text');
    const collapsed = createMindMapFixtureDocument('collapsed');
    const large = createMindMapFixtureDocument('large-500');
    const collapsedLayout = layoutMindMapDocument(collapsed);
    const collapsedBranch = getMindMapLayoutNode(collapsedLayout, 'visible-a');

    expect(Object.keys(deep.nodes)).toHaveLength(37);
    expect(deep.nodes['deep-36'].parentId).toBe('deep-35');
    expect(wide.nodes.root.childIds).toHaveLength(40);
    expect(empty.nodes['empty-a'].text).toBe('');
    expect(empty.nodes['empty-child'].text).toBe('');
    expect(collapsed.nodes['visible-a'].collapsed).toBe(true);
    expect(collapsedLayout.visibleNodeIds).toEqual(['root', 'visible-a', 'visible-b']);
    expect(collapsedBranch?.hiddenDescendantCount).toBe(3);
    expect(Object.keys(large.nodes)).toHaveLength(500);
  });

  it('reports no same-depth layout overlap for representative readability fixtures', () => {
    const representativeKinds: MindMapFixtureKind[] = [
      'balanced',
      'wide',
      'long-text',
      'empty-text',
      'collapsed',
      'large-500',
    ];

    for (const kind of representativeKinds) {
      const layout = layoutMindMapDocument(createMindMapFixtureDocument(kind));
      expect(findMindMapLayoutOverlaps(layout)).toEqual([]);
    }
  });

  it('keeps important balanced fixture nodes in bounds after fit-to-content', () => {
    const viewportSize = { width: 1280, height: 720 };
    const layout = layoutMindMapDocument(createMindMapFixtureDocument('balanced'));
    const viewport = calculateMindMapFitViewport(layout, viewportSize);

    for (const nodeId of ['root', 'planning', 'goals', 'execution', 'retro']) {
      const node = getMindMapLayoutNode(layout, nodeId);

      expect(node).toBeDefined();
      expect(node ? isNodeInViewport(node, viewport, viewportSize) : false).toBe(true);
    }
  });
});
