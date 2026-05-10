import type { MindMapEditorState } from '../../../domain/mindMap';
import type {
  AiContextLimits,
  AiContextScope,
  AiContextSnapshotRequest,
  WorkspaceId,
  WorkspaceRelativePath,
} from '../types';

export interface AiContextSelectorOptions {
  workspaceId: WorkspaceId;
  preferredScope?: AiContextScope;
  currentFile?: WorkspaceRelativePath | null;
  openFiles?: WorkspaceRelativePath[];
  limits?: AiContextLimits;
}

export function selectDefaultAiContextScope(
  state: MindMapEditorState,
  options: Pick<AiContextSelectorOptions, 'preferredScope' | 'currentFile'> = {},
): AiContextScope {
  if (options.preferredScope === 'workspaceSummary') {
    return 'workspaceSummary';
  }

  const hasSelectedNode = Boolean(state.document.nodes[state.selection.selectedNodeId]);
  const currentFile = normalizeOptionalPath(options.currentFile ?? state.document.sourcePath);

  if (
    options.preferredScope === 'selectedBranch' ||
    options.preferredScope === 'selectedNode'
  ) {
    if (hasSelectedNode) {
      return options.preferredScope;
    }
  }

  if (options.preferredScope === 'currentFile' && currentFile) {
    return 'currentFile';
  }

  if (hasSelectedNode) {
    return 'selectedNode';
  }

  if (currentFile) {
    return 'currentFile';
  }

  return 'workspaceSummary';
}

export function createAiContextSnapshotRequest(
  state: MindMapEditorState,
  options: AiContextSelectorOptions,
): AiContextSnapshotRequest {
  const currentFile = normalizeOptionalPath(options.currentFile ?? state.document.sourcePath);
  const scope = selectDefaultAiContextScope(state, options);

  return {
    workspaceId: options.workspaceId,
    scope,
    document: state.document,
    selectedNodeId: state.selection.selectedNodeId,
    currentFile,
    openFiles: options.openFiles ?? [],
    contentRevision: state.contentRevision,
    limits: options.limits,
  };
}

export function getAiContextScopeLabel(scope: AiContextScope): string {
  switch (scope) {
    case 'selectedNode':
      return 'Selected node';
    case 'selectedBranch':
      return 'Selected branch';
    case 'currentFile':
      return 'Current file';
    case 'workspaceSummary':
      return 'Workspace summary';
  }
}

function normalizeOptionalPath(path: WorkspaceRelativePath | null | undefined): WorkspaceRelativePath | undefined {
  return path && path.trim().length > 0 ? path : undefined;
}
