import { createAiChangeProposal } from '../domain/conversion';
import type {
  AiChangeProposal,
  AiChangeProposalInput,
  NodeId,
  NormalizedAiSuggestion,
  ProposalDocumentSnapshot,
  ProposalFileVersionAnchor,
  ProposalValidationContext,
} from '../domain/types';
import { createProposalReview } from '../application/proposalReviewStore';
import type { ProposalReview, ProposalReviewEditorSnapshot } from '../application/types';

export const proposalFixtureCreatedAt = '2026-01-02T03:04:05.000Z';
export const proposalFixtureFileVersion: ProposalFileVersionAnchor = {
  token: 'version:notes/root.md:7',
  modifiedAt: proposalFixtureCreatedAt,
  byteSize: 128,
  contentHash: 'root-hash',
};
export const proposalFixtureOtherFileVersion: ProposalFileVersionAnchor = {
  token: 'version:notes/other.md:3',
  modifiedAt: proposalFixtureCreatedAt,
  byteSize: 72,
  contentHash: 'other-hash',
};
export const proposalFixtureNewFileVersion: ProposalFileVersionAnchor = {
  token: 'new-file:notes/new.md',
  modifiedAt: proposalFixtureCreatedAt,
  byteSize: 0,
  contentHash: 'new-file',
};

export function createProposalFixtureDocument(path = 'notes/root.md'): ProposalDocumentSnapshot {
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

export function createProposalFixtureContext(): ProposalValidationContext {
  return {
    workspaceId: 'workspace-1',
    activeFilePath: 'notes/root.md',
    baseDocumentVersion: 7,
    knownFiles: [
      {
        path: 'notes/root.md',
        version: proposalFixtureFileVersion,
        document: createProposalFixtureDocument(),
      },
      {
        path: 'notes/other.md',
        version: proposalFixtureOtherFileVersion,
        document: createProposalFixtureDocument('notes/other.md'),
      },
    ],
  };
}

export function createProposalReviewEditorSnapshot(
  overrides: Partial<ProposalReviewEditorSnapshot> = {},
): ProposalReviewEditorSnapshot {
  return {
    document: createProposalFixtureDocument(),
    markdownBuffer: '# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta\n',
    markdownBuffersByPath: {
      'notes/root.md': '# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta\n',
      'notes/other.md': '# Other\n\n## Beta\n',
    },
    fileVersion: proposalFixtureFileVersion,
    fileVersions: {
      'notes/root.md': proposalFixtureFileVersion,
      'notes/other.md': proposalFixtureOtherFileVersion,
    },
    activeFilePath: 'notes/root.md',
    documentVersion: 7,
    isDirty: false,
    undoHistory: { undoStack: [], redoStack: [] },
    selection: { selectedNodeId: 'alpha', focusedNodeId: 'alpha' },
    capturedAt: proposalFixtureCreatedAt,
    ...overrides,
  };
}

export function createNodeProposalFixture(): AiChangeProposal {
  return buildProposal(
    baseInput({
      proposalId: 'proposal-node',
      targetScope: {
        type: 'node',
        filePath: 'notes/root.md',
        nodeId: 'alpha',
      },
      operations: [
        {
          type: 'update-node',
          operationId: 'op-update-alpha',
          targetFilePath: 'notes/root.md',
          nodeId: 'alpha',
          text: 'Alpha revised',
        },
      ],
      summary: 'Revise the selected node.',
    }),
  );
}

export function createBranchProposalFixture(): AiChangeProposal {
  return buildProposal(
    baseInput({
      proposalId: 'proposal-branch',
      targetScope: {
        type: 'branch',
        filePath: 'notes/root.md',
        rootNodeId: 'alpha',
      },
      operations: [
        {
          type: 'update-node',
          operationId: 'op-update-alpha-child',
          targetFilePath: 'notes/root.md',
          nodeId: 'alpha-child',
          text: 'Alpha child revised',
        },
      ],
      summary: 'Improve the alpha branch.',
    }),
  );
}

export function createCurrentFileProposalFixture(): AiChangeProposal {
  return buildProposal(
    baseInput({
      proposalId: 'proposal-current-file',
      targetScope: {
        type: 'current-file',
        filePath: 'notes/root.md',
      },
      operations: [
        {
          type: 'add-node',
          operationId: 'op-add-gamma',
          targetFilePath: 'notes/root.md',
          parentNodeId: 'root',
          nodeId: 'gamma',
          text: 'Gamma',
        },
      ],
      summary: 'Add a new top-level thought.',
    }),
  );
}

export function createDeletionProposalFixture(): AiChangeProposal {
  return buildProposal(
    baseInput({
      proposalId: 'proposal-delete',
      targetScope: {
        type: 'branch',
        filePath: 'notes/root.md',
        rootNodeId: 'alpha',
      },
      operations: [
        {
          type: 'delete-node',
          operationId: 'op-delete-alpha-child',
          targetFilePath: 'notes/root.md',
          nodeId: 'alpha-child',
        },
      ],
      summary: 'Remove the alpha child note.',
    }),
  );
}

export function createMarkdownWarningProposalFixture(): AiChangeProposal {
  return buildProposal(
    baseInput({
      proposalId: 'proposal-markdown-warning',
      affectedFiles: [
        {
          path: 'notes/root.md',
          baseFileVersion: proposalFixtureFileVersion,
          changeKind: 'modify',
          markdownSerialization: {
            status: 'valid',
            markdown: '# Root\n\n## Alpha revised\n\n## Beta\n',
            diagnostics: ['Serializer normalized heading whitespace.'],
          },
        },
      ],
      summary: 'Update Markdown with serializer diagnostics.',
    }),
  );
}

export function createMultiFileProposalFixture(): AiChangeProposal {
  return buildProposal(
    baseInput({
      proposalId: 'proposal-multi-file',
      targetScope: {
        type: 'multi-file',
        filePaths: ['notes/root.md', 'notes/other.md'],
      },
      affectedFiles: [
        {
          path: 'notes/root.md',
          baseFileVersion: proposalFixtureFileVersion,
          changeKind: 'modify',
          markdownSerialization: {
            status: 'valid',
            markdown: '# Root\n\n## Alpha revised\n\n## Beta\n',
            diagnostics: [],
          },
        },
        {
          path: 'notes/other.md',
          baseFileVersion: proposalFixtureOtherFileVersion,
          changeKind: 'modify',
          markdownSerialization: {
            status: 'valid',
            markdown: '# Other\n\n## Beta revised\n',
            diagnostics: [],
          },
        },
      ],
      operations: [
        {
          type: 'update-node',
          operationId: 'op-update-alpha',
          targetFilePath: 'notes/root.md',
          nodeId: 'alpha',
          text: 'Alpha revised',
        },
        {
          type: 'update-node',
          operationId: 'op-update-other-beta',
          targetFilePath: 'notes/other.md',
          nodeId: 'beta',
          text: 'Beta revised',
        },
      ],
      summary: 'Revise related notes across two files.',
    }),
  );
}

export function createFileCreationProposalFixture(): AiChangeProposal {
  return buildProposal(
    baseInput({
      proposalId: 'proposal-create-file',
      targetScope: {
        type: 'multi-file',
        filePaths: ['notes/new.md'],
      },
      affectedFiles: [
        {
          path: 'notes/new.md',
          baseFileVersion: proposalFixtureNewFileVersion,
          changeKind: 'create',
          markdownSerialization: {
            status: 'valid',
            markdown: '# New\n\n## First thought\n',
            diagnostics: [],
          },
        },
      ],
      operations: [
        {
          type: 'add-node',
          operationId: 'op-create-new-alpha',
          targetFilePath: 'notes/new.md',
          parentNodeId: 'root',
          nodeId: 'alpha',
          text: 'First thought',
        },
      ],
      summary: 'Create a related note.',
    }),
  );
}

export function createFileDeletionProposalFixture(): AiChangeProposal {
  return buildProposal(
    baseInput({
      proposalId: 'proposal-delete-file',
      targetScope: {
        type: 'multi-file',
        filePaths: ['notes/other.md'],
      },
      affectedFiles: [
        {
          path: 'notes/other.md',
          baseFileVersion: proposalFixtureOtherFileVersion,
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
      summary: 'Delete an obsolete related note.',
    }),
  );
}

export function createLinkTargetChangeProposalFixture(): AiChangeProposal {
  return buildProposal(
    baseInput({
      proposalId: 'proposal-link-target',
      targetScope: {
        type: 'current-file',
        filePath: 'notes/root.md',
      },
      affectedFiles: [
        {
          path: 'notes/root.md',
          baseFileVersion: proposalFixtureFileVersion,
          changeKind: 'modify',
          markdownSerialization: {
            status: 'valid',
            markdown: '# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta\n\n[Other](other.md)\n',
            diagnostics: [],
          },
        },
      ],
      operations: [
        {
          type: 'update-link',
          operationId: 'op-update-link-target',
          targetFilePath: 'notes/root.md',
          sourceNodeId: 'root',
          linkId: 'link-other',
          target: {
            type: 'file',
            filePath: 'notes/other.md',
          },
        },
      ],
      summary: 'Retarget a Markdown link.',
    }),
  );
}

export function createStaleProposalReviewFixture(): ProposalReview {
  return createProposalReview(
    createCurrentFileProposalFixture(),
    createProposalReviewEditorSnapshot({
      documentVersion: 8,
    }),
  );
}

export function createReadyProposalReviewFixture(): ProposalReview {
  return createProposalReview(createCurrentFileProposalFixture(), createProposalReviewEditorSnapshot());
}

export function createInvalidProposalSuggestionFixture(): NormalizedAiSuggestion {
  return {
    suggestionId: 'suggestion-invalid-path',
    sourceConversationId: 'conversation-1',
    createdAt: proposalFixtureCreatedAt,
    targetScope: {
      type: 'current-file',
      filePath: 'notes/root.md',
    },
    baseDocumentVersion: 7,
    affectedFiles: [
      {
        path: 'C:/Users/example/secret.md',
        baseFileVersion: proposalFixtureFileVersion,
        changeKind: 'modify',
      },
    ],
    operations: [
      {
        type: 'update-node',
        operationId: 'op-invalid-path',
        targetFilePath: 'C:/Users/example/secret.md',
        nodeId: 'alpha',
        text: 'Invalid path',
      },
    ],
    summary: 'Invalid file target.',
  };
}

export function createEmptyProposalSuggestionFixture(): NormalizedAiSuggestion {
  return {
    suggestionId: 'suggestion-empty',
    sourceConversationId: 'conversation-1',
    createdAt: proposalFixtureCreatedAt,
    targetScope: {
      type: 'current-file',
      filePath: 'notes/root.md',
    },
    baseDocumentVersion: 7,
    affectedFiles: [
      {
        path: 'notes/root.md',
        baseFileVersion: proposalFixtureFileVersion,
        changeKind: 'modify',
      },
    ],
    operations: [],
    summary: 'Empty proposal.',
  };
}

function node(
  id: NodeId,
  parentId: NodeId | null,
  childIds: NodeId[] = [],
  text = id,
): ProposalDocumentSnapshot['nodes'][string] {
  return { id, parentId, childIds, text };
}

function baseInput(overrides: Partial<AiChangeProposalInput> = {}): AiChangeProposalInput {
  return {
    proposalId: 'proposal-1',
    sourceConversationId: 'conversation-1',
    createdAt: proposalFixtureCreatedAt,
    targetScope: {
      type: 'current-file',
      filePath: 'notes/root.md',
    },
    baseDocumentVersion: 7,
    affectedFiles: [
      {
        path: 'notes/root.md',
        baseFileVersion: proposalFixtureFileVersion,
        changeKind: 'modify',
        markdownSerialization: {
          status: 'valid',
          markdown: '# Root\n\n## Alpha revised\n\n## Beta\n',
          diagnostics: [],
        },
      },
    ],
    operations: [
      {
        type: 'update-node',
        operationId: 'op-update-alpha',
        targetFilePath: 'notes/root.md',
        nodeId: 'alpha',
        text: 'Alpha revised',
      },
    ],
    summary: 'Update the current file.',
    ...overrides,
  };
}

function buildProposal(input: AiChangeProposalInput): AiChangeProposal {
  const result = createAiChangeProposal(input, createProposalFixtureContext());
  if (!result.ok) {
    throw new Error(
      `Invalid proposal fixture: ${result.validation.errors
        .map((error) => `${error.code}:${error.message}`)
        .join(', ')}`,
    );
  }

  return result.proposal;
}
