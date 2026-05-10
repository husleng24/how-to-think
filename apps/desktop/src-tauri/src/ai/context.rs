use crate::documents;
use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::file_index::index_markdown_files;
use crate::models::{WorkspaceId, WorkspaceRecord, WorkspaceRelativePath};
use crate::path_guard::validate_workspace_relative_path;
use how_to_think_markdown::{
    parse_markdown_to_mindmap, DiagnosticSeverity, MindMapDocument as MarkdownMindMapDocument,
    MindMapNode as MarkdownMindMapNode, ParseMode,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub type NodeId = String;

const DEFAULT_MAX_CONTEXT_BYTES: usize = 24 * 1024;
const DEFAULT_MAX_FILES: usize = 80;
const DEFAULT_MAX_OPEN_FILES: usize = 5;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiContextScope {
    SelectedNode,
    SelectedBranch,
    CurrentFile,
    WorkspaceSummary,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiContextItemKind {
    MindMapNode,
    MindMapBranch,
    MarkdownFile,
    WorkspaceFileTree,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiContextWarningCode {
    ContextTruncated,
    FileLimitReached,
    IgnoredPathsExcluded,
    UnsupportedFilesExcluded,
    InvalidDocumentPath,
    OpenFileSkipped,
    MarkdownParserDiagnostic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiContextWarning {
    pub code: AiContextWarningCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<WorkspaceRelativePath>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiContextItem {
    pub id: String,
    pub kind: AiContextItemKind,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<WorkspaceRelativePath>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_ids: Vec<NodeId>,
    pub content: String,
    pub byte_estimate: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiContextLimits {
    #[serde(default = "default_max_context_bytes")]
    pub max_context_bytes: usize,
    #[serde(default = "default_max_files")]
    pub max_files: usize,
    #[serde(default = "default_max_open_files")]
    pub max_open_files: usize,
}

impl Default for AiContextLimits {
    fn default() -> Self {
        Self {
            max_context_bytes: default_max_context_bytes(),
            max_files: default_max_files(),
            max_open_files: default_max_open_files(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiContextSnapshotRequest {
    pub workspace_id: WorkspaceId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<AiContextScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<AiMindMapDocument>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_node_id: Option<NodeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_file: Option<WorkspaceRelativePath>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open_files: Vec<WorkspaceRelativePath>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_revision: Option<u64>,
    #[serde(default)]
    pub limits: AiContextLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiContextSnapshot {
    pub workspace_id: WorkspaceId,
    pub scope: AiContextScope,
    pub display_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_path: Option<WorkspaceRelativePath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_node_ids: Vec<NodeId>,
    pub items: Vec<AiContextItem>,
    pub byte_estimate: usize,
    pub token_estimate: usize,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<AiContextWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiMindMapDocument {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<WorkspaceRelativePath>,
    pub root_node_id: NodeId,
    pub version: u64,
    pub nodes: BTreeMap<NodeId, AiMindMapNode>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiMindMapNode {
    pub id: NodeId,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<NodeId>,
    #[serde(default)]
    pub child_ids: Vec<NodeId>,
    pub collapsed: bool,
    pub created_at: String,
    pub updated_at: String,
}

pub fn build_context_snapshot(
    record: &WorkspaceRecord,
    request: AiContextSnapshotRequest,
) -> Result<AiContextSnapshot, WorkspaceError> {
    ensure_workspace_matches(record, &request.workspace_id)?;

    match resolve_scope(&request) {
        AiContextScope::SelectedNode => build_selected_node_snapshot(record, &request),
        AiContextScope::SelectedBranch => build_selected_branch_snapshot(record, &request),
        AiContextScope::CurrentFile => build_current_file_snapshot(record, &request),
        AiContextScope::WorkspaceSummary => build_workspace_summary_snapshot(record, &request),
    }
}

fn build_selected_node_snapshot(
    record: &WorkspaceRecord,
    request: &AiContextSnapshotRequest,
) -> Result<AiContextSnapshot, WorkspaceError> {
    let document = require_document(request, AiContextScope::SelectedNode)?;
    let node_id = require_selected_node_id(request, AiContextScope::SelectedNode)?;
    let node = document.nodes.get(node_id).ok_or_else(|| {
        invalid_context_request(format!(
            "Selected node '{node_id}' is not present in the document."
        ))
    })?;
    ensure_child_references(document, node)?;

    let mut warnings = Vec::new();
    let document_path = validated_document_path(record, request, document, &mut warnings);
    let item = AiContextItem {
        id: format!("mindmap-node:{node_id}"),
        kind: AiContextItemKind::MindMapNode,
        label: format!("Selected node: {}", compact_label(&node.text)),
        relative_path: document_path.clone(),
        node_ids: vec![node_id.to_owned()],
        content: serialize_selected_node(document, node)?,
        byte_estimate: 0,
    };

    Ok(finalize_snapshot(
        SnapshotDraft {
            workspace_id: record.info.id.clone(),
            scope: AiContextScope::SelectedNode,
            display_label: item.label.clone(),
            document_id: Some(document.id.clone()),
            document_path,
            document_revision: Some(document_revision(document, request.content_revision)),
            document_content_hash: Some(document_content_hash(document, request.content_revision)?),
            selected_node_ids: vec![node_id.to_owned()],
            items: vec![item],
            warnings,
        },
        request.limits,
    ))
}

fn build_selected_branch_snapshot(
    record: &WorkspaceRecord,
    request: &AiContextSnapshotRequest,
) -> Result<AiContextSnapshot, WorkspaceError> {
    let document = require_document(request, AiContextScope::SelectedBranch)?;
    let node_id = require_selected_node_id(request, AiContextScope::SelectedBranch)?;
    let root = document.nodes.get(node_id).ok_or_else(|| {
        invalid_context_request(format!(
            "Selected branch root '{node_id}' is not present in the document."
        ))
    })?;

    let branch = serialize_frontend_branch(document, node_id)?;
    let mut warnings = Vec::new();
    let document_path = validated_document_path(record, request, document, &mut warnings);
    let label = format!(
        "Selected branch: {} ({} nodes)",
        compact_label(&root.text),
        branch.node_ids.len()
    );
    let item = AiContextItem {
        id: format!("mindmap-branch:{node_id}"),
        kind: AiContextItemKind::MindMapBranch,
        label: label.clone(),
        relative_path: document_path.clone(),
        node_ids: branch.node_ids.clone(),
        content: branch.content,
        byte_estimate: 0,
    };

    Ok(finalize_snapshot(
        SnapshotDraft {
            workspace_id: record.info.id.clone(),
            scope: AiContextScope::SelectedBranch,
            display_label: label,
            document_id: Some(document.id.clone()),
            document_path,
            document_revision: Some(document_revision(document, request.content_revision)),
            document_content_hash: Some(document_content_hash(document, request.content_revision)?),
            selected_node_ids: branch.node_ids,
            items: vec![item],
            warnings,
        },
        request.limits,
    ))
}

fn build_current_file_snapshot(
    record: &WorkspaceRecord,
    request: &AiContextSnapshotRequest,
) -> Result<AiContextSnapshot, WorkspaceError> {
    let relative_path = current_file_candidate(request).ok_or_else(|| {
        invalid_context_request("Current file context requires a current Markdown file path.")
    })?;
    let snapshot = documents::open_document(record, &relative_path)?;
    let (content, warnings) =
        serialize_markdown_file_context(&snapshot.relative_path, &snapshot.content);
    let label = format!("Current file: {}", snapshot.relative_path);
    let item = AiContextItem {
        id: format!("markdown-file:{}", snapshot.relative_path),
        kind: AiContextItemKind::MarkdownFile,
        label: label.clone(),
        relative_path: Some(snapshot.relative_path.clone()),
        node_ids: Vec::new(),
        content,
        byte_estimate: 0,
    };

    Ok(finalize_snapshot(
        SnapshotDraft {
            workspace_id: record.info.id.clone(),
            scope: AiContextScope::CurrentFile,
            display_label: label,
            document_id: request
                .document
                .as_ref()
                .map(|document| document.id.clone()),
            document_path: Some(snapshot.relative_path),
            document_revision: Some(snapshot.version.token),
            document_content_hash: Some(snapshot.version.content_hash),
            selected_node_ids: Vec::new(),
            items: vec![item],
            warnings,
        },
        request.limits,
    ))
}

fn build_workspace_summary_snapshot(
    record: &WorkspaceRecord,
    request: &AiContextSnapshotRequest,
) -> Result<AiContextSnapshot, WorkspaceError> {
    let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)?;
    let shown_files = files
        .iter()
        .take(request.limits.max_files)
        .collect::<Vec<_>>();
    let mut warnings = vec![
        AiContextWarning {
            code: AiContextWarningCode::IgnoredPathsExcluded,
            message: "Ignored implementation directories are excluded from workspace AI context."
                .to_owned(),
            item_id: None,
            relative_path: None,
        },
        AiContextWarning {
            code: AiContextWarningCode::UnsupportedFilesExcluded,
            message: "Only supported Markdown files are included in workspace AI context."
                .to_owned(),
            item_id: None,
            relative_path: None,
        },
    ];

    if files.len() > shown_files.len() {
        warnings.push(AiContextWarning {
            code: AiContextWarningCode::FileLimitReached,
            message: format!(
                "Workspace context includes the first {} of {} indexed Markdown files.",
                shown_files.len(),
                files.len()
            ),
            item_id: Some("workspace-file-tree".to_owned()),
            relative_path: None,
        });
    }

    let mut items = vec![AiContextItem {
        id: "workspace-file-tree".to_owned(),
        kind: AiContextItemKind::WorkspaceFileTree,
        label: format!("Workspace summary: {} Markdown files", files.len()),
        relative_path: None,
        node_ids: Vec::new(),
        content: serialize_workspace_summary(record, files.len(), &shown_files),
        byte_estimate: 0,
    }];

    for relative_path in relevant_open_files(request)
        .into_iter()
        .take(request.limits.max_open_files)
    {
        match documents::open_document(record, &relative_path) {
            Ok(snapshot) => {
                let (content, parser_warnings) =
                    serialize_markdown_file_context(&snapshot.relative_path, &snapshot.content);
                warnings.extend(parser_warnings);
                items.push(AiContextItem {
                    id: format!("workspace-open-file:{}", snapshot.relative_path),
                    kind: AiContextItemKind::MarkdownFile,
                    label: format!("Relevant file: {}", snapshot.relative_path),
                    relative_path: Some(snapshot.relative_path),
                    node_ids: Vec::new(),
                    content,
                    byte_estimate: 0,
                });
            }
            Err(error) => warnings.push(AiContextWarning {
                code: AiContextWarningCode::OpenFileSkipped,
                message: format!("Open file was skipped: {}", error.message),
                item_id: None,
                relative_path: Some(relative_path),
            }),
        }
    }

    let workspace_hash = workspace_content_hash(&files);
    Ok(finalize_snapshot(
        SnapshotDraft {
            workspace_id: record.info.id.clone(),
            scope: AiContextScope::WorkspaceSummary,
            display_label: format!("Workspace summary: {} Markdown files", files.len()),
            document_id: None,
            document_path: None,
            document_revision: Some(format!(
                "workspace:{}:{}",
                files.len(),
                &workspace_hash[..16]
            )),
            document_content_hash: Some(workspace_hash),
            selected_node_ids: Vec::new(),
            items,
            warnings,
        },
        request.limits,
    ))
}

fn resolve_scope(request: &AiContextSnapshotRequest) -> AiContextScope {
    if let Some(scope) = request.scope {
        return scope;
    }

    if request
        .document
        .as_ref()
        .zip(request.selected_node_id.as_ref())
        .is_some_and(|(document, node_id)| document.nodes.contains_key(node_id))
    {
        return AiContextScope::SelectedNode;
    }

    if current_file_candidate(request).is_some() {
        return AiContextScope::CurrentFile;
    }

    AiContextScope::WorkspaceSummary
}

fn require_document(
    request: &AiContextSnapshotRequest,
    scope: AiContextScope,
) -> Result<&AiMindMapDocument, WorkspaceError> {
    request.document.as_ref().ok_or_else(|| {
        invalid_context_request(format!(
            "{scope:?} context requires a mind map document snapshot."
        ))
    })
}

fn require_selected_node_id(
    request: &AiContextSnapshotRequest,
    scope: AiContextScope,
) -> Result<&str, WorkspaceError> {
    request.selected_node_id.as_deref().ok_or_else(|| {
        invalid_context_request(format!("{scope:?} context requires a selected node id."))
    })
}

fn ensure_workspace_matches(
    record: &WorkspaceRecord,
    workspace_id: &str,
) -> Result<(), WorkspaceError> {
    if record.info.id == workspace_id {
        return Ok(());
    }

    Err(WorkspaceError::new(
        WorkspaceErrorCode::WorkspaceNotSelected,
        WorkspaceOperation::BuildAiContext,
        "The requested workspace id does not match the stored workspace path.",
        true,
    ))
}

fn current_file_candidate(request: &AiContextSnapshotRequest) -> Option<WorkspaceRelativePath> {
    request.current_file.clone().or_else(|| {
        request
            .document
            .as_ref()
            .and_then(|document| document.source_path.clone())
    })
}

fn validated_document_path(
    record: &WorkspaceRecord,
    request: &AiContextSnapshotRequest,
    document: &AiMindMapDocument,
    warnings: &mut Vec<AiContextWarning>,
) -> Option<WorkspaceRelativePath> {
    let candidate = document
        .source_path
        .as_ref()
        .or(request.current_file.as_ref())?;

    match validate_workspace_relative_path(
        candidate,
        record.info.case_sensitive,
        WorkspaceOperation::BuildAiContext,
    ) {
        Ok(relative_path) => Some(relative_path),
        Err(error) => {
            warnings.push(AiContextWarning {
                code: AiContextWarningCode::InvalidDocumentPath,
                message: format!(
                    "Document path was omitted from AI context metadata: {}",
                    error.message
                ),
                item_id: None,
                relative_path: Some(candidate.clone()),
            });
            None
        }
    }
}

fn serialize_selected_node(
    document: &AiMindMapDocument,
    node: &AiMindMapNode,
) -> Result<String, WorkspaceError> {
    let mut lines = vec![
        format!("Mind map: {}", document.title),
        format!("Document id: {}", document.id),
        format!("Document version: {}", document.version),
        "Scope: selected node".to_owned(),
        String::new(),
        format!("Node: {}", display_text(&node.text)),
        format!("Node id: {}", node.id),
    ];

    if let Some(parent_id) = &node.parent_id {
        if let Some(parent) = document.nodes.get(parent_id) {
            lines.push(format!(
                "Parent: {} ({})",
                display_text(&parent.text),
                parent.id
            ));
        }
    }

    if !node.child_ids.is_empty() {
        lines.push("Children:".to_owned());
        for child_id in &node.child_ids {
            let child = document.nodes.get(child_id).ok_or_else(|| {
                invalid_context_request(format!(
                    "Node '{}' references missing child '{}'.",
                    node.id, child_id
                ))
            })?;
            lines.push(format!("- {} ({})", display_text(&child.text), child.id));
        }
    }

    Ok(lines.join("\n"))
}

struct SerializedBranch {
    node_ids: Vec<NodeId>,
    content: String,
}

fn serialize_frontend_branch(
    document: &AiMindMapDocument,
    root_node_id: &str,
) -> Result<SerializedBranch, WorkspaceError> {
    let mut node_ids = Vec::new();
    let mut lines = vec![
        format!("Mind map: {}", document.title),
        format!("Document id: {}", document.id),
        format!("Document version: {}", document.version),
        "Scope: selected branch".to_owned(),
        String::new(),
    ];
    let mut active = BTreeSet::new();
    push_frontend_branch_node(
        document,
        root_node_id,
        0,
        &mut active,
        &mut node_ids,
        &mut lines,
    )?;

    Ok(SerializedBranch {
        node_ids,
        content: lines.join("\n"),
    })
}

fn push_frontend_branch_node(
    document: &AiMindMapDocument,
    node_id: &str,
    depth: usize,
    active: &mut BTreeSet<NodeId>,
    node_ids: &mut Vec<NodeId>,
    lines: &mut Vec<String>,
) -> Result<(), WorkspaceError> {
    if !active.insert(node_id.to_owned()) {
        return Err(invalid_context_request(format!(
            "Mind map branch contains a cycle at node '{node_id}'."
        )));
    }

    let node = document.nodes.get(node_id).ok_or_else(|| {
        invalid_context_request(format!(
            "Mind map branch references missing node '{node_id}'."
        ))
    })?;
    node_ids.push(node_id.to_owned());
    lines.push(format!(
        "{}- {} ({})",
        "  ".repeat(depth),
        display_text(&node.text),
        node.id
    ));

    for child_id in &node.child_ids {
        push_frontend_branch_node(document, child_id, depth + 1, active, node_ids, lines)?;
    }

    active.remove(node_id);
    Ok(())
}

fn ensure_child_references(
    document: &AiMindMapDocument,
    node: &AiMindMapNode,
) -> Result<(), WorkspaceError> {
    for child_id in &node.child_ids {
        if !document.nodes.contains_key(child_id) {
            return Err(invalid_context_request(format!(
                "Node '{}' references missing child '{}'.",
                node.id, child_id
            )));
        }
    }

    Ok(())
}

fn serialize_markdown_file_context(
    relative_path: &str,
    markdown: &str,
) -> (String, Vec<AiContextWarning>) {
    let parsed = parse_markdown_to_mindmap(markdown, Some(relative_path), ParseMode::Auto);
    let mut warnings = parsed
        .diagnostics
        .iter()
        .filter(|diagnostic| {
            matches!(
                diagnostic.severity,
                DiagnosticSeverity::Warning | DiagnosticSeverity::Error
            )
        })
        .map(|diagnostic| AiContextWarning {
            code: AiContextWarningCode::MarkdownParserDiagnostic,
            message: diagnostic.message.clone(),
            item_id: Some(format!("markdown-file:{relative_path}")),
            relative_path: Some(relative_path.to_owned()),
        })
        .collect::<Vec<_>>();

    let hierarchy = parsed
        .document
        .as_ref()
        .map(serialize_markdown_hierarchy)
        .unwrap_or_else(|| "No parseable Markdown hierarchy.".to_owned());
    if parsed.document.is_none() {
        warnings.push(AiContextWarning {
            code: AiContextWarningCode::MarkdownParserDiagnostic,
            message: "Markdown parser did not return a document for AI context.".to_owned(),
            item_id: Some(format!("markdown-file:{relative_path}")),
            relative_path: Some(relative_path.to_owned()),
        });
    }

    (
        format!(
            "Markdown file: {relative_path}\n\nHierarchy:\n{hierarchy}\n\nRaw Markdown:\n{}",
            normalize_line_endings(markdown)
        ),
        warnings,
    )
}

fn serialize_markdown_hierarchy(document: &MarkdownMindMapDocument) -> String {
    let Some(root) = document.nodes.get(&document.root_node_id) else {
        return "No parseable Markdown hierarchy.".to_owned();
    };

    let mut lines = Vec::new();
    let mut active = BTreeSet::new();
    for child_id in &root.children {
        push_markdown_node(document, child_id, 0, &mut active, &mut lines);
    }

    if lines.is_empty() {
        "No parseable Markdown hierarchy.".to_owned()
    } else {
        lines.join("\n")
    }
}

fn push_markdown_node(
    document: &MarkdownMindMapDocument,
    node_id: &str,
    depth: usize,
    active: &mut BTreeSet<String>,
    lines: &mut Vec<String>,
) {
    if !active.insert(node_id.to_owned()) {
        lines.push(format!(
            "{}- [cycle omitted at {node_id}]",
            "  ".repeat(depth)
        ));
        return;
    }

    if let Some(node) = document.nodes.get(node_id) {
        lines.push(format_markdown_node(node, depth));
        for child_id in &node.children {
            push_markdown_node(document, child_id, depth + 1, active, lines);
        }
    }

    active.remove(node_id);
}

fn format_markdown_node(node: &MarkdownMindMapNode, depth: usize) -> String {
    let links = if node.links.is_empty() {
        String::new()
    } else {
        let labels = node
            .links
            .iter()
            .map(|link| link.raw.clone())
            .collect::<Vec<_>>()
            .join(", ");
        format!(" [links: {labels}]")
    };

    format!(
        "{}- {} ({:?}, line {}){}",
        "  ".repeat(depth),
        display_text(&node.title),
        node.node_kind,
        node.origin.span.start_line,
        links
    )
}

fn serialize_workspace_summary(
    record: &WorkspaceRecord,
    total_file_count: usize,
    files: &[&crate::models::WorkspaceFile],
) -> String {
    let mut lines = vec![
        format!("Workspace: {}", record.info.display_name),
        format!("Workspace id: {}", record.info.id),
        format!("Markdown files indexed: {total_file_count}"),
        format!("Markdown files shown: {}", files.len()),
        String::new(),
        "Files:".to_owned(),
    ];

    if files.is_empty() {
        lines.push("- No Markdown files included.".to_owned());
    } else {
        for file in files {
            lines.push(format!(
                "- {} ({} bytes, hash {})",
                file.relative_path,
                file.byte_size,
                &file.version.content_hash[..16]
            ));
        }
    }

    lines.join("\n")
}

fn relevant_open_files(request: &AiContextSnapshotRequest) -> Vec<WorkspaceRelativePath> {
    let mut seen = BTreeSet::new();
    let mut paths = Vec::new();

    if let Some(current_file) = current_file_candidate(request) {
        if seen.insert(current_file.clone()) {
            paths.push(current_file);
        }
    }

    for relative_path in &request.open_files {
        if seen.insert(relative_path.clone()) {
            paths.push(relative_path.clone());
        }
    }

    paths
}

struct SnapshotDraft {
    workspace_id: WorkspaceId,
    scope: AiContextScope,
    display_label: String,
    document_id: Option<String>,
    document_path: Option<WorkspaceRelativePath>,
    document_revision: Option<String>,
    document_content_hash: Option<String>,
    selected_node_ids: Vec<NodeId>,
    items: Vec<AiContextItem>,
    warnings: Vec<AiContextWarning>,
}

fn finalize_snapshot(draft: SnapshotDraft, limits: AiContextLimits) -> AiContextSnapshot {
    let mut remaining_bytes = limits.max_context_bytes;
    let mut items = draft.items;
    let mut truncated = false;

    for item in &mut items {
        let original_content = std::mem::take(&mut item.content);
        let original_bytes = original_content.as_bytes().len();
        if original_bytes > remaining_bytes {
            item.content = truncate_to_byte_limit(&original_content, remaining_bytes);
            item.byte_estimate = item.content.as_bytes().len();
            remaining_bytes = 0;
            truncated = true;
        } else {
            item.byte_estimate = original_bytes;
            item.content = original_content;
            remaining_bytes -= original_bytes;
        }
    }

    let byte_estimate = items.iter().map(|item| item.byte_estimate).sum::<usize>();
    let mut warnings = draft.warnings;
    if truncated {
        warnings.push(AiContextWarning {
            code: AiContextWarningCode::ContextTruncated,
            message: format!(
                "AI context content was truncated to {} bytes.",
                limits.max_context_bytes
            ),
            item_id: None,
            relative_path: None,
        });
    }

    AiContextSnapshot {
        workspace_id: draft.workspace_id,
        scope: draft.scope,
        display_label: draft.display_label,
        document_id: draft.document_id,
        document_path: draft.document_path,
        document_revision: draft.document_revision,
        document_content_hash: draft.document_content_hash,
        selected_node_ids: draft.selected_node_ids,
        items,
        byte_estimate,
        token_estimate: estimate_tokens(byte_estimate),
        truncated,
        warnings,
    }
}

fn truncate_to_byte_limit(value: &str, max_bytes: usize) -> String {
    if value.as_bytes().len() <= max_bytes {
        return value.to_owned();
    }

    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn estimate_tokens(byte_count: usize) -> usize {
    byte_count.saturating_add(3) / 4
}

fn document_revision(document: &AiMindMapDocument, content_revision: Option<u64>) -> String {
    match content_revision {
        Some(content_revision) => {
            format!("mindmap:{}:content:{}", document.version, content_revision)
        }
        None => format!("mindmap:{}", document.version),
    }
}

fn document_content_hash(
    document: &AiMindMapDocument,
    content_revision: Option<u64>,
) -> Result<String, WorkspaceError> {
    let mut hasher = Sha256::new();
    let bytes = serde_json::to_vec(document).map_err(|error| {
        invalid_context_request(format!("Mind map document could not be hashed: {error}"))
    })?;
    hasher.update(bytes);
    if let Some(content_revision) = content_revision {
        hasher.update(content_revision.to_le_bytes());
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn workspace_content_hash(files: &[crate::models::WorkspaceFile]) -> String {
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.relative_path.as_bytes());
        hasher.update([0]);
        hasher.update(file.version.token.as_bytes());
        hasher.update([0]);
    }

    format!("{:x}", hasher.finalize())
}

fn normalize_line_endings(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn compact_label(value: &str) -> String {
    let text = display_text(value);
    let mut chars = text.chars();
    let compact = chars.by_ref().take(48).collect::<String>();
    if chars.next().is_some() {
        format!("{compact}...")
    } else {
        compact
    }
}

fn display_text(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "(untitled)".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn invalid_context_request(message: impl Into<String>) -> WorkspaceError {
    WorkspaceError::new(
        WorkspaceErrorCode::InvalidAiContextRequest,
        WorkspaceOperation::BuildAiContext,
        message,
        true,
    )
}

fn default_max_context_bytes() -> usize {
    DEFAULT_MAX_CONTEXT_BYTES
}

fn default_max_files() -> usize {
    DEFAULT_MAX_FILES
}

fn default_max_open_files() -> usize {
    DEFAULT_MAX_OPEN_FILES
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::validate_workspace_root;
    use std::fs;
    use std::path::Path;

    fn record(root: &Path) -> WorkspaceRecord {
        validate_workspace_root(root, WorkspaceOperation::SelectWorkspace).unwrap()
    }

    fn node(id: &str, text: &str, parent_id: Option<&str>, child_ids: &[&str]) -> AiMindMapNode {
        AiMindMapNode {
            id: id.to_owned(),
            text: text.to_owned(),
            parent_id: parent_id.map(str::to_owned),
            child_ids: child_ids
                .iter()
                .map(|child_id| (*child_id).to_owned())
                .collect(),
            collapsed: false,
            created_at: "2026-05-10T00:00:00Z".to_owned(),
            updated_at: "2026-05-10T00:00:00Z".to_owned(),
        }
    }

    fn document() -> AiMindMapDocument {
        let nodes = BTreeMap::from([
            (
                "root".to_owned(),
                node("root", "Root", None, &["alpha", "beta"]),
            ),
            (
                "alpha".to_owned(),
                node("alpha", "Alpha", Some("root"), &["alpha-child"]),
            ),
            (
                "alpha-child".to_owned(),
                node("alpha-child", "Alpha child", Some("alpha"), &[]),
            ),
            ("beta".to_owned(), node("beta", "Beta", Some("root"), &[])),
        ]);

        AiMindMapDocument {
            id: "doc-1".to_owned(),
            title: "Fixture map".to_owned(),
            source_path: Some("notes/root.md".to_owned()),
            root_node_id: "root".to_owned(),
            version: 7,
            nodes,
            created_at: "2026-05-10T00:00:00Z".to_owned(),
            updated_at: "2026-05-10T00:00:00Z".to_owned(),
        }
    }

    fn request(workspace_id: &str, document: AiMindMapDocument) -> AiContextSnapshotRequest {
        AiContextSnapshotRequest {
            workspace_id: workspace_id.to_owned(),
            scope: None,
            document: Some(document),
            selected_node_id: Some("alpha".to_owned()),
            current_file: None,
            open_files: Vec::new(),
            content_revision: Some(42),
            limits: AiContextLimits::default(),
        }
    }

    #[test]
    fn default_scope_prefers_selected_node_over_current_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("notes")).unwrap();
        fs::write(temp.path().join("notes/root.md"), "# Root").unwrap();
        let record = record(temp.path());
        let mut input = request(&record.info.id, document());
        input.current_file = Some("notes/root.md".to_owned());

        let snapshot = build_context_snapshot(&record, input).unwrap();

        assert_eq!(snapshot.scope, AiContextScope::SelectedNode);
        assert_eq!(snapshot.selected_node_ids, vec!["alpha"]);
        assert_eq!(
            snapshot.document_revision,
            Some("mindmap:7:content:42".to_owned())
        );
    }

    #[test]
    fn serializes_selected_branch_in_canonical_child_order() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let mut input = request(&record.info.id, document());
        input.scope = Some(AiContextScope::SelectedBranch);

        let snapshot = build_context_snapshot(&record, input).unwrap();

        assert_eq!(snapshot.scope, AiContextScope::SelectedBranch);
        assert_eq!(snapshot.selected_node_ids, vec!["alpha", "alpha-child"]);
        assert!(snapshot.items[0].content.contains("- Alpha (alpha)"));
        assert!(snapshot.items[0]
            .content
            .contains("  - Alpha child (alpha-child)"));
        assert!(!snapshot.items[0].content.contains("Beta"));
    }

    #[test]
    fn current_file_context_uses_markdown_hierarchy_and_preserves_links() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("notes.md"),
            "# Root\n\nSee [Architecture](./architecture.md).\n\n## Details\n",
        )
        .unwrap();
        let record = record(temp.path());
        let input = AiContextSnapshotRequest {
            workspace_id: record.info.id.clone(),
            scope: Some(AiContextScope::CurrentFile),
            document: None,
            selected_node_id: None,
            current_file: Some("notes.md".to_owned()),
            open_files: Vec::new(),
            content_revision: None,
            limits: AiContextLimits::default(),
        };

        let snapshot = build_context_snapshot(&record, input).unwrap();

        assert_eq!(snapshot.scope, AiContextScope::CurrentFile);
        assert_eq!(snapshot.document_path, Some("notes.md".to_owned()));
        assert!(snapshot.items[0].content.contains("Hierarchy:"));
        assert!(snapshot.items[0].content.contains("Root"));
        assert!(snapshot.items[0]
            .content
            .contains("[Architecture](./architecture.md)"));
        assert!(snapshot.document_content_hash.unwrap().len() == 64);
    }

    #[test]
    fn rejects_current_file_path_escape() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let input = AiContextSnapshotRequest {
            workspace_id: record.info.id.clone(),
            scope: Some(AiContextScope::CurrentFile),
            document: None,
            selected_node_id: None,
            current_file: Some("../secret.md".to_owned()),
            open_files: Vec::new(),
            content_revision: None,
            limits: AiContextLimits::default(),
        };

        let error = build_context_snapshot(&record, input).unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::InvalidRelativePath);
    }

    #[test]
    fn workspace_summary_is_bounded_and_reports_exclusions() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(temp.path().join("target")).unwrap();
        fs::write(temp.path().join("notes.md"), "# Notes").unwrap();
        fs::write(
            temp.path().join("node_modules/pkg/readme.md"),
            "# Dependency",
        )
        .unwrap();
        fs::write(temp.path().join("target/generated.md"), "# Build").unwrap();
        fs::write(temp.path().join("notes.txt"), "not markdown").unwrap();
        let record = record(temp.path());
        let input = AiContextSnapshotRequest {
            workspace_id: record.info.id.clone(),
            scope: Some(AiContextScope::WorkspaceSummary),
            document: None,
            selected_node_id: None,
            current_file: None,
            open_files: Vec::new(),
            content_revision: None,
            limits: AiContextLimits {
                max_files: 1,
                ..AiContextLimits::default()
            },
        };

        let snapshot = build_context_snapshot(&record, input).unwrap();

        assert_eq!(snapshot.scope, AiContextScope::WorkspaceSummary);
        assert!(snapshot.items[0].content.contains("notes.md"));
        assert!(!snapshot.items[0].content.contains("node_modules"));
        assert!(!snapshot.items[0].content.contains("notes.txt"));
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.code == AiContextWarningCode::IgnoredPathsExcluded));
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.code == AiContextWarningCode::UnsupportedFilesExcluded));
    }

    #[test]
    fn truncates_context_deterministically_with_visible_warning() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let mut input = request(&record.info.id, document());
        input.scope = Some(AiContextScope::SelectedBranch);
        input.limits.max_context_bytes = 32;

        let snapshot = build_context_snapshot(&record, input).unwrap();

        assert!(snapshot.truncated);
        assert!(snapshot.byte_estimate <= 32);
        assert!(snapshot.items[0].content.as_bytes().len() <= 32);
        assert!(snapshot
            .warnings
            .iter()
            .any(|warning| warning.code == AiContextWarningCode::ContextTruncated));
    }

    #[test]
    fn branch_context_generation_does_not_mutate_document() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let document = document();
        let original = document.clone();
        let mut input = request(&record.info.id, document);
        input.scope = Some(AiContextScope::SelectedBranch);

        let snapshot = build_context_snapshot(&record, input.clone()).unwrap();

        assert_eq!(snapshot.selected_node_ids, vec!["alpha", "alpha-child"]);
        assert_eq!(input.document.unwrap(), original);
    }
}
