import { FileText, GitBranch, Workflow } from 'lucide-react';

import type { WorkspaceLifecycleState } from '../workspace';

interface DashboardPageProps {
  workspaceState: WorkspaceLifecycleState;
  onOpenFile(relativePath: string): void;
  onViewProjects(): void;
}

export function DashboardPage({
  workspaceState,
  onOpenFile,
  onViewProjects,
}: DashboardPageProps) {
  const workspace = workspaceState.workspace;
  const activePath = workspaceState.active?.snapshot.relativePath;
  const changedFileCount = workspaceState.gitStatus?.changedFileCount ?? 0;

  return (
    <section className="dashboard-page page-surface" aria-label="Dashboard">
      <div className="page-heading">
        <span>Workspace overview</span>
        <h2>{workspace?.displayName ?? 'No workspace selected'}</h2>
        <p>{workspace?.displayPath ?? 'Select a local folder from the sidebar.'}</p>
      </div>

      <div className="metric-grid">
        <article>
          <FileText size={18} aria-hidden="true" />
          <strong>{workspaceState.files.length}</strong>
          <span>Markdown files</span>
        </article>
        <article>
          <Workflow size={18} aria-hidden="true" />
          <strong>{activePath ? '1' : '0'}</strong>
          <span>Open map</span>
        </article>
        <article>
          <GitBranch size={18} aria-hidden="true" />
          <strong>{changedFileCount}</strong>
          <span>Git changes</span>
        </article>
      </div>

      <section className="page-section">
        <div className="section-heading">
          <span>Recent files</span>
          <button className="text-button" type="button" disabled={!workspace} onClick={onViewProjects}>
            View all
          </button>
        </div>

        {workspaceState.recentFiles.length > 0 ? (
          <div className="recent-file-list">
            {workspaceState.recentFiles.map((relativePath) => (
              <button
                className={relativePath === activePath ? 'active' : ''}
                type="button"
                key={relativePath}
                onClick={() => onOpenFile(relativePath)}
              >
                <span>{relativePath}</span>
                {relativePath === activePath ? <small>Open</small> : null}
              </button>
            ))}
          </div>
        ) : (
          <p className="empty-state">Recent Markdown files will appear here after you open them.</p>
        )}
      </section>
    </section>
  );
}
