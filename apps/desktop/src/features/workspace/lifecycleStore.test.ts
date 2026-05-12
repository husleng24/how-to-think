import { describe, expect, it } from 'vitest';

import type { MindMapDocument as EditorMindMapDocument } from '../../domain/mindMap';
import type { GitStatusSummary } from '../git-service';
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
import {
  getWorkspaceDocumentStatus,
  getWorkspaceFileIndexStatus,
  getWorkspaceWatchStatus,
} from './statusModel';
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

  it('refreshes the active Markdown buffer and editor document after a Git restore', () => {
    let state = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('plan.md')]),
    });
    state = workspaceLifecycleReducer(state, {
      type: 'document-opened',
      payload: openedPayload('plan.md'),
    });

    state = workspaceLifecycleReducer(state, {
      type: 'document-restored',
      payload: openedPayload('plan.md', {
        content: '# Restored\n',
        title: 'Restored',
        token: 'restored-token',
        openedAt: '2026-05-10T00:02:00Z',
      }),
      gitStatus: gitStatusSummary('plan.md'),
    });

    expect(state.active?.snapshot.content).toBe('# Restored\n');
    expect(state.active?.snapshot.version.token).toBe('restored-token');
    expect(state.active?.markdownDocument.title).toBe('Restored');
    expect(state.active?.editorDocument.title).toBe('Restored');
    expect(state.active?.contentRevision).toBe(state.active?.savedContentRevision);
    expect(state.saveStatus.message).toBe('Restored from Git history');
    expect(state.gitStatus?.entries[0].relativePath).toBe('plan.md');
  });

  it('updates Git status and typed blocked state from repository refreshes', () => {
    let state = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('plan.md')]),
    });
    const status = gitStatusSummary('plan.md');

    state = workspaceLifecycleReducer(state, {
      type: 'git-status-refreshed',
      status: {
        ...status,
        repositoryState: {
          ...status.repositoryState,
          state: 'merge_conflict',
          blockedReason: 'merge_conflict',
        },
      },
    });

    expect(state.gitStatus?.repositoryState.state).toBe('merge_conflict');
    expect(state.gitBlockedState).toMatchObject({
      kind: 'merge_conflict',
      operation: 'refresh',
    });
  });

  it('updates Git status after a successful snapshot result', () => {
    let state = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('plan.md')]),
    });
    const dirtyStatus = gitStatusSummary('plan.md');
    const cleanStatus: GitStatusSummary = {
      ...dirtyStatus,
      entries: [],
      hasChanges: false,
      changedFileCount: 0,
      counts: {
        added: 0,
        modified: 0,
        deleted: 0,
        renamed: 0,
        untracked: 0,
        ignored: 0,
      },
    };

    state = workspaceLifecycleReducer(state, {
      type: 'git-status-refreshed',
      status: dirtyStatus,
    });
    state = workspaceLifecycleReducer(state, { type: 'operation-started' });
    state = workspaceLifecycleReducer(state, {
      type: 'git-snapshot-created',
      result: {
        workspaceId: 'workspace-1',
        commitOid: 'abcdef1234567890abcdef1234567890abcdef12',
        shortCommitOid: 'abcdef123456',
        parentOids: [],
        message: 'Save plan',
        affectedPaths: ['plan.md'],
        affectedFileCount: 1,
        repositoryState: cleanStatus.repositoryState,
        status: cleanStatus,
        snapshotAt: '2026-05-10T00:03:00Z',
      },
    });

    expect(state.gitStatus?.hasChanges).toBe(false);
    expect(state.gitStatus?.entries).toEqual([]);
    expect(state.isBusy).toBe(false);
  });

  it('coalesces file-level and Git-level external changes into one state update', () => {
    let state = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('plan.md')]),
    });
    state = workspaceLifecycleReducer(state, {
      type: 'document-opened',
      payload: openedPayload('plan.md'),
    });

    state = workspaceLifecycleReducer(state, {
      type: 'external-change-detected',
      batch: {
        workspaceId: 'workspace-1',
        source: 'watcher',
        events: [
          {
            workspaceId: 'workspace-1',
            kind: 'modified',
            relativePath: 'plan.md',
            file: workspaceFile('plan.md', 'external-token'),
            source: 'watcher',
            detectedAt: '2026-05-10T00:03:00Z',
          },
        ],
        files: [workspaceFile('plan.md', 'external-token')],
        repositoryStateChanged: true,
        gitStatus: gitStatusSummary('plan.md', 'external-repo-token'),
        detectedAt: '2026-05-10T00:03:00Z',
        watcherActive: true,
      },
    });

    expect(state.saveStatus.kind).toBe('conflict');
    expect(state.files[0].version.token).toBe('external-token');
    expect(state.gitStatus?.token?.token).toBe('external-repo-token');
    expect(state.gitBlockedState).toBeNull();
    expect(state.externalSyncStatus?.watch.kind).toBe('watching');
    expect(getWorkspaceFileIndexStatus(state)).toMatchObject({
      label: 'Index stale',
      meta: '1 files',
    });
    expect(getWorkspaceWatchStatus(state)).toMatchObject({
      label: 'Watcher active',
    });
    expect(getWorkspaceDocumentStatus(state, false)).toMatchObject({
      label: 'External edit conflict',
    });
  });

  it('models degraded watcher and stale index states without dropping open documents', () => {
    let state = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('plan.md')]),
    });
    state = workspaceLifecycleReducer(state, {
      type: 'document-opened',
      payload: openedPayload('plan.md'),
    });

    state = workspaceLifecycleReducer(state, {
      type: 'external-change-detected',
      batch: {
        workspaceId: 'workspace-1',
        source: 'refresh',
        events: [],
        files: [workspaceFile('plan.md')],
        repositoryStateChanged: false,
        detectedAt: '2026-05-10T00:03:00Z',
        watcherActive: false,
        watchError: {
          code: 'watch_unavailable',
          message: 'Native watcher unavailable.',
          recoverable: true,
          operation: 'watchWorkspace',
        },
      },
    });

    expect(state.active?.snapshot.relativePath).toBe('plan.md');
    expect(state.externalSyncStatus?.watch.kind).toBe('error');
    expect(state.externalSyncStatus?.fileIndex.kind).toBe('degraded');
    expect(getWorkspaceWatchStatus(state)).toMatchObject({
      label: 'Watcher error',
      tone: 'danger',
    });
    expect(getWorkspaceFileIndexStatus(state)).toMatchObject({
      label: 'Index diagnostics',
      tone: 'warning',
    });
  });

  it('maps stale Git operation failures without clearing the active document', () => {
    let state = workspaceLifecycleReducer(initialWorkspaceLifecycleState, {
      type: 'workspace-loaded',
      session: workspaceSession([workspaceFile('plan.md')]),
    });
    state = workspaceLifecycleReducer(state, {
      type: 'document-opened',
      payload: openedPayload('plan.md'),
    });

    state = workspaceLifecycleReducer(state, {
      type: 'operation-failed',
      error: {
        code: 'external_state_changed',
        operation: 'restore',
        message: 'Repository changed.',
        recoverable: true,
        relativePath: 'plan.md',
      },
    });

    expect(state.active?.snapshot.relativePath).toBe('plan.md');
    expect(state.gitBlockedState).toMatchObject({
      kind: 'stale_repository_state',
      operation: 'restore',
    });
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

function openedPayload(
  relativePath: string,
  input: { content?: string; title?: string; token?: string; openedAt?: string } = {},
): OpenedDocumentPayload {
  const content = input.content ?? '# Plan\n';
  const title = input.title ?? 'Plan';

  return {
    result: {
      snapshot: {
        workspaceId: 'workspace-1',
        relativePath,
        content,
        version: fileVersion(input.token ?? 'open-token'),
        openedAt: input.openedAt ?? '2026-05-10T00:00:00Z',
      },
      document: markdownDocument(relativePath, title),
      diagnostics: [],
      files: [workspaceFile(relativePath)],
      linkIndex: {
        workspaceId: 'workspace-1',
        files: [],
        diagnostics: [],
      },
    },
    editorDocument: editorDocument(relativePath, 1, title),
    contentRevision: 1,
  };
}

function workspaceFile(relativePath: string, token = `${relativePath}-token`): WorkspaceFile {
  return {
    relativePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: '.md',
    byteSize: 7,
    modifiedAt: '2026-05-10T00:00:00Z',
    version: fileVersion(token),
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

function gitStatusSummary(relativePath: string, token = 'repo-token'): GitStatusSummary {
  return {
    workspaceId: 'workspace-1',
    repositoryState: {
      workspaceId: 'workspace-1',
      state: 'valid_repository',
      backend: {
        kind: 'system_git',
        version: 'git version 2.52.0',
      },
      selectedRootDisplayPath: 'C:\\Notes',
      repositoryRootDisplayPath: 'C:\\Notes',
      branchName: 'main',
      headOid: 'abc123',
      token: {
        token,
        headOid: 'abc123',
        indexVersion: 3,
        indexChecksum: 'index',
        worktreeStatusGeneration: 'dirty',
        capturedAt: '2026-05-10T00:02:00Z',
      },
      warnings: [],
      checkedAt: '2026-05-10T00:02:00Z',
    },
    token: {
      token,
      headOid: 'abc123',
      indexVersion: 3,
      indexChecksum: 'index',
      worktreeStatusGeneration: 'dirty',
      capturedAt: '2026-05-10T00:02:00Z',
    },
    entries: [
      {
        relativePath,
        staged: 'unmodified',
        unstaged: 'modified',
        conflicted: false,
      },
    ],
    counts: {
      added: 0,
      modified: 1,
      deleted: 0,
      renamed: 0,
      untracked: 0,
      ignored: 0,
    },
    hasChanges: true,
    hasConflicts: false,
    changedFileCount: 1,
    untrackedFileCount: 0,
    refreshedAt: '2026-05-10T00:02:00Z',
  };
}

function editorDocument(
  relativePath: string,
  version: number,
  title = 'Plan',
): EditorMindMapDocument {
  return {
    id: relativePath,
    title,
    sourcePath: relativePath,
    rootNodeId: 'root',
    version,
    createdAt: '2026-05-10T00:00:00Z',
    updatedAt: '2026-05-10T00:00:00Z',
    nodes: {
      root: {
        id: 'root',
        text: title,
        parentId: null,
        childIds: [],
        collapsed: false,
        createdAt: '2026-05-10T00:00:00Z',
        updatedAt: '2026-05-10T00:00:00Z',
      },
    },
  };
}

function markdownDocument(relativePath: string, title = 'Plan'): MarkdownMindMapDocument {
  return {
    schemaVersion: 'mindmap-document.v1',
    sourcePath: relativePath,
    title,
    parseMode: 'auto',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        title,
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
