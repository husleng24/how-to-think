import type { MindMapDocument, NodeId } from '../../domain/mindMap';

export type WorkspaceId = string;
export type WorkspaceRelativePath = string;

export type AiContextScope =
  | 'selectedNode'
  | 'selectedBranch'
  | 'currentFile'
  | 'workspaceSummary';

export type AiContextItemKind =
  | 'mindMapNode'
  | 'mindMapBranch'
  | 'markdownFile'
  | 'workspaceFileTree';

export type AiContextWarningCode =
  | 'context_truncated'
  | 'file_limit_reached'
  | 'ignored_paths_excluded'
  | 'unsupported_files_excluded'
  | 'invalid_document_path'
  | 'open_file_skipped'
  | 'markdown_parser_diagnostic';

export interface AiContextLimits {
  maxContextBytes: number;
  maxFiles: number;
  maxOpenFiles: number;
}

export interface AiContextSnapshotRequest {
  workspaceId: WorkspaceId;
  scope?: AiContextScope;
  document?: MindMapDocument;
  selectedNodeId?: NodeId;
  currentFile?: WorkspaceRelativePath;
  openFiles?: WorkspaceRelativePath[];
  contentRevision?: number;
  limits?: AiContextLimits;
}

export interface AiContextWarning {
  code: AiContextWarningCode;
  message: string;
  itemId?: string;
  relativePath?: WorkspaceRelativePath;
}

export interface AiContextItem {
  id: string;
  kind: AiContextItemKind;
  label: string;
  relativePath?: WorkspaceRelativePath;
  nodeIds?: NodeId[];
  content: string;
  byteEstimate: number;
}

export interface AiContextSnapshot {
  workspaceId: WorkspaceId;
  scope: AiContextScope;
  displayLabel: string;
  documentId?: string;
  documentPath?: WorkspaceRelativePath;
  documentRevision?: string;
  documentContentHash?: string;
  selectedNodeIds?: NodeId[];
  items: AiContextItem[];
  byteEstimate: number;
  tokenEstimate: number;
  truncated: boolean;
  warnings?: AiContextWarning[];
}

export interface AiConversationContextEnvelope {
  contextLabel: string;
  contextSnapshot: AiContextSnapshot;
}

export type AiProviderKind = 'codex' | 'claude' | 'generic';

export type AiProviderHealthState =
  | 'unknown'
  | 'ok'
  | 'missingExecutable'
  | 'permissionDenied'
  | 'authRequired'
  | 'timeout'
  | 'nonZeroExit'
  | 'invalidConfig';

export interface AiProviderHealthStatus {
  status: AiProviderHealthState;
  checkedAt: string;
  message: string;
  detail?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface AiProviderConfig {
  id: string;
  displayName: string;
  kind: AiProviderKind;
  executablePath: string;
  argumentTemplate: string[];
  healthCheckArgs: string[];
  environmentAllowlist?: string[];
  workingDirectory?: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  enabled: boolean;
  lastHealthStatus?: AiProviderHealthStatus;
}

export interface AiProviderConfigInput {
  id?: string;
  displayName: string;
  kind: AiProviderKind;
  executablePath: string;
  argumentTemplate: string[];
  healthCheckArgs: string[];
  environmentAllowlist?: string[];
  workingDirectory?: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  enabled: boolean;
}

export interface AiProviderSettings {
  activeProviderId?: string | null;
  providers: AiProviderConfig[];
}

export interface AiProviderSetupState {
  usable: boolean;
  reason: string;
  nextAction: string;
  activeProvider?: AiProviderConfig;
}

export type AiMessageRole = 'user' | 'assistant' | 'error';

export type AiRunStatus =
  | 'queued'
  | 'running'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AiErrorCode =
  | 'invalid_request'
  | 'provider_not_configured'
  | 'provider_disabled'
  | 'provider_config_invalid'
  | 'provider_unavailable'
  | 'provider_timed_out'
  | 'provider_cancelled'
  | 'provider_non_zero_exit'
  | 'provider_output_malformed'
  | 'provider_output_too_large'
  | 'runtime_unavailable';

export interface AiError {
  code: AiErrorCode | string;
  message: string;
  recoverable: boolean;
  guidance: string;
  providerId?: string;
  runId?: string;
  exitCode?: number;
  detail?: string;
}

export interface AiConversationLimits {
  maxHistoryMessages: number;
  maxHistoryBytes: number;
}

export interface AiConversationRequest {
  workspaceId: WorkspaceId;
  sessionId?: string | null;
  providerId?: string | null;
  documentId?: string | null;
  documentPath?: WorkspaceRelativePath | null;
  prompt: string;
  context: AiContextSnapshot;
  limits?: Partial<AiConversationLimits>;
}

export interface AiMessage {
  id: string;
  sessionId: string;
  runId: string;
  role: AiMessageRole;
  content: string;
  createdAt: string;
  contextLabel?: string;
  errorCode?: AiErrorCode | string;
}

export interface AiRun {
  id: string;
  sessionId: string;
  providerId: string;
  status: AiRunStatus;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: AiError;
}

export interface AiSession {
  id: string;
  workspaceId: WorkspaceId;
  providerId: string;
  documentId?: string;
  documentPath?: WorkspaceRelativePath;
  messages: AiMessage[];
  createdAt: string;
  updatedAt: string;
  lastRunStatus: AiRunStatus;
}

export interface AiRunDiagnostics {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface AiResponse {
  run: AiRun;
  session: AiSession;
  assistantMessage?: AiMessage;
  error?: AiError;
  diagnostics?: AiRunDiagnostics;
}

export interface AiRunEvent {
  run: AiRun;
  status: AiRunStatus;
  error?: AiError;
}
