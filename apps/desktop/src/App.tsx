import { useCallback, useEffect, useRef } from 'react';

import { AppShell } from './components/layout';
import { createMindMapEditorState, createMindMapEditorStore } from './domain/mindMap';
import type { MindMapEditorState, MindMapEditorStore } from './domain/mindMap';
import { hasUnsavedChanges, useWorkspaceLifecycle } from './features/workspace';
import type { WorkspaceLifecycleState } from './features/workspace';

export default function App() {
  const [workspaceState, workspaceActions] = useWorkspaceLifecycle();
  const { editorStore, initialEditorState } = useEditorStoreForActiveDocument(workspaceState.active);
  const activeDocumentKey = workspaceState.active?.key ?? null;
  const activeContentRevision = workspaceState.active?.contentRevision ?? null;
  const activeSavedContentRevision = workspaceState.active?.savedContentRevision ?? null;
  const activeInFlightSave = workspaceState.active?.inFlightSave ?? null;
  const activeHasUnsavedChanges =
    activeContentRevision !== null && activeContentRevision !== activeSavedContentRevision;

  useEffect(() => {
    if (!activeDocumentKey) {
      return undefined;
    }

    return editorStore.subscribe((editorState, change) => {
      if (!change.documentChanged) {
        return;
      }

      workspaceActions.recordEditorChange({
        documentKey: activeDocumentKey,
        editorDocument: editorState.document,
        contentRevision: editorState.contentRevision,
      });
    });
  }, [activeDocumentKey, editorStore, workspaceActions]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges(workspaceState)) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [workspaceState]);

  const saveCurrentEditor = useCallback(
    async (reason: 'manual' | 'autosave') => {
      const currentEditorState = editorStore.getState();
      const savedCurrentRevision = await workspaceActions.saveActive(
        reason,
        currentEditorState.document,
        currentEditorState.contentRevision,
      );

      if (savedCurrentRevision && editorStore.getState().contentRevision === currentEditorState.contentRevision) {
        editorStore.markClean();
      }

      return savedCurrentRevision;
    },
    [editorStore, workspaceActions],
  );

  useEffect(() => {
    if (
      !activeHasUnsavedChanges ||
      activeInFlightSave ||
      workspaceState.saveStatus.kind !== 'unsaved'
    ) {
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      void saveCurrentEditor('autosave');
    }, 800);

    return () => window.clearTimeout(timerId);
  }, [
    activeHasUnsavedChanges,
    activeInFlightSave,
    saveCurrentEditor,
    workspaceState.saveStatus.kind,
  ]);

  const handlePromptSave = useCallback(async () => {
    const saved = await saveCurrentEditor('manual');

    if (saved) {
      await workspaceActions.continuePromptAfterSave();
    }
  }, [saveCurrentEditor, workspaceActions]);

  return (
    <AppShell
      state={initialEditorState}
      store={editorStore}
      workspaceState={workspaceState}
      workspaceActions={{
        ...workspaceActions,
        saveActiveDocument: () => saveCurrentEditor('manual'),
        savePromptDocument: handlePromptSave,
      }}
    />
  );
}

function useEditorStoreForActiveDocument(active: WorkspaceLifecycleState['active']): {
  editorStore: MindMapEditorStore;
  initialEditorState: MindMapEditorState;
} {
  const activeKey = active?.key ?? null;
  const ref = useRef<{
    activeKey: string | null;
    editorStore: MindMapEditorStore;
    initialEditorState: MindMapEditorState;
  } | null>(null);

  if (!ref.current || ref.current.activeKey !== activeKey) {
    const options = active
      ? {
          document: active.editorDocument,
        }
      : {};

    ref.current = {
      activeKey,
      editorStore: createMindMapEditorStore(options),
      initialEditorState: createMindMapEditorState(options),
    };
  }

  return ref.current;
}
