# Export Renderer Spike

This spike validates a headless SVG-first renderer and converter path for VIT-105.

The production desktop and CLI paths now exist, but no shared export renderer exists yet. This proof is intentionally isolated under `docs/spikes/export-renderer/` so it does not overlap AI handoff, Git, or CLI bridge work.

## Actual Paths Found

- Desktop app: `apps/desktop/`
- React mind map feature: `apps/desktop/src/features/mindmap/`
- Current layout module: `apps/desktop/src/features/mindmap/layout.ts`
- Tauri backend and CLI package: `apps/desktop/src-tauri/`
- Native CLI binary entrypoint: `apps/desktop/src-tauri/src/bin/how-to-think.rs`
- CLI parser/service code: `apps/desktop/src-tauri/src/cli.rs` and `apps/desktop/src-tauri/src/command_service.rs`
- Markdown compatibility crate: `crates/markdown/`

No shared core export/render crate or package exists yet. The current CLI supports diagnostics/help/version style scaffolding and does not yet expose `render`.

## Run

Use `npm.cmd` on Windows PowerShell:

```powershell
cd docs/spikes/export-renderer
npm.cmd install
npm.cmd run render
```

Generated artifacts:

- `artifacts/representative-mind-map.svg`
- `artifacts/representative-mind-map.png`
- `artifacts/representative-mind-map.pdf`

The renderer consumes a JSON `MindMapRenderSnapshot`, emits SVG directly, rasterizes that SVG to PNG with `@resvg/resvg-js`, and writes vector PDF with `svg-to-pdfkit`/`pdfkit`. It does not require a Tauri WebView, React DOM, an interactive canvas, or a running desktop instance.
