import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { ReactNode } from 'react';

interface DetailPanelProps {
  collapsed: boolean;
  children: ReactNode;
  onToggleCollapsed(): void;
}

export function DetailPanel({ collapsed, children, onToggleCollapsed }: DetailPanelProps) {
  if (collapsed) {
    return (
      <aside className="detail-panel is-collapsed" aria-label="Detail panel">
        <button
          type="button"
          aria-label="Expand detail panel"
          title="Expand detail panel"
          onClick={onToggleCollapsed}
        >
          <PanelRightOpen size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="detail-panel" aria-label="Detail panel">
      <div className="detail-panel-header">
        <span>Details</span>
        <button
          className="icon-button compact"
          type="button"
          aria-label="Collapse detail panel"
          title="Collapse detail panel"
          onClick={onToggleCollapsed}
        >
          <PanelRightClose size={15} />
        </button>
      </div>
      <div className="detail-panel-body">{children}</div>
    </aside>
  );
}
