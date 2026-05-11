import type { MindMapEditorState } from '../../../domain/mindMap';
import { getAiContextScopeLabel } from './contextSelectors';
import type {
  AiContextSnapshot,
  AiMessage,
  AiSuggestionDraft,
  AiSuggestionDraftWarning,
  WorkspaceRelativePath,
} from '../types';

export interface AiSuggestionDraftIntent {
  isSuggestionIntent: boolean;
  reason?: 'rewrite' | 'restructure' | 'expand' | 'improve' | 'suggest_changes';
}

export interface AiSuggestionDraftCurrentDocument {
  documentRevision?: string;
  documentContentHash?: string;
}

export interface CreateAiSuggestionDraftInput {
  assistantMessage: AiMessage;
  sourcePrompt: string;
  context: AiContextSnapshot;
  currentDocument?: AiSuggestionDraftCurrentDocument;
  draftId?: string;
  structuredOperations?: unknown;
  createdAt?: Date;
}

export interface AiSuggestionDraftReviewMetadata {
  draftId: string;
  sourceConversationId: string;
  sourceMessageId: string;
  targetScopeLabel: string;
  documentId?: string;
  documentPath?: WorkspaceRelativePath;
  baseDocumentRevision?: string;
  baseDocumentContentHash?: string;
  rawAssistantContent: string;
  structuredOperations?: unknown;
  warnings: AiSuggestionDraftWarning[];
  createdAt: string;
  summary: string;
}

const suggestionIntentPatterns: Array<{
  reason: NonNullable<AiSuggestionDraftIntent['reason']>;
  pattern: RegExp;
}> = [
  { reason: 'rewrite', pattern: /\b(rewrite|revise|rework|redraft|edit|polish)\b/i },
  { reason: 'restructure', pattern: /\b(restructure|reorganize|reorder|refactor|reshape)\b/i },
  { reason: 'expand', pattern: /\b(expand|extend|elaborate|add\s+(more\s+)?detail|flesh\s+out)\b/i },
  { reason: 'improve', pattern: /\b(improve|enhance|strengthen|tighten|clarify)\b/i },
  {
    reason: 'suggest_changes',
    pattern: /\b(suggest|propose|draft)\b[\s\S]{0,80}\b(change|changes|edit|edits|revision|rewrite|improvement|structure)\b/i,
  },
];

export function classifyAiSuggestionDraftIntent(prompt: string): AiSuggestionDraftIntent {
  const normalizedPrompt = prompt.trim();

  if (normalizedPrompt.length < 8) {
    return { isSuggestionIntent: false };
  }

  const matchedPattern = suggestionIntentPatterns.find(({ pattern }) => pattern.test(normalizedPrompt));

  return matchedPattern
    ? { isSuggestionIntent: true, reason: matchedPattern.reason }
    : { isSuggestionIntent: false };
}

export function createAiSuggestionDraft(input: CreateAiSuggestionDraftInput): AiSuggestionDraft {
  const { assistantMessage, context } = input;

  return {
    id: input.draftId ?? `draft-${assistantMessage.id}`,
    sourceSessionId: assistantMessage.sessionId,
    sourceMessageId: assistantMessage.id,
    sourceRunId: assistantMessage.runId,
    sourcePrompt: input.sourcePrompt,
    targetContext: {
      workspaceId: context.workspaceId,
      scope: context.scope,
      displayLabel: context.displayLabel,
      documentId: context.documentId,
      documentPath: context.documentPath,
      documentRevision: context.documentRevision,
      documentContentHash: context.documentContentHash,
      selectedNodeIds: context.selectedNodeIds ? [...context.selectedNodeIds] : undefined,
      itemIds: context.items.map((item) => item.id),
    },
    rawAssistantContent: assistantMessage.content,
    structuredOperations: input.structuredOperations,
    warnings: createSuggestionDraftWarnings(context, input.currentDocument),
    createdAt: (input.createdAt ?? new Date()).toISOString(),
  };
}

export function createSuggestionDraftWarnings(
  context: AiContextSnapshot,
  currentDocument: AiSuggestionDraftCurrentDocument = {},
): AiSuggestionDraftWarning[] {
  const warnings: AiSuggestionDraftWarning[] = (context.warnings ?? []).map((warning) => ({
    code: warning.code,
    message: warning.message,
    itemId: warning.itemId,
    relativePath: warning.relativePath,
  }));

  if (
    context.documentRevision &&
    currentDocument.documentRevision &&
    context.documentRevision !== currentDocument.documentRevision
  ) {
    warnings.push({
      code: 'document_revision_mismatch',
      message: 'Document changed since this AI context was captured.',
      expectedRevision: context.documentRevision,
      currentRevision: currentDocument.documentRevision,
      relativePath: context.documentPath,
    });
  }

  if (
    context.documentContentHash &&
    currentDocument.documentContentHash &&
    context.documentContentHash !== currentDocument.documentContentHash
  ) {
    warnings.push({
      code: 'document_content_hash_mismatch',
      message: 'Markdown file content changed since this AI context was captured.',
      expectedContentHash: context.documentContentHash,
      currentContentHash: currentDocument.documentContentHash,
      relativePath: context.documentPath,
    });
  }

  return warnings;
}

export function createCurrentAiSuggestionDraftDocument(
  state: Pick<MindMapEditorState, 'contentRevision' | 'document'>,
  currentContentHash?: string,
): AiSuggestionDraftCurrentDocument {
  return {
    documentRevision: createMindMapDocumentRevision(state),
    documentContentHash: currentContentHash,
  };
}

export function createMindMapDocumentRevision(
  state: Pick<MindMapEditorState, 'contentRevision' | 'document'>,
): string {
  return `mindmap:${state.document.version}:content:${state.contentRevision}`;
}

export function createAiSuggestionDraftReviewMetadata(
  draft: AiSuggestionDraft,
): AiSuggestionDraftReviewMetadata {
  return {
    draftId: draft.id,
    sourceConversationId: draft.sourceSessionId,
    sourceMessageId: draft.sourceMessageId,
    targetScopeLabel: getAiContextScopeLabel(draft.targetContext.scope),
    documentId: draft.targetContext.documentId,
    documentPath: draft.targetContext.documentPath,
    baseDocumentRevision: draft.targetContext.documentRevision,
    baseDocumentContentHash: draft.targetContext.documentContentHash,
    rawAssistantContent: draft.rawAssistantContent,
    structuredOperations: draft.structuredOperations,
    warnings: draft.warnings,
    createdAt: draft.createdAt,
    summary: summarizeSuggestionDraft(draft.rawAssistantContent),
  };
}

function summarizeSuggestionDraft(rawAssistantContent: string): string {
  const firstContentLine = rawAssistantContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstContentLine) {
    return 'AI suggestion draft';
  }

  return firstContentLine.length > 72
    ? `${firstContentLine.slice(0, 69)}...`
    : firstContentLine;
}
