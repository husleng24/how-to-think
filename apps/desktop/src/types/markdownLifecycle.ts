export type WorkspaceId = string;
export type WorkspaceRelativePath = string;
export type IsoDateTime = string;
export type NodeId = string;

export type ParseMode = 'auto' | 'heading_only' | 'list_only' | 'mixed';
export type MarkdownSerializeMode = 'canonical_headings';
export type SerializePreservationPolicy = 'block_lossy' | 'require_confirmation' | 'allow_lossy';
export type MarkdownLineEnding = 'lf' | 'crlf';
export type DiagnosticSeverity = 'info' | 'warning' | 'error';
export type MarkdownBlockKind =
  | 'document_root'
  | 'heading'
  | 'list_item'
  | 'frontmatter'
  | 'paragraph'
  | 'code_block'
  | 'table'
  | 'image'
  | 'html'
  | 'comment'
  | 'block_quote'
  | 'thematic_break'
  | 'unknown';
export type MindMapNodeKind = 'virtual_root' | 'heading' | 'list_item';
export type LinkTokenKind = 'standard_markdown' | 'image' | 'obsidian_wiki';
export type ListMarkerKind = 'unordered' | 'ordered' | 'task';
export type PreservationPolicy = 'preserve_raw' | 'requires_confirmation' | 'block_lossy_save';
export type SaveReason = 'manual' | 'autosave';

export interface FileVersion {
  modifiedAt: IsoDateTime;
  byteSize: number;
  contentHash: string;
  token: string;
}

export interface WorkspaceFile {
  relativePath: WorkspaceRelativePath;
  name: string;
  extension: string;
  byteSize: number;
  modifiedAt: IsoDateTime;
  version: FileVersion;
}

export interface DocumentSnapshot {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  content: string;
  version: FileVersion;
  openedAt: IsoDateTime;
}

export interface SaveResult {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  version: FileVersion;
  savedAt: IsoDateTime;
  byteSize: number;
}

export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface MarkdownOrigin {
  sourcePath: WorkspaceRelativePath | null;
  span: SourceSpan;
  blockKind: MarkdownBlockKind;
  headingLevel: number | null;
  listDepth: number | null;
}

export interface LinkToken {
  kind: LinkTokenKind;
  raw: string;
  label: string | null;
  target: string;
  alias: string | null;
  origin: MarkdownOrigin;
}

export interface ListMarker {
  raw: string;
  kind: ListMarkerKind;
  ordinal: number | null;
  checked: boolean | null;
}

export interface MarkdownMindMapNode {
  id: NodeId;
  title: string;
  rawText: string;
  nodeKind: MindMapNodeKind;
  children: NodeId[];
  origin: MarkdownOrigin;
  links: LinkToken[];
  listMarker: ListMarker | null;
}

export interface UnmappedPlacement {
  afterNodeId: NodeId | null;
  beforeNodeId: NodeId | null;
}

export interface UnmappedMarkdownBlock {
  id: string;
  kind: MarkdownBlockKind;
  raw: string;
  origin: MarkdownOrigin;
  placement: UnmappedPlacement;
  preservation: PreservationPolicy;
}

export interface CompatibilityDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  origin: MarkdownOrigin | null;
  nodeId: NodeId | null;
}

export interface MarkdownMindMapDocument {
  schemaVersion: string;
  sourcePath: WorkspaceRelativePath | null;
  title: string;
  parseMode: ParseMode;
  rootNodeId: NodeId;
  nodes: Record<NodeId, MarkdownMindMapNode>;
  unmappedBlocks: UnmappedMarkdownBlock[];
  diagnostics: CompatibilityDiagnostic[];
}

export interface SerializeMarkdownMetadata {
  schemaVersion: string;
  sourcePath: WorkspaceRelativePath | null;
  targetPath: WorkspaceRelativePath | null;
  saveMode: MarkdownSerializeMode;
  preservationPolicy: SerializePreservationPolicy;
  lineEnding: MarkdownLineEnding;
  canonicalized: boolean;
  nodeCount: number;
  unmappedBlockCount: number;
}

export interface HeadingAnchor {
  text: string;
  anchor: string;
  line: number;
  level: number;
}

export interface LinkIndexFile {
  relativePath: WorkspaceRelativePath;
  absolutePath: string;
  name: string;
  stem: string;
  pathLookupKey: string;
  stemLookupKey: string;
  headings: HeadingAnchor[];
}

export interface LinkDiagnostic {
  code: string;
  severity: string;
  message: string;
  sourceRelativePath?: WorkspaceRelativePath;
  target?: string;
  candidates: unknown[];
}

export interface LinkIndexSnapshot {
  workspaceId: WorkspaceId;
  files: LinkIndexFile[];
  diagnostics: LinkDiagnostic[];
}

export interface ParseMarkdownPreviewRequest {
  markdown: string;
  sourcePath?: WorkspaceRelativePath | null;
  parseMode?: ParseMode;
}

export interface ParseMarkdownPreviewResult {
  status: 'parsed' | 'parseError';
  document?: MarkdownMindMapDocument;
  diagnostics: CompatibilityDiagnostic[];
}

export interface OpenMarkdownMindMapRequest {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  parseMode?: ParseMode;
}

export interface OpenMarkdownMindMapResult {
  status: 'opened' | 'parseError';
  snapshot: DocumentSnapshot;
  document?: MarkdownMindMapDocument;
  diagnostics: CompatibilityDiagnostic[];
  files: WorkspaceFile[];
  linkIndex: LinkIndexSnapshot;
}

export interface SerializeMindMapRequest {
  document: MarkdownMindMapDocument;
  targetPath?: WorkspaceRelativePath | null;
  saveMode?: MarkdownSerializeMode;
  preservationPolicy?: SerializePreservationPolicy;
  lineEnding?: MarkdownLineEnding;
}

export interface SerializeMindMapResult {
  status: 'serialized' | 'lossySaveBlocked' | 'lossySaveConfirmationRequired' | 'serializationError';
  markdown?: string;
  diagnostics: CompatibilityDiagnostic[];
  metadata: SerializeMarkdownMetadata;
}

export interface SaveMarkdownMindMapRequest {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  expectedVersion: FileVersion;
  document: MarkdownMindMapDocument;
  reason: SaveReason;
  saveMode?: MarkdownSerializeMode;
  preservationPolicy?: SerializePreservationPolicy;
  lineEnding?: MarkdownLineEnding;
  confirmLossySave?: boolean;
}

export interface SaveMarkdownMindMapResult {
  status: 'saved' | 'lossySaveBlocked' | 'lossySaveConfirmationRequired' | 'serializationError';
  diagnostics: CompatibilityDiagnostic[];
  metadata: SerializeMarkdownMetadata;
  markdown?: string;
  save?: SaveResult;
  files?: WorkspaceFile[];
  linkIndex?: LinkIndexSnapshot;
}

export interface WorkspaceError {
  code: string;
  message: string;
  recoverable: boolean;
  relativePath?: WorkspaceRelativePath;
  operation: string;
  details?: Record<string, unknown>;
}
