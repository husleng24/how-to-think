import './MarkdownEditorMock.css';

interface MarkdownEditorMockProps {
  value: string;
  title: string;
  sourcePath?: string | null;
  status?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}

export function MarkdownEditorMock({
  value,
  title,
  sourcePath,
  status = 'Preview source',
  readOnly = true,
  onChange,
}: MarkdownEditorMockProps) {
  return (
    <div className="markdown-editor-mock">
      <header className="markdown-editor-mock-header">
        <div>
          <p className="field-label">Markdown</p>
          <p className="markdown-editor-mock-title">{title}</p>
        </div>
        <span className="markdown-editor-mock-status">{status}</span>
      </header>

      <div className="markdown-editor-mock-path">{sourcePath ?? 'Unsaved markdown buffer'}</div>

      <textarea
        className="markdown-editor-mock-input"
        aria-label="Markdown source"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      />
    </div>
  );
}
