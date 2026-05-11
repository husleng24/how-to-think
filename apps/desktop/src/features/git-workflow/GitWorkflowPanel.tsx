import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  GitCommitHorizontal,
  History,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getGitRestoreEligibility,
  getGitSnapshotEligibility,
  gitOperationErrorTitle,
  groupGitStatusEntries,
  isGitOperationAllowed,
} from '../git-service';
import type {
  GitDiffFile,
  GitDiffLine,
  GitDiffResult,
  GitHistoryEntry,
  GitOperationError,
  GitOperationErrorCode,
  GitRepositoryStateToken,
  GitRestoreEligibility,
  GitServiceOperation,
  GitSnapshotResult,
  GitStatusEntry,
  GitStatusSummary,
} from '../git-service';
import type { FileVersion, WorkspaceRelativePath } from '../../types/markdownLifecycle';
import type { WorkspaceLifecycleActions, WorkspaceLifecycleState } from '../workspace';

interface GitWorkflowPanelProps {
  workspaceState?: WorkspaceLifecycleState;
  workspaceActions?: WorkspaceLifecycleActions;
  snapshotDialogOpen?: boolean;
  onSnapshotDialogOpenChange?: (open: boolean) => void;
}

type PendingGitAction = 'enable' | 'refresh' | 'snapshot' | 'history' | 'diff' | 'restore' | null;
type HistoryScope = 'file' | 'workspace';

export function GitWorkflowPanel({
  workspaceState,
  workspaceActions,
  snapshotDialogOpen,
  onSnapshotDialogOpenChange,
}: GitWorkflowPanelProps) {
  const [localSnapshotDialogOpen, setLocalSnapshotDialogOpen] = useState(false);
  const [enableDialogOpen, setEnableDialogOpen] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyScope, setHistoryScope] = useState<HistoryScope>('file');
  const [pendingAction, setPendingAction] = useState<PendingGitAction>(null);
  const [snapshotMessage, setSnapshotMessage] = useState('');
  const [lastSnapshot, setLastSnapshot] = useState<GitSnapshotResult | null>(null);
  const [snapshotError, setSnapshotError] = useState<GitOperationError | null>(null);
  const [historyEntries, setHistoryEntries] = useState<GitHistoryEntry[]>([]);
  const [selectedHistoryEntry, setSelectedHistoryEntry] = useState<GitHistoryEntry | null>(null);
  const [historyError, setHistoryError] = useState<GitOperationError | null>(null);
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [diffError, setDiffError] = useState<GitOperationError | null>(null);
  const [historyRepoToken, setHistoryRepoToken] = useState<GitRepositoryStateToken | null>(null);
  const [historyFileVersion, setHistoryFileVersion] = useState<FileVersion | null>(null);
  const [restoreEntry, setRestoreEntry] = useState<GitHistoryEntry | null>(null);
  const [restoreError, setRestoreError] = useState<GitOperationError | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  const isSnapshotDialogOpen = snapshotDialogOpen ?? localSnapshotDialogOpen;
  const setSnapshotDialogOpen = onSnapshotDialogOpenChange ?? setLocalSnapshotDialogOpen;
  const workspace = workspaceState?.workspace ?? null;
  const status = workspaceState?.gitStatus ?? null;
  const blockedState = workspaceState?.gitBlockedState ?? null;
  const active = workspaceState?.active ?? null;
  const activePath = active?.snapshot.relativePath ?? null;
  const activeFileVersion = active?.snapshot.version ?? null;
  const currentRepoToken = status?.token ?? status?.repositoryState.token ?? null;
  const hasUnsavedEditorChanges = Boolean(
    active && active.contentRevision !== active.savedContentRevision,
  );
  const hasStaleOpenFile =
    workspaceState?.saveStatus.kind === 'conflict' || workspaceState?.saveStatus.kind === 'missing';
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
  const restoreEligibility = useMemo(
    () =>
      getGitRestoreEligibility({
        workspaceId: workspace?.id ?? null,
        activeRelativePath: activePath,
        isFileHistoryScope: historyScope === 'file',
        status,
        blockedState,
        expectedRepoToken: historyRepoToken,
        currentRepoToken,
        expectedFileVersion: historyFileVersion,
        currentFileVersion: activeFileVersion,
        hasUnsavedEditorChanges,
        hasStaleOpenFile,
      }),
    [
      activeFileVersion,
      activePath,
      blockedState,
      currentRepoToken,
      hasStaleOpenFile,
      hasUnsavedEditorChanges,
      historyFileVersion,
      historyRepoToken,
      historyScope,
      status,
      workspace?.id,
    ],
  );
  const repositoryState = status?.repositoryState.state ?? null;
  const isGitNotEnabled = repositoryState === 'not_repository';
  const isBusy = pendingAction !== null || Boolean(workspaceState?.isBusy);
  const canConfirmSnapshot =
    eligibility.canCreateSnapshot && snapshotMessage.trim().length > 0 && pendingAction !== 'snapshot';
  const restoreHardBlockReasons = restoreEligibility.disabledReasons.filter(
    (reason) => reason.code !== 'unsaved_editor_changes',
  );
  const canStartRestore =
    Boolean(selectedHistoryEntry && workspaceActions && currentRepoToken) &&
    restoreHardBlockReasons.length === 0;
  const canConfirmRestore =
    Boolean(restoreEntry && workspaceActions && currentRepoToken) &&
    restoreHardBlockReasons.length === 0 &&
    pendingAction !== 'restore';

  useEffect(() => {
    setSnapshotError(null);
  }, [status?.refreshedAt]);

  const loadDiffForEntry = useCallback(
    async (entry: GitHistoryEntry, scope: HistoryScope = historyScope) => {
      if (!workspace || !workspaceActions) {
        return;
      }

      if (scope === 'file' && !activePath) {
        setDiffResult(null);
        setDiffError(null);
        return;
      }

      if (status && !isGitOperationAllowed(status.repositoryState.state, 'diff')) {
        setDiffResult(null);
        setDiffError(
          gitError(
            status.repositoryState.blockedReason ?? 'unknown_git_error',
            'diff',
            'Git diff is unavailable for this repository state.',
            activePath ?? undefined,
          ),
        );
        return;
      }

      setPendingAction('diff');
      setDiffError(null);

      try {
        const result = await workspaceActions.getGitDiff({
          workspaceId: workspace.id,
          mode: 'working_tree',
          relativePath: scope === 'file' ? activePath : null,
          baseRef: entry.commitOid,
          headRef: null,
        });
        setDiffResult(result);
      } catch (error) {
        setDiffResult(null);
        setDiffError(asGitOperationError(error, 'diff'));
      } finally {
        setPendingAction(null);
      }
    },
    [activePath, historyScope, status, workspace, workspaceActions],
  );

  const loadHistory = useCallback(
    async (scope: HistoryScope = historyScope) => {
      setHistoryRepoToken(currentRepoToken);
      setHistoryFileVersion(activeFileVersion);
      setHistoryError(null);
      setDiffError(null);
      setRestoreError(null);
      setRestoreNotice(null);

      if (!workspace || !workspaceActions) {
        setHistoryEntries([]);
        setSelectedHistoryEntry(null);
        setDiffResult(null);
        return;
      }

      if (scope === 'file' && !activePath) {
        setHistoryEntries([]);
        setSelectedHistoryEntry(null);
        setDiffResult(null);
        return;
      }

      if (!status) {
        setHistoryEntries([]);
        setSelectedHistoryEntry(null);
        setDiffResult(null);
        setHistoryError(
          gitError(
            'not_repository',
            'history',
            'Refresh Git status before loading history.',
            activePath ?? undefined,
          ),
        );
        return;
      }

      if (!isGitOperationAllowed(status.repositoryState.state, 'history')) {
        setHistoryEntries([]);
        setSelectedHistoryEntry(null);
        setDiffResult(null);
        setHistoryError(
          gitError(
            status.repositoryState.blockedReason ?? 'not_repository',
            'history',
            historyBlockedMessage(status.repositoryState.state),
            activePath ?? undefined,
          ),
        );
        return;
      }

      setPendingAction('history');

      try {
        const entries = await workspaceActions.listGitHistory({
          workspaceId: workspace.id,
          relativePath: scope === 'file' ? activePath : null,
          maxEntries: 100,
        });
        const firstEntry = entries[0] ?? null;
        setHistoryEntries([...entries]);
        setSelectedHistoryEntry(firstEntry);

        if (firstEntry) {
          await loadDiffForEntry(firstEntry, scope);
        } else {
          setDiffResult(null);
        }
      } catch (error) {
        setHistoryEntries([]);
        setSelectedHistoryEntry(null);
        setDiffResult(null);
        setHistoryError(asGitOperationError(error, 'history'));
      } finally {
        setPendingAction(null);
      }
    },
    [
      activeFileVersion,
      activePath,
      currentRepoToken,
      historyScope,
      loadDiffForEntry,
      status,
      workspace,
      workspaceActions,
    ],
  );

  useEffect(() => {
    if (!historyDialogOpen) {
      return;
    }

    void loadHistory(historyScope);
  }, [historyDialogOpen, historyScope, loadHistory]);

  const openHistoryDialog = () => {
    setHistoryScope(activePath ? 'file' : 'workspace');
    setHistoryDialogOpen(true);
  };

  const refreshGitStatus = async () => {
    if (!workspaceActions) {
      return;
    }

    setPendingAction('refresh');
    try {
      await workspaceActions.refreshGitState();
      setSnapshotError(null);
      setRestoreError(null);
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
        setSnapshotError(asGitOperationError(result.error, 'snapshot'));
      }
    } finally {
      setPendingAction(null);
    }
  };

  const confirmRestore = async () => {
    if (!workspaceActions || !restoreEntry || !currentRepoToken || !canConfirmRestore) {
      return;
    }

    const sourceRef = restoreEntry.commitOid;
    setPendingAction('restore');
    setRestoreError(null);
    setRestoreNotice(null);

    try {
      const result = await workspaceActions.restoreActiveFromGit({
        sourceRef,
        expectedRepoToken: historyRepoToken ?? currentRepoToken,
      });

      if (result.ok) {
        setRestoreEntry(null);
        setRestoreNotice(`Restored ${activePath ?? 'file'} from ${restoreEntry.shortCommitOid}.`);
        await loadHistory(historyScope);
      } else if ('pendingPrompt' in result) {
        setRestoreEntry(null);
        setRestoreNotice('Resolve unsaved changes to continue restore.');
      } else {
        setRestoreError(asGitOperationError(result.error, 'restore'));
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
          <>
            <button
              className="text-button"
              type="button"
              disabled={!workspace || !workspaceActions}
              onClick={() => setSnapshotDialogOpen(true)}
            >
              <GitCommitHorizontal size={16} />
              Create snapshot
            </button>
            <button
              className="text-button"
              type="button"
              disabled={!workspace || !workspaceActions}
              onClick={openHistoryDialog}
            >
              <History size={16} />
              View history
            </button>
          </>
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

            {snapshotError ? <GitOperationErrorMessage error={snapshotError} /> : null}

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
                <strong>{pluralize(eligibility.eligibleEntries.length, 'affected file')}</strong>
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

      {historyDialogOpen ? (
        <div className="modal-backdrop">
          <div role="dialog" aria-label="Git history" className="git-dialog git-history-dialog">
            <div className="git-dialog-heading">
              <div>
                <p className="field-label">History</p>
                <h2>{historyScope === 'file' && activePath ? activePath : 'Workspace history'}</h2>
              </div>
              <button
                className="icon-button compact"
                type="button"
                aria-label="Close Git history"
                onClick={() => setHistoryDialogOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="git-history-toolbar">
              <div className="segmented-control git-history-scope" aria-label="History scope">
                <label>
                  <input
                    checked={historyScope === 'file'}
                    disabled={!activePath}
                    name="git-history-scope"
                    type="radio"
                    onChange={() => setHistoryScope('file')}
                  />
                  <span>
                    <FileText size={15} />
                    File
                  </span>
                </label>
                <label>
                  <input
                    checked={historyScope === 'workspace'}
                    name="git-history-scope"
                    type="radio"
                    onChange={() => setHistoryScope('workspace')}
                  />
                  <span>
                    <History size={15} />
                    Workspace
                  </span>
                </label>
              </div>
              <button
                className="text-button"
                type="button"
                disabled={pendingAction === 'history' || !workspace}
                onClick={() => void loadHistory(historyScope)}
              >
                <RefreshCw size={16} className={pendingAction === 'history' ? 'spin' : undefined} />
                Refresh
              </button>
            </div>

            {restoreNotice ? (
              <div className="git-panel-message success">
                <CheckCircle2 size={17} aria-hidden="true" />
                <div>
                  <strong>Restore queued</strong>
                  <p>{restoreNotice}</p>
                </div>
              </div>
            ) : null}

            {historyError ? <GitOperationErrorMessage error={historyError} /> : null}

            <div className="git-history-layout">
              <section className="git-history-list-panel" aria-label="History entries">
                {pendingAction === 'history' ? (
                  <p className="git-panel-note">Loading history.</p>
                ) : null}

                {!historyError && pendingAction !== 'history' && historyEntries.length === 0 ? (
                  <p className="git-panel-note">
                    {historyScope === 'file' && !activePath
                      ? 'Open a Markdown file to view file history.'
                      : 'No Git history found.'}
                  </p>
                ) : null}

                {historyEntries.length > 0 ? (
                  <div className="git-history-list">
                    {historyEntries.map((entry) => (
                      <button
                        aria-pressed={selectedHistoryEntry?.commitOid === entry.commitOid}
                        className={`git-history-entry${
                          selectedHistoryEntry?.commitOid === entry.commitOid ? ' active' : ''
                        }`}
                        key={entry.commitOid}
                        type="button"
                        onClick={() => {
                          setSelectedHistoryEntry(entry);
                          setRestoreError(null);
                          setRestoreNotice(null);
                          void loadDiffForEntry(entry, historyScope);
                        }}
                      >
                        <span className="git-history-entry-oid">{entry.shortCommitOid}</span>
                        <strong>{entry.subject || 'Untitled snapshot'}</strong>
                        <span>{formatHistoryTimestamp(entry.authoredAt)}</span>
                        <span>{formatHistoryAuthor(entry)}</span>
                        <span>{pluralize(entry.affectedFileCount, 'affected file')}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </section>

              <section className="git-diff-panel" aria-label="Selected Git diff">
                {pendingAction === 'diff' ? (
                  <p className="git-panel-note">Loading diff.</p>
                ) : null}

                {diffError ? <GitOperationErrorMessage error={diffError} /> : null}

                {!selectedHistoryEntry && !diffError ? (
                  <p className="git-panel-note">Select a history entry to inspect its diff.</p>
                ) : null}

                {selectedHistoryEntry && !diffError ? (
                  <div className="git-diff-heading">
                    <div>
                      <p className="field-label">Compare</p>
                      <h3>{selectedHistoryEntry.shortCommitOid} to current workspace</h3>
                    </div>
                    {historyScope === 'file' ? (
                      <button
                        className="text-button"
                        type="button"
                        disabled={!canStartRestore}
                        onClick={() => {
                          setRestoreEntry(selectedHistoryEntry);
                          setRestoreError(null);
                        }}
                      >
                        <RotateCcw size={16} />
                        Restore...
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {historyScope === 'file' && selectedHistoryEntry ? (
                  <RestoreEligibilityMessages eligibility={restoreEligibility} />
                ) : null}

                {diffResult && !diffError ? <GitDiffViewer diff={diffResult} /> : null}
              </section>
            </div>
          </div>
        </div>
      ) : null}

      {restoreEntry ? (
        <div className="modal-backdrop">
          <div role="dialog" aria-label="Restore from Git history" className="git-dialog">
            <div className="git-dialog-heading">
              <div>
                <p className="field-label">Restore</p>
                <h2>Restore {activePath ?? 'file'}</h2>
              </div>
              <button
                className="icon-button compact"
                type="button"
                aria-label="Close restore dialog"
                onClick={() => setRestoreEntry(null)}
              >
                <X size={16} />
              </button>
            </div>
            <p>
              Restore {activePath ?? 'the active file'} from {restoreEntry.shortCommitOid}. The
              restored Markdown will become a new uncommitted workspace change.
            </p>

            {restoreError ? <GitOperationErrorMessage error={restoreError} /> : null}
            <RestoreEligibilityMessages eligibility={restoreEligibility} />

            <div className="workspace-action-row git-dialog-actions">
              <button
                className="text-button"
                type="button"
                disabled={!canConfirmRestore}
                onClick={() => void confirmRestore()}
              >
                {pendingAction === 'restore' ? 'Restoring...' : 'Confirm restore'}
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
                onClick={() => setRestoreEntry(null)}
              >
                Cancel
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

function GitOperationErrorMessage({ error }: { error: GitOperationError }) {
  return (
    <div className="git-panel-message warning">
      <AlertTriangle size={17} aria-hidden="true" />
      <div>
        <strong>{gitOperationErrorTitle(error.code)}</strong>
        <p>{error.message}</p>
      </div>
    </div>
  );
}

function RestoreEligibilityMessages({ eligibility }: { eligibility: GitRestoreEligibility }) {
  if (eligibility.disabledReasons.length === 0) {
    return null;
  }

  return (
    <div className="git-disabled-reasons">
      {eligibility.disabledReasons.map((reason) => (
        <span key={`${reason.code}:${reason.message}`}>{reason.message}</span>
      ))}
    </div>
  );
}

function GitDiffViewer({ diff }: { diff: GitDiffResult }) {
  return (
    <div className="git-diff-viewer">
      <dl className="git-diff-summary">
        <div>
          <dt>Files</dt>
          <dd>{diff.fileCount}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>+{diff.additions}</dd>
        </div>
        <div>
          <dt>Deleted</dt>
          <dd>-{diff.deletions}</dd>
        </div>
      </dl>

      {diff.truncation.isTruncated ? (
        <div className="git-panel-message warning">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>Diff truncated</strong>
            <p>
              Showing {diff.truncation.includedLineCount} lines and{' '}
              {diff.truncation.includedFileCount} files. Omitted{' '}
              {diff.truncation.omittedLineCount} lines and {diff.truncation.omittedFileCount} files.
            </p>
          </div>
        </div>
      ) : null}

      {diff.files.length === 0 ? (
        <p className="git-panel-note">No differences from the selected snapshot.</p>
      ) : (
        <div className="git-diff-files">
          {diff.files.map((file) => (
            <GitDiffFileView file={file} key={`${file.previousRelativePath ?? ''}:${file.relativePath}`} />
          ))}
        </div>
      )}
    </div>
  );
}

function GitDiffFileView({ file }: { file: GitDiffFile }) {
  return (
    <article className="git-diff-file">
      <header className="git-diff-file-heading">
        <div>
          <span className={`git-diff-change is-${file.change}`}>{formatDiffChange(file.change)}</span>
          <strong>{file.relativePath}</strong>
          {file.previousRelativePath ? (
            <em>
              {file.previousRelativePath}
              {' -> '}
              {file.relativePath}
            </em>
          ) : null}
        </div>
        <span>
          +{file.additions} / -{file.deletions}
        </span>
      </header>

      {file.contentKind === 'binary' || file.isBinary ? (
        <p className="git-panel-note">Binary file changed. Text restore preview is unavailable.</p>
      ) : null}

      {file.contentKind === 'unsupported_resource' ? (
        <p className="git-panel-note">Resource file changed. This view does not render resource content.</p>
      ) : null}

      {file.truncated ? <p className="git-validation-message">File diff truncated.</p> : null}

      {file.hunks.length === 0 && file.contentKind === 'text' ? (
        <p className="git-panel-note">No text hunks returned for this file.</p>
      ) : null}

      {file.hunks.map((hunk) => (
        <div
          className="git-diff-hunk"
          key={`${file.relativePath}:${hunk.oldStart}:${hunk.newStart}:${hunk.sectionHeader ?? ''}`}
        >
          <div className="git-diff-hunk-heading">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            {hunk.sectionHeader ? <span>{hunk.sectionHeader}</span> : null}
          </div>
          <div className="git-diff-lines">
            {hunk.lines.map((line, index) => (
              <GitDiffLineView
                line={line}
                key={`${line.kind}:${line.oldLineNumber ?? ''}:${line.newLineNumber ?? ''}:${index}`}
              />
            ))}
          </div>
        </div>
      ))}
    </article>
  );
}

function GitDiffLineView({ line }: { line: GitDiffLine }) {
  return (
    <div className={`git-diff-line is-${line.kind}`}>
      <span>{line.oldLineNumber ?? ''}</span>
      <span>{line.newLineNumber ?? ''}</span>
      <code>
        <span aria-hidden="true">{diffLineMarker(line.kind)}</span>
        {line.content}
      </code>
    </div>
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

function formatHistoryTimestamp(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatHistoryAuthor(entry: GitHistoryEntry): string {
  return entry.authorName.trim() || entry.authorEmail.trim() || 'Unknown author';
}

function formatDiffChange(change: GitDiffFile['change']): string {
  switch (change) {
    case 'added':
      return 'Added';
    case 'modified':
      return 'Modified';
    case 'deleted':
      return 'Deleted';
    case 'renamed':
      return 'Renamed';
    case 'copied':
      return 'Copied';
  }
}

function diffLineMarker(kind: GitDiffLine['kind']): string {
  if (kind === 'addition') {
    return '+';
  }

  if (kind === 'deletion') {
    return '-';
  }

  return ' ';
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${singular}s`;
}

function historyBlockedMessage(state: GitStatusSummary['repositoryState']['state']): string {
  if (state === 'not_repository') {
    return 'Enable Git before viewing history.';
  }

  if (state === 'git_unavailable') {
    return 'Git is unavailable for this workspace.';
  }

  if (state === 'repository_corrupt' || state === 'bare_repository') {
    return 'The Git repository metadata cannot be read safely.';
  }

  if (state === 'permission_denied') {
    return 'The repository cannot be read with current permissions.';
  }

  return 'Git history is unavailable for this repository state.';
}

function gitError(
  code: GitOperationErrorCode,
  operation: GitServiceOperation,
  message: string,
  relativePath?: WorkspaceRelativePath,
): GitOperationError {
  return {
    code,
    operation,
    message,
    recoverable: true,
    relativePath,
  };
}

function asGitOperationError(error: unknown, fallbackOperation: GitServiceOperation): GitOperationError {
  if (!error || typeof error !== 'object') {
    return gitError('unknown_git_error', fallbackOperation, 'Git action failed.');
  }

  const candidate = error as Partial<GitOperationError>;

  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') {
    return gitError('unknown_git_error', fallbackOperation, 'Git action failed.');
  }

  return {
    code: candidate.code as GitOperationErrorCode,
    operation: isGitServiceOperation(candidate.operation) ? candidate.operation : fallbackOperation,
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
