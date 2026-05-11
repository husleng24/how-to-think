# Export Operator Guide

This guide covers first-version export behavior for developer agents, QA, and local operators validating PNG, SVG, PDF, and Markdown artifacts.

## Desktop Export

Open a Markdown mind map in the desktop shell and use the export dialog from the editor surface.

1. Choose `PNG`, `SVG`, `PDF`, or `Markdown`.
2. Choose `Current file` or `Selected branch`.
3. Confirm the output path and whether an existing file may be replaced.
4. Choose format options:
   - PNG/SVG/PDF: layout size, explicit size, or scale.
   - PNG: pixel density.
   - PDF: fit-to-single-page or custom page settings.
   - Markdown: source Markdown or Markmap hierarchy.
   - Collapsed branches: preserve collapsed, expand all, or visible only.
5. Run export and review the success path, warnings, or failure message.

Desktop export prepares a request from the current editor state. Failed exports must not close the document, discard unsaved edits, or write back to the source Markdown file.

## CLI Render

Run CLI examples from a workspace directory or pass `--workspace`.

```bash
how-to-think --json render ./ideas.md --format svg --output ideas.svg --workspace .
how-to-think --json render ./ideas.md --format png --output ideas.png --workspace .
how-to-think --json render ./ideas.md --format pdf --output ideas.pdf --workspace .
how-to-think --json render ./ideas.md --format markdown --output ideas.export.md --workspace .
```

Branch export requires a deterministic node selector:

```bash
how-to-think --json render ./ideas.md --format markdown --scope branch --node-path "Ideas/Launch" --output launch.md --workspace .
```

Use `--non-interactive` in automation. If an output file already exists, the CLI returns `confirmation_required` instead of prompting indefinitely:

```bash
how-to-think --json --non-interactive render ./ideas.md --format svg --output ideas.svg --workspace .
how-to-think --json render ./ideas.md --format svg --output ideas.svg --confirm-token <token> --workspace .
```

## Source Safety

Exports write artifacts to the requested output path. Successful and failed exports must leave the source Markdown unchanged except for one explicit case: the user renders Markdown to the same source path and approves overwrite through the standard confirmation flow.

Expected safety checks:

- Unsupported formats return a validation error before rendering.
- Invalid paths, traversal paths, missing parents, and extension mismatches fail before writing.
- Existing output paths require overwrite approval.
- Stale source versions fail before export when an expected version token is supplied.
- Renderer, converter, and write failures return typed errors and do not mutate source Markdown or unsaved editor state.

## Format Notes

| Format | Notes |
| --- | --- |
| SVG | Deterministic, self-contained XML with visible nodes, connectors, text, link labels, and collapsed markers. |
| PNG | Rasterized from the SVG render path. Pixel density changes output dimensions and byte size. Very large dimensions are rejected before conversion. |
| PDF | Uses the SVG render path and fits the map to page settings. Large or wide maps may be scaled down; check for `pdf_fit_to_page` warnings. |
| Markdown | Current-file source mode copies the safe source Markdown when there are no unsaved editor changes. Markmap hierarchy mode serializes a canonical hierarchy and can warn about unmapped raw blocks. |

## First-Version Limitations

- Export is one-way. It does not import PNG, SVG, PDF, or non-Markdown formats.
- PDF output is single-page first. Very wide or deep maps can be readable but scaled down.
- Markdown hierarchy export is canonical. Mixed heading/list documents, code blocks, tables, HTML, and other unmapped blocks can produce warnings because not every raw block is a mind map node.
- Branch export includes the selected node and descendants. In visible-only mode, collapsed descendants are intentionally omitted and reported with warnings.
- Link targets are preserved as text in Markdown and visual exports. Unresolved links produce warnings instead of blocking export.
- Export preferences are convenience state only. Markdown files remain the source of truth.

## Manual Verification Checklist

Use a representative Markdown file with headings, nested lists, a mixed heading/list section, long labels, a deep branch, a wide branch, folded branches, wikilinks, Markdown links, task items, inline code/emphasis, and at least one unmapped block such as a paragraph, code block, or table.

1. Export current file to SVG. Open it in a browser and verify nodes, connectors, labels, links, and collapsed markers are visible.
2. Export current file to PNG. Open it in the OS image viewer and verify dimensions match the selected size or density.
3. Export current file to PDF. Open it in the OS PDF viewer and verify one page is readable; record any scaling warnings.
4. Export current file to Markdown with a new `.export.md` path. Open it in a text editor and compare hierarchy, links, tasks, code, and emphasis.
5. Export a selected branch to Markdown. Confirm the artifact contains only the selected node and descendants in stable order.
6. Try an existing output path with `--non-interactive`. Confirm the CLI returns `confirmation_required` and the existing output and source file remain unchanged.
7. Retry the same output with the returned confirmation token. Confirm overwrite warnings are present and the artifact is replaced.
8. Try an invalid output path such as `../outside.svg`. Confirm the command fails and source Markdown is unchanged.
9. In desktop, make an unsaved edit and attempt Markdown source export. Confirm source mode is unavailable and failed exports do not clear the edit.
10. Reopen generated SVG, PNG, PDF, and Markdown artifacts in local tools before release signoff.

## Automated Coverage

Relevant automated coverage lives in:

- `apps/desktop/src/features/export/fixtures/exportFixtures.ts`
- `apps/desktop/src/features/export/domain/exportRegressionFixtures.test.ts`
- `apps/desktop/src/features/export/domain/visualExportService.test.ts`
- `apps/desktop/src/features/export/domain/scopeResolution.test.ts`
- `apps/desktop/src/features/export/components/ExportDialog.test.tsx`
- `apps/desktop/src-tauri/tests/cli_smoke.rs`

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm.cmd test --prefix apps\desktop
```
