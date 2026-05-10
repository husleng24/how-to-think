export interface MindMapNode {
  id: string;
  title: string;
  note: string;
  children: string[];
}

export interface MindMapDocument {
  id: string;
  title: string;
  sourcePath: string | null;
  rootNodeId: string;
  selectedNodeId: string;
  nodes: Record<string, MindMapNode>;
  createdAt: string;
  updatedAt: string;
}

const ROOT_NODE_ID = 'root';

export function createEmptyMindMapDocument(now = new Date()): MindMapDocument {
  const timestamp = now.toISOString();

  return {
    id: 'draft',
    title: 'Untitled map',
    sourcePath: null,
    rootNodeId: ROOT_NODE_ID,
    selectedNodeId: ROOT_NODE_ID,
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: {
      [ROOT_NODE_ID]: {
        id: ROOT_NODE_ID,
        title: 'Untitled thought',
        note: 'Start from a Markdown heading or outline branch.',
        children: [],
      },
    },
  };
}

export function getMindMapNode(document: MindMapDocument, nodeId: string): MindMapNode {
  const node = document.nodes[nodeId];

  if (!node) {
    throw new Error(`Mind map node not found: ${nodeId}`);
  }

  return node;
}

export function listChildNodes(document: MindMapDocument, nodeId: string): MindMapNode[] {
  return getMindMapNode(document, nodeId).children.map((childId) =>
    getMindMapNode(document, childId),
  );
}
