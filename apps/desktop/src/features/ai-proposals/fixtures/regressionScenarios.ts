import {
  createMindMapEditorState,
  type MindMapDocument,
  type MindMapEditorState,
  type MindMapNode,
} from '../../../domain/mindMap';
import type {
  CompatibilityDiagnostic,
  FileVersion,
  MarkdownMindMapDocument,
  MarkdownMindMapNode,
  MarkdownOrigin,
  SaveMarkdownMindMapResult,
  SerializeMindMapResult,
} from '../../../types/markdownLifecycle';
import type { SaveStatus } from '../../workspace/types';
import { createAiChangeProposal } from '../domain/conversion';
import type {
  AiChangeProposal,
  AiChangeProposalInput,
  NodeId,
  ProposalDocumentSnapshot,
  ProposalFileVersionAnchor,
  ProposalNodeSnapshot,
  ProposalValidationContext,
  WorkspaceRelativePath,
} from '../domain/types';
import type { ApplyProposalActiveState, ApplyProposalSerializeInput } from '../application/applyProposal';
import type {
  MultiFileApplyBackend,
  MultiFileApplyPreflightFileState,
  MultiFileBackendApplyFileResult,
} from '../application/applyMultiFileProposal';
import type { ProposalReviewEditorSnapshot } from '../application/types';

export const regressionWorkspaceId = 'workspace-regression';
export const regressionCreatedAt = '2026-05-10T00:00:00.000Z';
export const regressionSavedAt = '2026-05-10T00:01:00.000Z';
export const regressionRootPath = 'notes/root.md';
export const regressionOtherPath = 'notes/other.md';

export interface RegressionDocumentOptions {
  path?: WorkspaceRelativePath;
  largeBranch?: boolean;
  includeWikiLink?: boolean;
}

export interface RegressionActiveApplyStateOptions extends RegressionDocumentOptions {
  fileVersion?: ProposalFileVersionAnchor;
  markdownBuffer?: string;
  saveStatus?: SaveStatus;
  editorState?: MindMapEditorState;
}

export function createRegressionFileVersion(
  path: WorkspaceRelativePath = regressionRootPath,
  revision = 7,
): FileVersion {
  return {
    token: `version:${path}:${revision}`,
    modifiedAt: regressionCreatedAt,
    byteSize: 128 + revision,
    contentHash: `${path}:hash:${revision}`,
  };
}

export const regressionRootFileVersion = createRegressionFileVersion(regressionRootPath, 7);
export const regressionOtherFileVersion = createRegressionFileVersion(regressionOtherPath, 3);

export function createRegressionRawMarkdownSnapshot(options: RegressionDocumentOptions = {}): string {
  if (options.largeBranch) {
    const children = Array.from({ length: 10 }, (_, index) => `### Alpha child ${index + 1}`).join('\n\n');
    return `# Root\n\n## Alpha\n\n${children}\n\n## Beta\n`;
  }

  const wikiLink = options.includeWikiLink ? '\n\n[[notes/other#Beta|Other beta]]' : '';
  return `# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta${wikiLink}\n`;
}

export function createRegressionProposalDocumentSnapshot(
  options: RegressionDocumentOptions = {},
): ProposalDocumentSnapshot {
  const path = options.path ?? regressionRootPath;
  const nodes = options.largeBranch ? largeBranchNodes() : standardNodes(options.includeWikiLink);

  return {
    id: path,
    version: 7,
    rootNodeId: 'root',
    nodes,
  };
}

export function createRegressionMindMapDocument(options: RegressionDocumentOptions = {}): MindMapDocument {
  const snapshot = createRegressionProposalDocumentSnapshot(options);

  return {
    id: snapshot.id,
    title: 'Root',
    sourcePath: options.path ?? regressionRootPath,
    rootNodeId: snapshot.rootNodeId,
    version: snapshot.version,
    createdAt: regressionCreatedAt,
    updatedAt: regressionCreatedAt,
    nodes: Object.fromEntries(
      Object.entries(snapshot.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          id: node.id,
          text: node.text,
          parentId: node.parentId,
          childIds: [...node.childIds],
          collapsed: node.id === 'alpha',
          createdAt: regressionCreatedAt,
          updatedAt: regressionCreatedAt,
        } satisfies MindMapNode,
      ]),
    ),
  };
}

export function createRegressionMarkdownDocument(
  options: RegressionDocumentOptions = {},
): MarkdownMindMapDocument {
  const path = options.path ?? regressionRootPath;
  const snapshot = createRegressionProposalDocumentSnapshot(options);
  const depths = collectDepths(snapshot);

  return {
    schemaVersion: 'mindmap-document.v1',
    sourcePath: path,
    title: 'Root',
    parseMode: 'auto',
    rootNodeId: snapshot.rootNodeId,
    nodes: Object.fromEntries(
      Object.entries(snapshot.nodes).map(([nodeId, node]) => [
        nodeId,
        markdownNode({
          node,
          path,
          depth: depths.get(nodeId) ?? 1,
          includeWikiLink: Boolean(options.includeWikiLink) && nodeId === 'beta',
          rootNodeId: snapshot.rootNodeId,
        }),
      ]),
    ),
    unmappedBlocks: [],
    diagnostics: [],
  };
}

export function createRegressionActiveApplyState(
  options: RegressionActiveApplyStateOptions = {},
): ApplyProposalActiveState {
  const documentOptions: RegressionDocumentOptions = {
    path: options.path,
    largeBranch: options.largeBranch,
    includeWikiLink: options.includeWikiLink,
  };
  const document = createRegressionMindMapDocument(documentOptions);
  const editorState =
    options.editorState ??
    createMindMapEditorState({
      document,
      selection: {
        selectedNodeId: 'alpha',
        focusedNodeId: 'alpha',
      },
    });

  return {
    workspaceId: regressionWorkspaceId,
    activeFilePath: options.path ?? regressionRootPath,
    fileVersion: options.fileVersion ?? regressionRootFileVersion,
    editorState,
    markdownDocument: createRegressionMarkdownDocument(documentOptions),
    markdownBuffer: options.markdownBuffer ?? createRegressionRawMarkdownSnapshot(documentOptions),
    saveStatus:
      options.saveStatus ??
      {
        kind: 'saved',
        message: 'Saved',
        savedAt: regressionCreatedAt,
      },
  };
}

export function createRegressionReviewEditorSnapshot(
  active: ApplyProposalActiveState = createRegressionActiveApplyState(),
  overrides: Partial<ProposalReviewEditorSnapshot> = {},
): ProposalReviewEditorSnapshot {
  return {
    document: active.editorState.document,
    markdownBuffer: active.markdownBuffer,
    markdownBuffersByPath: {
      [regressionRootPath]: active.markdownBuffer,
      [regressionOtherPath]: '# Other\n\n## Beta\n',
    },
    fileVersion: active.fileVersion,
    fileVersions: {
      [regressionRootPath]: active.fileVersion,
      [regressionOtherPath]: regressionOtherFileVersion,
    },
    activeFilePath: active.activeFilePath,
    documentVersion: active.editorState.document.version,
    isDirty: active.editorState.isDirty,
    undoHistory: active.editorState.history,
    selection: active.editorState.selection,
    capturedAt: regressionCreatedAt,
    ...overrides,
  };
}

export function createBranchRewriteRegressionProposal(): AiChangeProposal {
  return buildRegressionProposal({
    proposalId: 'proposal-regression-branch-rewrite',
    summary: 'Rewrite the alpha branch and move beta underneath it.',
    operations: [
      {
        type: 'update-node',
        operationId: 'op-rewrite-alpha',
        targetFilePath: regressionRootPath,
        nodeId: 'alpha',
        text: 'Alpha rewritten',
      },
      {
        type: 'move-branch',
        operationId: 'op-move-beta-under-alpha',
        targetFilePath: regressionRootPath,
        nodeId: 'beta',
        newParentNodeId: 'alpha',
        index: 1,
      },
    ],
    affectedFiles: [
      {
        path: regressionRootPath,
        baseFileVersion: regressionRootFileVersion,
        changeKind: 'modify',
        markdownSerialization: {
          status: 'valid',
          markdown: '# Root\n\n## Alpha rewritten\n\n### Alpha child\n\n### Beta\n',
          diagnostics: [],
        },
      },
    ],
  });
}

export function createNodeExpansionRegressionProposal(): AiChangeProposal {
  return buildRegressionProposal({
    proposalId: 'proposal-regression-node-expansion',
    summary: 'Expand alpha with a generated supporting child.',
    operations: [
      {
        type: 'add-node',
        operationId: 'op-add-alpha-support',
        targetFilePath: regressionRootPath,
        parentNodeId: 'alpha',
        nodeId: 'alpha-support',
        text: 'Alpha support',
      },
    ],
    affectedFiles: [
      {
        path: regressionRootPath,
        baseFileVersion: regressionRootFileVersion,
        changeKind: 'modify',
        markdownSerialization: {
          status: 'valid',
          markdown: '# Root\n\n## Alpha\n\n### Alpha child\n\n### Alpha support\n\n## Beta\n',
          diagnostics: [],
        },
      },
    ],
  });
}

export function createSummaryReplacementRegressionProposal(): AiChangeProposal {
  return buildRegressionProposal({
    proposalId: 'proposal-regression-summary-replacement',
    summary: 'Replace the beta summary text.',
    operations: [
      {
        type: 'update-node',
        operationId: 'op-replace-beta-summary',
        targetFilePath: regressionRootPath,
        nodeId: 'beta',
        text: 'Decision summary: align scope and safety',
      },
    ],
    affectedFiles: [
      {
        path: regressionRootPath,
        baseFileVersion: regressionRootFileVersion,
        changeKind: 'modify',
        markdownSerialization: {
          status: 'valid',
          markdown: '# Root\n\n## Alpha\n\n### Alpha child\n\n## Decision summary: align scope and safety\n',
          diagnostics: [],
        },
      },
    ],
  });
}

export function createLargeDeletionRegressionProposal(): AiChangeProposal {
  return buildRegressionProposal(
    {
      proposalId: 'proposal-regression-large-deletion',
      summary: 'Remove the generated alpha branch.',
      operations: [
        {
          type: 'delete-node',
          operationId: 'op-delete-large-alpha-branch',
          targetFilePath: regressionRootPath,
          nodeId: 'alpha',
        },
      ],
      affectedFiles: [
        {
          path: regressionRootPath,
          baseFileVersion: regressionRootFileVersion,
          changeKind: 'modify',
          markdownSerialization: {
            status: 'valid',
            markdown: '# Root\n\n## Beta\n',
            diagnostics: [],
          },
        },
      ],
    },
    { largeBranch: true },
  );
}

export function createUnsupportedLinkOperationRegressionProposal(): AiChangeProposal {
  return buildRegressionProposal({
    proposalId: 'proposal-regression-unsupported-link',
    summary: 'Add a wiki link to beta.',
    operations: [
      {
        type: 'add-link',
        operationId: 'op-add-beta-wikilink',
        targetFilePath: regressionRootPath,
        sourceNodeId: 'beta',
        linkId: 'link-other-beta',
        target: {
          type: 'file',
          filePath: regressionOtherPath,
        },
        label: 'Other beta',
      },
    ],
    affectedFiles: [
      {
        path: regressionRootPath,
        baseFileVersion: regressionRootFileVersion,
        changeKind: 'modify',
        markdownSerialization: {
          status: 'valid',
          markdown: '# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta [[notes/other#Beta|Other beta]]\n',
          diagnostics: [],
        },
      },
    ],
  });
}

export function createWikilinkMultiFileRegressionProposal(): AiChangeProposal {
  return buildRegressionProposal({
    proposalId: 'proposal-regression-wikilink-multi-file',
    targetScope: {
      type: 'multi-file',
      filePaths: [regressionRootPath, regressionOtherPath],
    },
    summary: 'Update a linked note and retarget its wiki link.',
    operations: [
      {
        type: 'update-link',
        operationId: 'op-retarget-root-wikilink',
        targetFilePath: regressionRootPath,
        sourceNodeId: 'beta',
        linkId: 'link-other-beta',
        target: {
          type: 'node',
          filePath: regressionOtherPath,
          nodeId: 'beta',
        },
      },
      {
        type: 'update-node',
        operationId: 'op-update-other-beta',
        targetFilePath: regressionOtherPath,
        nodeId: 'beta',
        text: 'Other beta revised',
      },
    ],
    affectedFiles: [
      {
        path: regressionRootPath,
        baseFileVersion: regressionRootFileVersion,
        changeKind: 'modify',
        markdownSerialization: {
          status: 'valid',
          markdown: '# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta [[notes/other#Beta|Other beta]]\n',
          diagnostics: [],
        },
      },
      {
        path: regressionOtherPath,
        baseFileVersion: regressionOtherFileVersion,
        changeKind: 'modify',
        markdownSerialization: {
          status: 'valid',
          markdown: '# Other\n\n## Other beta revised\n',
          diagnostics: [],
        },
      },
    ],
  });
}

export function serializeRegressionMarkdown(input: ApplyProposalSerializeInput): SerializeMindMapResult {
  return {
    status: 'serialized',
    markdown: renderRegressionMarkdown(input.document),
    diagnostics: [],
    metadata: markdownMetadata(input.document, input.targetPath),
  };
}

export function createRegressionSerializationError(code = 'markdown_serializer_failed'): SerializeMindMapResult {
  return {
    status: 'serializationError',
    diagnostics: [diagnosticError(code)],
    metadata: markdownMetadata(createRegressionMarkdownDocument(), regressionRootPath),
  };
}

export function createRegressionCompatibilityError(code = 'markmap_invalid_hierarchy'): SerializeMindMapResult {
  const document = createRegressionMarkdownDocument();

  return {
    status: 'serialized',
    markdown: renderRegressionMarkdown(document),
    diagnostics: [diagnosticError(code)],
    metadata: markdownMetadata(document, regressionRootPath),
  };
}

export function createRegressionSavedResult(input: {
  markdown: string;
  version?: FileVersion;
  savedAt?: string;
}): SaveMarkdownMindMapResult {
  const version = input.version ?? createRegressionFileVersion(regressionRootPath, 8);

  return {
    status: 'saved',
    markdown: input.markdown,
    diagnostics: [],
    metadata: markdownMetadata(createRegressionMarkdownDocument(), regressionRootPath),
    save: {
      workspaceId: regressionWorkspaceId,
      relativePath: regressionRootPath,
      version,
      savedAt: input.savedAt ?? regressionSavedAt,
      byteSize: version.byteSize,
    },
  };
}

export function createRegressionBlockedSaveResult(code = 'backend_write_failed'): SaveMarkdownMindMapResult {
  return {
    status: 'serializationError',
    diagnostics: [diagnosticError(code)],
    metadata: markdownMetadata(createRegressionMarkdownDocument(), regressionRootPath),
  };
}

export function cleanRegressionMultiFilePreflightStates(): MultiFileApplyPreflightFileState[] {
  return [
    {
      path: regressionRootPath,
      exists: true,
      version: regressionRootFileVersion,
      writable: true,
    },
    {
      path: regressionOtherPath,
      exists: true,
      version: regressionOtherFileVersion,
      writable: true,
    },
  ];
}

export function createSequentialPartialFailureBackend(): MultiFileApplyBackend {
  let applyCount = 0;

  return {
    preflightFiles: () => cleanRegressionMultiFilePreflightStates(),
    applyFile: (input): MultiFileBackendApplyFileResult => {
      applyCount += 1;
      if (applyCount === 1) {
        return {
          ok: true,
          appliedFile: {
            path: input.file.path,
            operationType: input.file.operationType,
            version: createRegressionFileVersion(input.file.path, 8),
          },
          rollback: {
            path: input.file.path,
            operationType: input.file.operationType,
            recoveryToken: 'rollback-root',
            previousVersion: input.file.baseFileVersion,
            previousMarkdown: '# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta\n',
          },
        };
      }

      return {
        ok: false,
        code: 'backend_write_failed',
        message: 'Backend write failed after the first file was applied.',
        filePath: input.file.path,
      };
    },
    rollbackFile: () => ({ ok: true }),
  };
}

function buildRegressionProposal(
  overrides: Partial<AiChangeProposalInput>,
  options: RegressionDocumentOptions = {},
): AiChangeProposal {
  const context = createRegressionValidationContext(options);
  const input: AiChangeProposalInput = {
    proposalId: 'proposal-regression',
    sourceConversationId: 'conversation-regression',
    createdAt: regressionCreatedAt,
    targetScope: {
      type: 'current-file',
      filePath: regressionRootPath,
    },
    baseDocumentVersion: 7,
    affectedFiles: [
      {
        path: regressionRootPath,
        baseFileVersion: regressionRootFileVersion,
        changeKind: 'modify',
        markdownSerialization: {
          status: 'valid',
          markdown: '# Root\n\n## Alpha\n\n### Alpha child\n\n## Beta\n',
          diagnostics: [],
        },
      },
    ],
    operations: [
      {
        type: 'update-node',
        operationId: 'op-update-alpha',
        targetFilePath: regressionRootPath,
        nodeId: 'alpha',
        text: 'Alpha revised',
      },
    ],
    summary: 'Regression proposal.',
    ...overrides,
  };
  const result = createAiChangeProposal(input, context);

  if (!result.ok) {
    throw new Error(
      `Invalid regression proposal fixture: ${result.validation.errors
        .map((error) => `${error.code}:${error.message}`)
        .join(', ')}`,
    );
  }

  return result.proposal;
}

function createRegressionValidationContext(options: RegressionDocumentOptions = {}): ProposalValidationContext {
  return {
    workspaceId: regressionWorkspaceId,
    activeFilePath: regressionRootPath,
    baseDocumentVersion: 7,
    knownFiles: [
      {
        path: regressionRootPath,
        version: regressionRootFileVersion,
        document: createRegressionProposalDocumentSnapshot(options),
      },
      {
        path: regressionOtherPath,
        version: regressionOtherFileVersion,
        document: createRegressionProposalDocumentSnapshot({
          path: regressionOtherPath,
          includeWikiLink: options.includeWikiLink,
        }),
      },
    ],
  };
}

function standardNodes(includeWikiLink = false): Record<NodeId, ProposalNodeSnapshot> {
  return {
    root: proposalNode('root', null, ['alpha', 'beta'], 'Root'),
    alpha: proposalNode('alpha', 'root', ['alpha-child'], 'Alpha'),
    'alpha-child': proposalNode('alpha-child', 'alpha', [], 'Alpha child'),
    beta: {
      ...proposalNode('beta', 'root', [], 'Beta'),
      links: includeWikiLink
        ? [
            {
              id: 'link-other-beta',
              label: 'Other beta',
              target: {
                type: 'node',
                filePath: regressionOtherPath,
                nodeId: 'beta',
              },
            },
          ]
        : undefined,
    },
  };
}

function largeBranchNodes(): Record<NodeId, ProposalNodeSnapshot> {
  const alphaChildren = Array.from({ length: 10 }, (_, index) => `alpha-child-${index + 1}`);

  return {
    root: proposalNode('root', null, ['alpha', 'beta'], 'Root'),
    alpha: proposalNode('alpha', 'root', alphaChildren, 'Alpha'),
    ...Object.fromEntries(
      alphaChildren.map((childId, index) => [
        childId,
        proposalNode(childId, 'alpha', [], `Alpha child ${index + 1}`),
      ]),
    ),
    beta: proposalNode('beta', 'root', [], 'Beta'),
  };
}

function proposalNode(
  id: NodeId,
  parentId: NodeId | null,
  childIds: NodeId[],
  text: string,
): ProposalNodeSnapshot {
  return { id, parentId, childIds, text };
}

function markdownNode(input: {
  node: ProposalNodeSnapshot;
  path: WorkspaceRelativePath;
  depth: number;
  includeWikiLink: boolean;
  rootNodeId: NodeId;
}): MarkdownMindMapNode {
  const isRoot = input.node.id === input.rootNodeId || input.node.parentId === null;
  const origin = markdownOrigin(isRoot ? 'document_root' : 'heading', isRoot ? null : input.depth, input.path);

  return {
    id: input.node.id,
    title: input.node.text,
    rawText: isRoot ? '' : `${'#'.repeat(input.depth)} ${input.node.text}`,
    nodeKind: isRoot ? 'virtual_root' : 'heading',
    children: [...input.node.childIds],
    origin,
    links: input.includeWikiLink
      ? [
          {
            kind: 'obsidian_wiki',
            raw: '[[notes/other#Beta|Other beta]]',
            label: 'Other beta',
            target: 'notes/other#Beta',
            alias: 'Other beta',
            origin,
          },
        ]
      : [],
    listMarker: null,
  };
}

function markdownOrigin(
  blockKind: MarkdownOrigin['blockKind'],
  headingLevel: number | null,
  sourcePath: WorkspaceRelativePath,
): MarkdownOrigin {
  return {
    sourcePath,
    span: {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    },
    blockKind,
    headingLevel,
    listDepth: null,
  };
}

function collectDepths(document: ProposalDocumentSnapshot): Map<NodeId, number> {
  const depths = new Map<NodeId, number>();
  const visit = (nodeId: NodeId, depth: number): void => {
    depths.set(nodeId, depth);
    for (const childId of document.nodes[nodeId]?.childIds ?? []) {
      visit(childId, depth + 1);
    }
  };

  visit(document.rootNodeId, 1);
  return depths;
}

function renderRegressionMarkdown(document: MarkdownMindMapDocument): string {
  const lines: string[] = [`# ${document.title}`];

  const visit = (nodeId: NodeId, depth: number): void => {
    const node = document.nodes[nodeId];
    if (!node) {
      return;
    }

    if (nodeId !== document.rootNodeId) {
      const linkSuffix = node.links.length > 0 ? ` ${node.links.map((link) => link.raw).join(' ')}` : '';
      lines.push(`${'#'.repeat(depth)} ${node.title}${linkSuffix}`);
    }

    for (const childId of node.children) {
      visit(childId, nodeId === document.rootNodeId ? 2 : depth + 1);
    }
  };

  visit(document.rootNodeId, 1);
  return `${lines.join('\n\n')}\n`;
}

function markdownMetadata(
  document: MarkdownMindMapDocument,
  targetPath: WorkspaceRelativePath,
): SerializeMindMapResult['metadata'] {
  return {
    schemaVersion: 'markdown-serializer.v1',
    sourcePath: document.sourcePath,
    targetPath,
    saveMode: 'canonical_headings',
    preservationPolicy: 'block_lossy',
    lineEnding: 'lf',
    canonicalized: false,
    nodeCount: Object.keys(document.nodes).length - 1,
    unmappedBlockCount: document.unmappedBlocks.length,
  };
}

function diagnosticError(code: string): CompatibilityDiagnostic {
  return {
    code,
    severity: 'error',
    message: code,
    origin: null,
    nodeId: null,
  };
}
