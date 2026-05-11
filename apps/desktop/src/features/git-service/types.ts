import type {
  FileVersion,
  IsoDateTime,
  WorkspaceId,
  WorkspaceRelativePath,
} from '../../types/markdownLifecycle';

export type GitOperationErrorCode =
  | 'git_unavailable'
  | 'not_repository'
  | 'repository_corrupt'
  | 'parent_repository'
  | 'nested_repository'
  | 'bare_repository'
  | 'detached_head'
  | 'merge_conflict'
  | 'permission_denied'
  | 'identity_missing'
  | 'no_changes'
  | 'invalid_ref'
  | 'file_not_in_history'
  | 'external_state_changed'
  | 'restore_conflict'
  | 'unknown_git_error';

export type GitRepositoryStateKind =
  | 'git_unavailable'
  | 'not_repository'
  | 'valid_repository'
  | 'repository_corrupt'
  | 'parent_repository'
  | 'nested_repository'
  | 'bare_repository'
  | 'detached_head'
  | 'merge_conflict'
  | 'permission_denied';

export type GitServiceOperation =
  | 'detect'
  | 'init'
  | 'status'
  | 'snapshot'
  | 'history'
  | 'diff'
  | 'restore'
  | 'refresh';

export type GitServiceMutability = 'read_only' | 'mutating';
export type GitOperationAccess = 'allowed' | 'read_only' | 'blocked';
export type GitBackendKind = 'system_git';

export type GitStatusChangeKind =
  | 'unmodified'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'ignored'
  | 'unmerged'
  | 'unknown';

export type GitDiffMode = 'working_tree' | 'staged' | 'ref_range';

export interface GitBackendInfo {
  kind: GitBackendKind;
  version: string | null;
  executableDisplayPath?: string | null;
}

export interface GitRepositoryStateToken {
  token: string;
  headOid: string | null;
  indexVersion: number | null;
  indexChecksum: string | null;
  worktreeStatusGeneration: string;
  capturedAt: IsoDateTime;
}

export interface GitRepositoryWarning {
  code: 'ancestor_repository_ignored' | 'parent_repository_scope' | 'git_version_unverified';
  message: string;
}

export interface GitRepositoryState {
  workspaceId: WorkspaceId;
  state: GitRepositoryStateKind;
  backend: GitBackendInfo;
  selectedRootDisplayPath: string;
  repositoryRootDisplayPath?: string | null;
  relativePrefix?: WorkspaceRelativePath | null;
  branchName?: string | null;
  headOid?: string | null;
  token?: GitRepositoryStateToken | null;
  blockedReason?: GitOperationErrorCode | null;
  warnings: readonly GitRepositoryWarning[];
  checkedAt: IsoDateTime;
}

export interface GitStatusEntry {
  relativePath: WorkspaceRelativePath;
  previousRelativePath?: WorkspaceRelativePath | null;
  staged: GitStatusChangeKind;
  unstaged: GitStatusChangeKind;
  conflicted: boolean;
}

export interface GitStatusCounts {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  untracked: number;
  ignored: number;
}

export interface GitStatusSummary {
  workspaceId: WorkspaceId;
  repositoryState: GitRepositoryState;
  token: GitRepositoryStateToken | null;
  entries: readonly GitStatusEntry[];
  counts: GitStatusCounts;
  hasChanges: boolean;
  hasConflicts: boolean;
  changedFileCount: number;
  untrackedFileCount: number;
  refreshedAt: IsoDateTime;
}

export interface GitExpectedFileState {
  relativePath: WorkspaceRelativePath;
  expectedVersion: FileVersion;
}

export interface GitAuthorIdentity {
  name: string;
  email: string;
}

export interface GitSnapshotRequest {
  workspaceId: WorkspaceId;
  message: string;
  scopePaths: readonly WorkspaceRelativePath[];
  expectedRepoToken: GitRepositoryStateToken;
  expectedFileStates: readonly GitExpectedFileState[];
  author?: GitAuthorIdentity | null;
}

export interface GitSnapshotResult {
  workspaceId: WorkspaceId;
  commitOid: string;
  shortCommitOid: string;
  parentOids: readonly string[];
  message: string;
  affectedPaths: readonly WorkspaceRelativePath[];
  affectedFileCount: number;
  repositoryState: GitRepositoryState;
  status: GitStatusSummary;
  snapshotAt: IsoDateTime;
}

export interface GitHistoryRequest {
  workspaceId: WorkspaceId;
  relativePath?: WorkspaceRelativePath | null;
  maxEntries?: number;
}

export interface GitHistoryEntry {
  commitOid: string;
  parentOids: readonly string[];
  authorName: string;
  authorEmail: string;
  authoredAt: IsoDateTime;
  subject: string;
  touchedPaths: readonly WorkspaceRelativePath[];
}

export interface GitDiffRequest {
  workspaceId: WorkspaceId;
  mode: GitDiffMode;
  relativePath?: WorkspaceRelativePath | null;
  baseRef?: string | null;
  headRef?: string | null;
}

export interface GitDiffResult {
  workspaceId: WorkspaceId;
  mode: GitDiffMode;
  relativePath?: WorkspaceRelativePath | null;
  baseRef?: string | null;
  headRef?: string | null;
  patch: string;
  isBinary: boolean;
  changedLineCount: number;
}

export interface GitRestoreRequest {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  sourceRef: string;
  expectedRepoToken: GitRepositoryStateToken;
  expectedFileVersion: FileVersion;
  dryRun?: boolean;
}

export interface GitRestoreResult {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  restoredFrom: string;
  fileVersion: FileVersion;
  repositoryState: GitRepositoryState;
  status: GitStatusSummary;
  restoredAt: IsoDateTime;
}

export interface GitOperationError {
  code: GitOperationErrorCode;
  operation: GitServiceOperation;
  message: string;
  recoverable: boolean;
  relativePath?: WorkspaceRelativePath;
  details?: Record<string, string | number | boolean | null>;
}

export interface GitServiceMethodSignature {
  operation: GitServiceOperation;
  commandName: string;
  requestType: string;
  resultType: string;
  mutability: GitServiceMutability;
  requiresWorkspace: boolean;
  requiresExpectedRepoToken: boolean;
  requiresExpectedFileVersion: boolean;
}

export interface GitOperationPermissionPolicy {
  operation: GitServiceOperation;
  access: GitOperationAccess;
  blockedBy?: GitOperationErrorCode;
}

export interface GitPathValidationError {
  code: Extract<GitOperationErrorCode, 'permission_denied'>;
  message: string;
}

export type GitPathValidationResult =
  | { ok: true; path: WorkspaceRelativePath }
  | { ok: false; error: GitPathValidationError };

export interface GitRequestValidationIssue {
  code:
    | 'expected_repo_token_required'
    | 'expected_file_version_required'
    | 'unsafe_scope_path'
    | 'source_ref_required'
    | 'snapshot_message_required';
  message: string;
  relativePath?: WorkspaceRelativePath;
}
