import { useCallback, useEffect, useMemo, useState } from 'react';

import { tauriAiProviderClient } from '../infrastructure/providerApi';
import type { AiProviderClient } from '../infrastructure/providerApi';
import type {
  AiProviderConfigInput,
  AiProviderHealthStatus,
  AiProviderSettings,
  AiProviderSetupState,
} from '../types';
import {
  defaultAiProviderSettings,
  getAiProviderSetupState,
} from './providerSetup';

export interface AiProviderSettingsController {
  settings: AiProviderSettings;
  setupState: AiProviderSetupState;
  loading: boolean;
  error: string | null;
  reload(): Promise<AiProviderSettings>;
  saveProvider(provider: AiProviderConfigInput): Promise<AiProviderSettings>;
  selectProvider(providerId: string | null): Promise<AiProviderSettings>;
  removeProvider(providerId: string): Promise<AiProviderSettings>;
  checkProviderHealth(providerId: string): Promise<AiProviderHealthStatus>;
  clearError(): void;
}

export function useAiProviderSettings(
  client: AiProviderClient = tauriAiProviderClient,
): AiProviderSettingsController {
  const [settings, setSettings] = useState<AiProviderSettings>(defaultAiProviderSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextSettings = await client.listProviders();
      setSettings(nextSettings);
      return nextSettings;
    } catch (caughtError) {
      setError(toErrorMessage(caughtError));
      throw caughtError;
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    client
      .listProviders()
      .then((nextSettings) => {
        if (active) {
          setSettings(nextSettings);
        }
      })
      .catch((caughtError) => {
        if (active) {
          setError(toErrorMessage(caughtError));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [client]);

  const saveProvider = useCallback(
    async (provider: AiProviderConfigInput) => {
      setError(null);
      try {
        const nextSettings = await client.saveProvider(provider);
        setSettings(nextSettings);
        return nextSettings;
      } catch (caughtError) {
        setError(toErrorMessage(caughtError));
        throw caughtError;
      }
    },
    [client],
  );

  const selectProvider = useCallback(
    async (providerId: string | null) => {
      setError(null);
      try {
        const nextSettings = await client.selectProvider(providerId);
        setSettings(nextSettings);
        return nextSettings;
      } catch (caughtError) {
        setError(toErrorMessage(caughtError));
        throw caughtError;
      }
    },
    [client],
  );

  const removeProvider = useCallback(
    async (providerId: string) => {
      setError(null);
      try {
        const nextSettings = await client.removeProvider(providerId);
        setSettings(nextSettings);
        return nextSettings;
      } catch (caughtError) {
        setError(toErrorMessage(caughtError));
        throw caughtError;
      }
    },
    [client],
  );

  const checkProviderHealth = useCallback(
    async (providerId: string) => {
      setError(null);
      try {
        const status = await client.checkProviderHealth(providerId);
        const nextSettings = await client.listProviders();
        setSettings(nextSettings);
        return status;
      } catch (caughtError) {
        setError(toErrorMessage(caughtError));
        throw caughtError;
      }
    },
    [client],
  );

  const setupState = useMemo(() => getAiProviderSetupState(settings), [settings]);

  return {
    settings,
    setupState,
    loading,
    error,
    reload,
    saveProvider,
    selectProvider,
    removeProvider,
    checkProviderHealth,
    clearError: () => setError(null),
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return 'AI provider settings failed unexpectedly.';
}
