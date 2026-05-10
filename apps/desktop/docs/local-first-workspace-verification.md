# Local-First Workspace Verification

Use this checklist to manually verify the integrated local Markdown workspace lifecycle after the automated desktop checks pass.

## Automated Commands

Run from the repository root:

```powershell
npm.cmd run typecheck --prefix apps\desktop
npm.cmd run lint --prefix apps\desktop
npm.cmd run test:workspace --prefix apps\desktop
npm.cmd test --prefix apps\desktop
npm.cmd run build:web --prefix apps\desktop
cargo fmt --manifest-path apps\desktop\src-tauri\Cargo.toml --check
cargo test --manifest-path apps\desktop\src-tauri\Cargo.toml
git diff --check
```

If `cargo` is not on `PATH` on Windows, use:

```powershell
C:\Users\husle\.cargo\bin\cargo.exe fmt --manifest-path apps\desktop\src-tauri\Cargo.toml --check
C:\Users\husle\.cargo\bin\cargo.exe test --manifest-path apps\desktop\src-tauri\Cargo.toml
```

## Fixture Workspace

Create a temporary local folder with:

```text
README.md
notes/plan.md
notes/empty.md
notes/plain.md
notes/todo.txt
assets/diagram.png
```

Suggested content:

```markdown
# Plan

## Step A
```

Keep `notes/empty.md` empty. Put prose without headings in `notes/plain.md`. The app should index only `.md` and `.markdown` files and should not treat `notes/todo.txt` or `assets/diagram.png` as Markdown documents.

## First Run And Restart

1. Disconnect from the network or disable Wi-Fi.
2. Start the Vite dev server with `npm.cmd run dev --prefix apps\desktop`.
3. Start the Tauri shell with `npm.cmd run tauri:dev --prefix apps\desktop`.
4. On first launch, enter the fixture workspace path and open it.
5. Create `notes/restart.md`, add or edit a node, and save.
6. Quit the app completely.
7. Start the app again and confirm the same workspace is remembered.
8. Reopen `notes/restart.md` and confirm the saved Markdown content is unchanged on disk.

The workflow should complete while disconnected from the network. No browser download, provider setup, or remote service should be required for selecting a workspace, creating a Markdown file, opening it, saving it, or reopening it after restart.

## External Edit Conflict

1. Open `notes/plan.md` in the app.
2. Edit the document in the app but do not save.
3. Open the same file in an external editor such as VS Code, Notepad, TextEdit, or `nano`.
4. Change the file externally and save it.
5. Return to the app and press Save.
6. Confirm the app reports an external conflict and does not overwrite the external file.
7. Confirm the in-memory app edits are still visible.

## External Delete Or Move

1. Open `notes/plan.md` in the app.
2. Edit the document in the app but do not save.
3. Delete or move `notes/plan.md` using File Explorer, Finder, or the terminal.
4. Return to the app and press Save.
5. Confirm the app reports the file as missing and keeps the in-memory app edits visible.

## Unsaved Changes

1. Open `notes/plan.md`.
2. Edit the document.
3. Select another Markdown file.
4. Confirm the app shows Save, Discard, and Cancel.
5. Select Cancel and confirm the original file stays open.
6. Try closing the app window and confirm the operating system close prompt appears.

## Invalid Path And Permission Checks

1. Try creating `../outside.md`, `/absolute.md`, `notes\task.md`, and `notes/task.txt`.
2. Confirm each invalid path is rejected and no file is created outside the workspace.
3. Where practical, make the workspace read-only at the OS level and try saving.
4. Confirm the app reports a permission or unwritable workspace error without clearing local edits.
