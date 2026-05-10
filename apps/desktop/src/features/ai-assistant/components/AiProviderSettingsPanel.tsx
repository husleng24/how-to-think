import {
  Activity,
  CheckCircle2,
  Circle,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { AiProviderSettingsController } from '../application/useAiProviderSettings';
import type { AiProviderConfig, AiProviderConfigInput, AiProviderKind } from '../types';
import {
  createDefaultAiProviderInput,
  findEditableProvider,
  formatArgumentText,
  formatEnvironmentAllowlistText,
  getAiProviderHealthLabel,
  getAiProviderKindLabel,
  parseArgumentText,
  parseEnvironmentAllowlistText,
} from '../application/providerSetup';
import './AiProviderSettingsPanel.css';

interface AiProviderSettingsPanelProps {
  controller: AiProviderSettingsController;
}

interface ProviderFormState {
  id?: string;
  displayName: string;
  kind: AiProviderKind;
  executablePath: string;
  argumentText: string;
  healthCheckText: string;
  environmentText: string;
  workingDirectory: string;
  timeoutSeconds: string;
  maxOutputBytes: string;
  enabled: boolean;
}

const providerKinds: AiProviderKind[] = ['codex', 'claude', 'generic'];

export function AiProviderSettingsPanel({ controller }: AiProviderSettingsPanelProps) {
  const { settings, setupState } = controller;
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    settings.activeProviderId ?? settings.providers[0]?.id ?? null,
  );
  const [form, setForm] = useState<ProviderFormState>(() =>
    providerToForm(createDefaultAiProviderInput('codex')),
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const editableProvider = useMemo(
    () => findEditableProvider(settings, selectedProviderId),
    [selectedProviderId, settings],
  );

  useEffect(() => {
    if (editableProvider) {
      setForm(providerToForm(editableProvider));
      return;
    }

    if (!selectedProviderId) {
      setForm(providerToForm(createDefaultAiProviderInput('codex')));
    }
  }, [editableProvider, selectedProviderId]);

  useEffect(() => {
    if (
      selectedProviderId &&
      !settings.providers.some((provider) => provider.id === selectedProviderId)
    ) {
      setSelectedProviderId(settings.activeProviderId ?? settings.providers[0]?.id ?? null);
    }
  }, [selectedProviderId, settings]);

  const activeHealth = setupState.activeProvider?.lastHealthStatus;
  const activeHealthStatus = activeHealth?.status ?? 'unknown';

  async function saveCurrentProvider() {
    const provider = formToProviderInput(form);
    setPendingAction('save');
    try {
      const nextSettings = await controller.saveProvider(provider);
      setSelectedProviderId(provider.id ?? null);
      if (provider.enabled && !nextSettings.activeProviderId) {
        await controller.selectProvider(provider.id ?? null);
      }
    } catch {
      // The controller owns the displayed error state.
    } finally {
      setPendingAction(null);
    }
  }

  async function checkCurrentProvider() {
    const providerId = form.id;
    if (!providerId) {
      await saveCurrentProvider();
      return;
    }

    setPendingAction(`check:${providerId}`);
    try {
      await controller.checkProviderHealth(providerId);
    } catch {
      // The controller owns the displayed error state.
    } finally {
      setPendingAction(null);
    }
  }

  async function removeCurrentProvider() {
    if (!form.id) {
      setSelectedProviderId(null);
      setForm(providerToForm(createDefaultAiProviderInput('codex')));
      return;
    }

    setPendingAction(`remove:${form.id}`);
    try {
      await controller.removeProvider(form.id);
      setSelectedProviderId(null);
    } catch {
      // The controller owns the displayed error state.
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className="ai-provider-panel" aria-label="AI provider settings">
      <div className="ai-provider-heading">
        <div>
          <p className="panel-kicker">AI provider</p>
          <h2>Local providers</h2>
        </div>
        <span className={`ai-provider-readiness${setupState.usable ? ' ready' : ' blocked'}`}>
          {setupState.usable ? 'Ready' : 'Blocked'}
        </span>
      </div>

      <p className="ai-provider-next-action">
        <strong>{setupState.reason}</strong>
        <span>{setupState.nextAction}</span>
      </p>

      <div className="ai-provider-list" aria-label="Configured AI providers">
        {settings.providers.length === 0 ? (
          <p className="ai-provider-empty">No providers saved.</p>
        ) : (
          settings.providers.map((provider) => (
            <div
              className={`ai-provider-row${provider.id === selectedProviderId ? ' selected' : ''}`}
              key={provider.id}
            >
              <button
                className="ai-provider-select"
                type="button"
                onClick={() => setSelectedProviderId(provider.id)}
              >
                {provider.id === settings.activeProviderId ? (
                  <CheckCircle2 size={16} aria-hidden="true" />
                ) : (
                  <Circle size={16} aria-hidden="true" />
                )}
                <span>
                  <strong>{provider.displayName}</strong>
                  <small>
                    {getAiProviderKindLabel(provider.kind)} ·{' '}
                    {getAiProviderHealthLabel(provider.lastHealthStatus?.status)}
                  </small>
                </span>
              </button>
              <button
                className="icon-button compact"
                type="button"
                aria-label={`Make ${provider.displayName} active`}
                title="Make active"
                disabled={!provider.enabled || provider.id === settings.activeProviderId}
                onClick={() => void controller.selectProvider(provider.id).catch(() => undefined)}
              >
                <CheckCircle2 size={15} />
              </button>
            </div>
          ))
        )}
      </div>

      <form
        className="ai-provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveCurrentProvider();
        }}
      >
        <div className="ai-provider-form-toolbar">
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setSelectedProviderId(null);
              setForm(providerToForm(createDefaultAiProviderInput('codex')));
            }}
          >
            <Plus size={15} />
            New
          </button>
          <button className="text-button" type="submit" disabled={pendingAction === 'save'}>
            <Save size={15} />
            Save
          </button>
          <button
            className="text-button"
            type="button"
            disabled={pendingAction?.startsWith('check')}
            onClick={() => void checkCurrentProvider()}
          >
            <Activity size={15} />
            Check
          </button>
          <button
            className="icon-button compact"
            type="button"
            aria-label="Remove provider"
            title="Remove provider"
            disabled={pendingAction?.startsWith('remove')}
            onClick={() => void removeCurrentProvider()}
          >
            <Trash2 size={15} />
          </button>
        </div>

        <label className="ai-provider-field">
          <span>Kind</span>
          <select
            value={form.kind}
            onChange={(event) => {
              const kind = event.target.value as AiProviderKind;
              setForm((current) => ({
                ...current,
                kind,
                displayName:
                  current.displayName === getAiProviderKindLabel(current.kind)
                    ? getAiProviderKindLabel(kind)
                    : current.displayName,
              }));
            }}
          >
            {providerKinds.map((kind) => (
              <option value={kind} key={kind}>
                {getAiProviderKindLabel(kind)}
              </option>
            ))}
          </select>
        </label>

        <label className="ai-provider-field">
          <span>Name</span>
          <input
            value={form.displayName}
            onChange={(event) =>
              setForm((current) => ({ ...current, displayName: event.target.value }))
            }
          />
        </label>

        <label className="ai-provider-field">
          <span>Executable path</span>
          <input
            value={form.executablePath}
            onChange={(event) =>
              setForm((current) => ({ ...current, executablePath: event.target.value }))
            }
            placeholder="C:\\Program Files\\Codex\\codex.exe"
          />
        </label>

        <label className="ai-provider-field">
          <span>Arguments</span>
          <textarea
            rows={3}
            value={form.argumentText}
            onChange={(event) =>
              setForm((current) => ({ ...current, argumentText: event.target.value }))
            }
          />
        </label>

        <label className="ai-provider-field">
          <span>Health args</span>
          <textarea
            rows={2}
            value={form.healthCheckText}
            onChange={(event) =>
              setForm((current) => ({ ...current, healthCheckText: event.target.value }))
            }
          />
        </label>

        <div className="ai-provider-number-grid">
          <label className="ai-provider-field">
            <span>Timeout</span>
            <input
              type="number"
              min={1}
              max={600}
              value={form.timeoutSeconds}
              onChange={(event) =>
                setForm((current) => ({ ...current, timeoutSeconds: event.target.value }))
              }
            />
          </label>
          <label className="ai-provider-field">
            <span>Output bytes</span>
            <input
              type="number"
              min={1024}
              max={1048576}
              value={form.maxOutputBytes}
              onChange={(event) =>
                setForm((current) => ({ ...current, maxOutputBytes: event.target.value }))
              }
            />
          </label>
        </div>

        <label className="ai-provider-field">
          <span>Working directory</span>
          <input
            value={form.workingDirectory}
            onChange={(event) =>
              setForm((current) => ({ ...current, workingDirectory: event.target.value }))
            }
          />
        </label>

        <label className="ai-provider-field">
          <span>Env allowlist</span>
          <textarea
            rows={2}
            value={form.environmentText}
            onChange={(event) =>
              setForm((current) => ({ ...current, environmentText: event.target.value }))
            }
          />
        </label>

        <label className="ai-provider-toggle">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) =>
              setForm((current) => ({ ...current, enabled: event.target.checked }))
            }
          />
          <span>Enabled</span>
        </label>
      </form>

      {activeHealth ? (
        <p className={`ai-provider-health ${activeHealthStatus}`}>
          <strong>{getAiProviderHealthLabel(activeHealthStatus)}</strong>
          <span>{activeHealth.message}</span>
        </p>
      ) : null}

      {controller.error ? (
        <p className="ai-provider-error" role="alert">
          {controller.error}
        </p>
      ) : null}

      {controller.loading ? <p className="ai-provider-empty">Loading providers.</p> : null}
    </section>
  );
}

function providerToForm(provider: AiProviderConfig | AiProviderConfigInput): ProviderFormState {
  return {
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    executablePath: provider.executablePath,
    argumentText: formatArgumentText(provider.argumentTemplate),
    healthCheckText: formatArgumentText(provider.healthCheckArgs),
    environmentText: formatEnvironmentAllowlistText(provider.environmentAllowlist),
    workingDirectory: provider.workingDirectory ?? '',
    timeoutSeconds: String(provider.timeoutSeconds),
    maxOutputBytes: String(provider.maxOutputBytes),
    enabled: provider.enabled,
  };
}

function formToProviderInput(form: ProviderFormState): AiProviderConfigInput {
  return {
    id: form.id ?? createProviderId(form.kind, form.displayName),
    displayName: form.displayName,
    kind: form.kind,
    executablePath: form.executablePath,
    argumentTemplate: parseArgumentText(form.argumentText),
    healthCheckArgs: parseArgumentText(form.healthCheckText),
    environmentAllowlist: parseEnvironmentAllowlistText(form.environmentText),
    workingDirectory: optionalText(form.workingDirectory),
    timeoutSeconds: parseInteger(form.timeoutSeconds, 30),
    maxOutputBytes: parseInteger(form.maxOutputBytes, 64 * 1024),
    enabled: form.enabled,
  };
}

function createProviderId(kind: AiProviderKind, displayName: string): string {
  const slug =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'provider';
  return `${kind}-${slug}-${Date.now().toString(36)}`;
}

function parseInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
