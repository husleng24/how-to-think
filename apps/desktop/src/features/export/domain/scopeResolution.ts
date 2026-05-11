import { layoutMindMapDocument } from '../../mindmap/layout';
import type { MindMapLayoutResult } from '../../mindmap/layout';
import type {
  MindMapDocument,
  MindMapNode,
  NodeId,
  SelectionState,
} from '../../mindmap/domain/mindMap';
import type {
  CompatibilityDiagnostic,
  FileVersion,
  LinkToken,
  MarkdownMindMapDocument,
  MarkdownMindMapNode,
  UnmappedMarkdownBlock,
} from '../../../types/markdownLifecycle';
import {
  EXPORT_CONTRACT_VERSION,
  createExportError,
  createExportWarning,
  exportMimeTypeForFormat,
  validateExportRequest,
} from './contract';
import type {
  CollapsedBranchPolicy,
  ExportError,
  ExportOptions,
  ExportRequest,
  ExportResult,
  ExportScope,
  ExportScopeDiagnostic,
  ExportSourceMetadata,
  ExportWarning,
  MindMapRenderLinkToken,
  MindMapRenderSnapshot,
  MindMapRenderTheme,
  MindMapTextRun,
} from './types';

export interface ResolveExportScopeInput {
  request: ExportRequest;
  document: MindMapDocument;
  selection?: Partial<SelectionState> | null;
  markdownDocument?: MarkdownMindMapDocument | null;
  currentFileVersion?: Pick<FileVersion, 'token' | 'modifiedAt' | 'byteSize'> | null;
  resolvedLinkTargets?: readonly string[];
  theme?: MindMapRenderTheme;
}

export interface ExportScopeResolution {
  contractVersion: typeof EXPORT_CONTRACT_VERSION;
  requestedScope: ExportScope;
  resolvedScope: ExportScope;
  source: ExportSourceMetadata;
  document: MindMapDocument;
  markdownDocument: MarkdownMindMapDocument | null;
  rootNodeId: NodeId;
  nodeIds: readonly NodeId[];
  excludedNodeIds: readonly NodeId[];
  diagnostics: readonly ExportScopeDiagnostic[];
  warnings: readonly ExportWarning[];
  renderSnapshot: MindMapRenderSnapshot;
}

export type ExportScopeResolutionResult =
  | {
      ok: true;
      scope: ExportScopeResolution;
    }
  | {
      ok: false;
      error: ExportError;
      warnings: readonly ExportWarning[];
    };

export interface MarkdownExportArtifact {
  markdown: string;
  byteSize: number;
  writesSourceFile: false;
}

export interface MarkdownExportInput extends ResolveExportScopeInput {
  currentMarkdown?: string | null;
}

export type MarkdownExportResult =
  | {
      ok: true;
      result: ExportResult;
      scope: ExportScopeResolution;
      artifact: MarkdownExportArtifact;
      warnings: readonly ExportWarning[];
    }
  | {
      ok: false;
      result: ExportResult;
      error: ExportError;
      warnings: readonly ExportWarning[];
    };

export function resolveExportScope(input: ResolveExportScopeInput): ExportScopeResolutionResult {
  const rootNodeId = scopeRootNodeId(input.request.scope, input.selection);
  const request =
    input.request.scope.type === 'selected_branch' && rootNodeId
      ? {
          ...input.request,
          scope: {
            ...input.request.scope,
            rootNodeId,
          },
        }
      : input.request;
  const validation = validateExportRequest(request);
  if (!validation.ok) {
    return scopeFailure(validation.errors[0]);
  }

  const freshnessError = validateSourceFreshness(request.source, input.currentFileVersion);
  if (freshnessError) {
    return scopeFailure(freshnessError);
  }

  if (request.scope.type === 'selected_branch' && !rootNodeId) {
    return scopeFailure(
      createExportError('invalid_export_scope', 'Selected branch export requires a selected node id.', {
        details: { field: 'scope.rootNodeId' },
      }),
    );
  }

  const resolvedRootNodeId = rootNodeId ?? input.document.rootNodeId;
  if (!input.document.nodes[resolvedRootNodeId]) {
    return scopeFailure(
      createExportError('invalid_export_scope', 'Selected branch root node was not found.', {
        details: { nodeId: resolvedRootNodeId },
      }),
    );
  }

  const scope = normalizeScope(request.scope, resolvedRootNodeId, input.selection);
  const scopedTree = createScopedDocument(input.document, resolvedRootNodeId, {
    scopeType: request.scope.type,
    collapsedBranchPolicy: request.options.collapsedBranchPolicy,
  });
  const scopedMarkdownDocument = input.markdownDocument
    ? createScopedMarkdownDocument(input.markdownDocument, scopedTree)
    : null;
  const warnings = uniqueWarnings([
    ...collapsedPolicyWarnings(request.options.collapsedBranchPolicy, scopedTree),
    ...markdownCompatibilityWarnings(scopedMarkdownDocument ?? input.markdownDocument, {
      includedNodeIds: new Set(scopedTree.nodeIds),
      resolvedLinkTargets: input.resolvedLinkTargets,
      markdownMode: request.options.markdown?.mode,
      currentFileSourceMarkdown:
        request.scope.type === 'current_file' && request.options.markdown?.mode === 'source_markdown',
    }),
    ...unsupportedNodeWarnings(scopedTree.document),
  ]);
  const diagnostics = scopeDiagnostics(request.scope, warnings, scopedTree.excludedNodeIds);
  const resolvedScope = withDiagnostics(scope, diagnostics);
  const renderSnapshot = createRenderSnapshot({
    document: snapshotDocumentForPolicy(scopedTree.document, request.options.collapsedBranchPolicy),
    markdownDocument: scopedMarkdownDocument,
    source: request.source,
    scope: resolvedScope,
    warnings,
    theme: input.theme,
  });

  return {
    ok: true,
    scope: {
      contractVersion: EXPORT_CONTRACT_VERSION,
      requestedScope: request.scope,
      resolvedScope,
      source: request.source,
      document: scopedTree.document,
      markdownDocument: scopedMarkdownDocument,
      rootNodeId: scopedTree.rootNodeId,
      nodeIds: scopedTree.nodeIds,
      excludedNodeIds: scopedTree.excludedNodeIds,
      diagnostics,
      warnings,
      renderSnapshot,
    },
  };
}

export function exportMarkdownArtifact(input: MarkdownExportInput): MarkdownExportResult {
  const request =
    input.request.format === 'markdown'
      ? input.request
      : {
          ...input.request,
          format: 'markdown' as const,
        };

  if (input.request.format !== 'markdown') {
    const error = createExportError('unsupported_export_format', 'Markdown export requires markdown format.', {
      details: { format: input.request.format },
    });

    return markdownFailure(request, error, []);
  }

  const resolution = resolveExportScope({ ...input, request });
  if (!resolution.ok) {
    return markdownFailure(request, resolution.error, resolution.warnings);
  }

  const scope = resolution.scope;
  const sourceMarkdown =
    request.scope.type === 'current_file' &&
    request.options.markdown?.mode === 'source_markdown' &&
    typeof input.currentMarkdown === 'string'
      ? input.currentMarkdown
      : null;
  const serialization =
    sourceMarkdown !== null
      ? {
          markdown: sourceMarkdown,
          warnings: markdownCompatibilityWarnings(input.markdownDocument ?? null, {
            includedNodeIds: new Set(scope.nodeIds),
            resolvedLinkTargets: input.resolvedLinkTargets,
            markdownMode: 'source_markdown',
            currentFileSourceMarkdown: true,
          }),
        }
      : serializeScopedMarkdown(scope, request.options);
  const markdown = ensureTrailingNewline(serialization.markdown);
  const warnings = uniqueWarnings([...scope.warnings, ...serialization.warnings]);
  const artifact: MarkdownExportArtifact = {
    markdown,
    byteSize: new TextEncoder().encode(markdown).byteLength,
    writesSourceFile: false,
  };
  const result: ExportResult = {
    ok: true,
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: 'markdown',
    outputPath: request.options.outputPath,
    artifact: {
      mimeType: exportMimeTypeForFormat('markdown'),
      byteSize: artifact.byteSize,
      renderedNodeCount: scope.nodeIds.length,
      renderedEdgeCount: Math.max(0, scope.nodeIds.length - 1),
    },
    warnings,
  };

  return {
    ok: true,
    result,
    scope,
    artifact,
    warnings,
  };
}

function validateSourceFreshness(
  source: ExportSourceMetadata,
  currentFileVersion: Pick<FileVersion, 'token' | 'modifiedAt' | 'byteSize'> | null | undefined,
): ExportError | null {
  if (!source.fileVersion || !currentFileVersion) {
    return null;
  }

  if (source.fileVersion.token === currentFileVersion.token) {
    return null;
  }

  return createExportError('source_file_stale', 'Source file version changed before export.', {
    details: {
      expectedToken: source.fileVersion.token,
      currentToken: currentFileVersion.token,
      sourcePath: source.workspaceRelativePath ?? null,
    },
  });
}

function scopeRootNodeId(
  scope: ExportScope,
  selection: Partial<SelectionState> | null | undefined,
): NodeId | null {
  if (scope.type === 'current_file') {
    return null;
  }

  return scope.rootNodeId || selection?.selectedNodeId || null;
}

function normalizeScope(
  scope: ExportScope,
  rootNodeId: NodeId,
  selection: Partial<SelectionState> | null | undefined,
): ExportScope {
  if (scope.type === 'current_file') {
    return { type: 'current_file' };
  }

  return {
    type: 'selected_branch',
    rootNodeId,
    ...(scope.selectionId ? { selectionId: scope.selectionId } : {}),
    ...(!scope.selectionId && selection?.selectedNodeId === rootNodeId
      ? { selectionId: 'current-selection' }
      : {}),
  };
}

function withDiagnostics(scope: ExportScope, diagnostics: readonly ExportScopeDiagnostic[]): ExportScope {
  if (scope.type === 'current_file') {
    return {
      type: 'current_file',
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  return {
    ...scope,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

interface ScopedTree {
  document: MindMapDocument;
  rootNodeId: NodeId;
  nodeIds: NodeId[];
  excludedNodeIds: NodeId[];
}

function createScopedDocument(
  document: MindMapDocument,
  rootNodeId: NodeId,
  options: {
    scopeType: ExportScope['type'];
    collapsedBranchPolicy: CollapsedBranchPolicy;
  },
): ScopedTree {
  const nodeIds: NodeId[] = [];
  const excludedNodeIds: NodeId[] = [];
  const includeCollapsedDescendants = options.collapsedBranchPolicy !== 'visible_only';

  collectNodeIds(document, rootNodeId, includeCollapsedDescendants, nodeIds, excludedNodeIds);

  const included = new Set(nodeIds);
  const nodes: Record<NodeId, MindMapNode> = {};
  for (const nodeId of nodeIds) {
    const node = document.nodes[nodeId];
    const parentId = nodeId === rootNodeId || !included.has(node.parentId ?? '') ? null : node.parentId;
    const collapsed = options.collapsedBranchPolicy === 'expand_all' ? false : node.collapsed;
    nodes[nodeId] = {
      ...node,
      parentId,
      childIds: node.childIds.filter((childId) => included.has(childId)),
      collapsed,
    };
  }

  const root = document.nodes[rootNodeId];
  const isFullCurrentFile = options.scopeType === 'current_file' && rootNodeId === document.rootNodeId;

  return {
    document: {
      ...document,
      id: isFullCurrentFile ? document.id : `${document.id}:${rootNodeId}`,
      title: root.text,
      rootNodeId,
      nodes,
    },
    rootNodeId,
    nodeIds,
    excludedNodeIds,
  };
}

function collectNodeIds(
  document: MindMapDocument,
  nodeId: NodeId,
  includeCollapsedDescendants: boolean,
  nodeIds: NodeId[],
  excludedNodeIds: NodeId[],
): void {
  const node = document.nodes[nodeId];
  if (!node) {
    return;
  }

  nodeIds.push(nodeId);

  if (node.collapsed && !includeCollapsedDescendants) {
    collectDescendantIds(document, nodeId, excludedNodeIds);
    return;
  }

  for (const childId of node.childIds) {
    collectNodeIds(document, childId, includeCollapsedDescendants, nodeIds, excludedNodeIds);
  }
}

function collectDescendantIds(document: MindMapDocument, nodeId: NodeId, ids: NodeId[]): void {
  for (const childId of document.nodes[nodeId]?.childIds ?? []) {
    ids.push(childId);
    collectDescendantIds(document, childId, ids);
  }
}

function createScopedMarkdownDocument(
  document: MarkdownMindMapDocument,
  scopedTree: ScopedTree,
): MarkdownMindMapDocument | null {
  if (!document.nodes[scopedTree.rootNodeId]) {
    return null;
  }

  const included = new Set(scopedTree.nodeIds);
  const nodes = Object.fromEntries(
    scopedTree.nodeIds
      .filter((nodeId) => document.nodes[nodeId])
      .map((nodeId) => {
        const node = document.nodes[nodeId];

        return [
          nodeId,
          {
            ...node,
            children: node.children.filter((childId) => included.has(childId)),
            links: node.links.map((link) => ({ ...link })),
            listMarker: node.listMarker ? { ...node.listMarker } : null,
          } satisfies MarkdownMindMapNode,
        ];
      }),
  );

  return {
    ...document,
    title: document.nodes[scopedTree.rootNodeId].title,
    rootNodeId: scopedTree.rootNodeId,
    nodes,
    unmappedBlocks: document.unmappedBlocks.filter((block) =>
      unmappedBlockBelongsToScope(block, included, scopedTree.rootNodeId === document.rootNodeId),
    ),
    diagnostics: document.diagnostics.filter(
      (diagnostic) => !diagnostic.nodeId || included.has(diagnostic.nodeId),
    ),
  };
}

function unmappedBlockBelongsToScope(
  block: UnmappedMarkdownBlock,
  included: ReadonlySet<NodeId>,
  isFullDocument: boolean,
): boolean {
  if (isFullDocument) {
    return true;
  }

  const afterNodeId = block.placement.afterNodeId;
  const beforeNodeId = block.placement.beforeNodeId;
  return Boolean((afterNodeId && included.has(afterNodeId)) || (beforeNodeId && included.has(beforeNodeId)));
}

function snapshotDocumentForPolicy(
  document: MindMapDocument,
  policy: CollapsedBranchPolicy,
): MindMapDocument {
  if (policy !== 'expand_all') {
    return document;
  }

  return {
    ...document,
    nodes: Object.fromEntries(
      Object.entries(document.nodes).map(([nodeId, node]) => [
        nodeId,
        {
          ...node,
          collapsed: false,
        },
      ]),
    ),
  };
}

function createRenderSnapshot(input: {
  document: MindMapDocument;
  markdownDocument: MarkdownMindMapDocument | null;
  source: ExportSourceMetadata;
  scope: ExportScope;
  warnings: readonly ExportWarning[];
  theme?: MindMapRenderTheme;
}): MindMapRenderSnapshot {
  const layout = layoutMindMapDocument(input.document);
  const linkTokens = renderLinkTokens(input.markdownDocument, layout);
  const linkTokenIdsByNode = groupLinkTokenIdsByNode(linkTokens);

  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    snapshotId: `${input.source.documentId}:${input.scope.type}:${input.document.rootNodeId}:v${
      input.source.documentVersion ?? input.document.version
    }`,
    source: input.source,
    scope: input.scope,
    bounds: {
      x: layout.bounds.minX,
      y: layout.bounds.minY,
      width: layout.bounds.width,
      height: layout.bounds.height,
    },
    nodes: layout.nodes.map((layoutNode, index) => ({
      id: `render:${layoutNode.id}`,
      sourceNodeId: layoutNode.id,
      parentNodeId: layoutNode.node.parentId,
      depth: layoutNode.depth,
      order: index,
      bounds: {
        x: layoutNode.x,
        y: layoutNode.y,
        width: layoutNode.width,
        height: layoutNode.height,
      },
      textRuns: textRunsForNode(layoutNode.node, linkTokenIdsByNode.get(layoutNode.id) ?? []),
      linkTokenIds: linkTokenIdsByNode.get(layoutNode.id) ?? [],
      collapsed: layoutNode.node.collapsed,
      hiddenDescendantCount: layoutNode.hiddenDescendantCount,
    })),
    edges: layout.edges.map((edge) => ({
      id: `render:${edge.id}`,
      sourceNodeId: edge.sourceId,
      targetNodeId: edge.targetId,
      from: edge.source,
      to: edge.target,
    })),
    linkTokens,
    collapsedMarkers: layout.nodes
      .filter((node) => node.hiddenDescendantCount > 0)
      .map((node) => ({
        nodeId: node.id,
        hiddenNodeCount: node.hiddenDescendantCount,
        label: `+${node.hiddenDescendantCount}`,
      })),
    theme: input.theme ?? {
      source: 'document',
      tokens: {},
    },
    warnings: input.warnings,
  };
}

function renderLinkTokens(
  markdownDocument: MarkdownMindMapDocument | null,
  layout: MindMapLayoutResult,
): MindMapRenderLinkToken[] {
  if (!markdownDocument) {
    return [];
  }

  return layout.nodes.flatMap((layoutNode) => {
    const markdownNode = markdownDocument.nodes[layoutNode.id];

    return (markdownNode?.links ?? []).map((link, index) => ({
      id: `${layoutNode.id}:link-${index}`,
      kind: link.kind,
      raw: link.raw,
      label: link.label ?? link.alias ?? link.target,
      target: link.target,
      alias: link.alias,
      resolvedWorkspacePath: null,
    }));
  });
}

function groupLinkTokenIdsByNode(
  linkTokens: readonly MindMapRenderLinkToken[],
): Map<NodeId, string[]> {
  const grouped = new Map<NodeId, string[]>();

  for (const token of linkTokens) {
    const nodeId = token.id.split(':link-')[0];
    grouped.set(nodeId, [...(grouped.get(nodeId) ?? []), token.id]);
  }

  return grouped;
}

function textRunsForNode(node: MindMapNode, linkTokenIds: readonly string[]): readonly MindMapTextRun[] {
  return [
    {
      text: node.text,
      ...(linkTokenIds[0] ? { linkTokenId: linkTokenIds[0] } : {}),
    },
  ];
}

function serializeScopedMarkdown(
  scope: ExportScopeResolution,
  options: ExportOptions,
): { markdown: string; warnings: readonly ExportWarning[] } {
  const markdown = scope.markdownDocument
    ? serializeMarkdownDocument(scope.markdownDocument, scope.resolvedScope.type)
    : serializeEditorDocument(scope.document, scope.resolvedScope.type);
  const warnings = markdownCompatibilityWarnings(scope.markdownDocument, {
    includedNodeIds: new Set(scope.nodeIds),
    markdownMode: options.markdown?.mode,
    currentFileSourceMarkdown: false,
  });

  return {
    markdown,
    warnings,
  };
}

function serializeMarkdownDocument(document: MarkdownMindMapDocument, scopeType: ExportScope['type']): string {
  if (scopeType === 'selected_branch') {
    return serializeMarkdownNodeList(document, document.rootNodeId, 0).join('\n');
  }

  const root = document.nodes[document.rootNodeId];
  if (!root) {
    return '';
  }

  const startNodeIds = root.nodeKind === 'virtual_root' ? root.children : [root.id];
  return startNodeIds.flatMap((nodeId) => serializeMarkdownNodeHeadings(document, nodeId, 1)).join('\n\n');
}

function serializeMarkdownNodeHeadings(
  document: MarkdownMindMapDocument,
  nodeId: NodeId,
  depth: number,
): string[] {
  const node = document.nodes[nodeId];
  if (!node) {
    return [];
  }

  const headingDepth = Math.min(depth, 6);
  const lines =
    depth <= 6
      ? [`${'#'.repeat(headingDepth)} ${safeMarkdownTitle(node.title)}`]
      : [`${'  '.repeat(depth - 7)}${listMarker(node)} ${safeMarkdownTitle(node.title)}`];

  return [...lines, ...node.children.flatMap((childId) => serializeMarkdownNodeHeadings(document, childId, depth + 1))];
}

function serializeMarkdownNodeList(
  document: MarkdownMindMapDocument,
  nodeId: NodeId,
  depth: number,
): string[] {
  const node = document.nodes[nodeId];
  if (!node) {
    return [];
  }

  return [
    `${'  '.repeat(depth)}${listMarker(node)} ${safeMarkdownTitle(node.title)}`,
    ...node.children.flatMap((childId) => serializeMarkdownNodeList(document, childId, depth + 1)),
  ];
}

function serializeEditorDocument(document: MindMapDocument, scopeType: ExportScope['type']): string {
  if (scopeType === 'selected_branch') {
    return serializeEditorNodeList(document, document.rootNodeId, 0).join('\n');
  }

  return serializeEditorNodeHeadings(document, document.rootNodeId, 1).join('\n\n');
}

function serializeEditorNodeHeadings(document: MindMapDocument, nodeId: NodeId, depth: number): string[] {
  const node = document.nodes[nodeId];
  if (!node) {
    return [];
  }

  const lines =
    depth <= 6
      ? [`${'#'.repeat(depth)} ${safeMarkdownTitle(node.text)}`]
      : [`${'  '.repeat(depth - 7)}- ${safeMarkdownTitle(node.text)}`];

  return [...lines, ...node.childIds.flatMap((childId) => serializeEditorNodeHeadings(document, childId, depth + 1))];
}

function serializeEditorNodeList(document: MindMapDocument, nodeId: NodeId, depth: number): string[] {
  const node = document.nodes[nodeId];
  if (!node) {
    return [];
  }

  return [
    `${'  '.repeat(depth)}- ${safeMarkdownTitle(node.text)}`,
    ...node.childIds.flatMap((childId) => serializeEditorNodeList(document, childId, depth + 1)),
  ];
}

function listMarker(node: MarkdownMindMapNode): string {
  if (node.listMarker?.kind === 'task') {
    return node.listMarker.checked ? '- [x]' : '- [ ]';
  }

  return '-';
}

function safeMarkdownTitle(title: string): string {
  const normalized = title.replace(/[\r\n]+/g, ' ').trim();
  return normalized.length > 0 ? normalized : 'Untitled';
}

function markdownCompatibilityWarnings(
  document: MarkdownMindMapDocument | null | undefined,
  options: {
    includedNodeIds: ReadonlySet<NodeId>;
    resolvedLinkTargets?: readonly string[];
    markdownMode?: string;
    currentFileSourceMarkdown: boolean;
  },
): readonly ExportWarning[] {
  if (!document) {
    return [];
  }

  const warnings: ExportWarning[] = [];
  const resolvedTargets = new Set(options.resolvedLinkTargets ?? []);

  for (const diagnostic of document.diagnostics) {
    if (diagnostic.nodeId && !options.includedNodeIds.has(diagnostic.nodeId)) {
      continue;
    }
    warnings.push(markdownDiagnosticWarning(diagnostic));
  }

  for (const block of document.unmappedBlocks) {
    warnings.push(
      createExportWarning('unmapped_markdown_block', 'Markdown block is not represented as a mind map node.', {
        blockKind: block.kind,
        blockId: block.id,
        nodeId: block.placement.afterNodeId ?? block.placement.beforeNodeId ?? null,
      }),
    );
  }

  for (const node of Object.values(document.nodes)) {
    if (!options.includedNodeIds.has(node.id)) {
      continue;
    }

    for (const link of node.links) {
      if (isExternalLink(link.target) || resolvedTargets.has(link.target)) {
        continue;
      }
      warnings.push(unresolvedLinkWarning(node.id, link));
    }
  }

  if (!options.currentFileSourceMarkdown && canonicalizationRisk(document)) {
    warnings.push(
      createExportWarning(
        'markdown_canonicalization',
        'Markdown export uses canonical Markmap-compatible hierarchy output.',
        {
          parseMode: document.parseMode,
          unmappedBlockCount: document.unmappedBlocks.length,
        },
      ),
    );
  }

  if (!options.currentFileSourceMarkdown && document.unmappedBlocks.length > 0) {
    warnings.push(
      createExportWarning(
        'markdown_serialization_lossy',
        'Canonical Markdown export may not preserve all unmapped raw Markdown blocks.',
        { unmappedBlockCount: document.unmappedBlocks.length },
      ),
    );
  }

  return uniqueWarnings(warnings);
}

function markdownDiagnosticWarning(diagnostic: CompatibilityDiagnostic): ExportWarning {
  return createExportWarning('markdown_compatibility_warning', diagnostic.message, {
    diagnosticCode: diagnostic.code,
    nodeId: diagnostic.nodeId ?? null,
    line: diagnostic.origin?.span.startLine ?? null,
  });
}

function unresolvedLinkWarning(nodeId: NodeId, link: LinkToken): ExportWarning {
  return createExportWarning('unresolved_link', `Link target is unresolved: ${link.raw}`, {
    nodeId,
    target: link.target,
    linkKind: link.kind,
  });
}

function canonicalizationRisk(document: MarkdownMindMapDocument): boolean {
  return (
    document.parseMode !== 'heading_only' ||
    document.unmappedBlocks.length > 0 ||
    Object.values(document.nodes).some((node) => node.nodeKind === 'list_item')
  );
}

function unsupportedNodeWarnings(document: MindMapDocument): readonly ExportWarning[] {
  return Object.values(document.nodes)
    .filter((node) => /[\r\n]/.test(node.text))
    .map((node) =>
      createExportWarning('unsupported_node_content', 'Node contains multiline content unsupported by Markdown export.', {
        nodeId: node.id,
      }),
    );
}

function collapsedPolicyWarnings(
  policy: CollapsedBranchPolicy,
  scopedTree: ScopedTree,
): readonly ExportWarning[] {
  if (policy === 'visible_only' && scopedTree.excludedNodeIds.length > 0) {
    return [
      createExportWarning('collapsed_content_omitted', 'Collapsed branch descendants were excluded from export.', {
        excludedNodeCount: scopedTree.excludedNodeIds.length,
      }),
    ];
  }

  if (
    policy === 'preserve_collapsed' &&
    Object.values(scopedTree.document.nodes).some((node) => node.collapsed && node.childIds.length > 0)
  ) {
    return [
      createExportWarning('collapsed_content_preserved', 'Collapsed branch state is preserved in export scope.', {
        collapsedNodeCount: Object.values(scopedTree.document.nodes).filter(
          (node) => node.collapsed && node.childIds.length > 0,
        ).length,
      }),
    ];
  }

  if (policy === 'expand_all') {
    const collapsedNodeCount = Object.values(scopedTree.document.nodes).filter(
      (node) => node.collapsed && node.childIds.length > 0,
    ).length;

    return collapsedNodeCount > 0
      ? [
          createExportWarning('collapsed_content_expanded', 'Collapsed branches were expanded for export.', {
            collapsedNodeCount,
          }),
        ]
      : [];
  }

  return [];
}

function scopeDiagnostics(
  scope: ExportScope,
  warnings: readonly ExportWarning[],
  excludedNodeIds: readonly NodeId[],
): readonly ExportScopeDiagnostic[] {
  const diagnostics: ExportScopeDiagnostic[] = [];

  if (warnings.some((warning) => warning.code === 'markdown_serialization_lossy')) {
    diagnostics.push({
      code: 'scope_contains_lossy_markdown',
      severity: 'warning',
      message: 'Scope contains Markdown that may not serialize without loss.',
    });
  }

  if (scope.type === 'selected_branch' && excludedNodeIds.length > 0) {
    diagnostics.push({
      code: 'scope_contains_lossy_markdown',
      severity: 'warning',
      message: 'Selected branch omits collapsed descendants because visible-only export was requested.',
      nodeId: scope.rootNodeId,
    });
  }

  return diagnostics;
}

function isExternalLink(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function ensureTrailingNewline(markdown: string): string {
  return markdown.endsWith('\n') ? markdown : `${markdown}\n`;
}

function uniqueWarnings(warnings: readonly ExportWarning[]): readonly ExportWarning[] {
  const seen = new Set<string>();
  const unique: ExportWarning[] = [];

  for (const warning of warnings) {
    const key = `${warning.code}:${warning.message}:${JSON.stringify(warning.details ?? {})}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(warning);
    }
  }

  return unique;
}

function scopeFailure(error: ExportError): ExportScopeResolutionResult {
  return {
    ok: false,
    error,
    warnings: [],
  };
}

function markdownFailure(
  request: ExportRequest,
  error: ExportError,
  warnings: readonly ExportWarning[],
): MarkdownExportResult {
  return {
    ok: false,
    result: {
      ok: false,
      contractVersion: EXPORT_CONTRACT_VERSION,
      format: request.format,
      outputPath: request.options.outputPath,
      warnings,
      error,
    },
    error,
    warnings,
  };
}
