import type { MindMapDocument as EditorMindMapDocument } from '../../domain/mindMap';
import type {
  GitBlockedState,
  GitDiffRequest,
  GitDiffResult,
  GitHistoryEntry,
  GitHistoryRequest,
  GitOperationError,
  GitRepositoryState,
  GitRepositoryStateToken,
  GitRestoreRequest,
  GitRestoreResult,
  GitSnapshotRequest,
  GitSnapshotResult,
  GitStatusSummary,
} from '../git-service';
import type {
  CompatibilityDiagnostic,
  DocumentSnapshot,
  FileVersion,
  LinkIndexSnapshot,
  MarkdownMindMapDocument,
  SaveMarkdownMindMapResult,
  SaveReason,
  SaveResult,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceRelativePath,
} from '../../types/markdownLifecycle';

export type WorkspaceOperation =
  | 'selectWorkspace'
  | 'createWorkspace'
  | 'loadWorkspace'
  | 'listFiles'
  | 'createFile'
  | 'openFile'
  | 'saveFile'
  | 'renameFile'
  | 'deleteFile'
  | 'watchWorkspace'
  | 'buildAiContext';

export type WorkspaceErrorCode =
  | 'workspace_not_selected'
  | 'workspace_missing'
  | 'workspace_not_directory'
  | 'workspace_unwritable'
  | 'permission_denied'
  | 'invalid_workspace_path'
  | 'invalid_relative_path'
  | 'path_outside_workspace'
  | 'invalid_ai_context_request'
  | 'unsupported_file_type'
  | 'file_not_found'
  | 'file_already_exists'
  | 'invalid_utf8'
  | 'version_conflict'
  | 'write_failed'
  | 'disk_full'
  | 'rename_failed'
  | 'delete_failed'
  | 'watch_unavailable'
  | 'operation_cancelled'
  | 'unknown_io_error';

export interface WorkspaceError {
  code: WorkspaceErrorCode | string;
  message: string;
  recoverable: boolean;
  relativePath?: WorkspaceRelativePath;
  operation: WorkspaceOperation | string;
  details?: Record<string, unknown>;
}

export interface WorkspaceInfo {
  id: WorkspaceId;
  displayName: string;
  displayPath: string;
  platform: 'windows' | 'macos' | 'linux';
  caseSensitive: boolean;
  writable: boolean;
  lastOpenedAt: string;
}

export interface WorkspaceSession {
  workspace: WorkspaceInfo;
  files: WorkspaceFile[];
  lastOpenedFile?: WorkspaceRelativePath | null;
}

export interface RenameDocumentResult {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  newRelativePath: WorkspaceRelativePath;
  file: WorkspaceFile;
  files: WorkspaceFile[];
  renamedAt: string;
}

export interface DeleteDocumentResult {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  files: WorkspaceFile[];
  deletedAt: string;
}

export interface DocumentExternalChangeStatus {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  changeType: 'unchanged' | 'modified' | 'missing' | 'moved';
  expectedVersion: FileVersion;
  currentFile?: WorkspaceFile;
  movedTo?: WorkspaceRelativePath;
  movedFile?: WorkspaceFile;
  files: WorkspaceFile[];
  checkedAt: string;
}

export type ExternalChangeSource = 'watcher' | 'refresh';
export type ExternalChangeKind = 'created' | 'modified' | 'deleted' | 'renamed';

export interface ExternalChangeEvent {
  workspaceId: WorkspaceId;
  kind: ExternalChangeKind;
  relativePath: WorkspaceRelativePath;
  previousRelativePath?: WorkspaceRelativePath | null;
  file?: WorkspaceFile | null;
  previousVersion?: FileVersion | null;
  source: ExternalChangeSource;
  detectedAt: string;
}

export interface ExternalChangeBatch {
  workspaceId: WorkspaceId;
  source: ExternalChangeSource;
  events: readonly ExternalChangeEvent[];
  files: readonly WorkspaceFile[];
  repositoryStateChanged: boolean;
  gitStatus?: GitStatusSummary | null;
  detectedAt: string;
  watcherActive: boolean;
  watchError?: WorkspaceError | null;
}

export type WorkspaceWatchStatusKind =
  | 'inactive'
  | 'checking'
  | 'watching'
  | 'degraded'
  | 'error';

export interface WorkspaceWatchStatus {
  kind: WorkspaceWatchStatusKind;
  watcherActive: boolean;
  message: string;
  checkedAt?: string;
  error?: WorkspaceError | null;
}

export type WorkspaceFileIndexStatusKind =
  | 'idle'
  | 'building'
  | 'ready'
  | 'stale'
  | 'degraded'
  | 'error';

export interface WorkspaceFileIndexStatus {
  kind: WorkspaceFileIndexStatusKind;
  indexedFileCount: number;
  diagnosticCount: number;
  message: string;
  indexedAt?: string;
}

export interface WorkspaceExternalSyncStatus {
  watch: WorkspaceWatchStatus;
  fileIndex: WorkspaceFileIndexStatus;
}

export interface UserMessage {
  title: string;
  detail: string;
  relativePath?: WorkspaceRelativePath;
}

export type SaveStatusKind =
  | 'saved'
  | 'unsaved'
  | 'saving'
  | 'saveFailed'
  | 'conflict'
  | 'missing';

export interface SaveStatus {
  kind: SaveStatusKind;
  message: string;
  savedAt?: string;
  reason?: SaveReason;
  diagnostics?: CompatibilityDiagnostic[];
}

export interface ActiveDocumentState {
  key: string;
  snapshot: DocumentSnapshot;
  markdownDocument: MarkdownMindMapDocument;
  editorDocument: EditorMindMapDocument;
  linkIndex: LinkIndexSnapshot;
  savedContentRevision: number;
  contentRevision: number;
  inFlightSave: SaveRequestState | null;
}

export interface SaveRequestState {
  documentKey: string;
  relativePath: WorkspaceRelativePath;
  revision: number;
  reason: SaveReason;
}

export type PendingDocumentAction =
  | { type: 'open-file'; relativePath: WorkspaceRelativePath }
  | { type: 'create-file'; relativePath: WorkspaceRelativePath }
  | { type: 'rename-file'; newRelativePath: WorkspaceRelativePath }
  | { type: 'delete-file' }
  | { type: 'close-file' }
  | {
      type: 'restore-from-git';
      sourceRef: string;
      expectedRepoToken: GitRepositoryStateToken;
    };

export interface UnsavedPromptState {
  action: PendingDocumentAction;
  title: string;
  message: string;
  saveDisabled: boolean;
}

export interface WorkspaceLifecycleState {
  startupStatus: 'loading' | 'ready' | 'error';
  workspace: WorkspaceInfo | null;
  files: WorkspaceFile[];
  active: ActiveDocumentState | null;
  recentFiles: WorkspaceRelativePath[];
  saveStatus: SaveStatus;
  gitStatus: GitStatusSummary | null;
  gitBlockedState: GitBlockedState | null;
  externalSyncStatus?: WorkspaceExternalSyncStatus;
  prompt: UnsavedPromptState | null;
  lastError: UserMessage | null;
  isBusy: boolean;
}

export interface OpenedDocumentPayload {
  result: {
    snapshot: DocumentSnapshot;
    document: MarkdownMindMapDocument;
    diagnostics: CompatibilityDiagnostic[];
    files: WorkspaceFile[];
    linkIndex: LinkIndexSnapshot;
  };
  editorDocument: EditorMindMapDocument;
  contentRevision: number;
}

export interface SaveSucceededPayload {
  request: SaveRequestState;
  result: SaveMarkdownMindMapResult & { save: SaveResult };
  markdownDocument: MarkdownMindMapDocument;
  editorDocument: EditorMindMapDocument;
  currentContentRevision: number;
}

export interface WorkspaceCommands {
  loadRememberedWorkspace(): Promise<WorkspaceSession | null>;
  openWorkspaceAtPath(path: string): Promise<WorkspaceSession>;
  createWorkspaceAtPath(path: string): Promise<WorkspaceSession>;
  refreshWorkspaceFiles(workspaceId: WorkspaceId): Promise<WorkspaceFile[]>;
  refreshGitState(workspaceId: WorkspaceId): Promise<GitStatusSummary>;
  initializeGitRepository(workspaceId: WorkspaceId): Promise<GitRepositoryState>;
  createGitSnapshot(input: GitSnapshotRequest): Promise<GitSnapshotResult>;
  listGitHistory(input: GitHistoryRequest): Promise<GitHistoryEntry[]>;
  getGitDiff(input: GitDiffRequest): Promise<GitDiffResult>;
  startWorkspaceChangeDetection(workspaceId: WorkspaceId): Promise<ExternalChangeBatch>;
  refreshWorkspaceExternalChanges(workspaceId: WorkspaceId): Promise<ExternalChangeBatch>;
  stopWorkspaceChangeDetection(workspaceId: WorkspaceId): Promise<void>;
  createMarkdownDocument(
    workspaceId: WorkspaceId,
    relativePath: WorkspaceRelativePath,
    content?: string,
  ): Promise<DocumentSnapshot>;
  openMarkdownMindMap(
    workspaceId: WorkspaceId,
    relativePath: WorkspaceRelativePath,
  ): Promise<OpenedDocumentPayload['result']>;
  saveMarkdownMindMap(input: {
    workspaceId: WorkspaceId;
    relativePath: WorkspaceRelativePath;
    expectedVersion: FileVersion;
    document: MarkdownMindMapDocument;
    reason: SaveReason;
  }): Promise<SaveMarkdownMindMapResult>;
  renameMarkdownDocument(input: {
    workspaceId: WorkspaceId;
    relativePath: WorkspaceRelativePath;
    newRelativePath: WorkspaceRelativePath;
    expectedVersion?: FileVersion;
  }): Promise<RenameDocumentResult>;
  deleteMarkdownDocument(input: {
    workspaceId: WorkspaceId;
    relativePath: WorkspaceRelativePath;
    expectedVersion?: FileVersion;
  }): Promise<DeleteDocumentResult>;
  restoreMarkdownFromGit(input: GitRestoreRequest): Promise<GitRestoreResult>;
  rememberLastOpenedFile(
    workspaceId: WorkspaceId,
    relativePath: WorkspaceRelativePath,
  ): Promise<void>;
  checkOpenDocumentExternalChange(input: {
    workspaceId: WorkspaceId;
    relativePath: WorkspaceRelativePath;
    expectedVersion: FileVersion;
  }): Promise<DocumentExternalChangeStatus>;
}

export interface RestoreActiveFromGitInput {
  sourceRef: string;
  expectedRepoToken: GitRepositoryStateToken;
}

export type GitOperationFailure = GitOperationError;

export type GitSnapshotActionResult =
  | { ok: true; result: GitSnapshotResult }
  | { ok: false; error: unknown };

export type GitRestoreActionResult =
  | { ok: true; result: GitRestoreResult }
  | { ok: false; error: unknown }
  | { ok: false; pendingPrompt: true };
