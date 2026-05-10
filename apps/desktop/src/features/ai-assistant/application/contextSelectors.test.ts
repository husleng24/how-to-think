import { describe, expect, it } from 'vitest';

import { createMindMapEditorState } from '../../../domain/mindMap';
import type { MindMapEditorState } from '../../../domain/mindMap';
import {
  createAiContextSnapshotRequest,
  getAiContextScopeLabel,
  selectDefaultAiContextScope,
} from './contextSelectors';

const workspaceId = 'workspace-1';

function stateWithSourcePath(sourcePath: string | null): MindMapEditorState {
  const state = createMindMapEditorState({ sourcePath });
  return {
    ...state,
    document: {
      ...state.document,
      sourcePath,
    },
  };
}

describe('AI context selectors', () => {
  it('defaults to the smallest selected node scope before current file', () => {
    const state = stateWithSourcePath('notes/root.md');

    expect(selectDefaultAiContextScope(state, { currentFile: 'notes/root.md' })).toBe(
      'selectedNode',
    );
  });

  it('honors selected branch when explicitly requested and available', () => {
    const state = stateWithSourcePath('notes/root.md');

    expect(selectDefaultAiContextScope(state, { preferredScope: 'selectedBranch' })).toBe(
      'selectedBranch',
    );
  });

  it('falls back to current file when selection is stale', () => {
    const state = {
      ...stateWithSourcePath('notes/root.md'),
      selection: { selectedNodeId: 'missing', focusedNodeId: null },
    };

    expect(selectDefaultAiContextScope(state)).toBe('currentFile');
  });

  it('creates a backend request without mutating editor state', () => {
    const state = stateWithSourcePath('notes/root.md');
    const before = JSON.stringify(state);

    const request = createAiContextSnapshotRequest(state, {
      workspaceId,
      preferredScope: 'selectedNode',
      openFiles: ['notes/other.md'],
      limits: { maxContextBytes: 1024, maxFiles: 10, maxOpenFiles: 2 },
    });

    expect(request.workspaceId).toBe(workspaceId);
    expect(request.scope).toBe('selectedNode');
    expect(request.document).toBe(state.document);
    expect(request.selectedNodeId).toBe(state.selection.selectedNodeId);
    expect(request.currentFile).toBe('notes/root.md');
    expect(request.openFiles).toEqual(['notes/other.md']);
    expect(request.contentRevision).toBe(state.contentRevision);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('provides stable user-visible scope labels', () => {
    expect(getAiContextScopeLabel('selectedNode')).toBe('Selected node');
    expect(getAiContextScopeLabel('selectedBranch')).toBe('Selected branch');
    expect(getAiContextScopeLabel('currentFile')).toBe('Current file');
    expect(getAiContextScopeLabel('workspaceSummary')).toBe('Workspace summary');
  });
});
