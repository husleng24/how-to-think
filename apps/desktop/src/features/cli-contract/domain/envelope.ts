import {
  CLI_CONTRACT_VERSION,
  CLI_RESULT_SCHEMA_VERSION,
  errorCatalogEntryFor,
  exitCodeForErrorCode,
} from './contract';
import type {
  CliConfirmationRequest,
  CliContractVersion,
  CliError,
  CliErrorCode,
  CliExitCode,
  CliResultEnvelope,
  CliResultSchemaVersion,
  CliUiAction,
  CliWarning,
} from './types';

type JsonSchemaType =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

interface JsonSchemaFixture {
  $id: string;
  type: JsonSchemaType;
  required: readonly string[];
  additionalProperties: boolean;
  properties: Record<string, unknown>;
}

export const CLI_RESULT_ENVELOPE_SCHEMA: JsonSchemaFixture = {
  $id: 'https://how-to-think.local/contracts/cli-result-envelope.schema.json',
  type: 'object',
  required: [
    'ok',
    'contract_version',
    'schema_version',
    'operation_id',
    'data',
    'warnings',
    'error',
    'needs_confirmation',
    'ui_action',
  ],
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    contract_version: { const: CLI_CONTRACT_VERSION },
    schema_version: { const: CLI_RESULT_SCHEMA_VERSION },
    operation_id: { type: 'string', minLength: 1 },
    data: {},
    warnings: { type: 'array' },
    error: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['code', 'message', 'recoverable'],
          additionalProperties: false,
        },
      ],
    },
    needs_confirmation: { anyOf: [{ type: 'null' }, { type: 'object' }] },
    ui_action: { anyOf: [{ type: 'null' }, { type: 'object' }] },
  },
};

export function createCliSuccessEnvelope<TData>(input: {
  operationId: string;
  data: TData;
  warnings?: readonly CliWarning[];
}): CliResultEnvelope<TData> {
  return {
    ok: true,
    contract_version: CLI_CONTRACT_VERSION as CliContractVersion,
    schema_version: CLI_RESULT_SCHEMA_VERSION as CliResultSchemaVersion,
    operation_id: input.operationId,
    data: input.data,
    warnings: input.warnings ?? [],
    error: null,
    needs_confirmation: null,
    ui_action: null,
  };
}

export function createCliErrorEnvelope(input: {
  operationId: string;
  code: CliErrorCode;
  message?: string;
  details?: CliError['details'];
  warnings?: readonly CliWarning[];
  uiAction?: CliUiAction | null;
}): CliResultEnvelope {
  const catalogEntry = errorCatalogEntryFor(input.code);

  return {
    ok: false,
    contract_version: CLI_CONTRACT_VERSION as CliContractVersion,
    schema_version: CLI_RESULT_SCHEMA_VERSION as CliResultSchemaVersion,
    operation_id: input.operationId,
    data: null,
    warnings: input.warnings ?? [],
    error: {
      code: input.code,
      message: input.message ?? catalogEntry.description,
      recoverable: catalogEntry.recoverable,
      details: input.details,
    },
    needs_confirmation: null,
    ui_action: input.uiAction ?? null,
  };
}

export function createCliConfirmationRequiredEnvelope(input: {
  operationId: string;
  confirmation: CliConfirmationRequest;
  warnings?: readonly CliWarning[];
}): CliResultEnvelope {
  return {
    ok: false,
    contract_version: CLI_CONTRACT_VERSION as CliContractVersion,
    schema_version: CLI_RESULT_SCHEMA_VERSION as CliResultSchemaVersion,
    operation_id: input.operationId,
    data: null,
    warnings: input.warnings ?? [],
    error: {
      code: 'confirmation_required',
      message: 'The operation requires explicit confirmation before it can continue.',
      recoverable: true,
    },
    needs_confirmation: input.confirmation,
    ui_action: null,
  };
}

export function createCliUiHandoffEnvelope(input: {
  operationId: string;
  uiAction: CliUiAction;
  message?: string;
  warnings?: readonly CliWarning[];
}): CliResultEnvelope {
  return createCliErrorEnvelope({
    operationId: input.operationId,
    code: 'ui_required',
    message: input.message ?? 'The operation must continue in the desktop UI.',
    warnings: input.warnings,
    uiAction: input.uiAction,
  });
}

export function serializeCliResultEnvelope(envelope: CliResultEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export function exitCodeForEnvelope(envelope: CliResultEnvelope): CliExitCode {
  if (envelope.ok) {
    return 0;
  }

  return exitCodeForErrorCode(envelope.error.code);
}

export function validateCliResultEnvelope(envelope: CliResultEnvelope): readonly string[] {
  const issues: string[] = [];

  if (!envelope.operation_id) {
    issues.push('operation_id is required.');
  }

  if (envelope.contract_version !== CLI_CONTRACT_VERSION) {
    issues.push('contract_version does not match the current CLI contract.');
  }

  if (envelope.schema_version !== CLI_RESULT_SCHEMA_VERSION) {
    issues.push('schema_version does not match the current result schema.');
  }

  if (envelope.ok) {
    if (envelope.error !== null) {
      issues.push('Successful envelopes must not include error.');
    }

    if (envelope.needs_confirmation !== null) {
      issues.push('Successful envelopes must not include needs_confirmation.');
    }

    if (envelope.ui_action !== null) {
      issues.push('Successful envelopes must not include ui_action.');
    }
  } else {
    if (envelope.data !== null) {
      issues.push('Failed envelopes must not include data.');
    }

    if (envelope.error === null) {
      issues.push('Failed envelopes must include error.');
    }

    if (
      envelope.needs_confirmation !== null &&
      envelope.error.code !== 'confirmation_required'
    ) {
      issues.push('needs_confirmation is only valid with confirmation_required errors.');
    }

    if (
      envelope.error.code === 'confirmation_required' &&
      envelope.needs_confirmation === null
    ) {
      issues.push('confirmation_required errors must include needs_confirmation.');
    }
  }

  return issues;
}
