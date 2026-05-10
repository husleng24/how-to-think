# Workspace and Markdown File Lifecycle Contract

- Status: Accepted contract for VIT-54 Batch 1B
- Date: 2026-05-10
- Canonical app path: `apps/desktop/`

This contract defines the local workspace and raw Markdown file lifecycle shared by the Tauri backend and React frontend for the desktop product. It is based on the VIT-52 integration spike and the current scaffold target at `apps/desktop/`.

This document is intentionally documentation-only. It does not add Tauri filesystem commands, shared runtime types, generated bindings, or React state. Those are follow-up implementation tasks.

## Scope

This contract covers:

- Workspace root selection, creation, validation, persistence, and indexing.
- Workspace-relative Markdown file identity.
- Raw Markdown create, open, save, rename, and delete lifecycle.
- Dirty-state and save-state expectations in the React app.
- External filesystem change detection expectations.
- Path safety and traversal rejection.
- Stable error states for user-facing prompts.
- Follow-up implementation boundaries for VIT-56, VIT-59, and VIT-62.

This contract does not cover:

- Markdown parsing, normalization, rendering, or serialization compatibility. VIT-48 owns those rules.
- Editor node data model semantics. VIT-46 owns editor state and editing interactions.
- Git history, CLI automation, AI patches, or export behavior except where those features later reuse the same path safety rules.
- Any filesystem command implementation in this task.

## Ownership Boundaries

### Tauri Rust Backend

The backend is the filesystem authority. It owns:

- Native workspace picker and workspace directory creation.
- Canonicalization of selected workspace roots.
- Workspace read/write permission checks.
- Recents and remembered workspace settings stored in app data.
- Recursive Markdown file indexing.
- Path guards for every file operation.
- Raw UTF-8 file reads.
- Atomic file writes.
- Rename and delete operations.
- File version creation and comparison.
- External filesystem change observation where supported.
- Stable typed error payloads.

The backend must not trust frontend-supplied absolute paths for workspace file operations.

### React Frontend

The frontend owns user and editor lifecycle state. It owns:

- First-run workspace selection UI.
- File list UI and active file selection.
- Editor buffer state.
- Dirty state calculation.
- Manual save and autosave scheduling.
- Save-in-flight tracking.
- User prompts for unsaved changes, conflicts, missing files, and failed saves.
- Mapping typed backend errors to user-facing copy.

The frontend may display backend-provided workspace and file paths, but file commands must use workspace-relative paths only.

### Markdown Parser Boundary

This lifecycle layer treats document content as raw UTF-8 Markdown text. It must not rewrite Markdown structure, normalize frontmatter, change heading/list style, resolve Obsidian links, or apply Markmap compatibility rules.

VIT-48 owns Markdown parsing and serialization compatibility. VIT-54, VIT-56, VIT-59, and VIT-62 must preserve raw file content unless the user or editor explicitly changes it.

## Contract Types

The exact runtime schema should be generated or mirrored after the `apps/desktop/` contract location is selected by the scaffold work. Until then, these shapes are the source of truth.

```ts
type WorkspaceId = string;
type WorkspaceRelativePath = string;
type IsoDateTime = string;

interface WorkspaceInfo {
  id: WorkspaceId;
  displayName: string;
  displayPath: string;
  platform: 'windows' | 'macos' | 'linux';
  caseSensitive: boolean;
  writable: boolean;
  lastOpenedAt: IsoDateTime;
}

interface WorkspaceFile {
  relativePath: WorkspaceRelativePath;
  name: string;
  extension: '.md' | '.markdown';
  byteSize: number;
  modifiedAt: IsoDateTime;
  version: FileVersion;
}

interface FileVersion {
  modifiedAt: IsoDateTime;
  byteSize: number;
  contentHash: string;
  token: string;
}

interface DocumentSnapshot {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  content: string;
  version: FileVersion;
  openedAt: IsoDateTime;
}

interface SaveRequest {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  content: string;
  expectedVersion: FileVersion;
  reason: 'manual' | 'autosave';
}

interface SaveResult {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  version: FileVersion;
  savedAt: IsoDateTime;
  byteSize: number;
}

interface ExternalChangeEvent {
  workspaceId: WorkspaceId;
  relativePath: WorkspaceRelativePath;
  kind: 'created' | 'modified' | 'deleted' | 'renamed';
  observedAt: IsoDateTime;
  previousRelativePath?: WorkspaceRelativePath;
  version?: FileVersion;
}

interface WorkspaceError {
  code: WorkspaceErrorCode;
  message: string;
  recoverable: boolean;
  relativePath?: WorkspaceRelativePath;
  operation:
    | 'selectWorkspace'
    | 'createWorkspace'
    | 'loadWorkspace'
    | 'listFiles'
    | 'createFile'
    | 'openFile'
    | 'saveFile'
    | 'renameFile'
    | 'deleteFile'
    | 'watchWorkspace';
  details?: Record<string, string | number | boolean>;
}
```

`WorkspaceInfo.displayPath` is for display only. It may be an absolute platform path returned by the backend, but it must not be echoed back as authority for file operations.

`FileVersion.token` is backend-controlled and opaque to the frontend. It may be derived from modified time, file size, hash, device/inode metadata, or another deterministic backend strategy. The frontend may store it and send it back as an expected version, but must not parse or construct it.

## Workspace Root Rules

1. A workspace is a user-selected or user-created local directory.
2. The backend canonicalizes the selected directory before returning `WorkspaceInfo`.
3. The canonical root must exist, must be a directory, and must be readable.
4. Write operations require a writable root or a typed `workspace_unwritable` or `permission_denied` error.
5. The backend may accept a symlinked workspace selection only after resolving it to a canonical target directory.
6. Workspace identity is backend-defined. A stable hash of the canonical root is acceptable, but the frontend must treat `WorkspaceId` as opaque.
7. Workspace display name defaults to the selected directory basename and may be changed later only by a product-level rename/display preference feature.
8. The backend may remember recent workspaces in app data. It must not write app settings files into the user workspace unless a later feature explicitly adds workspace-local configuration.
9. Workspace file indexing includes `.md` and `.markdown` files, case-insensitive on case-insensitive filesystems and case-sensitive where the filesystem is case-sensitive.
10. The file index must ignore files outside the canonical root, including symlink escapes.
11. The file index should skip implementation and dependency directories such as `.git/`, `node_modules/`, `dist/`, `target/`, and `.tauri/` unless the user explicitly opens a file there through a future advanced flow.
12. Empty workspaces are valid and return an empty file list.

## Workspace-Relative Path Contract

Frontend file commands must identify files by `WorkspaceRelativePath`.

Valid workspace-relative paths:

- Use `/` as the separator on all platforms.
- Are relative to the active workspace root.
- Have no leading `/`.
- Have no Windows drive prefix such as `C:`.
- Have no UNC prefix such as `//server/share`.
- Have no backslash separators.
- Have no empty path segments.
- Have no `.` or `..` path segments.
- Have no NUL bytes or control characters.
- End in `.md` or `.markdown`.
- Resolve to a canonical path contained inside the canonical workspace root.

Invalid path examples:

```text
../notes.md
notes/../../secret.md
/Users/example/notes.md
C:/Users/example/notes.md
\\server\share\notes.md
notes\idea.md
notes//idea.md
notes/.hidden/../idea.md
notes/idea.txt
```

On Windows, backend validation must also reject reserved device names such as `CON`, `PRN`, `AUX`, `NUL`, `COM1`, and `LPT1` when they occur as a path segment with or without a Markdown extension.

Path validation must happen before every read, write, rename, delete, and watch-related operation. Validation failure must return a typed error and must not fall back to best-effort path manipulation.

## Markdown File Lifecycle

### First Launch

1. Frontend asks the backend to load the remembered workspace.
2. Backend returns either a valid `WorkspaceInfo` plus current file index, no remembered workspace, or a typed workspace error.
3. If there is no valid remembered workspace, the frontend presents select/create workspace actions.
4. Selecting or creating a workspace returns `WorkspaceInfo` and a file index.

### Create File

1. Frontend proposes a workspace-relative Markdown path and optional initial raw Markdown content.
2. Backend validates the path and ensures the resolved target remains inside the workspace.
3. Backend rejects name collisions unless a future explicit overwrite flow is added.
4. Backend writes initial UTF-8 content through the same durable write primitive used by save operations.
5. Backend returns a `DocumentSnapshot` with the new `FileVersion`.
6. Frontend makes the returned snapshot the clean baseline.

### Open File

1. Frontend sends only `workspaceId` and `relativePath`.
2. Backend validates the workspace and path.
3. Backend reads the file as UTF-8 raw Markdown.
4. Backend computes `FileVersion`.
5. Backend returns `DocumentSnapshot`.
6. Frontend replaces the active document only after unsaved-change guards pass.
7. The returned `content` becomes the frontend clean baseline for dirty-state comparison.

### Edit Buffer

1. The editor mutates only frontend buffer state.
2. Dirty state becomes true when the current buffer differs from the last clean baseline or when there are acknowledged local edits after the last successful save request was created.
3. Parser-derived mind map state must not be treated as the file authority in this layer.

### Save File

1. Frontend sends `SaveRequest` with `content` and the last clean `expectedVersion`.
2. Backend validates workspace and path.
3. Backend reads current disk metadata/version before writing.
4. If the current disk version does not match `expectedVersion`, backend returns `version_conflict` and must not overwrite the file.
5. If the version matches, backend writes atomically using a temp file in the same directory followed by durable replacement.
6. Backend returns `SaveResult` with a new `FileVersion`.
7. Frontend marks the document clean only if the saved content still matches the current editor buffer when the result arrives.
8. If the user edited during the in-flight save, frontend records the new version baseline for the saved content but keeps the document dirty and schedules or allows another save.

Manual save and autosave must call the same backend save path. Autosave must never bypass version checks.

### Rename File

1. Frontend sends old and new workspace-relative paths.
2. Backend validates both paths.
3. Backend rejects destination collisions unless a future explicit overwrite flow is added.
4. Backend verifies the old path version when the active document is being renamed.
5. Backend performs the rename within the workspace only.
6. Backend returns the updated file identity, file index delta, and version if the renamed file is active.
7. Frontend updates active document identity without clearing dirty content.

### Delete File

1. Frontend sends `workspaceId`, `relativePath`, and expected version when deleting an active or recently opened file.
2. Backend validates the path and version where supplied.
3. Backend deletes only the resolved file inside the workspace.
4. Backend returns success and file index delta.
5. Frontend does not discard an unsaved active buffer unless the user explicitly confirms deletion or discard.

## Dirty State and Save States

The frontend state machine should distinguish:

- `no_workspace`: no workspace is selected or remembered.
- `no_document`: a workspace is loaded but no file is active.
- `clean`: current buffer equals the last clean baseline.
- `dirty`: current buffer has local unsaved edits.
- `saving`: a manual save or autosave is in flight.
- `save_failed`: the last save attempt failed for a recoverable reason.
- `conflict`: disk changed after the document was opened or last saved.
- `missing`: the active file was deleted, moved, or became inaccessible.
- `externally_changed`: disk changed while the active buffer was clean or before the user chose a conflict action.

Save result handling must be content-aware:

- A successful save clears dirty state only when the editor buffer still equals the content sent in that save request.
- A failed save never clears dirty state.
- A conflict never discards local edits.
- A missing-file error never discards local edits.
- Switching files, closing a document, closing a workspace, or closing the app while dirty must prompt with Save, Discard, and Cancel choices.

## External Change Detection Expectations

The backend should detect external changes at these minimum checkpoints:

- Before save.
- Before rename or delete when a version is supplied.
- When opening a file.
- When refreshing the file index.
- When the app regains focus, if watcher support is not yet available.

Native file watching is expected in VIT-56 or a closely related backend task. Watch events may be coalesced and should be treated as hints. The backend must re-stat or re-read as needed before returning authoritative versions.

When an external change is observed:

1. Backend emits or returns an `ExternalChangeEvent`.
2. Frontend refreshes file list metadata for non-active files.
3. If the active file is clean and modified, frontend may offer Reload and Keep Current View. It must not silently replace content while the user is editing.
4. If the active file is dirty and modified, frontend enters `conflict`.
5. If the active file is deleted, frontend enters `missing` and keeps the in-memory buffer available.
6. If the active file is renamed externally, backend may report this as deleted plus created unless it can identify a rename reliably.

Conflict resolution UI is owned by VIT-62. Backend conflict detection and refusal to overwrite is owned by VIT-59.

## Error Codes

Error codes are stable contract values. User-facing strings may change, but code names must remain compatible once implemented.

| Code | Typical operation | Recoverable | Meaning |
| --- | --- | --- | --- |
| `workspace_not_selected` | file operations | yes | No active workspace is available. |
| `workspace_missing` | load/list/open/save | yes | Remembered workspace no longer exists. |
| `workspace_not_directory` | select/load | yes | Selected path is not a directory. |
| `workspace_unwritable` | create/save/rename/delete | yes | Workspace can be read but not written. |
| `permission_denied` | any filesystem operation | yes | OS denied access. |
| `invalid_workspace_path` | select/create | yes | Workspace path cannot be canonicalized or is unsupported. |
| `invalid_relative_path` | file operations | yes | Relative path failed syntax validation. |
| `path_outside_workspace` | file operations | yes | Resolved path escapes the canonical workspace root. |
| `unsupported_file_type` | create/open/save | yes | File is not `.md` or `.markdown`. |
| `file_not_found` | open/save/rename/delete | yes | Target file is missing. |
| `file_already_exists` | create/rename | yes | Target path already exists. |
| `invalid_utf8` | open | yes | File cannot be read as UTF-8 Markdown. |
| `version_conflict` | save/rename/delete | yes | Disk version differs from expected version. |
| `write_failed` | create/save | yes | Write failed for an IO reason not represented by a narrower code. |
| `disk_full` | create/save | yes | Write failed because storage is full or quota was exceeded. |
| `rename_failed` | rename | yes | Rename failed after validation. |
| `delete_failed` | delete | yes | Delete failed after validation. |
| `watch_unavailable` | watchWorkspace | yes | Native file watching is unavailable; polling/focus refresh may continue. |
| `operation_cancelled` | select/create dialogs | yes | User cancelled a native dialog or confirmation. |
| `unknown_io_error` | any filesystem operation | maybe | Unexpected OS or filesystem failure. |

Errors should include a sanitized `relativePath` when useful. They should not expose unexpected absolute paths in normal UI payloads.

## Follow-Up Implementation Boundaries

### VIT-56: Tauri Workspace Filesystem Backend

VIT-56 should implement:

- Workspace selection and creation commands.
- Remembered and recent workspace settings.
- Canonical `WorkspaceInfo` creation.
- Workspace read/write validation.
- Recursive Markdown file indexing.
- Path guard utilities shared by all backend file commands.
- Symlink escape rejection.
- Workspace file watcher or focus-refresh fallback.
- Typed workspace errors from this contract.

VIT-56 should not implement:

- Raw document save atomic write lifecycle beyond helpers needed for validation.
- React dirty-state prompts.
- Markdown parsing or serialization.

### VIT-59: Markdown Document Save Lifecycle

VIT-59 should implement:

- Create, open, save, rename, and delete document backend services.
- Raw UTF-8 Markdown read/write.
- `DocumentSnapshot`, `SaveRequest`, and `SaveResult` command payloads.
- `FileVersion` generation and expected-version comparison.
- Atomic write with temp file in the same directory and durable replacement.
- Conflict detection before overwrite.
- Precise errors for missing file, external modification, invalid UTF-8, write failure, disk full, permission denied, rename failure, and delete failure.
- Service or command tests for external edit, deletion, rename, empty file, and path escape cases.

VIT-59 should not implement:

- Frontend autosave scheduling or prompts.
- Parser-level Markdown compatibility.
- Git commits or history.

### VIT-62: React Workspace and File Lifecycle State

VIT-62 should implement:

- Frontend workspace/file store.
- First-run select/create workspace flow.
- File sidebar and file action orchestration.
- Active `DocumentSnapshot` state.
- Dirty-state and save-state transitions.
- Manual save and autosave using the same backend command.
- In-flight save race handling.
- Unsaved-change guards for file switch, close, and app close.
- User-facing prompts for conflict, missing file, permission errors, failed save, and invalid paths.
- External change event handling.
- Mocked Tauri command tests for success, failure, conflict, and rapid edit/autosave races.

VIT-62 should not implement:

- Filesystem authority or path guard logic.
- Atomic writes.
- Markdown parser compatibility logic.

## Acceptance Mapping

- Workspace root rules are defined in "Workspace Root Rules".
- Markdown file open/save lifecycle is defined in "Markdown File Lifecycle".
- Dirty state is defined in "Dirty State and Save States".
- External change detection expectations are defined in "External Change Detection Expectations".
- Path safety is defined in "Workspace-Relative Path Contract".
- Error states are defined in "Error Codes".
- Follow-up boundaries for VIT-56, VIT-59, and VIT-62 are defined in "Follow-Up Implementation Boundaries".
