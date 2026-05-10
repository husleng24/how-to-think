import { Settings } from 'lucide-react';

import {
  getAiProviderHealthLabel,
} from '../application/providerSetup';
import { getProviderRunAvailability } from '../application/providerAvailability';
import type {
  AiProviderSettings,
} from '../types';

interface ProviderSelectorProps {
  settings: AiProviderSettings;
  selectedProviderId: string | null;
  onSelectProvider(providerId: string | null): void;
  onOpenSettings?: () => void;
}

export function ProviderSelector({
  settings,
  selectedProviderId,
  onSelectProvider,
  onOpenSettings,
}: ProviderSelectorProps) {
  const availability = getProviderRunAvailability(settings, selectedProviderId);

  return (
    <section className="ai-assistant-section" aria-label="AI provider">
      <div className="ai-assistant-section-heading">
        <div>
          <p className="panel-kicker">Provider</p>
          <h2>{availability.provider?.displayName ?? 'No provider'}</h2>
        </div>
        <span className={`ai-assistant-status${availability.usable ? ' ready' : ' blocked'}`}>
          {availability.usable ? 'Ready' : 'Blocked'}
        </span>
      </div>

      {settings.providers.length > 0 ? (
        <label className="ai-assistant-field">
          <span>Provider</span>
          <select
            aria-label="AI provider"
            value={selectedProviderId ?? ''}
            onChange={(event) => onSelectProvider(event.target.value || null)}
          >
            {settings.providers.map((provider) => (
              <option value={provider.id} key={provider.id}>
                {provider.displayName} - {getAiProviderHealthLabel(provider.lastHealthStatus?.status)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <p className="ai-assistant-provider-message">
        <strong>{availability.reason}</strong>
        <span>{availability.nextAction}</span>
      </p>

      {onOpenSettings ? (
        <button className="text-button ai-assistant-compact-action" type="button" onClick={onOpenSettings}>
          <Settings size={15} />
          Provider settings
        </button>
      ) : null}
    </section>
  );
}
