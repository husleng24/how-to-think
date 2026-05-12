import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CommandRegistryInput } from './commandRegistry';
import { isCommandPaletteShortcut, useCommandPalette } from './useCommandPalette';

describe('useCommandPalette', () => {
  it('opens with Ctrl/Cmd+K and closes with Escape', () => {
    const { result } = renderHook(() => useCommandPalette(createInput()));

    expect(result.current.commandPaletteOpen).toBe(false);

    const openEvent = dispatchKeyboardShortcut({ ctrlKey: true, key: 'k' });

    expect(openEvent.defaultPrevented).toBe(true);
    expect(result.current.commandPaletteOpen).toBe(true);

    dispatchKeyboardShortcut({ key: 'Escape' });

    expect(result.current.commandPaletteOpen).toBe(false);
  });

  it('exposes registry commands and refreshes state-aware descriptions', () => {
    const { result, rerender } = renderHook(
      (input: CommandRegistryInput) => useCommandPalette(input),
      {
        initialProps: createInput({ sidebarCollapsed: false }),
      },
    );

    expect(result.current.commands.find((command) => command.id === 'panel.toggle-sidebar')).toMatchObject({
      description: 'Collapse the workspace sidebar.',
    });

    rerender(createInput({ sidebarCollapsed: true }));

    expect(result.current.commands.find((command) => command.id === 'panel.toggle-sidebar')).toMatchObject({
      description: 'Expand the workspace sidebar.',
    });
  });

  it('supports direct open and close controls', () => {
    const { result } = renderHook(() => useCommandPalette(createInput()));

    act(() => result.current.openCommandPalette());
    expect(result.current.commandPaletteOpen).toBe(true);

    act(() => result.current.closeCommandPalette());
    expect(result.current.commandPaletteOpen).toBe(false);
  });
});

describe('isCommandPaletteShortcut', () => {
  it('matches Ctrl/Cmd+K only', () => {
    expect(isCommandPaletteShortcut({ ctrlKey: true, key: 'k', metaKey: false })).toBe(true);
    expect(isCommandPaletteShortcut({ ctrlKey: false, key: 'K', metaKey: true })).toBe(true);
    expect(isCommandPaletteShortcut({ ctrlKey: false, key: 'k', metaKey: false })).toBe(false);
    expect(isCommandPaletteShortcut({ ctrlKey: true, key: 's', metaKey: false })).toBe(false);
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

function dispatchKeyboardShortcut(input: {
  ctrlKey?: boolean;
  key: string;
  metaKey?: boolean;
}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: input.ctrlKey ?? false,
    key: input.key,
    metaKey: input.metaKey ?? false,
  });

  act(() => {
    window.dispatchEvent(event);
  });

  return event;
}
