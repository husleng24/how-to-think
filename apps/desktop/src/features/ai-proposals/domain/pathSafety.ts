import type {
  ProposalValidationErrorCode,
  WorkspaceRelativePath,
} from './types';

export interface WorkspacePathValidationError {
  code: Extract<
    ProposalValidationErrorCode,
    'invalid_file_path' | 'out_of_workspace_file' | 'unsupported_file_type'
  >;
  message: string;
}

export type WorkspacePathValidationResult =
  | { ok: true; path: WorkspaceRelativePath }
  | { ok: false; error: WorkspacePathValidationError };

const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/;

export function validateWorkspaceRelativeMarkdownPath(
  path: unknown,
): WorkspacePathValidationResult {
  if (typeof path !== 'string' || path.trim().length === 0) {
    return invalidPath('Workspace-relative Markdown path is required.');
  }

  if (hasControlCharacter(path)) {
    return invalidPath('Workspace-relative path must not contain control characters.');
  }

  if (path.includes('\\')) {
    return invalidPath('Workspace-relative path must use / separators.');
  }

  if (
    path.startsWith('/') ||
    path.startsWith('//') ||
    path.startsWith('\\\\') ||
    WINDOWS_DRIVE_PREFIX_PATTERN.test(path)
  ) {
    return outsideWorkspace('Workspace-relative path must not be absolute.');
  }

  const segments = path.split('/');
  if (
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return outsideWorkspace('Workspace-relative path must not escape the workspace.');
  }

  const lowerPath = path.toLowerCase();
  if (!lowerPath.endsWith('.md') && !lowerPath.endsWith('.markdown')) {
    return {
      ok: false,
      error: {
        code: 'unsupported_file_type',
        message: 'AI proposals can only target Markdown files.',
      },
    };
  }

  return { ok: true, path };
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

function invalidPath(message: string): WorkspacePathValidationResult {
  return { ok: false, error: { code: 'invalid_file_path', message } };
}

function outsideWorkspace(message: string): WorkspacePathValidationResult {
  return { ok: false, error: { code: 'out_of_workspace_file', message } };
}
