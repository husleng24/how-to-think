use how_to_think_markdown::{
    parse_markdown_to_mindmap, serialize_markdown, serialize_markdown_document, DiagnosticSeverity,
    MarkdownBlockKind, MarkdownLineEnding, MarkdownOrigin, MindMapDocument, MindMapNode,
    MindMapNodeKind, ParseMarkdownResponse, ParseMode, PreservationPolicy,
    SerializeMarkdownRequest, SerializePreservationPolicy, SourceSpan, UnmappedMarkdownBlock,
    UnmappedPlacement,
};
use std::collections::BTreeMap;

fn unwrap_document(response: ParseMarkdownResponse) -> MindMapDocument {
    assert!(
        response.document.is_some(),
        "expected parser to return a document, diagnostics: {:?}",
        response.diagnostics
    );
    response.document.unwrap()
}

fn parse_fixture(name: &str, markdown: &str) -> MindMapDocument {
    unwrap_document(parse_markdown_to_mindmap(
        markdown,
        Some(&format!("fixtures/{name}.md")),
        ParseMode::Auto,
    ))
}

fn tree_signature(document: &MindMapDocument) -> String {
    let mut signature = String::new();
    append_tree_signature(document, &document.root_node_id, 0, &mut signature);
    signature
}

fn append_tree_signature(
    document: &MindMapDocument,
    node_id: &str,
    depth: usize,
    signature: &mut String,
) {
    let node = &document.nodes[node_id];
    for child_id in &node.children {
        let child = &document.nodes[child_id];
        signature.push_str(&format!("{depth}:{}\n", child.title));
        append_tree_signature(document, child_id, depth + 1, signature);
    }
}

fn link_raw_tokens(document: &MindMapDocument) -> Vec<String> {
    let mut tokens = Vec::new();
    collect_link_raw_tokens(document, &document.root_node_id, &mut tokens);
    tokens
}

fn collect_link_raw_tokens(document: &MindMapDocument, node_id: &str, tokens: &mut Vec<String>) {
    let node = &document.nodes[node_id];
    tokens.extend(node.links.iter().map(|link| link.raw.clone()));
    for child_id in &node.children {
        collect_link_raw_tokens(document, child_id, tokens);
    }
}

fn generated_document(titles: &[String]) -> MindMapDocument {
    let root_id = "root".to_owned();
    let mut nodes = BTreeMap::new();
    let first_child_id = titles.first().map(|_| "node-1".to_owned());

    nodes.insert(
        root_id.clone(),
        MindMapNode {
            id: root_id.clone(),
            title: titles
                .first()
                .cloned()
                .unwrap_or_else(|| "Untitled map".to_owned()),
            raw_text: String::new(),
            node_kind: MindMapNodeKind::VirtualRoot,
            children: first_child_id.into_iter().collect(),
            origin: origin(MarkdownBlockKind::DocumentRoot, None, None),
            links: Vec::new(),
            list_marker: None,
        },
    );

    for (index, title) in titles.iter().enumerate() {
        let id = format!("node-{}", index + 1);
        let child_id = (index + 1 < titles.len()).then(|| format!("node-{}", index + 2));
        nodes.insert(
            id.clone(),
            MindMapNode {
                id,
                title: title.clone(),
                raw_text: String::new(),
                node_kind: MindMapNodeKind::Heading,
                children: child_id.into_iter().collect(),
                origin: origin(
                    MarkdownBlockKind::Heading,
                    Some(((index + 1).min(6)) as u8),
                    None,
                ),
                links: Vec::new(),
                list_marker: None,
            },
        );
    }

    MindMapDocument {
        schema_version: "mindmap-document.v1".to_owned(),
        source_path: Some("generated.md".to_owned()),
        title: titles
            .first()
            .cloned()
            .unwrap_or_else(|| "Untitled map".to_owned()),
        parse_mode: ParseMode::Auto,
        root_node_id: root_id,
        nodes,
        unmapped_blocks: Vec::new(),
        diagnostics: Vec::new(),
    }
}

fn origin(
    kind: MarkdownBlockKind,
    heading_level: Option<u8>,
    list_depth: Option<usize>,
) -> MarkdownOrigin {
    MarkdownOrigin {
        source_path: Some("generated.md".to_owned()),
        span: SourceSpan {
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 1,
        },
        block_kind: kind,
        heading_level,
        list_depth,
    }
}

#[test]
fn serializes_heading_tree_to_deterministic_canonical_markdown() {
    let document = parse_fixture(
        "heading_hierarchy",
        include_str!("fixtures/heading_hierarchy.md"),
    );

    let response = serialize_markdown_document(document, Some("out.md"));

    assert_eq!(
        response.markdown.as_deref(),
        Some(include_str!("fixtures/serializer_canonical_headings.md"))
    );
    assert!(!response.metadata.canonicalized);
}

#[test]
fn canonicalizes_imported_list_trees_with_explicit_diagnostic() {
    let document = parse_fixture("nested_lists", include_str!("fixtures/nested_lists.md"));
    let original_signature = tree_signature(&document);

    let response = serialize_markdown_document(document, Some("out.md"));
    let markdown = response.markdown.as_deref().expect("serialized markdown");

    assert!(response.metadata.canonicalized);
    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "markdown_structure_canonicalized"));
    assert!(markdown.contains("## Positioning"));
    assert!(markdown.contains("### Audience"));
    assert!(markdown.contains("### MVP"));
    assert!(!markdown.contains("- Positioning"));

    let reparsed = unwrap_document(parse_markdown_to_mindmap(
        markdown,
        Some("out.md"),
        ParseMode::Auto,
    ));
    assert_eq!(tree_signature(&reparsed), original_signature);
}

#[test]
fn preserves_standard_links_and_obsidian_wikilinks_in_readable_source() {
    let document = parse_fixture("links", include_str!("fixtures/links.md"));
    let original_tokens = link_raw_tokens(&document);

    let response = serialize_markdown_document(document, Some("links-out.md"));
    let markdown = response.markdown.as_deref().expect("serialized markdown");

    assert!(markdown.contains("[[Topic]]"));
    assert!(markdown.contains("[[path/to/Topic]]"));
    assert!(markdown.contains("[[Topic|Alias]]"));
    assert!(markdown.contains("[Spec](relative.md)"));

    let reparsed = unwrap_document(parse_markdown_to_mindmap(
        markdown,
        Some("links-out.md"),
        ParseMode::Auto,
    ));
    assert_eq!(link_raw_tokens(&reparsed), original_tokens);
}

#[test]
fn preserves_frontmatter_and_raw_unmapped_blocks_in_deterministic_positions() {
    let document = parse_fixture("unmapped", include_str!("fixtures/unmapped_blocks.md"));
    let original_signature = tree_signature(&document);

    let response = serialize_markdown_document(document, Some("unmapped-out.md"));
    let markdown = response.markdown.as_deref().expect("serialized markdown");

    assert!(markdown.starts_with("---\ntitle: Product Map"));
    assert!(markdown.contains("This paragraph is useful context"));
    assert!(markdown.contains("```rust\nfn preserved() {}\n```"));
    assert!(markdown.contains("| Area | Owner |"));
    assert!(markdown.contains("![Architecture](./architecture.png)"));
    assert!(markdown.contains("<div data-note=\"preserve\">raw html</div>"));
    assert!(markdown.contains("<!-- keep this migration note -->"));
    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "unmapped_content_requires_confirmation"));
    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "unmapped_content_serialized"));

    let reparsed = unwrap_document(parse_markdown_to_mindmap(
        markdown,
        Some("unmapped-out.md"),
        ParseMode::Auto,
    ));
    assert_eq!(tree_signature(&reparsed), original_signature);
}

#[test]
fn blocks_unplaceable_unmapped_content_by_default() {
    let mut document = parse_fixture(
        "heading_hierarchy",
        include_str!("fixtures/heading_hierarchy.md"),
    );
    document.unmapped_blocks.push(UnmappedMarkdownBlock {
        id: "orphan-block".to_owned(),
        kind: MarkdownBlockKind::Paragraph,
        raw: "orphan context".to_owned(),
        origin: origin(MarkdownBlockKind::Paragraph, None, None),
        placement: UnmappedPlacement {
            after_node_id: Some("missing-node".to_owned()),
            before_node_id: None,
        },
        preservation: PreservationPolicy::PreserveRaw,
    });

    let response = serialize_markdown_document(document.clone(), Some("blocked.md"));

    assert!(response.markdown.is_none());
    assert!(response.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "lossy_save_blocked" && diagnostic.severity == DiagnosticSeverity::Error
    }));

    let response = serialize_markdown(SerializeMarkdownRequest {
        document,
        target_path: Some("confirm.md".to_owned()),
        save_mode: Default::default(),
        preservation_policy: SerializePreservationPolicy::RequireConfirmation,
        line_ending: Default::default(),
    });

    assert!(response.markdown.is_some());
    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "lossy_save_requires_confirmation"));
    assert!(!response
        .markdown
        .as_deref()
        .expect("serialized markdown")
        .contains("orphan context"));
}

#[test]
fn deep_hierarchies_fall_back_to_nested_lists_after_heading_level_six() {
    let titles = (1..=8)
        .map(|level| format!("Level {level}"))
        .collect::<Vec<_>>();
    let document = generated_document(&titles);
    let original_signature = tree_signature(&document);

    let response = serialize_markdown_document(document, Some("deep.md"));

    assert_eq!(
        response.markdown.as_deref(),
        Some(include_str!("fixtures/serializer_deep_nesting.md"))
    );

    let reparsed = unwrap_document(parse_markdown_to_mindmap(
        response.markdown.as_deref().unwrap(),
        Some("deep.md"),
        ParseMode::Auto,
    ));
    assert_eq!(tree_signature(&reparsed), original_signature);
}

#[test]
fn preserves_long_node_text_and_special_characters_without_trailing_whitespace() {
    let long_title = format!("{}symbols * & #tag", "Long node text ".repeat(12));
    let document = generated_document(&["C#".to_owned(), long_title.clone()]);

    let response = serialize_markdown_document(document, Some("special.md"));
    let markdown = response.markdown.as_deref().expect("serialized markdown");

    assert!(markdown.contains("# C#\n"));
    assert!(markdown.contains(&format!("## {long_title}\n")));
    assert!(!markdown.lines().any(|line| line.ends_with(' ')));

    let reparsed = unwrap_document(parse_markdown_to_mindmap(
        markdown,
        Some("special.md"),
        ParseMode::Auto,
    ));
    assert!(tree_signature(&reparsed).contains("0:C#\n"));
    assert!(tree_signature(&reparsed).contains(&format!("1:{long_title}\n")));
}

#[test]
fn supports_crlf_output_without_changing_the_tree() {
    let document = parse_fixture(
        "heading_hierarchy",
        include_str!("fixtures/heading_hierarchy.md"),
    );

    let response = serialize_markdown(SerializeMarkdownRequest {
        document,
        target_path: Some("windows.md".to_owned()),
        save_mode: Default::default(),
        preservation_policy: Default::default(),
        line_ending: MarkdownLineEnding::Crlf,
    });
    let markdown = response.markdown.as_deref().expect("serialized markdown");

    assert!(markdown.contains("\r\n\r\n## Positioning"));
    assert!(!markdown.replace("\r\n", "").contains('\n'));
}

#[test]
fn serializes_serializer_response_to_frontend_json() {
    let document = parse_fixture(
        "heading_hierarchy",
        include_str!("fixtures/heading_hierarchy.md"),
    );
    let response = serialize_markdown_document(document, Some("out.md"));

    let json = serde_json::to_value(&response).expect("response should serialize");
    assert!(json["markdown"].is_string());
    assert_eq!(json["metadata"]["schemaVersion"], "markdown-serializer.v1");
    assert!(json["diagnostics"].is_array());
}

#[test]
fn parse_serialize_parse_keeps_core_tree_and_links_stable_for_parser_fixtures() {
    let fixtures = [
        (
            "heading_hierarchy",
            include_str!("fixtures/heading_hierarchy.md"),
        ),
        ("nested_lists", include_str!("fixtures/nested_lists.md")),
        (
            "mixed_heading_list",
            include_str!("fixtures/mixed_heading_list.md"),
        ),
        (
            "skipped_headings",
            include_str!("fixtures/skipped_headings.md"),
        ),
        (
            "malformed_links",
            include_str!("fixtures/malformed_links.md"),
        ),
        ("links", include_str!("fixtures/links.md")),
        (
            "unmapped_blocks",
            include_str!("fixtures/unmapped_blocks.md"),
        ),
    ];

    for (name, markdown) in fixtures {
        let original = parse_fixture(name, markdown);
        let response =
            serialize_markdown_document(original.clone(), Some(&format!("{name}-out.md")));
        let serialized = response.markdown.unwrap_or_else(|| {
            panic!(
                "fixture {name} should serialize: {:?}",
                response.diagnostics
            )
        });
        let reparsed = unwrap_document(parse_markdown_to_mindmap(
            &serialized,
            Some(&format!("{name}-out.md")),
            ParseMode::Auto,
        ));

        assert_eq!(
            tree_signature(&reparsed),
            tree_signature(&original),
            "tree mismatch after round-trip for {name}"
        );
        assert_eq!(
            link_raw_tokens(&reparsed),
            link_raw_tokens(&original),
            "link tokens changed after round-trip for {name}"
        );
    }
}
