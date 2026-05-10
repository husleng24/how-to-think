# VIT-105 Export Renderer Recommendation

## Path Findings

The batch baseline is `main` at commit `fc0fd19`, where the prerequisite work has established real app paths:

- `apps/desktop/` is the canonical Tauri + React desktop app.
- `apps/desktop/src/features/mindmap/` contains the current editor/canvas/layout feature code.
- `apps/desktop/src/features/mindmap/layout.ts` is the current deterministic layout module.
- `apps/desktop/src-tauri/` contains the Rust/Tauri backend and native CLI package.
- `apps/desktop/src-tauri/src/bin/how-to-think.rs` is the native CLI entrypoint.
- `apps/desktop/src-tauri/src/cli.rs` currently implements help/version/doctor-style CLI scaffolding, not render.
- `crates/markdown/` contains Markdown compatibility logic.

No shared core renderer/export package exists yet. The README still mentions future `crates/core`, `packages/mindmap`, and `apps/cli` paths, but the actual merged code places the app and CLI under `apps/desktop/`.

## Prototype Result

This spike added a representative `MindMapRenderSnapshot` fixture and a headless SVG-first converter proof under `docs/spikes/export-renderer/`.

Generated artifacts:

- `docs/spikes/export-renderer/artifacts/representative-mind-map.svg`
- `docs/spikes/export-renderer/artifacts/representative-mind-map.png`
- `docs/spikes/export-renderer/artifacts/representative-mind-map.pdf`

Latest local run:

- Output size: 2528 x 1208.
- Visible nodes: 20.
- Total fixture nodes: 23.
- Hidden descendants behind a collapsed marker: 3.
- SVG file size: 18,325 bytes, validated by XML header and `<svg>` content.
- PNG file size: 150,590 bytes, validated by PNG signature.
- PDF file size: 13,052 bytes, validated by `%PDF` signature.
- PNG was visually inspected locally and is readable.

The proof does not depend on the desktop app, React DOM, canvas pixels, or a Tauri WebView. It can run in a headless CLI process as long as the CLI can build or receive the same snapshot.

## Recommended First-Version Shape

Use an SVG-first export pipeline.

Recommended module placement once production export work starts:

- Define a `MindMapRenderSnapshot` in the shared mindmap/export boundary. In the current repo that likely starts near `apps/desktop/src/features/mindmap/` and should move to a shared package/crate only when one exists.
- Keep the deterministic layout contract aligned with `apps/desktop/src/features/mindmap/layout.ts`.
- Add an SVG emitter that consumes layout nodes, edges, link tokens, collapsed state, and export settings without touching React components.
- Wire desktop export UI from `apps/desktop/src/features/mindmap/` or a sibling `export` feature.
- Add a future CLI `render` command in `apps/desktop/src-tauri/src/cli.rs` only after a shared service boundary exists, so the CLI does not duplicate desktop render semantics.

SVG should be the canonical visual export. PNG and PDF should be derived from the same SVG artifact.

## Converter Recommendation

For the prototype, Node libraries were used because the repository has a Node toolchain today and this environment does not have Cargo installed:

- PNG: `@resvg/resvg-js`
- PDF: `svg-to-pdfkit` + `pdfkit`

For production native CLI work, prefer Rust-native conversion after the Rust toolchain and shared service shape are available:

- PNG: `resvg`/`usvg`/`tiny-skia` or an equivalent Rust-native stack.
- PDF: vector SVG-to-PDF if the selected converter reliably supports the emitted SVG subset.
- PDF fallback: single-page fit-to-page raster or vector-derived PDF with explicit warnings for oversized maps.

Do not use a WebView screenshot path as the primary export route. It couples headless CLI output to desktop runtime availability and makes layout/font failures harder to test.

## SVG Subset Constraints

Keep the emitted SVG converter-friendly:

- Use explicit `width`, `height`, and `viewBox`.
- Use simple `path`, `rect`, `text`, and `tspan` primitives.
- Pre-wrap text before emission.
- Avoid `foreignObject`, HTML, external CSS, external images, browser layout APIs, and canvas-derived pixels.
- Preserve link display text visually and carry target metadata in the snapshot/export diagnostics.
- Bundle or declare a stable font fallback policy instead of relying on browser-only font behavior.

## Quality Risks To Carry Forward

- **Large maps:** a single SVG is feasible first, but production should impose size/time warnings and benchmark 500-node and 2,000-node fixtures.
- **Deep maps:** depth expands width quickly. Provide fit-to-content and explicit scale warnings.
- **Long text:** text wrapping must be part of layout, not delegated to SVG/browser automatic flow.
- **Collapsed branches:** always render hidden-descendant markers so exported maps remain explainable.
- **Links:** render readable link text while preserving target metadata for future interactive SVG or diagnostics.
- **Fonts:** cross-platform export consistency requires a font policy and tests on Windows, macOS, and Linux.
- **PDF:** vector PDF is preferred. If vector conversion fails for the final SVG subset, fall back to fit-to-page PDF with clear warnings rather than silently producing unreadable output.

## Regression Tests To Add Later

When production export code exists, add fixture tests for:

- SVG structural validity and stable dimensions.
- PNG signature plus non-empty pixel output.
- PDF signature plus page-size metadata.
- Long labels and long unbroken words.
- Folded branches with hidden descendants.
- Markdown links and Obsidian wikilinks.
- Deep maps at 5, 10, and 20 levels.
- Wide sibling maps.
- 500-node and 2,000-node synthetic maps with time and memory thresholds.
- Font fallback differences across Windows, macOS, and Linux.
- Oversized PDF fit-to-page warnings.
