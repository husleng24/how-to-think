import {
  Bot,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Save,
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import {
  MindMapDocument,
  getMindMapNode,
  listChildNodes,
} from '../domain/mindMap';

interface EditorShellProps {
  document: MindMapDocument;
}

const outlineSections = ['Local Markdown', 'AI Drafts', 'Git History'];

export function EditorShell({ document }: EditorShellProps) {
  const rootNode = getMindMapNode(document, document.rootNodeId);
  const selectedNode = getMindMapNode(document, document.selectedNodeId);
  const childNodes = listChildNodes(document, rootNode.id);

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
            <button className="outline-node active" type="button">
              <span className="node-dot" aria-hidden="true" />
              {rootNode.title}
            </button>
            {childNodes.map((node) => (
              <button className="outline-node child" type="button" key={node.id}>
                <span className="node-dot muted" aria-hidden="true" />
                {node.title}
              </button>
            ))}
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
          <div className="canvas-toolbar" aria-label="Canvas controls">
            <button className="icon-button compact" type="button" aria-label="Zoom out" title="Zoom out">
              <ZoomOut size={16} />
            </button>
            <span className="zoom-level">100%</span>
            <button className="icon-button compact" type="button" aria-label="Zoom in" title="Zoom in">
              <ZoomIn size={16} />
            </button>
          </div>

          <section className="mindmap-canvas" aria-label="Editable mind map canvas">
            <div className="root-node">
              <p className="node-label">Root</p>
              <h2>{rootNode.title}</h2>
              <p>{rootNode.note}</p>
            </div>

            <div className="branch-rail" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>

            <div className="branch-grid" aria-label="Starting branches">
              <article className="branch-node markdown">
                <p>Markdown source</p>
                <strong># Untitled thought</strong>
              </article>
              <article className="branch-node ai">
                <p>AI working set</p>
                <strong>No draft selected</strong>
              </article>
              <article className="branch-node git">
                <p>Git checkpoint</p>
                <strong>Uncommitted map</strong>
              </article>
            </div>
          </section>
        </main>

        <aside className="side-panel inspector-panel" aria-label="Node inspector">
          <div className="panel-heading">
            <p className="panel-kicker">Inspector</p>
          </div>

          <section className="inspector-section">
            <p className="field-label">Selected node</p>
            <h2>{selectedNode.title}</h2>
            <p>{selectedNode.note}</p>
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
        <span>Markdown ready</span>
        <span>AI idle</span>
        <span>Git detached</span>
      </footer>
    </div>
  );
}
