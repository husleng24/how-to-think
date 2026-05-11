# Native CLI Operator Guide

This guide documents the `how-to-think` native CLI shipped with the desktop app. It is intended for users, local automation, and developer agents validating CLI changes.

Canonical coverage metadata lives in `apps/desktop/docs/native-cli-capability-matrix.json`. The Rust contract test compares that file with the CLI command registry exposed by `help --json`.

## Locating the Binary

During development, build and run the binary from the Tauri package:

```bash
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin how-to-think
apps/desktop/src-tauri/target/debug/how-to-think help
```

Installed app locations depend on the bundle:

| Platform | Typical location |
| --- | --- |
| macOS | `How to Think.app/Contents/MacOS/how-to-think` or a CLI shim installed beside the app bundle. |
| Windows | `How to Think\how-to-think.exe` beside the installed desktop executable, or the package resource directory selected by the installer. |
| Linux | `how-to-think` beside the AppImage/deb/rpm desktop binary, or a package-managed path such as `/usr/bin/how-to-think`. |

If an installer does not place the binary on `PATH`, invoke it by absolute path. The command behavior is the same.

## Global Flags

| Flag | Use |
| --- | --- |
| `--json` | Print only the result envelope as JSON. |
| `--format human|json` | Select human or JSON output. For `render`, `--format` selects `svg`, `png`, `pdf`, or `markdown`. |
| `--workspace <path>` | Provide an explicit workspace directory. Prefer this for automation. |
| `--app-data-dir <path>` | Isolate app data for tests or automation. |
| `--app-config-dir <path>` | Isolate config, recent workspaces, and AI provider settings. |
| `--non-interactive` | Never prompt. Confirmation-required operations return exit code `30`. |
| `--confirm-token <token>` | Confirm the exact preflight returned by a prior attempt. Preflight is rerun before mutation. |

## Command Coverage

The native CLI command groups are:

| Group | Commands |
| --- | --- |
| Diagnostics | `help`, `version`, `doctor` |
| Workspace/file | `workspace.open`, `workspace.create`, `workspace.validate`, `workspace.recent.list`, `workspace.files.list`, `workspace.files.refresh`, `workspace.file.create`, `workspace.file.open`, `workspace.file.save`, `workspace.file.rename`, `workspace.file.delete` |
| Markdown compatibility | `markdown.parse`, `markdown.check`, `markdown.serialize`, `markdown.links.resolve` |
| Mind map | `mindmap.read`, `mindmap.create`, `mindmap.node.add`, `mindmap.node.update`, `mindmap.branch.move`, `mindmap.branch.delete`, `mindmap.siblings.reorder`, `mindmap.collapse`, `mindmap.expand`, `mindmap.focus-node`, `mindmap.fit-view`, `mindmap.drag-layout`, `mindmap.history.undo`, `mindmap.history.redo` |
| Export/render | `render` |
| AI | `ai.provider.list`, `ai.provider.health`, `ai.context.preview`, `ai.chat.send`, `ai.proposal.validate`, `ai.proposal.apply` |
| Git | `git.detect`, `git.init`, `git.status`, `git.refresh`, `git.snapshot`, `git.history`, `git.diff`, `git.restore` |
| Desktop bridge | `ui.open`, `ui.focus`, `ui.review` |

The matrix classifies each command as one of:

| Disposition | Meaning |
| --- | --- |
| `headless_cli_supported` | Can complete in a terminal with explicit arguments. |
| `cli_supported_with_confirmation` | Can complete only after a confirmation token from a prior preflight result. |
| `cli_wakes_desktop_ui` | Returns a deterministic `ui_action`; the decision belongs in the desktop app. |
| `intentionally_unsupported` | Documented as outside the native CLI surface. |

## JSON Envelope

All JSON commands return:

```json
{
  "ok": true,
  "contract_version": "2026-05-10.v1",
  "schema_version": "1.0.0",
  "operation_id": "version",
  "data": {},
  "warnings": [],
  "error": null,
  "needs_confirmation": null,
  "ui_action": null
}
```

Scripts should branch on `ok`, `error.code`, `needs_confirmation`, `ui_action`, and the process exit code. Do not parse human output.

## Exit Codes

| Exit code | Class | Typical errors |
| ---: | --- | --- |
| 0 | Success | Completed command, possibly with warnings. |
| 10 | Validation | Invalid arguments, invalid path, missing workspace, missing file. |
| 20 | Conflict | Version conflict, dirty state, external file/repository change. |
| 30 | Confirmation required | Missing confirmation token or cancelled prompt. |
| 40 | Unavailable backend/provider | Missing AI provider, unavailable Git/backend dependency. |
| 50 | Unsupported or UI required | Unsupported command or desktop handoff required. |
| 70 | Internal error | Unexpected failure after validation/preflight. |

## Safety Behavior

Workspace paths and file paths are guarded before IO. CLI commands reject absolute workspace-relative paths, traversal such as `../outside.md`, unsupported file extensions, invalid UTF-8 Markdown content, stale file versions, and stale Git repository tokens.

Confirmation is required for file rename/delete, destructive mind map branch moves/deletes, render output overwrite, AI proposal apply, Git init, Git snapshot, and Git restore. A confirmation token is bound to the requested command and preflight inputs; the command reruns preflight before writing.

Desktop UI handoff is used for visual or high-risk decisions: focus/viewport actions, dirty editor review, lossy Markdown review, AI proposal review, and complex Git conflict review. The CLI must not bypass desktop review by supplying hidden flags.

## Examples

Create a temporary workspace and file:

```bash
how-to-think --json workspace.create --workspace ./notes
how-to-think --json workspace.file.create --workspace ./notes --path plan.md --content "# Plan"
how-to-think --json workspace.file.open --workspace ./notes --path plan.md
```

Save with a version token from `workspace.file.open`:

```bash
how-to-think --json workspace.file.save --workspace ./notes --path plan.md --content "# Plan\n\n## Next" --expected-version '{"modified_at":"...","byte_size":8,"content_hash":"...","token":"..."}'
```

Check Markdown compatibility and resolve links:

```bash
how-to-think --json markdown.check --workspace ./notes --path plan.md
how-to-think --json markdown.links.resolve --workspace ./notes --path plan.md
```

Use the mock-provider flow in tests by writing `ai-providers.json` into an isolated `--app-config-dir`, then run:

```bash
how-to-think --json ai.provider.list --app-config-dir ./config
how-to-think --json ai.provider.health --provider mock-provider --app-config-dir ./config
how-to-think --json ai.context.preview --workspace ./notes --path plan.md --scope current-file
how-to-think --json ai.chat.send --workspace ./notes --path plan.md --scope current-file --prompt "Summarize the plan"
```

Use local Git without remote hosting:

```bash
how-to-think --json git.detect --workspace ./notes
how-to-think --json --non-interactive git.init --workspace ./notes
how-to-think --json git.init --workspace ./notes --confirm-token <token-from-previous-result>
how-to-think --json git.status --workspace ./notes
how-to-think --json git.snapshot --workspace ./notes --message "Save plan" --author-name "Local User" --author-email "local@example.test"
how-to-think --json git.history --workspace ./notes
how-to-think --json git.diff --workspace ./notes --path plan.md
how-to-think --json git.restore --workspace ./notes --path plan.md --source-ref HEAD~1 --dry-run
```

Request desktop review without prompting:

```bash
how-to-think --json --non-interactive ui.review --target workspace:local/file:plan.md --reason "Review pending AI proposal"
```

## First-Version Non-Goals

- No shell completion.
- No package-manager publishing.
- No remote service API or cloud automation platform.
- No remote Git hosting workflow, push, pull, rebase, submodules, or LFS support.
- No bypass of desktop review or confirmation.
- No full GUI replacement, gesture automation, or frontend Git history/diff/restore UI.

## Validation

Run these from the repository root before reporting CLI changes:

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --bin how-to-think
```

`cargo test` includes the native CLI smoke tests, JSON/exit-code contract regressions, mock AI provider flow, local Git flow, and the coverage-matrix check against the Rust command registry.
