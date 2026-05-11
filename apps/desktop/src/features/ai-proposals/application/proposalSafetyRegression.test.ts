import { describe, expect, it, vi } from 'vitest';

import type { MindMapEditorState } from '../../../domain/mindMap';
import {
  applyActiveProposalReview,
  applyAiProposal,
  undoAiProposalApply,
  type ApplyProposalActiveState,
} from './applyProposal';
import {
  applyMultiFileProposal,
  prepareMultiFileProposalApply,
  type MultiFileApplyBackend,
  type MultiFileBackendApplyInput,
} from './applyMultiFileProposal';
import { buildGuardedApplyConfirmation } from './guardedApplyConfirmation';
import { createProposalReviewStore } from './proposalReviewStore';
import {
  cleanRegressionMultiFilePreflightStates,
  createBranchRewriteRegressionProposal,
  createLargeDeletionRegressionProposal,
  createNodeExpansionRegressionProposal,
  createRegressionActiveApplyState,
  createRegressionBlockedSaveResult,
  createRegressionCompatibilityError,
  createRegressionFileVersion,
  createRegressionReviewEditorSnapshot,
  createRegressionSerializationError,
  createSequentialPartialFailureBackend,
  createSummaryReplacementRegressionProposal,
  createUnsupportedLinkOperationRegressionProposal,
  createWikilinkMultiFileRegressionProposal,
  regressionOtherPath,
  regressionRootFileVersion,
  regressionRootPath,
  serializeRegressionMarkdown,
} from '../fixtures/regressionScenarios';

describe('AI proposal review/apply safety regressions', () => {
  it('shows review metadata before mutation and rejects without touching editor state', () => {
    const active = createRegressionActiveApplyState({ includeWikiLink: true });
    const before = captureActiveState(active);
    const store = createProposalReviewStore();
    const proposal = createBranchRewriteRegressionProposal();
    const review = store.receiveProposal(proposal, createRegressionReviewEditorSnapshot(active));

    expect(review.status).toBe('ready');
    expect(store.getState().activeReview?.proposalId).toBe(proposal.proposalId);
    expect(captureActiveState(active)).toEqual(before);
    expect(active.editorState.document.nodes.alpha.text).toBe('Alpha');
    expect(active.markdownBuffer).toContain('[[notes/other#Beta|Other beta]]');
    expect(active.editorState.history.undoStack).toHaveLength(0);

    const rejected = store.rejectActive('Keep current notes.');

    expect(rejected?.status).toBe('rejected');
    expect(store.getState().activeReview).toBeNull();
    expect(store.getState().archivedReviews[0].editorSnapshot.document).toBe(active.editorState.document);
    expect(store.getState().archivedReviews[0].editorSnapshot.undoHistory).toBe(active.editorState.history);
    expect(captureActiveState(active)).toEqual(before);
  });

  it('accepts a branch rewrite as one visual/Markdown transaction and undo restores the baseline', async () => {
    const active = createRegressionActiveApplyState({ includeWikiLink: true });
    const store = createProposalReviewStore();
    const proposal = createBranchRewriteRegressionProposal();
    store.receiveProposal(proposal, createRegressionReviewEditorSnapshot(active));
    store.confirmRiskFlag('branch_move');

    const result = await applyActiveProposalReview({
      store,
      active,
      serializeMarkdown: serializeRegressionMarkdown,
      now: fixedNow(),
    });

    expect(result.applyResult.ok).toBe(true);
    if (!result.applyResult.ok) {
      return;
    }

    const nextState = result.applyResult.state;
    expect(store.getState().activeReview?.status).toBe('applied');
    expect(nextState.editorState.document.nodes.alpha.text).toBe('Alpha rewritten');
    expect(nextState.editorState.document.nodes.beta.parentId).toBe('alpha');
    expect(nextState.editorState.document.nodes.root.childIds).toEqual(['alpha']);
    expect(nextState.markdownDocument.nodes.beta.children).toEqual([]);
    expect(nextState.markdownBuffer).toContain('## Alpha rewritten');
    expect(nextState.markdownBuffer).toContain('### Beta [[notes/other#Beta|Other beta]]');
    expect(nextState.editorState.history.undoStack).toHaveLength(1);
    expect(nextState.proposalHistory?.undoStack).toHaveLength(1);
    expect(nextState.editorState.contentRevision).toBe(active.editorState.contentRevision + 1);
    expect(nextState.saveStatus.kind).toBe('unsaved');

    const undoResult = undoAiProposalApply(nextState);
    expect(undoResult.ok).toBe(true);
    if (!undoResult.ok) {
      return;
    }

    expect(captureRestorableState(undoResult.state)).toEqual(captureRestorableState(active));
    expect(undoResult.state.proposalHistory?.redoStack).toHaveLength(1);
  });

  it('covers node expansion and summary replacement with current-file Markdown consistency', async () => {
    const expansionResult = await applyAiProposal({
      proposal: createNodeExpansionRegressionProposal(),
      active: createRegressionActiveApplyState(),
      serializeMarkdown: serializeRegressionMarkdown,
      now: fixedNow(),
    });
    expect(expansionResult.ok).toBe(true);
    if (expansionResult.ok) {
      expect(expansionResult.state.editorState.document.nodes['alpha-support']).toMatchObject({
        parentId: 'alpha',
        text: 'Alpha support',
      });
      expect(expansionResult.state.markdownBuffer).toContain('### Alpha support');
    }

    const summaryResult = await applyAiProposal({
      proposal: createSummaryReplacementRegressionProposal(),
      active: createRegressionActiveApplyState(),
      serializeMarkdown: serializeRegressionMarkdown,
      now: fixedNow(),
    });
    expect(summaryResult.ok).toBe(true);
    if (summaryResult.ok) {
      expect(summaryResult.state.editorState.document.nodes.beta.text).toBe(
        'Decision summary: align scope and safety',
      );
      expect(summaryResult.state.markdownBuffer).toContain('## Decision summary: align scope and safety');
    }
  });

  it('warns on large deletion proposals and undo restores every deleted node', async () => {
    const active = createRegressionActiveApplyState({ largeBranch: true });
    const beforeNodeIds = Object.keys(active.editorState.document.nodes);
    const proposal = createLargeDeletionRegressionProposal();

    expect(proposal.riskFlags).toContain('large_deletion');

    const applyResult = await applyAiProposal({
      proposal,
      active,
      serializeMarkdown: serializeRegressionMarkdown,
      now: fixedNow(),
    });

    expect(applyResult.ok).toBe(true);
    if (!applyResult.ok) {
      return;
    }

    expect(applyResult.state.editorState.document.nodes.alpha).toBeUndefined();
    expect(applyResult.state.editorState.document.nodes.root.childIds).toEqual(['beta']);

    const undoResult = undoAiProposalApply(applyResult.state);
    expect(undoResult.ok).toBe(true);
    if (undoResult.ok) {
      expect(Object.keys(undoResult.state.editorState.document.nodes).sort()).toEqual(beforeNodeIds.sort());
      expect(undoResult.state.editorState.document.nodes.alpha.childIds).toHaveLength(10);
    }
  });

  it('does not silently overwrite stale, dirty, invalid, external-change, or save-failure states', async () => {
    const baseActive = createRegressionActiveApplyState();

    await expectNoMutationFailure({
      active: withEditorState(baseActive, bumpDocumentVersion(baseActive.editorState, 8)),
      expectedCode: 'stale_document_version',
      serializeMarkdown: vi.fn(serializeRegressionMarkdown),
    });

    await expectNoMutationFailure({
      active: createRegressionActiveApplyState({
        fileVersion: createRegressionFileVersion(regressionRootPath, 8),
      }),
      expectedCode: 'stale_file_version',
      serializeMarkdown: vi.fn(serializeRegressionMarkdown),
    });

    await expectNoMutationFailure({
      proposal: createUnsupportedLinkOperationRegressionProposal(),
      active: createRegressionActiveApplyState(),
      expectedCode: 'unsupported_operation',
      serializeMarkdown: vi.fn(serializeRegressionMarkdown),
    });

    const invalidHierarchySerialize = vi.fn(() => createRegressionCompatibilityError());
    await expectNoMutationFailure({
      active: createRegressionActiveApplyState(),
      expectedCode: 'markdown_compatibility_failed',
      serializeMarkdown: invalidHierarchySerialize,
      expectedSerializeCalls: 1,
    });

    const serializerFailure = vi.fn(() => createRegressionSerializationError());
    await expectNoMutationFailure({
      active: createRegressionActiveApplyState(),
      expectedCode: 'markdown_serialization_failed',
      serializeMarkdown: serializerFailure,
      expectedSerializeCalls: 1,
    });

    const saveFailure = vi.fn(() => createRegressionBlockedSaveResult());
    await expectNoMutationFailure({
      active: createRegressionActiveApplyState(),
      expectedCode: 'save_failed',
      serializeMarkdown: serializeRegressionMarkdown,
      conditionalSave: saveFailure,
    });
    expect(saveFailure).toHaveBeenCalledTimes(1);
  });

  it('requires explicit multi-file confirmation and blocks dirty, stale, and ambiguous preflight states', async () => {
    const proposal = createWikilinkMultiFileRegressionProposal();
    const backend: MultiFileApplyBackend = {
      preflightFiles: vi.fn(() => cleanRegressionMultiFilePreflightStates()),
      applyBatch: vi.fn(() => ({ ok: true as const, appliedFiles: [] })),
    };

    const unconfirmed = await applyMultiFileProposal({
      proposal,
      workspaceId: 'workspace-regression',
      backend,
    });

    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) {
      expect(unconfirmed.error.code).toBe('guarded_confirmation_required');
      expect(unconfirmed.error.step).toBe('confirmation');
    }
    expect(backend.preflightFiles).not.toHaveBeenCalled();
    expect(backend.applyBatch).not.toHaveBeenCalled();

    const confirmed = prepareMultiFileProposalApply({
      proposal,
      confirmedGuardedApplyToken: buildGuardedApplyConfirmation(proposal).token,
    });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.prepared.confirmation.linkImpactSummary).toContain('1 link operation');
      expect(confirmed.prepared.files.find((file) => file.path === regressionRootPath)?.linkImpact).toContain(
        regressionOtherPath,
      );
    }

    const unsafeBackend: MultiFileApplyBackend = {
      preflightFiles: vi.fn(() => [
        {
          path: regressionRootPath,
          exists: true,
          version: createRegressionFileVersion(regressionRootPath, 8),
          writable: true,
          ambiguousLinkTargets: ['Other beta'],
        },
        {
          path: regressionOtherPath,
          exists: true,
          version: regressionRootFileVersion,
          writable: true,
        },
      ]),
      applyBatch: vi.fn(() => ({ ok: true as const, appliedFiles: [] })),
    };

    const unsafe = await applyMultiFileProposal({
      proposal,
      workspaceId: 'workspace-regression',
      backend: unsafeBackend,
      confirmedGuardedApplyToken: buildGuardedApplyConfirmation(proposal).token,
      openDocuments: [{ path: regressionRootPath, version: regressionRootFileVersion, isDirty: true }],
    });

    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) {
      expect(unsafe.error.conflicts?.map((error) => error.code)).toEqual(
        expect.arrayContaining(['stale_file', 'dirty_file', 'ambiguous_link_target']),
      );
    }
    expect(unsafeBackend.applyBatch).not.toHaveBeenCalled();
  });

  it('refreshes link indexes after clean wikilink batch apply and reports rollback for partial writes', async () => {
    const proposal = createWikilinkMultiFileRegressionProposal();
    const confirmationToken = buildGuardedApplyConfirmation(proposal).token;
    const batchBackend: MultiFileApplyBackend = {
      preflightFiles: vi.fn(() => cleanRegressionMultiFilePreflightStates()),
      applyBatch: vi.fn((input: MultiFileBackendApplyInput) => ({
        ok: true as const,
        appliedFiles: input.files.map((file) => ({
          path: file.path,
          operationType: file.operationType,
          version: createRegressionFileVersion(file.path, 8),
        })),
      })),
      refreshAfterApply: vi.fn(() => ({ ok: true as const })),
    };

    const batchResult = await applyMultiFileProposal({
      proposal,
      workspaceId: 'workspace-regression',
      backend: batchBackend,
      confirmedGuardedApplyToken: confirmationToken,
      openDocuments: [
        { path: regressionRootPath, version: regressionRootFileVersion, isDirty: false },
        { path: regressionOtherPath, version: createRegressionFileVersion(regressionOtherPath, 3), isDirty: false },
      ],
    });

    expect(batchResult.ok).toBe(true);
    if (batchResult.ok) {
      expect(batchResult.refresh.linkIndexShouldRefresh).toBe(true);
      expect(batchResult.refresh.openDocumentsToRefresh).toEqual([regressionRootPath, regressionOtherPath]);
      expect(batchResult.rollbackStatus).toBe('not_needed');
    }

    const rollbackBackend = createSequentialPartialFailureBackend();
    const rollbackSpy = vi.spyOn(rollbackBackend, 'rollbackFile');
    const rollbackResult = await applyMultiFileProposal({
      proposal,
      workspaceId: 'workspace-regression',
      backend: rollbackBackend,
      confirmedGuardedApplyToken: confirmationToken,
    });

    expect(rollbackResult.ok).toBe(false);
    if (!rollbackResult.ok) {
      expect(rollbackResult.error.code).toBe('backend_write_failed');
      expect(rollbackResult.error.rollbackStatus).toBe('completed');
      expect(rollbackResult.error.appliedFiles).toHaveLength(1);
    }
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });
});

async function expectNoMutationFailure(input: {
  proposal?: ReturnType<typeof createBranchRewriteRegressionProposal>;
  active: ApplyProposalActiveState;
  expectedCode: string;
  serializeMarkdown: Parameters<typeof applyAiProposal>[0]['serializeMarkdown'];
  conditionalSave?: Parameters<typeof applyAiProposal>[0]['conditionalSave'];
  expectedSerializeCalls?: number;
}): Promise<void> {
  const before = captureActiveState(input.active);
  const result = await applyAiProposal({
    proposal: input.proposal ?? createNodeExpansionRegressionProposal(),
    active: input.active,
    serializeMarkdown: input.serializeMarkdown,
    conditionalSave: input.conditionalSave,
    now: fixedNow(),
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(input.expectedCode);
    expect(result.state).toBe(input.active);
    expect(captureActiveState(result.state)).toEqual(before);
  }

  if ('mock' in input.serializeMarkdown) {
    expect(input.serializeMarkdown).toHaveBeenCalledTimes(input.expectedSerializeCalls ?? 0);
  }
}

function withEditorState(
  active: ApplyProposalActiveState,
  editorState: MindMapEditorState,
): ApplyProposalActiveState {
  return {
    ...active,
    editorState,
    saveStatus: {
      kind: 'unsaved',
      message: 'User edits are pending while AI is processing.',
    },
  };
}

function bumpDocumentVersion(editorState: MindMapEditorState, version: number): MindMapEditorState {
  return {
    ...editorState,
    document: {
      ...editorState.document,
      version,
      nodes: {
        ...editorState.document.nodes,
        alpha: {
          ...editorState.document.nodes.alpha,
          text: 'User changed alpha before accepting AI output',
        },
      },
    },
    contentRevision: version,
    isDirty: true,
  };
}

function captureActiveState(active: ApplyProposalActiveState) {
  return {
    activeFilePath: active.activeFilePath,
    fileVersion: active.fileVersion,
    markdownBuffer: active.markdownBuffer,
    markdownDocument: active.markdownDocument,
    saveStatus: active.saveStatus,
    document: active.editorState.document,
    selection: active.editorState.selection,
    viewport: active.editorState.viewport,
    history: active.editorState.history,
    contentRevision: active.editorState.contentRevision,
    savedContentRevision: active.editorState.savedContentRevision,
    isDirty: active.editorState.isDirty,
    proposalHistory: active.proposalHistory,
  };
}

function captureRestorableState(active: ApplyProposalActiveState) {
  const { proposalHistory, ...restorableState } = captureActiveState(active);
  void proposalHistory;

  return restorableState;
}

function fixedNow(): Date {
  return new Date('2026-05-10T00:02:00.000Z');
}
