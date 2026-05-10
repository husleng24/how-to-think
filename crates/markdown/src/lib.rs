//! Markdown compatibility parser for How to Think.
//!
//! This crate is deliberately UI- and filesystem-independent. It accepts raw
//! Markdown plus optional source metadata and returns a stable JSON model that
//! can be consumed by Tauri commands, the React editor, or the future CLI.

pub mod diagnostics;
pub mod model;
pub mod parser;
pub mod serializer;

pub use model::{
    CompatibilityDiagnostic, DiagnosticSeverity, LinkToken, LinkTokenKind, ListMarker,
    ListMarkerKind, MarkdownBlockKind, MarkdownLineEnding, MarkdownOrigin, MarkdownSerializeMode,
    MindMapDocument, MindMapNode, MindMapNodeKind, ParseMarkdownRequest, ParseMarkdownResponse,
    ParseMode, PreservationPolicy, SerializeMarkdownMetadata, SerializeMarkdownRequest,
    SerializeMarkdownResponse, SerializePreservationPolicy, SourceSpan, UnmappedMarkdownBlock,
    UnmappedPlacement,
};
pub use parser::{parse_markdown, parse_markdown_to_mindmap};
pub use serializer::{serialize_markdown, serialize_markdown_document};
