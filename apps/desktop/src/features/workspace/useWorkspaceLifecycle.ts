import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import type { MindMapDocument as EditorMindMapDocument } from '../../domain/mindMap';
import { mergeEditorDocumentIntoMarkdownDocument } from '../../services/markdownLifecycle';
import type { SaveReason, WorkspaceRelativePath } from '../../types/markdownLifecycle';
import {
  buildGitSnapshotRequest,
  getGitSnapshotEligibility,
  isRepositoryTokenStale,
} from '../git-service';
import { openDocumentForEditor, isSavedMarkdownResult, tauriWorkspaceCommands } from './commands';
import {
  createSaveRequest,
  createUnsavedPrompt,
  hasUnsavedChanges,
  initialWorkspaceLifecycleState,
  shouldPromptForAction,
  workspaceLifecycleReducer,
} from './lifecycleStore';
import type {
  PendingDocumentAction,
  RestoreActiveFromGitInput,
  ExternalChangeBatch,
  GitSnapshotActionResult,
  WorkspaceCommands,
  WorkspaceLifecycleState,
} from './types';

export interface UseWorkspaceLifecycleOptions {
  commands?: WorkspaceCommands;
  autoOpenLastFile?: boolean;
}

export interface WorkspaceLifecycleActions {
  openWorkspace(path: string): Promise<void>;
  createWorkspace(path: string): Promise<void>;
  refreshFiles(): Promise<void>;
  refreshGitState(): Promise<void>;
  enableGit(): Promise<boolean>;
  createGitSnapshot(message: string): Promise<GitSnapshotActionResult>;
  requestCreateFile(relativePath: WorkspaceRelativePath): Promise<void>;
  requestOpenFile(relativePath: WorkspaceRelativePath): Promise<void>;
  requestRenameActive(newRelativePath: WorkspaceRelativePath): Promise<void>;
  requestDeleteActive(): Promise<void>;
  requestCloseActive(): void;
  restoreActiveFromGit(input: RestoreActiveFromGitInput): Promise<boolean>;
  continuePromptAfterSave(): Promise<void>;
  discardPrompt(): Promise<void>;
  cancelPrompt(): void;
  clearError(): void;
  recordEditorChange(input: {
    documentKey: string;
    editorDocument: EditorMindMapDocument;
    contentRevision: number;
  }): void;
  saveActive(
    reason: SaveReason,
    editorDocument?: EditorMindMapDocument,
    contentRevision?: number,
  ): Promise<boolean>;
}

export function useWorkspaceLifecycle(
  options: UseWorkspaceLifecycleOptions = {},
): [WorkspaceLifecycleState, WorkspaceLifecycleActions] {
  const commands = options.commands ?? tauriWorkspaceCommands;
  const autoOpenLastFile = options.autoOpenLastFile ?? true;
  const [state, dispatch] = useReducer(
    workspaceLifecycleReducer,
    initialWorkspaceLifecycleState,
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refreshGitStateDirect = useCallback(
    async (workspaceId: string, options: { swallowErrors?: boolean } = {}) => {
      try {
        const status = await commands.refreshGitState(workspaceId);
        dispatch({ type: 'git-status-refreshed', status });
        return status;
      } catch (error) {
        if (options.swallowErrors === false) {
          throw error;
        }

        return null;
      }
    },
    [commands],
  );

  const refreshGitStateForCurrentWorkspace = useCallback(async () => {
    const workspaceId = stateRef.current.workspace?.id;

    if (!workspaceId) {
      return;
    }

    dispatch({ type: 'operation-started' });

    try {
      await refreshGitStateDirect(workspaceId, { swallowErrors: false });
      dispatch({ type: 'operation-finished' });
    } catch (error) {
      dispatch({ type: 'operation-failed', error });
    }
  }, [refreshGitStateDirect]);

  const openFileDirect = useCallback(
    async (workspaceId: string, relativePath: WorkspaceRelativePath) => {
      dispatch({ type: 'operation-started' });

      try {
        const payload = await openDocumentForEditor(commands, workspaceId, relativePath);
        dispatch({ type: 'document-opened', payload });
        void refreshGitStateDirect(workspaceId);
        await commands.rememberLastOpenedFile(workspaceId, relativePath);
      } catch (error) {
        dispatch({ type: 'operation-failed', error });
      }
    },
    [commands, refreshGitStateDirect],
  );

  const loadSession = useCallback(
    async (sessionLoader: () => Promise<Awaited<ReturnType<WorkspaceCommands['loadRememberedWorkspace']>>>) => {
      dispatch({ type: 'operation-started' });

      try {
        const session = await sessionLoader();

        if (!session) {
          dispatch({ type: 'startup-empty' });
          return;
        }

        dispatch({ type: 'workspace-loaded', session });
        void refreshGitStateDirect(session.workspace.id);

        if (autoOpenLastFile && session.lastOpenedFile) {
          await openFileDirect(session.workspace.id, session.lastOpenedFile);
        }
      } catch (error) {
        dispatch({ type: 'startup-failed', error });
      }
    },
    [autoOpenLastFile, openFileDirect, refreshGitStateDirect],
  );

  useEffect(() => {
    dispatch({ type: 'startup-loading' });
    void loadSession(() => commands.loadRememberedWorkspace());
  }, [commands, loadSession]);

  useEffect(() => {
    const workspaceId = state.workspace?.id;
    if (!workspaceId) {
      return undefined;
    }

    const unlistenPromise = import('@tauri-apps/api/event').then(({ listen }) =>
      listen<ExternalChangeBatch>('workspace://external-change', (event) => {
        if (event.payload.workspaceId === workspaceId) {
          dispatch({ type: 'external-change-detected', batch: event.payload });
        }
      }),
    );

    void commands
      .startWorkspaceChangeDetection(workspaceId)
      .then((batch) => dispatch({ type: 'external-change-detected', batch }))
      .catch(() => undefined);

    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined);
      void commands.stopWorkspaceChangeDetection(workspaceId).catch(() => undefined);
    };
  }, [commands, state.workspace?.id]);

  useEffect(() => {
    const refreshExternalState = () => {
      const workspaceId = stateRef.current.workspace?.id;
      if (!workspaceId) {
        return;
      }

      void commands
        .refreshWorkspaceExternalChanges(workspaceId)
        .then((batch) => dispatch({ type: 'external-change-detected', batch }))
        .catch(() => {
          void refreshGitStateDirect(workspaceId);
        });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshExternalState();
      }
    };

    window.addEventListener('focus', refreshExternalState);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', refreshExternalState);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [commands, refreshGitStateDirect]);

  const performAction = useCallback(
    async (action: PendingDocumentAction, bypassGuard = false) => {
      const current = stateRef.current;

      if (!bypassGuard && shouldPromptForAction(current, action)) {
        dispatch({ type: 'prompt-opened', prompt: createUnsavedPrompt(current, action) });
        return;
      }

      if (!current.workspace) {
        return;
      }

      if (action.type === 'open-file') {
        await openFileDirect(current.workspace.id, action.relativePath);
        return;
      }

      if (action.type === 'create-file') {
        dispatch({ type: 'operation-started' });

        try {
          await commands.createMarkdownDocument(
            current.workspace.id,
            action.relativePath,
            initialMarkdownForPath(action.relativePath),
          );
          await openFileDirect(current.workspace.id, action.relativePath);
        } catch (error) {
          dispatch({ type: 'operation-failed', error });
        }
        return;
      }

      const active = stateRef.current.active;
      if (!active) {
        return;
      }

      if (action.type === 'rename-file') {
        dispatch({ type: 'operation-started' });

        try {
          const result = await commands.renameMarkdownDocument({
            workspaceId: current.workspace.id,
            relativePath: active.snapshot.relativePath,
            newRelativePath: action.newRelativePath,
            expectedVersion: active.snapshot.version,
          });
          const editorDocument = {
            ...active.editorDocument,
            id: result.newRelativePath,
            sourcePath: result.newRelativePath,
          };
          const markdownDocument = {
            ...active.markdownDocument,
            sourcePath: result.newRelativePath,
          };

          dispatch({
            type: 'document-renamed',
            newRelativePath: result.newRelativePath,
            fileVersion: result.file.version,
            files: result.files,
            editorDocument,
            markdownDocument,
          });
          await commands.rememberLastOpenedFile(current.workspace.id, result.newRelativePath);
          void refreshGitStateDirect(current.workspace.id);
        } catch (error) {
          dispatch({ type: 'operation-failed', error });
        }
        return;
      }

      if (action.type === 'delete-file') {
        dispatch({ type: 'operation-started' });

        try {
          const result = await commands.deleteMarkdownDocument({
            workspaceId: current.workspace.id,
            relativePath: active.snapshot.relativePath,
            expectedVersion: active.snapshot.version,
          });
          dispatch({ type: 'document-deleted', files: result.files });
          void refreshGitStateDirect(current.workspace.id);
        } catch (error) {
          dispatch({ type: 'operation-failed', error });
        }
        return;
      }

      dispatch({ type: 'document-closed' });
    },
    [commands, openFileDirect, refreshGitStateDirect],
  );

  const saveActive = useCallback(
    async (
      reason: SaveReason,
      providedEditorDocument?: EditorMindMapDocument,
      providedContentRevision?: number,
    ) => {
      const current = stateRef.current;
      const active = current.active;

      if (!current.workspace || !active || active.inFlightSave) {
        return false;
      }

      const editorDocument = providedEditorDocument ?? active.editorDocument;
      const contentRevision = providedContentRevision ?? active.contentRevision;
      const request = createSaveRequest(
        {
          ...active,
          editorDocument,
          contentRevision,
        },
        reason,
      );
      const markdownDocument = mergeEditorDocumentIntoMarkdownDocument(
        editorDocument,
        active.markdownDocument,
      );

      dispatch({ type: 'save-started', request });

      try {
        const result = await commands.saveMarkdownMindMap({
          workspaceId: current.workspace.id,
          relativePath: active.snapshot.relativePath,
          expectedVersion: active.snapshot.version,
          document: markdownDocument,
          reason,
        });

        if (!isSavedMarkdownResult(result)) {
          dispatch({ type: 'save-blocked', request, result });
          return false;
        }

        const latestActive =
          stateRef.current.active?.key === request.documentKey ? stateRef.current.active : active;
        const currentContentRevision = latestActive.contentRevision;
        const currentEditorDocument = latestActive.editorDocument;
        const savedMarkdownDocument = {
          ...markdownDocument,
          sourcePath: result.save.relativePath,
        };

        dispatch({
          type: 'save-succeeded',
          payload: {
            request,
            result,
            markdownDocument: savedMarkdownDocument,
            editorDocument: currentEditorDocument,
            currentContentRevision,
          },
        });
        void refreshGitStateDirect(current.workspace.id);

        return currentContentRevision === request.revision;
      } catch (error) {
        dispatch({ type: 'save-failed', request, error });
        return false;
      }
    },
    [commands, refreshGitStateDirect],
  );

  const restoreActiveFromGit = useCallback(
    async (input: RestoreActiveFromGitInput) => {
      const current = stateRef.current;
      const active = current.active;

      if (!current.workspace || !active || active.inFlightSave) {
        return false;
      }

      if (hasUnsavedChanges(current)) {
        dispatch({
          type: 'operation-failed',
          error: {
            code: 'restore_conflict',
            operation: 'restore',
            message: 'Restore is blocked while the editor has unsaved changes.',
            recoverable: true,
            relativePath: active.snapshot.relativePath,
          },
        });
        return false;
      }

      if (
        current.gitStatus?.token &&
        isRepositoryTokenStale(input.expectedRepoToken, current.gitStatus.token)
      ) {
        dispatch({
          type: 'operation-failed',
          error: {
            code: 'external_state_changed',
            operation: 'restore',
            message: 'The repository changed after the restore view was loaded.',
            recoverable: true,
            relativePath: active.snapshot.relativePath,
          },
        });
        return false;
      }

      dispatch({ type: 'operation-started' });

      try {
        const result = await commands.restoreMarkdownFromGit({
          workspaceId: current.workspace.id,
          relativePath: active.snapshot.relativePath,
          sourceRef: input.sourceRef,
          expectedRepoToken: input.expectedRepoToken,
          expectedFileVersion: active.snapshot.version,
          editorHasUnsavedChanges: false,
        });
        const payload = await openDocumentForEditor(commands, current.workspace.id, result.relativePath);

        dispatch({
          type: 'document-restored',
          payload,
          gitStatus: result.status,
        });
        await commands.rememberLastOpenedFile(current.workspace.id, result.relativePath);
        return true;
      } catch (error) {
        dispatch({ type: 'operation-failed', error });
        return false;
      }
    },
    [commands],
  );

  const enableGit = useCallback(async () => {
    const workspaceId = stateRef.current.workspace?.id;

    if (!workspaceId) {
      return false;
    }

    dispatch({ type: 'operation-started' });

    try {
      await commands.initializeGitRepository(workspaceId);
      await refreshGitStateDirect(workspaceId, { swallowErrors: false });
      dispatch({ type: 'operation-finished' });
      return true;
    } catch (error) {
      dispatch({ type: 'operation-failed', error });
      return false;
    }
  }, [commands, refreshGitStateDirect]);

  const createGitSnapshot = useCallback(
    async (message: string): Promise<GitSnapshotActionResult> => {
      const current = stateRef.current;

      if (!current.workspace || !current.gitStatus) {
        const error = {
          code: 'not_repository',
          operation: 'snapshot',
          message: 'Refresh Git status before creating a snapshot.',
          recoverable: true,
        };
        dispatch({ type: 'operation-failed', error });
        return { ok: false, error };
      }

      const hasUnsavedEditorChanges =
        current.active?.contentRevision !== current.active?.savedContentRevision;
      const eligibility = getGitSnapshotEligibility({
        workspaceId: current.workspace.id,
        status: current.gitStatus,
        blockedState: current.gitBlockedState,
        hasUnsavedEditorChanges,
      });
      const request = buildGitSnapshotRequest({
        workspaceId: current.workspace.id,
        status: current.gitStatus,
        files: current.files,
        message,
      });

      if (!eligibility.canCreateSnapshot || !request) {
        const error = {
          code: 'no_changes',
          operation: 'snapshot',
          message: eligibility.disabledReasons[0]?.message ?? 'Snapshot is not available.',
          recoverable: true,
          relativePath: current.active?.snapshot.relativePath,
        };
        dispatch({ type: 'operation-failed', error });
        return { ok: false, error };
      }

      dispatch({ type: 'operation-started' });

      try {
        const result = await commands.createGitSnapshot(request);
        dispatch({ type: 'git-snapshot-created', result });
        return { ok: true, result };
      } catch (error) {
        dispatch({ type: 'operation-failed', error });
        return { ok: false, error };
      }
    },
    [commands],
  );

  const actions = useMemo<WorkspaceLifecycleActions>(
    () => ({
      async openWorkspace(path) {
        const trimmedPath = path.trim();
        if (!trimmedPath) {
          return;
        }

        await loadSession(() => commands.openWorkspaceAtPath(trimmedPath));
      },

      async createWorkspace(path) {
        const trimmedPath = path.trim();
        if (!trimmedPath) {
          return;
        }

        await loadSession(() => commands.createWorkspaceAtPath(trimmedPath));
      },

      async refreshFiles() {
        const current = stateRef.current;
        if (!current.workspace) {
          return;
        }

        dispatch({ type: 'operation-started' });

        try {
          const batch = await commands.refreshWorkspaceExternalChanges(current.workspace.id);
          dispatch({ type: 'external-change-detected', batch });
        } catch {
          try {
            const files = await commands.refreshWorkspaceFiles(current.workspace.id);
            dispatch({ type: 'files-refreshed', files });
            void refreshGitStateDirect(current.workspace.id);
          } catch (error) {
            dispatch({ type: 'operation-failed', error });
          }
        }
      },

      refreshGitState: refreshGitStateForCurrentWorkspace,

      enableGit,

      createGitSnapshot,

      requestCreateFile(relativePath) {
        return performAction({ type: 'create-file', relativePath: normalizeMarkdownPath(relativePath) });
      },

      requestOpenFile(relativePath) {
        return performAction({ type: 'open-file', relativePath });
      },

      requestRenameActive(newRelativePath) {
        return performAction({
          type: 'rename-file',
          newRelativePath: normalizeMarkdownPath(newRelativePath),
        });
      },

      requestDeleteActive() {
        return performAction({ type: 'delete-file' });
      },

      requestCloseActive() {
        const current = stateRef.current;
        const action: PendingDocumentAction = { type: 'close-file' };

        if (shouldPromptForAction(current, action)) {
          dispatch({ type: 'prompt-opened', prompt: createUnsavedPrompt(current, action) });
          return;
        }

        dispatch({ type: 'document-closed' });
      },

      restoreActiveFromGit,

      async continuePromptAfterSave() {
        const prompt = stateRef.current.prompt;

        if (!prompt) {
          return;
        }

        dispatch({ type: 'prompt-closed' });
        await performAction(prompt.action, true);
      },

      async discardPrompt() {
        const prompt = stateRef.current.prompt;

        if (!prompt) {
          return;
        }

        dispatch({ type: 'prompt-closed' });
        await performAction(prompt.action, true);
      },

      cancelPrompt() {
        dispatch({ type: 'prompt-closed' });
      },

      clearError() {
        dispatch({ type: 'error-cleared' });
      },

      recordEditorChange(input) {
        dispatch({ type: 'document-edited', ...input });
      },

      saveActive,
    }),
    [
      commands,
      createGitSnapshot,
      enableGit,
      loadSession,
      performAction,
      refreshGitStateDirect,
      refreshGitStateForCurrentWorkspace,
      restoreActiveFromGit,
      saveActive,
    ],
  );

  return [state, actions];
}

export { hasUnsavedChanges };

function normalizeMarkdownPath(relativePath: WorkspaceRelativePath): WorkspaceRelativePath {
  const trimmedPath = relativePath.trim().replace(/\\/g, '/');

  if (!trimmedPath) {
    return trimmedPath;
  }

  return /\.(md|markdown)$/i.test(trimmedPath) ? trimmedPath : `${trimmedPath}.md`;
}

function initialMarkdownForPath(relativePath: WorkspaceRelativePath): string {
  const fileName = relativePath.split('/').pop() ?? 'Untitled';
  const title = fileName.replace(/\.(md|markdown)$/i, '').replace(/[-_]+/g, ' ').trim();
  return `# ${title || 'Untitled'}\n`;
}
