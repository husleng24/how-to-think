import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

interface ErrorStateProps {
  title: string;
  detail?: string;
  action?: ReactNode;
}

export function ErrorState({ title, detail, action }: ErrorStateProps) {
  return (
    <section className="ui-state error-state-panel" role="alert" aria-label={title}>
      <div className="ui-state-icon" aria-hidden="true">
        <AlertTriangle size={20} />
      </div>
      <div className="ui-state-copy">
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action ? <div className="ui-state-action">{action}</div> : null}
    </section>
  );
}
