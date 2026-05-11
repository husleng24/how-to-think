import {
  calculateProposalImpactSummary,
  convertNormalizedAiSuggestionToProposal,
  createAiChangeProposal,
  validateAiChangeProposalInput,
} from '../index';
import type {
  AiChangeProposalInput,
  NodeId,
  NormalizedAiSuggestion,
  ProposalDocumentSnapshot,
  ProposalFileVersionAnchor,
  ProposalOperation,
  ProposalValidationContext,
  ProposalValidationErrorCode,
} from '../index';

const createdAt = '2026-01-02T03:04:05.000Z';
const fileVersion: ProposalFileVersionAnchor = {
  token: 'version:notes/root.md:1',
  modifiedAt: createdAt,
  byteSize: 128,
  contentHash: 'abc',
};
const otherFileVersion: ProposalFileVersionAnchor = {
  token: 'version:notes/other.md:1',
  modifiedAt: createdAt,
  byteSize: 64,
  contentHash: 'def',
};

function node(
  id: NodeId,
  parentId: NodeId | null,
  childIds: NodeId[] = [],
  text = id,
): ProposalDocumentSnapshot['nodes'][string] {
  return { id, parentId, childIds, text };
}

function document(path = 'notes/root.md'): ProposalDocumentSnapshot {
  return {
    id: path,
    version: 7,
    rootNodeId: 'root',
    nodes: {
      root: node('root', null, ['alpha', 'beta'], 'Root'),
      alpha: node('alpha', 'root', ['alpha-child'], 'Alpha'),
      'alpha-child': node('alpha-child', 'alpha', [], 'Alpha child'),
      beta: node('beta', 'root', [], 'Beta'),
    },
  };
}

function largeDeletionDocument(): ProposalDocumentSnapshot {
  const childIds = Array.from({ length: 10 }, (_, index) => `alpha-child-${index}`);

  return {
    id: 'notes/root.md',
    version: 7,
    rootNodeId: 'root',
    nodes: {
      root: node('root', null, ['alpha'], 'Root'),
      alpha: node('alpha', 'root', childIds, 'Alpha'),
      ...Object.fromEntries(childIds.map((childId) => [childId, node(childId, 'alpha', [], childId)])),
    },
  };
}

function context(): ProposalValidationContext {
  return {
    workspaceId: 'workspace-1',
    activeFilePath: 'notes/root.md',
    baseDocumentVersion: 7,
    knownFiles: [
      {
        path: 'notes/root.md',
        version: fileVersion,
        document: document(),
      },
      {
        path: 'notes/other.md',
        version: otherFileVersion,
        document: document('notes/other.md'),
      },
    ],
  };
}

function updateOperation(
  overrides: Partial<Extract<ProposalOperation, { type: 'update-node' }>> = {},
): Extract<ProposalOperation, { type: 'update-node' }> {
  return {
    type: 'update-node',
    operationId: 'op-update-alpha',
    targetFilePath: 'notes/root.md',
    nodeId: 'alpha',
    text: 'Alpha revised',
    ...overrides,
  };
}

function baseInput(overrides: Partial<AiChangeProposalInput> = {}): AiChangeProposalInput {
  return {
    proposalId: 'proposal-1',
    sourceConversationId: 'conversation-1',
    createdAt,
    targetScope: {
      type: 'branch',
      filePath: 'notes/root.md',
      rootNodeId: 'alpha',
    },
    baseDocumentVersion: 7,
    affectedFiles: [
      {
        path: 'notes/root.md',
        baseFileVersion: fileVersion,
        changeKind: 'modify',
        markdownSerialization: {
          status: 'valid',
          markdown: '# Root\n\n## Alpha revised\n',
          diagnostics: [],
        },
      },
    ],
    operations: [updateOperation()],
    summary: 'Improve the alpha branch.',
    ...overrides,
  };
}

function expectCodes(
  input: AiChangeProposalInput,
  expectedCodes: ProposalValidationErrorCode[],
): void {
  const result = validateAiChangeProposalInput(input, context());
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.map((validationError) => validationError.code)).toEqual(
      expect.arrayContaining(expectedCodes),
    );
  }
}

describe('AI change proposal construction', () => {
  it('builds a whole-proposal review envelope with anchors, impact summary, and no partial apply API', () => {
    const result = createAiChangeProposal(baseInput(), context());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.proposal).toMatchObject({
      proposalId: 'proposal-1',
      sourceConversationId: 'conversation-1',
      baseDocumentVersion: 7,
      validationStatus: 'valid',
      validationErrors: [],
      reviewMode: 'whole-proposal',
    });
    expect(result.proposal.targetScope).toEqual({
      type: 'branch',
      filePath: 'notes/root.md',
      rootNodeId: 'alpha',
    });
    expect(result.proposal.affectedFiles[0].baseFileVersion.token).toBe(fileVersion.token);
    expect(result.proposal.impactSummary.changedNodeIds).toEqual(['alpha']);
    expect(result.proposal.impactSummary.affectedFilePaths).toEqual(['notes/root.md']);
    expect(result.proposal).not.toHaveProperty('partialApply');
  });

  it('does not construct proposals without explicit scope, document version, and file anchors', () => {
    expectCodes(
      baseInput({
        targetScope: undefined,
        baseDocumentVersion: undefined,
        affectedFiles: [
          {
            path: 'notes/root.md',
            baseFileVersion: { token: '' },
            changeKind: 'modify',
          },
        ],
      }),
      ['missing_target_scope', 'missing_base_document_version', 'missing_affected_file_anchor'],
    );
  });

  it('rejects empty, unsupported, and unknown-target AI output with typed errors', () => {
    expectCodes(baseInput({ operations: [] }), ['empty_operations']);

    expectCodes(
      baseInput({
        targetScope: {
          type: 'node',
          filePath: 'notes/root.md',
          nodeId: 'missing',
        },
      }),
      ['unknown_node_id', 'operation_outside_target_scope'],
    );

    expectCodes(
      baseInput({
        operations: [
          {
            type: 'replace-workspace',
            operationId: 'op-unsupported',
            targetFilePath: 'notes/root.md',
          } as unknown as ProposalOperation,
        ],
      }),
      ['unknown_operation_type'],
    );
  });

  it('rejects workspace-wide scopes and operations outside the selected workspace-relative paths', () => {
    expectCodes(
      baseInput({
        targetScope: {
          type: 'workspace',
        } as unknown as AiChangeProposalInput['targetScope'],
      }),
      ['workspace_scope_forbidden'],
    );

    expectCodes(
      baseInput({
        affectedFiles: [
          {
            path: '../secret.md',
            baseFileVersion: fileVersion,
            changeKind: 'modify',
          },
        ],
        operations: [
          updateOperation({
            targetFilePath: '../secret.md',
          }),
        ],
      }),
      ['out_of_workspace_file'],
    );
  });

  it('rejects stale document and file version anchors', () => {
    expectCodes(
      baseInput({
        baseDocumentVersion: 6,
        affectedFiles: [
          {
            path: 'notes/root.md',
            baseFileVersion: { ...fileVersion, token: 'stale-token' },
            changeKind: 'modify',
          },
        ],
      }),
      ['unresolved_base_document_version', 'unresolved_base_file_version'],
    );
  });

  it('rejects invalid Markdown serialization output from compatibility validation', () => {
    expectCodes(
      baseInput({
        affectedFiles: [
          {
            path: 'notes/root.md',
            baseFileVersion: fileVersion,
            changeKind: 'modify',
            markdownSerialization: {
              status: 'invalid',
              diagnostics: ['Unmapped content would be lost.'],
            },
          },
        ],
      }),
      ['invalid_markdown_serialization'],
    );
  });
});

describe('proposal tree and scope validation', () => {
  it('rejects duplicate added node ids and unknown operation nodes', () => {
    expectCodes(
      baseInput({
        operations: [
          {
            type: 'add-node',
            operationId: 'op-add-duplicate',
            targetFilePath: 'notes/root.md',
            parentNodeId: 'alpha',
            nodeId: 'beta',
            text: 'Duplicate beta',
          },
          updateOperation({
            operationId: 'op-update-missing',
            nodeId: 'missing-node',
          }),
        ],
      }),
      ['duplicate_node_id', 'unknown_node_id'],
    );
  });

  it('rejects root deletion, descendant moves, and invalid sibling order', () => {
    expectCodes(
      baseInput({
        targetScope: {
          type: 'current-file',
          filePath: 'notes/root.md',
        },
        operations: [
          {
            type: 'delete-node',
            operationId: 'op-delete-root',
            targetFilePath: 'notes/root.md',
            nodeId: 'root',
          },
          {
            type: 'move-branch',
            operationId: 'op-move-descendant',
            targetFilePath: 'notes/root.md',
            nodeId: 'alpha',
            newParentNodeId: 'alpha-child',
          },
          {
            type: 'reorder-children',
            operationId: 'op-reorder-bad',
            targetFilePath: 'notes/root.md',
            parentNodeId: 'root',
            childNodeIds: ['alpha', 'alpha'],
          },
        ],
      }),
      ['root_operation_forbidden', 'cannot_move_into_descendant', 'invalid_sibling_order'],
    );
  });

  it('rejects branch-scope operations outside the selected branch', () => {
    expectCodes(
      baseInput({
        operations: [
          updateOperation({
            nodeId: 'beta',
            text: 'Beta outside alpha branch',
          }),
        ],
      }),
      ['operation_outside_target_scope'],
    );
  });

  it('requires explicit affected file metadata for multi-file proposals', () => {
    expectCodes(
      baseInput({
        targetScope: {
          type: 'multi-file',
          filePaths: ['notes/root.md', 'notes/other.md'],
        },
        operations: [
          updateOperation(),
          updateOperation({
            operationId: 'op-update-other',
            targetFilePath: 'notes/other.md',
          }),
        ],
      }),
      ['missing_affected_file_anchor', 'missing_multi_file_metadata'],
    );
  });
});

describe('proposal impact and risk summary', () => {
  it('reports changed, added, deleted, moved, linked, and multi-file effects', () => {
    const operations: ProposalOperation[] = [
      {
        type: 'add-node',
        operationId: 'op-add',
        targetFilePath: 'notes/root.md',
        parentNodeId: 'alpha',
        nodeId: 'gamma',
        text: 'Gamma',
      },
      {
        type: 'delete-node',
        operationId: 'op-delete',
        targetFilePath: 'notes/root.md',
        nodeId: 'alpha',
      },
      {
        type: 'move-branch',
        operationId: 'op-move',
        targetFilePath: 'notes/root.md',
        nodeId: 'beta',
        newParentNodeId: 'alpha',
      },
      {
        type: 'add-link',
        operationId: 'op-link',
        targetFilePath: 'notes/other.md',
        sourceNodeId: 'root',
        linkId: 'link-1',
        target: { type: 'url', href: 'https://example.com' },
      },
    ];

    const summary = calculateProposalImpactSummary(operations, context());

    expect(summary.addedNodeIds).toEqual(['gamma']);
    expect(summary.deletedNodeIds).toEqual(['alpha', 'alpha-child']);
    expect(summary.movedBranchRootIds).toEqual(['beta']);
    expect(summary.affectedLinkIds).toEqual(['link-1']);
    expect(summary.affectedFilePaths).toEqual(['notes/root.md', 'notes/other.md']);
    expect(summary.includesDeletions).toBe(true);
    expect(summary.includesBranchMoves).toBe(true);
    expect(summary.includesLinkChanges).toBe(true);
    expect(summary.includesMultiFileChange).toBe(true);
  });

  it('derives review risk flags for destructive, branch, link, and multi-file changes', () => {
    const result = createAiChangeProposal(
      baseInput({
        targetScope: {
          type: 'multi-file',
          filePaths: ['notes/root.md', 'notes/other.md'],
        },
        affectedFiles: [
          {
            path: 'notes/root.md',
            baseFileVersion: fileVersion,
            changeKind: 'modify',
          },
          {
            path: 'notes/other.md',
            baseFileVersion: otherFileVersion,
            changeKind: 'modify',
            markdownSerialization: {
              status: 'valid',
              markdown: '# Other\n',
              diagnostics: ['Serializer normalized heading whitespace.'],
            },
          },
        ],
        operations: [
          {
            type: 'delete-node',
            operationId: 'op-delete-alpha-child',
            targetFilePath: 'notes/root.md',
            nodeId: 'alpha-child',
          },
          {
            type: 'move-branch',
            operationId: 'op-move-beta',
            targetFilePath: 'notes/root.md',
            nodeId: 'beta',
            newParentNodeId: 'alpha',
          },
          {
            type: 'update-link',
            operationId: 'op-update-link-target',
            targetFilePath: 'notes/other.md',
            sourceNodeId: 'root',
            linkId: 'link-2',
            target: { type: 'file', filePath: 'notes/root.md' },
          },
        ],
      }),
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.proposal.riskFlags).toEqual(
      expect.arrayContaining([
        'node_deletion',
        'branch_move',
        'link_change',
        'multi_file_change',
        'link_target_change',
        'markdown_serialization_warning',
      ]),
    );
  });

  it('derives guarded risk flags for file lifecycle, cross-file moves, and large deletions', () => {
    const created = createAiChangeProposal(
      baseInput({
        proposalId: 'proposal-create',
        targetScope: {
          type: 'multi-file',
          filePaths: ['notes/new.md'],
        },
        affectedFiles: [
          {
            path: 'notes/new.md',
            baseFileVersion: { token: 'new-file:notes/new.md' },
            changeKind: 'create',
            markdownSerialization: {
              status: 'valid',
              markdown: '# New\n',
              diagnostics: [],
            },
          },
        ],
        operations: [
          {
            type: 'add-node',
            operationId: 'op-add-new',
            targetFilePath: 'notes/new.md',
            parentNodeId: 'root',
            nodeId: 'new-child',
            text: 'New child',
          },
        ],
      }),
      context(),
    );
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.proposal.riskFlags).toEqual(expect.arrayContaining(['file_creation']));
    }

    const moved = createAiChangeProposal(
      baseInput({
        proposalId: 'proposal-cross-file-move',
        targetScope: {
          type: 'multi-file',
          filePaths: ['notes/root.md', 'notes/other.md'],
        },
        affectedFiles: [
          {
            path: 'notes/root.md',
            baseFileVersion: fileVersion,
            changeKind: 'modify',
          },
          {
            path: 'notes/other.md',
            baseFileVersion: otherFileVersion,
            changeKind: 'modify',
          },
        ],
        operations: [
          {
            type: 'delete-node',
            operationId: 'op-delete-alpha-child',
            targetFilePath: 'notes/root.md',
            nodeId: 'alpha-child',
          },
          {
            type: 'add-node',
            operationId: 'op-add-other-gamma',
            targetFilePath: 'notes/other.md',
            parentNodeId: 'root',
            nodeId: 'gamma',
            text: 'Gamma',
          },
        ],
      }),
      context(),
    );
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.proposal.riskFlags).toEqual(
        expect.arrayContaining(['cross_file_move', 'multi_file_change']),
      );
    }

    const deletedFile = createAiChangeProposal(
      baseInput({
        proposalId: 'proposal-delete-file',
        targetScope: {
          type: 'multi-file',
          filePaths: ['notes/other.md'],
        },
        affectedFiles: [
          {
            path: 'notes/other.md',
            baseFileVersion: otherFileVersion,
            changeKind: 'delete',
          },
        ],
        operations: [
          {
            type: 'delete-node',
            operationId: 'op-delete-other-alpha-child',
            targetFilePath: 'notes/other.md',
            nodeId: 'alpha-child',
          },
        ],
      }),
      context(),
    );
    expect(deletedFile.ok).toBe(true);
    if (deletedFile.ok) {
      expect(deletedFile.proposal.riskFlags).toEqual(expect.arrayContaining(['file_deletion']));
    }

    const largeContext = context();
    largeContext.knownFiles[0] = {
      ...largeContext.knownFiles[0],
      document: largeDeletionDocument(),
    };
    const largeDeletion = createAiChangeProposal(
      baseInput({
        proposalId: 'proposal-large-delete',
        targetScope: {
          type: 'branch',
          filePath: 'notes/root.md',
          rootNodeId: 'alpha',
        },
        operations: [
          {
            type: 'delete-node',
            operationId: 'op-delete-alpha-large',
            targetFilePath: 'notes/root.md',
            nodeId: 'alpha',
          },
        ],
      }),
      largeContext,
    );
    expect(largeDeletion.ok).toBe(true);
    if (largeDeletion.ok) {
      expect(largeDeletion.proposal.riskFlags).toEqual(expect.arrayContaining(['large_deletion']));
    }
  });
});

describe('normalized AI suggestion conversion boundary', () => {
  it('converts representative normalized AI output into a validated proposal', () => {
    const suggestion: NormalizedAiSuggestion = {
      suggestionId: 'suggestion-1',
      sourceConversationId: 'conversation-1',
      createdAt,
      targetScope: {
        type: 'current-file',
        filePath: 'notes/root.md',
      },
      baseDocumentVersion: 7,
      affectedFiles: [
        {
          path: 'notes/root.md',
          baseFileVersion: fileVersion,
          changeKind: 'modify',
        },
      ],
      operations: [
        updateOperation({
          operationId: 'op-normalized-update',
          nodeId: 'beta',
          text: 'Beta revised',
        }),
      ],
      summary: 'Revise beta.',
    };

    const result = convertNormalizedAiSuggestionToProposal(suggestion, context());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.proposal.proposalId).toBe('suggestion-1');
    expect(result.proposal.impactSummary.changedNodeIds).toEqual(['beta']);
  });

  it('returns typed rejection reasons and no proposal for invalid normalized output', () => {
    const result = convertNormalizedAiSuggestionToProposal(
      {
        suggestionId: 'suggestion-invalid',
        sourceConversationId: 'conversation-1',
        createdAt,
        targetScope: {
          type: 'current-file',
          filePath: 'notes/root.md',
        },
        baseDocumentVersion: 7,
        affectedFiles: [
          {
            path: 'C:/Users/example/secret.md',
            baseFileVersion: fileVersion,
            changeKind: 'modify',
          },
        ],
        operations: [
          updateOperation({
            targetFilePath: 'C:/Users/example/secret.md',
          }),
        ],
      },
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result).not.toHaveProperty('proposal');
    expect(result.rejection.code).toBe('proposal_validation_failed');
    expect(result.rejection.errors.map((validationError) => validationError.code)).toContain(
      'out_of_workspace_file',
    );
  });
});
