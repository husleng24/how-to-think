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

pub fn unmapped_content(origin: MarkdownOrigin, kind: MarkdownBlockKind) -> CompatibilityDiagnostic {
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
        format!("Malformed link token preserved in node text: {}", raw.into()),
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
