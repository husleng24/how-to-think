import {
  Bot,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Save,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  createMindMapEditorStore,
  getMindMapNode,
  layoutMindMapDocument,
} from '../domain/mindMap';
import type { MindMapCommand, MindMapEditorState, MindMapEditorStore } from '../domain/mindMap';
import {
  AiAssistantPanel,
  AiProviderSettingsPanel,
  useAiProviderSettings,
} from '../features/ai-assistant';
import type { AiProviderSettingsController, AiSuggestionDraft } from '../features/ai-assistant';
import {
  createProposalReviewDraftSourceFromAiSuggestionDraft,
  createProposalReviewStore,
  ProposalReviewPanel,
} from '../features/ai-proposals';
import type {
  ProposalReview,
  ProposalReviewEditorSnapshot,
  ProposalReviewStore,
} from '../features/ai-proposals';
import {
  CompatibilityDiagnosticsPanel,
  resolveWorkspaceLink,
} from '../features/markdown-compat';
import type { LinkInteractionController } from '../features/markdown-compat';
import { MindMapCanvas } from '../features/mindmap/MindMapCanvas';
import type { WorkspaceLifecycleActions, WorkspaceLifecycleState } from '../features/workspace';

interface EditorShellProps {
  state: MindMapEditorState;
  store?: MindMapEditorStore;
  proposalReviewStore?: ProposalReviewStore;
  aiProviderController?: AiProviderSettingsController;
  workspaceState?: WorkspaceLifecycleState;
  workspaceActions?: WorkspaceLifecycleActions & {
    saveActiveDocument?: () => Promise<boolean>;
    savePromptDocument?: () => Promise<void>;
  };
}

const outlineSections = ['Local Markdown', 'AI Drafts', 'Git History'];

export function EditorShell({
  state,
  store: providedStore,
  proposalReviewStore: providedProposalReviewStore,
  aiProviderController: providedAiProviderController,
  workspaceState,
  workspaceActions,
}: EditorShellProps) {
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
  const dispatch = useCallback(
    (command: MindMapCommand) => {
      return store.dispatch(command);
    },
    [store],
  );
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

  const { document, selection, viewport, isDirty } = editorState;
  const selectedNode = getMindMapNode(document, selection.selectedNodeId);
  const layout = useMemo(() => layoutMindMapDocument(document), [document]);
  const aiProviderSetupState = aiProviderController.setupState;
  const [workspacePathInput, setWorkspacePathInput] = useState(
    workspaceState?.workspace?.displayPath ?? '',
  );
  const [isAiAssistantOpen, setIsAiAssistantOpen] = useState(false);
  const [newMarkdownPath, setNewMarkdownPath] = useState('');
  const [markdownPathInput, setMarkdownPathInput] = useState(
    workspaceState?.active?.snapshot.relativePath ?? '',
  );
  const reviewSuggestionDraft = useCallback(
    (draft: AiSuggestionDraft) => {
      if (!workspaceState?.active) {
        return;
      }

      proposalReviewStore.receiveSuggestionDraft(
        createProposalReviewDraftSourceFromAiSuggestionDraft(draft),
        createProposalReviewEditorSnapshot(editorState, workspaceState),
      );
      setIsAiAssistantOpen(false);
    },
    [editorState, proposalReviewStore, workspaceState],
  );
  const visibleOutlineNodes = layout.nodes.slice(0, 80);
  const hiddenOutlineCount = Math.max(0, layout.nodes.length - visibleOutlineNodes.length);
  const zoomPercent = Math.round(viewport.zoom * 100);
  const trimmedWorkspacePath = workspacePathInput.trim();
  const trimmedNewMarkdownPath = newMarkdownPath.trim();
  const canOpenAiAssistant = Boolean(workspaceState?.workspace && workspaceState.active);
  const linkInteraction = useMemo<LinkInteractionController | undefined>(() => {
    if (!workspaceState?.workspace || !workspaceState.active || !workspaceActions) {
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
  }, [workspaceActions, workspaceState?.active, workspaceState?.workspace]);

  useEffect(() => {
    setWorkspacePathInput(workspaceState?.workspace?.displayPath ?? '');
  }, [workspaceState?.workspace?.displayPath]);

  useEffect(() => {
    setMarkdownPathInput(workspaceState?.active?.snapshot.relativePath ?? '');
  }, [workspaceState?.active?.snapshot.relativePath]);

  return (
    <div className="app-root">
      <header className="top-bar">
        <div className="brand-block">
          <span className="product-mark" aria-hidden="true">
            HT
          </span>
          <div>
            <p className="eyebrow">How to Think</p>
            <h1>{document.title}</h1>
          </div>
        </div>

        <div className="command-bar" aria-label="Document actions">
          <button
            className="icon-button"
            type="button"
            aria-label="New mind map"
            title="New mind map"
            disabled={!workspaceState?.workspace}
          >
            <FilePlus2 size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Open Markdown"
            title="Open Markdown"
            disabled={!workspaceState?.workspace}
          >
            <FolderOpen size={18} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Save Markdown"
            title="Save Markdown"
            disabled={!workspaceState?.active}
            onClick={() => void workspaceActions?.saveActiveDocument?.()}
          >
            <Save size={18} />
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <button
            className="text-button"
            type="button"
            aria-label={
              canOpenAiAssistant
                ? isAiAssistantOpen
                  ? 'Close AI assistant'
                  : 'Open AI assistant'
                : 'AI unavailable'
            }
            disabled={!canOpenAiAssistant}
            title={canOpenAiAssistant ? aiProviderSetupState.nextAction : 'Open a Markdown file first.'}
            onClick={() => setIsAiAssistantOpen((open) => !open)}
          >
            <Bot size={17} />
            AI
          </button>
          <button className="text-button" type="button">
            <GitBranch size={17} />
            Git
          </button>
        </div>
      </header>

      <div className="workspace-grid">
        <aside className="side-panel outline-panel" aria-label="Document outline">
          <div className="panel-heading">
            <p className="panel-kicker">Outline</p>
          </div>

          <label className="workspace-path-field">
            <span>Workspace path</span>
            <input
              value={workspacePathInput}
              placeholder="No workspace selected"
              onChange={(event) => setWorkspacePathInput(event.target.value)}
            />
          </label>

          <div className="workspace-action-row">
            <button
              className="text-button"
              type="button"
              disabled={!trimmedWorkspacePath || workspaceState?.isBusy}
              onClick={() => void workspaceActions?.openWorkspace(trimmedWorkspacePath)}
            >
              Open workspace
            </button>
            <button
              className="text-button"
              type="button"
              disabled={!trimmedWorkspacePath || workspaceState?.isBusy}
              onClick={() => void workspaceActions?.createWorkspace(trimmedWorkspacePath)}
            >
              Create workspace
            </button>
          </div>

          {workspaceState?.workspace ? (
            <section className="workspace-file-tools" aria-label="Workspace files">
              <p className="panel-kicker">{workspaceState.workspace.displayName}</p>
              <label className="workspace-path-field">
                <span>New Markdown path</span>
                <input
                  value={newMarkdownPath}
                  placeholder="ideas.md"
                  onChange={(event) => setNewMarkdownPath(event.target.value)}
                />
              </label>
              <button
                className="text-button"
                type="button"
                disabled={!trimmedNewMarkdownPath || workspaceState.isBusy}
                onClick={() => {
                  void workspaceActions?.requestCreateFile(trimmedNewMarkdownPath);
                  setNewMarkdownPath('');
                }}
              >
                Create Markdown file
              </button>

              {workspaceState.files.length > 0 ? (
                <div className="workspace-file-list">
                  {workspaceState.files.map((file) => (
                    <button
                      className="outline-section"
                      type="button"
                      key={file.relativePath}
                      onClick={() => void workspaceActions?.requestOpenFile(file.relativePath)}
                    >
                      {file.relativePath}
                    </button>
                  ))}
                </div>
              ) : (
                <p>No Markdown files yet.</p>
              )}
            </section>
          ) : null}

          <nav className="outline-tree" aria-label="Mind map nodes">
            {visibleOutlineNodes.map((layoutNode) => (
              <button
                className={`outline-node${selection.selectedNodeId === layoutNode.id ? ' active' : ''}`}
                style={{ paddingLeft: 10 + Math.min(layoutNode.depth, 5) * 14 }}
                type="button"
                key={layoutNode.id}
                onClick={() => dispatch({ type: 'select-node', nodeId: layoutNode.id })}
              >
                <span className={`node-dot${layoutNode.isRoot ? '' : ' muted'}`} aria-hidden="true" />
                {layoutNode.node.text.trim() || 'Empty thought'}
              </button>
            ))}
            {hiddenOutlineCount > 0 ? (
              <span className="outline-overflow">+{hiddenOutlineCount} more visible nodes</span>
            ) : null}
          </nav>

          <div className="outline-sections" aria-label="Work areas">
            {outlineSections.map((section) => (
              <button className="outline-section" type="button" key={section}>
                {section}
              </button>
            ))}
          </div>
        </aside>

        <main className="canvas-region" aria-label="Mind map editor">
          <MindMapCanvas
            state={editorState}
            onCommand={dispatch}
            onUndo={() => store.undo()}
            onRedo={() => store.redo()}
            linkInteraction={linkInteraction}
          />
        </main>

        <aside className="side-panel inspector-panel" aria-label="Node inspector">
          <div className="panel-heading">
            <p className="panel-kicker">Inspector</p>
          </div>

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

          <section className="inspector-section">
            <CompatibilityDiagnosticsPanel
              documentDiagnostics={workspaceState?.active?.markdownDocument.diagnostics}
              linkIndex={workspaceState?.active?.linkIndex}
              saveStatus={workspaceState?.saveStatus}
            />
          </section>

          {workspaceState?.active ? (
            <section className="inspector-section">
              <p className="field-label">File actions</p>
              <label className="workspace-path-field">
                <span>Markdown path</span>
                <input
                  value={markdownPathInput}
                  onChange={(event) => setMarkdownPathInput(event.target.value)}
                />
              </label>
              <div className="workspace-action-row">
                <button
                  className="text-button inspector-action"
                  type="button"
                  disabled={!markdownPathInput.trim() || workspaceState.isBusy}
                  onClick={() => void workspaceActions?.requestRenameActive(markdownPathInput)}
                >
                  Rename file
                </button>
                <button
                  className="text-button inspector-action"
                  type="button"
                  disabled={workspaceState.isBusy}
                  onClick={() => void workspaceActions?.requestDeleteActive()}
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
          />
        </aside>
      </div>

      <AiAssistantPanel
        open={isAiAssistantOpen}
        editorState={editorState}
        workspaceState={workspaceState}
        providerController={aiProviderController}
        onReviewSuggestionDraft={reviewSuggestionDraft}
        onClose={() => setIsAiAssistantOpen(false)}
        onOpenProviderSettings={() => setIsAiAssistantOpen(false)}
      />

      <footer className="status-bar">
        <span>{workspaceState?.saveStatus.message ?? (isDirty ? 'Unsaved changes' : 'Markdown ready')}</span>
        <span>{layout.visibleNodeIds.length} visible nodes</span>
        <span>{zoomPercent}% zoom</span>
      </footer>

      {workspaceState?.prompt ? (
        <div className="modal-backdrop">
          <div role="dialog" aria-label={workspaceState.prompt.title} className="modal-panel">
            <h2>{workspaceState.prompt.title}</h2>
            <p>{workspaceState.prompt.message}</p>
            <div className="workspace-action-row">
              <button
                className="text-button"
                type="button"
                disabled={workspaceState.prompt.saveDisabled}
                onClick={() => void workspaceActions?.savePromptDocument?.()}
              >
                Save
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => void workspaceActions?.discardPrompt()}
              >
                Discard
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => workspaceActions?.cancelPrompt()}
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

function createProposalReviewEditorSnapshot(
  editorState: MindMapEditorState,
  workspaceState: WorkspaceLifecycleState,
): ProposalReviewEditorSnapshot {
  const activeDocument = workspaceState.active;
  const activeFilePath = activeDocument?.snapshot.relativePath ?? editorState.document.sourcePath ?? 'untitled.md';
  const activeVersion = activeDocument?.snapshot.version ?? {
    token: `editor:${editorState.contentRevision}`,
    modifiedAt: editorState.document.updatedAt,
    byteSize: 0,
    contentHash: `editor:${editorState.contentRevision}`,
  };
  const fileVersions = Object.fromEntries(
    workspaceState.files.map((file) => [file.relativePath, file.version]),
  );

  return {
    document: editorState.document,
    markdownBuffer: activeDocument?.snapshot.content ?? '',
    markdownBuffersByPath: {
      [activeFilePath]: activeDocument?.snapshot.content ?? '',
    },
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
