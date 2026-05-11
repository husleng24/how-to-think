import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXPORT_CONTRACT_VERSION,
  EXPORT_ERROR_CODES,
  EXPORT_MIME_TYPES,
  createExportError,
  createExportWarning,
  exportMimeTypeForFormat,
  isExportFormat,
  validateExportRequest,
  validateMindMapRenderSnapshot,
} from './contract';
import {
  createRenderSnapshotFromSpikeFixture,
  createValidSvgExportRequest,
} from '../fixtures/exportFixtures';
import type { SpikeRenderSnapshotFixture } from '../fixtures/exportFixtures';
import type { ExportRequest, ExportResult } from './types';

describe('export contract validation', () => {
  it('accepts a valid SVG export request', () => {
    expect(validateExportRequest(createValidSvgExportRequest())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('rejects unsupported formats before rendering or writing', () => {
    const request = {
      ...createValidSvgExportRequest(),
      format: 'webp',
    };

    const result = validateExportRequest(request);

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(EXPORT_ERROR_CODES.UNSUPPORTED_EXPORT_FORMAT);
  });

  it('rejects selected branch scope without a root node id', () => {
    const request: ExportRequest = {
      ...createValidSvgExportRequest(),
      scope: {
        type: 'selected_branch',
        rootNodeId: '',
      },
    };

    const result = validateExportRequest(request);

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(EXPORT_ERROR_CODES.INVALID_EXPORT_SCOPE);
  });

  it('rejects invalid dimensions without mutating the request', () => {
    const request: ExportRequest = {
      ...createValidSvgExportRequest(),
      options: {
        ...createValidSvgExportRequest().options,
        dimensions: {
          mode: 'explicit',
          width: 0,
          height: 720,
        },
      },
    };
    const before = structuredClone(request);

    const result = validateExportRequest(request);

    expect(request).toEqual(before);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(EXPORT_ERROR_CODES.INVALID_EXPORT_DIMENSIONS);
  });

  it('rejects PDF-only options for PNG requests', () => {
    const request: ExportRequest = {
      ...createValidSvgExportRequest(),
      format: 'png',
      options: {
        outputPath: 'exports/renderer.png',
        overwritePolicy: 'fail_if_exists',
        dimensions: {
          mode: 'layout_bounds',
        },
        pixelDensity: 2,
        theme: {
          source: 'document',
        },
        collapsedBranchPolicy: 'preserve_collapsed',
        pdf: {
          mode: 'fit_to_single_page',
        },
      },
    };

    const result = validateExportRequest(request);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({
      code: EXPORT_ERROR_CODES.INCOMPATIBLE_EXPORT_OPTIONS,
      details: {
        field: 'options.pdf',
      },
    });
  });

  it('rejects visual dimensions for Markdown requests', () => {
    const request: ExportRequest = {
      ...createValidSvgExportRequest(),
      format: 'markdown',
      options: {
        outputPath: 'exports/renderer.md',
        overwritePolicy: 'replace_existing',
        dimensions: {
          mode: 'scale',
          scale: 1.5,
        },
        theme: {
          source: 'document',
        },
        collapsedBranchPolicy: 'expand_all',
        markdown: {
          mode: 'markmap_hierarchy',
        },
      },
    };

    const result = validateExportRequest(request);

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(EXPORT_ERROR_CODES.INCOMPATIBLE_EXPORT_OPTIONS);
  });

  it('keeps format and MIME helpers stable', () => {
    expect(isExportFormat('svg')).toBe(true);
    expect(isExportFormat('webp')).toBe(false);
    expect(exportMimeTypeForFormat('pdf')).toBe('application/pdf');
    expect(EXPORT_MIME_TYPES.markdown).toBe('text/markdown');
  });

  it('serializes warnings, errors, and result objects for CLI JSON payloads', () => {
    const warning = createExportWarning('pdf_fit_to_page', 'Map was scaled to fit one PDF page.', {
      scale: 0.62,
    });
    const error = createExportError('output_not_writable', 'Output path is not writable.', {
      details: {
        outputPath: 'exports/renderer.pdf',
      },
    });
    const success: ExportResult = {
      ok: true,
      contractVersion: EXPORT_CONTRACT_VERSION,
      format: 'pdf',
      outputPath: 'exports/renderer.pdf',
      artifact: {
        mimeType: exportMimeTypeForFormat('pdf'),
        byteSize: 13052,
        pageCount: 1,
        renderedNodeCount: 20,
      },
      warnings: [warning],
    };

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'output_not_writable',
      message: 'Output path is not writable.',
      recoverable: true,
      details: {
        outputPath: 'exports/renderer.pdf',
      },
    });
    expect(JSON.parse(JSON.stringify(success))).toMatchObject({
      ok: true,
      format: 'pdf',
      outputPath: 'exports/renderer.pdf',
      artifact: {
        mimeType: 'application/pdf',
        pageCount: 1,
      },
      warnings: [
        {
          code: 'pdf_fit_to_page',
        },
      ],
    });
  });
});

describe('MindMapRenderSnapshot contract', () => {
  it('constructs a valid renderer-neutral snapshot from the VIT-105 spike fixture', async () => {
    const fixture = await readVit105Fixture();
    const snapshot = createRenderSnapshotFromSpikeFixture(fixture);

    expect(validateMindMapRenderSnapshot(snapshot)).toEqual({
      ok: true,
      errors: [],
    });
    expect(snapshot.nodes).toHaveLength(20);
    expect(snapshot.collapsedMarkers).toEqual([
      {
        nodeId: 'folded',
        hiddenNodeCount: 3,
        label: '+3',
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('HTMLCanvasElement');
    expect(JSON.stringify(snapshot)).not.toContain('React');
  });

  it('rejects snapshot edges that reference unknown nodes', async () => {
    const fixture = await readVit105Fixture();
    const snapshot = createRenderSnapshotFromSpikeFixture(fixture);
    const invalidSnapshot = {
      ...snapshot,
      edges: [
        ...snapshot.edges,
        {
          id: 'bad-edge',
          sourceNodeId: 'root',
          targetNodeId: 'missing',
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
        },
      ],
    };

    const result = validateMindMapRenderSnapshot(invalidSnapshot);

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe(EXPORT_ERROR_CODES.INVALID_RENDER_SNAPSHOT);
  });
});

async function readVit105Fixture(): Promise<SpikeRenderSnapshotFixture> {
  const fixturePath = join(
    repoRoot(),
    'docs',
    'spikes',
    'export-renderer',
    'fixtures',
    'representative-render-snapshot.json',
  );
  const raw = await readFile(fixturePath, 'utf8');

  return JSON.parse(raw) as SpikeRenderSnapshotFixture;
}

function repoRoot(): string {
  const cwd = normalize(process.cwd());
  return cwd.endsWith(normalize('apps/desktop')) ? join(cwd, '..', '..') : cwd;
}
