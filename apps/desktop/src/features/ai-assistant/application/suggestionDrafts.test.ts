import { describe, expect, it } from 'vitest';

import { createMindMapEditorState } from '../../../domain/mindMap';
import type { AiContextSnapshot, AiMessage } from '../types';
import {
  classifyAiSuggestionDraftIntent,
  createAiSuggestionDraft,
  createCurrentAiSuggestionDraftDocument,
} from './suggestionDrafts';

describe('AI suggestion drafts', () => {
  it('classifies only change-oriented prompts as suggestion draft candidates', () => {
    expect(classifyAiSuggestionDraftIntent('Rewrite the selected branch with clearer steps.')).toEqual({
      isSuggestionIntent: true,
      reason: 'rewrite',
    });
    expect(classifyAiSuggestionDraftIntent('Can you summarize this branch?')).toEqual({
      isSuggestionIntent: false,
    });
  });

  it('serializes source message and context anchors without losing draft metadata', () => {
    const draft = createAiSuggestionDraft({
      assistantMessage: assistantMessage(),
      sourcePrompt: 'Improve the selected branch.',
      context: contextSnapshot(),
      currentDocument: {
        documentRevision: 'mindmap:7:content:7',
        documentContentHash: 'hash-7',
      },
      createdAt: new Date('2026-05-10T12:00:00Z'),
    });
    const serialized = JSON.parse(JSON.stringify(draft)) as typeof draft;

    expect(serialized.id).toBe('draft-message-1');
    expect(serialized.sourceSessionId).toBe('session-1');
    expect(serialized.sourceMessageId).toBe('message-1');
    expect(serialized.targetContext.scope).toBe('selectedBranch');
    expect(serialized.targetContext.documentPath).toBe('notes/plan.md');
    expect(serialized.targetContext.documentRevision).toBe('mindmap:7:content:7');
    expect(serialized.targetContext.documentContentHash).toBe('hash-7');
    expect(serialized.rawAssistantContent).toBe('Suggested branch rewrite');
    expect(serialized.warnings).toEqual([]);
  });

  it('adds revision and hash mismatch warnings when the document changed after context capture', () => {
    const draft = createAiSuggestionDraft({
      assistantMessage: assistantMessage(),
      sourcePrompt: 'Restructure this branch.',
      context: contextSnapshot(),
      currentDocument: {
        documentRevision: 'mindmap:8:content:8',
        documentContentHash: 'hash-8',
      },
    });

    expect(draft.warnings.map((warning) => warning.code)).toEqual([
      'document_revision_mismatch',
      'document_content_hash_mismatch',
    ]);
    expect(draft.warnings[0]).toMatchObject({
      expectedRevision: 'mindmap:7:content:7',
      currentRevision: 'mindmap:8:content:8',
      relativePath: 'notes/plan.md',
    });
  });

  it('derives the current editor revision token without mutating editor state', () => {
    const editorState = createMindMapEditorState({ sourcePath: 'notes/plan.md' });
    const documentRef = editorState.document;
    const historyRef = editorState.history;

    const currentDocument = createCurrentAiSuggestionDraftDocument(editorState, 'current-hash');

    expect(currentDocument).toEqual({
      documentRevision: 'mindmap:1:content:1',
      documentContentHash: 'current-hash',
    });
    expect(editorState.document).toBe(documentRef);
    expect(editorState.history).toBe(historyRef);
    expect(editorState.isDirty).toBe(false);
  });
});

function assistantMessage(): AiMessage {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    runId: 'run-1',
    role: 'assistant',
    content: 'Suggested branch rewrite',
    createdAt: '2026-05-10T12:00:00Z',
  };
}

function contextSnapshot(): AiContextSnapshot {
  return {
    workspaceId: 'workspace-1',
    scope: 'selectedBranch',
    displayLabel: 'Selected branch: Plan',
    documentId: 'document-1',
    documentPath: 'notes/plan.md',
    documentRevision: 'mindmap:7:content:7',
    documentContentHash: 'hash-7',
    selectedNodeIds: ['plan'],
    items: [
      {
        id: 'item-1',
        kind: 'mindMapBranch',
        label: 'Plan',
        relativePath: 'notes/plan.md',
        nodeIds: ['plan'],
        content: 'Plan context',
        byteEstimate: 12,
      },
    ],
    byteEstimate: 12,
    tokenEstimate: 3,
    truncated: false,
  };
}
