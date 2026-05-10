# CLI runtime spike

Date: 2026-05-10
Base: `main` at `e4edbffc7b358ac999f0fbf75bebdf8fa2bc135d`
Issue: VIT-95

## Scope

This spike identifies where the native local CLI should live, how it should be
packaged with the desktop app, which existing service modules it can call, and
what bridge is needed to coordinate with a running desktop instance. It does not
modify Tauri runtime code, Markdown lifecycle code, AI provider code, or
frontend proposal implementation.

## Current repository anchors

- Desktop app package: `apps/desktop/package.json`
- Tauri crate: `apps/desktop/src-tauri/Cargo.toml`
- Tauri library entrypoint: `apps/desktop/src-tauri/src/lib.rs`
- Tauri app binary: `apps/desktop/src-tauri/src/main.rs`
- Shared Markdown compatibility crate: `crates/markdown/Cargo.toml`
- Markdown lifecycle contract: `docs/contracts/workspace-markdown-lifecycle.md`
- AI proposal contract: `apps/desktop/src/features/ai-proposals/README.md`

The checkout does not have a root `Cargo.toml`; Rust commands must use manifest
paths for the desktop crate and the Markdown crate.

## Recommended CLI source location

Use a second Rust binary in the existing Tauri crate:

```text
apps/desktop/src-tauri/src/bin/how-to-think.rs
```

Cargo will auto-discover this as the `how-to-think` binary in the
`how-to-think-desktop` package. The binary should call the crate library
(`how_to_think_desktop_lib`) and the Tauri-free service modules directly, not the
`#[tauri::command]` functions in `commands.rs`.

Rationale:

- The current reusable Rust services already live in the Tauri crate and are
  exported by `lib.rs`.
- A sibling crate would require a new Cargo workspace or path dependency setup
  before it can call those modules.
- A TypeScript CLI would duplicate Rust filesystem/version/path safety rules or
  need an additional native bridge.
- The second-bin approach gives the follow-up implementation a small first
  step; extraction to a future `crates/core` can happen only when module reuse
  becomes awkward.

Initial CLI dependencies should stay narrow: argument parsing, JSON output, and
OS app-data/runtime directory discovery. Do not add AI provider dependencies or
proposal application logic as part of the first CLI binary.

## Packaging strategy

Build the CLI as a companion native binary from the desktop Tauri package:

```powershell
cargo build --manifest-path apps\desktop\src-tauri\Cargo.toml --bin how-to-think
cargo build --release --manifest-path apps\desktop\src-tauri\Cargo.toml --bin how-to-think
```

Expected development artifact after release build:

```text
apps/desktop/src-tauri/target/release/how-to-think(.exe)
```

Tauri does not currently package or expose this secondary Cargo binary. The
follow-up packaging task should add installer/bundler wiring so the CLI is
installed beside the desktop executable, with optional PATH setup handled by the
installer or a user-visible install command.

Recommended installed locations:

- macOS: bundle the binary in
  `/Applications/How to Think.app/Contents/MacOS/how-to-think`, then optionally
  install or print a symlink command for `/usr/local/bin/how-to-think` or the
  user's preferred bin directory.
- Windows: install `how-to-think.exe` beside `How to Think.exe`, for example
  `%LOCALAPPDATA%\Programs\How to Think\how-to-think.exe` for a per-user install
  or `C:\Program Files\How to Think\how-to-think.exe` for a machine-wide install.
- Linux: install `how-to-think` beside the desktop executable for AppImage
  builds, and prefer `/usr/bin/how-to-think` or `/usr/local/bin/how-to-think`
  for deb/rpm-style installers.

Blocker: `apps/desktop/src-tauri/tauri.conf.json` currently has no secondary
binary, sidecar, installer hook, protocol, or PATH-shim configuration. That
must be added in a packaging follow-up before users can invoke the CLI from an
installed app without a full path.

## Reusable service boundaries

Directly reusable from a Rust CLI:

| Area | Current path | CLI reuse |
| --- | --- | --- |
| Workspace lifecycle | `apps/desktop/src-tauri/src/workspace.rs` | Use `create_workspace`, `validate_workspace_root`, `workspace_session`, and `load_workspace_session` directly. |
| Document lifecycle | `apps/desktop/src-tauri/src/documents.rs` | Use create/open/save/rename/delete services directly; they already enforce path guards, writable checks, version conflicts, and atomic writes. |
| File indexing | `apps/desktop/src-tauri/src/file_index.rs` | Use `index_markdown_files` for list/status commands. |
| Path safety | `apps/desktop/src-tauri/src/path_guard.rs` | Use relative path validation and path conversion before any CLI file operation. |
| Link index/resolution | `apps/desktop/src-tauri/src/links/*` | Use `WorkspaceLinkIndex` and resolver functions for link diagnostics or navigation commands. |
| AI context snapshot | `apps/desktop/src-tauri/src/ai/context.rs` | Reuse `build_context_snapshot` for JSON context preview/export commands. |
| External change checks | `apps/desktop/src-tauri/src/fs_watch.rs` | Reuse `WorkspaceChangeDetector` and `document_external_change_status`; do not reuse the Tauri `WorkspaceWatchState` event emitter directly. |
| Settings persistence | `apps/desktop/src-tauri/src/settings.rs` | Reuse `SettingsStore` once the CLI has its own app-data path provider. |
| Error/model schema | `apps/desktop/src-tauri/src/errors.rs`, `models.rs` | Reuse serialized error and model types for stable CLI JSON. |
| Markdown compatibility | `crates/markdown/src/lib.rs` | Reuse parser/serializer APIs for Markdown/mindmap conversion commands. |

Adapters or extraction needed:

- `apps/desktop/src-tauri/src/commands.rs` is a Tauri adapter because it takes
  `AppHandle` and resolves app data through Tauri. Keep CLI logic out of this
  file; both Tauri commands and CLI commands should call lower-level services.
- `settings_store(app, operation)` currently hides app-data path discovery
  inside `commands.rs`. The CLI needs a small shared function or constructor
  that accepts an explicit app-data directory.
- `WorkspaceWatchState` emits Tauri events. CLI commands should use
  `WorkspaceChangeDetector` for polling/status and the future desktop bridge for
  live UI coordination.
- Mind map editing state lives in TypeScript under
  `apps/desktop/src/features/mindmap/`. CLI commands that need persisted
  Markdown conversion can use `crates/markdown`; commands that need live
  selection, undo, dirty state, or in-memory document state require the desktop
  bridge.
- AI proposal validation/review lives in TypeScript under
  `apps/desktop/src/features/ai-proposals/` and is explicitly pure frontend
  domain logic. Do not duplicate or move it in this CLI spike; proposal apply
  commands should wait for a dedicated boundary decision.
- No Git/version-control service exists in this checkout. The only Git-related
  behavior found is that `.git/` is skipped during Markdown indexing. Any CLI
  command for commit/status/history needs a new Rust service or crate first.

## Desktop rendezvous recommendation

Use a local per-user desktop bridge as the primary rendezvous mechanism:

1. On startup, the desktop app writes a session descriptor in app data, for
   example `desktop-session.json`, containing a PID, app version, active
   workspace ids, bridge endpoint, random auth token, and last-seen timestamp.
2. The desktop app owns a local IPC endpoint:
   - Windows: named pipe such as `\\.\pipe\how-to-think-<user-or-hash>`.
   - macOS/Linux: Unix domain socket under `$XDG_RUNTIME_DIR` when available,
     otherwise the app data directory with owner-only permissions.
3. The CLI reads the descriptor, verifies that the PID/endpoint are live, sends
   the token with each request, and falls back when the descriptor is stale.
4. Bridge messages are JSON and limited to local user operations: focus/wake
   app, open workspace/file, report active dirty state, request confirmation,
   and return `ui_required` when a command cannot safely complete headlessly.

Why this is the selected path:

- Dirty-document state and confirmation prompts are in the running React/Tauri
  app, not on disk.
- Deep links can wake the app but cannot answer "is this file dirty?" or "did
  the user confirm this destructive operation?"
- Lockfiles or settings files can identify the last workspace but cannot safely
  coordinate with unsaved in-memory buffers.

Fallback behavior:

- If the bridge is absent and the command is read-only, run headlessly against
  disk using the Rust services.
- If the bridge is absent and the command may conflict with UI dirty state or
  needs confirmation, return a structured `ui_required` error with a suggested
  `how-to-think://...` deep link once protocol support exists.
- If protocol support is not yet available, print the installed app path and
  instruct the caller to open the desktop app manually.

Blockers:

- `tauri.conf.json` does not define a custom protocol/deep link.
- The app does not currently enforce a single desktop instance.
- There is no IPC server, session descriptor, or bridge message schema.
- React dirty-state/confirmation state has no backend-accessible bridge yet.

## Commands for follow-up work

Run from the repository root unless noted.

Frontend/package commands:

```powershell
npm.cmd install --prefix apps\desktop
npm.cmd run typecheck --prefix apps\desktop
npm.cmd run test --prefix apps\desktop
npm.cmd run test:unit --prefix apps\desktop
npm.cmd run test:smoke --prefix apps\desktop
npm.cmd run build:web --prefix apps\desktop
npm.cmd run tauri:dev --prefix apps\desktop
npm.cmd run tauri:build --prefix apps\desktop
```

Rust commands:

```powershell
cargo fmt --manifest-path apps\desktop\src-tauri\Cargo.toml -- --check
cargo test --manifest-path apps\desktop\src-tauri\Cargo.toml
cargo build --manifest-path apps\desktop\src-tauri\Cargo.toml --bin how-to-think
cargo test --manifest-path crates\markdown\Cargo.toml
cargo fmt --manifest-path crates\markdown\Cargo.toml -- --check
```

Repository hygiene:

```powershell
git diff --check
git status --short
```

## Suggested implementation order

1. Add `apps/desktop/src-tauri/src/bin/how-to-think.rs` with a read-only command
   such as workspace validation or file listing, plus JSON error output using
   existing `WorkspaceError` types.
2. Extract shared app-data/settings path construction so Tauri commands and the
   CLI can both construct `SettingsStore` without duplicating file locations.
3. Add desktop bridge schema and a minimal app-owned IPC endpoint for focus,
   active workspace/file state, and `ui_required` confirmation flows.
4. Wire Tauri packaging/installer configuration to ship the CLI binary and
   document PATH setup.
5. Add Git/version-control service only when a concrete CLI command requires it.

## Current blockers for implementation

- Secondary CLI binary is not present yet.
- Packaging does not include a companion CLI binary.
- Desktop rendezvous infrastructure does not exist.
- Git service boundaries do not exist.
- Live dirty-state and confirmation checks are frontend/Tauri state only.
- Proposal review and apply behavior is frontend-only and should not be changed
  in parallel with the AI provider/proposal work.

These blockers do not prevent read-only or disk-only CLI commands from starting,
but they do block any command that must wake the desktop app, protect an unsaved
buffer, request confirmation, or integrate with installed-app packaging.
