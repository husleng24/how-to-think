interface StatusBarProps {
  visibleNodeCount: number;
  zoomPercent: number;
  workspaceName?: string;
  activePath?: string;
  sidebarCollapsed: boolean;
  detailPanelCollapsed: boolean;
}

export function StatusBar({
  visibleNodeCount,
  zoomPercent,
  workspaceName,
  activePath,
  sidebarCollapsed,
  detailPanelCollapsed,
}: StatusBarProps) {
  return (
    <footer className="app-status-bar" aria-label="Status">
      <span>{workspaceName ? 'Workspace ready' : 'No workspace'}</span>
      <span>{activePath ?? 'No file open'}</span>
      <span>{visibleNodeCount} visible nodes</span>
      <span>{zoomPercent}% zoom</span>
      <span>{sidebarCollapsed ? 'Sidebar hidden' : 'Sidebar shown'}</span>
      <span>{detailPanelCollapsed ? 'Details hidden' : 'Details shown'}</span>
    </footer>
  );
}
