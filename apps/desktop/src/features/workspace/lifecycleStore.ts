import type { MindMapDocument as EditorMindMapDocument } from '../../domain/mindMap';
import type {
  MarkdownMindMapDocument,
  SaveReason,
  WorkspaceFile,
  WorkspaceRelativePath,
} from '../../types/markdownLifecycle';
import { mapWorkspaceError, saveStatusFromBlockedResult, saveStatusFromError } from './errorMapping';
import type {
  ActiveDocumentState,
  OpenedDocumentPayload,
  PendingDocumentAction,
  SaveRequestState,
  SaveStatus,
  SaveSucceededPayload,
  UnsavedPromptState,
  WorkspaceLifecycleState,
  WorkspaceSession,
} from './types';

export type WorkspaceLifecycleAction =
  | { type: 'startup-loading' }
  | { type: 'startup-empty' }
  | { type: 'workspace-loaded'; session: WorkspaceSession }
  | { type: 'startup-failed'; error: unknown }
  | { type: 'operation-started' }
  | { type: 'operation-failed'; error: unknown }
  | { type: 'files-refreshed'; files: WorkspaceFile[] }
  | { type: 'document-opened'; payload: OpenedDocumentPayload }
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

    case 'operation-failed':
      return {
        ...state,
        isBusy: false,
        lastError: mapWorkspaceError(action.error),
      };

    case 'files-refreshed':
      return {
        ...state,
        files: sortWorkspaceFiles(action.files),
        isBusy: false,
      };

    case 'document-opened': {
      const relativePath = action.payload.result.snapshot.relativePath;
      const active: ActiveDocumentState = {
        key: documentKey(relativePath, action.payload.result.snapshot.openedAt),
        snapshot: action.payload.result.snapshot,
        markdownDocument: action.payload.result.document,
        editorDocument: action.payload.editorDocument,
        savedContentRevision: action.payload.contentRevision,
        contentRevision: action.payload.contentRevision,
        inFlightSave: null,
      };

      return {
        ...state,
        active,
        files: sortWorkspaceFiles(action.payload.result.files),
        recentFiles: rememberRecentFile(state.recentFiles, relativePath),
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
        savedContentRevision: request.revision,
        contentRevision: currentContentRevision,
        inFlightSave: null,
      };

      return {
        ...state,
        active,
        files: result.files && result.files.length > 0 ? sortWorkspaceFiles(result.files) : state.files,
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

function sortWorkspaceFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  return [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
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
