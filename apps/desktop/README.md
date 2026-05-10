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
npm run test:unit
npm run test:smoke
npm run build:web
npm run tauri:dev
npm run tauri:build
```

- `dev` starts the Vite editor shell at `http://localhost:1420`.
- `test:unit` verifies document bootstrap behavior.
- `test:smoke` renders the React editor shell in a component test.
- `tauri:dev` launches the native desktop shell against the Vite dev server.
- `tauri:build` builds the native desktop app bundle.

The scaffold is intentionally isolated under `apps/desktop/` so future `packages/*` and `crates/*` work can be added without coupling to the initial shell.
