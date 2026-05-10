use crate::diagnostics;
use crate::model::{
    CompatibilityDiagnostic, MarkdownBlockKind, MarkdownLineEnding, MarkdownSerializeMode,
    MindMapDocument, MindMapNode, MindMapNodeKind, PreservationPolicy, SerializeMarkdownMetadata,
    SerializeMarkdownRequest, SerializeMarkdownResponse, SerializePreservationPolicy,
    UnmappedMarkdownBlock,
};
use std::collections::{BTreeMap, BTreeSet};
use std::panic::{catch_unwind, AssertUnwindSafe};

const SERIALIZER_SCHEMA_VERSION: &str = "markdown-serializer.v1";

pub fn serialize_markdown(request: SerializeMarkdownRequest) -> SerializeMarkdownResponse {
    match catch_unwind(AssertUnwindSafe(|| serialize_markdown_inner(request))) {
        Ok(response) => response,
        Err(_) => SerializeMarkdownResponse {
            markdown: None,
            diagnostics: vec![diagnostics::serializer_panic()],
            metadata: SerializeMarkdownMetadata {
                schema_version: SERIALIZER_SCHEMA_VERSION.to_owned(),
                source_path: None,
                target_path: None,
                save_mode: MarkdownSerializeMode::default(),
                preservation_policy: SerializePreservationPolicy::default(),
                line_ending: MarkdownLineEnding::default(),
                canonicalized: false,
                node_count: 0,
                unmapped_block_count: 0,
            },
        },
    }
}

pub fn serialize_markdown_document(
    document: MindMapDocument,
    target_path: Option<&str>,
) -> SerializeMarkdownResponse {
    serialize_markdown(SerializeMarkdownRequest {
        document,
        target_path: target_path.map(str::to_owned),
        save_mode: MarkdownSerializeMode::default(),
        preservation_policy: SerializePreservationPolicy::default(),
        line_ending: MarkdownLineEnding::default(),
    })
}

fn serialize_markdown_inner(request: SerializeMarkdownRequest) -> SerializeMarkdownResponse {
    let canonicalized = is_canonicalized(&request.document);
    let metadata = SerializeMarkdownMetadata {
        schema_version: SERIALIZER_SCHEMA_VERSION.to_owned(),
        source_path: request.document.source_path.clone(),
        target_path: request.target_path.clone(),
        save_mode: request.save_mode,
        preservation_policy: request.preservation_policy,
        line_ending: request.line_ending,
        canonicalized,
        node_count: request.document.nodes.len().saturating_sub(1),
        unmapped_block_count: request.document.unmapped_blocks.len(),
    };

    let mut state = SerializerState::new(&request.document, request.preservation_policy);
    if canonicalized {
        state
            .diagnostics
            .push(diagnostics::canonicalized_structure());
    }

    state.classify_unmapped_blocks();

    let mut segments = Vec::new();
    let frontmatter_blocks = state.frontmatter_blocks.clone();
    for block in frontmatter_blocks {
        state.push_raw_segment(&mut segments, block);
    }

    let root_after_blocks = state.root_after_blocks.clone();
    for block in root_after_blocks {
        state.push_raw_segment(&mut segments, block);
    }

    match request.document.nodes.get(&request.document.root_node_id) {
        Some(root) => {
            let mut active = BTreeSet::new();
            for child_id in &root.children {
                state.write_node(child_id, 1, &mut active, &mut segments);
            }
        }
        None => {
            state
                .diagnostics
                .push(diagnostics::missing_node(&request.document.root_node_id));
            state.blocking_error = true;
        }
    }

    let markdown = if state.blocking_error {
        None
    } else {
        Some(apply_line_ending(
            finalize_segments(&segments),
            request.line_ending,
        ))
    };

    SerializeMarkdownResponse {
        markdown,
        diagnostics: state.diagnostics,
        metadata,
    }
}

struct SerializerState<'a> {
    document: &'a MindMapDocument,
    preservation_policy: SerializePreservationPolicy,
    diagnostics: Vec<CompatibilityDiagnostic>,
    frontmatter_blocks: Vec<&'a UnmappedMarkdownBlock>,
    root_after_blocks: Vec<&'a UnmappedMarkdownBlock>,
    before_blocks: BTreeMap<String, Vec<&'a UnmappedMarkdownBlock>>,
    after_blocks: BTreeMap<String, Vec<&'a UnmappedMarkdownBlock>>,
    blocking_error: bool,
}

impl<'a> SerializerState<'a> {
    fn new(
        document: &'a MindMapDocument,
        preservation_policy: SerializePreservationPolicy,
    ) -> Self {
        Self {
            document,
            preservation_policy,
            diagnostics: Vec::new(),
            frontmatter_blocks: Vec::new(),
            root_after_blocks: Vec::new(),
            before_blocks: BTreeMap::new(),
            after_blocks: BTreeMap::new(),
            blocking_error: false,
        }
    }

    fn classify_unmapped_blocks(&mut self) {
        let mut blocks = self.document.unmapped_blocks.iter().collect::<Vec<_>>();
        blocks.sort_by_key(|block| {
            (
                block.origin.span.start_line,
                block.origin.span.start_column,
                block.id.as_str(),
            )
        });

        for block in blocks {
            match block.preservation {
                PreservationPolicy::PreserveRaw => {
                    self.place_preservable_block(block);
                }
                PreservationPolicy::RequiresConfirmation => {
                    self.diagnostics
                        .push(diagnostics::raw_block_requires_confirmation(
                            block.origin.clone(),
                            block.kind,
                        ));
                    self.place_preservable_block(block);
                }
                PreservationPolicy::BlockLossySave => self.handle_block_lossy_policy(block),
            }
        }
    }

    fn handle_block_lossy_policy(&mut self, block: &'a UnmappedMarkdownBlock) {
        match self.preservation_policy {
            SerializePreservationPolicy::BlockLossy => {
                self.handle_lossy_block(Some(block));
            }
            SerializePreservationPolicy::RequireConfirmation => {
                self.diagnostics
                    .push(diagnostics::raw_block_requires_confirmation(
                        block.origin.clone(),
                        block.kind,
                    ));
                self.place_preservable_block(block);
            }
            SerializePreservationPolicy::AllowLossy => {
                if !self.place_preservable_block(block) {
                    self.handle_lossy_block(Some(block));
                }
            }
        }
    }

    fn place_preservable_block(&mut self, block: &'a UnmappedMarkdownBlock) -> bool {
        let placed = self.place_block(block);
        if placed {
            self.diagnostics.push(diagnostics::raw_block_preserved(
                block.origin.clone(),
                block.kind,
            ));
        } else {
            self.diagnostics.push(diagnostics::unplaceable_raw_block(
                block.origin.clone(),
                block.kind,
                block.id.clone(),
            ));
            self.handle_lossy_block(Some(block));
        }
        placed
    }

    fn place_block(&mut self, block: &'a UnmappedMarkdownBlock) -> bool {
        if block.kind == MarkdownBlockKind::Frontmatter {
            self.frontmatter_blocks.push(block);
            return true;
        }

        if let Some(before_node_id) = &block.placement.before_node_id {
            if self.document.nodes.contains_key(before_node_id) {
                self.before_blocks
                    .entry(before_node_id.clone())
                    .or_default()
                    .push(block);
                return true;
            }
            return false;
        }

        if let Some(after_node_id) = &block.placement.after_node_id {
            if after_node_id == &self.document.root_node_id {
                self.root_after_blocks.push(block);
                return true;
            }

            if self.document.nodes.contains_key(after_node_id) {
                self.after_blocks
                    .entry(after_node_id.clone())
                    .or_default()
                    .push(block);
                return true;
            }
        }

        false
    }

    fn handle_lossy_block(&mut self, block: Option<&UnmappedMarkdownBlock>) {
        let origin = block.map(|block| block.origin.clone());
        let block_id = block.map(|block| block.id.clone());

        match self.preservation_policy {
            SerializePreservationPolicy::BlockLossy => {
                self.diagnostics
                    .push(diagnostics::lossy_save_blocked(origin, block_id));
                self.blocking_error = true;
            }
            SerializePreservationPolicy::RequireConfirmation => {
                self.diagnostics
                    .push(diagnostics::lossy_save_requires_confirmation(
                        origin, block_id,
                    ));
            }
            SerializePreservationPolicy::AllowLossy => {
                self.diagnostics
                    .push(diagnostics::lossy_save_allowed(origin, block_id));
            }
        }
    }

    fn write_node(
        &mut self,
        node_id: &str,
        depth: usize,
        active: &mut BTreeSet<String>,
        segments: &mut Vec<MarkdownSegment>,
    ) {
        if !active.insert(node_id.to_owned()) {
            self.diagnostics
                .push(diagnostics::cyclic_node(node_id.to_owned()));
            self.blocking_error = true;
            return;
        }

        let Some(node) = self.document.nodes.get(node_id) else {
            self.diagnostics
                .push(diagnostics::missing_node(node_id.to_owned()));
            self.blocking_error = true;
            active.remove(node_id);
            return;
        };

        let before_blocks = self.before_blocks.get(node_id).cloned().unwrap_or_default();
        for block in before_blocks {
            self.push_raw_segment(segments, block);
        }

        segments.push(node_segment(node, depth));

        let after_blocks = self.after_blocks.get(node_id).cloned().unwrap_or_default();
        for block in after_blocks {
            self.push_raw_segment(segments, block);
        }

        for child_id in &node.children {
            self.write_node(child_id, depth + 1, active, segments);
        }

        active.remove(node_id);
    }

    fn push_raw_segment(
        &mut self,
        segments: &mut Vec<MarkdownSegment>,
        block: &UnmappedMarkdownBlock,
    ) {
        let raw = normalize_raw_block(&block.raw);
        if !raw.is_empty() {
            segments.push(MarkdownSegment {
                kind: MarkdownSegmentKind::Raw,
                text: raw,
            });
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkdownSegmentKind {
    Heading,
    ListItem,
    Raw,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarkdownSegment {
    kind: MarkdownSegmentKind,
    text: String,
}

fn node_segment(node: &MindMapNode, depth: usize) -> MarkdownSegment {
    let title = sanitize_node_title(&node.title);

    if depth <= 6 {
        MarkdownSegment {
            kind: MarkdownSegmentKind::Heading,
            text: format!("{} {title}", "#".repeat(depth)),
        }
    } else {
        MarkdownSegment {
            kind: MarkdownSegmentKind::ListItem,
            text: format!("{}{} {title}", "  ".repeat(depth - 7), list_marker(node)),
        }
    }
}

fn list_marker(node: &MindMapNode) -> &'static str {
    match node.list_marker.as_ref().and_then(|marker| marker.checked) {
        Some(true) => "- [x]",
        Some(false) => "- [ ]",
        None => "-",
    }
}

fn sanitize_node_title(title: &str) -> String {
    let mut sanitized = String::with_capacity(title.len());
    let mut previous_was_break = false;

    for ch in title.chars() {
        match ch {
            '\r' | '\n' => {
                if !previous_was_break {
                    sanitized.push(' ');
                    previous_was_break = true;
                }
            }
            _ => {
                sanitized.push(ch);
                previous_was_break = false;
            }
        }
    }

    let sanitized = sanitized.trim();
    if sanitized.is_empty() {
        "Untitled".to_owned()
    } else {
        sanitized.to_owned()
    }
}

fn normalize_raw_block(raw: &str) -> String {
    raw.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_matches('\n')
        .to_owned()
}

fn finalize_segments(segments: &[MarkdownSegment]) -> String {
    let mut markdown = String::new();
    let mut previous_kind = None;

    for segment in segments {
        if !markdown.is_empty() {
            if previous_kind == Some(MarkdownSegmentKind::ListItem)
                && segment.kind == MarkdownSegmentKind::ListItem
            {
                markdown.push('\n');
            } else {
                markdown.push_str("\n\n");
            }
        }

        markdown.push_str(segment.text.trim_end());
        previous_kind = Some(segment.kind);
    }

    if !markdown.is_empty() {
        markdown.push('\n');
    }

    markdown
}

fn apply_line_ending(markdown: String, line_ending: MarkdownLineEnding) -> String {
    match line_ending {
        MarkdownLineEnding::Lf => markdown,
        MarkdownLineEnding::Crlf => markdown.replace('\n', "\r\n"),
    }
}

fn is_canonicalized(document: &MindMapDocument) -> bool {
    document
        .nodes
        .values()
        .any(|node| node.node_kind == MindMapNodeKind::ListItem)
        || document
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "mixed_hierarchy")
}
