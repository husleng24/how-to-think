import { useCallback, useEffect, useMemo, useState } from 'react';

import { createCommandRegistry } from './commandRegistry';
import type { CommandPaletteItem } from './commandTypes';
import type { CommandRegistryInput } from './commandRegistry';

export interface CommandPaletteController {
  commandPaletteOpen: boolean;
  commands: readonly CommandPaletteItem[];
  closeCommandPalette: () => void;
  openCommandPalette: () => void;
}

interface CommandPaletteShortcutEvent {
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
}

export function isCommandPaletteShortcut(event: CommandPaletteShortcutEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
}

export function useCommandPalette(input: CommandRegistryInput): CommandPaletteController {
  const {
    detailCollapsed,
    onSectionChange,
    onToggleDetailPanel,
    onToggleSidebar,
    onToggleTheme,
    onViewModeChange,
    sidebarCollapsed,
  } = input;
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  const closeCommandPalette = useCallback(() => setCommandPaletteOpen(false), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isCommandPaletteShortcut(event)) {
        event.preventDefault();
        openCommandPalette();
        return;
      }

      if (event.key === 'Escape') {
        closeCommandPalette();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeCommandPalette, openCommandPalette]);

  const commands = useMemo(
    () =>
      createCommandRegistry({
        detailCollapsed,
        onSectionChange,
        onToggleDetailPanel,
        onToggleSidebar,
        onToggleTheme,
        onViewModeChange,
        sidebarCollapsed,
      }),
    [
      detailCollapsed,
      onSectionChange,
      onToggleDetailPanel,
      onToggleSidebar,
      onToggleTheme,
      onViewModeChange,
      sidebarCollapsed,
    ],
  );

  return {
    commandPaletteOpen,
    commands,
    closeCommandPalette,
    openCommandPalette,
  };
}
