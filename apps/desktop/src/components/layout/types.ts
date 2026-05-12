import type { ReactNode } from 'react';

import type { WorkspaceLifecycleActions } from '../../features/workspace';

export type ShellView = 'map' | 'dashboard' | 'projects' | 'settings';

export type ThemeName = 'light' | 'dark';

export interface ShellWorkspaceActions extends WorkspaceLifecycleActions {
  saveActiveDocument?: () => Promise<boolean>;
  savePromptDocument?: () => Promise<void>;
}

export interface OutlineNodeItem {
  id: string;
  text: string;
  depth: number;
  isRoot: boolean;
  active: boolean;
}

export interface CommandPaletteCommand {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  disabled?: boolean;
  icon?: ReactNode;
  run(): void | Promise<void>;
}
