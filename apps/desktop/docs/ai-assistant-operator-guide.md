# AI Assistant Operator Guide

This guide covers the local AI assistant conversation flow in the desktop app. The assistant runs local executable providers only; it does not call a hosted service by itself.

## Provider Configuration

Open the AI provider settings panel from the desktop inspector.

Configure one provider at a time:

- **Kind:** choose Codex, Claude, or Generic executable.
- **Executable path:** use the absolute path to the local CLI binary, such as `codex`, `claude`, or a wrapper executable. The app stores the path and argv entries, not API keys or tokens.
- **Argument template:** enter one argv entry per line. Do not paste a shell command string with pipes, redirects, or chained commands.
- **Health check args:** keep the default `--version` when the provider supports it, or use a short command that exits without sending a prompt.
- **Environment allowlist:** leave empty unless the provider requires specific local variables. When set, only the listed variables are passed to the provider process.
- **Working directory:** optional. If set, it must be an existing absolute directory and cannot be a filesystem root.
- **Timeout and output limit:** increase only when the local provider regularly needs more time or returns large responses.

Run a health check after saving. Conversation sending is enabled only when the selected provider is enabled and its last health check is healthy.

## Context Scopes

The assistant sends a bounded context snapshot to the local provider. The provider receives the snapshot on standard input with the latest user prompt and bounded prior conversation history.

- **Selected node:** sends metadata for the selected mind map node, its parent, and direct children. Use this for focused questions.
- **Selected branch:** sends the selected node and descendants in canonical child order. Use this for rewrite, restructure, or expansion requests.
- **Current file:** reads the active Markdown file from the workspace and includes parsed hierarchy plus raw Markdown.
- **Workspace summary:** includes a bounded Markdown file tree and relevant open files. Ignored implementation directories and unsupported files are excluded.

Snapshots include byte and token estimates. If the configured context byte limit is exceeded, content is truncated and a warning is shown before sending.

## Privacy and Workspace Boundaries

The assistant context builder reads only from the selected workspace record. Relative paths are validated before file reads. Workspace summary context excludes ignored implementation directories and non-Markdown files.

The selected local provider still receives the final prompt envelope. Treat provider CLIs as local processes with the same trust level as any command you run on the machine. Use the environment allowlist to avoid passing unnecessary secrets.

## Draft-Only Suggestions

AI conversation output is not applied to the mind map and is not saved to Markdown automatically.

Change-oriented prompts such as "rewrite", "restructure", "expand", "improve", or "suggest changes" can be saved as suggestion drafts. A saved draft keeps:

- source conversation and message ids,
- target scope and document metadata,
- raw assistant content,
- context truncation or stale-document warnings.

Drafts appear in the AI proposal review surface. They remain reviewable metadata until a later explicit apply flow accepts a proposal. Chat-only responses and saved drafts must not mutate the active document, trigger autosave, or alter undo/redo history.

## Common Errors

- **No local AI provider is configured:** add Codex, Claude, or a generic executable provider.
- **No active provider is selected:** select one configured provider as active.
- **Missing executable:** choose an existing executable path. On Windows, use an executable extension such as `.exe`, `.cmd`, `.bat`, or `.com`.
- **Permission denied:** fix filesystem permissions or choose a runnable executable.
- **Login required:** authenticate with the provider CLI outside the app, then run health check again.
- **Timeout:** increase provider timeout or reduce context size.
- **Cancelled:** start a new run when ready.
- **Non-zero exit:** inspect provider stderr and adjust provider args, authentication, or local configuration.
- **Malformed output:** return plain text or JSON with a string `message` or `content` field.
- **Output too large:** increase the provider output limit or ask for a shorter response.
- **Context truncated:** choose a narrower scope or raise the context byte limit.

## Automated Validation

The app includes a deterministic mock provider fixture at `apps/desktop/scripts/mock-ai-provider.mjs`. It supports:

- `health`
- `success`
- `slow`
- `timeout`
- `non-zero`
- `malformed`
- `suggestion`
- `long`

Run browser and frontend regression coverage from the repository root:

```bash
npm run test:browser --prefix apps/desktop
```

Run the focused assistant React tests from the desktop app directory so Vitest picks up `vite.config.ts` and jsdom setup:

```bash
cd apps/desktop
npm exec -- vitest run src/features/ai-assistant/components/AiAssistantPanel.test.tsx src/App.workspace.test.tsx
```

Run the Rust AI integration suite with the mock provider:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test ai_assistant_integration
```

Run all Rust AI module tests:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml ai
```

Platform requirements:

- Node.js 20 or newer is required for the mock provider fixture.
- Rust/Cargo is required for `src-tauri` tests.
- Windows process tests execute `node.exe` directly when available. Set `HTT_NODE` to an absolute Node executable path if PATH resolution is not reliable.
- macOS/Linux process tests require `node` on PATH or `HTT_NODE` set to an executable path.

## Manual QA

Codex:

1. Install and authenticate the Codex CLI outside the app.
2. Add a Codex provider with the absolute executable path.
3. Use a short health command such as `--version`.
4. Open a workspace Markdown file, open the AI assistant, and send a selected-node question.
5. Send a follow-up in the same thread and confirm prior context is respected.
6. Send a rewrite-style prompt, save the suggestion draft, and confirm Markdown is unchanged until review/apply.

Claude:

1. Install and authenticate the Claude CLI outside the app.
2. Add a Claude provider with the absolute executable path.
3. Use a short health command such as `--version`.
4. Repeat the selected-node, follow-up, cancellation, and rewrite draft checks above.

If a provider is not installed locally, record it as unverified rather than substituting a hosted API.
