import type {
  CollapsedBranchPolicy,
  ExportFormat,
  ExportOptions,
  ExportOverwritePolicy,
  ExportResult,
  ExportScope,
  MarkdownExportMode,
  PdfPageMode,
} from '../domain/types';

export type ExportDialogPhase =
  | 'ready'
  | 'validating'
  | 'rendering'
  | 'writing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'warning-present';

export type ExportDimensionMode = 'layout_bounds' | 'scale' | 'explicit';

export type ExportCommandEntryKind =
  | 'ready'
  | 'blocked'
  | 'validating'
  | 'rendering'
  | 'writing'
  | 'succeeded'
  | 'warning'
  | 'failed'
  | 'cancelled';

export type ExportCommandEntryTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'muted';

export interface ExportCommandEntryState {
  kind: ExportCommandEntryKind;
  label: string;
  detail: string;
  actionLabel: string;
  disabled: boolean;
  tone: ExportCommandEntryTone;
}

export interface ExportDialogContext {
  documentTitle: string;
  documentPath: string | null;
  selectedNodeId: string | null;
  selectedNodeTitle: string | null;
  hasUnsavedChanges: boolean;
}

export interface ExportDialogState {
  format: ExportFormat;
  scopeType: ExportScope['type'];
  outputPath: string;
  overwritePolicy: ExportOverwritePolicy;
  collapsedBranchPolicy: CollapsedBranchPolicy;
  dimensionMode: ExportDimensionMode;
  width: number;
  height: number;
  scale: number;
  pixelDensity: number;
  pdfPageMode: PdfPageMode;
  pdfWidth: number;
  pdfHeight: number;
  pdfMargin: number;
  markdownMode: MarkdownExportMode;
  includeFrontmatter: boolean;
  includeUnmappedBlocks: boolean;
  phase: ExportDialogPhase;
  result: ExportResult | null;
}

export type ExportDialogAction =
  | { type: 'reset'; context: ExportDialogContext; format?: ExportFormat }
  | { type: 'set-format'; format: ExportFormat; context: ExportDialogContext }
  | { type: 'set-scope'; scopeType: ExportScope['type']; context: ExportDialogContext }
  | { type: 'set-output-path'; outputPath: string }
  | { type: 'set-overwrite-policy'; overwritePolicy: ExportOverwritePolicy }
  | { type: 'set-collapsed-branch-policy'; collapsedBranchPolicy: CollapsedBranchPolicy }
  | { type: 'set-dimension-mode'; dimensionMode: ExportDimensionMode }
  | { type: 'set-width'; width: number }
  | { type: 'set-height'; height: number }
  | { type: 'set-scale'; scale: number }
  | { type: 'set-pixel-density'; pixelDensity: number }
  | { type: 'set-pdf-page-mode'; pdfPageMode: PdfPageMode }
  | { type: 'set-pdf-width'; pdfWidth: number }
  | { type: 'set-pdf-height'; pdfHeight: number }
  | { type: 'set-pdf-margin'; pdfMargin: number }
  | { type: 'set-markdown-mode'; markdownMode: MarkdownExportMode }
  | { type: 'set-include-frontmatter'; includeFrontmatter: boolean }
  | { type: 'set-include-unmapped-blocks'; includeUnmappedBlocks: boolean }
  | { type: 'set-phase'; phase: Extract<ExportDialogPhase, 'validating' | 'rendering' | 'writing'> }
  | { type: 'complete'; result: ExportResult }
  | { type: 'cancel' };

export interface ExportFormatOptionAvailability {
  showVisualDimensions: boolean;
  showPixelDensity: boolean;
  showPdfOptions: boolean;
  showMarkdownOptions: boolean;
}

const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  png: 'png',
  svg: 'svg',
  pdf: 'pdf',
  markdown: 'md',
};

const EXPORT_EXTENSION_PATTERN = /\.(png|svg|pdf|md|markdown)$/i;

export function createExportDialogState(
  context: ExportDialogContext,
  format: ExportFormat = 'png',
): ExportDialogState {
  return {
    format,
    scopeType: 'current_file',
    outputPath: defaultExportOutputPath(context, format, 'current_file'),
    overwritePolicy: 'fail_if_exists',
    collapsedBranchPolicy: 'preserve_collapsed',
    dimensionMode: 'layout_bounds',
    width: 1280,
    height: 720,
    scale: 1,
    pixelDensity: 1,
    pdfPageMode: 'fit_to_single_page',
    pdfWidth: 1024,
    pdfHeight: 768,
    pdfMargin: 24,
    markdownMode: 'markmap_hierarchy',
    includeFrontmatter: true,
    includeUnmappedBlocks: true,
    phase: 'ready',
    result: null,
  };
}

export function exportDialogReducer(
  state: ExportDialogState,
  action: ExportDialogAction,
): ExportDialogState {
  switch (action.type) {
    case 'reset':
      return createExportDialogState(action.context, action.format ?? state.format);
    case 'set-format':
      return {
        ...state,
        format: action.format,
        outputPath: defaultExportOutputPath(action.context, action.format, state.scopeType),
        phase: 'ready',
        result: null,
      };
    case 'set-scope':
      return {
        ...state,
        scopeType: action.scopeType,
        outputPath: defaultExportOutputPath(action.context, state.format, action.scopeType),
        phase: 'ready',
        result: null,
      };
    case 'set-output-path':
      return { ...state, outputPath: action.outputPath, phase: 'ready', result: null };
    case 'set-overwrite-policy':
      return { ...state, overwritePolicy: action.overwritePolicy, phase: 'ready', result: null };
    case 'set-collapsed-branch-policy':
      return {
        ...state,
        collapsedBranchPolicy: action.collapsedBranchPolicy,
        phase: 'ready',
        result: null,
      };
    case 'set-dimension-mode':
      return { ...state, dimensionMode: action.dimensionMode, phase: 'ready', result: null };
    case 'set-width':
      return { ...state, width: action.width, phase: 'ready', result: null };
    case 'set-height':
      return { ...state, height: action.height, phase: 'ready', result: null };
    case 'set-scale':
      return { ...state, scale: action.scale, phase: 'ready', result: null };
    case 'set-pixel-density':
      return { ...state, pixelDensity: action.pixelDensity, phase: 'ready', result: null };
    case 'set-pdf-page-mode':
      return { ...state, pdfPageMode: action.pdfPageMode, phase: 'ready', result: null };
    case 'set-pdf-width':
      return { ...state, pdfWidth: action.pdfWidth, phase: 'ready', result: null };
    case 'set-pdf-height':
      return { ...state, pdfHeight: action.pdfHeight, phase: 'ready', result: null };
    case 'set-pdf-margin':
      return { ...state, pdfMargin: action.pdfMargin, phase: 'ready', result: null };
    case 'set-markdown-mode':
      return { ...state, markdownMode: action.markdownMode, phase: 'ready', result: null };
    case 'set-include-frontmatter':
      return {
        ...state,
        includeFrontmatter: action.includeFrontmatter,
        phase: 'ready',
        result: null,
      };
    case 'set-include-unmapped-blocks':
      return {
        ...state,
        includeUnmappedBlocks: action.includeUnmappedBlocks,
        phase: 'ready',
        result: null,
      };
    case 'set-phase':
      return { ...state, phase: action.phase, result: null };
    case 'complete':
      return {
        ...state,
        phase: resultPhase(action.result),
        result: action.result,
      };
    case 'cancel':
      return { ...state, phase: 'cancelled' };
  }
}

export function exportFormatOptionAvailability(
  format: ExportFormat,
): ExportFormatOptionAvailability {
  return {
    showVisualDimensions: format !== 'markdown',
    showPixelDensity: format === 'png',
    showPdfOptions: format === 'pdf',
    showMarkdownOptions: format === 'markdown',
  };
}

export function selectedBranchAvailable(context: ExportDialogContext): boolean {
  return Boolean(context.selectedNodeId);
}

export function exportDialogValidationMessages(
  state: ExportDialogState,
  context: ExportDialogContext,
): string[] {
  const messages: string[] = [];

  if (!state.outputPath.trim()) {
    messages.push('Output path is required.');
  } else {
    const outputPathMessage = validateExportOutputPath(state.outputPath);
    if (outputPathMessage) {
      messages.push(outputPathMessage);
    }
  }

  if (state.scopeType === 'selected_branch' && !selectedBranchAvailable(context)) {
    messages.push('Selected branch export requires a selected node.');
  }

  if (state.format === 'markdown' && state.markdownMode === 'source_markdown' && context.hasUnsavedChanges) {
    messages.push('Source Markdown export is unavailable while the editor has unsaved changes.');
  }

  if (state.dimensionMode === 'explicit' && (state.width <= 0 || state.height <= 0)) {
    messages.push('Explicit export size must be positive.');
  }

  if (state.dimensionMode === 'scale' && state.scale <= 0) {
    messages.push('Export scale must be positive.');
  }

  if (state.format === 'png' && state.pixelDensity <= 0) {
    messages.push('PNG pixel density must be positive.');
  }

  if (
    state.format === 'pdf' &&
    state.pdfPageMode === 'custom_page' &&
    (state.pdfWidth <= 0 || state.pdfHeight <= 0)
  ) {
    messages.push('Custom PDF page size must be positive.');
  }

  if (state.format === 'pdf' && state.pdfMargin < 0) {
    messages.push('PDF margin cannot be negative.');
  }

  return messages;
}

function validateExportOutputPath(outputPath: string): string | null {
  const trimmed = outputPath.trim();

  if (/^[A-Za-z]:([/\\]|$)/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return 'Output path must be relative to the workspace.';
  }

  if (trimmed.includes('\\')) {
    return 'Output path must use forward slashes.';
  }

  if (trimmed.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'Output path cannot contain dot segments.';
  }

  return null;
}

export function canSubmitExport(
  state: ExportDialogState,
  context: ExportDialogContext,
): boolean {
  return (
    !isExportBusy(state.phase) &&
    exportDialogValidationMessages(state, context).length === 0
  );
}

export function getExportCommandEntryState(
  state: ExportDialogState,
  context: ExportDialogContext,
): ExportCommandEntryState {
  const validationMessages = exportDialogValidationMessages(state, context);

  if (state.phase === 'validating') {
    return {
      kind: 'validating',
      label: 'Validating export',
      detail: 'Checking format, scope, and output path before rendering.',
      actionLabel: 'Validating',
      disabled: true,
      tone: 'info',
    };
  }

  if (state.phase === 'rendering') {
    return {
      kind: 'rendering',
      label: 'Rendering export',
      detail: 'Preparing the visual snapshot for the desktop export command.',
      actionLabel: 'Rendering',
      disabled: true,
      tone: 'info',
    };
  }

  if (state.phase === 'writing') {
    return {
      kind: 'writing',
      label: 'Writing export',
      detail: 'Passing the prepared artifact to the desktop export command.',
      actionLabel: 'Writing',
      disabled: true,
      tone: 'info',
    };
  }

  if (validationMessages.length > 0) {
    return {
      kind: 'blocked',
      label: 'Export blocked',
      detail: validationMessages[0],
      actionLabel: 'Export',
      disabled: true,
      tone: 'warning',
    };
  }

  if (state.phase === 'succeeded' && state.result?.ok) {
    return {
      kind: 'succeeded',
      label: 'Export complete',
      detail: `Last export wrote ${state.result.outputPath}.`,
      actionLabel: 'Export again',
      disabled: false,
      tone: 'success',
    };
  }

  if (state.phase === 'warning-present' && state.result?.ok) {
    return {
      kind: 'warning',
      label: 'Export completed with warnings',
      detail: state.result.warnings[0]?.message ?? `Last export wrote ${state.result.outputPath}.`,
      actionLabel: 'Export again',
      disabled: false,
      tone: 'warning',
    };
  }

  if (state.phase === 'failed' && state.result && !state.result.ok) {
    return {
      kind: 'failed',
      label: 'Export failed',
      detail: state.result.error.message,
      actionLabel: 'Retry export',
      disabled: false,
      tone: 'danger',
    };
  }

  if (state.phase === 'cancelled') {
    return {
      kind: 'cancelled',
      label: 'Export cancelled',
      detail: 'The previous export run was cancelled before completion.',
      actionLabel: 'Export',
      disabled: false,
      tone: 'muted',
    };
  }

  return {
    kind: 'ready',
    label: 'Ready to export',
    detail: `Export ${formatLabel(state.format)} for ${scopeLabel(state.scopeType)}.`,
    actionLabel: 'Export',
    disabled: false,
    tone: 'neutral',
  };
}

export function isExportBusy(phase: ExportDialogPhase): boolean {
  return phase === 'validating' || phase === 'rendering' || phase === 'writing';
}

export function buildExportOptions(state: ExportDialogState): ExportOptions {
  return {
    outputPath: state.outputPath.trim(),
    overwritePolicy: state.overwritePolicy,
    ...(state.format === 'markdown'
      ? {}
      : {
          dimensions: buildDimensionOptions(state),
        }),
    ...(state.format === 'png'
      ? {
          pixelDensity: state.pixelDensity,
        }
      : {}),
    theme: {
      source: 'document',
    },
    ...(state.format === 'pdf'
      ? {
          pdf:
            state.pdfPageMode === 'custom_page'
              ? {
                  mode: state.pdfPageMode,
                  width: state.pdfWidth,
                  height: state.pdfHeight,
                  margin: state.pdfMargin,
                  unit: 'pt',
                }
              : {
                  mode: state.pdfPageMode,
                  margin: state.pdfMargin,
                  unit: 'pt',
                },
        }
      : {}),
    collapsedBranchPolicy: state.collapsedBranchPolicy,
    ...(state.format === 'markdown'
      ? {
          markdown: {
            mode: state.markdownMode,
            includeFrontmatter: state.includeFrontmatter,
            includeUnmappedBlocks: state.includeUnmappedBlocks,
          },
        }
      : {}),
  };
}

export function defaultExportOutputPath(
  context: ExportDialogContext,
  format: ExportFormat,
  scopeType: ExportScope['type'],
): string {
  const fileName = defaultExportFileName(context, format, scopeType);
  const directory = directoryFromPath(context.documentPath);

  return directory ? `${directory}/${fileName}` : `exports/${fileName}`;
}

export function defaultExportFileName(
  context: ExportDialogContext,
  format: ExportFormat,
  scopeType: ExportScope['type'],
): string {
  const sourceBase = context.documentPath
    ? basenameWithoutMarkdownExtension(context.documentPath)
    : slugSegment(context.documentTitle);
  const branchSegment =
    scopeType === 'selected_branch' && context.selectedNodeTitle
      ? `-${slugSegment(context.selectedNodeTitle)}`
      : '';
  const markdownCopySegment = format === 'markdown' && scopeType === 'current_file' ? '-export' : '';
  const extension = EXPORT_EXTENSIONS[format];

  return `${sourceBase || 'untitled-map'}${branchSegment}${markdownCopySegment}.${extension}`;
}

export function replaceExportExtension(outputPath: string, format: ExportFormat): string {
  const extension = EXPORT_EXTENSIONS[format];
  const nextPath = outputPath.trim() || `exports/untitled-map.${extension}`;

  if (EXPORT_EXTENSION_PATTERN.test(nextPath)) {
    return nextPath.replace(EXPORT_EXTENSION_PATTERN, `.${extension}`);
  }

  return `${nextPath}.${extension}`;
}

export function phaseLabel(phase: ExportDialogPhase): string {
  switch (phase) {
    case 'ready':
      return 'Ready';
    case 'validating':
      return 'Validating';
    case 'rendering':
      return 'Rendering';
    case 'writing':
      return 'Writing';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'warning-present':
      return 'Warning present';
  }
}

function buildDimensionOptions(state: ExportDialogState): NonNullable<ExportOptions['dimensions']> {
  if (state.dimensionMode === 'explicit') {
    return {
      mode: 'explicit',
      width: state.width,
      height: state.height,
    };
  }

  if (state.dimensionMode === 'scale') {
    return {
      mode: 'scale',
      scale: state.scale,
    };
  }

  return {
    mode: 'layout_bounds',
  };
}

function resultPhase(result: ExportResult): ExportDialogPhase {
  if (!result.ok) {
    return result.error.code === 'export_cancelled' ? 'cancelled' : 'failed';
  }

  return result.warnings.length > 0 ? 'warning-present' : 'succeeded';
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

function scopeLabel(scopeType: ExportScope['type']): string {
  switch (scopeType) {
    case 'current_file':
      return 'the current file';
    case 'selected_branch':
      return 'the selected branch';
  }
}

function directoryFromPath(path: string | null): string {
  if (!path) {
    return '';
  }

  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');

  return index > 0 ? normalized.slice(0, index) : '';
}

function basenameWithoutMarkdownExtension(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const filename = normalized.split('/').pop() ?? normalized;
  const withoutExtension = filename.replace(/\.(md|markdown)$/i, '');

  return slugSegment(withoutExtension);
}

function slugSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
