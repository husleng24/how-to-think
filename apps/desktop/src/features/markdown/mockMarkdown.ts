import type { MindMapDocument, MindMapNode, NodeId } from '../mindmap/domain/mindMap';

export function createMockMarkdownFromMindMapDocument(document: MindMapDocument): string {
  return serializeNode(document, document.rootNodeId, 1).join('\n').trimEnd();
}

function serializeNode(document: MindMapDocument, nodeId: NodeId, depth: number): string[] {
  const node = document.nodes[nodeId];

  if (!node) {
    return [];
  }

  const currentLine = markdownLineForNode(node, depth);
  const childLines = node.childIds.flatMap((childId) => serializeNode(document, childId, depth + 1));

  if (childLines.length === 0) {
    return [currentLine, ''];
  }

  return [currentLine, '', ...childLines];
}

function markdownLineForNode(node: MindMapNode, depth: number): string {
  const text = node.text.trim() || 'Untitled thought';

  if (depth <= 6) {
    return `${'#'.repeat(depth)} ${text}`;
  }

  return `${'  '.repeat(depth - 7)}- ${text}`;
}
