import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MindMapDocument as EditorMindMapDocument } from '../domain/mindMap';
import type { MarkdownMindMapDocument, MarkdownOrigin } from '../types/markdownLifecycle';
import {
  createEditorDocumentFromMarkdownDocument,
  mergeEditorDocumentIntoMarkdownDocument,
  openMarkdownMindMap,
  parseMarkdownPreview,
  saveMarkdownMindMap,
  serializeMindMap,
} from './markdownLifecycle';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe('markdown lifecycle bindings', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('invokes the camelCase Tauri lifecycle commands with typed request envelopes', async () => {
    invokeMock
      .mockResolvedValueOnce({ status: 'parsed', diagnostics: [] })
      .mockResolvedValueOnce({ status: 'opened', diagnostics: [] })
      .mockResolvedValueOnce({ status: 'serialized', diagnostics: [] })
      .mockResolvedValueOnce({ status: 'saved', diagnostics: [] });

    await parseMarkdownPreview({ markdown: '# Plan' });
    await openMarkdownMindMap({ workspaceId: 'workspace-1', relativePath: 'plan.md' });
    await serializeMindMap({ document: markdownDocument() });
    await saveMarkdownMindMap({
      workspaceId: 'workspace-1',
      relativePath: 'plan.md',
      expectedVersion: {
        modifiedAt: '2026-05-10T00:00:00Z',
        byteSize: 6,
        contentHash: 'hash',
        token: 'token',
      },
      document: markdownDocument(),
      reason: 'manual',
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'parseMarkdownPreview', {
      request: { markdown: '# Plan' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'openMarkdownMindMap', {
      request: { workspaceId: 'workspace-1', relativePath: 'plan.md' },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'serializeMindMap', {
      request: { document: markdownDocument() },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(
      4,
      'saveMarkdownMindMap',
      expect.objectContaining({
        request: expect.objectContaining({
          relativePath: 'plan.md',
          reason: 'manual',
        }),
      }),
    );
  });

  it('creates an editor document with parent links from parsed Markdown hierarchy', () => {
    const editorDocument = createEditorDocumentFromMarkdownDocument(markdownDocument(), {
      createdAt: '2026-05-10T00:00:00Z',
    });

    expect(editorDocument.title).toBe('Plan');
    expect(editorDocument.sourcePath).toBe('plan.md');
    expect(editorDocument.nodes.root.parentId).toBeNull();
    expect(editorDocument.nodes.plan.parentId).toBe('root');
    expect(editorDocument.nodes.step.parentId).toBe('plan');
    expect(editorDocument.nodes.plan.childIds).toEqual(['step']);
  });

  it('merges edited frontend nodes back into the Markdown serializer document', () => {
    const baseDocument = markdownDocument();
    const editorDocument: EditorMindMapDocument = {
      id: 'plan.md',
      title: 'Updated plan',
      sourcePath: 'plan.md',
      rootNodeId: 'root',
      version: 2,
      createdAt: '2026-05-10T00:00:00Z',
      updatedAt: '2026-05-10T00:01:00Z',
      nodes: {
        root: {
          id: 'root',
          text: 'Updated plan',
          parentId: null,
          childIds: ['plan'],
          collapsed: false,
          createdAt: '2026-05-10T00:00:00Z',
          updatedAt: '2026-05-10T00:01:00Z',
        },
        plan: {
          id: 'plan',
          text: 'Renamed plan',
          parentId: 'root',
          childIds: ['step', 'new-node'],
          collapsed: false,
          createdAt: '2026-05-10T00:00:00Z',
          updatedAt: '2026-05-10T00:01:00Z',
        },
        step: {
          id: 'step',
          text: 'Step',
          parentId: 'plan',
          childIds: [],
          collapsed: false,
          createdAt: '2026-05-10T00:00:00Z',
          updatedAt: '2026-05-10T00:00:00Z',
        },
        'new-node': {
          id: 'new-node',
          text: 'New detail',
          parentId: 'plan',
          childIds: [],
          collapsed: false,
          createdAt: '2026-05-10T00:01:00Z',
          updatedAt: '2026-05-10T00:01:00Z',
        },
      },
    };

    const merged = mergeEditorDocumentIntoMarkdownDocument(editorDocument, baseDocument);

    expect(merged.title).toBe('Updated plan');
    expect(merged.nodes.plan.title).toBe('Renamed plan');
    expect(merged.nodes.plan.origin).toBe(baseDocument.nodes.plan.origin);
    expect(merged.nodes['new-node']).toMatchObject({
      title: 'New detail',
      nodeKind: 'heading',
      rawText: '## New detail',
    });
    expect(merged.unmappedBlocks).toBe(baseDocument.unmappedBlocks);
  });
});

function markdownDocument(): MarkdownMindMapDocument {
  const rootOrigin = origin('document_root');
  const headingOrigin = origin('heading', 1);

  return {
    schemaVersion: 'mindmap-document.v1',
    sourcePath: 'plan.md',
    title: 'Plan',
    parseMode: 'auto',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        title: 'Plan',
        rawText: '',
        nodeKind: 'virtual_root',
        children: ['plan'],
        origin: rootOrigin,
        links: [],
        listMarker: null,
      },
      plan: {
        id: 'plan',
        title: 'Plan',
        rawText: '# Plan',
        nodeKind: 'heading',
        children: ['step'],
        origin: headingOrigin,
        links: [],
        listMarker: null,
      },
      step: {
        id: 'step',
        title: 'Step',
        rawText: '## Step',
        nodeKind: 'heading',
        children: [],
        origin: origin('heading', 2),
        links: [],
        listMarker: null,
      },
    },
    unmappedBlocks: [],
    diagnostics: [],
  };
}

function origin(blockKind: MarkdownOrigin['blockKind'], headingLevel: number | null = null): MarkdownOrigin {
  return {
    sourcePath: 'plan.md',
    span: {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    },
    blockKind,
    headingLevel,
    listDepth: null,
  };
}
