use how_to_think_markdown::{
    parse_markdown_to_mindmap, DiagnosticSeverity, LinkTokenKind, MarkdownBlockKind,
    MindMapDocument, ParseMarkdownResponse, ParseMode, PreservationPolicy,
};

fn document(response: ParseMarkdownResponse) -> MindMapDocument {
    assert!(
        response.document.is_some(),
        "expected parser to return a document, diagnostics: {:?}",
        response.diagnostics
    );
    response.document.unwrap()
}

fn parse_fixture(name: &str, markdown: &str) -> MindMapDocument {
    document(parse_markdown_to_mindmap(
        markdown,
        Some(&format!("fixtures/{name}.md")),
        ParseMode::Auto,
    ))
}

fn child_titles(document: &MindMapDocument, node_id: &str) -> Vec<String> {
    document.nodes[node_id]
        .children
        .iter()
        .map(|child_id| document.nodes[child_id].title.clone())
        .collect()
}

fn find_node_id(document: &MindMapDocument, title: &str) -> String {
    document
        .nodes
        .values()
        .find(|node| node.title == title)
        .map(|node| node.id.clone())
        .unwrap_or_else(|| panic!("node not found: {title}"))
}

#[test]
fn parses_heading_hierarchy() {
    let document = parse_fixture(
        "heading_hierarchy",
        include_str!("fixtures/heading_hierarchy.md"),
    );

    assert_eq!(document.title, "Product Strategy");
    assert_eq!(
        child_titles(&document, &document.root_node_id),
        vec!["Product Strategy"]
    );

    let root_heading = find_node_id(&document, "Product Strategy");
    assert_eq!(
        child_titles(&document, &root_heading),
        vec!["Positioning", "Roadmap"]
    );

    let positioning = find_node_id(&document, "Positioning");
    assert_eq!(
        child_titles(&document, &positioning),
        vec!["Audience", "Differentiation"]
    );
}

#[test]
fn parses_nested_lists_preserving_order() {
    let document = parse_fixture("nested_lists", include_str!("fixtures/nested_lists.md"));
    let root_heading = find_node_id(&document, "Product Strategy");

    assert_eq!(
        child_titles(&document, &root_heading),
        vec!["Positioning", "Roadmap"]
    );

    let roadmap = find_node_id(&document, "Roadmap");
    assert_eq!(child_titles(&document, &roadmap), vec!["MVP", "Beta", "Launch"]);

    let launch = find_node_id(&document, "Launch");
    let marker = document.nodes[&launch].list_marker.as_ref().unwrap();
    assert_eq!(marker.checked, Some(true));
}

#[test]
fn maps_mixed_heading_list_documents_with_diagnostic() {
    let response = parse_markdown_to_mindmap(
        include_str!("fixtures/mixed_heading_list.md"),
        Some("fixtures/mixed_heading_list.md"),
        ParseMode::Auto,
    );

    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "mixed_hierarchy"));

    let document = document(response);
    let launch_plan = find_node_id(&document, "Launch Plan");
    assert_eq!(
        child_titles(&document, &launch_plan),
        vec!["Discovery", "Delivery", "Risks"]
    );
}

#[test]
fn reports_skipped_heading_levels() {
    let response = parse_markdown_to_mindmap(
        include_str!("fixtures/skipped_headings.md"),
        Some("fixtures/skipped_headings.md"),
        ParseMode::Auto,
    );

    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "skipped_heading_level"));

    let document = document(response);
    assert_eq!(
        child_titles(&document, &document.root_node_id),
        vec!["Deep Start"]
    );
}

#[test]
fn reports_empty_document() {
    let response = parse_markdown_to_mindmap("", Some("empty.md"), ParseMode::Auto);

    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "empty_document"
            && diagnostic.severity == DiagnosticSeverity::Warning));

    let document = document(response);
    assert_eq!(document.nodes.len(), 1);
}

#[test]
fn reports_malformed_links_without_panic() {
    let response = parse_markdown_to_mindmap(
        include_str!("fixtures/malformed_links.md"),
        Some("fixtures/malformed_links.md"),
        ParseMode::Auto,
    );

    assert!(response.document.is_some());
    assert!(response
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "malformed_link"));
}

#[test]
fn preserves_wikilinks_and_standard_links_in_node_text() {
    let document = parse_fixture("links", include_str!("fixtures/links.md"));
    let references = find_node_id(&document, "References [[Topic]] [[path/to/Topic]] [[Topic|Alias]] [Spec](relative.md)");
    let node = &document.nodes[&references];

    assert_eq!(node.links.len(), 4);
    assert_eq!(node.links[0].kind, LinkTokenKind::ObsidianWiki);
    assert_eq!(node.links[0].raw, "[[Topic]]");
    assert_eq!(node.links[1].target, "path/to/Topic");
    assert_eq!(node.links[2].alias.as_deref(), Some("Alias"));
    assert_eq!(node.links[3].kind, LinkTokenKind::StandardMarkdown);
    assert_eq!(node.links[3].raw, "[Spec](relative.md)");
}

#[test]
fn captures_unmapped_blocks_for_lossless_preservation() {
    let document = parse_fixture("unmapped", include_str!("fixtures/unmapped_blocks.md"));
    let kinds = document
        .unmapped_blocks
        .iter()
        .map(|block| block.kind)
        .collect::<Vec<_>>();

    assert!(kinds.contains(&MarkdownBlockKind::Frontmatter));
    assert!(kinds.contains(&MarkdownBlockKind::Paragraph));
    assert!(kinds.contains(&MarkdownBlockKind::CodeBlock));
    assert!(kinds.contains(&MarkdownBlockKind::Table));
    assert!(kinds.contains(&MarkdownBlockKind::Image));
    assert!(kinds.contains(&MarkdownBlockKind::Html));
    assert!(kinds.contains(&MarkdownBlockKind::Comment));
    assert!(document
        .unmapped_blocks
        .iter()
        .any(|block| block.preservation == PreservationPolicy::RequiresConfirmation));
    assert!(document
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "unmapped_content_preserved"));
}

#[test]
fn serializes_response_to_frontend_json() {
    let response = parse_markdown_to_mindmap(
        include_str!("fixtures/heading_hierarchy.md"),
        Some("fixtures/heading_hierarchy.md"),
        ParseMode::Auto,
    );

    let json = serde_json::to_value(&response).expect("response should serialize");
    assert_eq!(json["document"]["schemaVersion"], "mindmap-document.v1");
    assert!(json["document"]["nodes"].is_object());
    assert!(json["diagnostics"].is_array());
}
