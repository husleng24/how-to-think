import type {
  AiProviderConfig,
  AiProviderHealthState,
  AiProviderSettings,
} from '../types';
import { getAiProviderHealthNextAction } from './providerSetup';

export interface AiProviderRunAvailability {
  usable: boolean;
  reason: string;
  nextAction: string;
  provider?: AiProviderConfig;
}

export function getProviderRunAvailability(
  settings: AiProviderSettings,
  selectedProviderId: string | null,
): AiProviderRunAvailability {
  if (settings.providers.length === 0) {
    return {
      usable: false,
      reason: 'No local AI provider is configured.',
      nextAction: 'Add a Codex, Claude, or generic executable provider before sending.',
    };
  }

  const providerId = selectedProviderId ?? settings.activeProviderId ?? settings.providers[0]?.id ?? null;
  const provider = settings.providers.find((candidate) => candidate.id === providerId);

  if (!provider) {
    return {
      usable: false,
      reason: 'No active AI provider is selected.',
      nextAction: 'Select one configured provider before sending.',
    };
  }

  if (!provider.enabled) {
    return {
      usable: false,
      reason: `${provider.displayName} is disabled.`,
      nextAction: 'Enable this provider or choose another healthy provider.',
      provider,
    };
  }

  const healthStatus: AiProviderHealthState = provider.lastHealthStatus?.status ?? 'unknown';
  if (healthStatus !== 'ok') {
    return {
      usable: false,
      reason: provider.lastHealthStatus?.message ?? `${provider.displayName} has not passed a health check.`,
      nextAction: getAiProviderHealthNextAction(healthStatus),
      provider,
    };
  }

  return {
    usable: true,
    reason: `${provider.displayName} is ready.`,
    nextAction: 'Ask a question using the selected context snapshot.',
    provider,
  };
}
