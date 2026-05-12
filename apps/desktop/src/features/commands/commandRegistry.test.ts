import { describe, expect, it, vi } from 'vitest';

import { createCommandRegistry } from './commandRegistry';
import type { CommandRegistryInput } from './commandRegistry';
import type { CommandId, CommandPaletteItem } from './commandTypes';

describe('createCommandRegistry', () => {
  it('registers typed navigation commands', () => {
    const onSectionChange = vi.fn<CommandRegistryInput['onSectionChange']>();
    const commands = createCommandRegistry(createInput({ onSectionChange }));

    expect(commands.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        'navigation.dashboard',
        'navigation.projects',
        'navigation.settings',
      ]),
    );

    expect(findCommand(commands, 'navigation.dashboard')).toMatchObject({
      category: 'navigation',
      label: 'Go to Dashboard',
      shortcut: 'G D',
    });

    findCommand(commands, 'navigation.projects').run();
    expect(onSectionChange).toHaveBeenCalledWith('projects');
  });

  it('registers view commands that switch workspace modes', () => {
    const onViewModeChange = vi.fn<CommandRegistryInput['onViewModeChange']>();
    const commands = createCommandRegistry(createInput({ onViewModeChange }));

    findCommand(commands, 'view.split').run();
    findCommand(commands, 'view.map').run();
    findCommand(commands, 'view.markdown').run();

    expect(onViewModeChange).toHaveBeenNthCalledWith(1, 'split');
    expect(onViewModeChange).toHaveBeenNthCalledWith(2, 'map');
    expect(onViewModeChange).toHaveBeenNthCalledWith(3, 'markdown');
    expect(findCommand(commands, 'view.map')).toMatchObject({
      category: 'view',
      label: 'View: Map Only',
    });
  });

  it('registers panel commands with state-aware descriptions', () => {
    const onToggleSidebar = vi.fn<CommandRegistryInput['onToggleSidebar']>();
    const onToggleDetailPanel = vi.fn<CommandRegistryInput['onToggleDetailPanel']>();
    const expandedCommands = createCommandRegistry(
      createInput({
        detailCollapsed: false,
        onToggleDetailPanel,
        onToggleSidebar,
        sidebarCollapsed: false,
      }),
    );

    expect(findCommand(expandedCommands, 'panel.toggle-sidebar')).toMatchObject({
      category: 'panel',
      description: 'Collapse the workspace sidebar.',
    });
    expect(findCommand(expandedCommands, 'panel.toggle-detail').description).toBe(
      'Collapse the AI and inspector panel.',
    );

    findCommand(expandedCommands, 'panel.toggle-sidebar').run();
    findCommand(expandedCommands, 'panel.toggle-detail').run();

    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(onToggleDetailPanel).toHaveBeenCalledTimes(1);

    const collapsedCommands = createCommandRegistry(
      createInput({
        detailCollapsed: true,
        sidebarCollapsed: true,
      }),
    );

    expect(findCommand(collapsedCommands, 'panel.toggle-sidebar').description).toBe(
      'Expand the workspace sidebar.',
    );
    expect(findCommand(collapsedCommands, 'panel.toggle-detail').description).toBe(
      'Expand the AI and inspector panel.',
    );
  });

  it('registers theme and disabled AI commands', () => {
    const onToggleTheme = vi.fn<CommandRegistryInput['onToggleTheme']>();
    const commands = createCommandRegistry(createInput({ onToggleTheme }));

    findCommand(commands, 'theme.toggle').run();
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
    expect(findCommand(commands, 'theme.toggle')).toMatchObject({
      category: 'theme',
      description: 'Switch between light and dark themes.',
    });

    expect(findCommand(commands, 'ai.expand-node')).toMatchObject({
      category: 'ai',
      disabledReason: 'Connect an AI provider before running this command.',
    });
  });
});

function createInput(overrides: Partial<CommandRegistryInput> = {}): CommandRegistryInput {
  return {
    detailCollapsed: false,
    onSectionChange: vi.fn<CommandRegistryInput['onSectionChange']>(),
    onToggleDetailPanel: vi.fn<CommandRegistryInput['onToggleDetailPanel']>(),
    onToggleSidebar: vi.fn<CommandRegistryInput['onToggleSidebar']>(),
    onToggleTheme: vi.fn<CommandRegistryInput['onToggleTheme']>(),
    onViewModeChange: vi.fn<CommandRegistryInput['onViewModeChange']>(),
    sidebarCollapsed: false,
    ...overrides,
  };
}

function findCommand(commands: readonly CommandPaletteItem[], id: CommandId): CommandPaletteItem {
  const command = commands.find((item) => item.id === id);

  if (!command) {
    throw new Error(`Expected command ${id} to be registered.`);
  }

  return command;
}
