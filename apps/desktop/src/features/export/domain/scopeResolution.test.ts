import { describe, expect, it } from 'vitest';

import type { MindMapDocument, MindMapNode, NodeId } from '../../mindmap/domain/mindMap';
import type {
  FileVersion,
  LinkToken,
  MarkdownMindMapDocument,
  MarkdownMindMapNode,
  MarkdownOrigin,
} from '../../../types/markdownLifecycle';
import { validateMindMapRenderSnapshot } from './contract';
import {
  exportMarkdownArtifact,
  resolveExportScope,
} from './scopeResolution';
import type { ExportRequest, ExportScope } from './types';

const FIXED_DATE = '2026-05-11T00:00:00.000Z';
const FILE_VERSION: FileVersion = {
  token: 'sha256:fixture-v1',
  modifiedAt: FIXED_DATE,
  byteSize: 256,
  contentHash: 'fixture-v1',
};
const MIXED_MARKDOWN = [
  '# Product Strategy',
  '',
  'Intro paragraph that is preserved in source Markdown.',
  '',
  '- Positioning',
  '  - Audience with [[Customer|customers]]',
  '  - [ ] Validate [survey](./survey.md)',
  '  - Keep `code` and *emphasis*',
  '- Roadmap',
  '  - MVP',
  '  - Beta',
  '',
  '```ts',
  'const preserved = true;',
  '```',
  '',
].join('\n');

describe('export scope resolution', () => {
  it('resolves current-file scope with full logical content and a valid render snapshot', () => {
    const document = createEditorDocument();
    const markdownDocument = createMarkdownDocument();
    const request = createMarkdownRequest({ type: 'current_file' });

    const result = resolveExportScope({
      request,
      document,
      markdownDocument,
      currentFileVersion: FILE_VERSION,
      resolvedLinkTargets: ['Customer', './survey.md'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.scope.nodeIds).toEqual([
      'root',
      'positioning',
      'audience',
      'validate',
      'inline',
      'roadmap',
      'mvp',
      'beta',
    ]);
    expect(result.scope.document.nodes.roadmap.collapsed).toBe(true);
    expect(result.scope.renderSnapshot.collapsedMarkers).toEqual([
      {
        nodeId: 'roadmap',
        hiddenNodeCount: 2,
        label: '+2',
      },
    ]);
    expect(validateMindMapRenderSnapshot(result.scope.renderSnapshot)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('exports a selected branch as standalone Markdown preserving order, links, tasks, code, and emphasis', () => {
    const result = exportMarkdownArtifact({
      request: createMarkdownRequest({
        type: 'selected_branch',
        rootNodeId: 'positioning',
        selectionId: 'selection-positioning',
      }),
      document: createEditorDocument(),
      markdownDocument: createMarkdownDocument(),
      currentFileVersion: FILE_VERSION,
      resolvedLinkTargets: ['Customer', './survey.md'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.scope.nodeIds).toEqual(['positioning', 'audience', 'validate', 'inline']);
    expect(result.artifact.writesSourceFile).toBe(false);
    expect(result.artifact.markdown).toBe(
      [
        '- Positioning',
        '  - Audience with [[Customer|customers]]',
        '  - [ ] Validate [survey](./survey.md)',
        '  - Keep `code` and *emphasis*',
        '',
      ].join('\n'),
    );
    expect(result.scope.renderSnapshot.nodes.map((node) => node.sourceNodeId)).toEqual([
      'positioning',
      'audience',
      'validate',
      'inline',
    ]);
  });

  it('uses selected node state when the selected-branch request omits a root node id', () => {
    const result = resolveExportScope({
      request: createMarkdownRequest({
        type: 'selected_branch',
        rootNodeId: '',
      }),
      document: createEditorDocument(),
      markdownDocument: createMarkdownDocument(),
      selection: {
        selectedNodeId: 'positioning',
      },
      currentFileVersion: FILE_VERSION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.scope.rootNodeId).toBe('positioning');
    expect(result.scope.resolvedScope).toMatchObject({
      type: 'selected_branch',
      rootNodeId: 'positioning',
    });
  });

  it('fails branch scope with typed non-mutating errors for missing or invalid selection', () => {
    const document = createEditorDocument();
    const before = structuredClone(document);
    const missing = resolveExportScope({
      request: createMarkdownRequest({
        type: 'selected_branch',
        rootNodeId: '',
      }),
      document,
      currentFileVersion: FILE_VERSION,
    });
    const invalid = resolveExportScope({
      request: createMarkdownRequest({
        type: 'selected_branch',
        rootNodeId: 'missing',
      }),
      document,
      currentFileVersion: FILE_VERSION,
    });

    expect(missing.ok).toBe(false);
    expect(missing.ok ? null : missing.error.code).toBe('invalid_export_scope');
    expect(invalid.ok).toBe(false);
    expect(invalid.ok ? null : invalid.error.code).toBe('invalid_export_scope');
    expect(document).toEqual(before);
  });

  it('omits collapsed descendants only when visible-only export is requested', () => {
    const result = exportMarkdownArtifact({
      request: createMarkdownRequest(
        {
          type: 'selected_branch',
          rootNodeId: 'roadmap',
        },
        {
          collapsedBranchPolicy: 'visible_only',
        },
      ),
      document: createEditorDocument(),
      markdownDocument: createMarkdownDocument(),
      currentFileVersion: FILE_VERSION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.scope.nodeIds).toEqual(['roadmap']);
    expect(result.scope.excludedNodeIds).toEqual(['mvp', 'beta']);
    expect(result.artifact.markdown).toBe('- Roadmap\n');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'collapsed_content_omitted',
          details: expect.objectContaining({
            excludedNodeCount: 2,
          }),
        }),
      ]),
    );
  });

  it('returns current safe Markdown unchanged for source-markdown current-file exports', () => {
    const document = createEditorDocument();
    const result = exportMarkdownArtifact({
      request: createMarkdownRequest(
        { type: 'current_file' },
        {
          markdown: {
            mode: 'source_markdown',
            includeUnmappedBlocks: true,
          },
        },
      ),
      document,
      markdownDocument: createMarkdownDocument(),
      currentMarkdown: MIXED_MARKDOWN,
      currentFileVersion: FILE_VERSION,
      resolvedLinkTargets: ['Customer', './survey.md'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.artifact.markdown).toBe(MIXED_MARKDOWN);
    expect(result.artifact.writesSourceFile).toBe(false);
    expect(document).toEqual(createEditorDocument());
    expect(result.warnings.some((warning) => warning.code === 'markdown_serialization_lossy')).toBe(false);
    expect(result.warnings.some((warning) => warning.code === 'unmapped_markdown_block')).toBe(true);
  });

  it('warns for unmapped blocks, unsupported content, unresolved links, and canonicalization risk', () => {
    const document = createEditorDocument({
      inlineText: 'Keep `code`\nand *emphasis*',
    });
    const result = exportMarkdownArtifact({
      request: createMarkdownRequest({ type: 'current_file' }),
      document,
      markdownDocument: createMarkdownDocument(),
      currentFileVersion: FILE_VERSION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const warningCodes = new Set(result.warnings.map((warning) => warning.code));
    expect([...warningCodes]).toEqual(
      expect.arrayContaining([
        'unmapped_markdown_block',
        'unsupported_node_content',
        'unresolved_link',
        'markdown_canonicalization',
        'markdown_serialization_lossy',
      ]),
    );
  });

  it('fails before export when the current source file version is stale', () => {
    const result = exportMarkdownArtifact({
      request: createMarkdownRequest({ type: 'current_file' }),
      document: createEditorDocument(),
      markdownDocument: createMarkdownDocument(),
      currentFileVersion: {
        ...FILE_VERSION,
        token: 'sha256:changed-on-disk',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe('source_file_stale');
  });
});

function createMarkdownRequest(
  scope: ExportScope,
  optionOverrides: Partial<ExportRequest['options']> = {},
): ExportRequest {
  return {
    contractVersion: '2026-05-11.v1',
    format: 'markdown',
    scope,
    options: {
      outputPath: 'exports/product-strategy.md',
      overwritePolicy: 'fail_if_exists',
      theme: {
        source: 'document',
      },
      collapsedBranchPolicy: 'preserve_collapsed',
      markdown: {
        mode: 'markmap_hierarchy',
      },
      ...optionOverrides,
    },
    source: {
      documentId: 'product-strategy',
      documentVersion: 7,
      workspaceRelativePath: 'maps/product-strategy.md',
      fileVersion: FILE_VERSION,
      generatedAt: FIXED_DATE,
    },
  };
}

function createEditorDocument(options: { inlineText?: string } = {}): MindMapDocument {
  const nodes = {
    root: editorNode('root', 'Product Strategy', null, ['positioning', 'roadmap']),
    positioning: editorNode('positioning', 'Positioning', 'root', ['audience', 'validate', 'inline']),
    audience: editorNode('audience', 'Audience with [[Customer|customers]]', 'positioning', []),
    validate: editorNode('validate', 'Validate [survey](./survey.md)', 'positioning', []),
    inline: editorNode('inline', options.inlineText ?? 'Keep `code` and *emphasis*', 'positioning', []),
    roadmap: editorNode('roadmap', 'Roadmap', 'root', ['mvp', 'beta'], true),
    mvp: editorNode('mvp', 'MVP', 'roadmap', []),
    beta: editorNode('beta', 'Beta', 'roadmap', []),
  } satisfies Record<NodeId, MindMapNode>;

  return {
    id: 'product-strategy',
    title: 'Product Strategy',
    sourcePath: 'maps/product-strategy.md',
    rootNodeId: 'root',
    version: 7,
    nodes,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}

function editorNode(
  id: NodeId,
  text: string,
  parentId: NodeId | null,
  childIds: NodeId[],
  collapsed = false,
): MindMapNode {
  return {
    id,
    text,
    parentId,
    childIds,
    collapsed,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}

function createMarkdownDocument(): MarkdownMindMapDocument {
  const nodes = {
    root: markdownNode('root', 'Product Strategy', 'virtual_root', [
      'positioning',
      'roadmap',
    ]),
    positioning: markdownNode('positioning', 'Positioning', 'list_item', [
      'audience',
      'validate',
      'inline',
    ]),
    audience: markdownNode('audience', 'Audience with [[Customer|customers]]', 'list_item', [], {
      links: [wikiLink('audience', '[[Customer|customers]]', 'Customer', 'customers')],
    }),
    validate: markdownNode('validate', 'Validate [survey](./survey.md)', 'list_item', [], {
      listMarker: {
        raw: '- [ ]',
        kind: 'task',
        ordinal: null,
        checked: false,
      },
      links: [markdownLink('validate', '[survey](./survey.md)', './survey.md', 'survey')],
    }),
    inline: markdownNode('inline', 'Keep `code` and *emphasis*', 'list_item', []),
    roadmap: markdownNode('roadmap', 'Roadmap', 'list_item', ['mvp', 'beta']),
    mvp: markdownNode('mvp', 'MVP', 'list_item', []),
    beta: markdownNode('beta', 'Beta', 'list_item', []),
  } satisfies Record<NodeId, MarkdownMindMapNode>;

  return {
    schemaVersion: 'mindmap-document.v1',
    sourcePath: 'maps/product-strategy.md',
    title: 'Product Strategy',
    parseMode: 'mixed',
    rootNodeId: 'root',
    nodes,
    unmappedBlocks: [
      {
        id: 'paragraph-1',
        kind: 'paragraph',
        raw: 'Intro paragraph that is preserved in source Markdown.',
        origin: origin('paragraph', 'root', 3),
        placement: {
          afterNodeId: 'root',
          beforeNodeId: null,
        },
        preservation: 'requires_confirmation',
      },
      {
        id: 'code-1',
        kind: 'code_block',
        raw: '```ts\nconst preserved = true;\n```',
        origin: origin('code_block', 'roadmap', 13),
        placement: {
          afterNodeId: 'roadmap',
          beforeNodeId: null,
        },
        preservation: 'block_lossy_save',
      },
    ],
    diagnostics: [
      {
        code: 'mixed_hierarchy',
        severity: 'warning',
        message: 'Document mixes headings and lists; canonical export may rewrite hierarchy syntax.',
        origin: null,
        nodeId: null,
      },
    ],
  };
}

function markdownNode(
  id: NodeId,
  title: string,
  nodeKind: MarkdownMindMapNode['nodeKind'],
  children: NodeId[],
  options: Partial<Pick<MarkdownMindMapNode, 'links' | 'listMarker'>> = {},
): MarkdownMindMapNode {
  return {
    id,
    title,
    rawText: title,
    nodeKind,
    children,
    origin: origin(nodeKind === 'virtual_root' ? 'document_root' : 'list_item', id, 1),
    links: options.links ?? [],
    listMarker: options.listMarker ?? null,
  };
}

function wikiLink(nodeId: NodeId, raw: string, target: string, alias: string): LinkToken {
  return {
    kind: 'obsidian_wiki',
    raw,
    label: alias,
    target,
    alias,
    origin: origin('list_item', nodeId, 1),
  };
}

function markdownLink(nodeId: NodeId, raw: string, target: string, label: string): LinkToken {
  return {
    kind: 'standard_markdown',
    raw,
    label,
    target,
    alias: null,
    origin: origin('list_item', nodeId, 1),
  };
}

function origin(
  blockKind: MarkdownOrigin['blockKind'],
  nodeId: NodeId,
  startLine: number,
): MarkdownOrigin {
  void nodeId;

  return {
    sourcePath: 'maps/product-strategy.md',
    span: {
      startLine,
      startColumn: 1,
      endLine: startLine,
      endColumn: 1,
    },
    blockKind,
    headingLevel: null,
    listDepth: blockKind === 'list_item' ? 1 : null,
  };
}
