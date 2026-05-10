import { createEmptyMindMapDocument, getMindMapNode } from './mindMap';

describe('createEmptyMindMapDocument', () => {
  it('bootstraps an unsaved document with a selected root node', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const document = createEmptyMindMapDocument(now);
    const root = getMindMapNode(document, document.rootNodeId);

    expect(document.title).toBe('Untitled map');
    expect(document.sourcePath).toBeNull();
    expect(document.selectedNodeId).toBe(document.rootNodeId);
    expect(root.title).toBe('Untitled thought');
    expect(root.note).toBe('Start from a Markdown heading or outline branch.');
    expect(root.children).toEqual([]);
    expect(document.createdAt).toBe(now.toISOString());
    expect(document.updatedAt).toBe(now.toISOString());
  });
});
