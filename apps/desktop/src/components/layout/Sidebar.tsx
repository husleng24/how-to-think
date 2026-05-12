import { FilePlus2, FolderOpen, RefreshCcw } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { WorkspaceLifecycleState } from '../../features/workspace';
import type { OutlineNodeItem, ShellWorkspaceActions } from './types';

interface SidebarProps {
  collapsed: boolean;
  workspaceState: WorkspaceLifecycleState;
  workspaceActions: ShellWorkspaceActions;
  outlineNodes: OutlineNodeItem[];
  hiddenOutlineCount: number;
  onSelectOutlineNode(nodeId: string): void;
  onExpand(): void;
}

export function Sidebar({
  collapsed,
  workspaceState,
  workspaceActions,
  outlineNodes,
  hiddenOutlineCount,
  onSelectOutlineNode,
  onExpand,
}: SidebarProps) {
  const [workspacePathInput, setWorkspacePathInput] = useState(
    workspaceState.workspace?.displayPath ?? '',
  );
  const [newMarkdownPath, setNewMarkdownPath] = useState('');
  const trimmedWorkspacePath = workspacePathInput.trim();
  const trimmedNewMarkdownPath = newMarkdownPath.trim();

  useEffect(() => {
    setWorkspacePathInput(workspaceState.workspace?.displayPath ?? '');
  }, [workspaceState.workspace?.displayPath]);

  if (collapsed) {
    return (
      <aside className="sidebar is-collapsed" aria-label="Workspace sidebar">
        <button type="button" aria-label="Expand sidebar" title="Expand sidebar" onClick={onExpand}>
          <FolderOpen size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar" aria-label="Workspace sidebar">
      <section className="sidebar-section workspace-selector">
        <div className="section-heading">
          <span>Workspace</span>
          <button
            className="icon-button compact"
            type="button"
            aria-label="Refresh workspace files"
            title="Refresh workspace files"
            disabled={!workspaceState.workspace || workspaceState.isBusy}
            onClick={() => void workspaceActions.refreshFiles()}
          >
            <RefreshCcw size={15} />
          </button>
        </div>

        <label className="workspace-path-field">
          <span>Workspace path</span>
          <input
            value={workspacePathInput}
            placeholder="C:\\Notes"
            onChange={(event) => setWorkspacePathInput(event.currentTarget.value)}
          />
        </label>

        <div className="workspace-action-row">
          <button
            className="text-button"
            type="button"
            disabled={!trimmedWorkspacePath || workspaceState.isBusy}
            onClick={() => void workspaceActions.openWorkspace(trimmedWorkspacePath)}
          >
            Open workspace
          </button>
          <button
            className="text-button"
            type="button"
            disabled={!trimmedWorkspacePath || workspaceState.isBusy}
            onClick={() => void workspaceActions.createWorkspace(trimmedWorkspacePath)}
          >
            Create workspace
          </button>
        </div>
      </section>

      {workspaceState.workspace ? (
        <section className="sidebar-section">
          <div className="workspace-summary">
            <strong>{workspaceState.workspace.displayName}</strong>
            <span>{workspaceState.workspace.displayPath}</span>
          </div>

          <label className="workspace-path-field">
            <span>New Markdown path</span>
            <input
              value={newMarkdownPath}
              placeholder="ideas.md"
              onChange={(event) => setNewMarkdownPath(event.currentTarget.value)}
            />
          </label>

          <button
            className="text-button full-width"
            type="button"
            disabled={!trimmedNewMarkdownPath || workspaceState.isBusy}
            onClick={() => {
              void workspaceActions.requestCreateFile(trimmedNewMarkdownPath);
              setNewMarkdownPath('');
            }}
          >
            <FilePlus2 size={16} />
            Create Markdown file
          </button>

          <div className="file-list" aria-label="Workspace Markdown files">
            {workspaceState.files.length > 0 ? (
              workspaceState.files.map((file) => (
                <button
                  className={`file-list-item${
                    workspaceState.active?.snapshot.relativePath === file.relativePath ? ' active' : ''
                  }`}
                  type="button"
                  key={file.relativePath}
                  aria-current={
                    workspaceState.active?.snapshot.relativePath === file.relativePath
                      ? 'page'
                      : undefined
                  }
                  onClick={() => void workspaceActions.requestOpenFile(file.relativePath)}
                >
                  <span className="file-dot" aria-hidden="true" />
                  <span>{file.relativePath}</span>
                </button>
              ))
            ) : (
              <p className="empty-state">No Markdown files yet.</p>
            )}
          </div>
        </section>
      ) : null}

      <section className="sidebar-section outline-sidebar-section">
        <div className="section-heading">
          <span>Outline</span>
        </div>
        <nav className="outline-tree" aria-label="Mind map nodes">
          {outlineNodes.length > 0 ? (
            outlineNodes.map((node) => (
              <button
                className={`outline-node${node.active ? ' active' : ''}`}
                style={{ paddingLeft: 10 + Math.min(node.depth, 5) * 14 }}
                type="button"
                key={node.id}
                aria-current={node.active ? 'true' : undefined}
                onClick={() => onSelectOutlineNode(node.id)}
              >
                <span className={`node-dot${node.isRoot ? '' : ' muted'}`} aria-hidden="true" />
                {node.text || 'Empty thought'}
              </button>
            ))
          ) : (
            <p className="empty-state">Open a Markdown file to see its outline.</p>
          )}
          {hiddenOutlineCount > 0 ? (
            <span className="outline-overflow">+{hiddenOutlineCount} more visible nodes</span>
          ) : null}
        </nav>
      </section>
    </aside>
  );
}
