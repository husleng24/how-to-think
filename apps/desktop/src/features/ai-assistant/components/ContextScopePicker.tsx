import { AiContextScopeControls } from '../../ai';
import type { AiContextScope } from '../types';

interface ContextScopePickerProps {
  value: AiContextScope;
  availableScopes: Record<AiContextScope, boolean>;
  onChange(scope: AiContextScope): void;
}

export function ContextScopePicker({
  value,
  availableScopes,
  onChange,
}: ContextScopePickerProps) {
  return <AiContextScopeControls value={value} availableScopes={availableScopes} onChange={onChange} />;
}
