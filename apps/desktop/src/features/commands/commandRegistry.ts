import {
  Bot,
  Command,
  FileText,
  FolderOpen,
  LayoutDashboard,
  ListTree,
  Moon,
  PanelLeft,
  PanelRight,
  Settings,
} from 'lucide-react';

import type { CommandPaletteItem, CommandSectionId, CommandViewMode } from './commandTypes';

export interface CommandRegistryInput {
  detailCollapsed: boolean;
  sidebarCollapsed: boolean;
  onSectionChange: (sectionId: CommandSectionId) => void;
  onToggleDetailPanel: () => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  onViewModeChange: (mode: CommandViewMode) => void;
}

export function createCommandRegistry({
  detailCollapsed,
  onSectionChange,
  onToggleDetailPanel,
  onToggleSidebar,
  onToggleTheme,
  onViewModeChange,
  sidebarCollapsed,
}: CommandRegistryInput): readonly CommandPaletteItem[] {
  return [
    {
      category: 'navigation',
      description: 'Jump to the Markdown and mind map workspace overview.',
      icon: LayoutDashboard,
      id: 'navigation.dashboard',
      label: 'Go to Dashboard',
      run: () => onSectionChange('dashboard'),
      shortcut: 'G D',
    },
    {
      category: 'navigation',
      description: 'Show local vaults and mock project metadata.',
      icon: FolderOpen,
      id: 'navigation.projects',
      label: 'Go to Projects',
      run: () => onSectionChange('projects'),
      shortcut: 'G P',
    },
    {
      category: 'navigation',
      description: 'Open appearance, editor, AI provider, and shortcut settings.',
      icon: Settings,
      id: 'navigation.settings',
      label: 'Go to Settings',
      run: () => onSectionChange('settings'),
      shortcut: 'G S',
    },
    {
      category: 'theme',
      description: 'Switch between light and dark themes.',
      icon: Moon,
      id: 'theme.toggle',
      label: 'Toggle Theme',
      run: onToggleTheme,
    },
    {
      category: 'panel',
      description: sidebarCollapsed ? 'Expand the workspace sidebar.' : 'Collapse the workspace sidebar.',
      icon: PanelLeft,
      id: 'panel.toggle-sidebar',
      label: 'Toggle Sidebar',
      run: onToggleSidebar,
    },
    {
      category: 'panel',
      description: detailCollapsed ? 'Expand the AI and inspector panel.' : 'Collapse the AI and inspector panel.',
      icon: PanelRight,
      id: 'panel.toggle-detail',
      label: 'Toggle Detail Panel',
      run: onToggleDetailPanel,
    },
    {
      category: 'view',
      description: 'Show Markdown source and mind map canvas together.',
      icon: ListTree,
      id: 'view.split',
      label: 'View: Split',
      run: () => onViewModeChange('split'),
    },
    {
      category: 'view',
      description: 'Show only the mind map canvas.',
      icon: Command,
      id: 'view.map',
      label: 'View: Map Only',
      run: () => onViewModeChange('map'),
    },
    {
      category: 'view',
      description: 'Show only the Markdown source pane.',
      icon: FileText,
      id: 'view.markdown',
      label: 'View: Markdown Only',
      run: () => onViewModeChange('markdown'),
    },
    {
      category: 'ai',
      description: 'Ask AI to expand the selected node as previewable child-node suggestions.',
      disabledReason: 'Connect an AI provider before running this command.',
      icon: Bot,
      id: 'ai.expand-node',
      label: 'AI: Expand Selected Node',
      run: () => undefined,
    },
  ];
}
