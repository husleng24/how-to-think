import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GitWorkflowPanel } from './GitWorkflowPanel';
import type {
  GitDiffResult,
  GitHistoryEntry,
  GitOperationError,
  GitRepositoryState,
  GitRepositoryStateToken,
  GitRestoreResult,
  GitSnapshotResult,
  GitStatusSummary,
} from '../git-service';
import type {
  WorkspaceLifecycleActions,
  WorkspaceLifecycleState,
} from '../workspace';
import type {
  DocumentSnapshot,
  FileVersion,
  LinkIndexSnapshot,
  MarkdownMindMapDocument,
  WorkspaceFile,
} from '../../types/markdownLifecycle';
import type { MindMapDocument as EditorMindMapDocument } from '../../domain/mindMap';

describe('GitWorkflowPanel history workflow', () => {
  it('enables local Git from an explicit confirmation when the workspace is not a repository', async () => {
    const enableGit = vi.fn().mockResolvedValue(true);
    const actions = workspaceActions({ enableGit });

    render(
      <GitWorkflowPanel
        workspaceState={workspaceState({ repositoryState: 'not_repository' })}
        workspaceActions={actions}
      />,
    );

    expect(screen.getByText('Git is off for this workspace')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^enable git$/i }));

    const dialog = await screen.findByRole('dialog', { name: /enable git/i });
    expect(within(dialog).getByText(/existing file contents will not be changed/i)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: /confirm enable git/i }));

    await waitFor(() => expect(enableGit).toHaveBeenCalledTimes(1));
  });

  it('creates a local snapshot from eligible Markdown changes and ignores ignored files', async () => {
    const result = snapshotResult();
    const createGitSnapshot = vi.fn().mockResolvedValue({ ok: true, result });
    const actions = workspaceActions({ createGitSnapshot });

    render(
      <GitWorkflowPanel
        workspaceState={workspaceState({
          entries: [
            {
              relativePath: 'notes/plan.md',
              staged: 'unmodified',
              unstaged: 'modified',
              conflicted: false,
            },
            {
              relativePath: 'notes/new.md',
              staged: 'untracked',
              unstaged: 'untracked',
              conflicted: false,
            },
            {
              relativePath: 'notes/ignored.md',
              staged: 'ignored',
              unstaged: 'ignored',
              conflicted: false,
            },
          ],
        })}
        workspaceActions={actions}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create snapshot/i }));
    const dialog = await screen.findByRole('dialog', { name: /create git snapshot/i });
    expect(within(dialog).getByText('2 affected files')).toBeVisible();
    expect(within(dialog).queryByText('notes/ignored.md')).toBeNull();

    fireEvent.change(within(dialog).getByLabelText(/snapshot message/i), {
      target: { value: 'Save local changes' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /confirm snapshot/i }));

    await waitFor(() => expect(createGitSnapshot).toHaveBeenCalledWith('Save local changes'));
    expect(await screen.findAllByText('Snapshot def456abc123 created')).toHaveLength(2);
    expect(screen.getAllByText('Save local changes')).toHaveLength(2);
  });

  it('loads file history and renders structured text, binary, and truncated diffs', async () => {
    const actions = workspaceActions({
      listGitHistory: vi.fn().mockResolvedValue(historyEntries()),
      getGitDiff: vi.fn().mockResolvedValue(diffResult({ truncated: true, binary: true })),
    });

    render(<GitWorkflowPanel workspaceState={workspaceState()} workspaceActions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: /view history/i }));

    expect(await screen.findByText('Save initial plan')).toBeVisible();
    expect(screen.getByText('abc123def456')).toBeVisible();
    expect(screen.getByText('Test User')).toBeVisible();
    expect(screen.getByText('2 affected files')).toBeVisible();
    expect(await screen.findByText('Diff truncated')).toBeVisible();
    expect(screen.getByText('Binary file changed. Text restore preview is unavailable.')).toBeVisible();
    expect(screen.getByText('File diff truncated.')).toBeVisible();
    expect(screen.getByText('old thought')).toBeVisible();
    expect(screen.getByText('new thought')).toBeVisible();
    expect(actions.listGitHistory).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      relativePath: 'notes/plan.md',
      maxEntries: 100,
    });
    expect(actions.getGitDiff).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      mode: 'working_tree',
      relativePath: 'notes/plan.md',
      baseRef: historyEntries()[0].commitOid,
      headRef: null,
    });
  });

  it('requires restore confirmation and calls lifecycle restore with the captured repository token', async () => {
    const restoreActiveFromGit = vi.fn().mockResolvedValue({
      ok: true,
      result: restoreResult(),
    });
    const actions = workspaceActions({
      listGitHistory: vi.fn().mockResolvedValue(historyEntries()),
      getGitDiff: vi.fn().mockResolvedValue(diffResult()),
      restoreActiveFromGit,
    });

    render(<GitWorkflowPanel workspaceState={workspaceState()} workspaceActions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: /view history/i }));
    await screen.findByText('Save initial plan');
    fireEvent.click(await screen.findByRole('button', { name: /restore/i }));

    const dialog = await screen.findByRole('dialog', { name: /restore from git history/i });
    expect(within(dialog).getByText(/new uncommitted workspace change/i)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: /confirm restore/i }));

    await waitFor(() =>
      expect(restoreActiveFromGit).toHaveBeenCalledWith({
        sourceRef: historyEntries()[0].commitOid,
        expectedRepoToken: gitToken(),
      }),
    );
  });

  it('shows dirty-state restore guidance while still routing confirmed restore through the lifecycle guard', async () => {
    const restoreActiveFromGit = vi.fn().mockResolvedValue({ ok: false, pendingPrompt: true });
    const actions = workspaceActions({
      listGitHistory: vi.fn().mockResolvedValue(historyEntries()),
      getGitDiff: vi.fn().mockResolvedValue(diffResult()),
      restoreActiveFromGit,
    });

    render(
      <GitWorkflowPanel
        workspaceState={workspaceState({ dirty: true })}
        workspaceActions={actions}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /view history/i }));
    await screen.findByText('Save initial plan');
    expect(screen.getByText('Save or discard unsaved editor changes before restoring from history.')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: /restore/i }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: /restore from git history/i }))
      .getByRole('button', { name: /confirm restore/i }));

    await waitFor(() => expect(restoreActiveFromGit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Resolve unsaved changes to continue restore.')).toBeVisible();
  });

  it('renders restore stale-state failures returned by the lifecycle guard', async () => {
    const restoreActiveFromGit = vi.fn().mockResolvedValue({
      ok: false,
      error: gitError(
        'external_state_changed',
        'The repository changed after the restore view was loaded.',
        'restore',
      ),
    });
    const actions = workspaceActions({
      listGitHistory: vi.fn().mockResolvedValue(historyEntries()),
      getGitDiff: vi.fn().mockResolvedValue(diffResult()),
      restoreActiveFromGit,
    });

    render(<GitWorkflowPanel workspaceState={workspaceState()} workspaceActions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: /view history/i }));
    await screen.findByText('Save initial plan');
    fireEvent.click(await screen.findByRole('button', { name: /restore/i }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: /restore from git history/i }))
        .getByRole('button', { name: /confirm restore/i }),
    );

    await waitFor(() => expect(restoreActiveFromGit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Git state changed')).toBeVisible();
    expect(screen.getByText('The repository changed after the restore view was loaded.')).toBeVisible();
  });

  it('renders typed diff errors from invalid refs', async () => {
    const actions = workspaceActions({
      listGitHistory: vi.fn().mockResolvedValue(historyEntries()),
      getGitDiff: vi.fn().mockRejectedValue(gitError('invalid_ref', 'The selected revision no longer exists.')),
    });

    render(<GitWorkflowPanel workspaceState={workspaceState()} workspaceActions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: /view history/i }));

    expect(await screen.findByText('Revision not found')).toBeVisible();
    expect(screen.getByText('The selected revision no longer exists.')).toBeVisible();
  });
});

function workspaceActions(
  overrides: Partial<WorkspaceLifecycleActions> = {},
): WorkspaceLifecycleActions {
  return {
    openWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
    refreshFiles: vi.fn(),
    refreshGitState: vi.fn(),
    enableGit: vi.fn().mockResolvedValue(true),
    createGitSnapshot: vi.fn(),
    listGitHistory: vi.fn().mockResolvedValue([]),
    getGitDiff: vi.fn(),
    requestCreateFile: vi.fn(),
    requestOpenFile: vi.fn(),
    requestRenameActive: vi.fn(),
    requestDeleteActive: vi.fn(),
    requestCloseActive: vi.fn(),
    restoreActiveFromGit: vi.fn(),
    continuePromptAfterSave: vi.fn(),
    discardPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    clearError: vi.fn(),
    recordEditorChange: vi.fn(),
    saveActive: vi.fn(),
    ...overrides,
  };
}

function workspaceState(
  input: {
    dirty?: boolean;
    repositoryState?: GitRepositoryState['state'];
    statusToken?: string;
    entries?: GitStatusSummary['entries'];
  } = {},
): WorkspaceLifecycleState {
  const active = activeDocumentState(input.dirty ?? false);
  const status = gitStatusSummary({
    repositoryState: input.repositoryState,
    token: input.statusToken,
    entries: input.entries,
  });

  return {
    startupStatus: 'ready',
    workspace: {
      id: 'workspace-1',
      displayName: 'Notes',
      displayPath: 'C:\\Notes',
      platform: 'windows',
      caseSensitive: false,
      writable: true,
      lastOpenedAt: '2026-05-10T00:00:00Z',
    },
    files: [workspaceFile('notes/plan.md')],
    active,
    recentFiles: ['notes/plan.md'],
    saveStatus: input.dirty
      ? { kind: 'unsaved', message: 'Unsaved changes in notes/plan.md' }
      : { kind: 'saved', message: 'Saved' },
    gitStatus: status,
    gitBlockedState: null,
    prompt: null,
    lastError: null,
    isBusy: false,
  };
}

function activeDocumentState(dirty: boolean): WorkspaceLifecycleState['active'] {
  const snapshot = documentSnapshot('notes/plan.md');
  const markdownDocument = markdownDocumentFor('notes/plan.md');
  const editorDocument = editorDocumentFor('notes/plan.md', dirty ? 2 : 1);

  return {
    key: 'notes/plan.md:2026-05-10T00:00:00Z',
    snapshot,
    markdownDocument,
    editorDocument,
    linkIndex: linkIndex(),
    savedContentRevision: 1,
    contentRevision: dirty ? 2 : 1,
    inFlightSave: null,
  };
}

function historyEntries(): GitHistoryEntry[] {
  return [
    {
      commitOid: 'abc123def4567890abc123def4567890abc123de',
      shortCommitOid: 'abc123def456',
      parentOids: ['1111111111111111111111111111111111111111'],
      authorName: 'Test User',
      authorEmail: 'test@example.invalid',
      authoredAt: '2026-05-10T00:00:00Z',
      subject: 'Save initial plan',
      touchedPaths: ['notes/plan.md', 'notes/assets.png'],
      affectedFileCount: 2,
    },
  ];
}

function diffResult(input: { truncated?: boolean; binary?: boolean } = {}): GitDiffResult {
  return {
    workspaceId: 'workspace-1',
    mode: 'working_tree',
    relativePath: 'notes/plan.md',
    baseRef: historyEntries()[0].commitOid,
    headRef: null,
    files: [
      {
        relativePath: 'notes/plan.md',
        change: 'modified',
        contentKind: 'text',
        isBinary: false,
        additions: 1,
        deletions: 1,
        truncated: input.truncated ?? false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 2,
            sectionHeader: 'Plan',
            lines: [
              {
                kind: 'deletion',
                oldLineNumber: 2,
                newLineNumber: null,
                content: 'old thought',
              },
              {
                kind: 'addition',
                oldLineNumber: null,
                newLineNumber: 2,
                content: 'new thought',
              },
            ],
          },
        ],
      },
      ...(input.binary
        ? [
            {
              relativePath: 'notes/assets.png',
              change: 'modified' as const,
              contentKind: 'binary' as const,
              isBinary: true,
              additions: 0,
              deletions: 0,
              truncated: false,
              hunks: [],
            },
          ]
        : []),
    ],
    fileCount: input.binary ? 2 : 1,
    additions: 1,
    deletions: 1,
    changedLineCount: 2,
    truncation: {
      isTruncated: input.truncated ?? false,
      maxBytes: 524288,
      maxFiles: 100,
      maxLines: 2000,
      maxHunksPerFile: 200,
      includedFileCount: input.binary ? 2 : 1,
      omittedFileCount: input.truncated ? 1 : 0,
      includedLineCount: 2,
      omittedLineCount: input.truncated ? 42 : 0,
      omittedByteCount: input.truncated ? 1024 : 0,
    },
    generatedAt: '2026-05-10T00:01:00Z',
  };
}

function restoreResult(): GitRestoreResult {
  const status = gitStatusSummary({
    entries: [
      {
        relativePath: 'notes/plan.md',
        staged: 'unmodified',
        unstaged: 'modified',
        conflicted: false,
      },
    ],
  });

  return {
    workspaceId: 'workspace-1',
    relativePath: 'notes/plan.md',
    restoredFrom: historyEntries()[0].commitOid,
    snapshot: documentSnapshot('notes/plan.md', 'restored-token'),
    fileVersion: fileVersion('restored-token'),
    repositoryState: status.repositoryState,
    status,
    restoredAt: '2026-05-10T00:02:00Z',
  };
}

function snapshotResult(): GitSnapshotResult {
  const status = gitStatusSummary({
    entries: [],
    token: 'post-snapshot-token',
  });

  return {
    workspaceId: 'workspace-1',
    commitOid: 'def456abc1237890def456abc1237890def456ab',
    shortCommitOid: 'def456abc123',
    parentOids: ['abc123def4567890abc123def4567890abc123de'],
    message: 'Save local changes',
    affectedPaths: ['notes/plan.md', 'notes/new.md'],
    affectedFileCount: 2,
    repositoryState: status.repositoryState,
    status,
    snapshotAt: '2026-05-10T00:03:00Z',
  };
}

function gitStatusSummary(
  input: {
    repositoryState?: GitRepositoryState['state'];
    entries?: GitStatusSummary['entries'];
    token?: string;
  } = {},
): GitStatusSummary {
  const token = gitToken(input.token);
  const entries = input.entries ?? [];
  const isRepositoryEnabled = input.repositoryState !== 'not_repository';

  return {
    workspaceId: 'workspace-1',
    repositoryState: {
      workspaceId: 'workspace-1',
      state: input.repositoryState ?? 'valid_repository',
      backend: {
        kind: 'system_git',
        version: 'git version 2.52.0',
      },
      selectedRootDisplayPath: 'C:\\Notes',
      repositoryRootDisplayPath: isRepositoryEnabled ? 'C:\\Notes' : null,
      branchName: isRepositoryEnabled ? 'main' : null,
      headOid: isRepositoryEnabled ? token.headOid : null,
      token: isRepositoryEnabled ? token : null,
      warnings: [],
      checkedAt: '2026-05-10T00:00:00Z',
    },
    token: isRepositoryEnabled ? token : null,
    entries,
    counts: {
      added: 0,
      modified: entries.length,
      deleted: 0,
      renamed: 0,
      untracked: 0,
      ignored: 0,
    },
    hasChanges: entries.length > 0,
    hasConflicts: false,
    changedFileCount: entries.length,
    untrackedFileCount: 0,
    refreshedAt: '2026-05-10T00:00:00Z',
  };
}

function gitToken(token = 'repo-token'): GitRepositoryStateToken {
  return {
    token,
    headOid: 'abc123def4567890',
    indexVersion: 3,
    indexChecksum: 'index',
    worktreeStatusGeneration: 'clean',
    capturedAt: '2026-05-10T00:00:00Z',
  };
}

function gitError(
  code: GitOperationError['code'],
  message: string,
  operation: GitOperationError['operation'] = 'diff',
): GitOperationError {
  return {
    code,
    operation,
    message,
    recoverable: true,
  };
}

function workspaceFile(relativePath: string): WorkspaceFile {
  return {
    relativePath,
    name: 'plan.md',
    extension: '.md',
    byteSize: 7,
    modifiedAt: '2026-05-10T00:00:00Z',
    version: fileVersion(`${relativePath}-token`),
  };
}

function documentSnapshot(relativePath: string, token = `${relativePath}-token`): DocumentSnapshot {
  return {
    workspaceId: 'workspace-1',
    relativePath,
    content: '# Plan\n',
    version: fileVersion(token),
    openedAt: '2026-05-10T00:00:00Z',
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

function markdownDocumentFor(relativePath: string): MarkdownMindMapDocument {
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

function editorDocumentFor(relativePath: string, version: number): EditorMindMapDocument {
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

function linkIndex(): LinkIndexSnapshot {
  return {
    workspaceId: 'workspace-1',
    files: [],
    diagnostics: [],
  };
}
