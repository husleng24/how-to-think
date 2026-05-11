import type { WorkspaceFile, WorkspaceId, WorkspaceRelativePath } from '../../types/markdownLifecycle';
import {
  gitOperationPolicy,
  isGitOperationAllowed,
  isRepositoryTokenStale,
} from './contract';
import type {
  GitBlockedState,
  GitOperationErrorCode,
  GitRepositoryStateKind,
  GitSnapshotRequest,
  GitStatusChangeKind,
  GitStatusEntry,
  GitStatusSummary,
} from './types';

export type GitStatusGroupKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface GitStatusGroup {
  kind: GitStatusGroupKind;
  title: string;
  entries: readonly GitStatusEntry[];
}

export interface GitSnapshotDisabledReason {
  code:
    | 'workspace_missing'
    | 'status_unavailable'
    | 'git_not_enabled'
    | 'repository_blocked'
    | 'missing_identity'
    | 'missing_repository_token'
    | 'stale_repository_state'
    | 'unsaved_editor_changes'
    | 'no_changes';
  message: string;
}

export interface GitSnapshotEligibilityInput {
  workspaceId?: WorkspaceId | null;
  status?: GitStatusSummary | null;
  blockedState?: GitBlockedState | null;
  hasUnsavedEditorChanges?: boolean;
}

export interface GitSnapshotEligibility {
  canCreateSnapshot: boolean;
  eligibleEntries: readonly GitStatusEntry[];
  disabledReasons: readonly GitSnapshotDisabledReason[];
}

const STATUS_GROUP_ORDER: readonly GitStatusGroupKind[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
];

const STATUS_GROUP_TITLES: Record<GitStatusGroupKind, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked',
};

export function groupGitStatusEntries(entries: readonly GitStatusEntry[]): GitStatusGroup[] {
  const groups = new Map<GitStatusGroupKind, GitStatusEntry[]>();

  for (const entry of entries) {
    const groupKind = gitStatusGroupKindForEntry(entry);

    if (!groupKind) {
      continue;
    }

    const group = groups.get(groupKind) ?? [];
    group.push(entry);
    groups.set(groupKind, group);
  }

  return STATUS_GROUP_ORDER.flatMap((kind) => {
    const groupEntries = groups.get(kind);

    if (!groupEntries || groupEntries.length === 0) {
      return [];
    }

    return [
      {
        kind,
        title: STATUS_GROUP_TITLES[kind],
        entries: sortStatusEntries(groupEntries),
      },
    ];
  });
}

export function gitStatusGroupKindForEntry(
  entry: GitStatusEntry,
): GitStatusGroupKind | null {
  const change = primaryGitStatusChangeKind(entry);

  switch (change) {
    case 'added':
      return 'added';
    case 'modified':
    case 'unmerged':
    case 'unknown':
      return 'modified';
    case 'deleted':
      return 'deleted';
    case 'renamed':
    case 'copied':
      return 'renamed';
    case 'untracked':
      return 'untracked';
    case 'ignored':
    case 'unmodified':
      return null;
  }
}

export function primaryGitStatusChangeKind(entry: GitStatusEntry): GitStatusChangeKind {
  for (const kind of [entry.staged, entry.unstaged]) {
    if (kind === 'ignored') {
      return 'ignored';
    }
  }

  for (const kind of [entry.staged, entry.unstaged]) {
    if (kind === 'untracked') {
      return 'untracked';
    }
  }

  for (const kind of [entry.staged, entry.unstaged]) {
    if (kind === 'renamed' || kind === 'copied') {
      return kind;
    }
  }

  for (const kind of [entry.staged, entry.unstaged]) {
    if (kind === 'added') {
      return 'added';
    }
  }

  for (const kind of [entry.staged, entry.unstaged]) {
    if (kind === 'deleted') {
      return 'deleted';
    }
  }

  for (const kind of [entry.staged, entry.unstaged]) {
    if (kind === 'unmerged') {
      return 'unmerged';
    }
  }

  for (const kind of [entry.staged, entry.unstaged]) {
    if (kind === 'modified') {
      return 'modified';
    }
  }

  for (const kind of [entry.staged, entry.unstaged]) {
    if (kind === 'unknown') {
      return 'unknown';
    }
  }

  return 'unmodified';
}

export function getSnapshotEligibleEntries(
  entries: readonly GitStatusEntry[],
): GitStatusEntry[] {
  return entries.filter((entry) => {
    if (entry.conflicted) {
      return false;
    }

    return gitStatusGroupKindForEntry(entry) !== null;
  });
}

export function getGitSnapshotEligibility(
  input: GitSnapshotEligibilityInput,
): GitSnapshotEligibility {
  const disabledReasons: GitSnapshotDisabledReason[] = [];
  const status = input.status ?? null;
  const eligibleEntries = status ? getSnapshotEligibleEntries(status.entries) : [];

  if (!input.workspaceId) {
    disabledReasons.push({
      code: 'workspace_missing',
      message: 'Open a workspace before using Git snapshots.',
    });
    return { canCreateSnapshot: false, eligibleEntries, disabledReasons };
  }

  if (!status) {
    disabledReasons.push({
      code: 'status_unavailable',
      message: 'Refresh Git status before creating a snapshot.',
    });
    return { canCreateSnapshot: false, eligibleEntries, disabledReasons };
  }

  if (input.blockedState?.kind === 'identity_missing') {
    disabledReasons.push({
      code: 'missing_identity',
      message: 'Configure a Git author name and email before creating snapshots.',
    });
  } else if (input.blockedState?.kind === 'stale_repository_state') {
    disabledReasons.push({
      code: 'stale_repository_state',
      message: 'Refresh Git status before retrying the snapshot.',
    });
  }

  const repositoryState = status.repositoryState.state;

  if (repositoryState === 'not_repository') {
    disabledReasons.push({
      code: 'git_not_enabled',
      message: 'Enable Git before creating snapshots.',
    });
    return { canCreateSnapshot: false, eligibleEntries, disabledReasons };
  }

  if (!isGitOperationAllowed(repositoryState, 'snapshot')) {
    disabledReasons.push({
      code: 'repository_blocked',
      message: snapshotBlockedMessage(repositoryState),
    });
  }

  if (status.hasConflicts) {
    disabledReasons.push({
      code: 'repository_blocked',
      message: 'Resolve merge conflicts before creating snapshots.',
    });
  }

  const expectedToken = status.token ?? status.repositoryState.token ?? null;

  if (!expectedToken) {
    disabledReasons.push({
      code: 'missing_repository_token',
      message: 'Refresh Git status before creating a snapshot.',
    });
  } else if (isRepositoryTokenStale(expectedToken, status.repositoryState.token)) {
    disabledReasons.push({
      code: 'stale_repository_state',
      message: 'Refresh Git status before retrying the snapshot.',
    });
  }

  if (input.hasUnsavedEditorChanges) {
    disabledReasons.push({
      code: 'unsaved_editor_changes',
      message: 'Save the active Markdown file before creating a snapshot.',
    });
  }

  if (eligibleEntries.length === 0) {
    disabledReasons.push({
      code: 'no_changes',
      message: 'No workspace changes are available to snapshot.',
    });
  }

  return {
    canCreateSnapshot: disabledReasons.length === 0,
    eligibleEntries,
    disabledReasons,
  };
}

export function buildGitSnapshotRequest(input: {
  workspaceId: WorkspaceId;
  status: GitStatusSummary;
  files: readonly WorkspaceFile[];
  message: string;
}): GitSnapshotRequest | null {
  const message = input.message.trim();
  const expectedRepoToken = input.status.token ?? input.status.repositoryState.token ?? null;
  const eligibleEntries = getSnapshotEligibleEntries(input.status.entries);

  if (!message || !expectedRepoToken || eligibleEntries.length === 0) {
    return null;
  }

  const scopePaths = eligibleEntries.map((entry) => entry.relativePath);
  const scopedPathSet = new Set<WorkspaceRelativePath>(scopePaths);

  return {
    workspaceId: input.workspaceId,
    message,
    scopePaths,
    expectedRepoToken,
    expectedFileStates: input.files
      .filter((file) => scopedPathSet.has(file.relativePath))
      .map((file) => ({
        relativePath: file.relativePath,
        expectedVersion: file.version,
      })),
  };
}

export function gitOperationErrorTitle(code: GitOperationErrorCode): string {
  switch (code) {
    case 'identity_missing':
      return 'Git identity needed';
    case 'external_state_changed':
      return 'Git state changed';
    case 'no_changes':
      return 'No changes';
    case 'merge_conflict':
      return 'Merge conflict active';
    case 'detached_head':
      return 'Detached HEAD';
    case 'repository_corrupt':
    case 'bare_repository':
      return 'Repository unavailable';
    case 'git_unavailable':
      return 'Git unavailable';
    case 'permission_denied':
      return 'Permission needed';
    default:
      return 'Git action failed';
  }
}

function snapshotBlockedMessage(state: GitRepositoryStateKind): string {
  const policy = gitOperationPolicy(state, 'snapshot');

  if (policy.blockedBy === 'merge_conflict') {
    return 'Resolve merge conflicts before creating snapshots.';
  }

  if (policy.blockedBy === 'detached_head') {
    return 'Check out a branch before creating snapshots.';
  }

  if (policy.blockedBy === 'git_unavailable') {
    return 'Git is unavailable for this workspace.';
  }

  if (policy.blockedBy === 'repository_corrupt' || policy.blockedBy === 'bare_repository') {
    return 'The Git repository metadata cannot be read safely.';
  }

  if (policy.blockedBy === 'permission_denied') {
    return 'The workspace cannot be read or written with current permissions.';
  }

  if (policy.blockedBy === 'parent_repository') {
    return 'Create snapshots only from the selected local workspace repository.';
  }

  return 'Git snapshots are unavailable for this repository state.';
}

function sortStatusEntries(entries: readonly GitStatusEntry[]): GitStatusEntry[] {
  return [...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
