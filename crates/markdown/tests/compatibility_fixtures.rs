use how_to_think_markdown::{
    parse_markdown_to_mindmap, serialize_markdown_document, LinkTokenKind, MarkdownBlockKind,
    MindMapDocument, MindMapNodeKind, ParseMarkdownResponse, ParseMode,
};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
struct CompatFixture {
    markdown_path: &'static str,
    tree_path: &'static str,
    expected_diagnostics: &'static [&'static str],
    expected_unmapped_kinds: &'static [MarkdownBlockKind],
}

const COMPAT_FIXTURES: &[CompatFixture] = &[
    CompatFixture {
        markdown_path: "hierarchy_heading_only.md",
        tree_path: "expected/hierarchy_heading_only.tree",
        expected_diagnostics: &[],
        expected_unmapped_kinds: &[],
    },
    CompatFixture {
        markdown_path: "hierarchy_nested_lists.md",
        tree_path: "expected/hierarchy_nested_lists.tree",
        expected_diagnostics: &[],
        expected_unmapped_kinds: &[],
    },
    CompatFixture {
        markdown_path: "hierarchy_mixed_heading_list.md",
        tree_path: "expected/hierarchy_mixed_heading_list.tree",
        expected_diagnostics: &["mixed_hierarchy"],
        expected_unmapped_kinds: &[],
    },
    CompatFixture {
        markdown_path: "hierarchy_skipped_levels.md",
        tree_path: "expected/hierarchy_skipped_levels.tree",
        expected_diagnostics: &["skipped_heading_level"],
        expected_unmapped_kinds: &[],
    },
    CompatFixture {
        markdown_path: "empty_file.md",
        tree_path: "expected/empty_file.tree",
        expected_diagnostics: &["empty_document"],
        expected_unmapped_kinds: &[],
    },
    CompatFixture {
        markdown_path: "long_node_text.md",
        tree_path: "expected/long_node_text.tree",
        expected_diagnostics: &[],
        expected_unmapped_kinds: &[],
    },
    CompatFixture {
        markdown_path: "special_characters.md",
        tree_path: "expected/special_characters.tree",
        expected_diagnostics: &[],
        expected_unmapped_kinds: &[],
    },
    CompatFixture {
        markdown_path: "unmapped_content.md",
        tree_path: "expected/unmapped_content.tree",
        expected_diagnostics: &["unmapped_content_preserved"],
        expected_unmapped_kinds: &[
            MarkdownBlockKind::Frontmatter,
            MarkdownBlockKind::Paragraph,
            MarkdownBlockKind::BlockQuote,
            MarkdownBlockKind::CodeBlock,
            MarkdownBlockKind::Table,
            MarkdownBlockKind::Image,
            MarkdownBlockKind::Html,
            MarkdownBlockKind::Comment,
            MarkdownBlockKind::ThematicBreak,
        ],
    },
    CompatFixture {
        markdown_path: "link_matrix.md",
        tree_path: "expected/link_matrix.tree",
        expected_diagnostics: &[],
        expected_unmapped_kinds: &[],
    },
];

fn compat_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("compat")
}

fn read_compat(path: &str) -> String {
    fs::read_to_string(compat_root().join(path))
        .unwrap_or_else(|error| panic!("failed to read compatibility fixture {path}: {error}"))
        .replace("\r\n", "\n")
}

fn parse_fixture(path: &str) -> ParseMarkdownResponse {
    let markdown = read_compat(path);
    parse_markdown_to_mindmap(
        &markdown,
        Some(&format!("tests/fixtures/compat/{path}")),
        ParseMode::Auto,
    )
}

fn unwrap_document(response: ParseMarkdownResponse, path: &str) -> MindMapDocument {
    response.document.unwrap_or_else(|| {
        panic!(
            "expected parser to return a document for {path}, diagnostics: {:?}",
            response.diagnostics
        )
    })
}

fn assert_snapshot_eq(actual: &str, expected: &str, context: &str) {
    assert_eq!(
        actual.trim_end_matches('\n'),
        expected.trim_end_matches('\n'),
        "snapshot mismatch for {context}"
    );
}

fn tree_snapshot(document: &MindMapDocument) -> String {
    let mut lines = Vec::new();
    append_tree_snapshot(document, &document.root_node_id, 0, &mut lines);

    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn hierarchy_snapshot(document: &MindMapDocument) -> String {
    let mut lines = Vec::new();
    append_hierarchy_snapshot(document, &document.root_node_id, 0, &mut lines);

    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn append_tree_snapshot(
    document: &MindMapDocument,
    node_id: &str,
    depth: usize,
    lines: &mut Vec<String>,
) {
    let node = &document.nodes[node_id];
    for child_id in &node.children {
        let child = &document.nodes[child_id];
        lines.push(format!(
            "{depth}|{}|{}",
            node_kind_label(child.node_kind),
            child.title
        ));
        append_tree_snapshot(document, child_id, depth + 1, lines);
    }
}

fn append_hierarchy_snapshot(
    document: &MindMapDocument,
    node_id: &str,
    depth: usize,
    lines: &mut Vec<String>,
) {
    let node = &document.nodes[node_id];
    for child_id in &node.children {
        let child = &document.nodes[child_id];
        lines.push(format!("{depth}|{}", child.title));
        append_hierarchy_snapshot(document, child_id, depth + 1, lines);
    }
}

fn node_kind_label(kind: MindMapNodeKind) -> &'static str {
    match kind {
        MindMapNodeKind::VirtualRoot => "virtual_root",
        MindMapNodeKind::Heading => "heading",
        MindMapNodeKind::ListItem => "list_item",
    }
}

fn link_snapshot(document: &MindMapDocument) -> String {
    let mut lines = Vec::new();
    append_link_snapshot(document, &document.root_node_id, &mut lines);

    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn append_link_snapshot(document: &MindMapDocument, node_id: &str, lines: &mut Vec<String>) {
    let node = &document.nodes[node_id];
    for link in &node.links {
        lines.push(format!(
            "{}|{}|{}|{}|{}",
            link_kind_label(link.kind),
            link.raw,
            link.target,
            link.label.as_deref().unwrap_or(""),
            link.alias.as_deref().unwrap_or("")
        ));
    }

    for child_id in &node.children {
        append_link_snapshot(document, child_id, lines);
    }
}

fn link_kind_label(kind: LinkTokenKind) -> &'static str {
    match kind {
        LinkTokenKind::StandardMarkdown => "StandardMarkdown",
        LinkTokenKind::Image => "Image",
        LinkTokenKind::ObsidianWiki => "ObsidianWiki",
    }
}

#[test]
fn parser_outputs_match_compatibility_tree_snapshots() {
    for fixture in COMPAT_FIXTURES {
        let response = parse_fixture(fixture.markdown_path);
        let document = unwrap_document(response, fixture.markdown_path);
        let actual = tree_snapshot(&document);
        let expected = read_compat(fixture.tree_path);

        assert_snapshot_eq(&actual, &expected, fixture.markdown_path);
    }
}

#[test]
fn compatibility_diagnostics_and_unmapped_blocks_are_stable() {
    for fixture in COMPAT_FIXTURES {
        let response = parse_fixture(fixture.markdown_path);
        let document = unwrap_document(response, fixture.markdown_path);

        for expected_code in fixture.expected_diagnostics {
            assert!(
                document
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == *expected_code),
                "expected diagnostic {expected_code} for {}, got {:?}",
                fixture.markdown_path,
                document.diagnostics
            );
        }

        for expected_kind in fixture.expected_unmapped_kinds {
            assert!(
                document
                    .unmapped_blocks
                    .iter()
                    .any(|block| block.kind == *expected_kind),
                "expected unmapped block {:?} for {}, got {:?}",
                expected_kind,
                fixture.markdown_path,
                document
                    .unmapped_blocks
                    .iter()
                    .map(|block| block.kind)
                    .collect::<Vec<_>>()
            );
        }
    }
}

#[test]
fn link_matrix_preserves_markdown_and_obsidian_link_tokens() {
    let response = parse_fixture("link_matrix.md");
    let document = unwrap_document(response, "link_matrix.md");
    let actual = link_snapshot(&document);
    let expected = read_compat("expected/link_matrix.links");

    assert_snapshot_eq(&actual, &expected, "link_matrix.links");
}

#[test]
fn serializer_round_trips_all_compatibility_fixtures() {
    for fixture in COMPAT_FIXTURES {
        let original = unwrap_document(parse_fixture(fixture.markdown_path), fixture.markdown_path);
        let original_tree = hierarchy_snapshot(&original);
        let original_links = link_snapshot(&original);

        let serialized = serialize_markdown_document(
            original,
            Some(&format!("roundtrip/{}", fixture.markdown_path)),
        );
        let markdown = serialized.markdown.unwrap_or_else(|| {
            panic!(
                "expected fixture {} to serialize, diagnostics: {:?}",
                fixture.markdown_path, serialized.diagnostics
            )
        });
        assert!(
            !markdown.lines().any(|line| line.ends_with(' ')),
            "serialized fixture {} contained trailing whitespace",
            fixture.markdown_path
        );

        let reparsed = unwrap_document(
            parse_markdown_to_mindmap(
                &markdown,
                Some(&format!("roundtrip/{}", fixture.markdown_path)),
                ParseMode::Auto,
            ),
            fixture.markdown_path,
        );

        assert_snapshot_eq(
            &hierarchy_snapshot(&reparsed),
            &original_tree,
            &format!("{} round-trip tree", fixture.markdown_path),
        );
        assert_snapshot_eq(
            &link_snapshot(&reparsed),
            &original_links,
            &format!("{} round-trip links", fixture.markdown_path),
        );
    }
}

#[test]
fn serializer_canonicalizes_nested_lists_to_markmap_headings_snapshot() {
    let original = unwrap_document(
        parse_fixture("hierarchy_nested_lists.md"),
        "hierarchy_nested_lists.md",
    );

    let serialized = serialize_markdown_document(original, Some("nested-lists-out.md"));
    let markdown = serialized
        .markdown
        .expect("nested list fixture should serialize");
    let expected = read_compat("expected/serialized_nested_lists.md");

    assert_snapshot_eq(&markdown, &expected, "expected/serialized_nested_lists.md");
    assert!(
        serialized
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "markdown_structure_canonicalized"),
        "expected canonicalization diagnostic, got {:?}",
        serialized.diagnostics
    );
}
