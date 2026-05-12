interface LoadingStateProps {
  title?: string;
  description?: string;
}

export function LoadingState({
  title = 'Loading workspace',
  description = 'Restoring the last local workspace session.',
}: LoadingStateProps) {
  return (
    <section className="ui-state loading-state-panel" aria-label={title}>
      <span className="loading-spinner" aria-hidden="true" />
      <div className="ui-state-copy">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </section>
  );
}
