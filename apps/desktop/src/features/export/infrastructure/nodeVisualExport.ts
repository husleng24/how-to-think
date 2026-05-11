import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';

import { Resvg } from '@resvg/resvg-js';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';

import { createExportError, createExportWarning } from '../domain/contract';
import type { ExportWarning, PdfPageOptions } from '../domain/types';
import type {
  VisualConversionInput,
  VisualConversionResult,
  VisualExportConverter,
  VisualExportOutputWriter,
  VisualExportPrepareInput,
  VisualExportPrepareResult,
  VisualExportServiceDependencies,
  VisualExportWriteInput,
  VisualExportWriteResult,
} from '../domain/visualExportService';

interface PdfPagePlan {
  pageWidth: number;
  pageHeight: number;
  x: number;
  y: number;
  renderWidth: number;
  renderHeight: number;
  warnings: readonly ExportWarning[];
}

const DEFAULT_MAX_FIT_PAGE_SIZE = 2400;
const DEFAULT_PDF_MARGIN = 0;

export function createNodeVisualExportDependencies(): VisualExportServiceDependencies {
  return {
    converter: nodeVisualExportConverter,
    writer: nodeVisualExportWriter,
    createOperationId: () => randomUUID(),
  };
}

export const nodeVisualExportConverter: VisualExportConverter = {
  async svgToPng(input): Promise<VisualConversionResult> {
    const resvg = new Resvg(input.svg, {
      fitTo:
        input.pixelDensity === 1
          ? undefined
          : {
              mode: 'zoom',
              value: input.pixelDensity,
            },
      font: {
        loadSystemFonts: true,
      },
    });
    const rendered = resvg.render();

    return {
      data: rendered.asPng(),
      width: Math.ceil(input.width * input.pixelDensity),
      height: Math.ceil(input.height * input.pixelDensity),
    };
  },

  async svgToPdf(input): Promise<VisualConversionResult> {
    const plan = createPdfPagePlan(input);
    const document = new PDFDocument({
      size: [plan.pageWidth, plan.pageHeight],
      margin: 0,
      compress: true,
    });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.on('error', reject);
    });

    SVGtoPDF(document, input.svg, plan.x, plan.y, {
      width: plan.renderWidth,
      height: plan.renderHeight,
      assumePt: true,
    });
    document.end();

    return {
      data: await done,
      width: Math.ceil(plan.pageWidth),
      height: Math.ceil(plan.pageHeight),
      pageCount: 1,
      warnings: plan.warnings,
    };
  },
};

export const nodeVisualExportWriter: VisualExportOutputWriter = {
  async prepareOutput(input: VisualExportPrepareInput): Promise<VisualExportPrepareResult> {
    const outputPath = path.resolve(input.outputPath);
    const parent = path.dirname(outputPath);
    const parentStatus = await statPath(parent);

    if (!parentStatus.exists) {
      return {
        ok: false,
        error: createExportError('output_not_writable', 'Export output parent directory does not exist.', {
          details: { outputPath, parentDirectory: parent },
        }),
      };
    }

    if (!parentStatus.isDirectory) {
      return {
        ok: false,
        error: createExportError('output_not_writable', 'Export output parent path is not a directory.', {
          details: { outputPath, parentDirectory: parent },
        }),
      };
    }

    try {
      await fs.access(parent, constants.W_OK);
    } catch (error) {
      return {
        ok: false,
        error: createExportError('output_not_writable', 'Export output parent directory is not writable.', {
          details: { outputPath, parentDirectory: parent, reason: errorMessage(error) },
        }),
      };
    }

    const targetStatus = await statPath(outputPath);
    if (targetStatus.exists && targetStatus.isDirectory) {
      return {
        ok: false,
        error: createExportError('output_path_conflict', 'Export output path is a directory.', {
          details: { outputPath },
        }),
      };
    }

    if (targetStatus.exists && input.overwritePolicy === 'fail_if_exists') {
      return {
        ok: false,
        error: createExportError('output_path_conflict', 'Export output path already exists.', {
          details: { outputPath, overwritePolicy: input.overwritePolicy },
        }),
      };
    }

    return {
      ok: true,
      outputPath,
      existed: targetStatus.exists,
    };
  },

  async writeOutput(input: VisualExportWriteInput): Promise<VisualExportWriteResult> {
    const outputPath = path.resolve(input.outputPath);
    const tempPath = temporaryPathFor(outputPath);

    try {
      await fs.writeFile(tempPath, input.data, { flag: 'wx' });
      await fs.rename(tempPath, outputPath);
      const stats = await fs.stat(outputPath);

      return {
        ok: true,
        outputPath,
        byteSize: stats.size,
        checksumSha256: createHash('sha256').update(input.data).digest('hex'),
      };
    } catch (error) {
      await cleanupTempFile(tempPath);

      return {
        ok: false,
        error: createExportError(permissionDenied(error) ? 'output_not_writable' : 'write_failed', 'Export output write failed.', {
          details: {
            outputPath,
            tempPath,
            format: input.format,
            reason: errorMessage(error),
          },
        }),
      };
    }
  },
};

function createPdfPagePlan(input: VisualConversionInput): PdfPagePlan {
  const pdfOptions = input.options.pdf ?? { mode: 'fit_to_single_page' as const };
  const unit = pdfOptions.unit ?? 'pt';
  const margin = pdfOptions.margin ?? DEFAULT_PDF_MARGIN;
  const naturalPage =
    pdfOptions.mode === 'custom_page'
      ? {
          width: convertToPoints(pdfOptions.width ?? input.width, unit),
          height: convertToPoints(pdfOptions.height ?? input.height, unit),
        }
      : fitPageFor(input.width, input.height, pdfOptions);
  const contentWidth = Math.max(1, naturalPage.width - margin * 2);
  const contentHeight = Math.max(1, naturalPage.height - margin * 2);
  const scale = Math.min(contentWidth / input.width, contentHeight / input.height, 1);
  const renderWidth = input.width * scale;
  const renderHeight = input.height * scale;
  const warnings: ExportWarning[] = [];

  if (scale < 0.98) {
    warnings.push(
      createExportWarning('pdf_fit_to_page', 'Map was scaled to fit the PDF page.', {
        scale: Number(scale.toFixed(4)),
        pageWidth: Math.ceil(naturalPage.width),
        pageHeight: Math.ceil(naturalPage.height),
      }),
    );
  }

  if (scale < 0.75) {
    warnings.push(
      createExportWarning('large_map_scaled', 'Large map was substantially scaled down for PDF export.', {
        scale: Number(scale.toFixed(4)),
      }),
    );
  }

  return {
    pageWidth: naturalPage.width,
    pageHeight: naturalPage.height,
    x: margin + (contentWidth - renderWidth) / 2,
    y: margin + (contentHeight - renderHeight) / 2,
    renderWidth,
    renderHeight,
    warnings,
  };
}

function fitPageFor(
  width: number,
  height: number,
  pdfOptions: PdfPageOptions,
): { width: number; height: number } {
  const unit = pdfOptions.unit ?? 'pt';
  if (pdfOptions.width && pdfOptions.height) {
    return {
      width: convertToPoints(pdfOptions.width, unit),
      height: convertToPoints(pdfOptions.height, unit),
    };
  }

  if (width <= DEFAULT_MAX_FIT_PAGE_SIZE && height <= DEFAULT_MAX_FIT_PAGE_SIZE) {
    return { width, height };
  }

  const scale = Math.min(DEFAULT_MAX_FIT_PAGE_SIZE / width, DEFAULT_MAX_FIT_PAGE_SIZE / height);
  return {
    width: width * scale,
    height: height * scale,
  };
}

function convertToPoints(value: number, unit: NonNullable<PdfPageOptions['unit']>): number {
  if (unit === 'mm') {
    return value * 2.8346456693;
  }

  if (unit === 'px') {
    return value * 0.75;
  }

  return value;
}

async function statPath(
  targetPath: string,
): Promise<{ exists: true; isDirectory: boolean } | { exists: false; isDirectory: false }> {
  try {
    const stats = await fs.stat(targetPath);
    return {
      exists: true,
      isDirectory: stats.isDirectory(),
    };
  } catch (error) {
    if (notFound(error)) {
      return {
        exists: false,
        isDirectory: false,
      };
    }

    throw error;
  }
}

function temporaryPathFor(outputPath: string): string {
  return path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomBytes(8).toString('hex')}.tmp`);
}

async function cleanupTempFile(tempPath: string): Promise<void> {
  try {
    await fs.unlink(tempPath);
  } catch (error) {
    if (!notFound(error)) {
      throw error;
    }
  }
}

function notFound(error: unknown): boolean {
  return errorHasCode(error, 'ENOENT');
}

function permissionDenied(error: unknown): boolean {
  return errorHasCode(error, 'EACCES') || errorHasCode(error, 'EPERM');
}

function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
