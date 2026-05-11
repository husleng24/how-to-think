import type {
  CollapsedBranchPolicy,
  ExportBounds,
  ExportDimensionOptions,
  ExportError,
  ExportErrorCode,
  ExportFormat,
  ExportOptions,
  ExportRequest,
  ExportScope,
  ExportThemeOptions,
  ExportValidationResult,
  ExportWarning,
  ExportWarningCode,
  MarkdownExportOptions,
  MindMapRenderSnapshot,
  PdfPageOptions,
} from './types';

export const EXPORT_CONTRACT_VERSION = '2026-05-11.v1';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['svg', 'png', 'pdf', 'markdown'];

export const EXPORT_MIME_TYPES: Readonly<Record<ExportFormat, string>> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  pdf: 'application/pdf',
  markdown: 'text/markdown',
};

export const EXPORT_WARNING_CODES: Readonly<Record<string, ExportWarningCode>> = {
  COLLAPSED_CONTENT_PRESERVED: 'collapsed_content_preserved',
  COLLAPSED_CONTENT_EXPANDED: 'collapsed_content_expanded',
  COLLAPSED_CONTENT_OMITTED: 'collapsed_content_omitted',
  FONT_SUBSTITUTION: 'font_substitution',
  LARGE_MAP_SCALED: 'large_map_scaled',
  PDF_FIT_TO_PAGE: 'pdf_fit_to_page',
  MARKDOWN_COMPATIBILITY_WARNING: 'markdown_compatibility_warning',
  UNRESOLVED_LINK: 'unresolved_link',
  OUTPUT_OVERWRITE_REQUESTED: 'output_overwrite_requested',
};

export const EXPORT_ERROR_CODES: Readonly<Record<string, ExportErrorCode>> = {
  UNSUPPORTED_CONTRACT_VERSION: 'unsupported_contract_version',
  UNSUPPORTED_EXPORT_FORMAT: 'unsupported_export_format',
  INVALID_EXPORT_SCOPE: 'invalid_export_scope',
  MISSING_OUTPUT_PATH: 'missing_output_path',
  INVALID_OVERWRITE_POLICY: 'invalid_overwrite_policy',
  INVALID_EXPORT_DIMENSIONS: 'invalid_export_dimensions',
  INCOMPATIBLE_EXPORT_OPTIONS: 'incompatible_export_options',
  INVALID_RENDER_SNAPSHOT: 'invalid_render_snapshot',
  OUTPUT_PATH_CONFLICT: 'output_path_conflict',
  OUTPUT_NOT_WRITABLE: 'output_not_writable',
  SOURCE_FILE_MISSING: 'source_file_missing',
  SOURCE_FILE_STALE: 'source_file_stale',
  MARKDOWN_PARSE_FAILED: 'markdown_parse_failed',
  MARKDOWN_SERIALIZATION_LOSSY: 'markdown_serialization_lossy',
  RENDER_FAILED: 'render_failed',
  CONVERSION_FAILED: 'conversion_failed',
  WRITE_FAILED: 'write_failed',
  CONFIRMATION_REQUIRED: 'confirmation_required',
  INTERNAL_EXPORT_ERROR: 'internal_export_error',
};

const EXPORT_SCOPE_TYPES = ['current_file', 'selected_branch'] as const;
const OVERWRITE_POLICIES = ['fail_if_exists', 'replace_existing'] as const;
const DIMENSION_MODES = ['layout_bounds', 'explicit', 'scale'] as const;
const THEME_SOURCES = ['document', 'application', 'explicit'] as const;
const PDF_PAGE_MODES = ['fit_to_single_page', 'custom_page'] as const;
const PDF_PAGE_UNITS = ['px', 'pt', 'mm'] as const;
const COLLAPSED_BRANCH_POLICIES: readonly CollapsedBranchPolicy[] = [
  'preserve_collapsed',
  'expand_all',
  'visible_only',
];
const MARKDOWN_EXPORT_MODES = ['source_markdown', 'markmap_hierarchy'] as const;

export function createExportWarning(
  code: ExportWarningCode,
  message: string,
  details?: ExportWarning['details'],
): ExportWarning {
  return {
    code,
    message,
    severity: 'warning',
    ...(details ? { details } : {}),
  };
}

export function createExportError(
  code: ExportErrorCode,
  message: string,
  options: {
    recoverable?: boolean;
    details?: ExportError['details'];
  } = {},
): ExportError {
  return {
    code,
    message,
    recoverable: options.recoverable ?? true,
    ...(options.details ? { details: options.details } : {}),
  };
}

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && EXPORT_FORMATS.includes(value as ExportFormat);
}

export function exportMimeTypeForFormat(format: ExportFormat): string {
  return EXPORT_MIME_TYPES[format];
}

export function validateExportRequest(request: unknown): ExportValidationResult {
  const errors: ExportError[] = [];

  if (!isRecord(request)) {
    return invalidResult([
      createExportError('internal_export_error', 'Export request must be an object.', {
        recoverable: false,
      }),
    ]);
  }

  validateContractVersion(request.contractVersion, errors);
  validateFormat(request.format, errors);
  validateScope(request.scope, errors);
  validateOptions(request.format, request.options, errors);
  validateSourceMetadata(request.source, errors);

  return validationResult(errors);
}

export function validateMindMapRenderSnapshot(snapshot: unknown): ExportValidationResult {
  const errors: ExportError[] = [];

  if (!isRecord(snapshot)) {
    return invalidResult([
      createExportError('invalid_render_snapshot', 'Render snapshot must be an object.'),
    ]);
  }

  validateContractVersion(snapshot.contractVersion, errors);
  validateSourceMetadata(snapshot.source, errors);
  validateScope(snapshot.scope, errors);

  if (!isNonEmptyString(snapshot.snapshotId)) {
    errors.push(
      createExportError('invalid_render_snapshot', 'Render snapshot id is required.', {
        details: { field: 'snapshotId' },
      }),
    );
  }

  if (!hasPositiveBounds(snapshot.bounds)) {
    errors.push(
      createExportError(
        'invalid_render_snapshot',
        'Render snapshot bounds must include positive width and height.',
        { details: { field: 'bounds' } },
      ),
    );
  }

  const linkTokenIds = validateLinkTokens(snapshot.linkTokens, errors);
  const sourceNodeIds = validateRenderNodes(snapshot.nodes, linkTokenIds, errors);
  validateRenderEdges(snapshot.edges, sourceNodeIds, errors);
  validateCollapsedMarkers(snapshot.collapsedMarkers, sourceNodeIds, errors);

  if (!isRecord(snapshot.theme) || !includesValue(THEME_SOURCES, snapshot.theme.source)) {
    errors.push(
      createExportError('invalid_render_snapshot', 'Render snapshot theme source is invalid.', {
        details: { field: 'theme.source' },
      }),
    );
  }

  if (!Array.isArray(snapshot.warnings)) {
    errors.push(
      createExportError('invalid_render_snapshot', 'Render snapshot warnings must be an array.', {
        details: { field: 'warnings' },
      }),
    );
  }

  return validationResult(errors);
}

export function assertValidExportRequest<T extends ExportRequest>(request: T): T {
  const result = validateExportRequest(request);

  if (!result.ok) {
    throw new ExportContractValidationError('Export request validation failed.', result.errors);
  }

  return request;
}

export function assertValidMindMapRenderSnapshot<T extends MindMapRenderSnapshot>(
  snapshot: T,
): T {
  const result = validateMindMapRenderSnapshot(snapshot);

  if (!result.ok) {
    throw new ExportContractValidationError('Render snapshot validation failed.', result.errors);
  }

  return snapshot;
}

export class ExportContractValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: readonly ExportError[],
  ) {
    super(message);
    this.name = 'ExportContractValidationError';
  }
}

function validateContractVersion(value: unknown, errors: ExportError[]): void {
  if (value !== EXPORT_CONTRACT_VERSION) {
    errors.push(
      createExportError('unsupported_contract_version', 'Unsupported export contract version.', {
        details: {
          expected: EXPORT_CONTRACT_VERSION,
          actual: printable(value),
        },
      }),
    );
  }
}

function validateFormat(value: unknown, errors: ExportError[]): void {
  if (!isExportFormat(value)) {
    errors.push(
      createExportError('unsupported_export_format', 'Export format is not supported.', {
        details: { format: printable(value) },
      }),
    );
  }
}

function validateScope(value: unknown, errors: ExportError[]): void {
  if (!isRecord(value) || !includesValue(EXPORT_SCOPE_TYPES, value.type)) {
    errors.push(
      createExportError(
        'invalid_export_scope',
        'Export scope must be current_file or selected_branch.',
        { details: { scopeType: printable(isRecord(value) ? value.type : value) } },
      ),
    );
    return;
  }

  const scope = value as Partial<ExportScope>;
  if (scope.type === 'selected_branch' && !isNonEmptyString(scope.rootNodeId)) {
    errors.push(
      createExportError(
        'invalid_export_scope',
        'Selected branch export requires a root node id.',
        { details: { field: 'scope.rootNodeId' } },
      ),
    );
  }
}

function validateOptions(
  format: unknown,
  value: unknown,
  errors: ExportError[],
): void {
  if (!isRecord(value)) {
    errors.push(
      createExportError('incompatible_export_options', 'Export options must be an object.', {
        details: { field: 'options' },
      }),
    );
    return;
  }

  const options = value as Partial<ExportOptions>;

  if (!isNonEmptyString(options.outputPath)) {
    errors.push(
      createExportError('missing_output_path', 'Export output path is required.', {
        details: { field: 'options.outputPath' },
      }),
    );
  }

  if (!includesValue(OVERWRITE_POLICIES, options.overwritePolicy)) {
    errors.push(
      createExportError('invalid_overwrite_policy', 'Export overwrite policy is invalid.', {
        details: {
          field: 'options.overwritePolicy',
          value: printable(options.overwritePolicy),
        },
      }),
    );
  }

  if (options.dimensions !== undefined) {
    validateDimensions(format, options.dimensions, errors);
  }

  if (options.pixelDensity !== undefined) {
    if (!isPositiveNumber(options.pixelDensity)) {
      errors.push(
        createExportError('invalid_export_dimensions', 'Pixel density must be positive.', {
          details: { field: 'options.pixelDensity' },
        }),
      );
    }

    if (format !== 'png') {
      errors.push(
        createExportError(
          'incompatible_export_options',
          'Pixel density is only valid for PNG export.',
          { details: { format: printable(format), field: 'options.pixelDensity' } },
        ),
      );
    }
  }

  validateTheme(options.theme, errors);

  if (!includesValue(COLLAPSED_BRANCH_POLICIES, options.collapsedBranchPolicy)) {
    errors.push(
      createExportError(
        'incompatible_export_options',
        'Collapsed branch policy is invalid.',
        {
          details: {
            field: 'options.collapsedBranchPolicy',
            value: printable(options.collapsedBranchPolicy),
          },
        },
      ),
    );
  }

  if (options.pdf !== undefined) {
    if (format !== 'pdf') {
      errors.push(
        createExportError(
          'incompatible_export_options',
          'PDF page options are only valid for PDF export.',
          { details: { format: printable(format), field: 'options.pdf' } },
        ),
      );
    }
    validatePdfOptions(options.pdf, errors);
  }

  if (options.markdown !== undefined) {
    if (format !== 'markdown') {
      errors.push(
        createExportError(
          'incompatible_export_options',
          'Markdown output options are only valid for Markdown export.',
          { details: { format: printable(format), field: 'options.markdown' } },
        ),
      );
    }
    validateMarkdownOptions(options.markdown, errors);
  }
}

function validateDimensions(
  format: unknown,
  value: ExportDimensionOptions,
  errors: ExportError[],
): void {
  if (!isRecord(value) || !includesValue(DIMENSION_MODES, value.mode)) {
    errors.push(
      createExportError('invalid_export_dimensions', 'Dimension mode is invalid.', {
        details: { field: 'options.dimensions.mode' },
      }),
    );
    return;
  }

  if (format === 'markdown') {
    errors.push(
      createExportError(
        'incompatible_export_options',
        'Visual dimension options are not valid for Markdown export.',
        { details: { field: 'options.dimensions' } },
      ),
    );
  }

  if (value.mode === 'explicit') {
    if (!isPositiveNumber(value.width) || !isPositiveNumber(value.height)) {
      errors.push(
        createExportError(
          'invalid_export_dimensions',
          'Explicit export dimensions require positive width and height.',
          {
            details: {
              width: printable(value.width),
              height: printable(value.height),
            },
          },
        ),
      );
    }
    return;
  }

  if (value.mode === 'scale') {
    if (!isPositiveNumber(value.scale)) {
      errors.push(
        createExportError('invalid_export_dimensions', 'Export scale must be positive.', {
          details: { scale: printable(value.scale) },
        }),
      );
    }
    return;
  }

  if (value.maxWidth !== undefined && !isPositiveNumber(value.maxWidth)) {
    errors.push(
      createExportError('invalid_export_dimensions', 'Maximum export width must be positive.', {
        details: { field: 'options.dimensions.maxWidth' },
      }),
    );
  }

  if (value.maxHeight !== undefined && !isPositiveNumber(value.maxHeight)) {
    errors.push(
      createExportError('invalid_export_dimensions', 'Maximum export height must be positive.', {
        details: { field: 'options.dimensions.maxHeight' },
      }),
    );
  }
}

function validateTheme(value: ExportThemeOptions | undefined, errors: ExportError[]): void {
  if (!isRecord(value) || !includesValue(THEME_SOURCES, value.source)) {
    errors.push(
      createExportError('incompatible_export_options', 'Theme source is invalid.', {
        details: { field: 'options.theme.source' },
      }),
    );
  }
}

function validatePdfOptions(value: PdfPageOptions, errors: ExportError[]): void {
  if (!isRecord(value) || !includesValue(PDF_PAGE_MODES, value.mode)) {
    errors.push(
      createExportError('incompatible_export_options', 'PDF page mode is invalid.', {
        details: { field: 'options.pdf.mode' },
      }),
    );
    return;
  }

  if (value.unit !== undefined && !includesValue(PDF_PAGE_UNITS, value.unit)) {
    errors.push(
      createExportError('incompatible_export_options', 'PDF page unit is invalid.', {
        details: { field: 'options.pdf.unit' },
      }),
    );
  }

  if (value.mode === 'custom_page') {
    if (!isPositiveNumber(value.width) || !isPositiveNumber(value.height)) {
      errors.push(
        createExportError(
          'invalid_export_dimensions',
          'Custom PDF page size requires positive width and height.',
          {
            details: {
              width: printable(value.width),
              height: printable(value.height),
            },
          },
        ),
      );
    }
  }

  if (value.margin !== undefined && (!Number.isFinite(value.margin) || value.margin < 0)) {
    errors.push(
      createExportError('invalid_export_dimensions', 'PDF margin cannot be negative.', {
        details: { field: 'options.pdf.margin' },
      }),
    );
  }
}

function validateMarkdownOptions(value: MarkdownExportOptions, errors: ExportError[]): void {
  if (!isRecord(value) || !includesValue(MARKDOWN_EXPORT_MODES, value.mode)) {
    errors.push(
      createExportError('incompatible_export_options', 'Markdown export mode is invalid.', {
        details: { field: 'options.markdown.mode' },
      }),
    );
  }
}

function validateSourceMetadata(value: unknown, errors: ExportError[]): void {
  if (!isRecord(value)) {
    errors.push(
      createExportError('incompatible_export_options', 'Export source metadata is required.', {
        details: { field: 'source' },
      }),
    );
    return;
  }

  if (!isNonEmptyString(value.documentId)) {
    errors.push(
      createExportError('incompatible_export_options', 'Export source document id is required.', {
        details: { field: 'source.documentId' },
      }),
    );
  }

  if (!isNonEmptyString(value.generatedAt)) {
    errors.push(
      createExportError('incompatible_export_options', 'Export source generated timestamp is required.', {
        details: { field: 'source.generatedAt' },
      }),
    );
  }
}

function validateLinkTokens(value: unknown, errors: ExportError[]): Set<string> {
  const linkTokenIds = new Set<string>();

  if (!Array.isArray(value)) {
    errors.push(
      createExportError('invalid_render_snapshot', 'Render snapshot link tokens must be an array.', {
        details: { field: 'linkTokens' },
      }),
    );
    return linkTokenIds;
  }

  for (const token of value) {
    if (!isRecord(token) || !isNonEmptyString(token.id)) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Every link token must have an id.', {
          details: { field: 'linkTokens.id' },
        }),
      );
      continue;
    }

    if (linkTokenIds.has(token.id)) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Link token ids must be unique.', {
          details: { linkTokenId: token.id },
        }),
      );
    }
    linkTokenIds.add(token.id);
  }

  return linkTokenIds;
}

function validateRenderNodes(
  value: unknown,
  linkTokenIds: Set<string>,
  errors: ExportError[],
): Set<string> {
  const nodeIds = new Set<string>();
  const sourceNodeIds = new Set<string>();

  if (!Array.isArray(value) || value.length === 0) {
    errors.push(
      createExportError('invalid_render_snapshot', 'Render snapshot must include nodes.', {
        details: { field: 'nodes' },
      }),
    );
    return nodeIds;
  }

  for (const node of value) {
    if (!isRecord(node) || !isNonEmptyString(node.id)) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Every render node must have an id.', {
          details: { field: 'nodes.id' },
        }),
      );
      continue;
    }

    if (nodeIds.has(node.id)) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Render node ids must be unique.', {
          details: { nodeId: node.id },
        }),
      );
    }
    nodeIds.add(node.id);

    if (!isNonEmptyString(node.sourceNodeId)) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Render node source id is required.', {
          details: { nodeId: node.id, field: 'sourceNodeId' },
        }),
      );
    } else if (sourceNodeIds.has(node.sourceNodeId)) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Render node source ids must be unique.', {
          details: { sourceNodeId: node.sourceNodeId },
        }),
      );
    } else {
      sourceNodeIds.add(node.sourceNodeId);
    }

    if (!hasFiniteBounds(node.bounds)) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Render node bounds must be finite.', {
          details: { nodeId: node.id, field: 'bounds' },
        }),
      );
    }

    if (!Array.isArray(node.textRuns)) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Render node text runs must be an array.', {
          details: { nodeId: node.id, field: 'textRuns' },
        }),
      );
    }

    const nodeLinkTokenIds = Array.isArray(node.linkTokenIds) ? node.linkTokenIds : [];
    for (const linkTokenId of nodeLinkTokenIds) {
      if (!linkTokenIds.has(linkTokenId)) {
        errors.push(
          createExportError(
            'invalid_render_snapshot',
            'Render node references an unknown link token.',
            {
              details: {
                nodeId: node.id,
                linkTokenId: printable(linkTokenId),
              },
            },
          ),
        );
      }
    }
  }

  return sourceNodeIds;
}

function validateRenderEdges(
  value: unknown,
  nodeIds: Set<string>,
  errors: ExportError[],
): void {
  if (!Array.isArray(value)) {
    errors.push(
      createExportError('invalid_render_snapshot', 'Render snapshot edges must be an array.', {
        details: { field: 'edges' },
      }),
    );
    return;
  }

  for (const edge of value) {
    if (
      !isRecord(edge) ||
      !isNonEmptyString(edge.id) ||
      !nodeIds.has(String(edge.sourceNodeId)) ||
      !nodeIds.has(String(edge.targetNodeId))
    ) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Render edge endpoints must exist.', {
          details: { edgeId: printable(isRecord(edge) ? edge.id : undefined) },
        }),
      );
    }
  }
}

function validateCollapsedMarkers(
  value: unknown,
  nodeIds: Set<string>,
  errors: ExportError[],
): void {
  if (!Array.isArray(value)) {
    errors.push(
      createExportError(
        'invalid_render_snapshot',
        'Render snapshot collapsed markers must be an array.',
        { details: { field: 'collapsedMarkers' } },
      ),
    );
    return;
  }

  for (const marker of value) {
    const hiddenNodeCount = isRecord(marker) ? marker.hiddenNodeCount : undefined;
    if (
      !isRecord(marker) ||
      !nodeIds.has(String(marker.nodeId)) ||
      typeof hiddenNodeCount !== 'number' ||
      !Number.isInteger(hiddenNodeCount) ||
      hiddenNodeCount <= 0
    ) {
      errors.push(
        createExportError('invalid_render_snapshot', 'Collapsed markers must reference hidden nodes.', {
          details: { nodeId: printable(isRecord(marker) ? marker.nodeId : undefined) },
        }),
      );
    }
  }
}

function hasPositiveBounds(value: unknown): value is ExportBounds {
  return (
    isRecord(value) &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    isPositiveNumber(value.width) &&
    isPositiveNumber(value.height)
  );
}

function hasFiniteBounds(value: unknown): value is ExportBounds {
  return (
    isRecord(value) &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height)
  );
}

function validationResult(errors: ExportError[]): ExportValidationResult {
  return errors.length === 0 ? { ok: true, errors: [] } : invalidResult(errors);
}

function invalidResult(errors: readonly ExportError[]): ExportValidationResult {
  return { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function includesValue<T extends readonly unknown[]>(
  values: T,
  candidate: unknown,
): candidate is T[number] {
  return values.includes(candidate);
}

function printable(value: unknown): string | number | boolean | null {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }

  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
}
