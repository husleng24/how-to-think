import {
  CLI_CAPABILITY_MATRIX,
  CLI_COMMANDS,
  CLI_CONFIRMATION_RULES,
  CLI_ERROR_CATALOG,
  CLI_EXIT_CODE_CLASSES,
  CLI_RESULT_ENVELOPE_SCHEMA,
  CLI_RESULT_ENVELOPE_FIXTURES,
  REQUIRED_CAPABILITY_SOURCE_ISSUES,
  confirmationRequiredEnvelope,
  createCliConfirmationRequiredEnvelope,
  createCliSuccessEnvelope,
  destructiveDeleteConfirmation,
  exitCodeForEnvelope,
  exitCodeForErrorCode,
  serializeCliResultEnvelope,
  successfulWorkspaceListEnvelope,
  validateCliContractRegistry,
  validateCliResultEnvelope,
} from '../index';
import type { CliErrorCode, CliResultEnvelope } from './types';

describe('CLI contract registry', () => {
  it('keeps every registered command covered by the capability matrix', () => {
    expect(validateCliContractRegistry()).toEqual([]);
  });

  it('covers every source capability issue required by VIT-96', () => {
    const matrixIssues = new Set(CLI_CAPABILITY_MATRIX.map((entry) => entry.sourceIssue));

    expect([...REQUIRED_CAPABILITY_SOURCE_ISSUES].sort()).toEqual(
      [...matrixIssues].filter((issue) => issue !== 'VIT-96').sort(),
    );
  });

  it('keeps confirmation command definitions aligned with reusable confirmation rules', () => {
    const ruleCommandIds = new Set(
      CLI_CONFIRMATION_RULES.flatMap((rule) => [...rule.commandIds]),
    );
    const commandIdsRequiringConfirmation = CLI_COMMANDS.filter(
      (command) => (command.confirmationKinds?.length ?? 0) > 0,
    ).map((command) => command.id);

    expect(commandIdsRequiringConfirmation.every((commandId) => ruleCommandIds.has(commandId)))
      .toBe(true);
  });
});

describe('CLI result envelope schema and serialization', () => {
  it('documents stable snake_case result fields in the reusable schema fixture', () => {
    expect(CLI_RESULT_ENVELOPE_SCHEMA.required).toEqual([
      'ok',
      'contract_version',
      'schema_version',
      'operation_id',
      'data',
      'warnings',
      'error',
      'needs_confirmation',
      'ui_action',
    ]);
  });

  it('serializes successful envelopes with version fields and without error state', () => {
    const serialized = serializeCliResultEnvelope(successfulWorkspaceListEnvelope);
    const parsed = JSON.parse(serialized);

    expect(parsed).toMatchObject({
      ok: true,
      contract_version: '2026-05-10.v1',
      schema_version: '1.0.0',
      operation_id: 'op_list_workspace_files',
      error: null,
      needs_confirmation: null,
      ui_action: null,
    });
    expect(parsed.data.files[0].relativePath).toBe('notes/root.md');
    expect(validateCliResultEnvelope(successfulWorkspaceListEnvelope)).toEqual([]);
  });

  it('keeps reusable fixture envelopes valid against local envelope invariants', () => {
    expect(
      CLI_RESULT_ENVELOPE_FIXTURES.flatMap((fixture) => validateCliResultEnvelope(fixture)),
    ).toEqual([]);
  });
});

describe('CLI confirmation behavior', () => {
  it('serializes confirmation-required operations as non-success with deterministic non-interactive behavior', () => {
    const serialized = serializeCliResultEnvelope(confirmationRequiredEnvelope);
    const parsed = JSON.parse(serialized);

    expect(parsed).toMatchObject({
      ok: false,
      data: null,
      error: {
        code: 'confirmation_required',
        recoverable: true,
      },
      needs_confirmation: {
        command_id: 'workspace.file.delete',
        confirm_token: 'confirm_delete_notes_old_topic_md',
        non_interactive: 'return_confirmation_required',
      },
      ui_action: null,
    });
    expect(exitCodeForEnvelope(confirmationRequiredEnvelope)).toBe(30);
    expect(validateCliResultEnvelope(confirmationRequiredEnvelope)).toEqual([]);
  });

  it('rejects confirmation state represented as ordinary success', () => {
    const invalidEnvelope = {
      ...createCliSuccessEnvelope({
        operationId: 'op_invalid_confirmation_success',
        data: {
          deleted: true,
        },
      }),
      needs_confirmation: destructiveDeleteConfirmation,
    } as unknown as CliResultEnvelope;

    expect(validateCliResultEnvelope(invalidEnvelope)).toContain(
      'Successful envelopes must not include needs_confirmation.',
    );
  });

  it('constructs confirmation-required envelopes without silent failure fields', () => {
    const envelope = createCliConfirmationRequiredEnvelope({
      operationId: 'op_delete_requires_confirmation',
      confirmation: destructiveDeleteConfirmation,
    });

    expect(envelope.ok).toBe(false);
    if (envelope.ok) {
      return;
    }
    expect(envelope.data).toBeNull();
    expect(envelope.error.code).toBe('confirmation_required');
    expect(envelope.needs_confirmation?.non_interactive).toBe('return_confirmation_required');
  });
});

describe('CLI error and exit-code policy', () => {
  it('maps every cataloged error code to its declared exit code', () => {
    for (const entry of CLI_ERROR_CATALOG) {
      expect(exitCodeForErrorCode(entry.code)).toBe(entry.exitCode);
    }
  });

  it('uses stable exit-code classes for success, validation, conflicts, confirmation, unavailable dependencies, UI handoff, and internal errors', () => {
    expect(CLI_EXIT_CODE_CLASSES.map((entry) => [entry.class, entry.exitCode])).toEqual([
      ['success', 0],
      ['validation_error', 10],
      ['conflict', 20],
      ['confirmation_required', 30],
      ['unavailable_backend_or_provider', 40],
      ['unsupported_or_ui_required', 50],
      ['internal_error', 70],
    ]);
  });

  it.each<[CliErrorCode, number]>([
    ['invalid_arguments', 10],
    ['version_conflict', 20],
    ['confirmation_required', 30],
    ['provider_unavailable', 40],
    ['ui_required', 50],
    ['internal_error', 70],
  ])('maps %s to exit code %i', (code, expectedExitCode) => {
    expect(exitCodeForErrorCode(code)).toBe(expectedExitCode);
  });
});
