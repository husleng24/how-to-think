import type {
  GitOperationAccess,
  GitOperationErrorCode,
  GitOperationPermissionPolicy,
  GitPathValidationResult,
  GitRepositoryStateKind,
  GitRepositoryStateToken,
  GitRequestValidationIssue,
  GitRestoreRequest,
  GitServiceMethodSignature,
  GitServiceOperation,
  GitSnapshotRequest,
} from './types';

export const GIT_OPERATION_ERROR_CODES = [
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
] as const satisfies readonly GitOperationErrorCode[];

export const GIT_REPOSITORY_STATE_KINDS = [
  'git_unavailable',
  'not_repository',
  'valid_repository',
  'repository_corrupt',
  'parent_repository',
  'nested_repository',
  'bare_repository',
  'detached_head',
  'merge_conflict',
  'permission_denied',
] as const satisfies readonly GitRepositoryStateKind[];

export const GIT_SERVICE_OPERATIONS = [
  'detect',
  'init',
  'status',
  'snapshot',
  'history',
  'diff',
  'restore',
  'refresh',
] as const satisfies readonly GitServiceOperation[];

export const GIT_SERVICE_METHODS = [
  {
    operation: 'detect',
    commandName: 'git_detect_repository',
    requestType: '{ workspaceId }',
    resultType: 'GitRepositoryState',
    mutability: 'read_only',
    requiresWorkspace: true,
    requiresExpectedRepoToken: false,
    requiresExpectedFileVersion: false,
  },
  {
    operation: 'init',
    commandName: 'git_init_repository',
    requestType: '{ workspaceId }',
    resultType: 'GitRepositoryState',
    mutability: 'mutating',
    requiresWorkspace: true,
    requiresExpectedRepoToken: false,
    requiresExpectedFileVersion: false,
  },
  {
    operation: 'status',
    commandName: 'git_status',
    requestType: '{ workspaceId }',
    resultType: 'GitStatusSummary',
    mutability: 'read_only',
    requiresWorkspace: true,
    requiresExpectedRepoToken: false,
    requiresExpectedFileVersion: false,
  },
  {
    operation: 'snapshot',
    commandName: 'git_create_snapshot',
    requestType: 'GitSnapshotRequest',
    resultType: 'GitSnapshotResult',
    mutability: 'mutating',
    requiresWorkspace: true,
    requiresExpectedRepoToken: true,
    requiresExpectedFileVersion: true,
  },
  {
    operation: 'history',
    commandName: 'git_history',
    requestType: 'GitHistoryRequest',
    resultType: 'GitHistoryEntry[]',
    mutability: 'read_only',
    requiresWorkspace: true,
    requiresExpectedRepoToken: false,
    requiresExpectedFileVersion: false,
  },
  {
    operation: 'diff',
    commandName: 'git_diff',
    requestType: 'GitDiffRequest',
    resultType: 'GitDiffResult',
    mutability: 'read_only',
    requiresWorkspace: true,
    requiresExpectedRepoToken: false,
    requiresExpectedFileVersion: false,
  },
  {
    operation: 'restore',
    commandName: 'git_restore_file',
    requestType: 'GitRestoreRequest',
    resultType: 'GitRestoreResult',
    mutability: 'mutating',
    requiresWorkspace: true,
    requiresExpectedRepoToken: true,
    requiresExpectedFileVersion: true,
  },
  {
    operation: 'refresh',
    commandName: 'git_refresh',
    requestType: '{ workspaceId }',
    resultType: 'GitRepositoryState',
    mutability: 'read_only',
    requiresWorkspace: true,
    requiresExpectedRepoToken: false,
    requiresExpectedFileVersion: false,
  },
] as const satisfies readonly GitServiceMethodSignature[];

export const GIT_OPERATION_PERMISSION_MATRIX: Record<
  GitRepositoryStateKind,
  Record<GitServiceOperation, GitOperationPermissionPolicy>
> = Object.fromEntries(
  GIT_REPOSITORY_STATE_KINDS.map((state) => [
    state,
    Object.fromEntries(
      GIT_SERVICE_OPERATIONS.map((operation) => [
        operation,
        buildGitOperationPolicy(state, operation),
      ]),
    ),
  ]),
) as Record<GitRepositoryStateKind, Record<GitServiceOperation, GitOperationPermissionPolicy>>;

const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/;

export function gitOperationPolicy(
  state: GitRepositoryStateKind,
  operation: GitServiceOperation,
): GitOperationPermissionPolicy {
  return GIT_OPERATION_PERMISSION_MATRIX[state][operation];
}

export function isGitOperationAllowed(
  state: GitRepositoryStateKind,
  operation: GitServiceOperation,
): boolean {
  return gitOperationPolicy(state, operation).access !== 'blocked';
}

export function validateGitWorkspaceRelativePath(path: unknown): GitPathValidationResult {
  if (typeof path !== 'string' || path.length === 0) {
    return gitPathDenied('Git paths must be non-empty workspace-relative paths.');
  }

  if (hasControlCharacter(path)) {
    return gitPathDenied('Git paths cannot contain control characters.');
  }

  if (path.includes('\\')) {
    return gitPathDenied('Git paths must use / separators.');
  }

  if (
    path.startsWith('/') ||
    path.startsWith('//') ||
    path.startsWith('\\\\') ||
    WINDOWS_DRIVE_PREFIX_PATTERN.test(path)
  ) {
    return gitPathDenied('Git paths must be workspace-relative.');
  }

  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return gitPathDenied('Git paths cannot contain empty or dot segments.');
  }

  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    return gitPathDenied('Git metadata internals are not addressable by UI commands.');
  }

  return { ok: true, path };
}

export function validateGitSnapshotRequestContract(
  request: Partial<GitSnapshotRequest>,
): GitRequestValidationIssue[] {
  const issues: GitRequestValidationIssue[] = [];

  if (!request.expectedRepoToken) {
    issues.push({
      code: 'expected_repo_token_required',
      message: 'Snapshot requests must include the repository state token last observed by the UI.',
    });
  }

  if (!request.message || request.message.trim().length === 0) {
    issues.push({
      code: 'snapshot_message_required',
      message: 'Snapshot requests must include a non-empty commit message.',
    });
  }

  if (!request.expectedFileStates || request.expectedFileStates.length === 0) {
    issues.push({
      code: 'expected_file_version_required',
      message: 'Snapshot requests must include expected file versions for scoped files.',
    });
  }

  for (const path of request.scopePaths ?? []) {
    const result = validateGitWorkspaceRelativePath(path);
    if (!result.ok) {
      issues.push({
        code: 'unsafe_scope_path',
        message: result.error.message,
        relativePath: typeof path === 'string' ? path : undefined,
      });
    }
  }

  for (const expected of request.expectedFileStates ?? []) {
    const result = validateGitWorkspaceRelativePath(expected.relativePath);
    if (!result.ok) {
      issues.push({
        code: 'unsafe_scope_path',
        message: result.error.message,
        relativePath: expected.relativePath,
      });
    }
  }

  return issues;
}

export function validateGitRestoreRequestContract(
  request: Partial<GitRestoreRequest>,
): GitRequestValidationIssue[] {
  const issues: GitRequestValidationIssue[] = [];

  if (!request.expectedRepoToken) {
    issues.push({
      code: 'expected_repo_token_required',
      message: 'Restore requests must include the repository state token last observed by the UI.',
    });
  }

  if (!request.expectedFileVersion) {
    issues.push({
      code: 'expected_file_version_required',
      message: 'Restore requests must include the current file version token.',
    });
  }

  if (!request.sourceRef || request.sourceRef.trim().length === 0) {
    issues.push({
      code: 'source_ref_required',
      message: 'Restore requests must identify the source Git revision.',
    });
  }

  if (request.editorHasUnsavedChanges) {
    issues.push({
      code: 'unsaved_editor_changes',
      message: 'Restore requests must not proceed while the editor has unsaved changes.',
      relativePath: request.relativePath,
    });
  }

  if (request.relativePath !== undefined) {
    const result = validateGitWorkspaceRelativePath(request.relativePath);
    if (!result.ok) {
      issues.push({
        code: 'unsafe_scope_path',
        message: result.error.message,
        relativePath: request.relativePath,
      });
    }
  }

  return issues;
}

export function isRepositoryTokenStale(
  expected: GitRepositoryStateToken | null | undefined,
  current: GitRepositoryStateToken | null | undefined,
): boolean {
  if (!expected || !current) {
    return true;
  }

  return (
    expected.token !== current.token ||
    expected.headOid !== current.headOid ||
    expected.indexVersion !== current.indexVersion ||
    expected.indexChecksum !== current.indexChecksum ||
    expected.worktreeStatusGeneration !== current.worktreeStatusGeneration
  );
}

export function gitMethodRequiresExpectedRepoToken(operation: GitServiceOperation): boolean {
  return GIT_SERVICE_METHODS.find((method) => method.operation === operation)
    ?.requiresExpectedRepoToken ?? false;
}

function buildGitOperationPolicy(
  state: GitRepositoryStateKind,
  operation: GitServiceOperation,
): GitOperationPermissionPolicy {
  if (operation === 'detect' || operation === 'refresh') {
    return policy(operation, 'read_only');
  }

  if (operation === 'init') {
    return state === 'not_repository'
      ? policy(operation, 'allowed')
      : policy(operation, 'blocked', initBlockedBy(state));
  }

  if (operation === 'status') {
    if (state === 'valid_repository' || state === 'nested_repository') {
      return policy(operation, 'read_only');
    }

    if (
      state === 'not_repository' ||
      state === 'parent_repository' ||
      state === 'detached_head' ||
      state === 'merge_conflict'
    ) {
      return policy(operation, 'read_only');
    }

    return policy(operation, 'blocked', blockedByState(state));
  }

  if (operation === 'history' || operation === 'diff') {
    if (
      state === 'valid_repository' ||
      state === 'nested_repository' ||
      state === 'parent_repository' ||
      state === 'detached_head' ||
      state === 'merge_conflict'
    ) {
      return policy(operation, 'read_only');
    }

    return policy(operation, 'blocked', blockedByState(state));
  }

  if (operation === 'snapshot' || operation === 'restore') {
    if (state === 'valid_repository' || state === 'nested_repository') {
      return policy(operation, 'allowed');
    }

    return policy(operation, 'blocked', blockedByState(state));
  }

  return policy(operation, 'blocked', 'unknown_git_error');
}

function initBlockedBy(state: GitRepositoryStateKind): GitOperationErrorCode {
  if (state === 'valid_repository' || state === 'nested_repository') {
    return 'no_changes';
  }

  return blockedByState(state);
}

function blockedByState(state: GitRepositoryStateKind): GitOperationErrorCode {
  if (state === 'valid_repository') {
    return 'no_changes';
  }

  if (state === 'git_unavailable') {
    return 'git_unavailable';
  }

  if (state === 'repository_corrupt') {
    return 'repository_corrupt';
  }

  if (state === 'permission_denied') {
    return 'permission_denied';
  }

  if (state === 'not_repository') {
    return 'not_repository';
  }

  return state;
}

function policy(
  operation: GitServiceOperation,
  access: GitOperationAccess,
  blockedBy?: GitOperationErrorCode,
): GitOperationPermissionPolicy {
  return blockedBy ? { operation, access, blockedBy } : { operation, access };
}

function gitPathDenied(message: string): GitPathValidationResult {
  return { ok: false, error: { code: 'permission_denied', message } };
}

function hasControlCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}
