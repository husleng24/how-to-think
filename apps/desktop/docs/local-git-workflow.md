# Local Git Workflow Guide

This guide describes the first-version local Git workflow in the How to Think
desktop app. It is for users and operators who need to validate or troubleshoot
local version snapshots for Markdown workspaces.

## First-Version Scope

The app supports local Git only:

- enable Git for a selected local workspace with `git init`
- refresh repository status
- create a local snapshot commit from eligible Markdown changes
- view workspace or active-file history
- inspect structured diffs
- restore a Markdown file from history
- detect external change conflicts before snapshot or restore writes

The backend uses the system `git` executable through argument-array process
calls. It does not use a shell, an external diff tool, a pager, terminal prompts,
remote network commands, or hosting-provider APIs.

## User Workflow

1. Open a local workspace.
2. If Git is off, choose **Enable Git**. Existing files are preserved.
3. Edit and save Markdown through the normal workspace lifecycle.
4. Refresh Git status and review changed, deleted, renamed, and untracked
   Markdown files. Ignored files are visible as ignored but are not snapshotted.
5. Create a snapshot with a short message.
6. Open history for the active file or whole workspace.
7. Select a history entry to inspect its diff.
8. Restore a file when needed, then review the restored content as a normal
   pending workspace change before creating any follow-up snapshot.

External change detection protects this workflow. If the repository token or
file version changed after the UI loaded status/history, the app blocks the
stale action and asks the user to refresh or reopen before retrying.

## Restore Semantics

Restore writes historical Markdown into the working tree. It does not reset
HEAD, switch branches, commit automatically, rebase, or discard unrelated
changes. Restored content is opened through the Markdown parser path and remains
subject to the normal serializer and save compatibility rules.

AI-applied Markdown changes follow the same lifecycle. Once an AI change is
saved to disk, Git status shows it as a reviewable local change. A snapshot can
capture it, history can display it, diff can compare it, and restore can recover
that snapshot later.

## Blocked States

| State | What the user sees | Recommended action |
| --- | --- | --- |
| Git unavailable | Git actions are disabled. | Install Git or make `git` available on `PATH`, then refresh status. |
| Missing identity | Snapshot fails before committing. | Configure `user.name` and `user.email`, or provide an app author identity. |
| Merge conflict | Status/history/diff may be readable; snapshot and restore are blocked. | Resolve conflicts with Git tools, then refresh status. |
| Detached HEAD | Read-only history/status/diff may work; snapshot and restore are blocked. | Check out a branch outside the app, then refresh status. |
| Repository corruption | Repository metadata cannot be read safely. | Repair or recreate `.git` with external Git tools before using app Git actions. |
| Permission denied | The workspace or `.git` metadata cannot be read or written. | Fix filesystem permissions or choose a writable workspace. |
| External modification | Snapshot or restore is stale. | Refresh status or reopen the file, review current disk content, then retry. |
| Parent repository | Selected folder is inside another repository. | Use the repository root, or create a separate workspace repository outside v1 app flow. |
| Bare repository | The selected folder is not a writable worktree. | Choose a normal worktree workspace. |

## Supported Platforms And Packaging

The app is intended to run on Windows, macOS, and Linux wherever the Tauri
desktop prerequisites and a compatible system Git installation are available.
Current v1 packaging does not bundle Git. Operators should verify `git --version`
in the app environment and ensure the executable is discoverable by the desktop
process.

The backend intentionally avoids remote credentials and network access. No
GitHub, GitLab, SSH, HTTPS credential helper, push, pull, fetch, clone, or
hosting-provider behavior is required for validation.

## Validation Commands

Run these from the repository root before reporting Git workflow changes:

```powershell
cargo fmt --manifest-path apps\desktop\src-tauri\Cargo.toml -- --check
cargo test --manifest-path apps\desktop\src-tauri\Cargo.toml
npm.cmd run typecheck --prefix apps\desktop
npm.cmd run lint --prefix apps\desktop
npm.cmd test --prefix apps\desktop
git diff --check
```

Focused checks while iterating:

```powershell
cargo test --manifest-path apps\desktop\src-tauri\Cargo.toml --test git_workflow_regression
npm.cmd run test:smoke --prefix apps\desktop -- src/features/git-workflow/GitWorkflowPanel.test.tsx
npm.cmd run test:unit --prefix apps\desktop -- src/features/git-service/gitServiceContract.test.ts
```

## Non-Goals

- No remote push, pull, fetch, clone, or sync.
- No branch creation, branch switching UI, detached-HEAD recovery UI, or rebase.
- No submodule, LFS, sparse-checkout, worktree-management, hook-management, or
  hosting-provider workflow.
- No export fixture or export documentation coverage.
- No automatic commit after restore.
- No direct editing of `.git` internals from UI commands.
