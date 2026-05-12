import type { CSSProperties, ReactNode } from 'react';

import './WorkspaceSplit.css';

export type WorkspaceViewMode = 'split' | 'map' | 'markdown';

interface WorkspaceSplitProps {
  mode: WorkspaceViewMode;
  markdownPane: ReactNode;
  mapPane: ReactNode;
  markdownLabel?: string;
  mapLabel?: string;
  editorFraction?: number;
}

const MIN_EDITOR_FRACTION = 0.25;
const MAX_EDITOR_FRACTION = 0.75;

export function WorkspaceSplit({
  mode,
  markdownPane,
  mapPane,
  markdownLabel = 'Markdown editor',
  mapLabel = 'Mind map canvas',
  editorFraction = 0.42,
}: WorkspaceSplitProps) {
  const boundedEditorFraction = Math.min(
    MAX_EDITOR_FRACTION,
    Math.max(MIN_EDITOR_FRACTION, editorFraction),
  );
  const editorPercent = Math.round(boundedEditorFraction * 100);
  const splitStyle: CSSProperties | undefined =
    mode === 'split'
      ? {
          gridTemplateColumns: `minmax(280px, ${editorPercent}%) 10px minmax(360px, 1fr)`,
        }
      : undefined;

  return (
    <div className={`workspace-split workspace-split--${mode}`} style={splitStyle}>
      {mode !== 'map' ? (
        <section className="workspace-split-pane markdown-pane" aria-label={markdownLabel}>
          {markdownPane}
        </section>
      ) : null}

      {mode === 'split' ? (
        <div
          className="workspace-split-resizer"
          role="separator"
          aria-label="Resize Markdown and mind map panes"
          aria-orientation="vertical"
          aria-valuemin={Math.round(MIN_EDITOR_FRACTION * 100)}
          aria-valuemax={Math.round(MAX_EDITOR_FRACTION * 100)}
          aria-valuenow={editorPercent}
          tabIndex={0}
        />
      ) : null}

      {mode !== 'markdown' ? (
        <section className="workspace-split-pane map-pane" aria-label={mapLabel}>
          {mapPane}
        </section>
      ) : null}
    </div>
  );
}
