import type { AiContextPreviewState } from '../aiContextPreviewState';

export interface AiContextPreviewProps {
  previewState: AiContextPreviewState;
}

export function AiContextPreview({ previewState }: AiContextPreviewProps) {
  if (previewState.status === 'idle') {
    return (
      <section className="ai-context-preview" aria-label="AI context preview">
        <p>No workspace context available.</p>
      </section>
    );
  }

  if (previewState.status === 'error') {
    return (
      <section className="ai-context-preview error" aria-label="AI context preview" role="alert">
        <strong>Context unavailable</strong>
        <p>{previewState.error}</p>
      </section>
    );
  }

  const snapshot = previewState.snapshot;

  return (
    <section
      className="ai-context-preview"
      aria-label="AI context preview"
      role={previewState.status === 'loading' ? 'status' : undefined}
    >
      {snapshot ? (
        <>
          <div className="ai-context-preview-heading">
            <strong>{snapshot.displayLabel}</strong>
            <span>
              {snapshot.byteEstimate} bytes / {snapshot.tokenEstimate} tokens
            </span>
          </div>
          {snapshot.scope === 'workspaceSummary' ? (
            <p className="ai-context-warning">
              Workspace context uses a bounded Markdown summary and excludes ignored paths.
            </p>
          ) : null}
          {snapshot.truncated ? (
            <p className="ai-context-warning">Context content was truncated before sending.</p>
          ) : null}
          {snapshot.warnings && snapshot.warnings.length > 0 ? (
            <ul className="ai-context-warning-list">
              {snapshot.warnings.map((warning, index) => (
                <li key={`${warning.code}-${warning.itemId ?? warning.relativePath ?? index}`}>
                  {warning.message}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p>Loading context.</p>
      )}
      {previewState.status === 'loading' ? <p className="ai-context-loading">Refreshing context.</p> : null}
    </section>
  );
}
