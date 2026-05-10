import { invoke } from '@tauri-apps/api/core';

import type {
  MindMapDocument as EditorMindMapDocument,
  MindMapNode as EditorMindMapNode,
  NodeId,
} from '../domain/mindMap';
import type {
  MarkdownMindMapDocument,
  MarkdownMindMapNode,
  MarkdownOrigin,
  OpenMarkdownMindMapRequest,
  OpenMarkdownMindMapResult,
  ParseMarkdownPreviewRequest,
  ParseMarkdownPreviewResult,
  SaveMarkdownMindMapRequest,
  SaveMarkdownMindMapResult,
  SerializeMindMapRequest,
  SerializeMindMapResult,
  WorkspaceRelativePath,
} from '../types/markdownLifecycle';

export interface CreateEditorDocumentFromMarkdownOptions {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function parseMarkdownPreview(
  request: ParseMarkdownPreviewRequest,
): Promise<ParseMarkdownPreviewResult> {
  return invoke<ParseMarkdownPreviewResult>('parseMarkdownPreview', { request });
}

export function openMarkdownMindMap(
  request: OpenMarkdownMindMapRequest,
): Promise<OpenMarkdownMindMapResult> {
  return invoke<OpenMarkdownMindMapResult>('openMarkdownMindMap', { request });
}

export function serializeMindMap(request: SerializeMindMapRequest): Promise<SerializeMindMapResult> {
  return invoke<SerializeMindMapResult>('serializeMindMap', { request });
}

export function saveMarkdownMindMap(
  request: SaveMarkdownMindMapRequest,
): Promise<SaveMarkdownMindMapResult> {
  return invoke<SaveMarkdownMindMapResult>('saveMarkdownMindMap', { request });
}

export function createEditorDocumentFromMarkdownDocument(
  document: MarkdownMindMapDocument,
  options: CreateEditorDocumentFromMarkdownOptions = {},
): EditorMindMapDocument {
  const timestamp = options.updatedAt ?? options.createdAt ?? new Date().toISOString();
  const parents = parentIdsByChild(document);
  const nodes = Object.fromEntries(
    Object.entries(document.nodes).map(([nodeId, node]) => [
      nodeId,
      {
        id: node.id,
        text: node.title,
        parentId: parents.get(nodeId) ?? null,
        childIds: [...node.children],
        collapsed: false,
        createdAt: options.createdAt ?? timestamp,
        updatedAt: timestamp,
      } satisfies EditorMindMapNode,
    ]),
  );

  return {
    id: options.id ?? document.sourcePath ?? document.rootNodeId,
    title: document.title,
    sourcePath: document.sourcePath,
    rootNodeId: document.rootNodeId,
    version: 1,
    nodes,
    createdAt: options.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

export function mergeEditorDocumentIntoMarkdownDocument(
  editorDocument: EditorMindMapDocument,
  baseDocument: MarkdownMindMapDocument,
): MarkdownMindMapDocument {
  const nodes: Record<NodeId, MarkdownMindMapNode> = {};

  for (const editorNode of Object.values(editorDocument.nodes)) {
    const baseNode = baseDocument.nodes[editorNode.id];
    nodes[editorNode.id] = {
      id: editorNode.id,
      title: editorNode.text,
      rawText: baseNode?.rawText ?? rawTextForEditorNode(editorDocument, editorNode),
      nodeKind: baseNode?.nodeKind ?? nodeKindForEditorNode(editorDocument, editorNode),
      children: [...editorNode.childIds],
      origin:
        baseNode?.origin ??
        syntheticOrigin(editorDocument.sourcePath ?? baseDocument.sourcePath, editorDocument, editorNode),
      links: baseNode?.links ?? [],
      listMarker: baseNode?.listMarker ?? null,
    };
  }

  return {
    ...baseDocument,
    sourcePath: editorDocument.sourcePath ?? baseDocument.sourcePath,
    title: editorDocument.title,
    rootNodeId: editorDocument.rootNodeId,
    nodes,
  };
}

function parentIdsByChild(document: MarkdownMindMapDocument): Map<NodeId, NodeId> {
  const parents = new Map<NodeId, NodeId>();

  for (const node of Object.values(document.nodes)) {
    for (const childId of node.children) {
      parents.set(childId, node.id);
    }
  }

  return parents;
}

function nodeKindForEditorNode(
  document: EditorMindMapDocument,
  node: EditorMindMapNode,
): MarkdownMindMapNode['nodeKind'] {
  return node.id === document.rootNodeId || node.parentId === null ? 'virtual_root' : 'heading';
}

function rawTextForEditorNode(document: EditorMindMapDocument, node: EditorMindMapNode): string {
  if (node.id === document.rootNodeId || node.parentId === null) {
    return '';
  }

  return `${'#'.repeat(Math.min(nodeDepth(document, node.id), 6))} ${node.text}`;
}

function syntheticOrigin(
  sourcePath: WorkspaceRelativePath | null,
  document: EditorMindMapDocument,
  node: EditorMindMapNode,
): MarkdownOrigin {
  const isRoot = node.id === document.rootNodeId || node.parentId === null;

  return {
    sourcePath,
    span: {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    },
    blockKind: isRoot ? 'document_root' : 'heading',
    headingLevel: isRoot ? null : Math.min(nodeDepth(document, node.id), 6),
    listDepth: null,
  };
}

function nodeDepth(document: EditorMindMapDocument, nodeId: NodeId): number {
  let depth = 0;
  let current = document.nodes[nodeId];

  while (current?.parentId) {
    depth += 1;
    current = document.nodes[current.parentId];
  }

  return Math.max(depth, 1);
}
