import { describe, expect, it } from 'vitest';

import type { AiProviderConfig, AiProviderSettings } from '../types';
import {
  createDefaultAiProviderInput,
  formatArgumentText,
  getAiProviderRuntimeStatus,
  getAiProviderHealthNextAction,
  getAiProviderSettingsPersistenceState,
  getAiProviderSetupState,
  parseArgumentText,
  parseEnvironmentAllowlistText,
} from './providerSetup';

describe('AI provider setup', () => {
  it('blocks AI conversation when no provider exists', () => {
    const state = getAiProviderSetupState({ activeProviderId: null, providers: [] });

    expect(state.usable).toBe(false);
    expect(state.nextAction).toMatch(/Add a Codex/);
  });

  it('requires an enabled active provider with passing health', () => {
    const provider = providerFixture({
      lastHealthStatus: {
        status: 'ok',
        checkedAt: '2026-05-10T00:00:00Z',
        message: 'Provider responded.',
      },
    });
    const settings: AiProviderSettings = {
      activeProviderId: provider.id,
      providers: [provider],
    };

    const state = getAiProviderSetupState(settings);

    expect(state.usable).toBe(true);
    expect(state.activeProvider?.id).toBe(provider.id);
  });

  it('returns actionable health failure copy', () => {
    const provider = providerFixture({
      lastHealthStatus: {
        status: 'authRequired',
        checkedAt: '2026-05-10T00:00:00Z',
        message: 'Login required.',
      },
    });

    const state = getAiProviderSetupState({
      activeProviderId: provider.id,
      providers: [provider],
    });

    expect(state.usable).toBe(false);
    expect(state.nextAction).toBe(getAiProviderHealthNextAction('authRequired'));
  });

  it('parses argument text as one argv entry per line', () => {
    const parsed = parseArgumentText('exec\n--model gpt-5\n\n-');

    expect(parsed).toEqual(['exec', '--model gpt-5', '-']);
    expect(formatArgumentText(parsed)).toBe('exec\n--model gpt-5\n-');
  });

  it('parses environment allowlists from whitespace and comma text', () => {
    expect(parseEnvironmentAllowlistText('HOME, APPDATA\nUSERPROFILE')).toEqual([
      'HOME',
      'APPDATA',
      'USERPROFILE',
    ]);
    expect(parseEnvironmentAllowlistText('   ')).toBeUndefined();
  });

  it('creates provider defaults without storing secrets', () => {
    const provider = createDefaultAiProviderInput('claude');

    expect(provider.displayName).toBe('Claude');
    expect(provider.healthCheckArgs).toEqual(['--version']);
    expect(provider.environmentAllowlist).toBeUndefined();
  });

  it('models runtime and persistence status for AI settings surfaces', () => {
    const provider = providerFixture({
      lastHealthStatus: {
        status: 'ok',
        checkedAt: '2026-05-10T00:00:00Z',
        message: 'Provider responded.',
      },
    });
    const settings: AiProviderSettings = {
      activeProviderId: provider.id,
      providers: [provider],
    };
    const setupState = getAiProviderSetupState(settings);

    expect(
      getAiProviderRuntimeStatus({
        settings,
        setupState,
        loading: false,
        error: null,
      }),
    ).toMatchObject({
      kind: 'ready',
      label: 'AI ready',
      tone: 'success',
      providerName: 'Local Codex',
    });

    expect(
      getAiProviderSettingsPersistenceState({
        loading: false,
        error: null,
        pendingAction: null,
        formDirty: true,
        selectedProviderId: provider.id,
        providerCount: 1,
      }),
    ).toMatchObject({
      kind: 'dirty',
      label: 'Unsaved provider edits',
      tone: 'warning',
    });

    expect(
      getAiProviderSettingsPersistenceState({
        loading: false,
        error: null,
        pendingAction: 'save',
        formDirty: true,
        selectedProviderId: provider.id,
        providerCount: 1,
      }),
    ).toMatchObject({
      kind: 'saving',
      label: 'Saving provider settings',
    });
  });
});

function providerFixture(overrides: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return {
    id: 'provider-1',
    displayName: 'Local Codex',
    kind: 'codex',
    executablePath: 'C:\\Tools\\codex.exe',
    argumentTemplate: [],
    healthCheckArgs: ['--version'],
    timeoutSeconds: 30,
    maxOutputBytes: 65536,
    enabled: true,
    ...overrides,
  };
}
