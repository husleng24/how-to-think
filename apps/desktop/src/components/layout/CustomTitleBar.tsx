import { Minus, Square, X } from 'lucide-react';

interface CustomTitleBarProps {
  title: string;
  subtitle?: string;
  isBusy?: boolean;
}

export function CustomTitleBar({ title, subtitle, isBusy = false }: CustomTitleBarProps) {
  return (
    <header className="custom-title-bar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="titlebar-mark" aria-hidden="true">
          HT
        </span>
        <div className="titlebar-copy" data-tauri-drag-region>
          <strong>{title}</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
      </div>

      <div className="titlebar-center" data-tauri-drag-region>
        {isBusy ? <span className="busy-dot" aria-hidden="true" /> : null}
        <span>{isBusy ? 'Working locally' : 'Local-first workspace'}</span>
      </div>

      <div className="titlebar-window-controls" aria-label="Window controls">
        <button type="button" aria-label="Minimize window unavailable" disabled>
          <Minus size={13} />
        </button>
        <button type="button" aria-label="Maximize window unavailable" disabled>
          <Square size={12} />
        </button>
        <button type="button" aria-label="Close window unavailable" disabled>
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
