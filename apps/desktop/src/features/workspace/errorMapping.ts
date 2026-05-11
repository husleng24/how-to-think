import type { SaveMarkdownMindMapResult } from '../../types/markdownLifecycle';
import type { SaveStatus, UserMessage, WorkspaceError } from './types';

export function mapWorkspaceError(error: unknown): UserMessage {
  const workspaceError = asWorkspaceError(error);

  if (!workspaceError) {
    return {
      title: 'Action failed',
      detail: error instanceof Error ? error.message : 'The desktop command failed unexpectedly.',
    };
  }

  const relativePath = workspaceError.relativePath;

  switch (workspaceError.code) {
    case 'version_conflict':
      return {
        title: 'External conflict',
        detail: pathDetail(relativePath, 'This file changed on disk. Reopen it or save a copy before continuing.'),
        relativePath,
      };
    case 'file_not_found':
      return {
        title: 'File missing',
        detail: pathDetail(relativePath, 'This Markdown file no longer exists in the workspace.'),
        relativePath,
      };
    case 'file_already_exists':
      return {
        title: 'File already exists',
        detail: pathDetail(relativePath, 'Choose a different Markdown file name.'),
        relativePath,
      };
    case 'invalid_relative_path':
    case 'path_outside_workspace':
    case 'unsupported_file_type':
      return {
        title: 'Invalid Markdown path',
        detail: 'Use a Markdown file path inside the selected workspace.',
        relativePath,
      };
    case 'workspace_missing':
    case 'workspace_not_directory':
    case 'invalid_workspace_path':
      return {
        title: 'Workspace unavailable',
        detail: 'Choose an existing folder that can be used as a workspace.',
      };
    case 'workspace_unwritable':
    case 'permission_denied':
      return {
        title: 'Permission needed',
        detail: pathDetail(relativePath, 'The selected workspace or file is not writable.'),
        relativePath,
      };
    case 'disk_full':
      return {
        title: 'Disk is full',
        detail: 'Free disk space and try saving again.',
        relativePath,
      };
    case 'restore_conflict':
      return {
        title: 'Restore blocked',
        detail: pathDetail(relativePath, workspaceError.message || 'Resolve the active file conflict before restoring.'),
        relativePath,
      };
    case 'external_state_changed':
      return {
        title: 'Git state changed',
        detail: 'Refresh Git status and try the Git action again.',
        relativePath,
      };
    case 'identity_missing':
      return {
        title: 'Git identity needed',
        detail: 'Configure a Git author name and email before creating snapshots.',
        relativePath,
      };
    case 'no_changes':
      return {
        title: 'No changes',
        detail: workspaceError.message || 'No workspace changes are available to snapshot.',
        relativePath,
      };
    case 'detached_head':
      return {
        title: 'Detached HEAD',
        detail: 'Check out a branch before creating snapshots or restoring files.',
        relativePath,
      };
    case 'git_unavailable':
      return {
        title: 'Git unavailable',
        detail: 'The desktop Git backend is unavailable for this workspace.',
        relativePath,
      };
    case 'repository_corrupt':
    case 'bare_repository':
      return {
        title: 'Repository unavailable',
        detail: 'The Git repository metadata cannot be read safely.',
        relativePath,
      };
    case 'invalid_ref':
    case 'file_not_in_history':
      return {
        title: 'Git version unavailable',
        detail: pathDetail(relativePath, workspaceError.message || 'Choose another history entry.'),
        relativePath,
      };
    case 'merge_conflict':
      return {
        title: 'Merge conflict active',
        detail: 'Resolve the Git conflict before creating snapshots or restoring files.',
        relativePath,
      };
    default:
      return {
        title: 'Action failed',
        detail: workspaceError.message || 'The desktop command failed unexpectedly.',
        relativePath,
      };
  }
}

export function saveStatusFromError(error: unknown): SaveStatus {
  const message = mapWorkspaceError(error);
  const workspaceError = asWorkspaceError(error);

  if (workspaceError?.code === 'version_conflict') {
    return {
      kind: 'conflict',
      message: message.detail,
    };
  }

  if (workspaceError?.code === 'file_not_found') {
    return {
      kind: 'missing',
      message: message.detail,
    };
  }

  return {
    kind: 'saveFailed',
    message: message.detail,
  };
}

export function saveStatusFromBlockedResult(result: SaveMarkdownMindMapResult): SaveStatus {
  if (result.status === 'lossySaveConfirmationRequired') {
    return {
      kind: 'saveFailed',
      message: 'Saving needs confirmation because some Markdown content may be rewritten.',
      diagnostics: result.diagnostics,
    };
  }

  if (result.status === 'lossySaveBlocked') {
    return {
      kind: 'saveFailed',
      message: 'Saving was blocked to avoid losing Markdown content.',
      diagnostics: result.diagnostics,
    };
  }

  return {
    kind: 'saveFailed',
    message: 'The document could not be serialized for saving.',
      diagnostics: result.diagnostics,
  };
}

export function asWorkspaceError(error: unknown): WorkspaceError | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as Partial<WorkspaceError>;

  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') {
    return null;
  }

  return {
    code: candidate.code,
    message: candidate.message,
    recoverable: Boolean(candidate.recoverable),
    operation: typeof candidate.operation === 'string' ? candidate.operation : 'openFile',
    relativePath:
      typeof candidate.relativePath === 'string' ? candidate.relativePath : undefined,
    details:
      candidate.details && typeof candidate.details === 'object' ? candidate.details : undefined,
  };
}

function pathDetail(relativePath: string | undefined, fallback: string): string {
  return relativePath ? `${fallback} File: ${relativePath}` : fallback;
}
