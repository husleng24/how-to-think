import {
  AlertTriangle,
  CheckCircle2,
  Download,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef } from 'react';

import type { MindMapEditorState } from '../../../domain/mindMap';
import type { WorkspaceLifecycleState } from '../../workspace';
import {
  createExportDialogContext,
  exportFailureFromUnknown,
  prepareDesktopExport,
} from '../application/desktopExportWorkflow';
import {
  canSubmitExport,
  createExportDialogState,
  defaultExportOutputPath,
  exportDialogReducer,
  exportDialogValidationMessages,
  exportFormatOptionAvailability,
  isExportBusy,
  phaseLabel,
} from '../application/exportDialogState';
import type {
  ExportDialogPhase,
  ExportDimensionMode,
} from '../application/exportDialogState';
import type { ExportFormat, ExportOverwritePolicy, ExportResult } from '../domain/types';
import {
  runDesktopExport,
  type DesktopExportCommand,
} from '../infrastructure/exportCommands';

interface ExportDialogProps {
  open: boolean;
  editorState: MindMapEditorState;
  workspaceState?: WorkspaceLifecycleState;
  runExport?: DesktopExportCommand;
  onClose: () => void;
}

const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  png: 'PNG',
  svg: 'SVG',
  pdf: 'PDF',
  markdown: 'Markdown',
};

const DIMENSION_MODE_LABELS: Record<ExportDimensionMode, string> = {
  layout_bounds: 'Layout',
  scale: 'Scale',
  explicit: 'Exact size',
};

export function ExportDialog({
  open,
  editorState,
  workspaceState,
  runExport = runDesktopExport,
  onClose,
}: ExportDialogProps) {
  const context = useMemo(
    () => createExportDialogContext(editorState, workspaceState),
    [editorState, workspaceState],
  );
  const [state, dispatch] = useReducer(
    exportDialogReducer,
    context,
    createExportDialogState,
  );
  const activeRunRef = useRef(0);
  const validationMessages = exportDialogValidationMessages(state, context);
  const availability = exportFormatOptionAvailability(state.format);
  const busy = isExportBusy(state.phase);
  const canExport = canSubmitExport(state, context);

  useEffect(() => {
    if (open) {
      dispatch({ type: 'reset', context });
    }
  }, [context, open]);

  if (!open) {
    return null;
  }

  const startExport = async () => {
    const runId = activeRunRef.current + 1;
    activeRunRef.current = runId;
    dispatch({ type: 'set-phase', phase: 'validating' });

    const prepared = prepareDesktopExport({
      dialogState: state,
      context,
      editorState,
      workspaceState,
    });

    if (!prepared.ok) {
      dispatch({ type: 'complete', result: prepared.result });
      return;
    }

    dispatch({
      type: 'set-phase',
      phase: prepared.export.request.format === 'markdown' ? 'writing' : 'rendering',
    });
    await Promise.resolve();

    if (prepared.export.request.format !== 'markdown') {
      dispatch({ type: 'set-phase', phase: 'writing' });
      await Promise.resolve();
    }

    try {
      const result = await runExport({
        request: prepared.export.request,
        markdownArtifact: prepared.export.markdownArtifact,
        warnings: prepared.export.warnings,
      });

      if (activeRunRef.current === runId) {
        dispatch({ type: 'complete', result });
      }
    } catch (error) {
      if (activeRunRef.current === runId) {
        dispatch({
          type: 'complete',
          result: exportFailureFromUnknown(prepared.export.request, error),
        });
      }
    }
  };

  const cancelExport = () => {
    activeRunRef.current += 1;
    dispatch({ type: 'cancel' });
  };

  return (
    <div className="modal-backdrop">
      <div role="dialog" aria-label="Export mind map" className="export-dialog">
        <div className="export-dialog-heading">
          <div>
            <p className="panel-kicker">Export</p>
            <h2>{context.documentTitle}</h2>
          </div>
          <button
            className="icon-button compact"
            type="button"
            aria-label="Close export dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <fieldset className="export-control-group">
          <legend>Format</legend>
          <div className="segmented-control">
            {(Object.keys(EXPORT_FORMAT_LABELS) as ExportFormat[]).map((format) => (
              <label key={format}>
                <input
                  type="radio"
                  name="export-format"
                  value={format}
                  checked={state.format === format}
                  disabled={busy}
                  onChange={() => dispatch({ type: 'set-format', format, context })}
                />
                <span>{EXPORT_FORMAT_LABELS[format]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="export-control-group">
          <legend>Scope</legend>
          <div className="segmented-control">
            <label>
              <input
                type="radio"
                name="export-scope"
                value="current_file"
                checked={state.scopeType === 'current_file'}
                disabled={busy}
                onChange={() => dispatch({ type: 'set-scope', scopeType: 'current_file', context })}
              />
              <span>Current file</span>
            </label>
            <label>
              <input
                type="radio"
                name="export-scope"
                value="selected_branch"
                checked={state.scopeType === 'selected_branch'}
                disabled={busy || !context.selectedNodeId}
                onChange={() => dispatch({ type: 'set-scope', scopeType: 'selected_branch', context })}
              />
              <span>Selected branch</span>
            </label>
          </div>
          {!context.selectedNodeId ? (
            <p className="export-inline-note">No selected node is available.</p>
          ) : null}
        </fieldset>

        <label className="workspace-path-field export-path-field">
          <span>Output path</span>
          <div className="export-path-row">
            <input
              value={state.outputPath}
              disabled={busy}
              onChange={(event) =>
                dispatch({ type: 'set-output-path', outputPath: event.currentTarget.value })
              }
            />
            <button
              className="icon-button compact"
              type="button"
              aria-label="Use default export path"
              title="Use default export path"
              disabled={busy}
              onClick={() =>
                dispatch({
                  type: 'set-output-path',
                  outputPath: defaultExportOutputPath(context, state.format, state.scopeType),
                })
              }
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </label>

        <label className="export-checkbox">
          <input
            type="checkbox"
            checked={state.overwritePolicy === 'replace_existing'}
            disabled={busy}
            onChange={(event) =>
              dispatch({
                type: 'set-overwrite-policy',
                overwritePolicy: overwritePolicyFromChecked(event.currentTarget.checked),
              })
            }
          />
          <span>Replace existing file</span>
        </label>

        <label className="workspace-path-field">
          <span>Collapsed branches</span>
          <select
            value={state.collapsedBranchPolicy}
            disabled={busy}
            onChange={(event) =>
              dispatch({
                type: 'set-collapsed-branch-policy',
                collapsedBranchPolicy: event.currentTarget.value as typeof state.collapsedBranchPolicy,
              })
            }
          >
            <option value="preserve_collapsed">Preserve collapsed</option>
            <option value="expand_all">Expand all</option>
            <option value="visible_only">Visible only</option>
          </select>
        </label>

        {availability.showVisualDimensions ? (
          <fieldset className="export-control-group">
            <legend>Size</legend>
            <div className="segmented-control">
              {(Object.keys(DIMENSION_MODE_LABELS) as ExportDimensionMode[]).map((mode) => (
                <label key={mode}>
                  <input
                    type="radio"
                    name="export-dimensions"
                    value={mode}
                    checked={state.dimensionMode === mode}
                    disabled={busy}
                    onChange={() => dispatch({ type: 'set-dimension-mode', dimensionMode: mode })}
                  />
                  <span>{DIMENSION_MODE_LABELS[mode]}</span>
                </label>
              ))}
            </div>

            {state.dimensionMode === 'scale' ? (
              <label className="workspace-path-field compact-field">
                <span>Scale</span>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={state.scale}
                  disabled={busy}
                  onChange={(event) =>
                    dispatch({ type: 'set-scale', scale: numericInputValue(event.currentTarget.valueAsNumber) })
                  }
                />
              </label>
            ) : null}

            {state.dimensionMode === 'explicit' ? (
              <div className="export-two-column">
                <label className="workspace-path-field compact-field">
                  <span>Width</span>
                  <input
                    type="number"
                    min="1"
                    value={state.width}
                    disabled={busy}
                    onChange={(event) =>
                      dispatch({ type: 'set-width', width: numericInputValue(event.currentTarget.valueAsNumber) })
                    }
                  />
                </label>
                <label className="workspace-path-field compact-field">
                  <span>Height</span>
                  <input
                    type="number"
                    min="1"
                    value={state.height}
                    disabled={busy}
                    onChange={(event) =>
                      dispatch({ type: 'set-height', height: numericInputValue(event.currentTarget.valueAsNumber) })
                    }
                  />
                </label>
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {availability.showPixelDensity ? (
          <label className="workspace-path-field compact-field">
            <span>Pixel density</span>
            <input
              type="number"
              min="0.5"
              step="0.5"
              value={state.pixelDensity}
              disabled={busy}
              onChange={(event) =>
                dispatch({
                  type: 'set-pixel-density',
                  pixelDensity: numericInputValue(event.currentTarget.valueAsNumber),
                })
              }
            />
          </label>
        ) : null}

        {availability.showPdfOptions ? (
          <fieldset className="export-control-group">
            <legend>PDF page</legend>
            <label className="workspace-path-field">
              <span>Page mode</span>
              <select
                value={state.pdfPageMode}
                disabled={busy}
                onChange={(event) =>
                  dispatch({
                    type: 'set-pdf-page-mode',
                    pdfPageMode: event.currentTarget.value as typeof state.pdfPageMode,
                  })
                }
              >
                <option value="fit_to_single_page">Fit to single page</option>
                <option value="custom_page">Custom page</option>
              </select>
            </label>
            {state.pdfPageMode === 'custom_page' ? (
              <div className="export-two-column">
                <label className="workspace-path-field compact-field">
                  <span>Page width</span>
                  <input
                    type="number"
                    min="1"
                    value={state.pdfWidth}
                    disabled={busy}
                    onChange={(event) =>
                      dispatch({
                        type: 'set-pdf-width',
                        pdfWidth: numericInputValue(event.currentTarget.valueAsNumber),
                      })
                    }
                  />
                </label>
                <label className="workspace-path-field compact-field">
                  <span>Page height</span>
                  <input
                    type="number"
                    min="1"
                    value={state.pdfHeight}
                    disabled={busy}
                    onChange={(event) =>
                      dispatch({
                        type: 'set-pdf-height',
                        pdfHeight: numericInputValue(event.currentTarget.valueAsNumber),
                      })
                    }
                  />
                </label>
              </div>
            ) : null}
            <label className="workspace-path-field compact-field">
              <span>Margin</span>
              <input
                type="number"
                min="0"
                value={state.pdfMargin}
                disabled={busy}
                onChange={(event) =>
                  dispatch({
                    type: 'set-pdf-margin',
                    pdfMargin: numericInputValue(event.currentTarget.valueAsNumber),
                  })
                }
              />
            </label>
          </fieldset>
        ) : null}

        {availability.showMarkdownOptions ? (
          <fieldset className="export-control-group">
            <legend>Markdown</legend>
            <label className="workspace-path-field">
              <span>Output mode</span>
              <select
                value={state.markdownMode}
                disabled={busy}
                onChange={(event) =>
                  dispatch({
                    type: 'set-markdown-mode',
                    markdownMode: event.currentTarget.value as typeof state.markdownMode,
                  })
                }
              >
                <option value="markmap_hierarchy">Markmap hierarchy</option>
                <option value="source_markdown" disabled={context.hasUnsavedChanges}>
                  Source Markdown
                </option>
              </select>
            </label>
            <label className="export-checkbox">
              <input
                type="checkbox"
                checked={state.includeFrontmatter}
                disabled={busy}
                onChange={(event) =>
                  dispatch({
                    type: 'set-include-frontmatter',
                    includeFrontmatter: event.currentTarget.checked,
                  })
                }
              />
              <span>Include frontmatter</span>
            </label>
            <label className="export-checkbox">
              <input
                type="checkbox"
                checked={state.includeUnmappedBlocks}
                disabled={busy}
                onChange={(event) =>
                  dispatch({
                    type: 'set-include-unmapped-blocks',
                    includeUnmappedBlocks: event.currentTarget.checked,
                  })
                }
              />
              <span>Include unmapped blocks</span>
            </label>
          </fieldset>
        ) : null}

        <ExportStatus
          phase={state.phase}
          result={state.result}
          validationMessages={validationMessages}
        />

        <div className="export-actions">
          {busy ? (
            <button className="text-button" type="button" onClick={cancelExport}>
              Cancel
            </button>
          ) : null}
          <button
            className="text-button"
            type="button"
            disabled={!canExport}
            onClick={() => void startExport()}
          >
            <Download size={16} />
            Export
          </button>
        </div>
      </div>
    </div>
  );
}

function ExportStatus({
  phase,
  result,
  validationMessages,
}: {
  phase: ExportDialogPhase;
  result: ExportResult | null;
  validationMessages: readonly string[];
}) {
  const busy = isExportBusy(phase);

  return (
    <section className={`export-status ${phase}`} aria-label="Export status">
      <span className="export-status-icon" aria-hidden="true">
        {busy ? (
          <LoaderCircle className="spin" size={18} />
        ) : result?.ok ? (
          <CheckCircle2 size={18} />
        ) : phase === 'failed' || phase === 'warning-present' ? (
          <AlertTriangle size={18} />
        ) : null}
      </span>
      <div>
        <strong>{phaseLabel(phase)}</strong>
        {result?.ok ? <p>Exported to {result.outputPath}</p> : null}
        {result && !result.ok ? <p>{result.error.message}</p> : null}
        {phase === 'cancelled' ? <p>Export was cancelled.</p> : null}
        {!result && validationMessages.length > 0 ? <p>{validationMessages[0]}</p> : null}
        {result?.warnings.length ? (
          <ul className="export-warning-list">
            {result.warnings.map((warning) => (
              <li key={`${warning.code}:${warning.message}`}>{warning.message}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function overwritePolicyFromChecked(checked: boolean): ExportOverwritePolicy {
  return checked ? 'replace_existing' : 'fail_if_exists';
}

function numericInputValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
