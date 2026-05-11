import {
  AlertTriangle,
  CheckCircle2,
  GitCommitHorizontal,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  getGitSnapshotEligibility,
  gitOperationErrorTitle,
  groupGitStatusEntries,
} from '../git-service';
import type {
  GitOperationError,
  GitOperationErrorCode,
  GitServiceOperation,
  GitSnapshotResult,
  GitStatusEntry,
  GitStatusSummary,
} from '../git-service';
import type { WorkspaceLifecycleActions, WorkspaceLifecycleState } from '../workspace';

interface GitWorkflowPanelProps {
  workspaceState?: WorkspaceLifecycleState;
  workspaceActions?: WorkspaceLifecycleActions;
  snapshotDialogOpen?: boolean;
  onSnapshotDialogOpenChange?: (open: boolean) => void;
}

type PendingGitAction = 'enable' | 'refresh' | 'snapshot' | null;

export function GitWorkflowPanel({
  workspaceState,
  workspaceActions,
  snapshotDialogOpen,
  onSnapshotDialogOpenChange,
}: GitWorkflowPanelProps) {
  const [localSnapshotDialogOpen, setLocalSnapshotDialogOpen] = useState(false);
  const [enableDialogOpen, setEnableDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingGitAction>(null);
  const [snapshotMessage, setSnapshotMessage] = useState('');
  const [lastSnapshot, setLastSnapshot] = useState<GitSnapshotResult | null>(null);
  const [snapshotError, setSnapshotError] = useState<GitOperationError | null>(null);

  const isSnapshotDialogOpen = snapshotDialogOpen ?? localSnapshotDialogOpen;
  const setSnapshotDialogOpen = onSnapshotDialogOpenChange ?? setLocalSnapshotDialogOpen;
  const workspace = workspaceState?.workspace ?? null;
  const status = workspaceState?.gitStatus ?? null;
  const blockedState = workspaceState?.gitBlockedState ?? null;
  const active = workspaceState?.active ?? null;
  const hasUnsavedEditorChanges = Boolean(
    active && active.contentRevision !== active.savedContentRevision,
  );
  const statusGroups = useMemo(
    () => groupGitStatusEntries(status?.entries ?? []),
    [status?.entries],
  );
  const eligibility = useMemo(
    () =>
      getGitSnapshotEligibility({
        workspaceId: workspace?.id ?? null,
        status,
        blockedState,
        hasUnsavedEditorChanges,
      }),
    [blockedState, hasUnsavedEditorChanges, status, workspace?.id],
  );
  const repositoryState = status?.repositoryState.state ?? null;
  const isGitNotEnabled = repositoryState === 'not_repository';
  const isBusy = pendingAction !== null || Boolean(workspaceState?.isBusy);
  const canConfirmSnapshot =
    eligibility.canCreateSnapshot && snapshotMessage.trim().length > 0 && pendingAction !== 'snapshot';

  useEffect(() => {
    setSnapshotError(null);
  }, [status?.refreshedAt]);

  const refreshGitStatus = async () => {
    if (!workspaceActions) {
      return;
    }

    setPendingAction('refresh');
    try {
      await workspaceActions.refreshGitState();
      setSnapshotError(null);
    } finally {
      setPendingAction(null);
    }
  };

  const enableGit = async () => {
    if (!workspaceActions) {
      return;
    }

    setPendingAction('enable');
    try {
      const enabled = await workspaceActions.enableGit();

      if (enabled) {
        setEnableDialogOpen(false);
      }
    } finally {
      setPendingAction(null);
    }
  };

  const createSnapshot = async () => {
    if (!workspaceActions || !canConfirmSnapshot) {
      return;
    }

    setPendingAction('snapshot');
    setSnapshotError(null);

    try {
      const result = await workspaceActions.createGitSnapshot(snapshotMessage);

      if (result.ok) {
        setLastSnapshot(result.result);
        setSnapshotMessage('');
      } else {
        setSnapshotError(asGitOperationError(result.error));
      }
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <section className="inspector-section git-workflow-panel" aria-label="Git status">
      <div className="git-panel-heading">
        <div>
          <p className="field-label">Git</p>
          <p className="git-state-title">{gitStateTitle(status, blockedState != null)}</p>
        </div>
        <button
          className="icon-button compact"
          type="button"
          aria-label="Refresh Git status"
          title="Refresh Git status"
          disabled={!workspace || pendingAction === 'refresh'}
          onClick={() => void refreshGitStatus()}
        >
          <RefreshCw size={16} className={pendingAction === 'refresh' ? 'spin' : undefined} />
        </button>
      </div>

      {!workspace ? <p className="git-panel-note">Open a workspace to use local Git snapshots.</p> : null}

      {workspace && !status ? (
        <p className="git-panel-note">Checking local repository status.</p>
      ) : null}

      {workspace && isGitNotEnabled ? (
        <div className="git-panel-message">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>Git is off for this workspace</strong>
            <p>Enable Git to create local version snapshots. Existing file contents are preserved.</p>
          </div>
        </div>
      ) : null}

      {blockedState ? (
        <div className="git-panel-message warning">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>{blockedState.title}</strong>
            <p>{blockedState.detail}</p>
          </div>
        </div>
      ) : null}

      {hasUnsavedEditorChanges ? (
        <div className="git-panel-message warning">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>Unsaved editor changes</strong>
            <p>Save Markdown before snapshotting so the current editor content is included.</p>
          </div>
        </div>
      ) : null}

      {lastSnapshot ? (
        <div className="git-panel-message success">
          <CheckCircle2 size={17} aria-hidden="true" />
          <div>
            <strong>Snapshot {lastSnapshot.shortCommitOid} created</strong>
            <p>{lastSnapshot.message}</p>
          </div>
        </div>
      ) : null}

      {status ? <GitStatusSummaryView status={status} /> : null}

      {statusGroups.length > 0 ? (
        <div className="git-status-groups">
          {statusGroups.map((group) => (
            <div className="git-status-group" key={group.kind}>
              <h3>{group.title}</h3>
              <ul>
                {group.entries.map((entry) => (
                  <li key={`${group.kind}:${entry.previousRelativePath ?? ''}:${entry.relativePath}`}>
                    {formatStatusEntry(entry)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : status && repositoryState !== 'not_repository' ? (
        <p className="git-panel-note">No workspace changes.</p>
      ) : null}

      {eligibility.disabledReasons.length > 0 && !isGitNotEnabled ? (
        <div className="git-disabled-reasons">
          {eligibility.disabledReasons.map((reason) => (
            <span key={`${reason.code}:${reason.message}`}>{reason.message}</span>
          ))}
        </div>
      ) : null}

      <div className="workspace-action-row git-action-row">
        {isGitNotEnabled ? (
          <button
            className="text-button"
            type="button"
            disabled={isBusy || !workspaceActions}
            onClick={() => setEnableDialogOpen(true)}
          >
            Enable Git
          </button>
        ) : (
          <button
            className="text-button"
            type="button"
            disabled={!workspace || !workspaceActions}
            onClick={() => setSnapshotDialogOpen(true)}
          >
            <GitCommitHorizontal size={16} />
            Create snapshot
          </button>
        )}
      </div>

      {enableDialogOpen ? (
        <div className="modal-backdrop">
          <div role="dialog" aria-label="Enable Git" className="git-dialog">
            <div className="git-dialog-heading">
              <div>
                <p className="field-label">Enable Git</p>
                <h2>Create local repository</h2>
              </div>
              <button
                className="icon-button compact"
                type="button"
                aria-label="Close enable Git dialog"
                onClick={() => setEnableDialogOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <p>
              Existing file contents will not be changed. A local repository will be created for
              this workspace so snapshots can be saved on this device.
            </p>
            <div className="workspace-action-row git-dialog-actions">
              <button
                className="text-button"
                type="button"
                disabled={pendingAction === 'enable'}
                onClick={() => void enableGit()}
              >
                Confirm enable Git
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => setEnableDialogOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isSnapshotDialogOpen ? (
        <div className="modal-backdrop">
          <div role="dialog" aria-label="Create Git snapshot" className="git-dialog">
            <div className="git-dialog-heading">
              <div>
                <p className="field-label">Snapshot</p>
                <h2>Create local version snapshot</h2>
              </div>
              <button
                className="icon-button compact"
                type="button"
                aria-label="Close snapshot dialog"
                onClick={() => setSnapshotDialogOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            {lastSnapshot ? (
              <div className="git-panel-message success">
                <CheckCircle2 size={17} aria-hidden="true" />
                <div>
                  <strong>Snapshot {lastSnapshot.shortCommitOid} created</strong>
                  <p>{lastSnapshot.message}</p>
                </div>
              </div>
            ) : null}

            {snapshotError ? (
              <div className="git-panel-message warning">
                <AlertTriangle size={17} aria-hidden="true" />
                <div>
                  <strong>{gitOperationErrorTitle(snapshotError.code)}</strong>
                  <p>{snapshotError.message}</p>
                </div>
              </div>
            ) : null}

            {eligibility.disabledReasons.length > 0 ? (
              <div className="git-disabled-reasons">
                {eligibility.disabledReasons.map((reason) => (
                  <span key={`${reason.code}:${reason.message}`}>{reason.message}</span>
                ))}
              </div>
            ) : null}

            <label className="workspace-path-field git-message-field">
              <span>Snapshot message</span>
              <textarea
                value={snapshotMessage}
                placeholder="Describe what changed"
                rows={3}
                onChange={(event) => setSnapshotMessage(event.target.value)}
              />
            </label>
            {snapshotMessage.trim().length === 0 ? (
              <p className="git-validation-message">Snapshot message is required.</p>
            ) : null}

            {eligibility.eligibleEntries.length > 0 ? (
              <div className="git-affected-summary">
                <strong>
                  {eligibility.eligibleEntries.length === 1
                    ? '1 affected file'
                    : `${eligibility.eligibleEntries.length} affected files`}
                </strong>
                <ul>
                  {eligibility.eligibleEntries.slice(0, 6).map((entry) => (
                    <li key={`affected:${entry.previousRelativePath ?? ''}:${entry.relativePath}`}>
                      {formatStatusEntry(entry)}
                    </li>
                  ))}
                </ul>
                {eligibility.eligibleEntries.length > 6 ? (
                  <span>{eligibility.eligibleEntries.length - 6} more files</span>
                ) : null}
              </div>
            ) : null}

            {hasUnsavedEditorChanges ? (
              <p className="git-panel-note">
                Unsaved editor content is not included until it is saved through the Markdown file
                lifecycle.
              </p>
            ) : null}

            <div className="workspace-action-row git-dialog-actions">
              <button
                className="text-button"
                type="button"
                disabled={!canConfirmSnapshot}
                onClick={() => void createSnapshot()}
              >
                {pendingAction === 'snapshot' ? 'Creating...' : 'Confirm snapshot'}
              </button>
              <button
                className="text-button"
                type="button"
                disabled={pendingAction === 'refresh'}
                onClick={() => void refreshGitStatus()}
              >
                Refresh Git status
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => setSnapshotDialogOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GitStatusSummaryView({ status }: { status: GitStatusSummary }) {
  if (status.repositoryState.state === 'not_repository') {
    return null;
  }

  const changedCount = status.changedFileCount;
  const untrackedCount = status.untrackedFileCount;

  return (
    <dl className="git-summary-list">
      <div>
        <dt>Status</dt>
        <dd>{changedCount === 0 ? 'Clean' : `${changedCount} changed`}</dd>
      </div>
      <div>
        <dt>Untracked</dt>
        <dd>{untrackedCount}</dd>
      </div>
    </dl>
  );
}

function gitStateTitle(status: GitStatusSummary | null, hasBlockedState: boolean): string {
  if (hasBlockedState) {
    return 'Attention needed';
  }

  if (!status) {
    return 'Checking status';
  }

  if (status.repositoryState.state === 'not_repository') {
    return 'Git is off';
  }

  return status.hasChanges ? 'Workspace changes' : 'Clean';
}

function formatStatusEntry(entry: GitStatusEntry): string {
  return entry.previousRelativePath
    ? `${entry.previousRelativePath} -> ${entry.relativePath}`
    : entry.relativePath;
}

function asGitOperationError(error: unknown): GitOperationError | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as Partial<GitOperationError>;

  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') {
    return null;
  }

  return {
    code: candidate.code as GitOperationErrorCode,
    operation: isGitServiceOperation(candidate.operation) ? candidate.operation : 'snapshot',
    message: candidate.message,
    recoverable: Boolean(candidate.recoverable),
    relativePath:
      typeof candidate.relativePath === 'string' ? candidate.relativePath : undefined,
    details:
      candidate.details && typeof candidate.details === 'object'
        ? candidate.details as GitOperationError['details']
        : undefined,
  };
}

function isGitServiceOperation(value: unknown): value is GitServiceOperation {
  return (
    value === 'detect' ||
    value === 'init' ||
    value === 'status' ||
    value === 'snapshot' ||
    value === 'history' ||
    value === 'diff' ||
    value === 'restore' ||
    value === 'refresh'
  );
}
