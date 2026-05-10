import { describe, expect, it, vi } from 'vitest';

import { createMindMapEditorState, type MindMapDocument, type MindMapEditorState } from '../../../domain/mindMap';
import type {
  CompatibilityDiagnostic,
  FileVersion,
  MarkdownMindMapDocument,
  MarkdownOrigin,
  SaveMarkdownMindMapResult,
  SerializeMindMapResult,
} from '../../../types/markdownLifecycle';
import {
  createCurrentFileProposalFixture,
  createProposalFixtureDocument,
  createProposalReviewEditorSnapshot,
  proposalFixtureCreatedAt,
  proposalFixtureFileVersion,
} from '../fixtures/proposalFixtures';
import type { AiChangeProposal } from '../index';
import { createProposalReviewStore } from './proposalReviewStore';
import {
  applyActiveProposalReview,
  applyAiProposal,
  undoAiProposalApply,
  type ApplyProposalActiveState,
  type ApplyProposalSerializeInput,
} from './applyProposal';

describe('applyAiProposal', () => {
  it('applies a valid current-file proposal to editor and Markdown state in one transaction', async () => {
    const active = createActiveApplyState();
    const serializeMarkdown = vi.fn((input: ApplyProposalSerializeInput) => serialized(input.document));

    const result = await applyAiProposal({
      proposal: createCurrentFileProposalFixture(),
      active,
      serializeMarkdown,
      now: fixedNow(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.state.editorState.document.nodes.gamma).toMatchObject({
      id: 'gamma',
      text: 'Gamma',
      parentId: 'root',
      childIds: [],
    });
    expect(result.state.markdownBuffer).toContain('## Gamma');
    expect(result.state.markdownDocument.nodes.gamma).toMatchObject({
      id: 'gamma',
      title: 'Gamma',
      children: [],
    });
    expect(result.state.editorState.history.undoStack).toHaveLength(1);
    expect(result.state.editorState.history.redoStack).toHaveLength(0);
    expect(result.state.proposalHistory?.undoStack).toHaveLength(1);
    expect(result.transaction.label).toBe('Apply AI proposal');
    expect(result.state.editorState.contentRevision).toBe(active.editorState.contentRevision + 1);
    expect(result.state.editorState.isDirty).toBe(true);
    expect(result.state.saveStatus.kind).toBe('unsaved');
    expect(serializeMarkdown).toHaveBeenCalledTimes(1);
  });

  it('commits multiple proposal operations as a single undoable editor transaction', async () => {
    const active = createActiveApplyState();
    const proposal: AiChangeProposal = {
      ...createCurrentFileProposalFixture(),
      operations: [
        {
          type: 'update-node',
          operationId: 'op-update-alpha',
          targetFilePath: 'notes/root.md',
          nodeId: 'alpha',
          text: 'Alpha revised',
        },
        {
          type: 'add-node',
          operationId: 'op-add-gamma',
          targetFilePath: 'notes/root.md',
          parentNodeId: 'root',
          nodeId: 'gamma',
          text: 'Gamma',
        },
      ],
    };

    const result = await applyAiProposal({
      proposal,
      active,
      serializeMarkdown: (input) => serialized(input.document),
      now: fixedNow(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.editorState.document.nodes.alpha.text).toBe('Alpha revised');
    expect(result.state.editorState.document.nodes.gamma.text).toBe('Gamma');
    expect(result.state.editorState.history.undoStack).toHaveLength(1);
    expect(result.state.editorState.contentRevision).toBe(8);
    expect(result.state.editorState.document.version).toBe(8);
  });

  it('rejects stale document or file versions without mutating state or history', async () => {
    const active = createActiveApplyState();
    const staleDocument = createActiveApplyState({
      editorState: withDocumentVersion(active.editorState, 8),
    });
    const staleFile = createActiveApplyState({
      fileVersion: {
        ...proposalFixtureFileVersion,
        token: 'version:notes/root.md:8',
      },
    });
    const serializeMarkdown = vi.fn((input: ApplyProposalSerializeInput) => serialized(input.document));

    const documentResult = await applyAiProposal({
      proposal: createCurrentFileProposalFixture(),
      active: staleDocument,
      serializeMarkdown,
    });
    const fileResult = await applyAiProposal({
      proposal: createCurrentFileProposalFixture(),
      active: staleFile,
      serializeMarkdown,
    });

    expect(documentResult.ok).toBe(false);
    expect(fileResult.ok).toBe(false);
    if (!documentResult.ok) {
      expect(documentResult.error.code).toBe('stale_document_version');
      expect(documentResult.state).toBe(staleDocument);
      expect(documentResult.state.editorState.history.undoStack).toHaveLength(0);
    }
    if (!fileResult.ok) {
      expect(fileResult.error.code).toBe('stale_file_version');
      expect(fileResult.state).toBe(staleFile);
      expect(fileResult.state.markdownBuffer).toBe(staleFile.markdownBuffer);
    }
    expect(serializeMarkdown).not.toHaveBeenCalled();
  });

  it('fails invalid post-apply tree operations before commit', async () => {
    const active = createActiveApplyState();
    const proposal: AiChangeProposal = {
      ...createCurrentFileProposalFixture(),
      operations: [
        {
          type: 'move-branch',
          operationId: 'op-move-alpha',
          targetFilePath: 'notes/root.md',
          nodeId: 'alpha',
          newParentNodeId: 'alpha-child',
        },
      ],
    };

    const result = await applyAiProposal({
      proposal,
      active,
      serializeMarkdown: (input) => serialized(input.document),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('operation_failed');
      expect(result.error.commandError?.code).toBe('cannot_move_into_descendant');
      expect(result.state.editorState.document).toBe(active.editorState.document);
      expect(result.state.editorState.history.undoStack).toHaveLength(0);
    }
  });

  it('fails Markdown serialization before commit and preserves the original state', async () => {
    const active = createActiveApplyState();

    const result = await applyAiProposal({
      proposal: createCurrentFileProposalFixture(),
      active,
      serializeMarkdown: () => serializationError('serializer_panic'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('markdown_serialization_failed');
      expect(result.state).toBe(active);
      expect(result.state.markdownBuffer).toBe(active.markdownBuffer);
      expect(result.state.editorState.history.undoStack).toHaveLength(0);
    }
  });

  it('surfaces conditional save conflicts without committing prepared changes', async () => {
    const active = createActiveApplyState();
    const conditionalSave = vi.fn(async () => {
      throw {
        code: 'version_conflict',
        message: 'File changed on disk.',
        recoverable: true,
        relativePath: 'notes/root.md',
        operation: 'saveFile',
      };
    });

    const result = await applyAiProposal({
      proposal: createCurrentFileProposalFixture(),
      active,
      serializeMarkdown: (input) => serialized(input.document),
      conditionalSave,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('save_conflict');
      expect(result.state).toBe(active);
      expect(result.state.editorState.document.nodes.gamma).toBeUndefined();
      expect(result.state.editorState.history.undoStack).toHaveLength(0);
    }
    expect(conditionalSave).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: proposalFixtureFileVersion,
        relativePath: 'notes/root.md',
      }),
    );
  });

  it('marks apply clean and advances the file version when conditional save succeeds', async () => {
    const active = createActiveApplyState();
    const savedAt = '2026-05-10T00:02:00.000Z';
    const savedVersion = {
      token: 'version:notes/root.md:8',
      modifiedAt: savedAt,
      byteSize: 72,
      contentHash: 'saved-hash',
    };

    const result = await applyAiProposal({
      proposal: createCurrentFileProposalFixture(),
      active,
      serializeMarkdown: (input) => serialized(input.document),
      conditionalSave: () =>
        savedResult({
          markdown: '# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta\n\n## Gamma\n',
          savedAt,
          version: savedVersion,
        }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.state.fileVersion).toEqual(savedVersion);
    expect(result.state.editorState.isDirty).toBe(false);
    expect(result.state.editorState.savedContentRevision).toBe(result.state.editorState.contentRevision);
    expect(result.state.saveStatus).toMatchObject({
      kind: 'saved',
      savedAt,
    });
  });

  it('undo restores pre-apply document, Markdown buffer, selection, dirty state, and save status', async () => {
    const active = createActiveApplyState({
      editorState: {
        ...createActiveApplyState().editorState,
        savedContentRevision: 6,
        isDirty: true,
      },
      saveStatus: {
        kind: 'unsaved',
        message: 'Unsaved changes in notes/root.md',
      },
    });
    const before = active.editorState;

    const applyResult = await applyAiProposal({
      proposal: createCurrentFileProposalFixture(),
      active,
      serializeMarkdown: (input) => serialized(input.document),
    });

    expect(applyResult.ok).toBe(true);
    if (!applyResult.ok) {
      return;
    }

    const undoResult = undoAiProposalApply(applyResult.state);
    expect(undoResult.ok).toBe(true);
    if (!undoResult.ok) {
      return;
    }

    expect(undoResult.state.editorState.document).toEqual(before.document);
    expect(undoResult.state.markdownDocument).toEqual(active.markdownDocument);
    expect(undoResult.state.markdownBuffer).toBe(active.markdownBuffer);
    expect(undoResult.state.editorState.selection).toEqual(before.selection);
    expect(undoResult.state.editorState.document.nodes.alpha.collapsed).toBe(true);
    expect(undoResult.state.editorState.isDirty).toBe(true);
    expect(undoResult.state.saveStatus).toEqual(active.saveStatus);
    expect(undoResult.state.proposalHistory?.redoStack).toHaveLength(1);
  });

  it('accepts a current-file review through the review controller bridge', async () => {
    const active = createActiveApplyState();
    const store = createProposalReviewStore();
    const proposal = createCurrentFileProposalFixture();
    store.receiveProposal(
      proposal,
      createProposalReviewEditorSnapshot({
        document: active.editorState.document,
        undoHistory: active.editorState.history,
        selection: active.editorState.selection,
        markdownBuffer: active.markdownBuffer,
        fileVersion: active.fileVersion,
        fileVersions: {
          'notes/root.md': active.fileVersion,
        },
        documentVersion: active.editorState.document.version,
      }),
    );

    const result = await applyActiveProposalReview({
      store,
      active,
      serializeMarkdown: (input) => serialized(input.document),
    });

    expect(result.applyResult.ok).toBe(true);
    expect(store.getState().activeReview?.status).toBe('applied');
    if (result.applyResult.ok) {
      expect(result.applyResult.state.editorState.document.nodes.gamma.text).toBe('Gamma');
      expect(result.applyResult.state.markdownBuffer).toContain('## Gamma');
      expect(result.applyResult.state.saveStatus.kind).toBe('unsaved');
    }
  });
});

function createActiveApplyState(overrides: Partial<ApplyProposalActiveState> = {}): ApplyProposalActiveState {
  const document = editorDocument();
  const editorState = createMindMapEditorState({
    document,
    selection: {
      selectedNodeId: 'alpha',
      focusedNodeId: 'alpha',
    },
  });

  return {
    workspaceId: 'workspace-1',
    activeFilePath: 'notes/root.md',
    fileVersion: proposalFixtureFileVersion,
    editorState,
    markdownDocument: markdownDocument(),
    markdownBuffer: '# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta\n',
    saveStatus: {
      kind: 'saved',
      message: 'Saved',
      savedAt: proposalFixtureCreatedAt,
    },
    ...overrides,
  };
}

function editorDocument(): MindMapDocument {
  const fixture = createProposalFixtureDocument();
  const timestamp = proposalFixtureCreatedAt;

  return {
    id: fixture.id,
    title: 'Root',
    sourcePath: 'notes/root.md',
    rootNodeId: fixture.rootNodeId,
    version: fixture.version,
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: Object.fromEntries(
      Object.entries(fixture.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          id: node.id,
          text: node.text,
          parentId: node.parentId,
          childIds: [...node.childIds],
          collapsed: node.id === 'alpha',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    ),
  };
}

function markdownDocument(): MarkdownMindMapDocument {
  const sourcePath = 'notes/root.md';
  const rootOrigin = origin('document_root', null, sourcePath);

  return {
    schemaVersion: 'mindmap-document.v1',
    sourcePath,
    title: 'Root',
    parseMode: 'auto',
    rootNodeId: 'root',
    nodes: {
      root: markdownNode('root', 'Root', ['alpha', 'beta'], rootOrigin, 'virtual_root'),
      alpha: markdownNode('alpha', 'Alpha', ['alpha-child'], origin('heading', 1, sourcePath)),
      'alpha-child': markdownNode('alpha-child', 'Alpha child', [], origin('heading', 2, sourcePath)),
      beta: markdownNode('beta', 'Beta', [], origin('heading', 1, sourcePath)),
    },
    unmappedBlocks: [],
    diagnostics: [],
  };
}

function markdownNode(
  id: string,
  title: string,
  children: string[],
  nodeOrigin: MarkdownOrigin,
  nodeKind: MarkdownMindMapDocument['nodes'][string]['nodeKind'] = 'heading',
): MarkdownMindMapDocument['nodes'][string] {
  return {
    id,
    title,
    rawText: nodeKind === 'virtual_root' ? '' : `${'#'.repeat(nodeOrigin.headingLevel ?? 1)} ${title}`,
    nodeKind,
    children,
    origin: nodeOrigin,
    links: [],
    listMarker: null,
  };
}

function origin(
  blockKind: MarkdownOrigin['blockKind'],
  headingLevel: number | null,
  sourcePath: string,
): MarkdownOrigin {
  return {
    sourcePath,
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

function fixedNow(): Date {
  return new Date('2026-05-10T00:01:00.000Z');
}

function withDocumentVersion(editorState: MindMapEditorState, version: number): MindMapEditorState {
  return {
    ...editorState,
    document: {
      ...editorState.document,
      version,
    },
    contentRevision: version,
    savedContentRevision: version,
  };
}

function serialized(document: MarkdownMindMapDocument): SerializeMindMapResult {
  return {
    status: 'serialized',
    markdown: renderMarkdown(document),
    diagnostics: [],
    metadata: {
      schemaVersion: 'markdown-serializer.v1',
      sourcePath: document.sourcePath,
      targetPath: document.sourcePath,
      saveMode: 'canonical_headings',
      preservationPolicy: 'block_lossy',
      lineEnding: 'lf',
      canonicalized: false,
      nodeCount: Object.keys(document.nodes).length - 1,
      unmappedBlockCount: 0,
    },
  };
}

function serializationError(code: string): SerializeMindMapResult {
  const diagnostic = diagnosticError(code);
  return {
    status: 'serializationError',
    diagnostics: [diagnostic],
    metadata: {
      schemaVersion: 'markdown-serializer.v1',
      sourcePath: 'notes/root.md',
      targetPath: 'notes/root.md',
      saveMode: 'canonical_headings',
      preservationPolicy: 'block_lossy',
      lineEnding: 'lf',
      canonicalized: false,
      nodeCount: 0,
      unmappedBlockCount: 0,
    },
  };
}

function savedResult(input: {
  markdown: string;
  savedAt: string;
  version: FileVersion;
}): SaveMarkdownMindMapResult {
  return {
    status: 'saved',
    markdown: input.markdown,
    diagnostics: [],
    metadata: {
      schemaVersion: 'markdown-serializer.v1',
      sourcePath: 'notes/root.md',
      targetPath: 'notes/root.md',
      saveMode: 'canonical_headings',
      preservationPolicy: 'block_lossy',
      lineEnding: 'lf',
      canonicalized: false,
      nodeCount: 4,
      unmappedBlockCount: 0,
    },
    save: {
      workspaceId: 'workspace-1',
      relativePath: 'notes/root.md',
      version: input.version,
      savedAt: input.savedAt,
      byteSize: input.version.byteSize,
    },
  };
}

function diagnosticError(code: string): CompatibilityDiagnostic {
  return {
    code,
    severity: 'error',
    message: code,
    origin: null,
    nodeId: null,
  };
}

function renderMarkdown(document: MarkdownMindMapDocument): string {
  const lines: string[] = [];

  const visit = (nodeId: string, depth: number): void => {
    const node = document.nodes[nodeId];
    if (!node) {
      return;
    }

    if (nodeId !== document.rootNodeId) {
      lines.push(`${'#'.repeat(depth)} ${node.title}`);
    }

    for (const childId of node.children) {
      visit(childId, nodeId === document.rootNodeId ? 2 : depth + 1);
    }
  };

  visit(document.rootNodeId, 1);
  return `# ${document.title}\n\n${lines.join('\n\n')}\n`;
}
