import { FilePlus2, FolderOpen } from 'lucide-react';
import type { ReactNode } from 'react';

import type { UserMessage, WorkspaceInfo, WorkspaceLifecycleState } from '../../features/workspace';
import { EmptyState, ErrorState, LoadingState } from '../ui';
import type { ShellView } from './types';

interface MainContentProps {
  activeView: ShellView;
  startupStatus: WorkspaceLifecycleState['startupStatus'];
  workspace: WorkspaceInfo | null;
  activeDocumentAvailable: boolean;
  lastError: UserMessage | null;
  onClearError(): void;
  mapView: ReactNode;
  dashboardView: ReactNode;
  projectsView: ReactNode;
  settingsView: ReactNode;
}

export function MainContent({
  activeView,
  startupStatus,
  workspace,
  activeDocumentAvailable,
  lastError,
  onClearError,
  mapView,
  dashboardView,
  projectsView,
  settingsView,
}: MainContentProps) {
  return (
    <main className={`main-content ${activeView}-view`} aria-label={mainLabel(activeView)}>
      {renderContent({
        activeView,
        startupStatus,
        workspace,
        activeDocumentAvailable,
        lastError,
        onClearError,
        mapView,
        dashboardView,
        projectsView,
        settingsView,
      })}
    </main>
  );
}

function renderContent({
  activeView,
  startupStatus,
  workspace,
  activeDocumentAvailable,
  lastError,
  onClearError,
  mapView,
  dashboardView,
  projectsView,
  settingsView,
}: MainContentProps) {
  if (activeView === 'dashboard') {
    return dashboardView;
  }

  if (activeView === 'projects') {
    return projectsView;
  }

  if (activeView === 'settings') {
    return settingsView;
  }

  if (startupStatus === 'loading') {
    return <LoadingState />;
  }

  if (startupStatus === 'error') {
    return (
      <ErrorState
        title={lastError?.title ?? 'Workspace could not be loaded'}
        detail={lastError?.detail}
        action={
          <button className="text-button" type="button" onClick={onClearError}>
            Dismiss
          </button>
        }
      />
    );
  }

  if (!workspace) {
    return (
      <EmptyState
        icon={<FolderOpen size={22} />}
        title="Select a workspace"
        description="Open or create a local folder in the sidebar to start editing Markdown mind maps."
      />
    );
  }

  if (!activeDocumentAvailable) {
    return (
      <EmptyState
        icon={<FilePlus2 size={22} />}
        title="Open or create a Markdown map"
        description="Choose a file from the sidebar or create a new Markdown file in this workspace."
      />
    );
  }

  return mapView;
}

function mainLabel(activeView: ShellView): string {
  if (activeView === 'map') {
    return 'Mind map editor';
  }

  if (activeView === 'projects') {
    return 'Markdown files';
  }

  return activeView === 'dashboard' ? 'Dashboard' : 'Settings';
}
