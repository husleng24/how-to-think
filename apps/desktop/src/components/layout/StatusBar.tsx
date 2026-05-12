interface StatusBarItem {
  label: string;
  tone?: string;
}

interface StatusBarProps {
  visibleNodeCount: number;
  zoomPercent: number;
  workspaceName?: string;
  activePath?: string;
  sidebarCollapsed: boolean;
  detailPanelCollapsed: boolean;
  statusItems?: readonly StatusBarItem[];
}

export function StatusBar({
  visibleNodeCount,
  zoomPercent,
  workspaceName,
  activePath,
  sidebarCollapsed,
  detailPanelCollapsed,
  statusItems = [],
}: StatusBarProps) {
  return (
    <footer className="app-status-bar" aria-label="Status">
      {statusItems.map((item) => (
        <span className={`status-chip ${item.tone ?? 'neutral'}`} key={item.label}>
          {item.label}
        </span>
      ))}
      <span>{workspaceName ? 'Workspace ready' : 'No workspace'}</span>
      <span>{activePath ?? 'No file open'}</span>
      <span>{visibleNodeCount} visible nodes</span>
      <span>{zoomPercent}% zoom</span>
      <span>{sidebarCollapsed ? 'Sidebar hidden' : 'Sidebar shown'}</span>
      <span>{detailPanelCollapsed ? 'Details hidden' : 'Details shown'}</span>
    </footer>
  );
}
