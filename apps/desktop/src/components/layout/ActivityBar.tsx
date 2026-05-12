import {
  FileText,
  Gauge,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { ShellView } from './types';

interface ActivityBarProps {
  activeView: ShellView;
  sidebarCollapsed: boolean;
  detailPanelCollapsed: boolean;
  onViewChange(view: ShellView): void;
  onToggleSidebar(): void;
  onToggleDetailPanel(): void;
}

interface ActivityItem {
  id: ShellView;
  label: string;
  icon: LucideIcon;
}

const primaryItems: ActivityItem[] = [
  { id: 'map', label: 'Mind map', icon: Workflow },
  { id: 'dashboard', label: 'Dashboard', icon: Gauge },
  { id: 'projects', label: 'Markdown files', icon: FileText },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function ActivityBar({
  activeView,
  sidebarCollapsed,
  detailPanelCollapsed,
  onViewChange,
  onToggleSidebar,
  onToggleDetailPanel,
}: ActivityBarProps) {
  return (
    <nav className="activity-bar" aria-label="Primary navigation">
      <div className="activity-bar-group">
        {primaryItems.map((item) => {
          const Icon = item.icon;

          return (
            <button
              className={activeView === item.id ? 'active' : ''}
              type="button"
              aria-label={item.label}
              aria-current={activeView === item.id ? 'page' : undefined}
              title={item.label}
              key={item.id}
              onClick={() => onViewChange(item.id)}
            >
              <Icon size={19} />
            </button>
          );
        })}
      </div>

      <div className="activity-bar-group">
        <button
          type="button"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleSidebar}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
        </button>
        <button
          type="button"
          aria-label={detailPanelCollapsed ? 'Expand detail panel' : 'Collapse detail panel'}
          title={detailPanelCollapsed ? 'Expand detail panel' : 'Collapse detail panel'}
          onClick={onToggleDetailPanel}
        >
          {detailPanelCollapsed ? <PanelRightOpen size={19} /> : <PanelRightClose size={19} />}
        </button>
      </div>
    </nav>
  );
}
