import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EXPORT_CONTRACT_VERSION } from '../domain/contract';
import type { ExportRequest, ExportResult, MindMapRenderSnapshot } from '../domain/types';
import { runDesktopExport } from './exportCommands';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const FIXED_DATE = '2026-05-11T00:00:00.000Z';

describe('runDesktopExport', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('invokes the registered Tauri command with a prepared Markdown artifact', async () => {
    const request = exportRequest('markdown');
    invokeMock.mockResolvedValue(successResult(request));

    await runDesktopExport({
      request,
      markdownArtifact: {
        markdown: '# Product Strategy\n',
        byteSize: 19,
        writesSourceFile: false,
      },
    });

    expect(invokeMock).toHaveBeenCalledWith('exportMindMap', {
      request,
      artifact: expect.objectContaining({
        mimeType: 'text/markdown',
        byteSize: 19,
      }),
    });
    const payload = invokeMock.mock.calls[0][1] as {
      artifact: { data: number[] };
    };
    expect(new TextDecoder().decode(new Uint8Array(payload.artifact.data))).toBe('# Product Strategy\n');
  });

  it('renders SVG before invoking the registered Tauri command', async () => {
    const request = exportRequest('svg', renderSnapshot());
    invokeMock.mockResolvedValue(successResult(request));

    await runDesktopExport({ request });

    expect(invokeMock).toHaveBeenCalledWith('exportMindMap', {
      request,
      artifact: expect.objectContaining({
        mimeType: 'image/svg+xml',
        width: expect.any(Number),
        height: expect.any(Number),
        renderedNodeCount: 1,
      }),
    });
    const payload = invokeMock.mock.calls[0][1] as {
      artifact: { data: number[] };
    };
    expect(new TextDecoder().decode(new Uint8Array(payload.artifact.data))).toContain('<svg');
  });
});

function exportRequest(
  format: ExportRequest['format'],
  snapshot?: MindMapRenderSnapshot,
): ExportRequest {
  const outputPath = format === 'markdown' ? 'exports/product-strategy.md' : `exports/product-strategy.${format}`;

  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    format,
    scope: { type: 'current_file' },
    options: {
      outputPath,
      overwritePolicy: 'replace_existing',
      theme: { source: 'document' },
      collapsedBranchPolicy: 'preserve_collapsed',
      ...(format === 'markdown'
        ? {
            markdown: {
              mode: 'markmap_hierarchy',
              includeFrontmatter: false,
              includeUnmappedBlocks: false,
            },
          }
        : {}),
    },
    source: {
      documentId: 'product-strategy',
      workspaceRelativePath: 'maps/product-strategy.md',
      generatedAt: FIXED_DATE,
    },
    ...(snapshot ? { snapshot } : {}),
  };
}

function renderSnapshot(): MindMapRenderSnapshot {
  const source = {
    documentId: 'product-strategy',
    workspaceRelativePath: 'maps/product-strategy.md',
    generatedAt: FIXED_DATE,
  };

  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    snapshotId: 'snapshot-product-strategy',
    source,
    scope: { type: 'current_file' },
    bounds: { x: 0, y: 0, width: 180, height: 64 },
    nodes: [
      {
        id: 'render-root',
        sourceNodeId: 'root',
        parentNodeId: null,
        depth: 0,
        order: 0,
        bounds: { x: 0, y: 0, width: 180, height: 64 },
        textRuns: [{ text: 'Product Strategy' }],
        linkTokenIds: [],
        collapsed: false,
        hiddenDescendantCount: 0,
      },
    ],
    edges: [],
    linkTokens: [],
    collapsedMarkers: [],
    theme: { source: 'document', tokens: {} },
    warnings: [],
  };
}

function successResult(request: ExportRequest): ExportResult {
  return {
    ok: true,
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: request.format,
    outputPath: request.options.outputPath,
    artifact: {
      mimeType: request.format === 'svg' ? 'image/svg+xml' : 'text/markdown',
      byteSize: 128,
    },
    warnings: [],
  };
}
