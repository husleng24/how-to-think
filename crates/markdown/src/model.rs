use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParseMode {
    Auto,
    HeadingOnly,
    ListOnly,
    Mixed,
}

impl Default for ParseMode {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParseMarkdownRequest {
    pub markdown: String,
    pub source_path: Option<String>,
    #[serde(default)]
    pub parse_mode: ParseMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParseMarkdownResponse {
    pub document: Option<MindMapDocument>,
    pub diagnostics: Vec<CompatibilityDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerializeMarkdownRequest {
    pub document: MindMapDocument,
    pub target_path: Option<String>,
    #[serde(default)]
    pub save_mode: MarkdownSerializeMode,
    #[serde(default)]
    pub preservation_policy: SerializePreservationPolicy,
    #[serde(default)]
    pub line_ending: MarkdownLineEnding,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerializeMarkdownResponse {
    pub markdown: Option<String>,
    pub diagnostics: Vec<CompatibilityDiagnostic>,
    pub metadata: SerializeMarkdownMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerializeMarkdownMetadata {
    pub schema_version: String,
    pub source_path: Option<String>,
    pub target_path: Option<String>,
    pub save_mode: MarkdownSerializeMode,
    pub preservation_policy: SerializePreservationPolicy,
    pub line_ending: MarkdownLineEnding,
    pub canonicalized: bool,
    pub node_count: usize,
    pub unmapped_block_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MarkdownSerializeMode {
    CanonicalHeadings,
}

impl Default for MarkdownSerializeMode {
    fn default() -> Self {
        Self::CanonicalHeadings
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SerializePreservationPolicy {
    BlockLossy,
    RequireConfirmation,
    AllowLossy,
}

impl Default for SerializePreservationPolicy {
    fn default() -> Self {
        Self::BlockLossy
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MarkdownLineEnding {
    Lf,
    Crlf,
}

impl Default for MarkdownLineEnding {
    fn default() -> Self {
        Self::Lf
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MindMapDocument {
    pub schema_version: String,
    pub source_path: Option<String>,
    pub title: String,
    pub parse_mode: ParseMode,
    pub root_node_id: String,
    pub nodes: BTreeMap<String, MindMapNode>,
    pub unmapped_blocks: Vec<UnmappedMarkdownBlock>,
    pub diagnostics: Vec<CompatibilityDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MindMapNode {
    pub id: String,
    pub title: String,
    pub raw_text: String,
    pub node_kind: MindMapNodeKind,
    pub children: Vec<String>,
    pub origin: MarkdownOrigin,
    pub links: Vec<LinkToken>,
    pub list_marker: Option<ListMarker>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MindMapNodeKind {
    VirtualRoot,
    Heading,
    ListItem,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListMarker {
    pub raw: String,
    pub kind: ListMarkerKind,
    pub ordinal: Option<u32>,
    pub checked: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ListMarkerKind {
    Unordered,
    Ordered,
    Task,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownOrigin {
    pub source_path: Option<String>,
    pub span: SourceSpan,
    pub block_kind: MarkdownBlockKind,
    pub heading_level: Option<u8>,
    pub list_depth: Option<usize>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MarkdownBlockKind {
    DocumentRoot,
    Heading,
    ListItem,
    Frontmatter,
    Paragraph,
    CodeBlock,
    Table,
    Image,
    Html,
    Comment,
    BlockQuote,
    ThematicBreak,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkToken {
    pub kind: LinkTokenKind,
    pub raw: String,
    pub label: Option<String>,
    pub target: String,
    pub alias: Option<String>,
    pub origin: MarkdownOrigin,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LinkTokenKind {
    StandardMarkdown,
    Image,
    ObsidianWiki,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnmappedMarkdownBlock {
    pub id: String,
    pub kind: MarkdownBlockKind,
    pub raw: String,
    pub origin: MarkdownOrigin,
    pub placement: UnmappedPlacement,
    pub preservation: PreservationPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnmappedPlacement {
    pub after_node_id: Option<String>,
    pub before_node_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreservationPolicy {
    PreserveRaw,
    RequiresConfirmation,
    BlockLossySave,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityDiagnostic {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub origin: Option<MarkdownOrigin>,
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}
