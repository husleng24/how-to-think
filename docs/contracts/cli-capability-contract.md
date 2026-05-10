# CLI Capability and Result Contract

- Status: Accepted contract for VIT-96
- Date: 2026-05-10
- Canonical app path: `apps/desktop/`
- Machine-readable source: `apps/desktop/src/features/cli-contract/`

This contract defines what the future CLI may do headlessly, what requires explicit confirmation, what wakes the desktop UI, and what is intentionally outside CLI scope. It also defines the stable result envelope, warnings, error codes, exit-code classes, confirmation behavior, and reusable fixtures for downstream command implementations.

The contract is implementation-neutral. It does not add an AI provider, Git backend, Tauri command bridge, or workspace lifecycle UI.

## Capability Classes

| Class | Meaning |
| --- | --- |
| `headless_cli_supported` | The command can complete in a terminal with explicit arguments and returns a result envelope. |
| `cli_supported_with_confirmation` | The command can run in a terminal only after explicit confirmation. Missing confirmation returns `confirmation_required`. |
| `cli_wakes_desktop_ui` | The CLI can produce a `ui_action` handoff and exit deterministically; the user decision belongs in the desktop app. |
| `intentionally_unsupported` | The CLI must not implement this behavior. |

## Command Groups

| Group | Commands |
| --- | --- |
| Workspace and file lifecycle | `workspace.open`, `workspace.create`, `workspace.files.list`, `workspace.file.create`, `workspace.file.open`, `workspace.file.save`, `workspace.file.rename`, `workspace.file.delete` |
| Mind map query and edit | `mindmap.read`, `mindmap.node.add`, `mindmap.node.update`, `mindmap.branch.move`, `mindmap.branch.delete`, `mindmap.history.undo`, `mindmap.history.redo` |
| Markdown compatibility | `markdown.parse`, `markdown.serialize`, `markdown.links.resolve`, `markdown.links.create-target` |
| AI chat and proposals | `ai.context.preview`, `ai.chat.send`, `ai.proposal.validate`, `ai.proposal.apply` |
| Git status, history, and restore | `git.status`, `git.init`, `git.snapshot`, `git.history`, `git.diff`, `git.restore` |
| Desktop UI handoff | `ui.open`, `ui.focus`, `ui.review` |
| Diagnostics and help | `diagnostics.doctor`, `help`, `contract.print` |

## Coverage Matrix

The typed matrix in `contract.ts` covers VIT-46, VIT-47, VIT-48, VIT-49, VIT-50, VIT-77, and VIT-96. Important boundaries:

- VIT-46 mind map inspection and pure node edits are headless. Branch move/delete require confirmation. Canvas pan, zoom, focus, and gesture workflows wake the desktop UI or stay unsupported as CLI gestures.
- VIT-47 workspace/file read and guarded save are headless. Rename/delete require confirmation. Dirty-state and external-conflict decisions wake the desktop review surface when no confirmation token is supplied.
- VIT-48 parse, serialize, and link resolution are headless. Creating link targets requires confirmation. Ambiguous links and lossy Markdown review wake the UI.
- VIT-49 context preview and local AI chat are headless when provider configuration is valid. Provider setup and auth recovery wake the UI.
- VIT-50 proposal validation is headless. Proposal apply requires confirmation, with a second confirmation class for multi-file changes. Automatic AI workspace rewrite is unsupported.
- VIT-77 status, history, and diff are headless. Git init, snapshot, and restore require confirmation. Remote workflows, rebase, submodules, and LFS are unsupported in this CLI contract.

## Result Envelope

Every command returns the same JSON shape when JSON output is requested:

```ts
interface CliResultEnvelope<TData> {
  ok: boolean;
  contract_version: '2026-05-10.v1';
  schema_version: '1.0.0';
  operation_id: string;
  data: TData | null;
  warnings: CliWarning[];
  error: CliError | null;
  needs_confirmation: CliConfirmationRequest | null;
  ui_action: CliUiAction | null;
}
```

Rules:

- Success uses `ok: true`, non-null `data`, `error: null`, `needs_confirmation: null`, and `ui_action: null`.
- Failure uses `ok: false`, `data: null`, and non-null `error`.
- Confirmation-required operations use `ok: false`, `error.code: 'confirmation_required'`, and non-null `needs_confirmation`.
- UI handoff uses `ok: false`, `error.code: 'ui_required'`, and non-null `ui_action`.
- Warnings never change `ok`; they describe truncation, diagnostics, fallback behavior, or recoverable blockers.

## Human and JSON Output

Human output should show concise command-specific summaries first, followed by warnings and recovery hints. It must not hide recoverable blockers such as conflicts, unavailable providers, or confirmation requirements.

JSON output must serialize only the result envelope. Downstream scripts should read `ok`, `error.code`, `needs_confirmation`, `ui_action`, and the process exit code instead of parsing human text.

## Exit-Code Classes

| Class | Exit code | Examples |
| --- | ---: | --- |
| `success` | 0 | Completed command, with or without warnings |
| `validation_error` | 10 | Invalid args, invalid path, missing workspace |
| `conflict` | 20 | Version conflict, dirty state, external state changed |
| `confirmation_required` | 30 | Confirmation missing or prompt cancelled |
| `unavailable_backend_or_provider` | 40 | Desktop backend, AI provider, or Git backend unavailable |
| `unsupported_or_ui_required` | 50 | Unsupported command or desktop UI handoff required |
| `internal_error` | 70 | Unexpected failure after validation |

The exact error catalog and mappings live in `CLI_ERROR_CATALOG`.

## Confirmation Model

Confirmation is required for destructive file operations, destructive mind map operations, AI apply, multi-file changes, lossy Markdown writes, Git init, Git snapshot, and Git restore.

Non-interactive terminals must not prompt or hang. They return a deterministic envelope with:

- `ok: false`
- `error.code: 'confirmation_required'`
- `needs_confirmation.non_interactive: 'return_confirmation_required'`
- exit code `30`

Downstream command implementations may accept a confirmation token, but they must re-run preflight before mutating anything. Confirmation cannot turn stale file versions, dirty editor state, repository conflicts, or provider failures into success.

## Reusable Contract Tests

The contract tests in `apps/desktop/src/features/cli-contract/domain/cliContract.test.ts` enforce:

- Every registered command appears in the capability matrix.
- Every required source issue has matrix coverage.
- Confirmation commands are backed by reusable confirmation rules.
- Result fixtures serialize with stable snake_case fields and version fields.
- Confirmation-required envelopes cannot be represented as ordinary success.
- Error codes map to stable exit-code classes.
