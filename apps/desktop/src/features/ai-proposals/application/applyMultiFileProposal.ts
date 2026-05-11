import { validateWorkspaceRelativeMarkdownPath } from '../domain/pathSafety';
import type {
  AiChangeProposal,
  ProposalAffectedFile,
  ProposalFileVersionAnchor,
  ProposalRiskFlag,
  WorkspaceRelativePath,
} from '../domain/types';
import {
  buildGuardedApplyConfirmation,
  isGuardedApplyTokenConfirmed,
} from './guardedApplyConfirmation';
import { createStatusMessage } from './messageMapping';
import type {
  ProposalGuardedApplyConfirmation,
  ProposalReviewMessage,
  ProposalReviewStore,
} from './types';

export type MultiFileProposalApplyStep =
  | 'confirmation'
  | 'prepare'
  | 'preflight'
  | 'batch'
  | 'write'
  | 'rollback'
  | 'refresh';

export type MultiFileProposalRollbackStatus =
  | 'not_needed'
  | 'completed'
  | 'incomplete'
  | 'not_supported';

export type MultiFileProposalApplyErrorCode =
  | 'guarded_confirmation_required'
  | 'duplicate_file'
  | 'invalid_file_path'
  | 'out_of_workspace_file'
  | 'unsupported_file_type'
  | 'missing_prepared_output'
  | 'stale_file'
  | 'dirty_file'
  | 'missing_file'
  | 'permission_denied'
  | 'file_already_exists'
  | 'ambiguous_link_target'
  | 'preflight_failed'
  | 'backend_write_failed'
  | 'rollback_failed'
  | 'refresh_failed'
  | 'review_not_ready';

export interface PreparedMultiFileProposalApply {
  proposalId: string;
  confirmation: ProposalGuardedApplyConfirmation;
  files: PreparedMultiFileProposalApplyFile[];
}

export interface PreparedMultiFileProposalApplyFile {
  path: WorkspaceRelativePath;
  operationType: ProposalAffectedFile['changeKind'];
  baseFileVersion: ProposalFileVersionAnchor;
  previousPath?: WorkspaceRelativePath;
  markdown?: string;
  riskFlags: ProposalRiskFlag[];
  linkImpact: string;
}

export interface MultiFileOpenDocumentState {
  path: WorkspaceRelativePath;
  version?: ProposalFileVersionAnchor;
  isDirty: boolean;
}

export interface MultiFileApplyPreflightFileState {
  path: WorkspaceRelativePath;
  exists: boolean;
  version?: ProposalFileVersionAnchor;
  writable?: boolean;
  permissionDenied?: boolean;
  ambiguousLinkTargets?: string[];
}

export interface MultiFileApplyPreflightInput {
  workspaceId: string;
  prepared: PreparedMultiFileProposalApply;
  backend: MultiFileApplyBackend;
  openDocuments?: MultiFileOpenDocumentState[];
}

export interface MultiFileApplyBackend {
  preflightFiles(
    input: MultiFileBackendPreflightInput,
  ): Promise<MultiFileApplyPreflightFileState[]> | MultiFileApplyPreflightFileState[];
  applyBatch?(
    input: MultiFileBackendApplyInput,
  ): Promise<MultiFileBackendBatchApplyResult> | MultiFileBackendBatchApplyResult;
  applyFile?(
    input: MultiFileBackendApplyFileInput,
  ): Promise<MultiFileBackendApplyFileResult> | MultiFileBackendApplyFileResult;
  rollbackFile?(
    input: MultiFileBackendRollbackFileInput,
  ): Promise<MultiFileBackendRollbackFileResult> | MultiFileBackendRollbackFileResult;
  refreshAfterApply?(
    input: MultiFileBackendRefreshInput,
  ): Promise<MultiFileBackendRefreshResult> | MultiFileBackendRefreshResult;
}

export interface MultiFileBackendPreflightInput {
  workspaceId: string;
  proposalId: string;
  files: PreparedMultiFileProposalApplyFile[];
}

export interface MultiFileBackendApplyInput {
  workspaceId: string;
  proposalId: string;
  files: PreparedMultiFileProposalApplyFile[];
  preflightStates: MultiFileApplyPreflightFileState[];
}

export interface MultiFileBackendApplyFileInput {
  workspaceId: string;
  proposalId: string;
  file: PreparedMultiFileProposalApplyFile;
  preflightState: MultiFileApplyPreflightFileState;
}

export interface MultiFileBackendRollbackFileInput {
  workspaceId: string;
  proposalId: string;
  rollback: MultiFileRollbackMetadata;
}

export interface MultiFileBackendRefreshInput {
  workspaceId: string;
  proposalId: string;
  appliedFiles: MultiFileAppliedFile[];
  refresh: MultiFileApplyRefreshInstructions;
}

export interface MultiFileAppliedFile {
  path: WorkspaceRelativePath;
  operationType: ProposalAffectedFile['changeKind'];
  version?: ProposalFileVersionAnchor;
}

export interface MultiFileRollbackMetadata {
  path: WorkspaceRelativePath;
  operationType: ProposalAffectedFile['changeKind'];
  recoveryToken?: string;
  previousVersion?: ProposalFileVersionAnchor;
  previousMarkdown?: string;
}

export type MultiFileBackendBatchApplyResult =
  | {
      ok: true;
      appliedFiles: MultiFileAppliedFile[];
      rollbackStatus?: MultiFileProposalRollbackStatus;
    }
  | {
      ok: false;
      code?: MultiFileProposalApplyErrorCode;
      message: string;
      filePath?: WorkspaceRelativePath;
      failedStep?: MultiFileProposalApplyStep;
      rollbackStatus?: MultiFileProposalRollbackStatus;
      appliedFiles?: MultiFileAppliedFile[];
      cause?: unknown;
    };

export type MultiFileBackendApplyFileResult =
  | {
      ok: true;
      appliedFile: MultiFileAppliedFile;
      rollback?: MultiFileRollbackMetadata;
    }
  | {
      ok: false;
      code?: MultiFileProposalApplyErrorCode;
      message: string;
      filePath?: WorkspaceRelativePath;
      cause?: unknown;
    };

export type MultiFileBackendRollbackFileResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      filePath?: WorkspaceRelativePath;
      cause?: unknown;
    };

export type MultiFileBackendRefreshResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      cause?: unknown;
    };

export interface MultiFileApplyRefreshInstructions {
  openDocumentsToRefresh: WorkspaceRelativePath[];
  fileListShouldRefresh: boolean;
  linkIndexShouldRefresh: boolean;
}

export interface MultiFileProposalApplyError {
  code: MultiFileProposalApplyErrorCode;
  message: string;
  step: MultiFileProposalApplyStep;
  filePath?: WorkspaceRelativePath;
  rollbackStatus: MultiFileProposalRollbackStatus;
  conflicts?: MultiFileProposalApplyError[];
  appliedFiles?: MultiFileAppliedFile[];
  cause?: unknown;
}

export type PrepareMultiFileProposalApplyResult =
  | { ok: true; prepared: PreparedMultiFileProposalApply }
  | { ok: false; error: MultiFileProposalApplyError };

export type PreflightMultiFileProposalApplyResult =
  | {
      ok: true;
      states: MultiFileApplyPreflightFileState[];
    }
  | {
      ok: false;
      errors: MultiFileProposalApplyError[];
    };

export interface ApplyMultiFileProposalInput {
  proposal: AiChangeProposal;
  workspaceId: string;
  backend: MultiFileApplyBackend;
  confirmedGuardedApplyToken?: string;
  openDocuments?: MultiFileOpenDocumentState[];
}

export type ApplyMultiFileProposalResult =
  | {
      ok: true;
      appliedFiles: MultiFileAppliedFile[];
      prepared: PreparedMultiFileProposalApply;
      refresh: MultiFileApplyRefreshInstructions;
      backendMode: 'batch' | 'sequential';
      rollbackStatus: MultiFileProposalRollbackStatus;
    }
  | {
      ok: false;
      prepared?: PreparedMultiFileProposalApply;
      error: MultiFileProposalApplyError;
    };

export interface ApplyActiveMultiFileProposalReviewInput {
  store: ProposalReviewStore;
  workspaceId: string;
  backend: MultiFileApplyBackend;
  openDocuments?: MultiFileOpenDocumentState[];
  reviewId?: string;
}

export interface ApplyActiveMultiFileProposalReviewResult {
  applyResult: ApplyMultiFileProposalResult;
  messages: ProposalReviewMessage[];
}

export function prepareMultiFileProposalApply(input: {
  proposal: AiChangeProposal;
  confirmedGuardedApplyToken?: string;
}): PrepareMultiFileProposalApplyResult {
  const confirmation = buildGuardedApplyConfirmation(input.proposal);

  if (!isGuardedApplyTokenConfirmed(confirmation, input.confirmedGuardedApplyToken)) {
    return {
      ok: false,
      error: applyError({
        code: 'guarded_confirmation_required',
        message: 'Guarded multi-file proposals require explicit affected-file confirmation.',
        step: 'confirmation',
      }),
    };
  }

  const duplicatePath = findDuplicatePath(input.proposal.affectedFiles);
  if (duplicatePath) {
    return {
      ok: false,
      error: applyError({
        code: 'duplicate_file',
        message: `Proposal lists ${duplicatePath} more than once.`,
        step: 'prepare',
        filePath: duplicatePath,
      }),
    };
  }

  const files: PreparedMultiFileProposalApplyFile[] = [];
  for (const affectedFile of input.proposal.affectedFiles) {
    const pathValidation = validateWorkspaceRelativeMarkdownPath(affectedFile.path);
    if (!pathValidation.ok) {
      return {
        ok: false,
        error: applyError({
          code: pathValidation.error.code,
          message: pathValidation.error.message,
          step: 'prepare',
          filePath: affectedFile.path,
        }),
      };
    }

    if (affectedFile.previousPath) {
      const previousPathValidation = validateWorkspaceRelativeMarkdownPath(affectedFile.previousPath);
      if (!previousPathValidation.ok) {
        return {
          ok: false,
          error: applyError({
            code: previousPathValidation.error.code,
            message: previousPathValidation.error.message,
            step: 'prepare',
            filePath: affectedFile.previousPath,
          }),
        };
      }
    }

    const markdown = affectedFile.markdownSerialization?.markdown;
    if (
      affectedFile.changeKind !== 'delete' &&
      (affectedFile.markdownSerialization?.status !== 'valid' || typeof markdown !== 'string')
    ) {
      return {
        ok: false,
        error: applyError({
          code: 'missing_prepared_output',
          message: `Proposal did not include prepared Markdown output for ${affectedFile.path}.`,
          step: 'prepare',
          filePath: affectedFile.path,
        }),
      };
    }

    const confirmationFile = confirmation.affectedFiles.find((file) => file.path === affectedFile.path);
    files.push({
      path: affectedFile.path,
      operationType: affectedFile.changeKind,
      baseFileVersion: affectedFile.baseFileVersion,
      previousPath: affectedFile.previousPath,
      markdown: affectedFile.changeKind === 'delete' ? undefined : markdown,
      riskFlags: confirmationFile?.highRiskFlags ?? [],
      linkImpact: confirmationFile?.linkImpact ?? 'No link changes',
    });
  }

  return {
    ok: true,
    prepared: {
      proposalId: input.proposal.proposalId,
      confirmation,
      files,
    },
  };
}

export async function preflightMultiFileProposalApply(
  input: MultiFileApplyPreflightInput,
): Promise<PreflightMultiFileProposalApplyResult> {
  let backendStates: MultiFileApplyPreflightFileState[];
  try {
    backendStates = await input.backend.preflightFiles({
      workspaceId: input.workspaceId,
      proposalId: input.prepared.proposalId,
      files: input.prepared.files,
    });
  } catch (cause) {
    return {
      ok: false,
      errors: [
        applyError({
          code: 'preflight_failed',
          message: 'The backend could not re-check affected file versions.',
          step: 'preflight',
          cause,
        }),
      ],
    };
  }

  const backendStatesByPath = new Map(backendStates.map((state) => [state.path, state]));
  const openDocumentsByPath = new Map((input.openDocuments ?? []).map((state) => [state.path, state]));
  const errors: MultiFileProposalApplyError[] = [];

  for (const file of input.prepared.files) {
    const backendState = backendStatesByPath.get(file.path);
    const openState = openDocumentsByPath.get(file.path);

    if (!backendState) {
      errors.push(
        applyError({
          code: 'missing_file',
          message: `The backend did not return state for ${file.path}.`,
          step: 'preflight',
          filePath: file.path,
        }),
      );
      continue;
    }

    if (backendState.permissionDenied || backendState.writable === false) {
      errors.push(
        applyError({
          code: 'permission_denied',
          message: `The backend cannot write ${file.path}.`,
          step: 'preflight',
          filePath: file.path,
        }),
      );
    }

    if (file.operationType === 'create') {
      if (backendState.exists) {
        errors.push(
          applyError({
            code: 'file_already_exists',
            message: `The file ${file.path} already exists.`,
            step: 'preflight',
            filePath: file.path,
          }),
        );
      }
    } else if (!backendState.exists) {
      errors.push(
        applyError({
          code: 'missing_file',
          message: `The file ${file.path} is missing.`,
          step: 'preflight',
          filePath: file.path,
        }),
      );
    } else if (!backendState.version || !fileVersionsEqual(backendState.version, file.baseFileVersion)) {
      errors.push(
        applyError({
          code: 'stale_file',
          message: `The file ${file.path} changed since the proposal was generated.`,
          step: 'preflight',
          filePath: file.path,
        }),
      );
    }

    if (openState?.isDirty) {
      errors.push(
        applyError({
          code: 'dirty_file',
          message: `The open document ${file.path} has unsaved edits.`,
          step: 'preflight',
          filePath: file.path,
        }),
      );
    }

    if (
      openState?.version &&
      file.operationType !== 'create' &&
      !fileVersionsEqual(openState.version, file.baseFileVersion)
    ) {
      errors.push(
        applyError({
          code: 'stale_file',
          message: `The open document ${file.path} no longer matches the proposal base version.`,
          step: 'preflight',
          filePath: file.path,
        }),
      );
    }

    if ((backendState.ambiguousLinkTargets?.length ?? 0) > 0) {
      errors.push(
        applyError({
          code: 'ambiguous_link_target',
          message: `The proposal has ambiguous link targets for ${file.path}.`,
          step: 'preflight',
          filePath: file.path,
        }),
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, states: backendStates };
}

export async function applyMultiFileProposal(
  input: ApplyMultiFileProposalInput,
): Promise<ApplyMultiFileProposalResult> {
  const preparedResult = prepareMultiFileProposalApply({
    proposal: input.proposal,
    confirmedGuardedApplyToken: input.confirmedGuardedApplyToken,
  });
  if (!preparedResult.ok) {
    return { ok: false, error: preparedResult.error };
  }

  const preflightResult = await preflightMultiFileProposalApply({
    workspaceId: input.workspaceId,
    prepared: preparedResult.prepared,
    backend: input.backend,
    openDocuments: input.openDocuments,
  });
  if (!preflightResult.ok) {
    return {
      ok: false,
      prepared: preparedResult.prepared,
      error: {
        ...preflightResult.errors[0],
        conflicts: preflightResult.errors,
      },
    };
  }

  const backendResult = input.backend.applyBatch
    ? await applyWithBatchBackend(input, preparedResult.prepared, preflightResult.states)
    : await applySequentially(input, preparedResult.prepared, preflightResult.states);
  if (!backendResult.ok) {
    return {
      ok: false,
      prepared: preparedResult.prepared,
      error: backendResult.error,
    };
  }

  const refresh = createRefreshInstructions(
    preparedResult.prepared,
    backendResult.appliedFiles,
    input.openDocuments ?? [],
  );

  if (input.backend.refreshAfterApply) {
    const refreshResult = await refreshAfterApply(input, backendResult.appliedFiles, refresh);
    if (!refreshResult.ok) {
      return {
        ok: false,
        prepared: preparedResult.prepared,
        error: refreshResult.error,
      };
    }
  }

  return {
    ok: true,
    appliedFiles: backendResult.appliedFiles,
    prepared: preparedResult.prepared,
    refresh,
    backendMode: backendResult.backendMode,
    rollbackStatus: backendResult.rollbackStatus,
  };
}

export async function applyActiveMultiFileProposalReview(
  input: ApplyActiveMultiFileProposalReviewInput,
): Promise<ApplyActiveMultiFileProposalReviewResult> {
  const review = input.store.getState().activeReview;
  if (!review || (input.reviewId && review.reviewId !== input.reviewId) || !review.proposal) {
    const error = applyError({
      code: 'review_not_ready',
      message: 'There is no active proposal review ready to apply.',
      step: 'confirmation',
    });
    return { applyResult: { ok: false, error }, messages: [messageForApplyError(error)] };
  }

  const applying = input.store.beginApply(review.reviewId);
  if (!applying || applying.status !== 'applying') {
    const error = applyError({
      code: 'review_not_ready',
      message: 'The active proposal review cannot be accepted in its current state.',
      step: 'confirmation',
    });
    input.store.markFailed('proposal_apply_failed', error.message, review.reviewId);
    return { applyResult: { ok: false, error }, messages: [messageForApplyError(error)] };
  }

  const applyResult = await applyMultiFileProposal({
    proposal: review.proposal,
    workspaceId: input.workspaceId,
    backend: input.backend,
    confirmedGuardedApplyToken: review.confirmedGuardedApplyToken,
    openDocuments: input.openDocuments,
  });
  const messages = applyResult.ok
    ? [
        createStatusMessage(
          'proposal_applied',
          'Proposal accepted',
          'The proposal was applied as a guarded file batch.',
        ),
      ]
    : [messageForApplyError(applyResult.error)];

  if (applyResult.ok) {
    input.store.markApplied(review.reviewId);
  } else if (isConflictError(applyResult.error)) {
    input.store.markConflict(messages, review.reviewId);
  } else {
    input.store.markFailed('proposal_apply_failed', applyResult.error.message, review.reviewId);
  }

  return { applyResult, messages };
}

async function applyWithBatchBackend(
  input: ApplyMultiFileProposalInput,
  prepared: PreparedMultiFileProposalApply,
  preflightStates: MultiFileApplyPreflightFileState[],
): Promise<
  | {
      ok: true;
      appliedFiles: MultiFileAppliedFile[];
      backendMode: 'batch';
      rollbackStatus: MultiFileProposalRollbackStatus;
    }
  | { ok: false; error: MultiFileProposalApplyError }
> {
  if (!input.backend.applyBatch) {
    return {
      ok: false,
      error: applyError({
        code: 'backend_write_failed',
        message: 'No batch backend is available.',
        step: 'batch',
      }),
    };
  }

  try {
    const result = await input.backend.applyBatch({
      workspaceId: input.workspaceId,
      proposalId: prepared.proposalId,
      files: prepared.files,
      preflightStates,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: applyError({
          code: result.code ?? 'backend_write_failed',
          message: result.message,
          step: result.failedStep ?? 'batch',
          filePath: result.filePath,
          rollbackStatus: result.rollbackStatus ?? 'not_supported',
          appliedFiles: result.appliedFiles,
          cause: result.cause,
        }),
      };
    }

    return {
      ok: true,
      appliedFiles: result.appliedFiles,
      backendMode: 'batch',
      rollbackStatus: result.rollbackStatus ?? 'not_needed',
    };
  } catch (cause) {
    return {
      ok: false,
      error: applyError({
        code: 'backend_write_failed',
        message: 'The backend batch write failed.',
        step: 'batch',
        rollbackStatus: 'not_supported',
        cause,
      }),
    };
  }
}

async function applySequentially(
  input: ApplyMultiFileProposalInput,
  prepared: PreparedMultiFileProposalApply,
  preflightStates: MultiFileApplyPreflightFileState[],
): Promise<
  | {
      ok: true;
      appliedFiles: MultiFileAppliedFile[];
      backendMode: 'sequential';
      rollbackStatus: MultiFileProposalRollbackStatus;
    }
  | { ok: false; error: MultiFileProposalApplyError }
> {
  if (!input.backend.applyFile) {
    return {
      ok: false,
      error: applyError({
        code: 'backend_write_failed',
        message: 'No file apply backend is available.',
        step: 'write',
      }),
    };
  }

  const preflightStatesByPath = new Map(preflightStates.map((state) => [state.path, state]));
  const appliedFiles: MultiFileAppliedFile[] = [];
  const rollbacks: MultiFileRollbackMetadata[] = [];

  for (const file of prepared.files) {
    const preflightState = preflightStatesByPath.get(file.path);
    if (!preflightState) {
      return {
        ok: false,
        error: applyError({
          code: 'preflight_failed',
          message: `Missing preflight state for ${file.path}.`,
          step: 'write',
          filePath: file.path,
          rollbackStatus: await rollbackAppliedFiles(input, prepared, rollbacks),
          appliedFiles,
        }),
      };
    }

    try {
      const result = await input.backend.applyFile({
        workspaceId: input.workspaceId,
        proposalId: prepared.proposalId,
        file,
        preflightState,
      });
      if (!result.ok) {
        const rollbackStatus = await rollbackAppliedFiles(input, prepared, rollbacks);
        return {
          ok: false,
          error: applyError({
            code: result.code ?? 'backend_write_failed',
            message: result.message,
            step: 'write',
            filePath: result.filePath ?? file.path,
            rollbackStatus,
            appliedFiles,
            cause: result.cause,
          }),
        };
      }

      appliedFiles.push(result.appliedFile);
      if (result.rollback) {
        rollbacks.push(result.rollback);
      }
    } catch (cause) {
      const rollbackStatus = await rollbackAppliedFiles(input, prepared, rollbacks);
      return {
        ok: false,
        error: applyError({
          code: 'backend_write_failed',
          message: `The backend failed while applying ${file.path}.`,
          step: 'write',
          filePath: file.path,
          rollbackStatus,
          appliedFiles,
          cause,
        }),
      };
    }
  }

  return {
    ok: true,
    appliedFiles,
    backendMode: 'sequential',
    rollbackStatus: 'not_needed',
  };
}

async function rollbackAppliedFiles(
  input: ApplyMultiFileProposalInput,
  prepared: PreparedMultiFileProposalApply,
  rollbacks: MultiFileRollbackMetadata[],
): Promise<MultiFileProposalRollbackStatus> {
  if (rollbacks.length === 0) {
    return 'not_needed';
  }
  if (!input.backend.rollbackFile) {
    return 'not_supported';
  }

  let rollbackComplete = true;
  for (const rollback of [...rollbacks].reverse()) {
    try {
      const result = await input.backend.rollbackFile({
        workspaceId: input.workspaceId,
        proposalId: prepared.proposalId,
        rollback,
      });
      rollbackComplete = rollbackComplete && result.ok;
    } catch {
      rollbackComplete = false;
    }
  }

  return rollbackComplete ? 'completed' : 'incomplete';
}

async function refreshAfterApply(
  input: ApplyMultiFileProposalInput,
  appliedFiles: MultiFileAppliedFile[],
  refresh: MultiFileApplyRefreshInstructions,
): Promise<{ ok: true } | { ok: false; error: MultiFileProposalApplyError }> {
  if (!input.backend.refreshAfterApply) {
    return { ok: true };
  }

  try {
    const result = await input.backend.refreshAfterApply({
      workspaceId: input.workspaceId,
      proposalId: input.proposal.proposalId,
      appliedFiles,
      refresh,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: applyError({
          code: 'refresh_failed',
          message: result.message,
          step: 'refresh',
          rollbackStatus: 'not_supported',
          appliedFiles,
          cause: result.cause,
        }),
      };
    }

    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      error: applyError({
        code: 'refresh_failed',
        message: 'The editor/file-list refresh failed after batch apply.',
        step: 'refresh',
        rollbackStatus: 'not_supported',
        appliedFiles,
        cause,
      }),
    };
  }
}

function createRefreshInstructions(
  prepared: PreparedMultiFileProposalApply,
  appliedFiles: MultiFileAppliedFile[],
  openDocuments: MultiFileOpenDocumentState[],
): MultiFileApplyRefreshInstructions {
  const appliedPaths = new Set(appliedFiles.map((file) => file.path));
  const openDocumentsToRefresh = openDocuments
    .filter((document) => appliedPaths.has(document.path))
    .map((document) => document.path);
  const hasLinkImpact = prepared.files.some((file) => file.linkImpact !== 'No link changes');
  const hasLifecycleChange = prepared.files.some((file) =>
    file.operationType === 'create' || file.operationType === 'delete' || file.operationType === 'rename',
  );

  return {
    openDocumentsToRefresh,
    fileListShouldRefresh: true,
    linkIndexShouldRefresh: hasLinkImpact || hasLifecycleChange,
  };
}

function findDuplicatePath(files: ProposalAffectedFile[]): WorkspaceRelativePath | null {
  const seen = new Set<WorkspaceRelativePath>();
  for (const file of files) {
    if (seen.has(file.path)) {
      return file.path;
    }
    seen.add(file.path);
  }

  return null;
}

function fileVersionsEqual(left: ProposalFileVersionAnchor, right: ProposalFileVersionAnchor): boolean {
  return left.token === right.token;
}

function applyError(input: {
  code: MultiFileProposalApplyErrorCode;
  message: string;
  step: MultiFileProposalApplyStep;
  filePath?: WorkspaceRelativePath;
  rollbackStatus?: MultiFileProposalRollbackStatus;
  conflicts?: MultiFileProposalApplyError[];
  appliedFiles?: MultiFileAppliedFile[];
  cause?: unknown;
}): MultiFileProposalApplyError {
  return {
    rollbackStatus: input.rollbackStatus ?? 'not_needed',
    ...input,
  };
}

function messageForApplyError(error: MultiFileProposalApplyError): ProposalReviewMessage {
  if (isConflictError(error)) {
    return createStatusMessage('proposal_stale_file', 'Proposal conflict', error.message, 'error');
  }

  return createStatusMessage('proposal_apply_failed', 'Proposal failed', error.message, 'error');
}

function isConflictError(error: MultiFileProposalApplyError): boolean {
  return (
    error.code === 'stale_file' ||
    error.code === 'dirty_file' ||
    error.code === 'missing_file' ||
    error.code === 'file_already_exists' ||
    error.code === 'ambiguous_link_target'
  );
}
