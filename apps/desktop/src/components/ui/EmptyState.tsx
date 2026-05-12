import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <section className="ui-state empty-state-panel" aria-label={title}>
      {icon ? <div className="ui-state-icon" aria-hidden="true">{icon}</div> : null}
      <div className="ui-state-copy">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="ui-state-action">{action}</div> : null}
    </section>
  );
}
