use crate::model::{
    CompatibilityDiagnostic, DiagnosticSeverity, MarkdownBlockKind, MarkdownOrigin,
};

pub fn diagnostic(
    code: impl Into<String>,
    severity: DiagnosticSeverity,
    message: impl Into<String>,
    origin: Option<MarkdownOrigin>,
    node_id: Option<String>,
) -> CompatibilityDiagnostic {
    CompatibilityDiagnostic {
        code: code.into(),
        severity,
        message: message.into(),
        origin,
        node_id,
    }
}

pub fn empty_document(origin: MarkdownOrigin) -> CompatibilityDiagnostic {
    diagnostic(
        "empty_document",
        DiagnosticSeverity::Warning,
        "Markdown document does not contain heading or list nodes.",
        Some(origin),
        None,
    )
}

pub fn skipped_heading_level(
    origin: MarkdownOrigin,
    level: u8,
    parent_level: u8,
) -> CompatibilityDiagnostic {
    diagnostic(
        "skipped_heading_level",
        DiagnosticSeverity::Warning,
        format!(
            "Heading level {level} skipped one or more levels after level {parent_level}; attached to nearest available parent."
        ),
        Some(origin),
        None,
    )
}

pub fn mixed_hierarchy(origin: MarkdownOrigin) -> CompatibilityDiagnostic {
    diagnostic(
        "mixed_hierarchy",
        DiagnosticSeverity::Info,
        "Document mixes heading and list hierarchy; list items attach to the nearest list parent or current heading.",
        Some(origin),
        None,
    )
}

pub fn unmapped_content(
    origin: MarkdownOrigin,
    kind: MarkdownBlockKind,
) -> CompatibilityDiagnostic {
    diagnostic(
        "unmapped_content_preserved",
        DiagnosticSeverity::Info,
        format!("{kind:?} content is preserved as raw Markdown outside editable mind map nodes."),
        Some(origin),
        None,
    )
}

pub fn malformed_link(origin: MarkdownOrigin, raw: impl Into<String>) -> CompatibilityDiagnostic {
    diagnostic(
        "malformed_link",
        DiagnosticSeverity::Warning,
        format!(
            "Malformed link token preserved in node text: {}",
            raw.into()
        ),
        Some(origin),
        None,
    )
}

pub fn parser_panic() -> CompatibilityDiagnostic {
    diagnostic(
        "parser_panic",
        DiagnosticSeverity::Error,
        "Markdown parser failed unexpectedly before producing a document.",
        None,
        None,
    )
}

pub fn serializer_panic() -> CompatibilityDiagnostic {
    diagnostic(
        "serializer_panic",
        DiagnosticSeverity::Error,
        "Markdown serializer failed unexpectedly before producing output.",
        None,
        None,
    )
}

pub fn canonicalized_structure() -> CompatibilityDiagnostic {
    diagnostic(
        "markdown_structure_canonicalized",
        DiagnosticSeverity::Info,
        "Mind map structure was serialized as the canonical Markmap heading hierarchy.",
        None,
        None,
    )
}

pub fn raw_block_preserved(
    origin: MarkdownOrigin,
    kind: MarkdownBlockKind,
) -> CompatibilityDiagnostic {
    diagnostic(
        "unmapped_content_serialized",
        DiagnosticSeverity::Info,
        format!("{kind:?} content was preserved as raw Markdown in serialized output."),
        Some(origin),
        None,
    )
}

pub fn raw_block_requires_confirmation(
    origin: MarkdownOrigin,
    kind: MarkdownBlockKind,
) -> CompatibilityDiagnostic {
    diagnostic(
        "unmapped_content_requires_confirmation",
        DiagnosticSeverity::Warning,
        format!(
            "{kind:?} content is preserved as raw Markdown and should be confirmed before saving."
        ),
        Some(origin),
        None,
    )
}

pub fn unplaceable_raw_block(
    origin: MarkdownOrigin,
    kind: MarkdownBlockKind,
    block_id: impl Into<String>,
) -> CompatibilityDiagnostic {
    diagnostic(
        "unmapped_content_unplaceable",
        DiagnosticSeverity::Error,
        format!("{kind:?} content could not be placed safely in serialized Markdown."),
        Some(origin),
        Some(block_id.into()),
    )
}

pub fn lossy_save_requires_confirmation(
    origin: Option<MarkdownOrigin>,
    block_id: Option<String>,
) -> CompatibilityDiagnostic {
    diagnostic(
        "lossy_save_requires_confirmation",
        DiagnosticSeverity::Warning,
        "Serialized Markdown would omit preserved content and requires explicit confirmation.",
        origin,
        block_id,
    )
}

pub fn lossy_save_blocked(
    origin: Option<MarkdownOrigin>,
    block_id: Option<String>,
) -> CompatibilityDiagnostic {
    diagnostic(
        "lossy_save_blocked",
        DiagnosticSeverity::Error,
        "Serialized Markdown would lose content; serialization was blocked by policy.",
        origin,
        block_id,
    )
}

pub fn lossy_save_allowed(
    origin: Option<MarkdownOrigin>,
    block_id: Option<String>,
) -> CompatibilityDiagnostic {
    diagnostic(
        "lossy_save_allowed",
        DiagnosticSeverity::Warning,
        "Serialized Markdown omitted preserved content because the request allowed lossy output.",
        origin,
        block_id,
    )
}

pub fn missing_node(node_id: impl Into<String>) -> CompatibilityDiagnostic {
    let node_id = node_id.into();
    diagnostic(
        "mindmap_node_missing",
        DiagnosticSeverity::Error,
        format!("Mind map node `{node_id}` is referenced but missing from the document."),
        None,
        Some(node_id),
    )
}

pub fn cyclic_node(node_id: impl Into<String>) -> CompatibilityDiagnostic {
    let node_id = node_id.into();
    diagnostic(
        "mindmap_node_cycle",
        DiagnosticSeverity::Error,
        format!("Mind map node `{node_id}` creates a cycle and cannot be serialized safely."),
        None,
        Some(node_id),
    )
}
