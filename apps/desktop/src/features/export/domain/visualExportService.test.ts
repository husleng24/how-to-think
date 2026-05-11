import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';

import { createRenderSnapshotFromSpikeFixture } from '../fixtures/exportFixtures';
import type { SpikeRenderSnapshotFixture } from '../fixtures/exportFixtures';
import { createNodeVisualExportDependencies } from '../infrastructure/nodeVisualExport';
import { EXPORT_CONTRACT_VERSION } from './contract';
import { renderMindMapSnapshotToSvg } from './svgRenderer';
import {
  exportMindMapVisual,
  validateVisualExportOutputPath,
} from './visualExportService';
import type { ExportFormat, ExportRequest, ExportResult, MindMapRenderSnapshot } from './types';

const tempDirs: string[] = [];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SVG visual renderer', () => {
  it('emits deterministic self-contained SVG with nodes, connectors, links, and collapsed markers', async () => {
    const snapshot = await readSnapshot();
    const request = createVisualRequest(snapshot, 'svg', 'exports/renderer.svg');

    const first = renderMindMapSnapshotToSvg(snapshot, request.options);
    const second = renderMindMapSnapshotToSvg(snapshot, request.options);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error('Expected SVG rendering to succeed.');
    }

    expect(first.artifact.svg).toBe(second.artifact.svg);
    expect(first.artifact.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(first.artifact.svg).toContain('role="img"');
    expect(first.artifact.svg).toContain('<path d=');
    expect(first.artifact.svg).toContain('data-collapsed-marker="true"');
    expect(first.artifact.svg).toContain('+3');
    expect(first.artifact.svg).toContain('Renderer Spike');
    expect(first.artifact.svg).toContain('Markmap');
    expect(first.artifact.svg).toContain('compatibility');
    expect(first.artifact.svg).not.toContain('[[Renderer Spike');
    expect(first.artifact.svg).not.toContain('<foreignObject');
  });

  it('maps explicit dimensions and warns when maps are scaled down substantially', async () => {
    const snapshot = await readSnapshot();
    const request = createVisualRequest(snapshot, 'svg', 'exports/renderer.svg', {
      dimensions: {
        mode: 'explicit',
        width: 420,
        height: 260,
      },
    });

    const result = renderMindMapSnapshotToSvg(snapshot, request.options);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.artifact.width).toBe(420);
    expect(result.artifact.height).toBe(260);
    expect(result.artifact.warnings.some((warning) => warning.code === 'large_map_scaled')).toBe(true);
  });
});

describe('visual export service', () => {
  it('writes valid SVG, PNG, and PDF artifacts through the shared service path', async () => {
    const snapshot = await readSnapshot();
    const tempDir = await makeTempDir();
    const dependencies = createNodeVisualExportDependencies();

    const svgResult = await exportMindMapVisual(
      createVisualRequest(snapshot, 'svg', join(tempDir, 'renderer.svg')),
      dependencies,
    );
    expectSuccess(svgResult);
    expect(svgResult.artifact.mimeType).toBe('image/svg+xml');
    expect(svgResult.artifact.renderedNodeCount).toBe(snapshot.nodes.length);
    expect(await readFile(svgResult.outputPath, 'utf8')).toContain('<svg');

    const pngResult = await exportMindMapVisual(
      createVisualRequest(snapshot, 'png', join(tempDir, 'renderer.png'), {
        dimensions: {
          mode: 'explicit',
          width: 640,
          height: 420,
        },
        pixelDensity: 2,
      }),
      dependencies,
    );
    expectSuccess(pngResult);
    const png = await readFile(pngResult.outputPath);
    expect(png.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
    expect(png.readUInt32BE(16)).toBe(pngResult.artifact.width);
    expect(png.readUInt32BE(20)).toBe(pngResult.artifact.height);

    const pdfResult = await exportMindMapVisual(
      createVisualRequest(snapshot, 'pdf', join(tempDir, 'renderer.pdf'), {
        dimensions: {
          mode: 'explicit',
          width: 900,
          height: 600,
        },
        pdf: {
          mode: 'custom_page',
          width: 360,
          height: 240,
          margin: 12,
          unit: 'pt',
        },
      }),
      dependencies,
    );
    expectSuccess(pdfResult);
    const pdf = await readFile(pdfResult.outputPath);
    expect(pdf.toString('ascii', 0, 4)).toBe('%PDF');
    expect(pdfResult.artifact.pageCount).toBe(1);
    expect(pdfResult.warnings.some((warning) => warning.code === 'pdf_fit_to_page')).toBe(true);
  });

  it('rejects extension mismatches before rendering or writing', async () => {
    const snapshot = await readSnapshot();
    const tempDir = await makeTempDir();
    const outputPath = join(tempDir, 'renderer.png');
    const error = validateVisualExportOutputPath(outputPath, 'svg');

    expect(error).toMatchObject({
      code: 'incompatible_export_options',
      details: {
        expectedExtension: '.svg',
      },
    });

    const result = await exportMindMapVisual(
      createVisualRequest(snapshot, 'svg', outputPath),
      createNodeVisualExportDependencies(),
    );

    expectFailure(result, 'incompatible_export_options');
  });

  it('respects overwrite policy and missing parent directory checks', async () => {
    const snapshot = await readSnapshot();
    const tempDir = await makeTempDir();
    const outputPath = join(tempDir, 'renderer.svg');
    await writeFile(outputPath, 'existing', 'utf8');

    const conflict = await exportMindMapVisual(
      createVisualRequest(snapshot, 'svg', outputPath, {
        overwritePolicy: 'fail_if_exists',
      }),
      createNodeVisualExportDependencies(),
    );

    expectFailure(conflict, 'output_path_conflict');
    expect(await readFile(outputPath, 'utf8')).toBe('existing');

    const missingParent = await exportMindMapVisual(
      createVisualRequest(snapshot, 'svg', join(tempDir, 'missing', 'renderer.svg')),
      createNodeVisualExportDependencies(),
    );

    expectFailure(missingParent, 'output_not_writable');
  });

  it('fails clearly for impossible PNG dimensions without creating an artifact', async () => {
    const snapshot = await readSnapshot();
    const tempDir = await makeTempDir();
    const outputPath = join(tempDir, 'oversized.png');
    const result = await exportMindMapVisual(
      createVisualRequest(snapshot, 'png', outputPath, {
        dimensions: {
          mode: 'explicit',
          width: 17000,
          height: 17000,
        },
        pixelDensity: 1,
      }),
      createNodeVisualExportDependencies(),
    );

    expectFailure(result, 'invalid_export_dimensions');
    expect(result.error.details).toMatchObject({ stage: 'conversion' });
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports cancellation through a typed export error hook', async () => {
    const snapshot = await readSnapshot();
    const tempDir = await makeTempDir();
    const controller = new AbortController();
    controller.abort();

    const result = await exportMindMapVisual(
      createVisualRequest(snapshot, 'svg', join(tempDir, 'renderer.svg')),
      createNodeVisualExportDependencies(),
      { signal: controller.signal },
    );

    expectFailure(result, 'export_cancelled');
    expect(result.error.details).toMatchObject({ stage: 'cancelled' });
  });
});

async function readSnapshot(): Promise<MindMapRenderSnapshot> {
  const fixturePath = join(
    repoRoot(),
    'docs',
    'spikes',
    'export-renderer',
    'fixtures',
    'representative-render-snapshot.json',
  );
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as SpikeRenderSnapshotFixture;

  return createRenderSnapshotFromSpikeFixture(fixture);
}

function repoRoot(): string {
  const cwd = normalize(process.cwd());
  return cwd.endsWith(normalize('apps/desktop')) ? join(cwd, '..', '..') : cwd;
}

function createVisualRequest(
  snapshot: MindMapRenderSnapshot,
  format: Exclude<ExportFormat, 'markdown'>,
  outputPath: string,
  options: Partial<ExportRequest['options']> = {},
): ExportRequest {
  const dimensions = options.dimensions ?? {
    mode: 'explicit' as const,
    width: 1280,
    height: 720,
  };

  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    format,
    scope: snapshot.scope,
    source: snapshot.source,
    snapshot,
    options: {
      outputPath,
      overwritePolicy: options.overwritePolicy ?? 'replace_existing',
      dimensions,
      ...(format === 'png' ? { pixelDensity: options.pixelDensity ?? 1 } : {}),
      theme: options.theme ?? {
        source: 'document',
      },
      ...(format === 'pdf'
        ? {
            pdf: options.pdf ?? {
              mode: 'fit_to_single_page',
            },
          }
        : {}),
      collapsedBranchPolicy: options.collapsedBranchPolicy ?? 'preserve_collapsed',
    },
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'how-to-think-export-'));
  tempDirs.push(dir);
  return dir;
}

function expectSuccess(result: ExportResult): asserts result is Extract<ExportResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  expect(result.ok).toBe(true);
  expect(result.artifact.byteSize).toBeGreaterThan(0);
  expect(result.artifact.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
}

function expectFailure(
  result: ExportResult,
  code: Exclude<ExportResult, { ok: true }>['error']['code'],
): asserts result is Extract<ExportResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected export to fail.');
  }
  expect(result.error.code).toBe(code);
}
