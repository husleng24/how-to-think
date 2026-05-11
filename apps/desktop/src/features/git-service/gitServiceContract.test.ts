import {
  GIT_OPERATION_ERROR_CODES,
  GIT_OPERATION_PERMISSION_MATRIX,
  GIT_SERVICE_METHODS,
  gitMethodRequiresExpectedRepoToken,
  gitOperationPolicy,
  isGitOperationAllowed,
  isRepositoryTokenStale,
  validateGitRestoreRequestContract,
  validateGitSnapshotRequestContract,
  validateGitWorkspaceRelativePath,
} from './index';
import type {
  GitRepositoryState,
  GitRepositoryStateToken,
  GitRestoreRequest,
  GitSnapshotRequest,
} from './types';

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
    expect(gitMethodRequiresExpectedRepoToken('snapshot')).toBe(true);
    expect(gitMethodRequiresExpectedRepoToken('restore')).toBe(true);
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
  });
});
