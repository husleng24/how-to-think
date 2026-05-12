import type { LucideIcon } from 'lucide-react';

export type CommandSectionId = 'dashboard' | 'projects' | 'settings';
export type CommandViewMode = 'split' | 'map' | 'markdown';
export type CommandCategory = 'navigation' | 'view' | 'panel' | 'theme' | 'ai';

export type NavigationCommandId =
  | 'navigation.dashboard'
  | 'navigation.projects'
  | 'navigation.settings';

export type ViewCommandId =
  | 'view.split'
  | 'view.map'
  | 'view.markdown';

export type PanelCommandId =
  | 'panel.toggle-sidebar'
  | 'panel.toggle-detail';

export type ThemeCommandId = 'theme.toggle';
export type AiCommandId = 'ai.expand-node';

export type CommandId =
  | NavigationCommandId
  | ViewCommandId
  | PanelCommandId
  | ThemeCommandId
  | AiCommandId;

export interface CommandPaletteItem {
  id: CommandId;
  category: CommandCategory;
  label: string;
  description: string;
  shortcut?: string;
  disabledReason?: string;
  icon: LucideIcon;
  run: () => void;
}

const sectionIds = ['dashboard', 'projects', 'settings'] satisfies readonly CommandSectionId[];

export function isCommandSectionId(value: string): value is CommandSectionId {
  return sectionIds.some((sectionId) => sectionId === value);
}
