import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import type { CommandPaletteCommand } from './types';

interface CommandPaletteProps {
  open: boolean;
  commands: CommandPaletteCommand[];
  onClose(): void;
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return commands;
    }

    return commands.filter((command) => {
      const haystack = `${command.label} ${command.detail ?? ''}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [commands, query]);
  const enabledCommands = filteredCommands.filter((command) => !command.disabled);
  const activeCommand = enabledCommands[Math.min(activeIndex, enabledCommands.length - 1)];

  useEffect(() => {
    if (!open) {
      return;
    }

    setQuery('');
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) {
    return null;
  }

  const runCommand = (command: CommandPaletteCommand): void => {
    if (command.disabled) {
      return;
    }

    void command.run();
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, Math.max(0, enabledCommands.length - 1)));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }

    if (event.key === 'Enter' && activeCommand) {
      event.preventDefault();
      runCommand(activeCommand);
    }
  };

  return (
    <div className="command-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label className="command-palette-search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search commands"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
        </label>

        <div className="command-palette-list" role="listbox" aria-label="Commands">
          {filteredCommands.length > 0 ? (
            filteredCommands.map((command) => {
              const enabledIndex = enabledCommands.findIndex((item) => item.id === command.id);
              const active = enabledIndex === activeIndex && !command.disabled;

              return (
                <button
                  className={active ? 'active' : ''}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={command.disabled}
                  key={command.id}
                  onClick={() => runCommand(command)}
                >
                  {command.icon ? <span className="command-palette-icon">{command.icon}</span> : null}
                  <span>
                    <strong>{command.label}</strong>
                    {command.detail ? <small>{command.detail}</small> : null}
                  </span>
                  {command.shortcut ? <kbd>{command.shortcut}</kbd> : null}
                </button>
              );
            })
          ) : (
            <p className="command-palette-empty">No commands found.</p>
          )}
        </div>
      </section>
    </div>
  );
}
