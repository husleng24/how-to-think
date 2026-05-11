# AI Proposal Review And Apply Verification

Use this checklist for deterministic AI proposal review/apply QA. Automated tests use fixture proposals; manual verification should use the same scenario names and avoid live AI provider output unless explicitly validating provider wiring.

## Automated Coverage

Run from the repository root:

```bash
npm.cmd run typecheck --prefix apps\desktop
npm.cmd run lint --prefix apps\desktop
npm.cmd test --prefix apps\desktop
```

The fixture suite in `src/features/ai-proposals/application/proposalSafetyRegression.test.ts` covers:

- Review-before-mutation: receiving a proposal creates review metadata while editor document, Markdown buffer, file version, dirty state, selection, and undo history stay unchanged.
- Reject no-op: rejecting archives the proposal and keeps the captured editor state references unchanged.
- Current-file accept: branch rewrite, node expansion, and summary replacement update visual state and serialized Markdown together.
- Undo regression: accepted AI changes create one proposal transaction, and undo restores the pre-apply editor and Markdown state.
- Large deletion warning: destructive proposals expose `large_deletion` risk and remain undoable.
- Conflict/failure no-op paths: stale document version, stale file version from external changes, unsupported operations, Markmap-invalid hierarchy diagnostics, serializer failure, and backend save failure preserve user content.
- Multi-file guard rails: affected-file confirmation is required before preflight, dirty/stale/ambiguous-link preflight blocks writes, wikilink impact refreshes link indexes, and partial sequential writes report rollback status.

## Manual Desktop Checklist

1. Open a workspace with `notes/root.md` containing Root, Alpha, Alpha child, Beta, and a wiki link from Beta to `notes/other.md#Beta`.
2. Inject or replay the branch rewrite fixture. Confirm the AI proposal panel appears before the canvas or Markdown buffer changes.
3. Reject the proposal. Confirm the canvas, Markdown text, dirty indicator, file version, and undo stack are unchanged.
4. Replay the branch rewrite fixture, confirm the branch move risk, then accept. Confirm Beta moves under Alpha in the canvas and the Markdown preview serializes Beta at the nested heading level with the wiki link preserved.
5. Undo once. Confirm the canvas and Markdown return to the exact pre-apply state.
6. Replay node expansion and summary replacement fixtures. Confirm each accept creates one undoable change and no extra history entries.
7. Replay the large deletion fixture. Confirm deletion risk copy is visible before accept and undo restores every deleted child.
8. With unsaved edits in `notes/root.md`, replay any fixture generated from the previous document version. Confirm accept is blocked and no save/write occurs.
9. Modify `notes/root.md` externally before accepting a proposal. Confirm the stale file conflict is shown and user content is preserved.
10. Replay invalid output fixtures for unsupported link operation, Markmap-invalid hierarchy, serializer failure, and backend write failure. Confirm the proposal enters conflict/failed state without modifying editor or Markdown content.
11. Replay the multi-file wikilink fixture. Confirm affected-file confirmation is required, dirty or stale open files block preflight, clean apply refreshes open documents and link indexes, and partial write failure reports rollback status.

## Unsupported Manual Cases

Native Tauri filesystem dialogs, OS permission failures, and real external editor races require a machine with Rust/Cargo, Tauri prerequisites, and a real workspace directory. If those prerequisites are unavailable, record the skipped platform checks in the issue report.
