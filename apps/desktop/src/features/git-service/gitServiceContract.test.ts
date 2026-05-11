import {
  GIT_OPERATION_ERROR_CODES,
  GIT_OPERATION_PERMISSION_MATRIX,
  GIT_SERVICE_METHODS,
  buildGitSnapshotRequest,
  gitBlockedStateForRepository,
  gitBlockedStateFromError,
  gitMethodRequiresExpectedRepoToken,
  gitOperationPolicy,
  getGitSnapshotEligibility,
  getGitRestoreEligibility,
  groupGitStatusEntries,
  isFileVersionStale,
  isGitOperationAllowed,
  isRepositoryTokenStale,
  validateGitRestoreRequestContract,
  validateGitSnapshotRequestContract,
  validateGitWorkspaceRelativePath,
} from './index';
import type {
  GitDiffResult,
  GitHistoryEntry,
  GitRepositoryState,
  GitRepositoryStateToken,
  GitRestoreRequest,
  GitSnapshotResult,
  GitSnapshotRequest,
  GitStatusSummary,
} from './types';
import type { WorkspaceFile } from '../../types/markdownLifecycle';

const sampleToken: GitRepositoryStateToken = {
  token: 'head:abc:index:3:status:clean',
  headOid: 'abcdef1234567890',
  indexVersion: 3,
  indexChecksum: 'index-checksum',
  worktreeStatusGeneration: 'clean-0001',
  capturedAt: '2026-05-11T00:00:00.000Z',
};

const sampleFileVersion = {
  modifiedAt: '2026-05-11T00:00:00.000Z',
  byteSize: 42,
  contentHash: 'sha256:abc',
  token: 'file-version-token',
};

describe('Git service contract', () => {
  it('keeps stable UI-safe Git error codes explicit', () => {
    expect(GIT_OPERATION_ERROR_CODES).toEqual([
      'git_unavailable',
      'not_repository',
      'repository_corrupt',
      'parent_repository',
      'nested_repository',
      'bare_repository',
      'detached_head',
      'merge_conflict',
      'permission_denied',
      'identity_missing',
      'no_changes',
      'invalid_ref',
      'file_not_in_history',
      'external_state_changed',
      'restore_conflict',
      'unknown_git_error',
    ]);
  });

  it('round-trips repository state with camelCase DTO fields and snake_case state values', () => {
    const state: GitRepositoryState = {
      workspaceId: 'workspace-1',
      state: 'valid_repository',
      backend: {
        kind: 'system_git',
        version: 'git version 2.52.0.windows.1',
      },
      selectedRootDisplayPath: 'C:/Users/example/notes',
      repositoryRootDisplayPath: 'C:/Users/example/notes',
      relativePrefix: null,
      branchName: 'main',
      headOid: sampleToken.headOid,
      token: sampleToken,
      warnings: [],
      checkedAt: '2026-05-11T00:00:01.000Z',
    };

    const parsed = JSON.parse(JSON.stringify(state)) as GitRepositoryState;

    expect(parsed.workspaceId).toBe('workspace-1');
    expect(parsed.state).toBe('valid_repository');
    expect(parsed.token?.worktreeStatusGeneration).toBe('clean-0001');
  });

  it('rejects absolute paths, traversal, backslashes, and Git internals', () => {
    expect(validateGitWorkspaceRelativePath('notes/idea.md')).toEqual({
      ok: true,
      path: 'notes/idea.md',
    });

    for (const path of [
      '../notes.md',
      'notes/../../secret.md',
      '/Users/example/notes.md',
      'C:/Users/example/notes.md',
      '//server/share/notes.md',
      'notes\\idea.md',
      'notes//idea.md',
      '.git/config',
      'notes/.git/index',
    ]) {
      const result = validateGitWorkspaceRelativePath(path);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('permission_denied');
      }
    }
  });

  it('documents operation permissions for blocked and degraded repository states', () => {
    expect(gitOperationPolicy('detached_head', 'status').access).toBe('read_only');
    expect(gitOperationPolicy('detached_head', 'snapshot')).toMatchObject({
      access: 'blocked',
      blockedBy: 'detached_head',
    });
    expect(gitOperationPolicy('merge_conflict', 'diff').access).toBe('read_only');
    expect(gitOperationPolicy('merge_conflict', 'restore')).toMatchObject({
      access: 'blocked',
      blockedBy: 'merge_conflict',
    });
    expect(gitOperationPolicy('bare_repository', 'history')).toMatchObject({
      access: 'blocked',
      blockedBy: 'bare_repository',
    });
    expect(gitOperationPolicy('parent_repository', 'diff').access).toBe('read_only');
    expect(gitOperationPolicy('parent_repository', 'restore')).toMatchObject({
      access: 'blocked',
      blockedBy: 'parent_repository',
    });
    expect(isGitOperationAllowed('nested_repository', 'snapshot')).toBe(true);
    expect(isGitOperationAllowed('nested_repository', 'restore')).toBe(true);
    expect(GIT_OPERATION_PERMISSION_MATRIX.valid_repository.init.blockedBy).toBe('no_changes');
  });

  it('requires repository and file state tokens for mutating snapshot and restore contracts', () => {
    const snapshot: GitSnapshotRequest = {
      workspaceId: 'workspace-1',
      message: 'Save local snapshot',
      scopePaths: ['notes/idea.md'],
      expectedRepoToken: sampleToken,
      expectedFileStates: [
        {
          relativePath: 'notes/idea.md',
          expectedVersion: sampleFileVersion,
        },
      ],
      author: {
        name: 'How to Think',
        email: 'local@example.invalid',
      },
    };
    const restore: GitRestoreRequest = {
      workspaceId: 'workspace-1',
      relativePath: 'notes/idea.md',
      sourceRef: 'HEAD~1',
      expectedRepoToken: sampleToken,
      expectedFileVersion: sampleFileVersion,
      editorHasUnsavedChanges: false,
    };

    expect(validateGitSnapshotRequestContract(snapshot)).toEqual([]);
    expect(validateGitRestoreRequestContract(restore)).toEqual([]);
    expect(validateGitSnapshotRequestContract({ message: '', scopePaths: ['.git/config'] }).map(
      (issue) => issue.code,
    )).toEqual([
      'expected_repo_token_required',
      'snapshot_message_required',
      'expected_file_version_required',
      'unsafe_scope_path',
    ]);
    expect(validateGitRestoreRequestContract({ relativePath: '../notes.md' }).map(
      (issue) => issue.code,
    )).toEqual([
      'expected_repo_token_required',
      'expected_file_version_required',
      'source_ref_required',
      'unsafe_scope_path',
    ]);
    expect(
      validateGitRestoreRequestContract({
        ...restore,
        editorHasUnsavedChanges: true,
      }).map((issue) => issue.code),
    ).toEqual(['unsaved_editor_changes']);
    expect(gitMethodRequiresExpectedRepoToken('snapshot')).toBe(true);
    expect(gitMethodRequiresExpectedRepoToken('restore')).toBe(true);
  });

  it('models status counts and snapshot result metadata needed by the UI', () => {
    const repositoryState: GitRepositoryState = {
      workspaceId: 'workspace-1',
      state: 'valid_repository',
      backend: {
        kind: 'system_git',
        version: 'git version 2.52.0.windows.1',
      },
      selectedRootDisplayPath: 'C:/Users/example/notes',
      repositoryRootDisplayPath: 'C:/Users/example/notes',
      branchName: 'main',
      headOid: sampleToken.headOid,
      token: sampleToken,
      warnings: [],
      checkedAt: '2026-05-11T00:00:01.000Z',
    };
    const status: GitStatusSummary = {
      workspaceId: 'workspace-1',
      repositoryState,
      token: sampleToken,
      entries: [
        {
          relativePath: 'notes/idea.md',
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
      refreshedAt: '2026-05-11T00:00:02.000Z',
    };
    const result: GitSnapshotResult = {
      workspaceId: 'workspace-1',
      commitOid: 'abcdef1234567890abcdef1234567890abcdef12',
      shortCommitOid: 'abcdef123456',
      parentOids: [],
      message: 'Save idea',
      affectedPaths: ['notes/idea.md'],
      affectedFileCount: 1,
      repositoryState,
      status: {
        ...status,
        entries: [],
        hasChanges: false,
        changedFileCount: 0,
      },
      snapshotAt: '2026-05-11T00:00:03.000Z',
    };

    expect(status.counts.modified).toBe(1);
    expect(result.shortCommitOid).toHaveLength(12);
    expect(result.affectedPaths).toEqual(['notes/idea.md']);
  });

  it('models history entries with short commit ids and affected file counts', () => {
    const entry: GitHistoryEntry = {
      commitOid: 'abcdef1234567890abcdef1234567890abcdef12',
      shortCommitOid: 'abcdef123456',
      parentOids: ['1111111111111111111111111111111111111111'],
      authorName: 'Test User',
      authorEmail: 'test@example.invalid',
      authoredAt: '2026-05-11T00:00:00+00:00',
      subject: 'Save idea',
      touchedPaths: ['notes/idea.md'],
      affectedFileCount: 1,
    };

    expect(entry.shortCommitOid).toHaveLength(12);
    expect(entry.touchedPaths).toEqual(['notes/idea.md']);
  });

  it('models structured UI-ready Git diffs without raw patch parsing', () => {
    const diff: GitDiffResult = {
      workspaceId: 'workspace-1',
      mode: 'working_tree',
      relativePath: 'notes/idea.md',
      baseRef: 'HEAD~1',
      files: [
        {
          relativePath: 'notes/idea.md',
          change: 'modified',
          contentKind: 'text',
          isBinary: false,
          additions: 1,
          deletions: 1,
          truncated: false,
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              lines: [
                {
                  kind: 'deletion',
                  oldLineNumber: 2,
                  content: 'old thought',
                },
                {
                  kind: 'addition',
                  newLineNumber: 2,
                  content: 'new thought',
                },
              ],
            },
          ],
        },
      ],
      fileCount: 1,
      additions: 1,
      deletions: 1,
      changedLineCount: 2,
      truncation: {
        isTruncated: false,
        maxBytes: 524288,
        maxFiles: 100,
        maxLines: 2000,
        maxHunksPerFile: 200,
        includedFileCount: 1,
        omittedFileCount: 0,
        includedLineCount: 2,
        omittedLineCount: 0,
        omittedByteCount: 0,
      },
      generatedAt: '2026-05-11T00:00:01.000Z',
    };

    expect(diff.files[0].hunks[0].lines.map((line) => line.kind)).toEqual([
      'deletion',
      'addition',
    ]);
    expect(diff.changedLineCount).toBe(2);
  });

  it('detects stale repository tokens across head, index, and worktree generation changes', () => {
    expect(isRepositoryTokenStale(sampleToken, { ...sampleToken })).toBe(false);
    expect(isRepositoryTokenStale(sampleToken, { ...sampleToken, headOid: 'changed' })).toBe(true);
    expect(isRepositoryTokenStale(sampleToken, { ...sampleToken, indexVersion: 4 })).toBe(true);
    expect(isRepositoryTokenStale(sampleToken, {
      ...sampleToken,
      worktreeStatusGeneration: 'dirty-0002',
    })).toBe(true);
    expect(isRepositoryTokenStale(sampleToken, null)).toBe(true);
  });

  it('keeps public Git method signatures scoped to local repository service operations', () => {
    expect(GIT_SERVICE_METHODS.map((method) => method.operation)).toEqual([
      'detect',
      'init',
      'status',
      'snapshot',
      'history',
      'diff',
      'restore',
      'refresh',
    ]);
    expect(GIT_SERVICE_METHODS.some((method) => method.commandName.includes('remote'))).toBe(false);
    expect(GIT_SERVICE_METHODS.some((method) => method.commandName.includes('branch'))).toBe(false);
    expect(GIT_SERVICE_METHODS.some((method) => method.commandName.includes('rebase'))).toBe(false);
    expect(GIT_SERVICE_METHODS.find((method) => method.operation === 'refresh')?.resultType).toBe(
      'GitStatusSummary',
    );
  });

  it('maps blocked repository and stale operation states to typed frontend states', () => {
    const blocked = gitBlockedStateForRepository(
      {
        workspaceId: 'workspace-1',
        state: 'merge_conflict',
        backend: {
          kind: 'system_git',
          version: 'git version 2.52.0',
        },
        selectedRootDisplayPath: 'C:/Users/example/notes',
        repositoryRootDisplayPath: 'C:/Users/example/notes',
        branchName: 'main',
        headOid: sampleToken.headOid,
        token: sampleToken,
        blockedReason: 'merge_conflict',
        warnings: [],
        checkedAt: '2026-05-11T00:00:01.000Z',
      },
      'snapshot',
    );

    expect(blocked).toMatchObject({
      kind: 'merge_conflict',
      operation: 'snapshot',
      code: 'merge_conflict',
    });
    expect(
      gitBlockedStateFromError({
        code: 'external_state_changed',
        operation: 'restore',
        message: 'Repository changed.',
        recoverable: true,
        relativePath: 'notes/idea.md',
      }),
    ).toMatchObject({
      kind: 'stale_repository_state',
      operation: 'restore',
      relativePath: 'notes/idea.md',
    });
    expect(
      gitBlockedStateFromError({
        code: 'identity_missing',
        operation: 'snapshot',
        message: 'Author identity unknown.',
        recoverable: true,
      }),
    ).toMatchObject({
      kind: 'identity_missing',
      operation: 'snapshot',
    });
    expect(
      gitBlockedStateFromError({
        code: 'restore_conflict',
        operation: 'restore',
        message: 'File changed.',
        recoverable: true,
      }),
    ).toMatchObject({ kind: 'stale_file_state' });
  });

  it('groups status entries into UI sections without exposing ignored files', () => {
    const groups = groupGitStatusEntries([
      {
        relativePath: 'notes/added.md',
        staged: 'added',
        unstaged: 'unmodified',
        conflicted: false,
      },
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
        relativePath: 'notes/old.md',
        staged: 'deleted',
        unstaged: 'unmodified',
        conflicted: false,
      },
      {
        relativePath: 'notes/renamed.md',
        previousRelativePath: 'notes/draft.md',
        staged: 'renamed',
        unstaged: 'unmodified',
        conflicted: false,
      },
      {
        relativePath: 'notes/ignored.md',
        staged: 'ignored',
        unstaged: 'ignored',
        conflicted: false,
      },
    ]);

    expect(groups.map((group) => group.kind)).toEqual([
      'added',
      'modified',
      'deleted',
      'renamed',
      'untracked',
    ]);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.relativePath))).not.toContain(
      'notes/ignored.md',
    );
  });

  it('derives snapshot disabled reasons for clean, blocked, stale, identity, and unsaved states', () => {
    const dirtyStatus = gitStatusSummary('notes/plan.md');
    const cleanStatus: GitStatusSummary = {
      ...dirtyStatus,
      entries: [],
      counts: {
        added: 0,
        modified: 0,
        deleted: 0,
        renamed: 0,
        untracked: 0,
        ignored: 0,
      },
      hasChanges: false,
      changedFileCount: 0,
      untrackedFileCount: 0,
    };

    expect(
      getGitSnapshotEligibility({
        workspaceId: 'workspace-1',
        status: cleanStatus,
      }).disabledReasons.map((reason) => reason.code),
    ).toContain('no_changes');
    expect(
      getGitSnapshotEligibility({
        workspaceId: 'workspace-1',
        status: {
          ...dirtyStatus,
          repositoryState: {
            ...dirtyStatus.repositoryState,
            state: 'detached_head',
            blockedReason: 'detached_head',
          },
        },
      }).disabledReasons.map((reason) => reason.code),
    ).toContain('repository_blocked');
    expect(
      getGitSnapshotEligibility({
        workspaceId: 'workspace-1',
        status: {
          ...dirtyStatus,
          repositoryState: {
            ...dirtyStatus.repositoryState,
            token: {
              ...sampleToken,
              token: 'new-token',
            },
          },
        },
      }).disabledReasons.map((reason) => reason.code),
    ).toContain('stale_repository_state');
    expect(
      getGitSnapshotEligibility({
        workspaceId: 'workspace-1',
        status: dirtyStatus,
        blockedState: {
          kind: 'identity_missing',
          operation: 'snapshot',
          code: 'identity_missing',
          title: 'Git identity needed',
          detail: 'Configure a Git author name and email before creating snapshots.',
          recoverable: true,
        },
      }).disabledReasons.map((reason) => reason.code),
    ).toContain('missing_identity');
    expect(
      getGitSnapshotEligibility({
        workspaceId: 'workspace-1',
        status: dirtyStatus,
        hasUnsavedEditorChanges: true,
      }).disabledReasons.map((reason) => reason.code),
    ).toContain('unsaved_editor_changes');
  });

  it('derives restore disabled reasons for stale, dirty, scoped, and blocked states', () => {
    const dirtyStatus = gitStatusSummary('notes/plan.md');

    expect(
      getGitRestoreEligibility({
        workspaceId: 'workspace-1',
        activeRelativePath: 'notes/plan.md',
        isFileHistoryScope: true,
        status: dirtyStatus,
        expectedRepoToken: sampleToken,
        currentRepoToken: sampleToken,
        expectedFileVersion: sampleFileVersion,
        currentFileVersion: sampleFileVersion,
      }),
    ).toMatchObject({ canRestore: true });

    expect(
      getGitRestoreEligibility({
        workspaceId: 'workspace-1',
        activeRelativePath: 'notes/plan.md',
        isFileHistoryScope: false,
        status: dirtyStatus,
        expectedRepoToken: sampleToken,
        currentRepoToken: sampleToken,
        expectedFileVersion: sampleFileVersion,
        currentFileVersion: sampleFileVersion,
        hasUnsavedEditorChanges: true,
      }).disabledReasons.map((reason) => reason.code),
    ).toEqual(['file_history_required', 'unsaved_editor_changes']);

    expect(
      getGitRestoreEligibility({
        workspaceId: 'workspace-1',
        activeRelativePath: 'notes/plan.md',
        isFileHistoryScope: true,
        status: {
          ...dirtyStatus,
          repositoryState: {
            ...dirtyStatus.repositoryState,
            state: 'merge_conflict',
            blockedReason: 'merge_conflict',
          },
          hasConflicts: true,
        },
        expectedRepoToken: sampleToken,
        currentRepoToken: sampleToken,
        expectedFileVersion: sampleFileVersion,
        currentFileVersion: sampleFileVersion,
      }).disabledReasons.map((reason) => reason.code),
    ).toEqual(['repository_blocked']);

    expect(
      getGitRestoreEligibility({
        workspaceId: 'workspace-1',
        activeRelativePath: 'notes/plan.md',
        isFileHistoryScope: true,
        status: dirtyStatus,
        expectedRepoToken: sampleToken,
        currentRepoToken: { ...sampleToken, token: 'changed-token' },
        expectedFileVersion: sampleFileVersion,
        currentFileVersion: { ...sampleFileVersion, token: 'changed-file' },
      }).disabledReasons.map((reason) => reason.code),
    ).toEqual(['stale_repository_state', 'stale_file_state']);
    expect(isFileVersionStale(sampleFileVersion, { ...sampleFileVersion })).toBe(false);
    expect(isFileVersionStale(sampleFileVersion, { ...sampleFileVersion, contentHash: 'changed' })).toBe(true);
  });

  it('builds snapshot requests from eligible status entries and current file versions', () => {
    const status: GitStatusSummary = {
      ...gitStatusSummary('notes/plan.md'),
      entries: [
        {
          relativePath: 'notes/plan.md',
          staged: 'unmodified',
          unstaged: 'modified',
          conflicted: false,
        },
        {
          relativePath: 'notes/deleted.md',
          staged: 'deleted',
          unstaged: 'unmodified',
          conflicted: false,
        },
        {
          relativePath: 'notes/ignored.md',
          staged: 'ignored',
          unstaged: 'ignored',
          conflicted: false,
        },
      ],
    };
    const files: WorkspaceFile[] = [
      {
        relativePath: 'notes/plan.md',
        name: 'plan.md',
        extension: '.md',
        byteSize: 12,
        modifiedAt: sampleFileVersion.modifiedAt,
        version: sampleFileVersion,
      },
    ];

    expect(
      buildGitSnapshotRequest({
        workspaceId: 'workspace-1',
        status,
        files,
        message: '  Save plan  ',
      }),
    ).toMatchObject({
      workspaceId: 'workspace-1',
      message: 'Save plan',
      scopePaths: ['notes/plan.md', 'notes/deleted.md'],
      expectedFileStates: [
        {
          relativePath: 'notes/plan.md',
          expectedVersion: sampleFileVersion,
        },
      ],
    });
    expect(
      buildGitSnapshotRequest({
        workspaceId: 'workspace-1',
        status,
        files,
        message: '   ',
      }),
    ).toBeNull();
  });
});

function gitStatusSummary(relativePath: string, token = sampleToken.token): GitStatusSummary {
  const repositoryState: GitRepositoryState = {
    workspaceId: 'workspace-1',
    state: 'valid_repository',
    backend: {
      kind: 'system_git',
      version: 'git version 2.52.0',
    },
    selectedRootDisplayPath: 'C:/Users/example/notes',
    repositoryRootDisplayPath: 'C:/Users/example/notes',
    branchName: 'main',
    headOid: sampleToken.headOid,
    token: {
      ...sampleToken,
      token,
    },
    warnings: [],
    checkedAt: '2026-05-11T00:00:01.000Z',
  };

  return {
    workspaceId: 'workspace-1',
    repositoryState,
    token: repositoryState.token ?? null,
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
    refreshedAt: '2026-05-11T00:00:02.000Z',
  };
}
