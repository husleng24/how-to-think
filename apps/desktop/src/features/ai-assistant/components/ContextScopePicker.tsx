import {
  FileText,
  FolderTree,
  GitBranch,
  LocateFixed,
} from 'lucide-react';

import { getAiContextScopeLabel } from '../application/contextSelectors';
import type { AiContextScope } from '../types';

interface ContextScopePickerProps {
  value: AiContextScope;
  availableScopes: Record<AiContextScope, boolean>;
  onChange(scope: AiContextScope): void;
}

const scopes: AiContextScope[] = [
  'selectedNode',
  'selectedBranch',
  'currentFile',
  'workspaceSummary',
];

export function ContextScopePicker({
  value,
  availableScopes,
  onChange,
}: ContextScopePickerProps) {
  return (
    <section className="ai-assistant-section" aria-label="AI context scope">
      <div className="ai-assistant-section-heading">
        <div>
          <p className="panel-kicker">Context</p>
          <h2>{getAiContextScopeLabel(value)}</h2>
        </div>
      </div>

      <div className="ai-context-scope-grid" role="group" aria-label="Context scope">
        {scopes.map((scope) => (
          <button
            className={`ai-context-scope${value === scope ? ' selected' : ''}`}
            type="button"
            aria-pressed={value === scope}
            disabled={!availableScopes[scope]}
            key={scope}
            onClick={() => onChange(scope)}
          >
            {iconForScope(scope)}
            <span>{getAiContextScopeLabel(scope)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function iconForScope(scope: AiContextScope) {
  switch (scope) {
    case 'selectedNode':
      return <LocateFixed size={15} aria-hidden="true" />;
    case 'selectedBranch':
      return <GitBranch size={15} aria-hidden="true" />;
    case 'currentFile':
      return <FileText size={15} aria-hidden="true" />;
    case 'workspaceSummary':
      return <FolderTree size={15} aria-hidden="true" />;
  }
}
