# Markdown Compatibility Crate

`crates/markdown` owns the Markdown-to-mindmap compatibility boundary for How to Think.
It is intentionally independent from Tauri, React, workspace storage, and filesystem
watching so desktop commands, CLI commands, and tests can all consume the same JSON
model.

## Public Model

The crate exposes:

- `MindMapDocument` as the stable parser output.
- `MindMapNode` for virtual root, heading, and list-item nodes.
- `MarkdownOrigin` and `SourceSpan` for source placement metadata.
- `LinkToken` for standard Markdown links, image links found in node text, and
  Obsidian wikilinks such as `[[Topic]]`, `[[path/to/Topic]]`, and
  `[[Topic|Alias]]`.
- `UnmappedMarkdownBlock` for content that must be preserved but is not editable as
  a mind map node in v1.
- `CompatibilityDiagnostic` for empty files, skipped hierarchy levels, mixed
  structures, malformed links, and raw-block preservation notes.
- `SerializeMarkdownRequest` / `SerializeMarkdownResponse` for pure Markdown
  serialization with deterministic canonical output and lossy-save diagnostics.

## Mapping Rules

- Heading documents use heading levels as the hierarchy. Skipped levels attach to
  the nearest available lower heading or the virtual root and emit a diagnostic.
- List documents use indentation to preserve sibling order and nesting. Ordered,
  unordered, and task-list markers are kept on each list node.
- Mixed heading/list documents are deterministic: headings remain the primary
  branch anchors, and list items attach to the nearest list parent or current
  heading. A `mixed_hierarchy` diagnostic tells callers the source may require
  confirmation before lossy serialization.
- Frontmatter, paragraphs, code fences, tables, images, HTML, comments,
  blockquotes, thematic breaks, and unknown blocks are retained in
  `unmappedBlocks`.

The current implementation is a deterministic v1 adapter over the Markmap/Obsidian
subset needed by the product contract. The crate-level API keeps the parser core
replaceable by a future CommonMark AST-backed adapter without changing the JSON
shape consumed by Tauri or React.

## Serialization Rules

- Serializer output uses canonical Markmap-compatible headings through level 6.
- Deeper branches fall back to nested list items under the nearest level-6
  heading so parse -> serialize -> parse can retain tree depth.
- Existing node labels are emitted in readable Markdown source form, preserving
  standard links and Obsidian wikilinks.
- Frontmatter and placeable raw unmapped blocks are reinserted in deterministic
  source order. Unplaceable raw content returns typed lossy-save diagnostics and
  is blocked by default.

## Validation

Run from the repository root when Rust is available:

```bash
cargo test --manifest-path crates/markdown/Cargo.toml
cargo fmt --manifest-path crates/markdown/Cargo.toml -- --check
```

The shared compatibility corpus lives in `tests/fixtures/compat`, with exact tree
and link snapshots under `tests/fixtures/compat/expected`. See
`docs/markdown-compat-validation.md` for the targeted regression commands and
manual Markmap/Obsidian-style validation steps.
