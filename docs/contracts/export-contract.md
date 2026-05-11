# Export Contract Boundary

VIT-106 defines the request, result, option, warning, error, and render snapshot model shared by desktop export and future CLI render work.

## Owner Module

The current owner module is `apps/desktop/src/features/export/`. VIT-105 found no separate shared export package yet, so the contract starts as a desktop feature boundary and can move to a shared crate/package once export services are promoted.

## Field Ownership

- `ExportFormat`, `ExportScope`, `ExportOptions`, `MindMapRenderSnapshot`, `ExportResult`, `ExportWarning`, and `ExportError` are owned by `apps/desktop/src/features/export/domain`.
- Editor node ids, collapse state, and layout bounds come from VIT-46 mind map state and `apps/desktop/src/features/mindmap/layout.ts`.
- Markdown link tokens, compatibility diagnostics, lossy-save decisions, and Markdown output mode are owned by VIT-48. Export stores link metadata and diagnostics but does not parse or serialize Markdown.
- Workspace-relative paths, output write safety, overwrite behavior, source file versions, and atomic writes are owned by VIT-47. Export validation checks option shape but does not touch the filesystem.
- CLI result envelopes, exit codes, non-interactive confirmation behavior, and command registration are owned by VIT-91. `ExportResult` is the command payload, not the CLI envelope.
- Renderer/converter implementation remains future work from VIT-108/VIT-110. This contract does not emit SVG, PNG, PDF, or Markdown files.

## Formats

Supported `ExportFormat` values are `svg`, `png`, `pdf`, and `markdown`.

Unsupported values are rejected by `validateExportRequest` with `unsupported_export_format` before renderer or file-write work begins.

## Scopes

`ExportScope` supports:

- `current_file`
- `selected_branch` with required `rootNodeId`

Scope diagnostics use stable codes for missing branch roots, unresolved branch roots, empty scopes, and lossy Markdown in scope. Scope resolution itself belongs to downstream export scope work.

## Options

`ExportOptions` includes:

- `outputPath`
- `overwritePolicy`
- `dimensions` using layout bounds, explicit width/height, or scale
- `pixelDensity` for PNG
- `theme.source` and optional tokens
- `pdf` page settings
- `collapsedBranchPolicy`
- `markdown` output mode

Validation rejects incompatible combinations such as PDF options on PNG, pixel density on non-PNG formats, visual sizing for Markdown export, invalid dimensions, missing output paths, and invalid overwrite policy.

## Render Snapshot

`MindMapRenderSnapshot` is renderer-neutral JSON. It contains source metadata, scope, layout bounds, nodes, edges, text runs, link tokens, collapsed markers, theme tokens, and warnings.

It must not contain React component state, DOM nodes, canvas handles, WebView references, or converter-specific objects. The VIT-105 spike fixture under `docs/spikes/export-renderer` is used as the representative construction test.

## Validation

Use:

```ts
import {
  validateExportRequest,
  validateMindMapRenderSnapshot,
} from './features/export';
```

Both validators are pure and return typed errors. They are intended to run before any rendering, conversion, or file mutation.
