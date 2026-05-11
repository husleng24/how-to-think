import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MindMapDocument, MindMapNode, NodeId } from '../../../domain/mindMap';
import { createMindMapEditorState } from '../../../domain/mindMap';
import { EXPORT_CONTRACT_VERSION, createExportError, createExportWarning } from '../domain/contract';
import type { ExportFormat, ExportRequest, ExportResult, ExportWarning } from '../domain/types';
import type { DesktopExportCommand } from '../infrastructure/exportCommands';
import { ExportDialog } from './ExportDialog';

const FIXED_DATE = '2026-05-11T00:00:00.000Z';

describe('ExportDialog', () => {
  let runExport: ReturnType<typeof vi.fn<DesktopExportCommand>>;

  beforeEach(() => {
    runExport = vi.fn<DesktopExportCommand>(async ({ request }) => successResult(request));
  });

  it.each([
    ['png', 'current_file'],
    ['svg', 'current_file'],
    ['pdf', 'current_file'],
    ['markdown', 'current_file'],
    ['png', 'selected_branch'],
    ['svg', 'selected_branch'],
    ['pdf', 'selected_branch'],
    ['markdown', 'selected_branch'],
  ] satisfies Array<[ExportFormat, ExportRequest['scope']['type']]>)(
    'submits %s %s exports through the Tauri command boundary',
    async (format, scopeType) => {
      renderDialog({}, runExport);

      if (format !== 'png') {
        fireEvent.click(screen.getByLabelText(formatLabel(format)));
      }

      if (scopeType === 'selected_branch') {
        fireEvent.click(screen.getByLabelText('Selected branch'));
      }

      fireEvent.click(screen.getByRole('button', { name: 'Export' }));

      await waitFor(() => expect(runExport).toHaveBeenCalled());
      const payload = runExport.mock.calls[0][0] as {
        request: ExportRequest;
        markdownArtifact?: { markdown: string };
      };
      expect(payload.request.format).toBe(format);
      expect(payload.request.scope.type).toBe(scopeType);
      expect(payload.request.options.outputPath).toMatch(extensionPattern(format));

      if (scopeType === 'selected_branch') {
        expect(payload.request.scope).toMatchObject({
          type: 'selected_branch',
          rootNodeId: 'roadmap',
        });
      }

      if (format === 'markdown') {
        expect(payload.markdownArtifact?.markdown).toContain(
          scopeType === 'selected_branch' ? '- Roadmap' : '# Product Strategy',
        );
      } else {
        expect(payload.request.snapshot?.nodes.length).toBeGreaterThan(0);
      }

      expect(await screen.findByText('Succeeded')).toBeVisible();
      expect(screen.getByText((text) => text.includes(payload.request.options.outputPath))).toBeVisible();
    },
  );

  it('blocks branch scope when the current selection is not exportable', () => {
    renderDialog({
      selection: {
        selectedNodeId: 'missing',
        focusedNodeId: null,
      },
    });

    expect(screen.getByLabelText('Selected branch')).toBeDisabled();
    expect(screen.getByText('No selected node is available.')).toBeVisible();
  });

  it('renders warnings returned by the export command', async () => {
    runExport.mockImplementation(async ({ request }) => {
      return successResult(request, [
        createExportWarning('pdf_fit_to_page', 'Map was scaled to fit the PDF page.'),
      ]);
    });

    renderDialog({}, runExport);
    fireEvent.click(screen.getByLabelText('PDF'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('Warning present')).toBeVisible();
    expect(screen.getByText('Map was scaled to fit the PDF page.')).toBeVisible();
  });

  it('keeps the editor state intact after failure and supports retry', async () => {
    const editorState = createMindMapEditorState({
      document: editorDocument(),
      selection: {
        selectedNodeId: 'roadmap',
      },
    });
    const before = structuredClone(editorState.document);

    runExport
      .mockImplementationOnce(async ({ request }) => {
        return failureResult(request, 'Renderer failed.');
      })
      .mockImplementationOnce(async ({ request }) => {
        return successResult(request);
      });

    render(
      <ExportDialog
        open
        editorState={editorState}
        runExport={runExport}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByLabelText('SVG'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('Failed')).toBeVisible();
    expect(screen.getByText('Renderer failed.')).toBeVisible();
    expect(editorState.document).toEqual(before);

    fireEvent.change(screen.getByLabelText('Output path'), {
      target: { value: 'exports/retry.svg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('Succeeded')).toBeVisible();
    expect(editorState.document).toEqual(before);
    expect(runExport).toHaveBeenCalledTimes(2);
  });

  it('keeps unsaved editor state out of source-Markdown export mode', async () => {
    const editorState = {
      ...createMindMapEditorState({
        document: editorDocument(),
        selection: {
          selectedNodeId: 'roadmap',
        },
      }),
      isDirty: true,
      savedContentRevision: 1,
      contentRevision: 2,
    };
    const before = structuredClone(editorState.document);

    render(
      <ExportDialog
        open
        editorState={editorState}
        runExport={runExport}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByLabelText('Markdown'));
    expect(screen.getByRole('option', { name: 'Source Markdown' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(runExport).toHaveBeenCalled());
    const payload = runExport.mock.calls[0][0] as {
      request: ExportRequest;
      markdownArtifact?: { markdown: string; writesSourceFile: false };
    };
    expect(payload.request.options.markdown?.mode).toBe('markmap_hierarchy');
    expect(payload.markdownArtifact?.writesSourceFile).toBe(false);
    expect(editorState.document).toEqual(before);
    expect(editorState.isDirty).toBe(true);
  });

  it('shows validation and output errors without closing the dialog', async () => {
    runExport.mockImplementation(async ({ request }) => {
      return {
        ok: false,
        contractVersion: EXPORT_CONTRACT_VERSION,
        format: request.format,
        outputPath: request.options.outputPath,
        warnings: [],
        error: createExportError('output_path_conflict', 'Export output path already exists.'),
      } satisfies ExportResult;
    });

    renderDialog({}, runExport);
    fireEvent.change(screen.getByLabelText('Output path'), { target: { value: '' } });

    expect(screen.getByText('Output path is required.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Output path'), {
      target: { value: 'exports/conflict.png' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    const dialog = await screen.findByRole('dialog', { name: 'Export mind map' });
    expect(within(dialog).getByText('Failed')).toBeVisible();
    expect(within(dialog).getByText('Export output path already exists.')).toBeVisible();
  });
});

function renderDialog(
  options: Partial<Parameters<typeof createMindMapEditorState>[0]> = {},
  runExport?: DesktopExportCommand,
) {
  const editorState = createMindMapEditorState({
    document: editorDocument(),
    selection: {
      selectedNodeId: 'roadmap',
    },
    ...options,
  });

  return render(
    <ExportDialog
      open
      editorState={editorState}
      runExport={runExport}
      onClose={() => undefined}
    />,
  );
}

function successResult(
  request: ExportRequest,
  warnings: readonly ExportWarning[] = [],
): ExportResult {
  return {
    ok: true,
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: request.format,
    outputPath: request.options.outputPath,
    artifact: {
      mimeType:
        request.format === 'png'
          ? 'image/png'
          : request.format === 'svg'
            ? 'image/svg+xml'
            : request.format === 'pdf'
              ? 'application/pdf'
              : 'text/markdown',
      byteSize: 128,
      renderedNodeCount: request.snapshot?.nodes.length ?? 1,
    },
    warnings,
  };
}

function failureResult(request: ExportRequest, message: string): ExportResult {
  return {
    ok: false,
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: request.format,
    outputPath: request.options.outputPath,
    warnings: [],
    error: createExportError('render_failed', message),
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

function formatLabel(format: ExportFormat): string {
  switch (format) {
    case 'png':
      return 'PNG';
    case 'svg':
      return 'SVG';
    case 'pdf':
      return 'PDF';
    case 'markdown':
      return 'Markdown';
  }
}

function extensionPattern(format: ExportFormat): RegExp {
  switch (format) {
    case 'png':
      return /\.png$/;
    case 'svg':
      return /\.svg$/;
    case 'pdf':
      return /\.pdf$/;
    case 'markdown':
      return /\.md$/;
  }
}
