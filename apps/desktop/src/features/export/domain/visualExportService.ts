import {
  EXPORT_CONTRACT_VERSION,
  createExportError,
  createExportWarning,
  exportMimeTypeForFormat,
  validateExportRequest,
} from './contract';
import {
  DEFAULT_VISUAL_EXPORT_LIMITS,
  projectedPngDimensions,
  renderMindMapSnapshotToSvg,
  validatePngDimensions,
} from './svgRenderer';
import type { RenderedSvgArtifact, VisualExportLimits } from './svgRenderer';
import type {
  ExportError,
  ExportFormat,
  ExportOptions,
  ExportRequest,
  ExportResult,
  ExportWarning,
} from './types';

export type VisualExportFormat = Exclude<ExportFormat, 'markdown'>;

export interface VisualConversionInput {
  svg: string;
  width: number;
  height: number;
  options: ExportOptions;
}

export interface VisualConversionResult {
  data: Uint8Array;
  width?: number;
  height?: number;
  pageCount?: number;
  warnings?: readonly ExportWarning[];
}

export interface VisualExportConverter {
  svgToPng(input: VisualConversionInput & { pixelDensity: number }): Promise<VisualConversionResult>;
  svgToPdf(input: VisualConversionInput): Promise<VisualConversionResult>;
}

export interface VisualExportPrepareInput {
  outputPath: string;
  format: VisualExportFormat;
  overwritePolicy: ExportOptions['overwritePolicy'];
}

export type VisualExportPrepareResult =
  | {
      ok: true;
      outputPath: string;
      existed: boolean;
    }
  | {
      ok: false;
      error: ExportError;
    };

export interface VisualExportWriteInput {
  outputPath: string;
  data: Uint8Array;
  format: VisualExportFormat;
}

export type VisualExportWriteResult =
  | {
      ok: true;
      outputPath: string;
      byteSize: number;
      checksumSha256?: string;
    }
  | {
      ok: false;
      error: ExportError;
    };

export interface VisualExportOutputWriter {
  prepareOutput(input: VisualExportPrepareInput): Promise<VisualExportPrepareResult>;
  writeOutput(input: VisualExportWriteInput): Promise<VisualExportWriteResult>;
}

export interface VisualExportServiceDependencies {
  converter: VisualExportConverter;
  writer: VisualExportOutputWriter;
  createOperationId?: () => string;
  limits?: VisualExportLimits;
}

export interface VisualExportServiceOptions {
  signal?: AbortSignal;
}

const VISUAL_FORMATS: readonly VisualExportFormat[] = ['svg', 'png', 'pdf'];
const EXTENSIONS: Readonly<Record<VisualExportFormat, string>> = {
  svg: '.svg',
  png: '.png',
  pdf: '.pdf',
};

export async function exportMindMapVisual(
  request: ExportRequest,
  dependencies: VisualExportServiceDependencies,
  options: VisualExportServiceOptions = {},
): Promise<ExportResult> {
  const operationId = dependencies.createOperationId?.();
  const baseWarnings = request.snapshot?.warnings ?? [];
  const requestValidation = validateExportRequest(request);
  if (!requestValidation.ok) {
    return failure(request, requestValidation.errors[0], baseWarnings);
  }

  if (!isVisualExportFormat(request.format)) {
    return failure(
      request,
      createExportError('unsupported_export_format', 'Visual export supports svg, png, and pdf formats.', {
        details: { format: request.format },
      }),
      baseWarnings,
    );
  }
  const visualRequest = request as ExportRequest & { format: VisualExportFormat };

  const cancelError = cancellationError(options.signal);
  if (cancelError) {
    return failure(request, cancelError, baseWarnings);
  }

  if (!request.snapshot) {
    return failure(
      request,
      createExportError('invalid_render_snapshot', 'Visual export requires a render snapshot.'),
      baseWarnings,
    );
  }

  const extensionError = validateVisualExportOutputPath(visualRequest.options.outputPath, visualRequest.format);
  if (extensionError) {
    return failure(request, extensionError, baseWarnings);
  }

  const rendered = renderMindMapSnapshotToSvg(
    request.snapshot,
    request.options,
    dependencies.limits ?? DEFAULT_VISUAL_EXPORT_LIMITS,
  );
  if (!rendered.ok) {
    return failure(request, withStage(rendered.error, 'render'), rendered.warnings);
  }

  const prepared = await dependencies.writer.prepareOutput({
    outputPath: visualRequest.options.outputPath,
    format: visualRequest.format,
    overwritePolicy: visualRequest.options.overwritePolicy,
  });
  if (!prepared.ok) {
    return failure(request, withStage(prepared.error, 'write'), rendered.artifact.warnings);
  }

  const overwriteWarnings = prepared.existed
    ? [
        createExportWarning('output_overwrite_requested', 'Existing export artifact will be replaced.', {
          outputPath: prepared.outputPath,
        }),
      ]
    : [];
  const warnings = uniqueWarnings([...rendered.artifact.warnings, ...overwriteWarnings]);

  const converted = await convertVisualArtifact(visualRequest, rendered.artifact, dependencies, options);
  if (!converted.ok) {
    return failure(request, converted.error, warnings);
  }

  const allWarnings = uniqueWarnings([...warnings, ...(converted.result.warnings ?? [])]);
  const written = await dependencies.writer.writeOutput({
    outputPath: prepared.outputPath,
    data: converted.result.data,
    format: visualRequest.format,
  });
  if (!written.ok) {
    return failure(request, withStage(written.error, 'write'), allWarnings);
  }

  return {
    ok: true,
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: visualRequest.format,
    outputPath: written.outputPath,
    artifact: {
      mimeType: exportMimeTypeForFormat(visualRequest.format),
      byteSize: written.byteSize,
      width: converted.result.width,
      height: converted.result.height,
      pageCount: converted.result.pageCount,
      checksumSha256: written.checksumSha256,
      renderedNodeCount: request.snapshot.nodes.length,
      renderedEdgeCount: request.snapshot.edges.length,
      ...(operationId ? { operationId } : {}),
    },
    warnings: allWarnings,
  };
}

export function validateVisualExportOutputPath(
  outputPath: string,
  format: VisualExportFormat,
): ExportError | null {
  if (!outputPath.trim()) {
    return createExportError('missing_output_path', 'Export output path is required.', {
      details: { field: 'options.outputPath' },
    });
  }

  const normalized = outputPath.replace(/\\/g, '/').toLowerCase();
  const expectedExtension = EXTENSIONS[format];
  if (!normalized.endsWith(expectedExtension)) {
    return createExportError(
      'incompatible_export_options',
      `Output path extension must match ${format.toUpperCase()} export.`,
      {
        details: {
          outputPath,
          expectedExtension,
          format,
        },
      },
    );
  }

  return null;
}

export function isVisualExportFormat(format: ExportFormat): format is VisualExportFormat {
  return VISUAL_FORMATS.includes(format as VisualExportFormat);
}

async function convertVisualArtifact(
  request: ExportRequest & { format: VisualExportFormat },
  svg: RenderedSvgArtifact,
  dependencies: VisualExportServiceDependencies,
  options: VisualExportServiceOptions,
): Promise<
  | {
      ok: true;
      result: VisualConversionResult;
    }
  | {
      ok: false;
      error: ExportError;
    }
> {
  const cancelError = cancellationError(options.signal);
  if (cancelError) {
    return { ok: false, error: cancelError };
  }

  if (request.format === 'svg') {
    return {
      ok: true,
      result: {
        data: new TextEncoder().encode(svg.svg),
        width: svg.width,
        height: svg.height,
      },
    };
  }

  try {
    if (request.format === 'png') {
      const pixelDensity = request.options.pixelDensity ?? 1;
      const projected = projectedPngDimensions(svg, pixelDensity);
      const dimensionError = validatePngDimensions(
        projected.width,
        projected.height,
        dependencies.limits ?? DEFAULT_VISUAL_EXPORT_LIMITS,
      );
      if (dimensionError) {
        return { ok: false, error: withStage(dimensionError, 'conversion') };
      }

      return {
        ok: true,
        result: await dependencies.converter.svgToPng({
          svg: svg.svg,
          width: svg.width,
          height: svg.height,
          options: request.options,
          pixelDensity,
        }),
      };
    }

    return {
      ok: true,
      result: await dependencies.converter.svgToPdf({
        svg: svg.svg,
        width: svg.width,
        height: svg.height,
        options: request.options,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: createExportError('conversion_failed', 'Visual export conversion failed.', {
        details: {
          stage: 'conversion',
          format: request.format,
          reason: errorMessage(error),
        },
      }),
    };
  }
}

function failure(
  request: Pick<ExportRequest, 'contractVersion' | 'format' | 'options'>,
  error: ExportError,
  warnings: readonly ExportWarning[],
): ExportResult {
  return {
    ok: false,
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: request.format,
    outputPath: request.options.outputPath,
    warnings,
    error,
  };
}

function cancellationError(signal: AbortSignal | undefined): ExportError | null {
  if (!signal?.aborted) {
    return null;
  }

  return createExportError('export_cancelled', 'Visual export was cancelled.', {
    details: { stage: 'cancelled' },
  });
}

function withStage(error: ExportError, stage: string): ExportError {
  return {
    ...error,
    details: {
      ...(error.details ?? {}),
      stage,
    },
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
