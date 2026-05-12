import { FilePlus2, FolderOpen, RefreshCcw } from 'lucide-react';
import { useState } from 'react';

import type { WorkspaceLifecycleState } from '../workspace';

interface ProjectListPageProps {
  workspaceState: WorkspaceLifecycleState;
  onCreateFile(relativePath: string): void;
  onOpenFile(relativePath: string): void;
  onRefreshFiles(): void;
}

export function ProjectListPage({
  workspaceState,
  onCreateFile,
  onOpenFile,
  onRefreshFiles,
}: ProjectListPageProps) {
  const [draftPath, setDraftPath] = useState('');
  const trimmedPath = draftPath.trim();

  return (
    <section className="project-list-page page-surface" aria-label="Markdown files">
      <div className="page-heading">
        <span>Files</span>
        <h2>{workspaceState.workspace?.displayName ?? 'No workspace'}</h2>
        <p>{workspaceState.workspace?.displayPath ?? 'Open a workspace to list Markdown files.'}</p>
      </div>

      <div className="project-toolbar">
        <label className="workspace-path-field">
          <span>Project file path</span>
          <input
            value={draftPath}
            placeholder="research/outline.md"
            disabled={!workspaceState.workspace}
            onChange={(event) => setDraftPath(event.currentTarget.value)}
          />
        </label>
        <button
          className="text-button"
          type="button"
          disabled={!workspaceState.workspace || !trimmedPath || workspaceState.isBusy}
          onClick={() => {
            onCreateFile(trimmedPath);
            setDraftPath('');
          }}
        >
          <FilePlus2 size={16} />
          Create file
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Refresh files"
          title="Refresh files"
          disabled={!workspaceState.workspace || workspaceState.isBusy}
          onClick={onRefreshFiles}
        >
          <RefreshCcw size={16} />
        </button>
      </div>

      {workspaceState.files.length > 0 ? (
        <div className="project-file-grid">
          {workspaceState.files.map((file) => (
            <button
              className={
                workspaceState.active?.snapshot.relativePath === file.relativePath ? 'active' : ''
              }
              type="button"
              key={file.relativePath}
              onClick={() => onOpenFile(file.relativePath)}
            >
              <FolderOpen size={17} aria-hidden="true" />
              <span>{file.relativePath}</span>
              <small>{new Date(file.modifiedAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-state">No Markdown files yet.</p>
      )}
    </section>
  );
}
