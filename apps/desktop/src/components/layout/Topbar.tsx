import {
  Bot,
  Command,
  Download,
  GitBranch,
  PanelRightOpen,
  Save,
} from 'lucide-react';

import type { SaveStatus, WorkspaceInfo } from '../../features/workspace';
import type { ShellView } from './types';

interface TopbarProps {
  activeView: ShellView;
  documentTitle: string;
  workspace: WorkspaceInfo | null;
  activePath?: string;
  saveStatus: SaveStatus;
  isBusy: boolean;
  canOpenAiAssistant: boolean;
  isAiAssistantOpen: boolean;
  detailPanelCollapsed: boolean;
  onOpenCommandPalette(): void;
  onSaveMarkdown(): void;
  onOpenExport(): void;
  onToggleAiAssistant(): void;
  onOpenGitSnapshot(): void;
  onExpandDetailPanel(): void;
}

const viewLabels: Record<ShellView, string> = {
  map: 'Mind map',
  dashboard: 'Dashboard',
  projects: 'Markdown files',
  settings: 'Settings',
};

export function Topbar({
  activeView,
  documentTitle,
  workspace,
  activePath,
  saveStatus,
  isBusy,
  canOpenAiAssistant,
  isAiAssistantOpen,
  detailPanelCollapsed,
  onOpenCommandPalette,
  onSaveMarkdown,
  onOpenExport,
  onToggleAiAssistant,
  onOpenGitSnapshot,
  onExpandDetailPanel,
}: TopbarProps) {
  const saveStatusClass = `save-status ${saveStatus.kind}`;

  return (
    <header className="topbar">
      <div className="topbar-title">
        <span>{viewLabels[activeView]}</span>
        <h1>{activeView === 'map' ? documentTitle : workspace?.displayName ?? 'No workspace'}</h1>
        {activePath ? <p>{activePath}</p> : null}
      </div>

      <div className="topbar-actions" aria-label="Workspace actions">
        <button
          className="command-button"
          type="button"
          aria-label="Open command palette"
          title="Open command palette"
          onClick={onOpenCommandPalette}
        >
          <Command size={16} />
          <span>Cmd/Ctrl K</span>
        </button>

        <span className={saveStatusClass} aria-live="polite">
          {isBusy ? 'Working...' : saveStatus.message}
        </span>

        <button
          className="icon-button"
          type="button"
          aria-label="Save Markdown"
          title="Save Markdown"
          disabled={!activePath}
          onClick={onSaveMarkdown}
        >
          <Save size={17} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="Export mind map"
          title="Export mind map"
          disabled={!activePath}
          onClick={onOpenExport}
        >
          <Download size={17} />
        </button>
        <button
          className="text-button"
          type="button"
          aria-label={
            canOpenAiAssistant
              ? isAiAssistantOpen
                ? 'Close AI assistant'
                : 'Open AI assistant'
              : 'AI unavailable'
          }
          disabled={!canOpenAiAssistant}
          title={canOpenAiAssistant ? 'Open AI assistant' : 'Open a Markdown file first.'}
          onClick={onToggleAiAssistant}
        >
          <Bot size={16} />
          AI
        </button>
        <button
          className="text-button"
          type="button"
          aria-label="Open Git snapshot"
          title={workspace ? 'Open Git snapshot' : 'Open a workspace first.'}
          disabled={!workspace}
          onClick={onOpenGitSnapshot}
        >
          <GitBranch size={16} />
          Git
        </button>
        {detailPanelCollapsed ? (
          <button
            className="icon-button"
            type="button"
            aria-label="Expand detail panel"
            title="Expand detail panel"
            onClick={onExpandDetailPanel}
          >
            <PanelRightOpen size={17} />
          </button>
        ) : null}
      </div>
    </header>
  );
}
