# How to Think Desktop

Tauri + React + TypeScript desktop shell for the How to Think mind map editor.

## Prerequisites

- Node.js 20 or newer.
- npm 10 or newer.
- Rust and Cargo for Tauri desktop commands.
- Tauri system prerequisites for your OS: https://tauri.app/start/prerequisites/

The web checks can run without Rust. `tauri:dev` and `tauri:build` require Rust/Cargo and the OS-specific Tauri prerequisites.

## Install

```bash
npm install
```

## Commands

```bash
npm run dev
npm run typecheck
npm run lint
npm run test
npm run test:browser
npm run test:unit
npm run test:smoke
npm run test:workspace
npm run test:desktop-smoke
npm run build:web
npm run tauri:dev
npm run tauri:build
```

- `dev` starts the Vite editor shell at `http://localhost:1420`.
- `test:browser` runs the mandatory browser-rendered React and mind map regression checks.
- `test:unit` verifies document, layout, fixture generation, and readability helper behavior.
- `test:smoke` renders the React editor shell and core mind map editing flows in component tests.
- `test:workspace` runs the local-first workspace fixture, lifecycle store, and React workspace regression checks.
- `test:desktop-smoke` reports a skipped Tauri smoke by default. Set `HTT_RUN_TAURI_SMOKE=1` to check local Rust/Cargo and Tauri CLI prerequisites before launching the native shell manually.
- `tauri:dev` launches the native desktop shell against the Vite dev server.
- `tauri:build` builds the native desktop app bundle.

## Core Editor Validation

Run these commands from the repository root before reporting editor implementation completion:

```bash
npm.cmd run typecheck --prefix apps\desktop
npm.cmd run lint --prefix apps\desktop
npm.cmd run test:workspace --prefix apps\desktop
npm.cmd test --prefix apps\desktop
npm.cmd run build:web --prefix apps\desktop
git diff --check
```

`npm.cmd test --prefix apps\desktop` runs mandatory browser-mode coverage first, then prints an explicit desktop-smoke skip unless `HTT_RUN_TAURI_SMOKE=1` is set. The browser-mode coverage includes fixture generation for balanced, deep, wide, long-text, empty-text, collapsed, and 500-node maps; layout/readability assertions; rendered canvas regression checks; keyboard-only create/edit/delete/move/collapse/undo/redo flows; panning, zooming, fit-to-content, and focus controls.

The optional native shell smoke is local-environment dependent because it requires Rust/Cargo, the Tauri CLI, and OS-specific webview prerequisites. When those prerequisites are available, run:

```bash
npm.cmd run dev --prefix apps\desktop
npm.cmd run tauri:dev --prefix apps\desktop
```

For manual inspection, use the 500-node generated fixture in the editor checks and inspect it at default zoom, after zooming out, and after focusing the selected node. The fixture should show rendered nodes/edges without a blank canvas or obvious same-depth text/node overlap.

For local-first workspace lifecycle verification, follow `apps/desktop/docs/local-first-workspace-verification.md`. It covers first-run workspace selection, offline create/open/save, restart recovery, external editor conflicts, external delete or move, invalid filenames, and permission failures.

For local AI assistant provider setup, context/privacy behavior, mock-provider validation, and manual Codex/Claude QA, follow `apps/desktop/docs/ai-assistant-operator-guide.md`.

The scaffold is intentionally isolated under `apps/desktop/` so future `packages/*` and `crates/*` work can be added without coupling to the initial shell.
