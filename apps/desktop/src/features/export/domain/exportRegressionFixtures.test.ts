import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createExportRequestForRegressionFixture,
  createRepresentativeExportRegressionFixture,
} from '../fixtures/exportFixtures';
import { createNodeVisualExportDependencies } from '../infrastructure/nodeVisualExport';
import { createExportError, validateMindMapRenderSnapshot } from './contract';
import {
  exportMarkdownArtifact,
  resolveExportScope,
} from './scopeResolution';
import { renderMindMapSnapshotToSvg } from './svgRenderer';
import {
  exportMindMapVisual,
  type VisualExportServiceDependencies,
} from './visualExportService';
import type { ExportFormat, ExportRequest, ExportResult, MindMapRenderSnapshot } from './types';

const tempDirs: string[] = [];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('export regression fixtures', () => {
  it('builds a deterministic representative scope covering hierarchy, size, links, folds, and unmapped Markdown', () => {
    const fixture = createRepresentativeExportRegressionFixture();
    const beforeDocument = structuredClone(fixture.document);
    const beforeMarkdownDocument = structuredClone(fixture.markdownDocument);
    const request = createExportRequestForRegressionFixture(fixture, 'svg');

    const result = resolveExportScope({
      request,
      document: fixture.document,
      markdownDocument: fixture.markdownDocument,
      currentFileVersion: fixture.fileVersion,
      resolvedLinkTargets: fixture.resolvedLinkTargets,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.scope.nodeIds).toEqual(
      expect.arrayContaining([
        fixture.branchNodeIds.heading,
        'heading-grandchild',
        fixture.branchNodeIds.list,
        'task-link',
        'wiki-link',
        'inline-formatting',
        fixture.branchNodeIds.mixed,
        'long',
        'deep-10',
        'wide-16',
        'folded-hidden-b',
      ]),
    );
    expect(result.scope.renderSnapshot.collapsedMarkers).toEqual([
      {
        nodeId: fixture.branchNodeIds.folded,
        hiddenNodeCount: 2,
        label: '+2',
      },
    ]);
    expect(result.scope.renderSnapshot.linkTokens.map((token) => token.raw)).toEqual([
      '[research](./research.md)',
      '[[Spec|spec]]',
    ]);
    expect(validateMindMapRenderSnapshot(result.scope.renderSnapshot)).toEqual({
      ok: true,
      errors: [],
    });

    const warningCodes = new Set(result.scope.warnings.map((warning) => warning.code));
    expect([...warningCodes]).toEqual(
      expect.arrayContaining([
        'collapsed_content_preserved',
        'markdown_compatibility_warning',
        'unmapped_markdown_block',
        'unresolved_link',
        'markdown_canonicalization',
        'markdown_serialization_lossy',
      ]),
    );
    expect(fixture.document).toEqual(beforeDocument);
    expect(fixture.markdownDocument).toEqual(beforeMarkdownDocument);
  });

  it('exports representative branch Markdown with tasks, wikilinks, Markdown links, code, and emphasis intact', () => {
    const fixture = createRepresentativeExportRegressionFixture();
    const beforeDocument = structuredClone(fixture.document);
    const beforeMarkdownDocument = structuredClone(fixture.markdownDocument);
    const request = createExportRequestForRegressionFixture(
      fixture,
      'markdown',
      {
        type: 'selected_branch',
        rootNodeId: fixture.branchNodeIds.list,
        selectionId: 'selection-list',
      },
      {
        outputPath: 'exports/list-branch.md',
      },
    );

    const result = exportMarkdownArtifact({
      request,
      document: fixture.document,
      markdownDocument: fixture.markdownDocument,
      currentFileVersion: fixture.fileVersion,
      resolvedLinkTargets: fixture.resolvedLinkTargets,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    expect(result.scope.nodeIds).toEqual(['list', 'task-link', 'wiki-link', 'inline-formatting']);
    expect(result.artifact.writesSourceFile).toBe(false);
    expect(result.artifact.markdown).toBe(
      [
        '- List hierarchy',
        '  - [ ] Validate [research](./research.md)',
        '  - Review [[Spec|spec]]',
        '  - Keep `code` and *emphasis* readable',
        '',
      ].join('\n'),
    );
    expect(result.warnings.some((warning) => warning.code === 'unresolved_link')).toBe(true);
    expect(fixture.sourceMarkdown).toContain('Intro paragraph retained only in source Markdown.');
    expect(fixture.document).toEqual(beforeDocument);
    expect(fixture.markdownDocument).toEqual(beforeMarkdownDocument);
  });

  it('returns source Markdown unchanged for current-file source exports and fails stale exports before mutation', () => {
    const fixture = createRepresentativeExportRegressionFixture();
    const beforeDocument = structuredClone(fixture.document);
    const request = createExportRequestForRegressionFixture(fixture, 'markdown', { type: 'current_file' }, {
      outputPath: 'exports/source-copy.md',
      markdown: {
        mode: 'source_markdown',
        includeFrontmatter: true,
        includeUnmappedBlocks: true,
      },
    });

    const exported = exportMarkdownArtifact({
      request,
      document: fixture.document,
      markdownDocument: fixture.markdownDocument,
      currentMarkdown: fixture.sourceMarkdown,
      currentFileVersion: fixture.fileVersion,
      resolvedLinkTargets: fixture.resolvedLinkTargets,
    });

    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      throw new Error(exported.error.message);
    }
    expect(exported.artifact.markdown).toBe(fixture.sourceMarkdown);
    expect(exported.artifact.writesSourceFile).toBe(false);
    expect(exported.warnings.some((warning) => warning.code === 'markdown_serialization_lossy')).toBe(false);

    const stale = exportMarkdownArtifact({
      request,
      document: fixture.document,
      markdownDocument: fixture.markdownDocument,
      currentMarkdown: fixture.sourceMarkdown,
      currentFileVersion: {
        ...fixture.fileVersion,
        token: 'sha256:changed-on-disk',
      },
    });

    expect(stale.ok).toBe(false);
    expect(stale.ok ? null : stale.error.code).toBe('source_file_stale');
    expect(fixture.document).toEqual(beforeDocument);
    expect(fixture.sourceMarkdown).toContain('Folded branch');
  });

  it('validates SVG, PNG, and PDF artifacts generated from the representative snapshot', async () => {
    const fixture = createRepresentativeExportRegressionFixture();
    const snapshot = representativeSnapshot(fixture);
    const svgRequest = requestWithSnapshot(
      createExportRequestForRegressionFixture(fixture, 'svg'),
      snapshot,
    );
    const firstSvg = renderMindMapSnapshotToSvg(snapshot, svgRequest.options);
    const secondSvg = renderMindMapSnapshotToSvg(snapshot, svgRequest.options);

    expect(firstSvg.ok).toBe(true);
    expect(secondSvg.ok).toBe(true);
    if (!firstSvg.ok || !secondSvg.ok) {
      throw new Error('Expected representative SVG rendering to succeed.');
    }
    expect(firstSvg.artifact.svg).toBe(secondSvg.artifact.svg);
    const parsedSvg = new DOMParser().parseFromString(firstSvg.artifact.svg, 'image/svg+xml');
    expect(parsedSvg.querySelector('parsererror')).toBeNull();
    expect(parsedSvg.documentElement.tagName.toLowerCase()).toBe('svg');

    const tempDir = await makeTempDir();
    const dependencies = createNodeVisualExportDependencies();

    for (const format of ['svg', 'png', 'pdf'] satisfies Exclude<ExportFormat, 'markdown'>[]) {
      const outputPath = join(tempDir, `representative.${format}`);
      const result = await exportMindMapVisual(
        requestWithSnapshot(
          createExportRequestForRegressionFixture(fixture, format, { type: 'current_file' }, {
            outputPath,
            dimensions: {
              mode: 'explicit',
              width: 1200,
              height: 840,
            },
            ...(format === 'png' ? { pixelDensity: 1 } : {}),
            ...(format === 'pdf'
              ? {
                  pdf: {
                    mode: 'custom_page',
                    width: 420,
                    height: 300,
                    margin: 16,
                    unit: 'pt',
                  },
                }
              : {}),
          }),
          snapshot,
        ),
        dependencies,
      );

      expectSuccess(result);
      const artifact = await readFile(outputPath);
      if (format === 'svg') {
        expect(artifact.toString('utf8')).toContain('<svg');
      } else if (format === 'png') {
        expect(artifact.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
        expect(artifact.readUInt32BE(16)).toBe(result.artifact.width);
        expect(artifact.readUInt32BE(20)).toBe(result.artifact.height);
      } else {
        expect(artifact.toString('ascii', 0, 5)).toBe('%PDF-');
        expect(result.artifact.pageCount).toBe(1);
      }
    }
  });

  it('does not mutate source fixture state when a visual write fails', async () => {
    const fixture = createRepresentativeExportRegressionFixture();
    const beforeDocument = structuredClone(fixture.document);
    const beforeMarkdownDocument = structuredClone(fixture.markdownDocument);
    const snapshot = representativeSnapshot(fixture);
    const request = requestWithSnapshot(
      createExportRequestForRegressionFixture(fixture, 'svg', { type: 'current_file' }, {
        outputPath: 'exports/write-fails.svg',
      }),
      snapshot,
    );

    const result = await exportMindMapVisual(request, failingWriterDependencies());

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe('output_not_writable');
    expect(result.ok ? null : result.error.details).toMatchObject({ stage: 'write' });
    expect(fixture.document).toEqual(beforeDocument);
    expect(fixture.markdownDocument).toEqual(beforeMarkdownDocument);
    expect(fixture.sourceMarkdown).toContain('Export Regression Map');
  });
});

function representativeSnapshot(
  fixture: ReturnType<typeof createRepresentativeExportRegressionFixture>,
): MindMapRenderSnapshot {
  const result = resolveExportScope({
    request: createExportRequestForRegressionFixture(fixture, 'svg'),
    document: fixture.document,
    markdownDocument: fixture.markdownDocument,
    currentFileVersion: fixture.fileVersion,
    resolvedLinkTargets: fixture.resolvedLinkTargets,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.scope.renderSnapshot;
}

function requestWithSnapshot(
  request: ExportRequest,
  snapshot: MindMapRenderSnapshot,
): ExportRequest {
  return {
    ...request,
    snapshot,
    scope: snapshot.scope,
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'how-to-think-export-regression-'));
  tempDirs.push(dir);
  return dir;
}

function failingWriterDependencies(): VisualExportServiceDependencies {
  return {
    converter: {
      async svgToPng() {
        throw new Error('PNG conversion should not be called for SVG write failure.');
      },
      async svgToPdf() {
        throw new Error('PDF conversion should not be called for SVG write failure.');
      },
    },
    writer: {
      async prepareOutput(input) {
        return {
          ok: true,
          outputPath: input.outputPath,
          existed: false,
        };
      },
      async writeOutput() {
        return {
          ok: false,
          error: createExportError('output_not_writable', 'Simulated write failure.'),
        };
      },
    },
  };
}

function expectSuccess(result: ExportResult): asserts result is Extract<ExportResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  expect(result.artifact.byteSize).toBeGreaterThan(0);
  expect(result.artifact.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
}
