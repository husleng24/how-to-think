# Markdown Compatibility Fixtures

These fixtures are shared by parser and serializer regression tests. Keep new
compatibility cases here rather than embedding Markdown strings directly in test
code so failures point at a reusable corpus.

## Fixture Groups

- `hierarchy_*.md` covers heading-only trees, nested list trees, mixed
  heading/list trees, and skipped heading levels.
- `empty_file.md`, `long_node_text.md`, and `special_characters.md` cover parser
  edge cases that should not panic or lose node text.
- `unmapped_content.md` covers frontmatter, paragraphs, code fences, tables,
  images, HTML, comments, blockquotes, and thematic breaks.
- `link_matrix.md` covers Obsidian wikilinks, path wikilinks, aliases, duplicate
  filename candidates, unresolved target text, case-sensitive target text,
  standard relative Markdown links, workspace-escape candidate paths, and image
  link tokens.
- `expected/*.tree`, `expected/*.links`, and `expected/*.md` are exact snapshots
  used by fixture-driven tests.

The markdown crate does not resolve filesystem links. Link resolution fixtures
are expressed as parser/serializer compatibility inputs here; workspace resolver
tests should consume the same link shapes when that resolver lives in this crate
or another shared crate.
