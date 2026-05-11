import {
  EXPORT_CONTRACT_VERSION,
  createExportError,
  createExportWarning,
  exportMimeTypeForFormat,
  validateExportRequest,
} from '../domain/contract';
import {
  DEFAULT_VISUAL_EXPORT_LIMITS,
  projectedPngDimensions,
  renderMindMapSnapshotToSvg,
  validatePngDimensions,
} from '../domain/svgRenderer';
import type {
  ExportOptions,
  ExportRequest,
  ExportResult,
  ExportWarning,
  PdfPageOptions,
} from '../domain/types';
import type { DesktopExportCommandPayload } from './exportCommands';

export interface DesktopExportArtifact {
  data: number[];
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  pageCount?: number;
  renderedNodeCount?: number;
  renderedEdgeCount?: number;
  warnings?: readonly ExportWarning[];
}

export type CreateDesktopExportArtifactResult =
  | {
      ok: true;
      artifact: DesktopExportArtifact;
    }
  | {
      ok: false;
      result: ExportResult;
    };

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

export async function createDesktopExportArtifact(
  payload: DesktopExportCommandPayload,
): Promise<CreateDesktopExportArtifactResult> {
  const requestValidation = validateExportRequest(payload.request);
  if (!requestValidation.ok) {
    return {
      ok: false,
      result: failure(payload.request, requestValidation.errors[0], payload.warnings ?? []),
    };
  }

  if (payload.request.format === 'markdown') {
    return createMarkdownArtifact(payload);
  }

  if (!payload.request.snapshot) {
    return {
      ok: false,
      result: failure(
        payload.request,
        createExportError('invalid_render_snapshot', 'Visual export requires a render snapshot.'),
        payload.warnings ?? [],
      ),
    };
  }

  const rendered = renderMindMapSnapshotToSvg(
    payload.request.snapshot,
    payload.request.options,
    DEFAULT_VISUAL_EXPORT_LIMITS,
  );
  if (!rendered.ok) {
    return {
      ok: false,
      result: failure(payload.request, rendered.error, rendered.warnings),
    };
  }

  const warnings = uniqueWarnings([...(payload.warnings ?? []), ...rendered.artifact.warnings]);

  if (payload.request.format === 'svg') {
    const data = new TextEncoder().encode(rendered.artifact.svg);

    return {
      ok: true,
      artifact: {
        data: bytesForInvoke(data),
        mimeType: exportMimeTypeForFormat('svg'),
        byteSize: data.byteLength,
        width: rendered.artifact.width,
        height: rendered.artifact.height,
        renderedNodeCount: payload.request.snapshot.nodes.length,
        renderedEdgeCount: payload.request.snapshot.edges.length,
        warnings,
      },
    };
  }

  if (payload.request.format === 'png') {
    return createPngArtifact(payload.request, rendered.artifact.svg, rendered.artifact.width, rendered.artifact.height, warnings);
  }

  return createPdfArtifact(payload.request, rendered.artifact.svg, rendered.artifact.width, rendered.artifact.height, warnings);
}

function createMarkdownArtifact(
  payload: DesktopExportCommandPayload,
): CreateDesktopExportArtifactResult {
  if (!payload.markdownArtifact) {
    return {
      ok: false,
      result: failure(
        payload.request,
        createExportError('internal_export_error', 'Markdown export artifact was not prepared.'),
        payload.warnings ?? [],
      ),
    };
  }

  const data = new TextEncoder().encode(payload.markdownArtifact.markdown);

  return {
    ok: true,
    artifact: {
      data: bytesForInvoke(data),
      mimeType: exportMimeTypeForFormat('markdown'),
      byteSize: data.byteLength,
      warnings: uniqueWarnings(payload.warnings ?? []),
    },
  };
}

async function createPngArtifact(
  request: ExportRequest,
  svg: string,
  width: number,
  height: number,
  warnings: readonly ExportWarning[],
): Promise<CreateDesktopExportArtifactResult> {
  const pixelDensity = request.options.pixelDensity ?? 1;
  const projected = projectedPngDimensions({ width, height }, pixelDensity);
  const dimensionError = validatePngDimensions(projected.width, projected.height, DEFAULT_VISUAL_EXPORT_LIMITS);
  if (dimensionError) {
    return {
      ok: false,
      result: failure(request, dimensionError, warnings),
    };
  }

  const converted = await rasterizeSvg(svg, width, height, {
    scale: pixelDensity,
    mimeType: 'image/png',
  });
  if (!converted.ok) {
    return {
      ok: false,
      result: failure(request, converted.error, warnings),
    };
  }

  return {
    ok: true,
    artifact: {
      data: bytesForInvoke(converted.data),
      mimeType: exportMimeTypeForFormat('png'),
      byteSize: converted.data.byteLength,
      width: projected.width,
      height: projected.height,
      renderedNodeCount: request.snapshot?.nodes.length,
      renderedEdgeCount: request.snapshot?.edges.length,
      warnings,
    },
  };
}

async function createPdfArtifact(
  request: ExportRequest,
  svg: string,
  width: number,
  height: number,
  warnings: readonly ExportWarning[],
): Promise<CreateDesktopExportArtifactResult> {
  const plan = createPdfPagePlan(width, height, request.options);
  const converted = await rasterizeSvg(svg, width, height, {
    scale: 1,
    mimeType: 'image/jpeg',
    quality: 0.92,
    fill: '#ffffff',
  });
  if (!converted.ok) {
    return {
      ok: false,
      result: failure(request, converted.error, warnings),
    };
  }

  const pdf = createSingleImagePdf(converted.data, Math.ceil(width), Math.ceil(height), plan);
  const pdfWarnings = uniqueWarnings([...warnings, ...plan.warnings]);

  return {
    ok: true,
    artifact: {
      data: bytesForInvoke(pdf),
      mimeType: exportMimeTypeForFormat('pdf'),
      byteSize: pdf.byteLength,
      width: Math.ceil(plan.pageWidth),
      height: Math.ceil(plan.pageHeight),
      pageCount: 1,
      renderedNodeCount: request.snapshot?.nodes.length,
      renderedEdgeCount: request.snapshot?.edges.length,
      warnings: pdfWarnings,
    },
  };
}

async function rasterizeSvg(
  svg: string,
  width: number,
  height: number,
  options: {
    scale: number;
    mimeType: 'image/png' | 'image/jpeg';
    quality?: number;
    fill?: string;
  },
): Promise<
  | {
      ok: true;
      data: Uint8Array;
    }
  | {
      ok: false;
      error: ReturnType<typeof createExportError>;
    }
> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return {
      ok: false,
      error: createExportError('conversion_failed', 'Browser raster export is unavailable in this environment.'),
    };
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * options.scale));
  canvas.height = Math.max(1, Math.ceil(height * options.scale));
  const context = canvas.getContext('2d');
  if (!context) {
    return {
      ok: false,
      error: createExportError('conversion_failed', 'Browser canvas export is unavailable.'),
    };
  }

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = await loadImage(url);
    if (options.fill) {
      context.fillStyle = options.fill;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await canvasToBlob(canvas, options.mimeType, options.quality);
    return {
      ok: true,
      data: new Uint8Array(await blob.arrayBuffer()),
    };
  } catch (error) {
    return {
      ok: false,
      error: createExportError('conversion_failed', 'Browser visual export conversion failed.', {
        details: {
          reason: error instanceof Error ? error.message : String(error),
          mimeType: options.mimeType,
        },
      }),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('SVG image could not be loaded for export conversion.'));
    image.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas export did not produce a Blob.'));
        return;
      }

      resolve(blob);
    }, type, quality);
  });
}

function createPdfPagePlan(
  width: number,
  height: number,
  options: ExportOptions,
): PdfPagePlan {
  const pdfOptions = options.pdf ?? { mode: 'fit_to_single_page' as const };
  const unit = pdfOptions.unit ?? 'pt';
  const margin = pdfOptions.margin ?? DEFAULT_PDF_MARGIN;
  const naturalPage =
    pdfOptions.mode === 'custom_page'
      ? {
          width: convertToPoints(pdfOptions.width ?? width, unit),
          height: convertToPoints(pdfOptions.height ?? height, unit),
        }
      : fitPageFor(width, height, pdfOptions);
  const contentWidth = Math.max(1, naturalPage.width - margin * 2);
  const contentHeight = Math.max(1, naturalPage.height - margin * 2);
  const scale = Math.min(contentWidth / width, contentHeight / height, 1);
  const renderWidth = width * scale;
  const renderHeight = height * scale;
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

function createSingleImagePdf(
  jpegBytes: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  plan: PdfPagePlan,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let offset = 0;

  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    offset += chunk.byteLength;
  };
  const pushText = (text: string) => push(encoder.encode(text));
  const beginObject = (id: number) => {
    offsets[id] = offset;
    pushText(`${id} 0 obj\n`);
  };

  pushText('%PDF-1.4\n');

  beginObject(1);
  pushText('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  pushText('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  beginObject(3);
  pushText(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNumber(plan.pageWidth)} ${pdfNumber(plan.pageHeight)}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);

  beginObject(4);
  pushText(`<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`);
  push(jpegBytes);
  pushText('\nendstream\nendobj\n');

  const imageY = plan.pageHeight - plan.y - plan.renderHeight;
  const content = `q\n${pdfNumber(plan.renderWidth)} 0 0 ${pdfNumber(plan.renderHeight)} ${pdfNumber(plan.x)} ${pdfNumber(imageY)} cm\n/Im1 Do\nQ\n`;
  beginObject(5);
  pushText(`<< /Length ${new TextEncoder().encode(content).byteLength} >>\nstream\n${content}endstream\nendobj\n`);

  const xrefOffset = offset;
  pushText('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id += 1) {
    pushText(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return concatBytes(chunks, offset);
}

function concatBytes(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let cursor = 0;
  for (const chunk of chunks) {
    result.set(chunk, cursor);
    cursor += chunk.byteLength;
  }

  return result;
}

function pdfNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');
}

function bytesForInvoke(data: Uint8Array): number[] {
  return Array.from(data);
}

function failure(
  request: Pick<ExportRequest, 'contractVersion' | 'format' | 'options'>,
  error: ReturnType<typeof createExportError>,
  warnings: readonly ExportWarning[] = [],
): ExportResult {
  return {
    ok: false,
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: request.format,
    outputPath: request.options.outputPath,
    warnings: uniqueWarnings(warnings),
    error,
  };
}

function uniqueWarnings(warnings: readonly ExportWarning[]): readonly ExportWarning[] {
  const seen = new Set<string>();
  const result: ExportWarning[] = [];

  for (const warning of warnings) {
    const key = `${warning.code}:${warning.message}:${JSON.stringify(warning.details ?? {})}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(warning);
    }
  }

  return result;
}
