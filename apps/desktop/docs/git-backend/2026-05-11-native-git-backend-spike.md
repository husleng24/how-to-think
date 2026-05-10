# Native Git backend spike

Date: 2026-05-11
Base: `main` at `fc0fd1950413ecd7800dee75bde4f70b3edc7d8f`
Issue: VIT-84

## Scope

This spike confirms the Git backend integration boundary for the current
desktop scaffold, compares `git2`/libgit2 with invoking a system `git`
executable, proves the required Git operations in temporary repositories, and
defines the first-version repository state taxonomy. It does not add runtime
Tauri commands, React UI, CLI bridge behavior, AI handoff behavior, or export
logic.

## Current repository anchors

- Desktop app package: `apps/desktop/package.json`
- Tauri crate: `apps/desktop/src-tauri/Cargo.toml`
- Tauri library entrypoint: `apps/desktop/src-tauri/src/lib.rs`
- Tauri command adapter: `apps/desktop/src-tauri/src/commands.rs`
- Workspace root validation: `apps/desktop/src-tauri/src/workspace.rs`
- Workspace path safety: `apps/desktop/src-tauri/src/path_guard.rs`
- Shared Rust DTO/error patterns: `apps/desktop/src-tauri/src/models.rs` and
  `apps/desktop/src-tauri/src/errors.rs`
- React workspace command adapter: `apps/desktop/src/features/workspace/commands.ts`
- React workspace DTO patterns: `apps/desktop/src/features/workspace/types.ts`

The checkout has no root `Cargo.toml`; Rust follow-up commands should use
`--manifest-path apps/desktop/src-tauri/Cargo.toml`.

## Recommended module locations

Add the backend service inside the existing desktop Tauri crate:

```text
apps/desktop/src-tauri/src/git/
  mod.rs
  backend.rs
  system_git.rs
  repository.rs
  models.rs
  errors.rs
```

`backend.rs` should define a small trait for the operations the app needs:
detect repository state, initialize, status, commit, history, diff, and restore.
`system_git.rs` should implement that trait with `std::process::Command` and
argument arrays. `repository.rs` should hold workspace-root scoping, pathspec
normalization, and result parsing. `models.rs` and `errors.rs` should contain
serializable DTOs that mirror the existing `WorkspaceError` and `Workspace*`
model style.

Expose Tauri commands either as a new `apps/desktop/src-tauri/src/git/commands.rs`
module re-exported from `lib.rs`, or as thin adapters in the existing
`commands.rs`. Keep all Git logic out of the adapter layer. Each command should
resolve the selected `WorkspaceRecord` through the existing settings path, then
call the Git service.

Recommended frontend paths:

```text
apps/desktop/src/features/versioning/
  commands.ts
  types.ts
  errorMapping.ts
  versioningStore.ts
  components/
```

Use `versioning` for the product-facing feature name and keep Git-specific
terms inside DTO fields where needed. Shared, stable DTOs that cross feature
boundaries can move to `apps/desktop/src/types/versioning.ts` once more than one
feature consumes them.

## Backend recommendation

Use system `git` invocation for v1, behind a Rust backend trait.

Reasons:

- Compatibility is highest with existing `.git` repositories, worktrees, branch
  states, merge conflict metadata, pathspec behavior, and user expectations.
- No libgit2 native build, OpenSSL, SSH, certificate, or MSVC packaging burden is
  added to the Tauri crate.
- The required operations are available through stable porcelain or plumbing
  commands and can be parsed without shell execution.
- Detached HEAD, unmerged index entries, bare repositories, nested repositories,
  and corrupted repositories are straightforward to detect with the installed
  Git binary.
- The same backend can later be replaced by a bundled Git distribution or a
  `git2` implementation because the trait boundary is small.

Trade-offs:

- Production packaging must either find `git` on `PATH`, discover common install
  locations, or bundle a Git distribution. If none is available, the app must
  surface `backend_unavailable`.
- Process spawning is slower than in-process calls, but the expected Markdown
  workspace scale is small enough for status/history/diff operations to remain
  acceptable when calls are debounced and scoped.
- CLI output must be parsed carefully. Use `--porcelain=v1 -z` or explicit
  `--format` output, never localized free-form text.
- Invoking Git can run repository-configured behavior unless constrained. Use no
  shell, set a minimal environment, disable pagers/external diff, set
  `GIT_TERMINAL_PROMPT=0`, use `--no-optional-locks` for read-only operations,
  and disable hooks for app-created commits with `--no-verify` plus an empty
  `core.hooksPath`.

Do not choose `git2`/libgit2 for v1. It gives tighter in-process control and
avoids a runtime Git dependency, but it adds native dependency packaging risk,
does not exactly match command-line Git behavior, and requires more custom code
for repository edge cases that the CLI already handles. Revisit `git2` only if
the product requires Git features when no executable can be installed or bundled,
or if future security requirements prohibit spawning any repository-aware
executable.

## Operation design

Detection:

- First verify the workspace root with the existing `validate_workspace_root`.
- Locate `git` and capture its version. If spawn fails, return
  `backend_unavailable`.
- Run `git -C <workspace> rev-parse --show-toplevel`,
  `git -C <workspace> rev-parse --git-dir`,
  `git -C <workspace> rev-parse --is-bare-repository`, and
  `git -C <workspace> rev-parse --is-inside-work-tree`.
- Compare the returned top-level path with the selected workspace root to
  distinguish valid root, parent repository, and nested repository states.

Init:

- Permit `git init` only when the selected workspace is `not_repository`.
- If the selected workspace is inside a parent repository, block by default and
  require an explicit "create nested repository" follow-up decision.
- Initialize with the current default branch unless product requirements define a
  branch name. Do not change global Git config.

Status:

- Use `git -C <repo> --no-optional-locks status --porcelain=v1 -z --branch`.
- In parent-repository mode, pass `-- <workspace-relative-prefix>` so the app
  only reports files under the selected workspace.
- Parse staged, unstaged, untracked, renamed, deleted, and unmerged entries into
  typed records.

Commit:

- Stage only validated workspace-relative Markdown paths.
- Use argument arrays, not a shell.
- Set author/committer from app settings or a local app identity.
- Disable GPG signing for app-created local commits unless the user explicitly
  opts in.
- Disable hooks for app-created commits. Running workspace hooks from a desktop
  app is a security boundary and should not be implicit.
- Block commits in `detached_head`, `merge_conflict`, `bare_repository`,
  `corrupted_repository`, `permission_denied`, and `backend_unavailable` states.

History:

- Use `git log --format=<NUL-delimited fields> -z -- <pathspec>` for predictable
  parsing.
- Return commit id, parents, author, author time, subject, and touched paths.
- Scope history to the selected workspace or a validated Markdown path.

Diff:

- Use `git diff --no-ext-diff --no-color -- <pathspec>` for working-tree diffs.
- Use `git diff --no-ext-diff --no-color <base> <head> -- <pathspec>` for
  revision diffs.
- Consider adding `--word-diff=porcelain` later for Markdown-aware UI display,
  but keep v1 line-based.

Restore:

- Use `git restore --source=<revision> -- <validated pathspec>`.
- Check the app's existing dirty-document/version conflict state before writing
  to disk.
- For restoring an older version without committing, restore from the selected
  revision into the working tree and return a normal modified-file status.

## Repository state taxonomy

Expose a single primary state with details. Recommended precedence:

| State | Detection | First-version behavior |
| --- | --- | --- |
| `backend_unavailable` | `git --version` cannot spawn or fails minimum-version check. | Disable all Git actions and show install/bundle guidance. |
| `permission_denied` | Workspace or `.git` metadata cannot be read/written due to OS permissions. | Disable mutating actions; allow retry after permission change. |
| `corrupted_repository` | `.git` exists but `rev-parse` or `status` reports invalid metadata. | Disable mutating actions; show the failing command detail. |
| `bare_repository` | `rev-parse --is-bare-repository` returns `true`. | Treat as unsupported for a Markdown workspace; ask user to choose a worktree. |
| `merge_conflict` | Unmerged index entries from `git diff --name-only --diff-filter=U` or porcelain `U*`/`*U`. | Allow status/diff/history; block app commit and broad restore until conflicts are resolved externally or by a future conflict UI. |
| `detached_head` | `git symbolic-ref -q --short HEAD` fails while a valid commit exists. | Allow status/diff/history; block app commit to avoid hidden detached commits. |
| `nested_repository` | Selected workspace root is a repo and an ancestor is also a repo. | Use the selected workspace repo, warn that ancestor repo state is ignored. |
| `parent_repository` | Selected workspace is inside an ancestor repo but is not the repo root. | Scope status/diff/history to the selected workspace path; block init unless user confirms nested repo creation. |
| `valid_repository` | Selected workspace root is a normal worktree repo. | Enable v1 Git actions subject to dirty-document checks. |
| `not_repository` | No current or parent `.git` repository is detected. | Offer `git init`; status/history/diff/restore return empty or unavailable states. |

The DTO should also include `repoRoot`, `selectedRoot`, `relativePrefix`,
`headOid`, `branchName`, `gitVersion`, and `lastCheckedAt` where available.

## Backend comparison

| Dimension | System `git` | `git2`/libgit2 |
| --- | --- | --- |
| Standard `.git` compatibility | Best match; same implementation users already trust. | Good for common repos, but differences from CLI Git must be tested and documented. |
| Packaging | Needs runtime discovery or bundled Git; Git for Windows is more than one executable. | Adds native library build and packaging inside the Rust/Tauri app. |
| Failure modes | Missing executable, old Git version, PATH problems, hooks/filters/config surprises. | Build failures, libgit2/OpenSSL/SSH/cert issues, behavioral gaps. |
| Security boundary | Safe only with no shell, constrained env, scoped paths, disabled hooks, and careful config handling. | Fewer process-spawn concerns and no Git hooks by default, but still must guard filesystem paths. |
| Performance | Process startup overhead; acceptable for debounced Markdown workspace operations. | Faster for repeated in-process operations. |
| Merge/detached states | Direct and familiar CLI detection. | Supported but requires more custom state interpretation. |
| Maintenance | Parse stable Git output and map exit codes. | Own more Git behavior and native dependency lifecycle. |

## Prototype and validation

Prototype:

```text
apps/desktop/docs/git-backend/system-git-prototype.mjs
```

The prototype uses Node's `spawnSync` with `shell: false` and temporary
repositories. It exercises:

- not-repository detection
- `git init`
- status after file creation
- commit
- history
- diff
- restore from `HEAD`
- restore from `HEAD~1` as an uncommitted working-tree change
- parent repository detection
- nested repository detection
- detached HEAD detection
- merge conflict detection
- bare repository detection
- corrupted repository detection

Validation run on Windows in this workspace:

```powershell
git --version
# git version 2.52.0.windows.1

node --version
# v25.2.1

node --check apps\desktop\docs\git-backend\system-git-prototype.mjs
# passed

node apps\desktop\docs\git-backend\system-git-prototype.mjs
# passed and emitted JSON evidence for the operations and states above

git diff --check
# passed
```

`cargo --version` and `rustc --version` were unavailable in this runner, so no
Rust compilation was attempted. macOS, Linux packaged app behavior, production
Git discovery, and bundled Git behavior remain unverified.

## Downstream recommendation

1. Add the `apps/desktop/src-tauri/src/git/*` backend trait and `SystemGit`
   implementation first, with unit tests that create temporary repositories
   using `tempfile`.
2. Add read-only Tauri commands for repository state and status before adding
   commit or restore.
3. Wire React under `apps/desktop/src/features/versioning/` using typed command
   wrappers and error mapping.
4. Add commit and restore only after integrating with the existing dirty
   document/version conflict checks.
5. Create a packaging follow-up for Git discovery and bundling. The app should
   start with PATH/common-location discovery and a clear `backend_unavailable`
   state; production reliability likely needs bundled Git per platform.
6. Keep the service trait small so `git2` or a bundled executable strategy can
   replace the command backend without changing UI contracts.

## Known limitations

- The prototype validates feasibility of Git operations, not Tauri command
  wiring.
- Permission-denied behavior is defined in the taxonomy but not reproduced in
  the prototype because portable permission mutation is unreliable on Windows
  temporary directories.
- Git filters and attributes need a dedicated security pass before app-created
  commits or restores ship for untrusted workspaces.
