import type { MindMapDocument, MindMapNode, NodeId } from '../../mindmap/domain/mindMap';
import { createEmptyMindMapDocument } from '../../mindmap/domain/mindMap';
import { layoutMindMapDocument } from '../../mindmap/layout';
import type { MindMapLayoutResult } from '../../mindmap/layout';
import type {
  FileVersion,
  LinkToken,
  MarkdownMindMapDocument,
  MarkdownMindMapNode,
  MarkdownOrigin,
  UnmappedMarkdownBlock,
} from '../../../types/markdownLifecycle';
import type {
  ExportFormat,
  ExportRequest,
  ExportScope,
  MindMapRenderLinkToken,
  MindMapRenderSnapshot,
} from '../domain/types';
import { EXPORT_CONTRACT_VERSION, createExportWarning } from '../domain/contract';

export interface SpikeRenderNodeFixture {
  id: NodeId;
  text: string;
  parentId: NodeId | null;
  childIds: NodeId[];
  collapsed: boolean;
  linkTokens: Array<{
    kind: 'wikilink' | 'markdown';
    raw: string;
    target: string;
    alias?: string;
  }>;
}

export interface SpikeRenderSnapshotFixture {
  id: string;
  title: string;
  source: {
    documentPath: string;
    scope: string;
  };
  nodes: Record<NodeId, SpikeRenderNodeFixture>;
  rootNodeId: NodeId;
}

export interface ExportRegressionFixture {
  id: string;
  title: string;
  sourceMarkdown: string;
  document: MindMapDocument;
  markdownDocument: MarkdownMindMapDocument;
  fileVersion: FileVersion;
  resolvedLinkTargets: readonly string[];
  branchNodeIds: {
    heading: NodeId;
    list: NodeId;
    mixed: NodeId;
    deep: NodeId;
    wide: NodeId;
    folded: NodeId;
  };
}

const FIXTURE_DATE = '2026-05-11T00:00:00.000Z';

export function createValidSvgExportRequest(): ExportRequest {
  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: 'svg',
    scope: {
      type: 'selected_branch',
      rootNodeId: 'renderer',
      selectionId: 'selection-renderer',
    },
    options: {
      outputPath: 'exports/renderer.svg',
      overwritePolicy: 'fail_if_exists',
      dimensions: {
        mode: 'explicit',
        width: 1280,
        height: 720,
      },
      theme: {
        source: 'document',
      },
      collapsedBranchPolicy: 'preserve_collapsed',
    },
    source: {
      documentId: 'vit-105-representative-render-snapshot',
      documentVersion: 1,
      workspaceRelativePath: 'maps/export-renderer-proof.md',
      generatedAt: FIXTURE_DATE,
    },
  };
}

export function createRepresentativeExportRegressionFixture(): ExportRegressionFixture {
  const sourceMarkdown = representativeExportMarkdown();
  const nodes: Record<NodeId, MindMapNode> = {};
  const markdownNodes: Record<NodeId, MarkdownMindMapNode> = {};

  const addNode = (
    id: NodeId,
    title: string,
    parentId: NodeId | null,
    options: {
      collapsed?: boolean;
      nodeKind?: MarkdownMindMapNode['nodeKind'];
      links?: LinkToken[];
      task?: boolean;
      line?: number;
    } = {},
  ) => {
    const childIds: NodeId[] = [];
    const markdownChildIds: NodeId[] = [];
    const nodeKind = options.nodeKind ?? (id === 'root' ? 'virtual_root' : 'list_item');
    const origin = markdownOrigin(
      nodeKind === 'virtual_root' ? 'document_root' : nodeKind === 'heading' ? 'heading' : 'list_item',
      id,
      options.line ?? 1,
      nodeKind === 'heading' ? 2 : null,
      nodeKind === 'list_item' ? 1 : null,
    );

    nodes[id] = {
      id,
      text: title,
      parentId,
      childIds,
      collapsed: options.collapsed ?? false,
      createdAt: FIXTURE_DATE,
      updatedAt: FIXTURE_DATE,
    };
    markdownNodes[id] = {
      id,
      title,
      rawText: title,
      nodeKind,
      children: markdownChildIds,
      origin,
      links: options.links ?? [],
      listMarker: options.task
        ? {
            raw: '- [ ]',
            kind: 'task',
            ordinal: null,
            checked: false,
          }
        : null,
    };

    if (parentId) {
      nodes[parentId].childIds.push(id);
      markdownNodes[parentId].children.push(id);
    }
  };

  addNode('root', 'Export Regression Map', null, {
    nodeKind: 'virtual_root',
    line: 1,
  });
  addNode('heading', 'Heading hierarchy', 'root', {
    nodeKind: 'heading',
    line: 5,
  });
  addNode('heading-child', 'Heading child', 'heading', {
    nodeKind: 'heading',
    line: 7,
  });
  addNode('heading-grandchild', 'Heading grandchild', 'heading-child', {
    nodeKind: 'heading',
    line: 9,
  });

  addNode('list', 'List hierarchy', 'root', { line: 11 });
  addNode('task-link', 'Validate [research](./research.md)', 'list', {
    task: true,
    links: [standardMarkdownLink('task-link', '[research](./research.md)', './research.md', 'research', 12)],
    line: 12,
  });
  addNode('wiki-link', 'Review [[Spec|spec]]', 'list', {
    links: [wikiLink('wiki-link', '[[Spec|spec]]', 'Spec', 'spec', 13)],
    line: 13,
  });
  addNode('inline-formatting', 'Keep `code` and *emphasis* readable', 'list', {
    line: 14,
  });

  addNode('mixed', 'Mixed hierarchy branch', 'root', {
    nodeKind: 'heading',
    line: 16,
  });
  addNode('mixed-list-a', 'List child under heading', 'mixed', { line: 17 });
  addNode('mixed-list-b', 'Second list child', 'mixed', { line: 18 });

  addNode(
    'long',
    'Long label '.repeat(16).trim(),
    'root',
    {
      line: 20,
    },
  );

  addNode('deep', 'Deep map', 'root', { line: 22 });
  let parentId: NodeId = 'deep';
  for (let depth = 1; depth <= 10; depth += 1) {
    const nodeId = `deep-${depth}`;
    addNode(nodeId, `Deep level ${depth}`, parentId, { line: 22 + depth });
    parentId = nodeId;
  }

  addNode('wide', 'Wide map', 'root', { line: 35 });
  for (let index = 1; index <= 16; index += 1) {
    addNode(`wide-${index}`, `Wide branch ${index}`, 'wide', { line: 35 + index });
  }

  addNode('folded', 'Folded branch', 'root', {
    collapsed: true,
    line: 54,
  });
  addNode('folded-hidden-a', 'Hidden folded child', 'folded', { line: 55 });
  addNode('folded-hidden-b', 'Hidden folded grandchild', 'folded-hidden-a', { line: 56 });

  const document: MindMapDocument = {
    id: 'export-regression-map',
    title: 'Export Regression Map',
    sourcePath: 'maps/export-regression.md',
    rootNodeId: 'root',
    version: Object.keys(nodes).length,
    nodes,
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE,
  };
  const markdownDocument: MarkdownMindMapDocument = {
    schemaVersion: 'mindmap-document.v1',
    sourcePath: 'maps/export-regression.md',
    title: 'Export Regression Map',
    parseMode: 'mixed',
    rootNodeId: 'root',
    nodes: markdownNodes,
    unmappedBlocks: [
      unmappedBlock('intro-paragraph', 'paragraph', 'Intro paragraph retained only in source Markdown.', 'root', 3),
      unmappedBlock('code-sample', 'code_block', '```ts\nconst exportFixture = true;\n```', 'mixed', 19),
      unmappedBlock('table-sample', 'table', '| Format | Status |\n| --- | --- |\n| PNG | supported |', 'wide', 52),
    ],
    diagnostics: [
      {
        code: 'mixed_hierarchy',
        severity: 'warning',
        message: 'Document mixes heading and list hierarchy styles.',
        origin: markdownOrigin('heading', 'mixed', 16, 2, null),
        nodeId: 'mixed',
      },
      {
        code: 'unmapped_markdown_block',
        severity: 'warning',
        message: 'Raw Markdown blocks need explicit export warnings.',
        origin: markdownOrigin('code_block', 'mixed', 19, null, null),
        nodeId: null,
      },
    ],
  };

  return {
    id: document.id,
    title: document.title,
    sourceMarkdown,
    document,
    markdownDocument,
    fileVersion: {
      modifiedAt: FIXTURE_DATE,
      byteSize: new TextEncoder().encode(sourceMarkdown).byteLength,
      contentHash: 'export-regression-v1',
      token: 'sha256:export-regression-v1',
    },
    resolvedLinkTargets: ['./research.md'],
    branchNodeIds: {
      heading: 'heading',
      list: 'list',
      mixed: 'mixed',
      deep: 'deep',
      wide: 'wide',
      folded: 'folded',
    },
  };
}

export function createExportRequestForRegressionFixture(
  fixture: ExportRegressionFixture,
  format: ExportFormat,
  scope: ExportScope = { type: 'current_file' },
  optionOverrides: Partial<ExportRequest['options']> = {},
): ExportRequest {
  const outputPath = optionOverrides.outputPath ?? `exports/export-regression.${format === 'markdown' ? 'md' : format}`;
  const baseOptions: ExportRequest['options'] = {
    outputPath,
    overwritePolicy: optionOverrides.overwritePolicy ?? 'replace_existing',
    theme: optionOverrides.theme ?? {
      source: 'document',
    },
    collapsedBranchPolicy: optionOverrides.collapsedBranchPolicy ?? 'preserve_collapsed',
    ...(format === 'markdown'
      ? {
          markdown: optionOverrides.markdown ?? {
            mode: 'markmap_hierarchy',
            includeFrontmatter: false,
            includeUnmappedBlocks: false,
          },
        }
      : {
          dimensions: optionOverrides.dimensions ?? {
            mode: 'explicit',
            width: 1280,
            height: 900,
          },
          ...(format === 'png' ? { pixelDensity: optionOverrides.pixelDensity ?? 1 } : {}),
          ...(format === 'pdf'
            ? {
                pdf: optionOverrides.pdf ?? {
                  mode: 'fit_to_single_page',
                },
              }
            : {}),
        }),
  };

  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    format,
    scope,
    options: baseOptions,
    source: {
      documentId: fixture.id,
      documentVersion: fixture.document.version,
      workspaceRelativePath: fixture.document.sourcePath,
      fileVersion: fixture.fileVersion,
      markdownSchemaVersion: fixture.markdownDocument.schemaVersion,
      generatedAt: FIXTURE_DATE,
    },
  };
}

export function createMindMapDocumentFromSpikeFixture(
  fixture: SpikeRenderSnapshotFixture,
): MindMapDocument {
  const createdAt = FIXTURE_DATE;
  const document = createEmptyMindMapDocument({
    id: fixture.id,
    title: fixture.title,
    sourcePath: fixture.source.documentPath,
    rootNodeId: fixture.rootNodeId,
    rootText: fixture.nodes[fixture.rootNodeId]?.text ?? fixture.title,
    now: new Date(FIXTURE_DATE),
  });
  const nodes: Record<NodeId, MindMapNode> = {};

  for (const node of Object.values(fixture.nodes)) {
    nodes[node.id] = {
      id: node.id,
      text: node.text,
      parentId: node.parentId,
      childIds: [...node.childIds],
      collapsed: node.collapsed,
      createdAt,
      updatedAt: createdAt,
    };
  }

  return {
    ...document,
    nodes,
    version: Object.keys(nodes).length,
    updatedAt: createdAt,
  };
}

export function createRenderSnapshotFromSpikeFixture(
  fixture: SpikeRenderSnapshotFixture,
): MindMapRenderSnapshot {
  const document = createMindMapDocumentFromSpikeFixture(fixture);
  const layout = layoutMindMapDocument(document);
  const linkTokens = createLinkTokens(fixture);

  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    snapshotId: fixture.id,
    source: {
      documentId: document.id,
      documentVersion: document.version,
      workspaceRelativePath: fixture.source.documentPath,
      generatedAt: FIXTURE_DATE,
    },
    scope: {
      type: 'current_file',
    },
    bounds: layoutBoundsToExportBounds(layout),
    nodes: layout.nodes.map((layoutNode, index) => {
      const sourceFixtureNode = fixture.nodes[layoutNode.id];
      const sourceLinkTokenIds = sourceFixtureNode.linkTokens.map(
        (_token, tokenIndex) => `${layoutNode.id}:link-${tokenIndex}`,
      );

      return {
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
        textRuns: [
          {
            text: layoutNode.node.text,
            ...(sourceLinkTokenIds[0] ? { linkTokenId: sourceLinkTokenIds[0] } : {}),
          },
        ],
        linkTokenIds: sourceLinkTokenIds,
        collapsed: layoutNode.node.collapsed,
        hiddenDescendantCount: layoutNode.hiddenDescendantCount,
      };
    }),
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
    theme: {
      source: 'document',
      tokens: {
        background: '#ffffff',
        nodeFill: '#f8fafc',
        edgeStroke: '#64748b',
      },
    },
    warnings: [
      createExportWarning(
        'collapsed_content_preserved',
        'Collapsed branch markers are preserved in the render snapshot.',
        { collapsedMarkerCount: layout.nodes.filter((node) => node.hiddenDescendantCount > 0).length },
      ),
    ],
  };
}

function createLinkTokens(
  fixture: SpikeRenderSnapshotFixture,
): MindMapRenderLinkToken[] {
  return Object.values(fixture.nodes).flatMap((node) =>
    node.linkTokens.map((token, index) => ({
      id: `${node.id}:link-${index}`,
      kind: token.kind === 'wikilink' ? 'obsidian_wiki' : 'standard_markdown',
      raw: token.raw,
      label: token.alias ?? token.target,
      target: token.target,
      alias: token.alias ?? null,
      resolvedWorkspacePath: null,
    })),
  );
}

function layoutBoundsToExportBounds(layout: MindMapLayoutResult): MindMapRenderSnapshot['bounds'] {
  return {
    x: layout.bounds.minX,
    y: layout.bounds.minY,
    width: layout.bounds.width,
    height: layout.bounds.height,
  };
}

function representativeExportMarkdown(): string {
  const lines = [
    '# Export Regression Map',
    '',
    'Intro paragraph retained only in source Markdown.',
    '',
    '## Heading hierarchy',
    '',
    '### Heading child',
    '',
    '#### Heading grandchild',
    '',
    '- List hierarchy',
    '  - [ ] Validate [research](./research.md)',
    '  - Review [[Spec|spec]]',
    '  - Keep `code` and *emphasis* readable',
    '',
    '## Mixed hierarchy branch',
    '- List child under heading',
    '- Second list child',
    '',
    '```ts',
    'const exportFixture = true;',
    '```',
    '',
    `- ${'Long label '.repeat(16).trim()}`,
    '- Deep map',
    ...Array.from({ length: 10 }, (_value, index) => `${'  '.repeat(index + 1)}- Deep level ${index + 1}`),
    '- Wide map',
    ...Array.from({ length: 16 }, (_value, index) => `  - Wide branch ${index + 1}`),
    '',
    '| Format | Status |',
    '| --- | --- |',
    '| PNG | supported |',
    '',
    '- Folded branch',
    '  - Hidden folded child',
    '    - Hidden folded grandchild',
    '',
  ];

  return lines.join('\n');
}

function standardMarkdownLink(
  nodeId: NodeId,
  raw: string,
  target: string,
  label: string,
  line: number,
): LinkToken {
  return {
    kind: 'standard_markdown',
    raw,
    label,
    target,
    alias: null,
    origin: markdownOrigin('list_item', nodeId, line, null, 2),
  };
}

function wikiLink(
  nodeId: NodeId,
  raw: string,
  target: string,
  alias: string,
  line: number,
): LinkToken {
  return {
    kind: 'obsidian_wiki',
    raw,
    label: alias,
    target,
    alias,
    origin: markdownOrigin('list_item', nodeId, line, null, 2),
  };
}

function unmappedBlock(
  id: string,
  kind: UnmappedMarkdownBlock['kind'],
  raw: string,
  afterNodeId: NodeId,
  line: number,
): UnmappedMarkdownBlock {
  return {
    id,
    kind,
    raw,
    origin: markdownOrigin(kind, afterNodeId, line, null, null),
    placement: {
      afterNodeId,
      beforeNodeId: null,
    },
    preservation: kind === 'paragraph' ? 'requires_confirmation' : 'block_lossy_save',
  };
}

function markdownOrigin(
  blockKind: MarkdownOrigin['blockKind'],
  nodeId: NodeId,
  startLine: number,
  headingLevel: number | null,
  listDepth: number | null,
): MarkdownOrigin {
  void nodeId;

  return {
    sourcePath: 'maps/export-regression.md',
    span: {
      startLine,
      startColumn: 1,
      endLine: startLine,
      endColumn: 1,
    },
    blockKind,
    headingLevel,
    listDepth,
  };
}
