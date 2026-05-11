import type { NodeId } from '../../mindmap/domain/mindMap';
import type {
  CompatibilityDiagnostic,
  DiagnosticSeverity,
  FileVersion,
  LinkTokenKind,
  WorkspaceId,
  WorkspaceRelativePath,
} from '../../../types/markdownLifecycle';

export type ExportContractVersion = '2026-05-11.v1';

export type ExportFormat = 'svg' | 'png' | 'pdf' | 'markdown';

export type ExportScopeDiagnosticCode =
  | 'branch_root_missing'
  | 'branch_root_not_found'
  | 'scope_empty'
  | 'scope_contains_lossy_markdown';

export interface ExportScopeDiagnostic {
  code: ExportScopeDiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  nodeId?: NodeId;
  markdownDiagnostics?: readonly CompatibilityDiagnostic[];
}

export type ExportScope =
  | {
      type: 'current_file';
      diagnostics?: readonly ExportScopeDiagnostic[];
    }
  | {
      type: 'selected_branch';
      rootNodeId: NodeId;
      selectionId?: string;
      diagnostics?: readonly ExportScopeDiagnostic[];
    };

export type ExportOverwritePolicy = 'fail_if_exists' | 'replace_existing';

export type ExportDimensionOptions =
  | {
      mode: 'layout_bounds';
      maxWidth?: number;
      maxHeight?: number;
    }
  | {
      mode: 'explicit';
      width: number;
      height: number;
    }
  | {
      mode: 'scale';
      scale: number;
    };

export type ExportThemeSource = 'document' | 'application' | 'explicit';

export interface ExportThemeOptions {
  source: ExportThemeSource;
  tokens?: Record<string, string | number | boolean>;
}

export type PdfPageMode = 'fit_to_single_page' | 'custom_page';
export type PdfPageUnit = 'px' | 'pt' | 'mm';

export interface PdfPageOptions {
  mode: PdfPageMode;
  width?: number;
  height?: number;
  margin?: number;
  unit?: PdfPageUnit;
}

export type CollapsedBranchPolicy =
  | 'preserve_collapsed'
  | 'expand_all'
  | 'visible_only';

export type MarkdownExportMode = 'source_markdown' | 'markmap_hierarchy';

export interface MarkdownExportOptions {
  mode: MarkdownExportMode;
  includeFrontmatter?: boolean;
  includeUnmappedBlocks?: boolean;
}

export interface ExportOptions {
  outputPath: WorkspaceRelativePath | string;
  overwritePolicy: ExportOverwritePolicy;
  dimensions?: ExportDimensionOptions;
  pixelDensity?: number;
  theme: ExportThemeOptions;
  pdf?: PdfPageOptions;
  collapsedBranchPolicy: CollapsedBranchPolicy;
  markdown?: MarkdownExportOptions;
}

export interface ExportSourceMetadata {
  workspaceId?: WorkspaceId;
  documentId: string;
  documentVersion?: number;
  workspaceRelativePath?: WorkspaceRelativePath | null;
  fileVersion?: Pick<FileVersion, 'token' | 'modifiedAt' | 'byteSize'>;
  markdownSchemaVersion?: string;
  generatedAt: string;
}

export interface ExportRequest {
  contractVersion: ExportContractVersion;
  format: ExportFormat;
  scope: ExportScope;
  options: ExportOptions;
  source: ExportSourceMetadata;
  snapshot?: MindMapRenderSnapshot;
}

export interface ExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TextRunMark = 'bold' | 'italic' | 'code' | 'strikethrough';

export interface MindMapTextRun {
  text: string;
  marks?: readonly TextRunMark[];
  linkTokenId?: string;
}

export interface MindMapRenderNode {
  id: string;
  sourceNodeId: NodeId;
  parentNodeId: NodeId | null;
  depth: number;
  order: number;
  bounds: ExportBounds;
  textRuns: readonly MindMapTextRun[];
  linkTokenIds: readonly string[];
  collapsed: boolean;
  hiddenDescendantCount: number;
}

export interface MindMapRenderEdge {
  id: string;
  sourceNodeId: NodeId;
  targetNodeId: NodeId;
  from: {
    x: number;
    y: number;
  };
  to: {
    x: number;
    y: number;
  };
}

export interface MindMapRenderLinkToken {
  id: string;
  kind: LinkTokenKind;
  raw: string;
  label: string;
  target: string;
  alias?: string | null;
  resolvedWorkspacePath?: WorkspaceRelativePath | null;
}

export interface MindMapCollapsedMarker {
  nodeId: NodeId;
  hiddenNodeCount: number;
  label: string;
}

export interface MindMapRenderTheme {
  source: ExportThemeSource;
  tokens: Record<string, string | number | boolean>;
}

export interface MindMapRenderSnapshot {
  contractVersion: ExportContractVersion;
  snapshotId: string;
  source: ExportSourceMetadata;
  scope: ExportScope;
  bounds: ExportBounds;
  nodes: readonly MindMapRenderNode[];
  edges: readonly MindMapRenderEdge[];
  linkTokens: readonly MindMapRenderLinkToken[];
  collapsedMarkers: readonly MindMapCollapsedMarker[];
  theme: MindMapRenderTheme;
  warnings: readonly ExportWarning[];
}

export type ExportWarningCode =
  | 'collapsed_content_preserved'
  | 'collapsed_content_expanded'
  | 'collapsed_content_omitted'
  | 'font_substitution'
  | 'large_map_scaled'
  | 'pdf_fit_to_page'
  | 'markdown_compatibility_warning'
  | 'unresolved_link'
  | 'output_overwrite_requested';

export interface ExportWarning {
  code: ExportWarningCode;
  message: string;
  severity: Exclude<DiagnosticSeverity, 'error'>;
  details?: Record<string, string | number | boolean | null>;
}

export type ExportErrorCode =
  | 'unsupported_contract_version'
  | 'unsupported_export_format'
  | 'invalid_export_scope'
  | 'missing_output_path'
  | 'invalid_overwrite_policy'
  | 'invalid_export_dimensions'
  | 'incompatible_export_options'
  | 'invalid_render_snapshot'
  | 'output_path_conflict'
  | 'output_not_writable'
  | 'source_file_missing'
  | 'source_file_stale'
  | 'markdown_parse_failed'
  | 'markdown_serialization_lossy'
  | 'render_failed'
  | 'conversion_failed'
  | 'write_failed'
  | 'confirmation_required'
  | 'internal_export_error';

export interface ExportError {
  code: ExportErrorCode;
  message: string;
  recoverable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export interface ExportArtifactMetadata {
  mimeType: string;
  byteSize?: number;
  width?: number;
  height?: number;
  pageCount?: number;
  checksumSha256?: string;
  renderedNodeCount?: number;
  renderedEdgeCount?: number;
}

export type ExportResult =
  | {
      ok: true;
      contractVersion: ExportContractVersion;
      format: ExportFormat;
      outputPath: WorkspaceRelativePath | string;
      artifact: ExportArtifactMetadata;
      warnings: readonly ExportWarning[];
    }
  | {
      ok: false;
      contractVersion: ExportContractVersion;
      format?: ExportFormat;
      outputPath?: WorkspaceRelativePath | string;
      warnings: readonly ExportWarning[];
      error: ExportError;
    };

export type ExportValidationResult =
  | {
      ok: true;
      errors: [];
    }
  | {
      ok: false;
      errors: readonly ExportError[];
    };
