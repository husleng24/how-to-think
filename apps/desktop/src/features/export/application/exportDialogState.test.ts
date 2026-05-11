import { describe, expect, it } from 'vitest';

import type { MindMapDocument, MindMapNode, NodeId } from '../../../domain/mindMap';
import { createMindMapEditorState } from '../../../domain/mindMap';
import { validateExportRequest } from '../domain/contract';
import {
  createExportDialogContext,
  prepareDesktopExport,
} from './desktopExportWorkflow';
import {
  buildExportOptions,
  canSubmitExport,
  createExportDialogState,
  defaultExportOutputPath,
  exportDialogReducer,
  exportDialogValidationMessages,
  exportFormatOptionAvailability,
} from './exportDialogState';
import type { ExportDialogContext } from './exportDialogState';

const FIXED_DATE = '2026-05-11T00:00:00.000Z';

describe('export dialog state', () => {
  it('generates default output paths from the current document and format', () => {
    const context = exportContext();

    expect(defaultExportOutputPath(context, 'png', 'current_file')).toBe(
      'maps/product-strategy.png',
    );
    expect(defaultExportOutputPath(context, 'svg', 'selected_branch')).toBe(
      'maps/product-strategy-roadmap.png'.replace('.png', '.svg'),
    );
    expect(defaultExportOutputPath(context, 'markdown', 'current_file')).toBe(
      'maps/product-strategy-export.md',
    );
    expect(defaultExportOutputPath(context, 'markdown', 'selected_branch')).toBe(
      'maps/product-strategy-roadmap.md',
    );
  });

  it('blocks selected-branch export when no node is selected', () => {
    const context = exportContext({
      selectedNodeId: null,
      selectedNodeTitle: null,
    });
    const state = exportDialogReducer(createExportDialogState(context), {
      type: 'set-scope',
      scopeType: 'selected_branch',
      context,
    });

    expect(canSubmitExport(state, context)).toBe(false);
    expect(exportDialogValidationMessages(state, context)).toContain(
      'Selected branch export requires a selected node.',
    );
  });

  it('shows only options that apply to the selected format', () => {
    expect(exportFormatOptionAvailability('png')).toMatchObject({
      showPixelDensity: true,
      showPdfOptions: false,
      showMarkdownOptions: false,
    });
    expect(exportFormatOptionAvailability('pdf')).toMatchObject({
      showPixelDensity: false,
      showPdfOptions: true,
    });
    expect(exportFormatOptionAvailability('markdown')).toMatchObject({
      showVisualDimensions: false,
      showMarkdownOptions: true,
    });
  });

  it('maps format-specific controls to validated ExportOptions', () => {
    const context = exportContext();
    const pdfState = {
      ...createExportDialogState(context, 'pdf'),
      dimensionMode: 'explicit' as const,
      width: 900,
      height: 600,
      pdfPageMode: 'custom_page' as const,
      pdfWidth: 420,
      pdfHeight: 320,
      pdfMargin: 16,
    };
    const markdownState = createExportDialogState(context, 'markdown');

    expect(buildExportOptions(pdfState)).toMatchObject({
      dimensions: {
        mode: 'explicit',
        width: 900,
        height: 600,
      },
      pdf: {
        mode: 'custom_page',
        width: 420,
        height: 320,
        margin: 16,
      },
    });
    expect(buildExportOptions(markdownState)).not.toHaveProperty('dimensions');
    expect(buildExportOptions(markdownState)).toMatchObject({
      markdown: {
        mode: 'markmap_hierarchy',
      },
    });
  });

  it('prepares visual export requests with renderer-neutral snapshots without mutating editor state', () => {
    const editorState = createMindMapEditorState({
      document: editorDocument(),
      selection: {
        selectedNodeId: 'roadmap',
      },
    });
    const context = createExportDialogContext(editorState);
    const before = structuredClone(editorState.document);
    const dialogState = exportDialogReducer(createExportDialogState(context, 'svg'), {
      type: 'set-scope',
      scopeType: 'selected_branch',
      context,
    });
    const prepared = prepareDesktopExport({
      dialogState,
      context,
      editorState,
      now: () => new Date(FIXED_DATE),
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error('Expected export preparation to succeed.');
    }
    expect(prepared.export.request.format).toBe('svg');
    expect(prepared.export.request.scope).toMatchObject({
      type: 'selected_branch',
      rootNodeId: 'roadmap',
    });
    expect(prepared.export.request.snapshot?.nodes.map((node) => node.sourceNodeId)).toEqual([
      'roadmap',
      'mvp',
    ]);
    expect(validateExportRequest(prepared.export.request)).toEqual({ ok: true, errors: [] });
    expect(editorState.document).toEqual(before);
  });

  it('prepares Markdown artifacts from editor state and rejects unsafe source-copy mode while dirty', () => {
    const editorState = {
      ...createMindMapEditorState({
        document: editorDocument(),
      }),
      isDirty: true,
    };
    const context = createExportDialogContext(editorState);
    const hierarchyState = createExportDialogState(context, 'markdown');
    const sourceCopyState = {
      ...hierarchyState,
      markdownMode: 'source_markdown' as const,
    };

    const hierarchy = prepareDesktopExport({
      dialogState: hierarchyState,
      context,
      editorState,
      now: () => new Date(FIXED_DATE),
    });
    const sourceCopy = prepareDesktopExport({
      dialogState: sourceCopyState,
      context,
      editorState,
      now: () => new Date(FIXED_DATE),
    });

    expect(hierarchy.ok).toBe(true);
    if (!hierarchy.ok) {
      throw new Error('Expected Markdown export preparation to succeed.');
    }
    expect(hierarchy.export.markdownArtifact?.writesSourceFile).toBe(false);
    expect(hierarchy.export.markdownArtifact?.markdown).toContain('# Product Strategy');
    expect(sourceCopy.ok).toBe(false);
    if (sourceCopy.ok) {
      throw new Error('Expected source-copy export preparation to fail.');
    }
    if (sourceCopy.result.ok) {
      throw new Error('Expected failed export result.');
    }
    expect(sourceCopy.result.error.code).toBe('incompatible_export_options');
  });
});

function exportContext(overrides: Partial<ExportDialogContext> = {}): ExportDialogContext {
  return {
    documentTitle: 'Product Strategy',
    documentPath: 'maps/product-strategy.md',
    selectedNodeId: 'roadmap',
    selectedNodeTitle: 'Roadmap',
    hasUnsavedChanges: false,
    ...overrides,
  };
}

function editorDocument(): MindMapDocument {
  const nodes = {
    root: editorNode('root', 'Product Strategy', null, ['positioning', 'roadmap']),
    positioning: editorNode('positioning', 'Positioning', 'root', []),
    roadmap: editorNode('roadmap', 'Roadmap', 'root', ['mvp']),
    mvp: editorNode('mvp', 'MVP', 'roadmap', []),
  } satisfies Record<NodeId, MindMapNode>;

  return {
    id: 'product-strategy',
    title: 'Product Strategy',
    sourcePath: 'maps/product-strategy.md',
    rootNodeId: 'root',
    version: 4,
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
): MindMapNode {
  return {
    id,
    text,
    parentId,
    childIds,
    collapsed: false,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}
