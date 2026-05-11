import type { MindMapEditorState } from '../../../domain/mindMap';
import { mergeEditorDocumentIntoMarkdownDocument } from '../../../services/markdownLifecycle';
import type { LinkIndexSnapshot, WorkspaceRelativePath } from '../../../types/markdownLifecycle';
import type { WorkspaceLifecycleState } from '../../workspace';
import {
  EXPORT_CONTRACT_VERSION,
  createExportError,
  validateExportRequest,
} from '../domain/contract';
import {
  exportMarkdownArtifact,
  resolveExportScope,
} from '../domain/scopeResolution';
import type {
  ExportError,
  ExportRequest,
  ExportResult,
  ExportScope,
  ExportSourceMetadata,
  ExportWarning,
} from '../domain/types';
import {
  buildExportOptions,
  exportDialogValidationMessages,
  type ExportDialogContext,
  type ExportDialogState,
} from './exportDialogState';

export interface PreparedDesktopExport {
  request: ExportRequest;
  markdownArtifact?: {
    markdown: string;
    byteSize: number;
    writesSourceFile: false;
  };
  warnings: readonly ExportWarning[];
}

export type PrepareDesktopExportResult =
  | {
      ok: true;
      export: PreparedDesktopExport;
    }
  | {
      ok: false;
      result: ExportResult;
    };

export interface PrepareDesktopExportInput {
  dialogState: ExportDialogState;
  context: ExportDialogContext;
  editorState: MindMapEditorState;
  workspaceState?: WorkspaceLifecycleState;
  now?: () => Date;
}

export function createExportDialogContext(
  editorState: MindMapEditorState,
  workspaceState?: WorkspaceLifecycleState,
): ExportDialogContext {
  const selectedNode = editorState.document.nodes[editorState.selection.selectedNodeId] ?? null;

  return {
    documentTitle: editorState.document.title,
    documentPath:
      workspaceState?.active?.snapshot.relativePath ??
      editorState.document.sourcePath ??
      null,
    selectedNodeId: selectedNode?.id ?? null,
    selectedNodeTitle: selectedNode?.text ?? null,
    hasUnsavedChanges: editorState.isDirty || Boolean(
      workspaceState?.active &&
        workspaceState.active.contentRevision !== workspaceState.active.savedContentRevision,
    ),
  };
}

export function prepareDesktopExport(
  input: PrepareDesktopExportInput,
): PrepareDesktopExportResult {
  const validationMessages = exportDialogValidationMessages(input.dialogState, input.context);
  const baseRequest = createBaseExportRequest(input);

  if (validationMessages.length > 0) {
    return {
      ok: false,
      result: exportFailure(
        baseRequest,
        createExportError('incompatible_export_options', validationMessages[0]),
      ),
    };
  }

  if (input.dialogState.format === 'markdown') {
    return prepareMarkdownExport(input, baseRequest);
  }

  return prepareVisualExport(input, baseRequest);
}

export function exportFailureFromUnknown(
  request: ExportRequest,
  error: unknown,
): ExportResult {
  return exportFailure(
    request,
    createExportError('internal_export_error', 'Desktop export command failed.', {
      details: {
        reason: error instanceof Error ? error.message : String(error),
      },
    }),
    request.snapshot?.warnings ?? [],
  );
}

function prepareMarkdownExport(
  input: PrepareDesktopExportInput,
  request: ExportRequest,
): PrepareDesktopExportResult {
  const active = input.workspaceState?.active ?? null;
  const markdownDocument = active
    ? mergeEditorDocumentIntoMarkdownDocument(input.editorState.document, active.markdownDocument)
    : null;
  const markdownResult = exportMarkdownArtifact({
    request,
    document: input.editorState.document,
    selection: input.editorState.selection,
    markdownDocument,
    currentMarkdown:
      request.options.markdown?.mode === 'source_markdown' && !input.context.hasUnsavedChanges
        ? active?.snapshot.content ?? null
        : null,
    currentFileVersion: active?.snapshot.version ?? null,
    resolvedLinkTargets: resolvedLinkTargets(active?.linkIndex),
  });

  if (!markdownResult.ok) {
    return {
      ok: false,
      result: markdownResult.result,
    };
  }

  return {
    ok: true,
    export: {
      request,
      markdownArtifact: markdownResult.artifact,
      warnings: markdownResult.warnings,
    },
  };
}

function prepareVisualExport(
  input: PrepareDesktopExportInput,
  request: ExportRequest,
): PrepareDesktopExportResult {
  const active = input.workspaceState?.active ?? null;
  const markdownDocument = active
    ? mergeEditorDocumentIntoMarkdownDocument(input.editorState.document, active.markdownDocument)
    : null;
  const resolution = resolveExportScope({
    request,
    document: input.editorState.document,
    selection: input.editorState.selection,
    markdownDocument,
    currentFileVersion: active?.snapshot.version ?? null,
    resolvedLinkTargets: resolvedLinkTargets(active?.linkIndex),
  });

  if (!resolution.ok) {
    return {
      ok: false,
      result: exportFailure(request, resolution.error, resolution.warnings),
    };
  }

  const requestWithSnapshot: ExportRequest = {
    ...request,
    scope: resolution.scope.resolvedScope,
    snapshot: resolution.scope.renderSnapshot,
  };
  const validation = validateExportRequest(requestWithSnapshot);

  if (!validation.ok) {
    return {
      ok: false,
      result: exportFailure(requestWithSnapshot, validation.errors[0]),
    };
  }

  return {
    ok: true,
    export: {
      request: requestWithSnapshot,
      warnings: resolution.scope.warnings,
    },
  };
}

function createBaseExportRequest(input: PrepareDesktopExportInput): ExportRequest {
  return {
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: input.dialogState.format,
    scope: exportScopeForState(input.dialogState, input.context),
    options: buildExportOptions(input.dialogState),
    source: exportSourceMetadata(input),
  };
}

function exportScopeForState(
  state: ExportDialogState,
  context: ExportDialogContext,
): ExportScope {
  if (state.scopeType === 'current_file') {
    return { type: 'current_file' };
  }

  return {
    type: 'selected_branch',
    rootNodeId: context.selectedNodeId ?? '',
    selectionId: context.selectedNodeId ? 'current-selection' : undefined,
  };
}

function exportSourceMetadata(input: PrepareDesktopExportInput): ExportSourceMetadata {
  const active = input.workspaceState?.active ?? null;
  const generatedAt = (input.now?.() ?? new Date()).toISOString();

  return {
    workspaceId: input.workspaceState?.workspace?.id,
    documentId: input.editorState.document.id,
    documentVersion: input.editorState.contentRevision,
    workspaceRelativePath: active?.snapshot.relativePath ?? input.editorState.document.sourcePath ?? null,
    fileVersion: active?.snapshot.version
      ? {
          token: active.snapshot.version.token,
          modifiedAt: active.snapshot.version.modifiedAt,
          byteSize: active.snapshot.version.byteSize,
        }
      : undefined,
    markdownSchemaVersion: active?.markdownDocument.schemaVersion,
    generatedAt,
  };
}

function resolvedLinkTargets(linkIndex: LinkIndexSnapshot | undefined): WorkspaceRelativePath[] {
  if (!linkIndex) {
    return [];
  }

  return linkIndex.files.flatMap((file) => [
    file.relativePath,
    file.stem,
    ...file.headings.map((heading) => `${file.relativePath}#${heading.anchor}`),
    ...file.headings.map((heading) => `${file.stem}#${heading.anchor}`),
  ]);
}

function exportFailure(
  request: ExportRequest,
  error: ExportError,
  warnings: readonly ExportWarning[] = [],
): ExportResult {
  return {
    ok: false,
    contractVersion: EXPORT_CONTRACT_VERSION,
    format: request.format,
    outputPath: request.options.outputPath,
    warnings,
    error,
  };
}
