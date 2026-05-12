import type {
  AiProviderConfig,
  AiProviderConfigInput,
  AiProviderHealthState,
  AiProviderKind,
  AiProviderSettings,
  AiProviderSetupState,
} from '../types';

export const defaultAiProviderSettings: AiProviderSettings = {
  activeProviderId: null,
  providers: [],
};

export const defaultProviderTimeoutSeconds = 30;
export const defaultProviderMaxOutputBytes = 64 * 1024;

export type AiProviderStatusTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'muted';

export type AiProviderRuntimeStatusKind =
  | 'loading'
  | 'unconfigured'
  | 'blocked'
  | 'ready'
  | 'error';

export interface AiProviderRuntimeStatus {
  kind: AiProviderRuntimeStatusKind;
  label: string;
  detail: string;
  tone: AiProviderStatusTone;
  providerName?: string;
}

export type AiProviderSettingsPersistenceKind =
  | 'loading'
  | 'empty'
  | 'draft'
  | 'dirty'
  | 'persisted'
  | 'saving'
  | 'checking'
  | 'removing'
  | 'error';

export interface AiProviderSettingsPersistenceState {
  kind: AiProviderSettingsPersistenceKind;
  label: string;
  detail: string;
  tone: AiProviderStatusTone;
}

export function createDefaultAiProviderInput(
  kind: AiProviderKind = 'codex',
): AiProviderConfigInput {
  return {
    displayName: getAiProviderKindLabel(kind),
    kind,
    executablePath: '',
    argumentTemplate: [],
    healthCheckArgs: ['--version'],
    timeoutSeconds: defaultProviderTimeoutSeconds,
    maxOutputBytes: defaultProviderMaxOutputBytes,
    enabled: true,
  };
}

export function getAiProviderSetupState(
  settings: AiProviderSettings = defaultAiProviderSettings,
): AiProviderSetupState {
  if (settings.providers.length === 0) {
    return {
      usable: false,
      reason: 'No local AI provider is configured.',
      nextAction: 'Add a Codex, Claude, or generic executable provider.',
    };
  }

  const activeProvider = settings.providers.find(
    (provider) => provider.id === settings.activeProviderId,
  );
  if (!activeProvider) {
    return {
      usable: false,
      reason: 'No active AI provider is selected.',
      nextAction: 'Select one configured provider as active.',
    };
  }

  if (!activeProvider.enabled) {
    return {
      usable: false,
      reason: `${activeProvider.displayName} is disabled.`,
      nextAction: 'Enable the provider or choose a different active provider.',
      activeProvider,
    };
  }

  const health = activeProvider.lastHealthStatus;
  if (!health || health.status === 'unknown') {
    return {
      usable: false,
      reason: `${activeProvider.displayName} has not passed a health check.`,
      nextAction: 'Run a health check before starting an AI conversation.',
      activeProvider,
    };
  }

  if (health.status !== 'ok') {
    return {
      usable: false,
      reason: health.message,
      nextAction: getAiProviderHealthNextAction(health.status),
      activeProvider,
    };
  }

  return {
    usable: true,
    reason: `${activeProvider.displayName} is ready.`,
    nextAction: 'Start an AI conversation.',
    activeProvider,
  };
}

export function getAiProviderRuntimeStatus(input: {
  settings: AiProviderSettings;
  setupState: AiProviderSetupState;
  loading: boolean;
  error: string | null;
}): AiProviderRuntimeStatus {
  if (input.loading) {
    return {
      kind: 'loading',
      label: 'AI loading',
      detail: 'Reading saved provider settings.',
      tone: 'info',
    };
  }

  if (input.error) {
    return {
      kind: 'error',
      label: 'AI settings error',
      detail: input.error,
      tone: 'danger',
    };
  }

  if (input.setupState.usable) {
    return {
      kind: 'ready',
      label: 'AI ready',
      detail: input.setupState.reason,
      tone: 'success',
      providerName: input.setupState.activeProvider?.displayName,
    };
  }

  return {
    kind: input.settings.providers.length === 0 ? 'unconfigured' : 'blocked',
    label: 'AI blocked',
    detail: `${input.setupState.reason} ${input.setupState.nextAction}`,
    tone: input.settings.providers.length === 0 ? 'muted' : 'warning',
    providerName: input.setupState.activeProvider?.displayName,
  };
}

export function getAiProviderSettingsPersistenceState(input: {
  loading: boolean;
  error: string | null;
  pendingAction: string | null;
  formDirty: boolean;
  selectedProviderId: string | null;
  providerCount: number;
}): AiProviderSettingsPersistenceState {
  if (input.loading) {
    return {
      kind: 'loading',
      label: 'Loading saved settings',
      detail: 'Provider settings are being read from the desktop settings service.',
      tone: 'info',
    };
  }

  if (input.error) {
    return {
      kind: 'error',
      label: 'Settings sync needs attention',
      detail: input.error,
      tone: 'danger',
    };
  }

  if (input.pendingAction === 'save') {
    return {
      kind: 'saving',
      label: 'Saving provider settings',
      detail: 'Changes are being persisted through the settings service.',
      tone: 'info',
    };
  }

  if (input.pendingAction?.startsWith('check')) {
    return {
      kind: 'checking',
      label: 'Checking provider health',
      detail: 'Health status will be reflected in the saved provider entry.',
      tone: 'info',
    };
  }

  if (input.pendingAction?.startsWith('remove')) {
    return {
      kind: 'removing',
      label: 'Removing provider settings',
      detail: 'The selected provider entry is being removed from saved settings.',
      tone: 'warning',
    };
  }

  if (!input.selectedProviderId && input.providerCount === 0) {
    return {
      kind: 'empty',
      label: 'No provider settings saved',
      detail: 'Fill the form and save to persist the first local provider.',
      tone: 'muted',
    };
  }

  if (!input.selectedProviderId) {
    return {
      kind: 'draft',
      label: 'New provider draft',
      detail: 'Save this draft to add it to persisted provider settings.',
      tone: 'info',
    };
  }

  if (input.formDirty) {
    return {
      kind: 'dirty',
      label: 'Unsaved provider edits',
      detail: 'Save to persist these settings before switching providers.',
      tone: 'warning',
    };
  }

  return {
    kind: 'persisted',
    label: 'Provider settings saved',
    detail: 'Current provider settings match the persisted desktop settings.',
    tone: 'success',
  };
}

export function parseArgumentText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function formatArgumentText(args: string[] | undefined): string {
  return (args ?? []).join('\n');
}

export function parseEnvironmentAllowlistText(text: string): string[] | undefined {
  const names = text
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  return names.length > 0 ? names : undefined;
}

export function formatEnvironmentAllowlistText(names: string[] | undefined): string {
  return (names ?? []).join('\n');
}

export function getAiProviderKindLabel(kind: AiProviderKind): string {
  switch (kind) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'generic':
      return 'Generic executable';
  }
}

export function getAiProviderHealthLabel(status: AiProviderHealthState | undefined): string {
  switch (status) {
    case 'ok':
      return 'Healthy';
    case 'missingExecutable':
      return 'Missing executable';
    case 'permissionDenied':
      return 'Permission denied';
    case 'authRequired':
      return 'Login required';
    case 'timeout':
      return 'Timed out';
    case 'nonZeroExit':
      return 'Command failed';
    case 'invalidConfig':
      return 'Invalid config';
    case 'unknown':
    case undefined:
      return 'Not checked';
  }
}

export function getAiProviderHealthNextAction(status: AiProviderHealthState): string {
  switch (status) {
    case 'missingExecutable':
      return 'Choose an existing executable path and save the provider.';
    case 'permissionDenied':
      return 'Fix file permissions or choose an executable that the app can run.';
    case 'authRequired':
      return 'Log in with the provider CLI outside the app, then run health check again.';
    case 'timeout':
      return 'Increase the timeout or choose a health command that exits quickly.';
    case 'nonZeroExit':
      return 'Review the provider output, adjust the health arguments, and retry.';
    case 'invalidConfig':
      return 'Fix the provider settings and save again.';
    case 'unknown':
      return 'Run a health check before starting an AI conversation.';
    case 'ok':
      return 'Start an AI conversation.';
  }
}

export function findEditableProvider(
  settings: AiProviderSettings,
  providerId: string | null,
): AiProviderConfig | null {
  if (!providerId) {
    return null;
  }

  return settings.providers.find((provider) => provider.id === providerId) ?? null;
}
