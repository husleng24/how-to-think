import { describe, expect, it } from 'vitest';

import type { MindMapDocument as EditorMindMapDocument } from '../../domain/mindMap';
import type {
  FileVersion,
  MarkdownMindMapDocument,
  SaveMarkdownMindMapResult,
  WorkspaceFile,
} from '../../types/markdownLifecycle';
import {
  createSaveRequest,
  createUnsavedPrompt,
  hasUnsavedChanges,
  initialWorkspaceLifecycleState,
  shouldPromptForAction,
  workspaceLifecycleReducer,
} from './lifecycleStore';
import type { OpenedDocumentPayload, WorkspaceSession } from './types';

describe('workspace lifecycle store', () => {
  it('loads a workspace and opens a Markdown document as a saved active file', () => {
    const loaded = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('z.md'), workspaceFile('a.md')]),
    });

    expect(loaded.startupStatus).toBe('ready');
    expect(loaded.files.map((file) => file.relativePath)).toEqual(['a.md', 'z.md']);

    const opened = workspaceLifecycleReducer(loaded, {
      type: 'document-opened',
      payload: openedPayload('a.md'),
    });

    expect(opened.active?.snapshot.relativePath).toBe('a.md');
    expect(opened.active?.savedContentRevision).toBe(1);
    expect(opened.saveStatus.kind).toBe('saved');
    expect(opened.recentFiles).toEqual(['a.md']);
  });

  it('keeps newer edits dirty when an earlier autosave finishes', () => {
    let state = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('plan.md')]),
    });
    state = workspaceLifecycleReducer(state, {
      type: 'document-opened',
      payload: openedPayload('plan.md'),
    });

    const active = state.active;
    expect(active).not.toBeNull();

    state = workspaceLifecycleReducer(state, {
      type: 'document-edited',
      documentKey: active!.key,
      editorDocument: editorDocument('plan.md', 2),
      contentRevision: 2,
    });
    const request = createSaveRequest(state.active!, 'autosave');
    state = workspaceLifecycleReducer(state, { type: 'save-started', request });
    state = workspaceLifecycleReducer(state, {
      type: 'document-edited',
      documentKey: active!.key,
      editorDocument: editorDocument('plan.md', 3),
      contentRevision: 3,
    });
    state = workspaceLifecycleReducer(state, {
      type: 'save-succeeded',
      payload: {
        request,
        result: savedResult('plan.md'),
        markdownDocument: markdownDocument('plan.md'),
        editorDocument: editorDocument('plan.md', 3),
        currentContentRevision: 3,
      },
    });

    expect(state.active?.savedContentRevision).toBe(2);
    expect(state.active?.contentRevision).toBe(3);
    expect(state.active?.snapshot.version.token).toBe('saved-token');
    expect(state.saveStatus.kind).toBe('unsaved');
  });

  it('maps save failures to conflict and missing states without clearing dirty content', () => {
    let state = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('plan.md')]),
    });
    state = workspaceLifecycleReducer(state, {
      type: 'document-opened',
      payload: openedPayload('plan.md'),
    });
    state = workspaceLifecycleReducer(state, {
      type: 'document-edited',
      documentKey: state.active!.key,
      editorDocument: editorDocument('plan.md', 2),
      contentRevision: 2,
    });

    const conflictRequest = createSaveRequest(state.active!, 'manual');
    state = workspaceLifecycleReducer(state, {
      type: 'save-failed',
      request: conflictRequest,
      error: {
        code: 'version_conflict',
        message: 'Changed on disk at C:\\secret\\plan.md',
        recoverable: true,
        operation: 'saveFile',
        relativePath: 'plan.md',
      },
    });

    expect(state.saveStatus.kind).toBe('conflict');
    expect(state.active?.contentRevision).toBe(2);
    expect(state.lastError?.detail).not.toContain('C:\\secret');

    const missingRequest = createSaveRequest(state.active!, 'manual');
    state = workspaceLifecycleReducer(state, {
      type: 'save-failed',
      request: missingRequest,
      error: {
        code: 'file_not_found',
        message: 'missing',
        recoverable: true,
        operation: 'saveFile',
        relativePath: 'plan.md',
      },
    });

    expect(state.saveStatus.kind).toBe('missing');
  });

  it('creates Save, Discard, Cancel prompts for dirty switches and disables Save while saving', () => {
    let state = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('plan.md'), workspaceFile('other.md')]),
    });
    state = workspaceLifecycleReducer(state, {
      type: 'document-opened',
      payload: openedPayload('plan.md'),
    });
    state = workspaceLifecycleReducer(state, {
      type: 'document-edited',
      documentKey: state.active!.key,
      editorDocument: editorDocument('plan.md', 2),
      contentRevision: 2,
    });

    expect(hasUnsavedChanges(state)).toBe(true);
    expect(shouldPromptForAction(state, { type: 'open-file', relativePath: 'other.md' })).toBe(true);
    expect(
      createUnsavedPrompt(state, { type: 'open-file', relativePath: 'other.md' }),
    ).toMatchObject({
      title: 'Unsaved changes',
      saveDisabled: false,
    });

    const request = createSaveRequest(state.active!, 'autosave');
    state = workspaceLifecycleReducer(state, { type: 'save-started', request });

    expect(
      createUnsavedPrompt(state, { type: 'open-file', relativePath: 'other.md' }).saveDisabled,
    ).toBe(true);
  });
});

function workspaceSession(files: WorkspaceFile[]): WorkspaceSession {
  return {
    workspace: {
      id: 'workspace-1',
      displayName: 'Notes',
      displayPath: 'C:\\Notes',
      platform: 'windows',
      caseSensitive: false,
      writable: true,
      lastOpenedAt: '2026-05-10T00:00:00Z',
    },
    files,
    lastOpenedFile: null,
  };
}

function openedPayload(relativePath: string): OpenedDocumentPayload {
  return {
    result: {
      snapshot: {
        workspaceId: 'workspace-1',
        relativePath,
        content: '# Plan\n',
        version: fileVersion('open-token'),
        openedAt: '2026-05-10T00:00:00Z',
      },
      document: markdownDocument(relativePath),
      diagnostics: [],
      files: [workspaceFile(relativePath)],
      linkIndex: {
        workspaceId: 'workspace-1',
        files: [],
        diagnostics: [],
      },
    },
    editorDocument: editorDocument(relativePath, 1),
    contentRevision: 1,
  };
}

function workspaceFile(relativePath: string): WorkspaceFile {
  return {
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: '.md',
    byteSize: 7,
    modifiedAt: '2026-05-10T00:00:00Z',
    version: fileVersion(`${relativePath}-token`),
  };
}

function fileVersion(token: string): FileVersion {
  return {
    modifiedAt: '2026-05-10T00:00:00Z',
    byteSize: 7,
    contentHash: `${token}-hash`,
    token,
  };
}

function savedResult(relativePath: string): SaveMarkdownMindMapResult & {
  save: NonNullable<SaveMarkdownMindMapResult['save']>;
} {
  return {
    status: 'saved',
    diagnostics: [],
    metadata: {
      schemaVersion: 'mindmap-document.v1',
      sourcePath: relativePath,
      targetPath: relativePath,
      saveMode: 'canonical_headings',
      preservationPolicy: 'block_lossy',
      lineEnding: 'lf',
      canonicalized: true,
      nodeCount: 1,
      unmappedBlockCount: 0,
    },
    markdown: '# Plan\n',
    save: {
      workspaceId: 'workspace-1',
      relativePath,
      version: fileVersion('saved-token'),
      savedAt: '2026-05-10T00:01:00Z',
      byteSize: 7,
    },
    files: [workspaceFile(relativePath)],
    linkIndex: {
      workspaceId: 'workspace-1',
      files: [],
      diagnostics: [],
    },
  };
}

function editorDocument(relativePath: string, version: number): EditorMindMapDocument {
  return {
    id: relativePath,
    title: 'Plan',
    sourcePath: relativePath,
    rootNodeId: 'root',
    version,
    createdAt: '2026-05-10T00:00:00Z',
    updatedAt: '2026-05-10T00:00:00Z',
    nodes: {
      root: {
        id: 'root',
        text: 'Plan',
        parentId: null,
        childIds: [],
        collapsed: false,
        createdAt: '2026-05-10T00:00:00Z',
        updatedAt: '2026-05-10T00:00:00Z',
      },
    },
  };
}

function markdownDocument(relativePath: string): MarkdownMindMapDocument {
  return {
    schemaVersion: 'mindmap-document.v1',
    sourcePath: relativePath,
    title: 'Plan',
    parseMode: 'auto',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        title: 'Plan',
        rawText: '',
        nodeKind: 'virtual_root',
        children: [],
        origin: {
          sourcePath: relativePath,
          span: {
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1,
          },
          blockKind: 'document_root',
          headingLevel: null,
          listDepth: null,
        },
        links: [],
        listMarker: null,
      },
    },
    unmappedBlocks: [],
    diagnostics: [],
  };
}
