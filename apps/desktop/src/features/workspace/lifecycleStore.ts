import type { MindMapDocument as EditorMindMapDocument } from '../../domain/mindMap';
import type {
  LinkIndexSnapshot,
  MarkdownMindMapDocument,
  SaveReason,
  WorkspaceFile,
  WorkspaceRelativePath,
} from '../../types/markdownLifecycle';
import {
  gitBlockedStateForRepository,
  gitBlockedStateFromError,
} from '../git-service';
import type {
  GitOperationError,
  GitServiceOperation,
  GitSnapshotResult,
  GitStatusSummary,
} from '../git-service';
import { mapWorkspaceError, saveStatusFromBlockedResult, saveStatusFromError } from './errorMapping';
import type {
  ActiveDocumentState,
  ExternalChangeBatch,
  OpenedDocumentPayload,
  PendingDocumentAction,
  SaveRequestState,
  SaveStatus,
  SaveSucceededPayload,
  UnsavedPromptState,
  WorkspaceExternalSyncStatus,
  WorkspaceLifecycleState,
  WorkspaceSession,
} from './types';

export type WorkspaceLifecycleAction =
  | { type: 'startup-loading' }
  | { type: 'startup-empty' }
  | { type: 'workspace-loaded'; session: WorkspaceSession }
  | { type: 'startup-failed'; error: unknown }
  | { type: 'operation-started' }
  | { type: 'operation-finished' }
  | { type: 'operation-failed'; error: unknown }
  | { type: 'files-refreshed'; files: WorkspaceFile[] }
  | { type: 'git-status-refreshed'; status: GitStatusSummary }
  | { type: 'git-snapshot-created'; result: GitSnapshotResult }
  | { type: 'external-change-detected'; batch: ExternalChangeBatch }
  | { type: 'document-opened'; payload: OpenedDocumentPayload }
  | {
      type: 'document-restored';
      payload: OpenedDocumentPayload;
      gitStatus: WorkspaceLifecycleState['gitStatus'];
    }
  | {
      type: 'document-edited';
      documentKey: string;
      editorDocument: EditorMindMapDocument;
      contentRevision: number;
    }
  | { type: 'save-started'; request: SaveRequestState }
  | { type: 'save-succeeded'; payload: SaveSucceededPayload }
  | { type: 'save-blocked'; request: SaveRequestState; result: Parameters<typeof saveStatusFromBlockedResult>[0] }
  | { type: 'save-failed'; request: SaveRequestState; error: unknown }
  | {
      type: 'document-renamed';
      newRelativePath: WorkspaceRelativePath;
      fileVersion: ActiveDocumentState['snapshot']['version'];
      files: WorkspaceFile[];
      editorDocument: EditorMindMapDocument;
      markdownDocument: MarkdownMindMapDocument;
    }
  | { type: 'document-deleted'; files: WorkspaceFile[] }
  | { type: 'document-closed' }
  | { type: 'prompt-opened'; prompt: UnsavedPromptState }
  | { type: 'prompt-closed' }
  | { type: 'error-cleared' };

export const initialWorkspaceLifecycleState: WorkspaceLifecycleState = {
  startupStatus: 'loading',
  workspace: null,
  files: [],
  active: null,
  recentFiles: [],
  saveStatus: {
    kind: 'saved',
    message: 'No file open',
  },
  gitStatus: null,
  gitBlockedState: null,
  externalSyncStatus: noWorkspaceExternalSyncStatus(),
  prompt: null,
  lastError: null,
  isBusy: false,
};

export function workspaceLifecycleReducer(
  state: WorkspaceLifecycleState,
  action: WorkspaceLifecycleAction,
): WorkspaceLifecycleState {
  switch (action.type) {
    case 'startup-loading':
      return {
        ...state,
        startupStatus: 'loading',
        lastError: null,
      };

    case 'startup-empty':
      return {
        ...state,
        startupStatus: 'ready',
        workspace: null,
        files: [],
        active: null,
        saveStatus: noFileStatus(),
        gitStatus: null,
        gitBlockedState: null,
        externalSyncStatus: noWorkspaceExternalSyncStatus(),
        isBusy: false,
      };

    case 'workspace-loaded':
      return {
        ...state,
        startupStatus: 'ready',
        workspace: action.session.workspace,
        files: sortWorkspaceFiles(action.session.files),
        active: null,
        saveStatus: noFileStatus(),
        gitStatus: null,
        gitBlockedState: null,
        externalSyncStatus: externalSyncStatusForWorkspace(action.session.files),
        lastError: null,
        isBusy: false,
      };

    case 'startup-failed':
      return {
        ...state,
        startupStatus: 'error',
        lastError: mapWorkspaceError(action.error),
        isBusy: false,
      };

    case 'operation-started':
      return {
        ...state,
        isBusy: true,
        lastError: null,
      };

    case 'operation-finished':
      return {
        ...state,
        isBusy: false,
      };

    case 'operation-failed':
      return {
        ...state,
        isBusy: false,
        gitBlockedState: gitBlockedStateFromUnknown(action.error) ?? state.gitBlockedState,
        lastError: mapWorkspaceError(action.error),
      };

    case 'files-refreshed':
      return {
        ...state,
        files: sortWorkspaceFiles(action.files),
        externalSyncStatus: externalSyncStatusForWorkspace(action.files, state.externalSyncStatus),
        isBusy: false,
      };

    case 'git-status-refreshed':
      if (state.workspace?.id !== action.status.workspaceId) {
        return state;
      }

      return {
        ...state,
        gitStatus: action.status,
        gitBlockedState: gitBlockedStateForRepository(action.status.repositoryState, 'refresh'),
      };

    case 'git-snapshot-created':
      if (state.workspace?.id !== action.result.workspaceId) {
        return state;
      }

      return {
        ...state,
        gitStatus: action.result.status,
        gitBlockedState: gitBlockedStateForRepository(action.result.repositoryState, 'snapshot'),
        lastError: null,
        isBusy: false,
      };

    case 'external-change-detected':
      return applyExternalChangeBatch(state, action.batch);

    case 'document-opened': {
      const relativePath = action.payload.result.snapshot.relativePath;
      const active: ActiveDocumentState = {
        key: documentKey(relativePath, action.payload.result.snapshot.openedAt),
        snapshot: action.payload.result.snapshot,
        markdownDocument: action.payload.result.document,
        editorDocument: action.payload.editorDocument,
        linkIndex: action.payload.result.linkIndex,
        savedContentRevision: action.payload.contentRevision,
        contentRevision: action.payload.contentRevision,
        inFlightSave: null,
      };

      return {
        ...state,
        active,
        files: sortWorkspaceFiles(action.payload.result.files),
        recentFiles: rememberRecentFile(state.recentFiles, relativePath),
        externalSyncStatus: externalSyncStatusForOpenDocument(
          action.payload.result.linkIndex,
          action.payload.result.document.diagnostics.length,
          state.externalSyncStatus,
        ),
        saveStatus: {
          kind: 'saved',
          message: 'Saved',
          savedAt: action.payload.result.snapshot.openedAt,
        },
        prompt: null,
        lastError: null,
        isBusy: false,
      };
    }

    case 'document-restored': {
      const relativePath = action.payload.result.snapshot.relativePath;
      const active: ActiveDocumentState = {
        key: documentKey(relativePath, action.payload.result.snapshot.openedAt),
        snapshot: action.payload.result.snapshot,
        markdownDocument: action.payload.result.document,
        editorDocument: action.payload.editorDocument,
        linkIndex: action.payload.result.linkIndex,
        savedContentRevision: action.payload.contentRevision,
        contentRevision: action.payload.contentRevision,
        inFlightSave: null,
      };

      return {
        ...state,
        active,
        files: sortWorkspaceFiles(action.payload.result.files),
        recentFiles: rememberRecentFile(state.recentFiles, relativePath),
        externalSyncStatus: externalSyncStatusForOpenDocument(
          action.payload.result.linkIndex,
          action.payload.result.document.diagnostics.length,
          state.externalSyncStatus,
        ),
        saveStatus: {
          kind: 'saved',
          message: 'Restored from Git history',
          savedAt: action.payload.result.snapshot.openedAt,
        },
        gitStatus: action.gitStatus,
        gitBlockedState: action.gitStatus
          ? gitBlockedStateForRepository(action.gitStatus.repositoryState, 'restore')
          : null,
        prompt: null,
        lastError: null,
        isBusy: false,
      };
    }

    case 'document-edited': {
      if (!state.active || state.active.key !== action.documentKey) {
        return state;
      }

      const active = {
        ...state.active,
        editorDocument: action.editorDocument,
        contentRevision: action.contentRevision,
      };
      const hasUnsavedChanges = active.contentRevision !== active.savedContentRevision;

      return {
        ...state,
        active,
        saveStatus:
          hasUnsavedChanges && state.saveStatus.kind !== 'saving'
            ? unsavedStatus(active.snapshot.relativePath)
            : state.saveStatus,
      };
    }

    case 'save-started':
      if (!state.active || state.active.key !== action.request.documentKey) {
        return state;
      }

      return {
        ...state,
        active: {
          ...state.active,
          inFlightSave: action.request,
        },
        saveStatus: {
          kind: 'saving',
          message: action.request.reason === 'manual' ? 'Saving...' : 'Autosaving...',
          reason: action.request.reason,
        },
        lastError: null,
      };

    case 'save-succeeded': {
      const { request, result, markdownDocument, editorDocument, currentContentRevision } =
        action.payload;

      if (!state.active || state.active.key !== request.documentKey) {
        return state;
      }

      const isCurrentRevisionSaved = currentContentRevision === request.revision;
      const active: ActiveDocumentState = {
        ...state.active,
        snapshot: {
          ...state.active.snapshot,
          relativePath: result.save.relativePath,
          version: result.save.version,
        },
        markdownDocument,
        editorDocument,
        linkIndex: result.linkIndex ?? state.active.linkIndex,
        savedContentRevision: request.revision,
        contentRevision: currentContentRevision,
        inFlightSave: null,
      };

      return {
        ...state,
        active,
        files: result.files && result.files.length > 0 ? sortWorkspaceFiles(result.files) : state.files,
        externalSyncStatus: externalSyncStatusForOpenDocument(
          result.linkIndex ?? state.active.linkIndex,
          result.diagnostics.length,
          state.externalSyncStatus,
        ),
        saveStatus: isCurrentRevisionSaved
          ? {
              kind: 'saved',
              message: 'Saved',
              savedAt: result.save.savedAt,
              diagnostics: result.diagnostics,
            }
          : unsavedStatus(active.snapshot.relativePath),
      };
    }

    case 'save-blocked':
      if (!state.active || state.active.key !== action.request.documentKey) {
        return state;
      }

      return {
        ...state,
        active: {
          ...state.active,
          inFlightSave: null,
        },
        externalSyncStatus: staleExternalSyncStatus(state.externalSyncStatus, action.request.relativePath),
        saveStatus: saveStatusFromBlockedResult(action.result),
      };

    case 'save-failed':
      if (!state.active || state.active.key !== action.request.documentKey) {
        return state;
      }

      return {
        ...state,
        active: {
          ...state.active,
          inFlightSave: null,
        },
        externalSyncStatus: staleExternalSyncStatus(state.externalSyncStatus, action.request.relativePath),
        saveStatus: saveStatusFromError(action.error),
        lastError: mapWorkspaceError(action.error),
      };

    case 'document-renamed':
      if (!state.active) {
        return state;
      }

      return {
        ...state,
        active: {
          ...state.active,
          key: documentKey(action.newRelativePath, state.active.snapshot.openedAt),
          snapshot: {
            ...state.active.snapshot,
            relativePath: action.newRelativePath,
            version: action.fileVersion,
          },
          markdownDocument: action.markdownDocument,
          editorDocument: action.editorDocument,
        },
        files: sortWorkspaceFiles(action.files),
        recentFiles: rememberRecentFile(state.recentFiles, action.newRelativePath),
        saveStatus:
          state.active.contentRevision === state.active.savedContentRevision
            ? {
                kind: 'saved',
                message: 'Saved',
                savedAt: new Date().toISOString(),
              }
            : unsavedStatus(action.newRelativePath),
        isBusy: false,
      };

    case 'document-deleted':
      return {
        ...state,
        active: null,
        files: sortWorkspaceFiles(action.files),
        saveStatus: noFileStatus(),
        isBusy: false,
      };

    case 'document-closed':
      return {
        ...state,
        active: null,
        saveStatus: noFileStatus(),
        prompt: null,
        isBusy: false,
      };

    case 'prompt-opened':
      return {
        ...state,
        prompt: action.prompt,
      };

    case 'prompt-closed':
      return {
        ...state,
        prompt: null,
      };

    case 'error-cleared':
      return {
        ...state,
        lastError: null,
      };
  }
}

export function hasUnsavedChanges(state: WorkspaceLifecycleState): boolean {
  return Boolean(
    state.active && state.active.contentRevision !== state.active.savedContentRevision,
  );
}

export function shouldPromptForAction(
  state: WorkspaceLifecycleState,
  action: PendingDocumentAction,
): boolean {
  void action;
  return hasUnsavedChanges(state) || Boolean(state.active?.inFlightSave);
}

export function createUnsavedPrompt(
  state: WorkspaceLifecycleState,
  action: PendingDocumentAction,
): UnsavedPromptState {
  const fileLabel = state.active?.snapshot.relativePath ?? 'this file';
  const isSaving = Boolean(state.active?.inFlightSave);

  return {
    action,
    title: 'Unsaved changes',
    message: isSaving
      ? `A save is still in progress for ${fileLabel}. Wait for it to finish, discard changes, or cancel.`
      : `Save changes to ${fileLabel} before continuing?`,
    saveDisabled: isSaving,
  };
}

export function createSaveRequest(
  active: ActiveDocumentState,
  reason: SaveReason,
): SaveRequestState {
  return {
    documentKey: active.key,
    relativePath: active.snapshot.relativePath,
    revision: active.contentRevision,
    reason,
  };
}

function applyExternalChangeBatch(
  state: WorkspaceLifecycleState,
  batch: ExternalChangeBatch,
): WorkspaceLifecycleState {
  if (state.workspace?.id !== batch.workspaceId) {
    return state;
  }

  const activeEvent = state.active
    ? batch.events.find((event) => {
        if (event.relativePath === state.active?.snapshot.relativePath) {
          return true;
        }

        return event.previousRelativePath === state.active?.snapshot.relativePath;
      })
    : undefined;
  const gitBlockedState = batch.gitStatus
    ? gitBlockedStateForRepository(batch.gitStatus.repositoryState, 'refresh')
    : state.gitBlockedState;
  const externalSyncStatus = externalSyncStatusFromBatch(
    batch,
    state.active?.linkIndex.diagnostics.length ?? 0,
  );

  if (!state.active || !activeEvent) {
    return {
      ...state,
      files: sortWorkspaceFiles([...batch.files]),
      gitStatus: batch.gitStatus ?? state.gitStatus,
      gitBlockedState,
      externalSyncStatus,
      isBusy: false,
    };
  }

  const saveStatus = saveStatusForExternalChange(state.active, activeEvent.kind);

  return {
    ...state,
    files: sortWorkspaceFiles([...batch.files]),
    saveStatus: saveStatus ?? state.saveStatus,
    gitStatus: batch.gitStatus ?? state.gitStatus,
    gitBlockedState,
    externalSyncStatus:
      saveStatus?.kind === 'conflict' || saveStatus?.kind === 'missing'
        ? staleExternalSyncStatus(externalSyncStatus, state.active.snapshot.relativePath)
        : externalSyncStatus,
    isBusy: false,
  };
}

function saveStatusForExternalChange(
  active: ActiveDocumentState,
  kind: ExternalChangeBatch['events'][number]['kind'],
): SaveStatus | null {
  if (kind === 'modified') {
    return {
      kind: 'conflict',
      message: `External changes detected in ${active.snapshot.relativePath}`,
    };
  }

  if (kind === 'deleted' || kind === 'renamed') {
    return {
      kind: 'missing',
      message: `The active file moved or was deleted: ${active.snapshot.relativePath}`,
    };
  }

  return null;
}

function gitBlockedStateFromUnknown(error: unknown) {
  return gitBlockedStateFromError(asGitOperationError(error));
}

function asGitOperationError(error: unknown): GitOperationError | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as Partial<GitOperationError>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') {
    return null;
  }

  return {
    code: candidate.code as GitOperationError['code'],
    operation: isGitServiceOperation(candidate.operation) ? candidate.operation : 'refresh',
    message: candidate.message,
    recoverable: Boolean(candidate.recoverable),
    relativePath:
      typeof candidate.relativePath === 'string' ? candidate.relativePath : undefined,
    details:
      candidate.details && typeof candidate.details === 'object' ? candidate.details : undefined,
  };
}

function isGitServiceOperation(value: unknown): value is GitServiceOperation {
  return (
    value === 'detect' ||
    value === 'init' ||
    value === 'status' ||
    value === 'snapshot' ||
    value === 'history' ||
    value === 'diff' ||
    value === 'restore' ||
    value === 'refresh'
  );
}

function sortWorkspaceFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  return [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function noWorkspaceExternalSyncStatus(): WorkspaceExternalSyncStatus {
  return {
    watch: {
      kind: 'inactive',
      watcherActive: false,
      message: 'No workspace is open.',
    },
    fileIndex: {
      kind: 'idle',
      indexedFileCount: 0,
      diagnosticCount: 0,
      message: 'Open a workspace to build the Markdown file index.',
    },
  };
}

function externalSyncStatusForWorkspace(
  files: readonly WorkspaceFile[],
  previous?: WorkspaceExternalSyncStatus,
): WorkspaceExternalSyncStatus {
  return {
    watch: previous?.watch ?? {
      kind: 'checking',
      watcherActive: false,
      message: 'Starting workspace change detection.',
    },
    fileIndex: {
      kind: files.length > 0 ? 'ready' : 'idle',
      indexedFileCount: files.length,
      diagnosticCount: previous?.fileIndex.diagnosticCount ?? 0,
      message:
        files.length > 0
          ? `${files.length} Markdown file${files.length === 1 ? '' : 's'} indexed.`
          : 'No Markdown files are indexed yet.',
      indexedAt: previous?.fileIndex.indexedAt,
    },
  };
}

function externalSyncStatusForOpenDocument(
  linkIndex: LinkIndexSnapshot,
  documentDiagnosticCount: number,
  previous?: WorkspaceExternalSyncStatus,
): WorkspaceExternalSyncStatus {
  const diagnosticCount = documentDiagnosticCount + linkIndex.diagnostics.length;

  return {
    watch: previous?.watch ?? {
      kind: 'checking',
      watcherActive: false,
      message: 'Starting workspace change detection.',
    },
    fileIndex: {
      kind: diagnosticCount > 0 ? 'degraded' : 'ready',
      indexedFileCount: linkIndex.files.length,
      diagnosticCount,
      message:
        diagnosticCount > 0
          ? `${diagnosticCount} Markdown or link diagnostic${diagnosticCount === 1 ? '' : 's'} need review.`
          : `${linkIndex.files.length} indexed Markdown file${linkIndex.files.length === 1 ? '' : 's'} ready.`,
      indexedAt: previous?.fileIndex.indexedAt,
    },
  };
}

function externalSyncStatusFromBatch(
  batch: ExternalChangeBatch,
  activeLinkDiagnosticCount: number,
): WorkspaceExternalSyncStatus {
  const diagnosticCount = activeLinkDiagnosticCount + (batch.watchError ? 1 : 0);
  const watchKind = batch.watchError
    ? 'error'
    : batch.watcherActive
      ? 'watching'
      : 'degraded';

  return {
    watch: {
      kind: watchKind,
      watcherActive: batch.watcherActive,
      message: watchStatusMessage(watchKind, batch.source),
      checkedAt: batch.detectedAt,
      error: batch.watchError ?? null,
    },
    fileIndex: {
      kind: diagnosticCount > 0 ? 'degraded' : 'ready',
      indexedFileCount: batch.files.length,
      diagnosticCount,
      message:
        diagnosticCount > 0
          ? `${diagnosticCount} workspace sync diagnostic${diagnosticCount === 1 ? '' : 's'} need review.`
          : `${batch.files.length} Markdown file${batch.files.length === 1 ? '' : 's'} indexed after ${batch.source}.`,
      indexedAt: batch.detectedAt,
    },
  };
}

function staleExternalSyncStatus(
  previous: WorkspaceExternalSyncStatus | undefined,
  relativePath: WorkspaceRelativePath,
): WorkspaceExternalSyncStatus | undefined {
  if (!previous) {
    return previous;
  }

  return {
    ...previous,
    fileIndex: {
      ...previous.fileIndex,
      kind: 'stale',
      message: `File index needs refresh before saving ${relativePath}.`,
    },
  };
}

function watchStatusMessage(
  kind: WorkspaceExternalSyncStatus['watch']['kind'],
  source: ExternalChangeBatch['source'],
): string {
  if (kind === 'watching') {
    return source === 'watcher'
      ? 'Live workspace watcher is active.'
      : 'Workspace state refreshed while watcher stays active.';
  }

  if (kind === 'error') {
    return 'Workspace watcher reported an error; manual refresh is available.';
  }

  return 'Workspace watcher is degraded; using refresh checks.';
}

function rememberRecentFile(
  recentFiles: WorkspaceRelativePath[],
  relativePath: WorkspaceRelativePath,
): WorkspaceRelativePath[] {
  return [relativePath, ...recentFiles.filter((recent) => recent !== relativePath)].slice(0, 8);
}

function documentKey(relativePath: WorkspaceRelativePath, openedAt: string): string {
  return `${relativePath}:${openedAt}`;
}

function noFileStatus(): SaveStatus {
  return {
    kind: 'saved',
    message: 'No file open',
  };
}

function unsavedStatus(relativePath: WorkspaceRelativePath): SaveStatus {
  return {
    kind: 'unsaved',
    message: `Unsaved changes in ${relativePath}`,
  };
}
