import {
  FilePlus2,
  FolderOpen,
  Gauge,
  PanelLeftClose,
  PanelRightClose,
  Save,
  Settings,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  createMindMapEditorStore,
  getMindMapNode,
  layoutMindMapDocument,
} from '../../domain/mindMap';
import type { MindMapCommand, MindMapEditorState, MindMapEditorStore } from '../../domain/mindMap';
import {
  AiAssistantPanel,
  AiProviderSettingsPanel,
  useAiProviderSettings,
} from '../../features/ai-assistant';
import type { AiProviderSettingsController, AiSuggestionDraft } from '../../features/ai-assistant';
import {
  createProposalReviewDraftSourceFromAiSuggestionDraft,
  createProposalReviewStore,
  ProposalReviewPanel,
} from '../../features/ai-proposals';
import type {
  ProposalReview,
  ProposalReviewEditorSnapshot,
  ProposalReviewStore,
} from '../../features/ai-proposals';
import { DashboardPage } from '../../features/dashboard';
import { ExportDialog } from '../../features/export';
import { GitWorkflowPanel } from '../../features/git-workflow';
import {
  CompatibilityDiagnosticsPanel,
  resolveWorkspaceLink,
} from '../../features/markdown-compat';
import type { LinkInteractionController } from '../../features/markdown-compat';
import { MindMapCanvas } from '../../features/mindmap/MindMapCanvas';
import { ProjectListPage } from '../../features/projects';
import { SettingsPage } from '../../features/settings';
import type { WorkspaceLifecycleState } from '../../features/workspace';
import type {
  FileVersion,
  WorkspaceRelativePath,
} from '../../types/markdownLifecycle';
import { ActivityBar } from './ActivityBar';
import { CommandPalette } from './CommandPalette';
import { CustomTitleBar } from './CustomTitleBar';
import { DetailPanel } from './DetailPanel';
import { MainContent } from './MainContent';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { Topbar } from './Topbar';
import type {
  CommandPaletteCommand,
  OutlineNodeItem,
  ShellView,
  ShellWorkspaceActions,
  ThemeName,
} from './types';

interface AppShellProps {
  state: MindMapEditorState;
  store?: MindMapEditorStore;
  proposalReviewStore?: ProposalReviewStore;
  aiProviderController?: AiProviderSettingsController;
  workspaceState: WorkspaceLifecycleState;
  workspaceActions: ShellWorkspaceActions;
}

export function AppShell({
  state,
  store: providedStore,
  proposalReviewStore: providedProposalReviewStore,
  aiProviderController: providedAiProviderController,
  workspaceState,
  workspaceActions,
}: AppShellProps) {
  const localStore = useMemo(
    () =>
      createMindMapEditorStore({
        document: state.document,
        selection: state.selection,
        viewport: state.viewport,
        historyLimit: state.history.limit,
      }),
    [state],
  );
  const store = providedStore ?? localStore;
  const localProposalReviewStore = useMemo(() => createProposalReviewStore(), []);
  const proposalReviewStore = providedProposalReviewStore ?? localProposalReviewStore;
  const localAiProviderController = useAiProviderSettings();
  const aiProviderController = providedAiProviderController ?? localAiProviderController;
  const editorState = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const proposalReviewState = useSyncExternalStore(
    proposalReviewStore.subscribe,
    proposalReviewStore.getState,
    proposalReviewStore.getState,
  );
  const [activeView, setActiveView] = useState<ShellView>('map');
  const [theme, setTheme] = useState<ThemeName>(() => getInitialTheme());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailPanelCollapsed, setDetailPanelCollapsed] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [isAiAssistantOpen, setIsAiAssistantOpen] = useState(false);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [isGitSnapshotDialogOpen, setIsGitSnapshotDialogOpen] = useState(false);
  const [markdownPathInput, setMarkdownPathInput] = useState(
    workspaceState.active?.snapshot.relativePath ?? '',
  );

  const dispatch = useCallback(
    (command: MindMapCommand) => {
      return store.dispatch(command);
    },
    [store],
  );
  const { document, selection, viewport } = editorState;
  const selectedNode = getMindMapNode(document, selection.selectedNodeId);
  const layout = useMemo(() => layoutMindMapDocument(document), [document]);
  const visibleOutlineNodes = useMemo<OutlineNodeItem[]>(
    () =>
      workspaceState.active
        ? layout.nodes.slice(0, 80).map((layoutNode) => ({
            id: layoutNode.id,
            text: layoutNode.node.text.trim(),
            depth: layoutNode.depth,
            isRoot: layoutNode.isRoot,
            active: selection.selectedNodeId === layoutNode.id,
          }))
        : [],
    [layout.nodes, selection.selectedNodeId, workspaceState.active],
  );
  const hiddenOutlineCount = workspaceState.active
    ? Math.max(0, layout.nodes.length - visibleOutlineNodes.length)
    : 0;
  const zoomPercent = Math.round(viewport.zoom * 100);
  const activePath = workspaceState.active?.snapshot.relativePath;
  const canOpenAiAssistant = Boolean(workspaceState.workspace && workspaceState.active);
  const titleSubtitle = workspaceState.workspace?.displayPath ?? 'No workspace selected';

  useEffect(() => {
    setMarkdownPathInput(workspaceState.active?.snapshot.relativePath ?? '');
  }, [workspaceState.active?.snapshot.relativePath]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      if (event.key === 'Escape' && commandPaletteOpen) {
        event.preventDefault();
        setCommandPaletteOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen]);

  const beginProposalApply = useCallback(
    (review: ProposalReview) => {
      proposalReviewStore.beginApply(review.reviewId);
    },
    [proposalReviewStore],
  );
  const rejectProposal = useCallback(
    (review: ProposalReview) => {
      void review;
      proposalReviewStore.rejectActive();
    },
    [proposalReviewStore],
  );
  const dismissProposal = useCallback(
    (review: ProposalReview) => {
      void review;
      proposalReviewStore.dismissActive();
    },
    [proposalReviewStore],
  );
  const reviewSuggestionDraft = useCallback(
    (draft: AiSuggestionDraft) => {
      if (!workspaceState.active) {
        return;
      }

      proposalReviewStore.receiveSuggestionDraft(
        createProposalReviewDraftSourceFromAiSuggestionDraft(draft),
        createProposalReviewEditorSnapshot(editorState, workspaceState),
      );
      setIsAiAssistantOpen(false);
      setDetailPanelCollapsed(false);
    },
    [editorState, proposalReviewStore, workspaceState],
  );
  const linkInteraction = useMemo<LinkInteractionController | undefined>(() => {
    if (!workspaceState.workspace || !workspaceState.active) {
      return undefined;
    }

    return {
      workspaceId: workspaceState.workspace.id,
      sourceRelativePath: workspaceState.active.snapshot.relativePath,
      resolveLink: resolveWorkspaceLink,
      openTarget(relativePath) {
        return workspaceActions.requestOpenFile(relativePath);
      },
      createTarget(relativePath) {
        return workspaceActions.requestCreateFile(relativePath);
      },
    };
  }, [workspaceActions, workspaceState.active, workspaceState.workspace]);

  const commandPaletteCommands = useMemo<CommandPaletteCommand[]>(
    () => [
      {
        id: 'view-map',
        label: 'Open mind map',
        detail: activePath ?? 'Main editor surface',
        shortcut: 'M',
        icon: <Workflow size={16} />,
        run: () => setActiveView('map'),
      },
      {
        id: 'view-dashboard',
        label: 'Open dashboard',
        detail: 'Workspace overview and recent files',
        icon: <Gauge size={16} />,
        run: () => setActiveView('dashboard'),
      },
      {
        id: 'view-projects',
        label: 'Open Markdown files',
        detail: 'Browse and create workspace files',
        icon: <FolderOpen size={16} />,
        run: () => setActiveView('projects'),
      },
      {
        id: 'view-settings',
        label: 'Open settings',
        detail: 'Theme and local preferences',
        icon: <Settings size={16} />,
        run: () => setActiveView('settings'),
      },
      {
        id: 'save-markdown',
        label: 'Save Markdown',
        detail: activePath ?? 'No active file',
        shortcut: 'Ctrl S',
        disabled: !activePath,
        icon: <Save size={16} />,
        run: () => {
          void workspaceActions.saveActiveDocument?.();
        },
      },
      {
        id: 'new-markdown',
        label: 'Create Markdown file',
        detail: workspaceState.workspace ? 'Use the sidebar file form' : 'Open a workspace first',
        disabled: !workspaceState.workspace,
        icon: <FilePlus2 size={16} />,
        run: () => {
          setSidebarCollapsed(false);
          setActiveView('projects');
        },
      },
      {
        id: 'toggle-sidebar',
        label: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        icon: <PanelLeftClose size={16} />,
        run: () => setSidebarCollapsed((collapsed) => !collapsed),
      },
      {
        id: 'toggle-details',
        label: detailPanelCollapsed ? 'Expand detail panel' : 'Collapse detail panel',
        icon: <PanelRightClose size={16} />,
        run: () => setDetailPanelCollapsed((collapsed) => !collapsed),
      },
    ],
    [activePath, detailPanelCollapsed, sidebarCollapsed, workspaceActions, workspaceState.workspace],
  );

  const mapView = (
    <div className="map-stage">
      <MindMapCanvas
        state={editorState}
        onCommand={dispatch}
        onUndo={() => store.undo()}
        onRedo={() => store.redo()}
        linkInteraction={linkInteraction}
      />
    </div>
  );

  return (
    <div className="app-shell-root" data-theme={theme}>
      <CustomTitleBar
        title="How to Think"
        subtitle={titleSubtitle}
        isBusy={workspaceState.isBusy}
      />

      <div
        className="app-shell-grid"
        style={{
          gridTemplateColumns: `var(--activitybar-width) ${
            sidebarCollapsed ? '0px' : 'var(--sidebar-width)'
          } minmax(0, 1fr) ${detailPanelCollapsed ? '0px' : 'var(--detail-panel-width)'}`,
        }}
      >
        <ActivityBar
          activeView={activeView}
          sidebarCollapsed={sidebarCollapsed}
          detailPanelCollapsed={detailPanelCollapsed}
          onViewChange={setActiveView}
          onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
          onToggleDetailPanel={() => setDetailPanelCollapsed((collapsed) => !collapsed)}
        />

        <Sidebar
          collapsed={sidebarCollapsed}
          workspaceState={workspaceState}
          workspaceActions={workspaceActions}
          outlineNodes={visibleOutlineNodes}
          hiddenOutlineCount={hiddenOutlineCount}
          onSelectOutlineNode={(nodeId) => dispatch({ type: 'select-node', nodeId })}
          onExpand={() => setSidebarCollapsed(false)}
        />

        <div className="content-shell">
          <Topbar
            activeView={activeView}
            documentTitle={document.title}
            workspace={workspaceState.workspace}
            activePath={activePath}
            saveStatus={workspaceState.saveStatus}
            isBusy={workspaceState.isBusy}
            canOpenAiAssistant={canOpenAiAssistant}
            isAiAssistantOpen={isAiAssistantOpen}
            detailPanelCollapsed={detailPanelCollapsed}
            onOpenCommandPalette={() => setCommandPaletteOpen(true)}
            onSaveMarkdown={() => void workspaceActions.saveActiveDocument?.()}
            onOpenExport={() => setIsExportDialogOpen(true)}
            onToggleAiAssistant={() => setIsAiAssistantOpen((open) => !open)}
            onOpenGitSnapshot={() => {
              setDetailPanelCollapsed(false);
              setIsGitSnapshotDialogOpen(true);
            }}
            onExpandDetailPanel={() => setDetailPanelCollapsed(false)}
          />

          <MainContent
            activeView={activeView}
            startupStatus={workspaceState.startupStatus}
            workspace={workspaceState.workspace}
            activeDocumentAvailable={Boolean(workspaceState.active)}
            lastError={workspaceState.lastError}
            onClearError={workspaceActions.clearError}
            mapView={mapView}
            dashboardView={
              <DashboardPage
                workspaceState={workspaceState}
                onOpenFile={(relativePath) => {
                  setActiveView('map');
                  void workspaceActions.requestOpenFile(relativePath);
                }}
                onViewProjects={() => setActiveView('projects')}
              />
            }
            projectsView={
              <ProjectListPage
                workspaceState={workspaceState}
                onCreateFile={(relativePath) => {
                  setActiveView('map');
                  void workspaceActions.requestCreateFile(relativePath);
                }}
                onOpenFile={(relativePath) => {
                  setActiveView('map');
                  void workspaceActions.requestOpenFile(relativePath);
                }}
                onRefreshFiles={() => void workspaceActions.refreshFiles()}
              />
            }
            settingsView={<SettingsPage theme={theme} onThemeChange={setTheme} />}
          />
        </div>

        <DetailPanel
          collapsed={detailPanelCollapsed}
          onToggleCollapsed={() => setDetailPanelCollapsed((collapsed) => !collapsed)}
        >
          <section className="inspector-section">
            <p className="field-label">Selected node</p>
            <p className="selected-node-title">{selectedNode.text}</p>
            <p>
              {selectedNode.collapsed ? 'Collapsed branch' : 'Expanded branch'} -{' '}
              {selectedNode.childIds.length === 1
                ? '1 child'
                : `${selectedNode.childIds.length} children`}
            </p>
            {selectedNode.childIds.length > 0 ? (
              <button
                className="text-button inspector-action"
                type="button"
                onClick={() =>
                  dispatch({
                    type: selectedNode.collapsed ? 'expand-node' : 'collapse-node',
                    nodeId: selectedNode.id,
                  })
                }
              >
                {selectedNode.collapsed ? 'Expand branch' : 'Collapse branch'}
              </button>
            ) : null}
          </section>

          <section className="inspector-section">
            <p className="field-label">Source</p>
            <dl className="metadata-list">
              <div>
                <dt>Format</dt>
                <dd>Markdown</dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd>{document.sourcePath ?? 'Unsaved'}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{new Date(document.updatedAt).toLocaleString()}</dd>
              </div>
            </dl>
          </section>

          <GitWorkflowPanel
            workspaceState={workspaceState}
            workspaceActions={workspaceActions}
            snapshotDialogOpen={isGitSnapshotDialogOpen}
            onSnapshotDialogOpenChange={setIsGitSnapshotDialogOpen}
          />

          <section className="inspector-section">
            <CompatibilityDiagnosticsPanel
              documentDiagnostics={workspaceState.active?.markdownDocument.diagnostics}
              linkIndex={workspaceState.active?.linkIndex}
              saveStatus={workspaceState.saveStatus}
            />
          </section>

          {workspaceState.active ? (
            <section className="inspector-section">
              <p className="field-label">File actions</p>
              <label className="workspace-path-field">
                <span>Markdown path</span>
                <input
                  value={markdownPathInput}
                  onChange={(event) => setMarkdownPathInput(event.currentTarget.value)}
                />
              </label>
              <div className="workspace-action-row">
                <button
                  className="text-button inspector-action"
                  type="button"
                  disabled={!markdownPathInput.trim() || workspaceState.isBusy}
                  onClick={() =>
                    void workspaceActions.requestRenameActive(
                      markdownPathInput as WorkspaceRelativePath,
                    )
                  }
                >
                  Rename file
                </button>
                <button
                  className="text-button inspector-action"
                  type="button"
                  disabled={workspaceState.isBusy}
                  onClick={() => void workspaceActions.requestDeleteActive()}
                >
                  Delete file
                </button>
              </div>
            </section>
          ) : null}

          <AiProviderSettingsPanel controller={aiProviderController} />

          <ProposalReviewPanel
            review={proposalReviewState.activeReview}
            onAccept={beginProposalApply}
            onReject={rejectProposal}
            onDismiss={dismissProposal}
            onConfirmRiskFlag={(riskFlag, review) =>
              proposalReviewStore.confirmRiskFlag(riskFlag, review.reviewId)
            }
            onClearRiskConfirmation={(riskFlag, review) =>
              proposalReviewStore.clearRiskConfirmation(riskFlag, review.reviewId)
            }
            onConfirmGuardedApply={(token, review) =>
              proposalReviewStore.confirmGuardedApply(token, review.reviewId)
            }
            onClearGuardedApplyConfirmation={(review) =>
              proposalReviewStore.clearGuardedApplyConfirmation(review.reviewId)
            }
          />
        </DetailPanel>
      </div>

      <StatusBar
        visibleNodeCount={layout.visibleNodeIds.length}
        zoomPercent={zoomPercent}
        workspaceName={workspaceState.workspace?.displayName}
        activePath={activePath}
        sidebarCollapsed={sidebarCollapsed}
        detailPanelCollapsed={detailPanelCollapsed}
      />

      <CommandPalette
        open={commandPaletteOpen}
        commands={commandPaletteCommands}
        onClose={() => setCommandPaletteOpen(false)}
      />

      <AiAssistantPanel
        open={isAiAssistantOpen}
        editorState={editorState}
        workspaceState={workspaceState}
        providerController={aiProviderController}
        onReviewSuggestionDraft={reviewSuggestionDraft}
        onClose={() => setIsAiAssistantOpen(false)}
        onOpenProviderSettings={() => {
          setIsAiAssistantOpen(false);
          setDetailPanelCollapsed(false);
        }}
      />

      <ExportDialog
        open={isExportDialogOpen}
        editorState={editorState}
        workspaceState={workspaceState}
        onClose={() => setIsExportDialogOpen(false)}
      />

      {workspaceState.prompt ? (
        <div className="modal-backdrop">
          <div role="dialog" aria-label={workspaceState.prompt.title} className="modal-panel">
            <h2>{workspaceState.prompt.title}</h2>
            <p>{workspaceState.prompt.message}</p>
            <div className="workspace-action-row">
              <button
                className="text-button"
                type="button"
                disabled={workspaceState.prompt.saveDisabled}
                onClick={() => void workspaceActions.savePromptDocument?.()}
              >
                Save
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => void workspaceActions.discardPrompt()}
              >
                Discard
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => workspaceActions.cancelPrompt()}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function getInitialTheme(): ThemeName {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function createProposalReviewEditorSnapshot(
  editorState: MindMapEditorState,
  workspaceState: WorkspaceLifecycleState,
): ProposalReviewEditorSnapshot {
  const activeDocument = workspaceState.active;
  const activeFilePath = activeDocument?.snapshot.relativePath ?? editorState.document.sourcePath ?? 'untitled.md';
  const activeVersion: FileVersion = activeDocument?.snapshot.version ?? {
    token: `editor:${editorState.contentRevision}`,
    modifiedAt: editorState.document.updatedAt,
    byteSize: 0,
    contentHash: `editor:${editorState.contentRevision}`,
  };
  const fileVersions: Record<string, FileVersion> = Object.fromEntries(
    workspaceState.files.map((file) => [file.relativePath, file.version]),
  );
  const markdownBuffer = activeDocument?.snapshot.content ?? '';
  const markdownBuffersByPath: Record<string, string> = {
    [activeFilePath]: markdownBuffer,
  };

  return {
    document: editorState.document,
    markdownBuffer,
    markdownBuffersByPath,
    fileVersion: activeVersion,
    fileVersions: {
      ...fileVersions,
      [activeFilePath]: activeVersion,
    },
    activeFilePath,
    documentVersion: editorState.contentRevision,
    isDirty: editorState.isDirty,
    undoHistory: editorState.history,
    selection: editorState.selection,
    capturedAt: new Date().toISOString(),
  };
}
