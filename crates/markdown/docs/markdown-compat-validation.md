# Markdown Compatibility Validation

This crate-level compatibility suite protects parser and serializer behavior for
Markdown hierarchy, Markmap-readable output, Obsidian-style link syntax, standard
Markdown links, and unmapped raw content preservation.

## Automated Checks

Run these commands from the repository root:

```powershell
C:\Users\husle\.cargo\bin\cargo.exe fmt --manifest-path crates\markdown\Cargo.toml -- --check
C:\Users\husle\.cargo\bin\cargo.exe test --manifest-path crates\markdown\Cargo.toml
git diff --check -- crates\markdown
```

If `cargo` is on `PATH`, the same commands can be run with `cargo` instead of
the explicit executable path.

## Fixture Coverage

The shared fixture corpus lives in `crates/markdown/tests/fixtures/compat`.
Parser tests compare each Markdown file to an exact tree snapshot in
`expected/*.tree`. Serializer tests use the same fixtures for
parse -> serialize -> parse round trips and compare canonical Markmap output for
nested list imports.

The link matrix fixture keeps parser and serializer coverage for:

- `[[Unique Note]]`
- `[[Projects/Alpha/Decision]]`
- `[[Decision Log|decision alias]]`
- `[[Shared]]`
- `[[Missing Target]]`
- `[[case sensitive]]`
- `[Spec](docs/spec.md)`
- `[Overview](../overview.md)`
- `[Outside](../../outside.md)`
- `![Diagram](assets/diagram.png)`

The markdown crate records link syntax but does not resolve filesystem targets.
Resolver integration tests should reuse these same link shapes when resolver
code is available in a shared crate.

## Manual Markmap Check

1. Run the automated test suite so expected serializer output is current.
2. Open `crates/markdown/tests/fixtures/compat/expected/serialized_nested_lists.md`
   in a Markmap-compatible viewer.
3. Confirm the map renders as `Strategy` with `Discovery` and `Delivery`
   branches, and that `Interviews`, `Synthesis`, `Build`, and `Measure` remain
   leaf nodes.
4. Confirm there is no raw list syntax shown as node text. The serializer should
   emit canonical headings for this fixture.

## Manual Obsidian-Style Link Check

1. Copy `crates/markdown/tests/fixtures/compat/link_matrix.md` into a temporary
   Obsidian-style vault.
2. Add notes named `Unique Note.md`, `Projects/Alpha/Decision.md`,
   `Decision Log.md`, and two folders that each contain `Shared.md`.
3. Open `link_matrix.md` and confirm that unique, path-based, alias, duplicate,
   unresolved, and case-mismatch wikilinks remain visible with their original
   syntax.
4. Confirm standard relative links and the workspace-escape candidate remain
   plain Markdown links. The parser/serializer should preserve these strings;
   target validation belongs to resolver integration tests.
