import { AlertTriangle, CircleAlert, Info } from 'lucide-react';

import type {
  CompatibilityDiagnostic,
  LinkIndexSnapshot,
} from '../../types/markdownLifecycle';
import type { SaveStatus } from '../workspace';
import type { CompatibilityDiagnosticItem } from './types';
import './CompatibilityDiagnosticsPanel.css';

interface CompatibilityDiagnosticsPanelProps {
  documentDiagnostics?: CompatibilityDiagnostic[];
  saveStatus?: SaveStatus;
  linkIndex?: LinkIndexSnapshot | null;
}

export function CompatibilityDiagnosticsPanel({
  documentDiagnostics = [],
  saveStatus,
  linkIndex,
}: CompatibilityDiagnosticsPanelProps) {
  const diagnostics = collectCompatibilityDiagnostics({
    documentDiagnostics,
    saveDiagnostics: saveStatus?.diagnostics ?? [],
    linkDiagnostics: linkIndex?.diagnostics ?? [],
  });

  return (
    <section className="compat-diagnostics-panel" aria-label="Markdown compatibility diagnostics">
      <div className="compat-diagnostics-heading">
        <p className="field-label">Compatibility</p>
        <span className={`compat-diagnostics-count${diagnostics.length > 0 ? ' has-items' : ''}`}>
          {diagnostics.length}
        </span>
      </div>

      {diagnostics.length > 0 ? (
        <ul className="compat-diagnostics-list">
          {diagnostics.map((diagnostic) => (
            <li className={`compat-diagnostic-item is-${diagnostic.severity}`} key={diagnostic.id}>
              <span className="compat-diagnostic-icon" aria-hidden="true">
                {iconForSeverity(diagnostic.severity)}
              </span>
              <span>
                <strong>{labelForDiagnostic(diagnostic)}</strong>
                <span>{diagnostic.message}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="compat-diagnostics-empty">No Markdown compatibility issues.</p>
      )}
    </section>
  );
}

function collectCompatibilityDiagnostics({
  documentDiagnostics = [],
  saveDiagnostics = [],
  linkDiagnostics = [],
}: {
  documentDiagnostics?: CompatibilityDiagnostic[];
  saveDiagnostics?: CompatibilityDiagnostic[];
  linkDiagnostics?: LinkIndexSnapshot['diagnostics'];
}): CompatibilityDiagnosticItem[] {
  const items: CompatibilityDiagnosticItem[] = [];

  for (const [index, diagnostic] of documentDiagnostics.entries()) {
    items.push({
      id: `parser:${diagnostic.code}:${index}`,
      source: 'parser',
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      relativePath: diagnostic.origin?.sourcePath,
      line: diagnostic.origin?.span.startLine,
    });
  }

  for (const [index, diagnostic] of saveDiagnostics.entries()) {
    items.push({
      id: `save:${diagnostic.code}:${index}`,
      source: 'save',
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      relativePath: diagnostic.origin?.sourcePath,
      line: diagnostic.origin?.span.startLine,
    });
  }

  for (const [index, diagnostic] of linkDiagnostics.entries()) {
    items.push({
      id: `links:${diagnostic.code}:${index}`,
      source: 'links',
      severity: normalizeLinkSeverity(diagnostic.severity),
      code: diagnostic.code,
      message: diagnostic.message,
      relativePath: diagnostic.sourceRelativePath,
    });
  }

  return items;
}

function normalizeLinkSeverity(severity: string): CompatibilityDiagnosticItem['severity'] {
  return severity === 'error' || severity === 'warning' || severity === 'info' ? severity : 'warning';
}

function labelForDiagnostic(diagnostic: CompatibilityDiagnosticItem): string {
  const sourceLabel =
    diagnostic.source === 'parser' ? 'Parser' : diagnostic.source === 'save' ? 'Save' : 'Links';
  const location = diagnostic.relativePath
    ? diagnostic.line
      ? ` - ${diagnostic.relativePath}:${diagnostic.line}`
      : ` - ${diagnostic.relativePath}`
    : '';

  return `${sourceLabel}${location}`;
}

function iconForSeverity(severity: CompatibilityDiagnosticItem['severity']) {
  switch (severity) {
    case 'error':
      return <CircleAlert size={15} />;
    case 'warning':
      return <AlertTriangle size={15} />;
    case 'info':
      return <Info size={15} />;
  }
}
