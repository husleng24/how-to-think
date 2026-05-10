use crate::diagnostics;
use crate::model::{
    CompatibilityDiagnostic, LinkToken, LinkTokenKind, ListMarker, ListMarkerKind,
    MarkdownBlockKind, MarkdownOrigin, MindMapDocument, MindMapNode, MindMapNodeKind,
    ParseMarkdownRequest, ParseMarkdownResponse, ParseMode, PreservationPolicy, SourceSpan,
    UnmappedMarkdownBlock, UnmappedPlacement,
};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

const SCHEMA_VERSION: &str = "mindmap-document.v1";

pub fn parse_markdown(request: ParseMarkdownRequest) -> ParseMarkdownResponse {
    match catch_unwind(AssertUnwindSafe(|| parse_markdown_inner(request))) {
        Ok(response) => response,
        Err(_) => ParseMarkdownResponse {
            document: None,
            diagnostics: vec![diagnostics::parser_panic()],
        },
    }
}

pub fn parse_markdown_to_mindmap(
    markdown: &str,
    source_path: Option<&str>,
    parse_mode: ParseMode,
) -> ParseMarkdownResponse {
    parse_markdown(ParseMarkdownRequest {
        markdown: markdown.to_owned(),
        source_path: source_path.map(str::to_owned),
        parse_mode,
    })
}

fn parse_markdown_inner(request: ParseMarkdownRequest) -> ParseMarkdownResponse {
    let source_path = request.source_path;
    let lines = request.markdown.lines().collect::<Vec<_>>();
    let root_id = stable_id("node", source_path.as_deref(), 0, "document-root", 0);
    let root_origin = origin(
        &source_path,
        MarkdownBlockKind::DocumentRoot,
        1,
        1,
        1,
        1,
        None,
        None,
    );

    let mut nodes = BTreeMap::new();
    nodes.insert(
        root_id.clone(),
        MindMapNode {
            id: root_id.clone(),
            title: document_title_from_path(source_path.as_deref()),
            raw_text: String::new(),
            node_kind: MindMapNodeKind::VirtualRoot,
            children: Vec::new(),
            origin: root_origin.clone(),
            links: Vec::new(),
            list_marker: None,
        },
    );

    let mut state = ParserState {
        source_path: source_path.clone(),
        parse_mode: request.parse_mode,
        root_id: root_id.clone(),
        nodes,
        unmapped_blocks: Vec::new(),
        diagnostics: Vec::new(),
        heading_stack: Vec::new(),
        list_stack: Vec::new(),
        seen_heading: false,
        seen_list: false,
        emitted_mixed_diagnostic: false,
        last_node_id: Some(root_id.clone()),
        sequence: 0,
    };

    if request.markdown.trim().is_empty() {
        state
            .diagnostics
            .push(diagnostics::empty_document(root_origin.clone()));
    } else {
        state.parse_lines(&lines);
    }

    if state.node_count_without_root() == 0
        && !state
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "empty_document")
    {
        state
            .diagnostics
            .push(diagnostics::empty_document(root_origin.clone()));
    }

    let title = state
        .first_child_title()
        .unwrap_or_else(|| document_title_from_path(source_path.as_deref()));
    if let Some(root) = state.nodes.get_mut(&root_id) {
        root.title = title.clone();
    }

    let diagnostics = state.diagnostics.clone();
    let document = MindMapDocument {
        schema_version: SCHEMA_VERSION.to_owned(),
        source_path,
        title,
        parse_mode: request.parse_mode,
        root_node_id: root_id,
        nodes: state.nodes,
        unmapped_blocks: state.unmapped_blocks,
        diagnostics: diagnostics.clone(),
    };

    ParseMarkdownResponse {
        document: Some(document),
        diagnostics,
    }
}

struct ParserState {
    source_path: Option<String>,
    parse_mode: ParseMode,
    root_id: String,
    nodes: BTreeMap<String, MindMapNode>,
    unmapped_blocks: Vec<UnmappedMarkdownBlock>,
    diagnostics: Vec<CompatibilityDiagnostic>,
    heading_stack: Vec<(u8, String)>,
    list_stack: Vec<(usize, String)>,
    seen_heading: bool,
    seen_list: bool,
    emitted_mixed_diagnostic: bool,
    last_node_id: Option<String>,
    sequence: usize,
}

impl ParserState {
    fn parse_lines(&mut self, lines: &[&str]) {
        let mut index = 0;

        while index < lines.len() {
            let line = lines[index];
            let line_no = index + 1;
            let trimmed = line.trim();

            if trimmed.is_empty() {
                index += 1;
                continue;
            }

            if index == 0 && trimmed == "---" {
                if let Some(end_index) = find_frontmatter_end(lines) {
                    self.push_unmapped(lines, index, end_index, MarkdownBlockKind::Frontmatter);
                    index = end_index + 1;
                    continue;
                }
            }

            if let Some(fence) = code_fence(trimmed) {
                let end_index =
                    find_code_fence_end(lines, index + 1, fence).unwrap_or(lines.len() - 1);
                self.push_unmapped(lines, index, end_index, MarkdownBlockKind::CodeBlock);
                index = end_index + 1;
                continue;
            }

            if trimmed.starts_with("<!--") {
                let end_index = find_comment_end(lines, index).unwrap_or(index);
                self.push_unmapped(lines, index, end_index, MarkdownBlockKind::Comment);
                index = end_index + 1;
                continue;
            }

            if is_table_start(lines, index) {
                let end_index = find_table_end(lines, index);
                self.push_unmapped(lines, index, end_index, MarkdownBlockKind::Table);
                index = end_index + 1;
                continue;
            }

            if is_thematic_break(trimmed) {
                self.push_unmapped(lines, index, index, MarkdownBlockKind::ThematicBreak);
                index += 1;
                continue;
            }

            if trimmed.starts_with("![") {
                self.push_unmapped(lines, index, index, MarkdownBlockKind::Image);
                index += 1;
                continue;
            }

            if trimmed.starts_with('>') {
                let end_index = find_prefixed_block_end(lines, index, '>');
                self.push_unmapped(lines, index, end_index, MarkdownBlockKind::BlockQuote);
                index = end_index + 1;
                continue;
            }

            if looks_like_html(trimmed) {
                let end_index = find_html_end(lines, index);
                self.push_unmapped(lines, index, end_index, MarkdownBlockKind::Html);
                index = end_index + 1;
                continue;
            }

            if let Some(heading) = parse_heading_line(line) {
                if self.maps_heading() {
                    self.push_heading(heading, line_no, line);
                } else {
                    self.push_unmapped(lines, index, index, MarkdownBlockKind::Heading);
                }
                index += 1;
                continue;
            }

            if let Some(list_item) = parse_list_item(line) {
                if self.maps_list() {
                    self.push_list_item(list_item, line_no, line);
                } else {
                    self.push_unmapped(lines, index, index, MarkdownBlockKind::ListItem);
                }
                index += 1;
                continue;
            }

            let end_index = find_paragraph_end(lines, index);
            self.push_unmapped(lines, index, end_index, MarkdownBlockKind::Paragraph);
            index = end_index + 1;
        }
    }

    fn maps_heading(&self) -> bool {
        matches!(
            self.parse_mode,
            ParseMode::Auto | ParseMode::HeadingOnly | ParseMode::Mixed
        )
    }

    fn maps_list(&self) -> bool {
        matches!(
            self.parse_mode,
            ParseMode::Auto | ParseMode::ListOnly | ParseMode::Mixed
        )
    }

    fn push_heading(&mut self, heading: ParsedHeading, line_no: usize, raw_line: &str) {
        let end_column = line_end_column(raw_line);
        let heading_origin = origin(
            &self.source_path,
            MarkdownBlockKind::Heading,
            line_no,
            1,
            line_no,
            end_column,
            Some(heading.level),
            None,
        );

        self.note_mixed_structure(self.seen_list, heading_origin.clone());
        self.seen_heading = true;
        self.list_stack.clear();

        while self
            .heading_stack
            .last()
            .is_some_and(|(level, _)| *level >= heading.level)
        {
            self.heading_stack.pop();
        }

        let parent_level = self
            .heading_stack
            .last()
            .map(|(level, _)| *level)
            .unwrap_or(0);
        if heading.level > parent_level + 1 {
            self.diagnostics.push(diagnostics::skipped_heading_level(
                heading_origin.clone(),
                heading.level,
                parent_level,
            ));
        }

        let parent_id = self
            .heading_stack
            .last()
            .map(|(_, id)| id.clone())
            .unwrap_or_else(|| self.root_id.clone());
        let id = self.next_node_id(line_no, &heading.text);
        let (links, link_diagnostics) = parse_links(
            &heading.text,
            line_no,
            &self.source_path,
            MarkdownBlockKind::Heading,
        );
        self.diagnostics.extend(link_diagnostics);

        let node = MindMapNode {
            id: id.clone(),
            title: heading.text,
            raw_text: raw_line.to_owned(),
            node_kind: MindMapNodeKind::Heading,
            children: Vec::new(),
            origin: heading_origin,
            links,
            list_marker: None,
        };
        self.attach_node(parent_id, node);
        self.heading_stack.push((heading.level, id.clone()));
        self.last_node_id = Some(id);
    }

    fn push_list_item(&mut self, item: ParsedListItem, line_no: usize, raw_line: &str) {
        let end_column = line_end_column(raw_line);
        let item_origin = origin(
            &self.source_path,
            MarkdownBlockKind::ListItem,
            line_no,
            item.content_column,
            line_no,
            end_column,
            None,
            Some(item.depth),
        );

        self.note_mixed_structure(self.seen_heading, item_origin.clone());
        self.seen_list = true;

        while self
            .list_stack
            .last()
            .is_some_and(|(indent, _)| *indent >= item.indent_columns)
        {
            self.list_stack.pop();
        }

        let parent_id = self
            .list_stack
            .last()
            .map(|(_, id)| id.clone())
            .or_else(|| self.heading_stack.last().map(|(_, id)| id.clone()))
            .unwrap_or_else(|| self.root_id.clone());
        let id = self.next_node_id(line_no, &item.text);
        let (links, link_diagnostics) = parse_links(
            &item.text,
            line_no,
            &self.source_path,
            MarkdownBlockKind::ListItem,
        );
        self.diagnostics.extend(link_diagnostics);

        let node = MindMapNode {
            id: id.clone(),
            title: item.text,
            raw_text: raw_line.to_owned(),
            node_kind: MindMapNodeKind::ListItem,
            children: Vec::new(),
            origin: item_origin,
            links,
            list_marker: Some(item.marker),
        };
        self.attach_node(parent_id, node);
        self.list_stack.push((item.indent_columns, id.clone()));
        self.last_node_id = Some(id);
    }

    fn push_unmapped(
        &mut self,
        lines: &[&str],
        start_index: usize,
        end_index: usize,
        kind: MarkdownBlockKind,
    ) {
        let raw = lines[start_index..=end_index].join("\n");
        let start_line = start_index + 1;
        let end_line = end_index + 1;
        let end_column = line_end_column(lines[end_index]);
        let block_origin = origin(
            &self.source_path,
            kind,
            start_line,
            1,
            end_line,
            end_column,
            None,
            None,
        );
        let id = stable_id(
            "block",
            self.source_path.as_deref(),
            start_line,
            &raw,
            self.sequence,
        );
        self.sequence += 1;

        self.unmapped_blocks.push(UnmappedMarkdownBlock {
            id,
            kind,
            raw,
            origin: block_origin.clone(),
            placement: UnmappedPlacement {
                after_node_id: self.last_node_id.clone(),
                before_node_id: None,
            },
            preservation: preservation_for(kind),
        });
        self.diagnostics
            .push(diagnostics::unmapped_content(block_origin, kind));
    }

    fn attach_node(&mut self, parent_id: String, node: MindMapNode) {
        if let Some(parent) = self.nodes.get_mut(&parent_id) {
            parent.children.push(node.id.clone());
        }
        self.nodes.insert(node.id.clone(), node);
    }

    fn note_mixed_structure(&mut self, already_saw_other: bool, origin: MarkdownOrigin) {
        if already_saw_other && !self.emitted_mixed_diagnostic {
            self.diagnostics.push(diagnostics::mixed_hierarchy(origin));
            self.emitted_mixed_diagnostic = true;
        }
    }

    fn next_node_id(&mut self, line_no: usize, text: &str) -> String {
        let id = stable_id(
            "node",
            self.source_path.as_deref(),
            line_no,
            text,
            self.sequence,
        );
        self.sequence += 1;
        id
    }

    fn node_count_without_root(&self) -> usize {
        self.nodes.len().saturating_sub(1)
    }

    fn first_child_title(&self) -> Option<String> {
        let root = self.nodes.get(&self.root_id)?;
        let first_child_id = root.children.first()?;
        self.nodes
            .get(first_child_id)
            .map(|node| node.title.clone())
    }
}

#[derive(Debug)]
struct ParsedHeading {
    level: u8,
    text: String,
}

fn parse_heading_line(line: &str) -> Option<ParsedHeading> {
    let leading_spaces = line.chars().take_while(|ch| *ch == ' ').count();
    if leading_spaces > 3 {
        return None;
    }

    let trimmed = line.trim_start();
    let level = trimmed.chars().take_while(|ch| *ch == '#').count();
    if level == 0 || level > 6 {
        return None;
    }

    let after_hashes = &trimmed[level..];
    if !after_hashes.is_empty() && !after_hashes.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }

    let mut text = after_hashes.trim().to_owned();
    if let Some(closing_start) = closing_hash_sequence_start(&text) {
        text = text[..closing_start].trim_end().to_owned();
    }

    Some(ParsedHeading {
        level: level as u8,
        text,
    })
}

fn closing_hash_sequence_start(text: &str) -> Option<usize> {
    let trimmed_end = text.trim_end();
    let hash_start = trimmed_end
        .char_indices()
        .rev()
        .find_map(|(index, ch)| (ch != '#').then_some(index + ch.len_utf8()))?;

    if hash_start == trimmed_end.len() {
        return None;
    }

    let before_hashes = &trimmed_end[..hash_start];
    before_hashes
        .chars()
        .last()
        .is_some_and(char::is_whitespace)
        .then_some(hash_start)
}

#[derive(Debug)]
struct ParsedListItem {
    indent_columns: usize,
    depth: usize,
    content_column: usize,
    text: String,
    marker: ListMarker,
}

fn parse_list_item(line: &str) -> Option<ParsedListItem> {
    let indent_columns = indent_columns(line);
    let trimmed = line.trim_start();

    if trimmed.len() < 2 {
        return None;
    }

    let (marker_raw, marker_kind, ordinal, after_marker) = parse_list_marker(trimmed)?;
    let mut content = after_marker.trim_start();
    let mut checked = None;

    if content.as_bytes().len() >= 3 {
        let bytes = content.as_bytes();
        if bytes.starts_with(b"[ ]") || bytes.starts_with(b"[x]") || bytes.starts_with(b"[X]") {
            checked = Some(bytes[1] == b'x' || bytes[1] == b'X');
            content = content[3..].trim_start();
        }
    }

    let kind = if checked.is_some() {
        ListMarkerKind::Task
    } else {
        marker_kind
    };
    let content_column = indent_columns + marker_raw.chars().count() + 2;

    Some(ParsedListItem {
        indent_columns,
        depth: indent_columns / 2,
        content_column,
        text: content.to_owned(),
        marker: ListMarker {
            raw: marker_raw,
            kind,
            ordinal,
            checked,
        },
    })
}

fn parse_list_marker(trimmed: &str) -> Option<(String, ListMarkerKind, Option<u32>, &str)> {
    let mut chars = trimmed.chars();
    let first = chars.next()?;

    if matches!(first, '-' | '*' | '+') {
        let after_marker = &trimmed[first.len_utf8()..];
        if after_marker.chars().next().is_some_and(char::is_whitespace) {
            return Some((
                first.to_string(),
                ListMarkerKind::Unordered,
                None,
                after_marker,
            ));
        }
        return None;
    }

    if !first.is_ascii_digit() {
        return None;
    }

    let marker_end = trimmed.char_indices().find_map(|(index, ch)| {
        if ch == '.' || ch == ')' {
            Some(index)
        } else if ch.is_ascii_digit() {
            None
        } else {
            Some(usize::MAX)
        }
    })?;

    if marker_end == usize::MAX {
        return None;
    }

    let delimiter = trimmed[marker_end..].chars().next()?;
    if delimiter != '.' && delimiter != ')' {
        return None;
    }

    let marker_raw = &trimmed[..=marker_end];
    let after_marker = &trimmed[marker_end + delimiter.len_utf8()..];
    if !after_marker.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }

    let ordinal = trimmed[..marker_end].parse::<u32>().ok();
    Some((
        marker_raw.to_owned(),
        ListMarkerKind::Ordered,
        ordinal,
        after_marker,
    ))
}

fn parse_links(
    text: &str,
    line_no: usize,
    source_path: &Option<String>,
    block_kind: MarkdownBlockKind,
) -> (Vec<LinkToken>, Vec<CompatibilityDiagnostic>) {
    let mut links = Vec::new();
    let mut diagnostics_out = Vec::new();
    let mut index = 0;

    while index < text.len() {
        if text[index..].starts_with("[[") {
            match text[index + 2..].find("]]") {
                Some(end_relative) => {
                    let inner_start = index + 2;
                    let inner_end = inner_start + end_relative;
                    let end = inner_end + 2;
                    let inner = &text[inner_start..inner_end];
                    let (target, alias) = split_wikilink(inner);
                    let token_origin =
                        link_origin(source_path, block_kind, line_no, text, index, end);
                    links.push(LinkToken {
                        kind: LinkTokenKind::ObsidianWiki,
                        raw: text[index..end].to_owned(),
                        label: alias.clone().or_else(|| Some(target.clone())),
                        target,
                        alias,
                        origin: token_origin,
                    });
                    index = end;
                    continue;
                }
                None => {
                    let token_origin =
                        link_origin(source_path, block_kind, line_no, text, index, text.len());
                    diagnostics_out.push(diagnostics::malformed_link(
                        token_origin,
                        text[index..].to_owned(),
                    ));
                    break;
                }
            }
        }

        if text[index..].starts_with("![") || text[index..].starts_with('[') {
            let image = text[index..].starts_with("![");
            let bracket_start = if image { index + 1 } else { index };
            if let Some(close_relative) = text[bracket_start + 1..].find(']') {
                let label_start = bracket_start + 1;
                let label_end = label_start + close_relative;
                let close_bracket = label_end;
                let after_bracket = close_bracket + 1;

                if text[after_bracket..].starts_with('(') {
                    match text[after_bracket + 1..].find(')') {
                        Some(close_paren_relative) => {
                            let target_start = after_bracket + 1;
                            let target_end = target_start + close_paren_relative;
                            let end = target_end + 1;
                            let raw = &text[index..end];
                            let target = text[target_start..target_end].to_owned();
                            let token_origin =
                                link_origin(source_path, block_kind, line_no, text, index, end);

                            if target.trim().is_empty() {
                                diagnostics_out
                                    .push(diagnostics::malformed_link(token_origin, raw));
                            } else {
                                links.push(LinkToken {
                                    kind: if image {
                                        LinkTokenKind::Image
                                    } else {
                                        LinkTokenKind::StandardMarkdown
                                    },
                                    raw: raw.to_owned(),
                                    label: Some(text[label_start..label_end].to_owned()),
                                    target,
                                    alias: None,
                                    origin: token_origin,
                                });
                            }
                            index = end;
                            continue;
                        }
                        None => {
                            let token_origin = link_origin(
                                source_path,
                                block_kind,
                                line_no,
                                text,
                                index,
                                text.len(),
                            );
                            diagnostics_out.push(diagnostics::malformed_link(
                                token_origin,
                                text[index..].to_owned(),
                            ));
                            break;
                        }
                    }
                }
            }
        }

        index += text[index..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
    }

    (links, diagnostics_out)
}

fn split_wikilink(inner: &str) -> (String, Option<String>) {
    match inner.split_once('|') {
        Some((target, alias)) => (target.to_owned(), Some(alias.to_owned())),
        None => (inner.to_owned(), None),
    }
}

fn link_origin(
    source_path: &Option<String>,
    block_kind: MarkdownBlockKind,
    line_no: usize,
    text: &str,
    start: usize,
    end: usize,
) -> MarkdownOrigin {
    origin(
        source_path,
        block_kind,
        line_no,
        byte_to_column(text, start),
        line_no,
        byte_to_column(text, end),
        None,
        None,
    )
}

fn origin(
    source_path: &Option<String>,
    kind: MarkdownBlockKind,
    start_line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
    heading_level: Option<u8>,
    list_depth: Option<usize>,
) -> MarkdownOrigin {
    MarkdownOrigin {
        source_path: source_path.clone(),
        span: SourceSpan {
            start_line,
            start_column,
            end_line,
            end_column,
        },
        block_kind: kind,
        heading_level,
        list_depth,
    }
}

fn find_frontmatter_end(lines: &[&str]) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, line)| (line.trim() == "---").then_some(index))
}

fn code_fence(trimmed: &str) -> Option<&'static str> {
    if trimmed.starts_with("```") {
        Some("```")
    } else if trimmed.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

fn find_code_fence_end(lines: &[&str], start: usize, fence: &str) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .skip(start)
        .find_map(|(index, line)| line.trim_start().starts_with(fence).then_some(index))
}

fn find_comment_end(lines: &[&str], start: usize) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .skip(start)
        .find_map(|(index, line)| line.contains("-->").then_some(index))
}

fn is_table_start(lines: &[&str], index: usize) -> bool {
    if index + 1 >= lines.len() {
        return false;
    }

    lines[index].contains('|') && is_table_separator(lines[index + 1])
}

fn is_table_separator(line: &str) -> bool {
    let trimmed = line.trim().trim_matches('|').trim();
    !trimmed.is_empty()
        && trimmed.split('|').all(|cell| {
            let cell = cell.trim();
            cell.len() >= 3 && cell.chars().all(|ch| ch == '-' || ch == ':')
        })
}

fn find_table_end(lines: &[&str], start: usize) -> usize {
    let mut end = start + 1;
    while end + 1 < lines.len() {
        let next = lines[end + 1];
        if next.trim().is_empty() || !next.contains('|') {
            break;
        }
        end += 1;
    }
    end
}

fn is_thematic_break(trimmed: &str) -> bool {
    let compact = trimmed.split_whitespace().collect::<String>();
    compact.len() >= 3
        && (compact.chars().all(|ch| ch == '-')
            || compact.chars().all(|ch| ch == '*')
            || compact.chars().all(|ch| ch == '_'))
}

fn find_prefixed_block_end(lines: &[&str], start: usize, prefix: char) -> usize {
    let mut end = start;
    while end + 1 < lines.len() && lines[end + 1].trim_start().starts_with(prefix) {
        end += 1;
    }
    end
}

fn looks_like_html(trimmed: &str) -> bool {
    trimmed.starts_with('<') && trimmed.ends_with('>') && !trimmed.starts_with("<http")
}

fn find_html_end(lines: &[&str], start: usize) -> usize {
    let mut end = start;
    while end + 1 < lines.len() {
        let next = lines[end + 1].trim();
        if next.is_empty() || !looks_like_html(next) {
            break;
        }
        end += 1;
    }
    end
}

fn find_paragraph_end(lines: &[&str], start: usize) -> usize {
    let mut end = start;
    while end + 1 < lines.len() {
        let next = lines[end + 1];
        let trimmed = next.trim();
        if trimmed.is_empty()
            || parse_heading_line(next).is_some()
            || parse_list_item(next).is_some()
            || code_fence(trimmed).is_some()
            || trimmed.starts_with("<!--")
            || is_table_start(lines, end + 1)
            || is_thematic_break(trimmed)
            || trimmed.starts_with("![")
            || trimmed.starts_with('>')
            || looks_like_html(trimmed)
        {
            break;
        }
        end += 1;
    }
    end
}

fn preservation_for(kind: MarkdownBlockKind) -> PreservationPolicy {
    match kind {
        MarkdownBlockKind::Paragraph | MarkdownBlockKind::BlockQuote => {
            PreservationPolicy::RequiresConfirmation
        }
        MarkdownBlockKind::Unknown => PreservationPolicy::BlockLossySave,
        _ => PreservationPolicy::PreserveRaw,
    }
}

fn indent_columns(line: &str) -> usize {
    line.chars()
        .take_while(|ch| *ch == ' ' || *ch == '\t')
        .map(|ch| if ch == '\t' { 4 } else { 1 })
        .sum()
}

fn line_end_column(line: &str) -> usize {
    line.chars().count() + 1
}

fn byte_to_column(text: &str, byte_index: usize) -> usize {
    text[..byte_index].chars().count() + 1
}

fn stable_id(
    prefix: &str,
    source_path: Option<&str>,
    line_no: usize,
    text: &str,
    sequence: usize,
) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    let line_no = line_no.to_string();
    let sequence = sequence.to_string();
    for part in [
        prefix,
        source_path.unwrap_or(""),
        line_no.as_str(),
        text,
        sequence.as_str(),
    ] {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{prefix}-{hash:016x}")
}

fn document_title_from_path(source_path: Option<&str>) -> String {
    source_path
        .and_then(|path| Path::new(path).file_stem())
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "Untitled map".to_owned())
}
