import {
  Bot,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Save,
  Search,
} from 'lucide-react';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import {
  createMindMapEditorStore,
  getMindMapNode,
  layoutMindMapDocument,
} from '../domain/mindMap';
import type { MindMapCommand, MindMapEditorState, MindMapEditorStore } from '../domain/mindMap';
import { MindMapCanvas } from '../features/mindmap/MindMapCanvas';

interface EditorShellProps {
  state: MindMapEditorState;
  store?: MindMapEditorStore;
}

const outlineSections = ['Local Markdown', 'AI Drafts', 'Git History'];

export function EditorShell({ state, store: providedStore }: EditorShellProps) {
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
  const editorState = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const dispatch = useCallback(
    (command: MindMapCommand) => {
      store.dispatch(command);
    },
    [store],
  );
  const { document, selection, viewport, isDirty } = editorState;
  const selectedNode = getMindMapNode(document, selection.selectedNodeId);
  const layout = useMemo(() => layoutMindMapDocument(document), [document]);
  const zoomPercent = Math.round(viewport.zoom * 100);
  const visibleOutlineNodes = layout.nodes.slice(0, 80);
  const hiddenOutlineCount = Math.max(0, layout.nodes.length - visibleOutlineNodes.length);

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
          <button className="icon-button" type="button" aria-label="New mind map" title="New mind map">
            <FilePlus2 size={18} />
          </button>
          <button className="icon-button" type="button" aria-label="Open Markdown" title="Open Markdown">
            <FolderOpen size={18} />
          </button>
          <button className="icon-button" type="button" aria-label="Save Markdown" title="Save Markdown">
            <Save size={18} />
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <button className="text-button" type="button">
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
            <button className="icon-button compact" type="button" aria-label="Search outline" title="Search outline">
              <Search size={16} />
            </button>
          </div>

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
          <MindMapCanvas state={editorState} onCommand={dispatch} />
        </main>

        <aside className="side-panel inspector-panel" aria-label="Node inspector">
          <div className="panel-heading">
            <p className="panel-kicker">Inspector</p>
          </div>

          <section className="inspector-section">
            <p className="field-label">Selected node</p>
            <h2>{selectedNode.text}</h2>
            <p>
              {selectedNode.collapsed ? 'Collapsed branch' : 'Expanded branch'} ·{' '}
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
        </aside>
      </div>

      <footer className="status-bar">
        <span>{isDirty ? 'Unsaved changes' : 'Markdown ready'}</span>
        <span>{layout.visibleNodeIds.length} visible nodes</span>
        <span>{zoomPercent}% zoom</span>
      </footer>
    </div>
  );
}
