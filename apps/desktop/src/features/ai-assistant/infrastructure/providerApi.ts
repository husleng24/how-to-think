import { invoke } from '@tauri-apps/api/core';

import {
  defaultAiProviderSettings,
} from '../application/providerSetup';
import type {
  AiProviderConfigInput,
  AiProviderHealthStatus,
  AiProviderSettings,
} from '../types';

export interface AiProviderClient {
  listProviders(): Promise<AiProviderSettings>;
  saveProvider(provider: AiProviderConfigInput): Promise<AiProviderSettings>;
  selectProvider(providerId: string | null): Promise<AiProviderSettings>;
  removeProvider(providerId: string): Promise<AiProviderSettings>;
  checkProviderHealth(providerId: string): Promise<AiProviderHealthStatus>;
}

export const tauriAiProviderClient: AiProviderClient = {
  listProviders() {
    if (!canUseTauriInvoke()) {
      return Promise.resolve(defaultAiProviderSettings);
    }

    return invoke<AiProviderSettings>('list_ai_providers');
  },
  saveProvider(provider) {
    ensureTauriRuntime();
    return invoke<AiProviderSettings>('save_ai_provider', { provider });
  },
  selectProvider(providerId) {
    ensureTauriRuntime();
    return invoke<AiProviderSettings>('select_ai_provider', { providerId });
  },
  removeProvider(providerId) {
    ensureTauriRuntime();
    return invoke<AiProviderSettings>('remove_ai_provider', { providerId });
  },
  checkProviderHealth(providerId) {
    ensureTauriRuntime();
    return invoke<AiProviderHealthStatus>('check_ai_provider_health', { providerId });
  },
};

function ensureTauriRuntime(): void {
  if (!canUseTauriInvoke()) {
    throw new Error('AI provider settings are only available in the desktop runtime.');
  }
}

function canUseTauriInvoke(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
  );
}
