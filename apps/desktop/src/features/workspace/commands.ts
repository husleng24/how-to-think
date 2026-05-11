import { invoke } from '@tauri-apps/api/core';

import {
  createEditorDocumentFromMarkdownDocument,
  openMarkdownMindMap as openMarkdownMindMapCommand,
  saveMarkdownMindMap as saveMarkdownMindMapCommand,
} from '../../services/markdownLifecycle';
import type {
  DocumentSnapshot,
  SaveMarkdownMindMapResult,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceRelativePath,
} from '../../types/markdownLifecycle';
import type { GitRestoreResult } from '../git-service';
import type {
  DeleteDocumentResult,
  DocumentExternalChangeStatus,
  OpenedDocumentPayload,
  RenameDocumentResult,
  WorkspaceCommands,
  WorkspaceSession,
} from './types';

export const tauriWorkspaceCommands: WorkspaceCommands = {
  loadRememberedWorkspace() {
    return invoke<WorkspaceSession | null>('load_remembered_workspace');
  },

  openWorkspaceAtPath(path) {
    return invoke<WorkspaceSession>('open_workspace_at_path', { path });
  },

  createWorkspaceAtPath(path) {
    return invoke<WorkspaceSession>('create_workspace_at_path', { path });
  },

  refreshWorkspaceFiles(workspaceId) {
    return invoke<WorkspaceFile[]>('refresh_workspace_files', { workspaceId });
  },

  createMarkdownDocument(workspaceId, relativePath, content) {
    return invoke<DocumentSnapshot>('create_markdown_document', {
      workspaceId,
      relativePath,
      content,
    });
  },

  async openMarkdownMindMap(workspaceId, relativePath) {
    const result = await openMarkdownMindMapCommand({ workspaceId, relativePath });

    if (!result.document) {
      throw new Error('The Markdown file could not be converted into a mind map.');
    }

    return {
      snapshot: result.snapshot,
      document: result.document,
      diagnostics: result.diagnostics,
      files: result.files,
      linkIndex: result.linkIndex,
    };
  },

  saveMarkdownMindMap(input) {
    return saveMarkdownMindMapCommand(input);
  },

  renameMarkdownDocument(input) {
    return invoke<RenameDocumentResult>('rename_markdown_document', input);
  },

  deleteMarkdownDocument(input) {
    return invoke<DeleteDocumentResult>('delete_markdown_document', input);
  },

  restoreMarkdownFromGit(input) {
    return invoke<GitRestoreResult>('git_restore_file', { request: input });
  },

  rememberLastOpenedFile(workspaceId, relativePath) {
    return invoke<void>('remember_last_opened_file', { workspaceId, relativePath });
  },

  checkOpenDocumentExternalChange(input) {
    return invoke<DocumentExternalChangeStatus>('check_open_document_external_change', input);
  },
};

export async function openDocumentForEditor(
  commands: WorkspaceCommands,
  workspaceId: WorkspaceId,
  relativePath: WorkspaceRelativePath,
): Promise<OpenedDocumentPayload> {
  const result = await commands.openMarkdownMindMap(workspaceId, relativePath);
  const editorDocument = createEditorDocumentFromMarkdownDocument(result.document, {
    id: result.snapshot.relativePath,
    createdAt: result.snapshot.openedAt,
    updatedAt: result.snapshot.openedAt,
  });

  return {
    result,
    editorDocument,
    contentRevision: editorDocument.version,
  };
}

export function isSavedMarkdownResult(
  result: SaveMarkdownMindMapResult,
): result is SaveMarkdownMindMapResult & { save: NonNullable<SaveMarkdownMindMapResult['save']> } {
  return result.status === 'saved' && result.save != null;
}
