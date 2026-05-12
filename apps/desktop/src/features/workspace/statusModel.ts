import type { WorkspaceLifecycleState } from './types';

export type WorkspaceStatusTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'muted';

export interface WorkspaceStatusItem {
  kind: string;
  label: string;
  detail: string;
  tone: WorkspaceStatusTone;
  meta?: string;
}

export function getWorkspaceDocumentStatus(
  state: WorkspaceLifecycleState | undefined,
  editorDirty: boolean,
): WorkspaceStatusItem {
  if (!state) {
    return statusItem('unavailable', 'Document unavailable', 'Workspace state is not ready.', 'muted');
  }

  if (state.startupStatus === 'loading') {
    return statusItem('loading', 'Loading workspace', 'Restoring the remembered workspace session.', 'info');
  }

  if (state.startupStatus === 'error') {
    return statusItem(
      'startup-error',
      'Workspace issue',
      state.lastError?.detail ?? 'The workspace could not be restored.',
      'danger',
    );
  }

  if (!state.workspace) {
    return statusItem('no-workspace', 'No workspace', 'Open or create a workspace to begin.', 'muted');
  }

  if (!state.active) {
    return statusItem(
      'no-document',
      'No document',
      `${state.files.length} Markdown file${state.files.length === 1 ? '' : 's'} available.`,
      'muted',
    );
  }

  if (state.saveStatus.kind === 'saving') {
    return statusItem('saving', 'Saving document', 'Writing Markdown changes to disk.', 'info', state.active.snapshot.relativePath);
  }

  if (state.saveStatus.kind === 'unsaved' || editorDirty) {
    return statusItem('dirty', 'Unsaved document', 'Current editor changes have not been saved.', 'warning', state.active.snapshot.relativePath);
  }

  if (state.saveStatus.kind === 'conflict') {
    return statusItem('conflict', 'External edit conflict', 'Resolve the external edit before saving again.', 'danger', state.active.snapshot.relativePath);
  }

  if (state.saveStatus.kind === 'missing') {
    return statusItem('missing', 'Document missing', 'The active file is missing from the workspace.', 'danger', state.active.snapshot.relativePath);
  }

  if (state.saveStatus.kind === 'saveFailed') {
    return statusItem('save-failed', 'Save failed', 'Review the save error and retry.', 'danger', state.active.snapshot.relativePath);
  }

  const diagnosticCount = state.active.markdownDocument.diagnostics.length;
  if (diagnosticCount > 0) {
    return statusItem(
      'diagnostics',
      'Document warnings',
      `${diagnosticCount} Markdown diagnostic${diagnosticCount === 1 ? '' : 's'} need review.`,
      'warning',
      state.active.snapshot.relativePath,
    );
  }

  return statusItem('ready', 'Document ready', 'Latest changes are persisted.', 'success', state.active.snapshot.relativePath);
}

export function getWorkspaceFileIndexStatus(
  state: WorkspaceLifecycleState | undefined,
): WorkspaceStatusItem {
  if (!state?.workspace) {
    return statusItem('idle', 'Index idle', 'Open a workspace to build the Markdown index.', 'muted');
  }

  const fileIndex = state.externalSyncStatus?.fileIndex;
  if (fileIndex) {
    return statusItem(
      fileIndex.kind,
      fileIndexTitle(fileIndex.kind),
      fileIndex.message,
      fileIndexTone(fileIndex.kind),
      `${fileIndex.indexedFileCount} files`,
    );
  }

  const indexedFileCount = state.active?.linkIndex.files.length ?? state.files.length;
  const diagnosticCount = state.active?.linkIndex.diagnostics.length ?? 0;

  if (state.saveStatus.kind === 'conflict' || state.saveStatus.kind === 'missing') {
    return statusItem(
      'stale',
      'Index stale',
      'Refresh workspace files before writing more changes.',
      'warning',
      `${indexedFileCount} files`,
    );
  }

  if (diagnosticCount > 0) {
    return statusItem(
      'degraded',
      'Index diagnostics',
      `${diagnosticCount} link diagnostic${diagnosticCount === 1 ? '' : 's'} need review.`,
      'warning',
      `${indexedFileCount} files`,
    );
  }

  return statusItem(
    'ready',
    'Index ready',
    `${indexedFileCount} Markdown file${indexedFileCount === 1 ? '' : 's'} indexed.`,
    'success',
    `${indexedFileCount} files`,
  );
}

export function getWorkspaceWatchStatus(
  state: WorkspaceLifecycleState | undefined,
): WorkspaceStatusItem {
  if (!state?.workspace) {
    return statusItem('inactive', 'Watcher idle', 'Workspace change detection starts after a workspace opens.', 'muted');
  }

  const watch = state.externalSyncStatus?.watch;
  if (!watch) {
    return statusItem('checking', 'Watcher pending', 'Waiting for desktop workspace change detection.', 'info');
  }

  return statusItem(watch.kind, watchTitle(watch.kind), watch.message, watchTone(watch.kind));
}

function statusItem(
  kind: string,
  label: string,
  detail: string,
  tone: WorkspaceStatusTone,
  meta?: string,
): WorkspaceStatusItem {
  return { kind, label, detail, tone, meta };
}

function fileIndexTitle(kind: NonNullable<WorkspaceLifecycleState['externalSyncStatus']>['fileIndex']['kind']): string {
  switch (kind) {
    case 'idle':
      return 'Index idle';
    case 'building':
      return 'Index building';
    case 'ready':
      return 'Index ready';
    case 'stale':
      return 'Index stale';
    case 'degraded':
      return 'Index diagnostics';
    case 'error':
      return 'Index error';
  }
}

function fileIndexTone(kind: NonNullable<WorkspaceLifecycleState['externalSyncStatus']>['fileIndex']['kind']): WorkspaceStatusTone {
  switch (kind) {
    case 'ready':
      return 'success';
    case 'building':
      return 'info';
    case 'stale':
    case 'degraded':
      return 'warning';
    case 'error':
      return 'danger';
    case 'idle':
      return 'muted';
  }
}

function watchTitle(kind: NonNullable<WorkspaceLifecycleState['externalSyncStatus']>['watch']['kind']): string {
  switch (kind) {
    case 'inactive':
      return 'Watcher idle';
    case 'checking':
      return 'Watcher checking';
    case 'watching':
      return 'Watcher active';
    case 'degraded':
      return 'Watcher degraded';
    case 'error':
      return 'Watcher error';
  }
}

function watchTone(kind: NonNullable<WorkspaceLifecycleState['externalSyncStatus']>['watch']['kind']): WorkspaceStatusTone {
  switch (kind) {
    case 'watching':
      return 'success';
    case 'checking':
      return 'info';
    case 'degraded':
      return 'warning';
    case 'error':
      return 'danger';
    case 'inactive':
      return 'muted';
  }
}
