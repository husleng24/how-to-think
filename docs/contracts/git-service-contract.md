# Local Git Repository Service Contract

- Status: Accepted contract for VIT-85
- Date: 2026-05-11
- Canonical app path: `apps/desktop/`

This contract defines the backend and frontend boundary for local Git repository
state, status, snapshots, history, diff, restore, typed failures, and path
safety. It is contracts-only: it does not add Git UI, CLI command groups, or a
runtime Git backend implementation.

## Scope

Included:

- Local repository detection and state taxonomy.
- Status, snapshot, history, diff, restore, and refresh DTOs.
- Stable UI-safe Git error codes.
- Repository state tokens for external Git operation detection.
- Operation permission rules for blocked and degraded repository states.
- Workspace-relative path handling for all public Git requests.

Excluded:

- Remote Git, hosting providers, branches as product concepts, rebase,
  submodules, LFS, credential flows, and network operations.
- Git detection/status/history/restore UI.
- CLI command group implementation.
- AI proposal apply and export contracts.

## Type Owners

The TypeScript surface lives in:

```text
apps/desktop/src/features/git-service/types.ts
apps/desktop/src/features/git-service/contract.ts
```

The Rust mirror lives in:

```text
apps/desktop/src-tauri/src/git_contracts.rs
```

Both sides expose the same stable error-code list, repository state list,
operation names, DTO field names, permission matrix behavior, and path
validation expectations. Tests exercise serialization and matrix alignment.

## Service Signatures

These are service contracts, not implemented command handlers:

```ts
git_detect_repository({ workspaceId }): GitRepositoryState
git_init_repository({ workspaceId }): GitRepositoryState
git_status({ workspaceId }): GitStatusSummary
git_create_snapshot(request: GitSnapshotRequest): GitSnapshotResult
git_history(request: GitHistoryRequest): GitHistoryEntry[]
git_diff(request: GitDiffRequest): GitDiffResult
git_restore_file(request: GitRestoreRequest): GitRestoreResult
git_refresh({ workspaceId }): GitRepositoryState
```

All requests are scoped to the selected workspace. Requests never accept host
absolute paths.

## Stable Error Codes

The public Git error-code set is:

```text
git_unavailable
not_repository
repository_corrupt
parent_repository
nested_repository
bare_repository
detached_head
merge_conflict
permission_denied
identity_missing
no_changes
invalid_ref
file_not_in_history
external_state_changed
restore_conflict
unknown_git_error
```

Path-scope failures intentionally map to `permission_denied` in Git operations
so the UI does not learn or display host filesystem authority details.

## Repository State Token

`GitRepositoryStateToken` is backend-controlled and opaque to the frontend. It
must include enough state to detect external Git operations before snapshot or
restore:

- `headOid`: current `HEAD` object id when available.
- `indexVersion`: index metadata version when available.
- `indexChecksum`: index checksum when available.
- `worktreeStatusGeneration`: backend-generated status generation derived from
  the observed worktree status.
- `token`: opaque combined token.
- `capturedAt`: ISO timestamp.

Snapshot and restore requests must echo the last observed token. Restore also
requires the current VIT-47 `FileVersion` for the target file. Snapshot requires
expected file versions for the scoped files being captured.

## Status and Snapshot Result Shape

`GitStatusSummary` reports UI-ready workspace-relative entries and summary
counts for `added`, `modified`, `deleted`, `renamed`, `untracked`, and
`ignored` Markdown workspace files. Ignored files can be shown in status, but
they are not eligible for snapshot staging.

`GitSnapshotResult` returns the full commit oid, a short commit oid, parent
oids, snapshot message, affected workspace-relative paths, affected file count,
the refreshed repository state, and the refreshed status after commit creation.

## Path Handling

Every public Git request path is a workspace-relative path using `/`
separators. Valid paths:

- have no leading `/`, Windows drive prefix, UNC prefix, or backslashes;
- have no empty, `.`, or `..` segments;
- have no control characters;
- never address `.git` as any path segment.

The backend remains the filesystem authority. VIT-47 path canonicalization,
symlink escape checks, workspace writable checks, and file version tokens remain
the source of truth for disk access. Git helpers add the `.git` internal-path
block and Git-specific error mapping on top of that boundary.

## Operation Permission Matrix

`detect` and `refresh` are read-only retries in every state.

| Repository state | Read-only operations | Mutating operations |
| --- | --- | --- |
| `valid_repository` | status, history, diff | snapshot, restore allowed; init returns `no_changes` |
| `nested_repository` | status, history, diff | snapshot, restore allowed against the selected nested repo; init returns `no_changes` |
| `parent_repository` | status, history, diff scoped to `relativePrefix` | init, snapshot, restore blocked by `parent_repository` |
| `detached_head` | status, history, diff | init, snapshot, restore blocked by `detached_head` |
| `merge_conflict` | status, history, diff | init, snapshot, restore blocked by `merge_conflict` |
| `not_repository` | status returns an empty/not-repo summary | init allowed; snapshot, history, diff, restore blocked by `not_repository` |
| `bare_repository` | none beyond detect/refresh | all file-scoped operations blocked by `bare_repository` |
| `repository_corrupt` | none beyond detect/refresh | all file-scoped operations blocked by `repository_corrupt` |
| `permission_denied` | none beyond detect/refresh | all file-scoped operations blocked by `permission_denied` |
| `git_unavailable` | none beyond detect/refresh | all Git operations blocked by `git_unavailable` |

## VIT-47 Dependencies

| Git operation | VIT-47 dependency |
| --- | --- |
| detect, refresh | selected workspace identity, canonical root, readable directory checks |
| init | selected workspace identity, canonical root, writable directory checks |
| status | selected workspace identity and workspace-relative path reporting |
| snapshot | workspace-relative path validation, current `FileVersion` tokens for scoped files, writable checks |
| history | workspace-relative path validation for optional path filters |
| diff | workspace-relative path validation for optional path filters |
| restore | workspace-relative path validation, current target `FileVersion`, conflict refusal before write |

The Git contract does not bypass the Markdown lifecycle. Restore writes must
still refuse stale file versions and return `external_state_changed` or
`restore_conflict` rather than silently overwriting a document.

## Backend Safety Notes

VIT-84 recommends system `git` behind a Rust trait for v1. This contract stays
compatible with that recommendation while keeping the DTOs backend-neutral. A
future runtime implementation must invoke Git with argument arrays, no shell,
no external diff or pager, no terminal prompts, and no implicit network
behavior.
