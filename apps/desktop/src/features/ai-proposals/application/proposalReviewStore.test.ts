import {
  beginApplyingProposalReview,
  canAcceptProposalReview,
  confirmProposalRiskFlag,
  createCurrentFileProposalFixture,
  createDeletionProposalFixture,
  createEmptyProposalSuggestionFixture,
  createInvalidProposalSuggestionFixture,
  createMultiFileProposalFixture,
  createProposalFixtureContext,
  createProposalPreviewModel,
  createProposalReviewDraftSourceFromAiSuggestionDraft,
  createProposalReview,
  createProposalReviewEditorSnapshot,
  createProposalReviewStore,
  createReadyProposalReviewFixture,
  createStaleProposalReviewFixture,
  getAcceptDisabledMessages,
  receiveAiConversationProposal,
  rejectProposalReview,
} from '../index';
import { createMindMapEditorState } from '../../../domain/mindMap';

describe('proposal review lifecycle', () => {
  it('moves proposals through validation, ready, applying, applied, failed, and conflict states', () => {
    const store = createProposalReviewStore();
    const proposal = createReadyProposalReviewFixture().proposal;
    const snapshot = createProposalReviewEditorSnapshot();

    expect(proposal).toBeDefined();
    if (!proposal) {
      return;
    }

    const received = store.receiveProposal(proposal, snapshot);
    expect(received.status).toBe('ready');
    expect(store.startValidation()?.status).toBe('validating');
    expect(store.markReady()?.status).toBe('ready');
    expect(store.beginApply()?.status).toBe('applying');
    expect(store.beginApply()).toBe(store.getState().activeReview);
    expect(store.markApplied()?.status).toBe('applied');
    expect(store.markFailed('proposal_apply_failed', 'Apply adapter unavailable.')?.status).toBe('failed');
    expect(store.markConflict()?.status).toBe('conflict');
  });

  it('keeps invalid, stale, and unconfirmed high-risk proposals from being accepted', () => {
    const deletionReview = createProposalReview(
      createDeletionProposalFixture(),
      createProposalReviewEditorSnapshot(),
    );
    expect(deletionReview.status).toBe('ready');
    expect(canAcceptProposalReview(deletionReview)).toBe(false);
    expect(getAcceptDisabledMessages(deletionReview).map((message) => message.code)).toContain(
      'proposal_high_risk_unconfirmed',
    );

    const confirmedDeletionReview = confirmProposalRiskFlag(deletionReview, 'node_deletion');
    expect(canAcceptProposalReview(confirmedDeletionReview)).toBe(true);
    expect(beginApplyingProposalReview(confirmedDeletionReview).status).toBe('applying');

    const multiFileReview = createProposalReview(
      createMultiFileProposalFixture(),
      createProposalReviewEditorSnapshot(),
    );
    const multiFileStore = createProposalReviewStore({ activeReview: multiFileReview });
    multiFileStore.confirmRiskFlag('multi_file_change');
    expect(canAcceptProposalReview(multiFileStore.getState().activeReview as typeof multiFileReview)).toBe(
      false,
    );
    const token = multiFileReview.guardedApplyConfirmation?.token;
    expect(token).toBeDefined();
    multiFileStore.confirmGuardedApply(token as string);
    expect(canAcceptProposalReview(multiFileStore.getState().activeReview as typeof multiFileReview)).toBe(
      true,
    );
    multiFileStore.clearGuardedApplyConfirmation();
    expect(canAcceptProposalReview(multiFileStore.getState().activeReview as typeof multiFileReview)).toBe(
      false,
    );

    const staleReview = createStaleProposalReviewFixture();
    expect(staleReview.status).toBe('conflict');
    expect(canAcceptProposalReview(staleReview)).toBe(false);

    const invalidReview = receiveAiConversationProposal({
      suggestion: createInvalidProposalSuggestionFixture(),
      validationContext: createProposalFixtureContext(),
      editorSnapshot: createProposalReviewEditorSnapshot(),
    });
    expect(invalidReview.status).toBe('failed');
    expect(canAcceptProposalReview(invalidReview)).toBe(false);
  });

  it('rejects without changing captured editor state references', () => {
    const document = { id: 'doc-ref' };
    const undoHistory = { undoStack: [{ id: 'undo-ref' }], redoStack: [] };
    const selection = { selectedNodeId: 'alpha', focusedNodeId: 'alpha' };
    const snapshot = createProposalReviewEditorSnapshot({
      document,
      markdownBuffer: '# Stable\n',
      undoHistory,
      selection,
      isDirty: true,
    });
    const review = createProposalReview(createMultiFileProposalFixture(), snapshot);
    const rejected = rejectProposalReview(review, 'Not needed.');

    expect(rejected.status).toBe('rejected');
    expect(rejected.editorSnapshot.document).toBe(document);
    expect(rejected.editorSnapshot.markdownBuffer).toBe('# Stable\n');
    expect(rejected.editorSnapshot.fileVersion).toBe(snapshot.fileVersion);
    expect(rejected.editorSnapshot.isDirty).toBe(true);
    expect(rejected.editorSnapshot.undoHistory).toBe(undoHistory);
    expect(rejected.editorSnapshot.selection).toBe(selection);
  });

  it('creates a review from AI conversation output and rejects back to the unchanged editor', () => {
    const editorState = createMindMapEditorState();
    const snapshot = createProposalReviewEditorSnapshot({
      document: editorState.document,
      undoHistory: editorState.history,
      selection: editorState.selection,
    });
    const proposal = createCurrentFileProposalFixture();
    const review = receiveAiConversationProposal({
      suggestion: {
        ...proposal,
        suggestionId: proposal.proposalId,
      },
      validationContext: createProposalFixtureContext(),
      editorSnapshot: snapshot,
    });
    const store = createProposalReviewStore({ activeReview: review });
    const archived = store.rejectActive('Skip generated suggestion.');

    expect(review.status).toBe('ready');
    expect(archived?.status).toBe('rejected');
    expect(store.getState().activeReview).toBeNull();
    expect(store.getState().archivedReviews[0].editorSnapshot.document).toBe(editorState.document);
    expect(editorState.document).toBe(snapshot.document);
    expect(editorState.history).toBe(snapshot.undoHistory);
    expect(editorState.selection).toBe(snapshot.selection);
    expect(editorState.isDirty).toBe(false);
  });

  it('receives suggestion drafts as isolated review metadata without enabling apply', () => {
    const editorState = createMindMapEditorState();
    const snapshot = createProposalReviewEditorSnapshot({
      document: editorState.document,
      undoHistory: editorState.history,
      selection: editorState.selection,
    });
    const store = createProposalReviewStore();
    const review = store.receiveSuggestionDraft(
      createProposalReviewDraftSourceFromAiSuggestionDraft({
        id: 'draft-1',
        sourceSessionId: 'session-1',
        sourceMessageId: 'message-1',
        sourceRunId: 'run-1',
        sourcePrompt: 'Rewrite this branch.',
        targetContext: {
          workspaceId: 'workspace-1',
          scope: 'selectedBranch',
          displayLabel: 'Selected branch: Root',
          documentId: 'doc-1',
          documentPath: 'notes/root.md',
          documentRevision: 'mindmap:1:content:1',
          documentContentHash: 'hash-1',
          selectedNodeIds: ['root'],
          itemIds: ['item-1'],
        },
        rawAssistantContent: 'Suggested rewrite only.',
        warnings: [
          {
            code: 'document_revision_mismatch',
            message: 'Document changed since this AI context was captured.',
            expectedRevision: 'mindmap:1:content:1',
            currentRevision: 'mindmap:2:content:2',
            relativePath: 'notes/root.md',
          },
        ],
        createdAt: '2026-05-10T00:00:00Z',
      }),
      snapshot,
    );
    const preview = createProposalPreviewModel(review);

    expect(review.status).toBe('draft');
    expect(preview.canAccept).toBe(false);
    expect(preview.rawDraftContent).toBe('Suggested rewrite only.');
    expect(preview.messages.map((message) => message.code)).toContain('suggestion_draft_saved');
    expect(preview.messages.map((message) => message.code)).toContain(
      'suggestion_draft_revision_mismatch',
    );
    expect(review.editorSnapshot.document).toBe(editorState.document);
    expect(review.editorSnapshot.undoHistory).toBe(editorState.history);
    expect(editorState.isDirty).toBe(false);
  });

  it('maps typed validation and conflict messages into actionable review copy', () => {
    const invalidReview = receiveAiConversationProposal({
      suggestion: createEmptyProposalSuggestionFixture(),
      validationContext: createProposalFixtureContext(),
      editorSnapshot: createProposalReviewEditorSnapshot(),
    });
    expect(invalidReview.messages.map((message) => message.code)).toContain('empty_operations');
    expect(invalidReview.messages.find((message) => message.code === 'empty_operations')?.title).toBe(
      'Empty proposal',
    );

    const stalePreview = createProposalPreviewModel(createStaleProposalReviewFixture());
    expect(stalePreview.messages.map((message) => message.code)).toContain('proposal_stale_document');
    expect(stalePreview.canAccept).toBe(false);
  });
});
