import {
  createCliConfirmationRequiredEnvelope,
  createCliErrorEnvelope,
  createCliSuccessEnvelope,
  createCliUiHandoffEnvelope,
} from '../domain/envelope';
import type { CliConfirmationRequest, CliResultEnvelope, CliUiAction } from '../domain/types';

export const destructiveDeleteConfirmation: CliConfirmationRequest = {
  kind: 'destructive_file',
  command_id: 'workspace.file.delete',
  prompt: 'Delete notes/old-topic.md from the active workspace?',
  risks: ['The file will be removed from disk.', 'Unsaved editor buffers are not discarded.'],
  confirm_token: 'confirm_delete_notes_old_topic_md',
  non_interactive: 'return_confirmation_required',
};

export const reviewUiAction: CliUiAction = {
  kind: 'open_review_surface',
  target: 'ai-proposal/proposal-123',
  reason: 'The proposal affects multiple files and requires visual review.',
  handoff_token: 'handoff_ai_proposal_123',
};

export const successfulWorkspaceListEnvelope: CliResultEnvelope = createCliSuccessEnvelope({
  operationId: 'op_list_workspace_files',
  data: {
    files: [
      {
        relativePath: 'notes/root.md',
        byteSize: 128,
        modifiedAt: '2026-05-10T00:00:00.000Z',
      },
    ],
  },
});

export const confirmationRequiredEnvelope: CliResultEnvelope =
  createCliConfirmationRequiredEnvelope({
    operationId: 'op_delete_notes_old_topic',
    confirmation: destructiveDeleteConfirmation,
  });

export const validationErrorEnvelope: CliResultEnvelope = createCliErrorEnvelope({
  operationId: 'op_open_absolute_path',
  code: 'path_outside_workspace',
  message: 'Workspace-relative path must not be absolute.',
  details: {
    path: 'C:/Users/example/secret.md',
  },
});

export const uiHandoffEnvelope: CliResultEnvelope = createCliUiHandoffEnvelope({
  operationId: 'op_review_ai_proposal',
  uiAction: reviewUiAction,
});

export const CLI_RESULT_ENVELOPE_FIXTURES: readonly CliResultEnvelope[] = [
  successfulWorkspaceListEnvelope,
  confirmationRequiredEnvelope,
  validationErrorEnvelope,
  uiHandoffEnvelope,
];
