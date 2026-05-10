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
