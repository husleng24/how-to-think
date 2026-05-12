import {
  FileText,
  FolderTree,
  GitBranch,
  LocateFixed,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { AiContextScope } from '../../ai-assistant/types';

export interface AiContextScopeControlsProps {
  value: AiContextScope;
  availableScopes: Record<AiContextScope, boolean>;
  onChange(scope: AiContextScope): void;
}

const contextScopeOptions: readonly AiContextScope[] = [
  'selectedNode',
  'selectedBranch',
  'currentFile',
  'workspaceSummary',
];

export function AiContextScopeControls({
  value,
  availableScopes,
  onChange,
}: AiContextScopeControlsProps) {
  return (
    <section className="ai-assistant-section" aria-label="AI context scope">
      <div className="ai-assistant-section-heading">
        <div>
          <p className="panel-kicker">Context</p>
          <h2>{getAiContextScopeDisplayName(value)}</h2>
        </div>
      </div>

      <div className="ai-context-scope-grid" role="group" aria-label="Context scope">
        {contextScopeOptions.map((scope) => (
          <button
            className={`ai-context-scope${value === scope ? ' selected' : ''}`}
            type="button"
            aria-pressed={value === scope}
            disabled={!availableScopes[scope]}
            key={scope}
            onClick={() => onChange(scope)}
          >
            {iconForScope(scope)}
            <span>{getAiContextScopeDisplayName(scope)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function getAiContextScopeDisplayName(scope: AiContextScope): string {
  switch (scope) {
    case 'selectedNode':
      return 'Selected node';
    case 'selectedBranch':
      return 'Selected branch';
    case 'currentFile':
      return 'Current file';
    case 'workspaceSummary':
      return 'Workspace summary';
  }
}

function iconForScope(scope: AiContextScope): ReactNode {
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
