export type CliContractVersion = '2026-05-10.v1';
export type CliResultSchemaVersion = '1.0.0';

export type SourceCapabilityIssue =
  | 'VIT-46'
  | 'VIT-47'
  | 'VIT-48'
  | 'VIT-49'
  | 'VIT-50'
  | 'VIT-77'
  | 'VIT-96';

export type CliCapabilityDisposition =
  | 'headless_cli_supported'
  | 'cli_supported_with_confirmation'
  | 'cli_wakes_desktop_ui'
  | 'intentionally_unsupported';

export type CliCommandGroup =
  | 'workspace-file'
  | 'mindmap'
  | 'markdown'
  | 'ai'
  | 'git'
  | 'desktop-ui'
  | 'diagnostics';

export type CliCommandId = string;

export type CliConfirmationKind =
  | 'destructive_file'
  | 'destructive_mindmap'
  | 'ai_apply'
  | 'git_init'
  | 'git_snapshot'
  | 'git_restore'
  | 'multi_file_change'
  | 'lossy_markdown_write';

export interface CliCommandDefinition {
  id: CliCommandId;
  group: CliCommandGroup;
  displayName: string;
  description: string;
  disposition: CliCapabilityDisposition;
  outputDataKind: string;
  requiresWorkspace: boolean;
  supportsJsonOutput: boolean;
  confirmationKinds?: readonly CliConfirmationKind[];
}

export interface CliCapabilityMatrixEntry {
  capabilityId: string;
  sourceIssue: SourceCapabilityIssue;
  capabilityGroup: string;
  disposition: CliCapabilityDisposition;
  commandIds: readonly CliCommandId[];
  rationale: string;
}

export type CliExitCodeClass =
  | 'success'
  | 'validation_error'
  | 'conflict'
  | 'confirmation_required'
  | 'unavailable_backend_or_provider'
  | 'unsupported_or_ui_required'
  | 'internal_error';

export type CliExitCode = 0 | 10 | 20 | 30 | 40 | 50 | 70;

export type CliErrorCode =
  | 'validation_error'
  | 'invalid_arguments'
  | 'invalid_output_format'
  | 'workspace_not_selected'
  | 'workspace_missing'
  | 'invalid_relative_path'
  | 'path_outside_workspace'
  | 'unsupported_file_type'
  | 'file_not_found'
  | 'version_conflict'
  | 'dirty_state_conflict'
  | 'external_state_changed'
  | 'confirmation_required'
  | 'operation_cancelled'
  | 'backend_unavailable'
  | 'provider_not_configured'
  | 'provider_unavailable'
  | 'git_unavailable'
  | 'repository_blocked'
  | 'command_unavailable'
  | 'ui_required'
  | 'unsupported_operation'
  | 'internal_error';

export interface CliExitCodeClassDefinition {
  class: CliExitCodeClass;
  exitCode: CliExitCode;
  description: string;
}

export interface CliErrorCatalogEntry {
  code: CliErrorCode;
  exitCodeClass: CliExitCodeClass;
  exitCode: CliExitCode;
  recoverable: boolean;
  description: string;
}

export interface CliWarning {
  code: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface CliError {
  code: CliErrorCode;
  message: string;
  recoverable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export type CliNonInteractivePromptBehavior = 'return_confirmation_required';

export interface CliConfirmationRequest {
  kind: CliConfirmationKind;
  command_id: CliCommandId;
  prompt: string;
  risks: readonly string[];
  confirm_token: string;
  non_interactive: CliNonInteractivePromptBehavior;
}

export interface CliConfirmationRule {
  id: string;
  kind: CliConfirmationKind;
  commandIds: readonly CliCommandId[];
  requiredWhen: string;
  interactiveBehavior: string;
  nonInteractiveBehavior: CliNonInteractivePromptBehavior;
  bypassFlag?: '--yes' | '--confirm-token';
}

export interface CliUiAction {
  kind: 'open_window' | 'focus_existing_window' | 'open_review_surface';
  target: string;
  reason: string;
  handoff_token: string;
}

export type CliResultEnvelope<TData = unknown> =
  | {
      ok: true;
      contract_version: CliContractVersion;
      schema_version: CliResultSchemaVersion;
      operation_id: string;
      data: TData;
      warnings: readonly CliWarning[];
      error: null;
      needs_confirmation: null;
      ui_action: null;
    }
  | {
      ok: false;
      contract_version: CliContractVersion;
      schema_version: CliResultSchemaVersion;
      operation_id: string;
      data: null;
      warnings: readonly CliWarning[];
      error: CliError;
      needs_confirmation: CliConfirmationRequest | null;
      ui_action: CliUiAction | null;
    };

export interface CliContractValidationIssue {
  code:
    | 'command_missing_from_matrix'
    | 'matrix_references_unknown_command'
    | 'source_issue_missing_from_matrix'
    | 'confirmation_command_missing_rule';
  message: string;
  commandId?: CliCommandId;
  sourceIssue?: SourceCapabilityIssue;
}
