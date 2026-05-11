use crate::ai::context::{
    build_context_snapshot, AiContextLimits, AiContextScope, AiContextSnapshot,
    AiContextSnapshotRequest, AiMindMapDocument,
};
use crate::ai::providers::{AiProviderConfig, AiProviderSettings};
use crate::ai::session::AiConversationLimits;
use crate::documents;
use crate::errors::WorkspaceError;
use crate::file_index::index_markdown_files;
use crate::models::{FileVersion, WorkspaceRecord, WorkspaceRelativePath};
use how_to_think_markdown::{parse_markdown_to_mindmap, MindMapDocument, ParseMode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const LARGE_NODE_CHANGE_THRESHOLD: usize = 20;
const LARGE_FILE_CHANGE_THRESHOLD: usize = 5;
const LARGE_DELETION_THRESHOLD: usize = 10;

#[derive(Debug, Clone, PartialEq)]
pub struct AiProviderHealthCliRequest {
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiContextPreviewCliRequest {
    pub workspace_path: Option<PathBuf>,
    pub scope: Option<AiContextScope>,
    pub current_file: Option<WorkspaceRelativePath>,
    pub open_files: Vec<WorkspaceRelativePath>,
    pub selected_node_id: Option<String>,
    pub document: Option<AiMindMapDocument>,
    pub content_revision: Option<u64>,
    pub limits: AiContextLimits,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiChatCliRequest {
    pub workspace_path: Option<PathBuf>,
    pub provider_id: Option<String>,
    pub session_id: Option<String>,
    pub prompt: String,
    pub context: Option<AiContextSnapshot>,
    pub context_request: AiContextPreviewCliRequest,
    pub limits: AiConversationLimits,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiProposalValidateCliRequest {
    pub workspace_path: Option<PathBuf>,
    pub proposal: Value,
    pub base_document_version: Option<u64>,
    pub active_file_path: Option<WorkspaceRelativePath>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiProposalApplyCliRequest {
    pub workspace_path: Option<PathBuf>,
    pub proposal: Value,
    pub base_document_version: Option<u64>,
    pub active_file_path: Option<WorkspaceRelativePath>,
    pub confirmation_token: Option<String>,
    pub non_interactive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderListResult {
    pub active_provider_id: Option<String>,
    pub providers: Vec<AiProviderCliSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderCliSummary {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub enabled: bool,
    pub has_health_check: bool,
    pub last_health_status: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderHealthCliResult {
    pub provider_id: String,
    pub status: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiProposalValidateCliResult {
    pub validation: ProposalValidationEnvelope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal: Option<Value>,
    pub affected_files: Vec<ProposalAffectedFileSummary>,
    pub risk_flags: Vec<String>,
    pub impact_summary: ProposalImpactSummary,
    pub base_document_version: u64,
    pub active_file_path: WorkspaceRelativePath,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposalValidationEnvelope {
    pub ok: bool,
    pub errors: Vec<ProposalValidationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProposalValidationError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<WorkspaceRelativePath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProposalAffectedFileSummary {
    pub path: WorkspaceRelativePath,
    pub change_kind: String,
    pub base_version_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version_token: Option<String>,
    pub known: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProposalImpactSummary {
    pub changed_node_ids: Vec<String>,
    pub added_node_ids: Vec<String>,
    pub deleted_node_ids: Vec<String>,
    pub moved_branch_root_ids: Vec<String>,
    pub affected_link_ids: Vec<String>,
    pub affected_file_paths: Vec<WorkspaceRelativePath>,
    pub counts: ProposalImpactCounts,
    pub includes_deletions: bool,
    pub includes_branch_moves: bool,
    pub includes_link_changes: bool,
    pub includes_multi_file_change: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProposalImpactCounts {
    pub changed_nodes: usize,
    pub added_nodes: usize,
    pub deleted_nodes: usize,
    pub moved_branches: usize,
    pub affected_links: usize,
    pub affected_files: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiProposalValidationOutcome {
    pub result: AiProposalValidateCliResult,
    pub proposal_id: String,
    pub affected_paths: Vec<WorkspaceRelativePath>,
    pub expected_versions: Vec<(WorkspaceRelativePath, FileVersion)>,
    pub requires_multi_file_confirmation: bool,
    pub risks: Vec<String>,
}

#[derive(Debug, Clone)]
struct KnownProposalFile {
    path: WorkspaceRelativePath,
    version: FileVersion,
    document: Option<ProposalDocumentSnapshot>,
}

#[derive(Debug, Clone)]
struct ProposalDocumentSnapshot {
    root_node_id: String,
    nodes: BTreeMap<String, ProposalNodeSnapshot>,
}

#[derive(Debug, Clone)]
struct ProposalNodeSnapshot {
    child_ids: Vec<String>,
}

pub fn provider_list_result(settings: AiProviderSettings) -> AiProviderListResult {
    AiProviderListResult {
        active_provider_id: settings.active_provider_id,
        providers: settings
            .providers
            .into_iter()
            .map(|provider| AiProviderCliSummary {
                id: provider.id,
                display_name: provider.display_name,
                kind: serde_json::to_value(provider.kind)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_owned))
                    .unwrap_or_else(|| format!("{:?}", provider.kind)),
                enabled: provider.enabled,
                has_health_check: !provider.health_check_args.is_empty(),
                last_health_status: provider
                    .last_health_status
                    .and_then(|status| serde_json::to_value(status).ok()),
            })
            .collect(),
    }
}

pub fn resolve_provider_for_cli(
    settings: &AiProviderSettings,
    requested_provider_id: Option<&str>,
) -> Result<AiProviderConfig, String> {
    let provider_id = requested_provider_id
        .and_then(non_empty)
        .or(settings.active_provider_id.as_deref())
        .ok_or_else(|| "No active AI provider is configured.".to_owned())?;

    let provider = settings
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .cloned()
        .ok_or_else(|| "The requested AI provider is not configured.".to_owned())?;

    if !provider.enabled {
        return Err("The selected AI provider is disabled.".to_owned());
    }

    Ok(provider)
}

pub fn build_context_for_cli(
    record: &WorkspaceRecord,
    request: AiContextPreviewCliRequest,
) -> Result<AiContextSnapshot, WorkspaceError> {
    build_context_snapshot(
        record,
        AiContextSnapshotRequest {
            workspace_id: record.info.id.clone(),
            scope: request.scope,
            document: request.document,
            selected_node_id: request.selected_node_id,
            current_file: request.current_file,
            open_files: request.open_files,
            content_revision: request.content_revision,
            limits: request.limits,
        },
    )
}

pub fn validate_proposal_for_cli(
    record: &WorkspaceRecord,
    request: AiProposalValidateCliRequest,
) -> Result<AiProposalValidationOutcome, WorkspaceError> {
    let base_document_version = request
        .base_document_version
        .or_else(|| {
            request
                .proposal
                .get("baseDocumentVersion")
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let active_file_path = request
        .active_file_path
        .or_else(|| first_scope_path(&request.proposal))
        .or_else(|| first_affected_file_path(&request.proposal))
        .unwrap_or_default();
    let known_files = known_files_for_proposal(record, &request.proposal, base_document_version)?;
    let validation = validate_proposal_value(
        &request.proposal,
        base_document_version,
        &active_file_path,
        &known_files,
    );
    let impact_summary = calculate_impact_summary(&request.proposal, &known_files);
    let risk_flags = detect_risk_flags(&impact_summary, &request.proposal);
    let affected_files = affected_file_summaries(&request.proposal, &known_files);
    let affected_paths = affected_files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let expected_versions = expected_versions(&request.proposal, &known_files);
    let requires_multi_file_confirmation = is_multi_file_scope(&request.proposal)
        || affected_paths.len() > 1
        || risk_flags.iter().any(|risk| risk == "multi_file_change");
    let risks = proposal_risks(&risk_flags, &affected_files);
    let proposal_id = request
        .proposal
        .get("proposalId")
        .and_then(Value::as_str)
        .unwrap_or("proposal")
        .to_owned();
    let proposal = validation
        .ok
        .then(|| enriched_proposal(request.proposal.clone(), &risk_flags, &impact_summary));

    Ok(AiProposalValidationOutcome {
        result: AiProposalValidateCliResult {
            validation,
            proposal,
            affected_files,
            risk_flags,
            impact_summary,
            base_document_version,
            active_file_path,
        },
        proposal_id,
        affected_paths,
        expected_versions,
        requires_multi_file_confirmation,
        risks,
    })
}

fn validate_proposal_value(
    proposal: &Value,
    base_document_version: u64,
    active_file_path: &str,
    known_files: &[KnownProposalFile],
) -> ProposalValidationEnvelope {
    let mut errors = Vec::new();
    let known_by_path = known_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let affected_change_kinds = affected_change_kinds(proposal);
    let affected_paths = affected_change_kinds
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let target_scope_paths = validate_target_scope(
        proposal.get("targetScope"),
        active_file_path,
        &known_by_path,
        &affected_change_kinds,
        &mut errors,
    );

    validate_envelope(proposal, base_document_version, &mut errors);
    validate_affected_files(proposal.get("affectedFiles"), &known_by_path, &mut errors);
    validate_operations(
        proposal.get("operations"),
        &target_scope_paths,
        &affected_paths,
        &known_by_path,
        &mut errors,
    );

    ProposalValidationEnvelope {
        ok: errors.is_empty(),
        errors,
    }
}

fn validate_envelope(
    proposal: &Value,
    base_document_version: u64,
    errors: &mut Vec<ProposalValidationError>,
) {
    if !non_empty_value(proposal.get("proposalId")) {
        errors.push(error(
            "missing_proposal_id",
            "A proposal id is required.",
            Some("proposalId"),
        ));
    }
    if !non_empty_value(proposal.get("sourceConversationId")) {
        errors.push(error(
            "missing_source_conversation_id",
            "A source conversation id is required.",
            Some("sourceConversationId"),
        ));
    }
    if !non_empty_value(proposal.get("createdAt")) {
        errors.push(error(
            "missing_created_at",
            "A proposal creation timestamp is required.",
            Some("createdAt"),
        ));
    }

    let proposal_version = proposal
        .get("baseDocumentVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if proposal_version == 0 {
        errors.push(error(
            "missing_base_document_version",
            "A positive base document version is required.",
            Some("baseDocumentVersion"),
        ));
    } else if base_document_version > 0 && proposal_version != base_document_version {
        let mut details = BTreeMap::new();
        details.insert("expected".to_owned(), json!(base_document_version));
        details.insert("received".to_owned(), json!(proposal_version));
        errors.push(error_with_details(
            "unresolved_base_document_version",
            "Proposal base document version does not match the current context baseline.",
            Some("baseDocumentVersion"),
            details,
        ));
    }
}

fn validate_affected_files(
    affected_files: Option<&Value>,
    known_by_path: &BTreeMap<&str, &KnownProposalFile>,
    errors: &mut Vec<ProposalValidationError>,
) {
    let Some(files) = affected_files.and_then(Value::as_array) else {
        errors.push(error(
            "missing_affected_file",
            "At least one affected file is required.",
            Some("affectedFiles"),
        ));
        return;
    };
    if files.is_empty() {
        errors.push(error(
            "missing_affected_file",
            "At least one affected file is required.",
            Some("affectedFiles"),
        ));
        return;
    }

    for (index, file) in files.iter().enumerate() {
        let field = format!("affectedFiles.{index}");
        let path = file.get("path").and_then(Value::as_str).unwrap_or_default();
        let Ok(path) = validate_proposal_path(path) else {
            let (code, message) = proposal_path_error(path);
            errors.push(error_with_file(
                code,
                message,
                Some(format!("{field}.path")),
                Some(path.to_owned()),
            ));
            continue;
        };
        let change_kind = file
            .get("changeKind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(change_kind, "modify" | "create" | "delete" | "rename") {
            errors.push(error_with_file(
                "malformed_operation",
                "Affected file changeKind must be modify, create, delete, or rename.",
                Some(format!("{field}.changeKind")),
                Some(path.clone()),
            ));
        }
        let known_file = known_by_path.get(path.as_str()).copied();
        if change_kind == "create" && known_file.is_some() {
            errors.push(error_with_file(
                "file_already_exists",
                "Created files must not already exist in the selected workspace file index.",
                Some(format!("{field}.path")),
                Some(path.clone()),
            ));
        } else if change_kind != "create" && known_file.is_none() {
            errors.push(error_with_file(
                "unknown_file_path",
                "Affected file is not part of the selected workspace file index.",
                Some(format!("{field}.path")),
                Some(path.clone()),
            ));
        }

        let token = file
            .get("baseFileVersion")
            .and_then(|version| version.get("token"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if token.trim().is_empty() {
            errors.push(error_with_file(
                "missing_affected_file_anchor",
                "Every affected file must include a backend-controlled base file version.",
                Some(format!("{field}.baseFileVersion")),
                Some(path.clone()),
            ));
        } else if let Some(known_file) = known_file {
            if change_kind != "create" && token != known_file.version.token {
                errors.push(error_with_file(
                    "unresolved_base_file_version",
                    "Affected file version does not match the current workspace baseline.",
                    Some(format!("{field}.baseFileVersion")),
                    Some(path.clone()),
                ));
            }
        }

        if let Some(serialization) = file.get("markdownSerialization") {
            let status = serialization
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let missing_markdown =
                status == "valid" && !serialization.get("markdown").is_some_and(Value::is_string);
            if status == "invalid" || missing_markdown {
                errors.push(error_with_file(
                    "invalid_markdown_serialization",
                    "Markdown serialization output must be valid before a proposal can be reviewed.",
                    Some(format!("{field}.markdownSerialization")),
                    Some(path),
                ));
            }
        }
    }
}

fn validate_target_scope(
    scope: Option<&Value>,
    active_file_path: &str,
    known_by_path: &BTreeMap<&str, &KnownProposalFile>,
    affected_change_kinds: &BTreeMap<WorkspaceRelativePath, String>,
    errors: &mut Vec<ProposalValidationError>,
) -> BTreeSet<WorkspaceRelativePath> {
    let mut paths = BTreeSet::new();
    let Some(scope) = scope else {
        errors.push(error(
            "missing_target_scope",
            "A target scope is required.",
            Some("targetScope"),
        ));
        return paths;
    };
    let scope_type = scope
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match scope_type {
        "workspace" => {
            errors.push(error(
                "workspace_scope_forbidden",
                "Workspace-wide AI proposals are not supported by this contract.",
                Some("targetScope.type"),
            ));
        }
        "node" | "branch" | "current-file" => {
            let path = scope
                .get("filePath")
                .and_then(Value::as_str)
                .unwrap_or(active_file_path);
            if let Ok(path) = validate_proposal_path(path) {
                validate_scoped_file(
                    &path,
                    "targetScope.filePath",
                    known_by_path,
                    affected_change_kinds,
                    errors,
                );
                paths.insert(path.clone());
                if scope_type == "node" {
                    validate_node_exists(
                        &path,
                        scope.get("nodeId").and_then(Value::as_str),
                        "targetScope.nodeId",
                        known_by_path,
                        errors,
                    );
                } else if scope_type == "branch" {
                    validate_node_exists(
                        &path,
                        scope.get("rootNodeId").and_then(Value::as_str),
                        "targetScope.rootNodeId",
                        known_by_path,
                        errors,
                    );
                }
            } else {
                let (code, message) = proposal_path_error(path);
                errors.push(error_with_file(
                    code,
                    message,
                    Some("targetScope.filePath".to_owned()),
                    Some(path.to_owned()),
                ));
            }
        }
        "multi-file" => {
            let Some(file_paths) = scope.get("filePaths").and_then(Value::as_array) else {
                errors.push(error(
                    "missing_multi_file_metadata",
                    "Multi-file proposals must list every target file.",
                    Some("targetScope.filePaths"),
                ));
                return paths;
            };
            for (index, path) in file_paths.iter().enumerate() {
                let field = format!("targetScope.filePaths.{index}");
                let path = path.as_str().unwrap_or_default();
                if let Ok(path) = validate_proposal_path(path) {
                    validate_scoped_file(
                        &path,
                        &field,
                        known_by_path,
                        affected_change_kinds,
                        errors,
                    );
                    paths.insert(path);
                } else {
                    let (code, message) = proposal_path_error(path);
                    errors.push(error_with_file(
                        code,
                        message,
                        Some(field),
                        Some(path.to_owned()),
                    ));
                }
            }
        }
        _ => errors.push(error_with_details(
            "unsupported_target_scope",
            "Target scope type is not supported by the AI proposal contract.",
            Some("targetScope.type"),
            [("received".to_owned(), json!(scope_type))]
                .into_iter()
                .collect(),
        )),
    }
    paths
}

fn validate_operations(
    operations: Option<&Value>,
    target_scope_paths: &BTreeSet<WorkspaceRelativePath>,
    affected_paths: &BTreeSet<WorkspaceRelativePath>,
    known_by_path: &BTreeMap<&str, &KnownProposalFile>,
    errors: &mut Vec<ProposalValidationError>,
) {
    let Some(operations) = operations.and_then(Value::as_array) else {
        errors.push(error(
            "empty_operations",
            "AI proposal must include at least one operation.",
            Some("operations"),
        ));
        return;
    };
    if operations.is_empty() {
        errors.push(error(
            "empty_operations",
            "AI proposal must include at least one operation.",
            Some("operations"),
        ));
        return;
    }

    let mut operation_ids = BTreeSet::new();
    for (index, operation) in operations.iter().enumerate() {
        let field = format!("operations.{index}");
        let operation_type = operation
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let operation_id = operation
            .get("operationId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(
            operation_type,
            "add-node"
                | "update-node"
                | "delete-node"
                | "move-branch"
                | "reorder-children"
                | "add-link"
                | "update-link"
                | "delete-link"
        ) {
            errors.push(operation_error(
                "unknown_operation_type",
                "Operation type is not supported by the AI proposal contract.",
                &field,
                operation_id,
                None,
                None,
            ));
            continue;
        }
        if operation_id.trim().is_empty() {
            errors.push(operation_error(
                "malformed_operation",
                "Operation id is required.",
                &format!("{field}.operationId"),
                "",
                None,
                None,
            ));
        } else if !operation_ids.insert(operation_id.to_owned()) {
            errors.push(operation_error(
                "duplicate_operation_id",
                "Operation ids must be unique within a proposal.",
                &format!("{field}.operationId"),
                operation_id,
                None,
                None,
            ));
        }

        let target_file_path = operation
            .get("targetFilePath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Ok(target_file_path) = validate_proposal_path(target_file_path) else {
            let (code, message) = proposal_path_error(target_file_path);
            errors.push(operation_error(
                code,
                message,
                &format!("{field}.targetFilePath"),
                operation_id,
                Some(target_file_path),
                None,
            ));
            continue;
        };
        if !affected_paths.contains(&target_file_path) {
            errors.push(operation_error(
                "missing_affected_file_anchor",
                "Every operation target file must be listed in affectedFiles with a file version anchor.",
                &format!("{field}.targetFilePath"),
                operation_id,
                Some(&target_file_path),
                None,
            ));
        }
        if !target_scope_paths.is_empty() && !target_scope_paths.contains(&target_file_path) {
            errors.push(operation_error(
                "operation_outside_target_scope",
                "Operation targets a file outside the proposal target scope.",
                &format!("{field}.targetFilePath"),
                operation_id,
                Some(&target_file_path),
                None,
            ));
        }
        validate_operation_shape(
            operation,
            &field,
            operation_type,
            operation_id,
            &target_file_path,
            known_by_path,
            errors,
        );
    }
}

fn validate_operation_shape(
    operation: &Value,
    field: &str,
    operation_type: &str,
    operation_id: &str,
    target_file_path: &str,
    known_by_path: &BTreeMap<&str, &KnownProposalFile>,
    errors: &mut Vec<ProposalValidationError>,
) {
    match operation_type {
        "add-node" => {
            let node_id = operation.get("nodeId").and_then(Value::as_str);
            let parent_id = operation.get("parentNodeId").and_then(Value::as_str);
            require_string(
                node_id,
                field,
                "nodeId",
                operation_id,
                target_file_path,
                errors,
            );
            require_string(
                parent_id,
                field,
                "parentNodeId",
                operation_id,
                target_file_path,
                errors,
            );
            if !operation.get("text").is_some_and(Value::is_string) {
                errors.push(operation_error(
                    "malformed_operation",
                    "Added node text must be a string.",
                    &format!("{field}.text"),
                    operation_id,
                    Some(target_file_path),
                    None,
                ));
            }
            if let Some(index) = operation.get("index") {
                if !index.as_u64().is_some() {
                    errors.push(operation_error(
                        "malformed_operation",
                        "Insert index must be a non-negative integer.",
                        &format!("{field}.index"),
                        operation_id,
                        Some(target_file_path),
                        None,
                    ));
                }
            }
            if let Some(parent_id) = parent_id {
                validate_node_exists(
                    target_file_path,
                    Some(parent_id),
                    &format!("{field}.parentNodeId"),
                    known_by_path,
                    errors,
                );
            }
            if let Some(node_id) = node_id {
                if document_for(known_by_path, target_file_path)
                    .is_some_and(|document| document.nodes.contains_key(node_id))
                {
                    errors.push(operation_error(
                        "duplicate_node_id",
                        "Added node id already exists in the target document.",
                        &format!("{field}.nodeId"),
                        operation_id,
                        Some(target_file_path),
                        Some(node_id),
                    ));
                }
            }
        }
        "update-node" | "delete-node" => {
            let node_id = operation.get("nodeId").and_then(Value::as_str);
            require_string(
                node_id,
                field,
                "nodeId",
                operation_id,
                target_file_path,
                errors,
            );
            validate_node_exists(
                target_file_path,
                node_id,
                &format!("{field}.nodeId"),
                known_by_path,
                errors,
            );
        }
        "move-branch" => {
            let node_id = operation.get("nodeId").and_then(Value::as_str);
            let new_parent_id = operation.get("newParentNodeId").and_then(Value::as_str);
            require_string(
                node_id,
                field,
                "nodeId",
                operation_id,
                target_file_path,
                errors,
            );
            require_string(
                new_parent_id,
                field,
                "newParentNodeId",
                operation_id,
                target_file_path,
                errors,
            );
            validate_node_exists(
                target_file_path,
                node_id,
                &format!("{field}.nodeId"),
                known_by_path,
                errors,
            );
            validate_node_exists(
                target_file_path,
                new_parent_id,
                &format!("{field}.newParentNodeId"),
                known_by_path,
                errors,
            );
            if let (Some(node_id), Some(new_parent_id), Some(document)) = (
                node_id,
                new_parent_id,
                document_for(known_by_path, target_file_path),
            ) {
                if node_id == document.root_node_id.as_str() {
                    errors.push(operation_error(
                        "root_operation_forbidden",
                        "The virtual root node cannot be moved.",
                        &format!("{field}.nodeId"),
                        operation_id,
                        Some(target_file_path),
                        Some(node_id),
                    ));
                } else if node_id == new_parent_id
                    || collect_subtree_node_ids(document, node_id)
                        .contains(&new_parent_id.to_owned())
                {
                    errors.push(operation_error(
                        "cannot_move_into_descendant",
                        "Cannot move a node into itself or one of its descendants.",
                        &format!("{field}.newParentNodeId"),
                        operation_id,
                        Some(target_file_path),
                        Some(new_parent_id),
                    ));
                }
            }
        }
        "reorder-children" => {
            let parent_id = operation.get("parentNodeId").and_then(Value::as_str);
            require_string(
                parent_id,
                field,
                "parentNodeId",
                operation_id,
                target_file_path,
                errors,
            );
            validate_node_exists(
                target_file_path,
                parent_id,
                &format!("{field}.parentNodeId"),
                known_by_path,
                errors,
            );
            let children = operation.get("childNodeIds").and_then(Value::as_array);
            if children.is_none() {
                errors.push(operation_error(
                    "malformed_operation",
                    "Child node order must be an array.",
                    &format!("{field}.childNodeIds"),
                    operation_id,
                    Some(target_file_path),
                    None,
                ));
            }
            if let (Some(parent_id), Some(children), Some(document)) = (
                parent_id,
                children,
                document_for(known_by_path, target_file_path),
            ) {
                let requested = children
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                if children.len() != requested.len()
                    || document
                        .nodes
                        .get(parent_id)
                        .is_some_and(|node| !has_same_members(&node.child_ids, &requested))
                {
                    errors.push(operation_error(
                        "invalid_sibling_order",
                        "Reorder operations must include the exact existing child ids.",
                        &format!("{field}.childNodeIds"),
                        operation_id,
                        Some(target_file_path),
                        Some(parent_id),
                    ));
                }
            }
        }
        "add-link" | "update-link" | "delete-link" => {
            require_string(
                operation.get("linkId").and_then(Value::as_str),
                field,
                "linkId",
                operation_id,
                target_file_path,
                errors,
            );
            let source_id = operation.get("sourceNodeId").and_then(Value::as_str);
            require_string(
                source_id,
                field,
                "sourceNodeId",
                operation_id,
                target_file_path,
                errors,
            );
            validate_node_exists(
                target_file_path,
                source_id,
                &format!("{field}.sourceNodeId"),
                known_by_path,
                errors,
            );
        }
        _ => {}
    }
}

fn known_files_for_proposal(
    record: &WorkspaceRecord,
    proposal: &Value,
    base_document_version: u64,
) -> Result<Vec<KnownProposalFile>, WorkspaceError> {
    let affected_paths = affected_change_kinds(proposal)
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)?;
    files
        .into_iter()
        .map(|file| {
            let document = if affected_paths.contains(&file.relative_path) {
                proposal_document_for_file(record, &file.relative_path, base_document_version)?
            } else {
                None
            };
            Ok(KnownProposalFile {
                path: file.relative_path,
                version: file.version,
                document,
            })
        })
        .collect()
}

fn proposal_document_for_file(
    record: &WorkspaceRecord,
    relative_path: &str,
    _base_document_version: u64,
) -> Result<Option<ProposalDocumentSnapshot>, WorkspaceError> {
    let snapshot = documents::open_document(record, relative_path)?;
    let parsed = parse_markdown_to_mindmap(
        &snapshot.content,
        Some(snapshot.relative_path.as_str()),
        ParseMode::Auto,
    );
    Ok(parsed.document.as_ref().map(proposal_document_snapshot))
}

fn proposal_document_snapshot(document: &MindMapDocument) -> ProposalDocumentSnapshot {
    let nodes = document
        .nodes
        .iter()
        .map(|(node_id, node)| {
            (
                node_id.clone(),
                ProposalNodeSnapshot {
                    child_ids: node.children.clone(),
                },
            )
        })
        .collect();
    ProposalDocumentSnapshot {
        root_node_id: document.root_node_id.clone(),
        nodes,
    }
}

fn calculate_impact_summary(
    proposal: &Value,
    known_files: &[KnownProposalFile],
) -> ProposalImpactSummary {
    let known_by_path = known_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let mut changed_node_ids = BTreeSet::new();
    let mut added_node_ids = BTreeSet::new();
    let mut deleted_node_ids = BTreeSet::new();
    let mut moved_branch_root_ids = BTreeSet::new();
    let mut affected_link_ids = BTreeSet::new();
    let mut affected_file_paths = BTreeSet::new();

    for operation in proposal
        .get("operations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let operation_type = operation
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let target_file_path = operation
            .get("targetFilePath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !target_file_path.is_empty() {
            affected_file_paths.insert(target_file_path.to_owned());
        }
        match operation_type {
            "add-node" => {
                insert_string(operation, "nodeId", &mut added_node_ids);
                insert_string(operation, "parentNodeId", &mut changed_node_ids);
            }
            "update-node" => insert_string(operation, "nodeId", &mut changed_node_ids),
            "delete-node" => {
                if let Some(node_id) = operation.get("nodeId").and_then(Value::as_str) {
                    if let Some(document) = document_for(&known_by_path, target_file_path) {
                        deleted_node_ids.extend(collect_subtree_node_ids(document, node_id));
                    } else {
                        deleted_node_ids.insert(node_id.to_owned());
                    }
                }
            }
            "move-branch" => {
                insert_string(operation, "nodeId", &mut moved_branch_root_ids);
                insert_string(operation, "nodeId", &mut changed_node_ids);
                insert_string(operation, "newParentNodeId", &mut changed_node_ids);
            }
            "reorder-children" => insert_string(operation, "parentNodeId", &mut changed_node_ids),
            "add-link" | "update-link" | "delete-link" => {
                insert_string(operation, "linkId", &mut affected_link_ids);
                insert_string(operation, "sourceNodeId", &mut changed_node_ids);
            }
            _ => {}
        }
    }

    let counts = ProposalImpactCounts {
        changed_nodes: changed_node_ids.len(),
        added_nodes: added_node_ids.len(),
        deleted_nodes: deleted_node_ids.len(),
        moved_branches: moved_branch_root_ids.len(),
        affected_links: affected_link_ids.len(),
        affected_files: affected_file_paths.len(),
    };

    ProposalImpactSummary {
        changed_node_ids: changed_node_ids.into_iter().collect(),
        added_node_ids: added_node_ids.into_iter().collect(),
        deleted_node_ids: deleted_node_ids.into_iter().collect(),
        moved_branch_root_ids: moved_branch_root_ids.into_iter().collect(),
        affected_link_ids: affected_link_ids.into_iter().collect(),
        affected_file_paths: affected_file_paths.into_iter().collect(),
        includes_deletions: counts.deleted_nodes > 0,
        includes_branch_moves: counts.moved_branches > 0,
        includes_link_changes: counts.affected_links > 0,
        includes_multi_file_change: counts.affected_files > 1,
        counts,
    }
}

fn detect_risk_flags(impact: &ProposalImpactSummary, proposal: &Value) -> Vec<String> {
    let mut flags = BTreeSet::new();
    let changed_node_count =
        impact.counts.changed_nodes + impact.counts.added_nodes + impact.counts.deleted_nodes;

    if impact.includes_deletions {
        flags.insert("node_deletion".to_owned());
    }
    if impact.includes_branch_moves {
        flags.insert("branch_move".to_owned());
    }
    if impact.includes_link_changes {
        flags.insert("link_change".to_owned());
    }
    if impact.includes_multi_file_change {
        flags.insert("multi_file_change".to_owned());
    }
    if affected_files(proposal).any(|file| field(file, "changeKind") == Some("create")) {
        flags.insert("file_creation".to_owned());
    }
    if affected_files(proposal).any(|file| field(file, "changeKind") == Some("delete")) {
        flags.insert("file_deletion".to_owned());
    }
    if detect_cross_file_move(proposal) {
        flags.insert("cross_file_move".to_owned());
    }
    if operations(proposal).any(is_link_target_change_operation) {
        flags.insert("link_target_change".to_owned());
    }
    if changed_node_count >= LARGE_NODE_CHANGE_THRESHOLD
        || impact.counts.affected_files >= LARGE_FILE_CHANGE_THRESHOLD
    {
        flags.insert("large_change".to_owned());
    }
    if impact.counts.deleted_nodes >= LARGE_DELETION_THRESHOLD {
        flags.insert("large_deletion".to_owned());
    }
    if affected_files(proposal).any(|file| {
        file.get("markdownSerialization")
            .and_then(|serialization| serialization.get("diagnostics"))
            .and_then(Value::as_array)
            .is_some_and(|diagnostics| !diagnostics.is_empty())
    }) {
        flags.insert("markdown_serialization_warning".to_owned());
    }

    flags.into_iter().collect()
}

fn affected_file_summaries(
    proposal: &Value,
    known_files: &[KnownProposalFile],
) -> Vec<ProposalAffectedFileSummary> {
    let known_by_path = known_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    affected_files(proposal)
        .map(|file| {
            let path = field(file, "path").unwrap_or_default().to_owned();
            let known = known_by_path.get(path.as_str()).copied();
            ProposalAffectedFileSummary {
                path,
                change_kind: field(file, "changeKind").unwrap_or_default().to_owned(),
                base_version_token: file
                    .get("baseFileVersion")
                    .and_then(|version| version.get("token"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                current_version_token: known.map(|file| file.version.token.clone()),
                known: known.is_some(),
            }
        })
        .collect()
}

fn expected_versions(
    proposal: &Value,
    known_files: &[KnownProposalFile],
) -> Vec<(WorkspaceRelativePath, FileVersion)> {
    let known_by_path = known_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    affected_files(proposal)
        .filter_map(|file| {
            let path = field(file, "path")?;
            if field(file, "changeKind") == Some("create") {
                return None;
            }
            known_by_path
                .get(path)
                .map(|known| (known.path.clone(), known.version.clone()))
        })
        .collect()
}

fn enriched_proposal(
    mut proposal: Value,
    risk_flags: &[String],
    impact_summary: &ProposalImpactSummary,
) -> Value {
    if let Some(object) = proposal.as_object_mut() {
        object.insert("riskFlags".to_owned(), json!(risk_flags));
        object.insert("validationStatus".to_owned(), json!("valid"));
        object.insert("validationErrors".to_owned(), json!([]));
        object.insert("impactSummary".to_owned(), json!(impact_summary));
        object.insert("reviewMode".to_owned(), json!("whole-proposal"));
    }
    proposal
}

fn proposal_risks(
    risk_flags: &[String],
    affected_files: &[ProposalAffectedFileSummary],
) -> Vec<String> {
    let mut risks = Vec::new();
    risks.push(
        "AI-generated changes will modify workspace content after desktop review.".to_owned(),
    );
    if affected_files.len() > 1 {
        risks.push(format!(
            "{} workspace files are included in this proposal.",
            affected_files.len()
        ));
    }
    for file in affected_files {
        match file.change_kind.as_str() {
            "create" => risks.push(format!("File `{}` may be created.", file.path)),
            "delete" => risks.push(format!("File `{}` may be deleted.", file.path)),
            "rename" => risks.push(format!("File `{}` may be moved or renamed.", file.path)),
            _ => {}
        }
    }
    for flag in risk_flags {
        if matches!(
            flag.as_str(),
            "large_deletion"
                | "cross_file_move"
                | "link_target_change"
                | "markdown_serialization_warning"
        ) {
            risks.push(format!("Proposal risk flag: {flag}."));
        }
    }
    risks
}

fn affected_change_kinds(proposal: &Value) -> BTreeMap<WorkspaceRelativePath, String> {
    affected_files(proposal)
        .filter_map(|file| {
            Some((
                field(file, "path")?.to_owned(),
                field(file, "changeKind").unwrap_or_default().to_owned(),
            ))
        })
        .collect()
}

fn validate_scoped_file(
    path: &str,
    field: &str,
    known_by_path: &BTreeMap<&str, &KnownProposalFile>,
    affected_change_kinds: &BTreeMap<WorkspaceRelativePath, String>,
    errors: &mut Vec<ProposalValidationError>,
) {
    let is_create = affected_change_kinds
        .get(path)
        .is_some_and(|kind| kind == "create");
    if !is_create && !known_by_path.contains_key(path) {
        errors.push(error_with_file(
            "unknown_file_path",
            "Scoped file is not part of the selected workspace file index.",
            Some(field.to_owned()),
            Some(path.to_owned()),
        ));
    }
}

fn validate_node_exists(
    path: &str,
    node_id: Option<&str>,
    field: &str,
    known_by_path: &BTreeMap<&str, &KnownProposalFile>,
    errors: &mut Vec<ProposalValidationError>,
) {
    let Some(node_id) = node_id.filter(|node_id| !node_id.trim().is_empty()) else {
        errors.push(error_with_node(
            "unknown_node_id",
            "A target node id is required.",
            Some(field.to_owned()),
            Some(path.to_owned()),
            None,
        ));
        return;
    };
    if let Some(document) = document_for(known_by_path, path) {
        if !document.nodes.contains_key(node_id) {
            errors.push(error_with_node(
                "unknown_node_id",
                "Target node is not present in the document baseline.",
                Some(field.to_owned()),
                Some(path.to_owned()),
                Some(node_id.to_owned()),
            ));
        }
    }
}

fn document_for<'a>(
    known_by_path: &'a BTreeMap<&str, &KnownProposalFile>,
    path: &str,
) -> Option<&'a ProposalDocumentSnapshot> {
    known_by_path
        .get(path)
        .and_then(|file| file.document.as_ref())
}

fn collect_subtree_node_ids(document: &ProposalDocumentSnapshot, node_id: &str) -> Vec<String> {
    if !document.nodes.contains_key(node_id) {
        return vec![node_id.to_owned()];
    }
    let mut ids = Vec::new();
    let mut stack = vec![node_id.to_owned()];
    while let Some(current_id) = stack.pop() {
        ids.push(current_id.clone());
        if let Some(node) = document.nodes.get(&current_id) {
            for child_id in node.child_ids.iter().rev() {
                stack.push(child_id.clone());
            }
        }
    }
    ids
}

fn first_scope_path(proposal: &Value) -> Option<String> {
    let scope = proposal.get("targetScope")?;
    scope
        .get("filePath")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            scope
                .get("filePaths")
                .and_then(Value::as_array)
                .and_then(|paths| paths.first())
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
}

fn first_affected_file_path(proposal: &Value) -> Option<String> {
    affected_files(proposal).find_map(|file| field(file, "path").map(str::to_owned))
}

fn is_multi_file_scope(proposal: &Value) -> bool {
    proposal
        .get("targetScope")
        .and_then(|scope| scope.get("type"))
        .and_then(Value::as_str)
        == Some("multi-file")
}

fn detect_cross_file_move(proposal: &Value) -> bool {
    let file_paths = operations(proposal)
        .filter_map(|operation| field(operation, "targetFilePath"))
        .collect::<BTreeSet<_>>();
    if file_paths.len() < 2 {
        return false;
    }
    if operations(proposal).any(|operation| field(operation, "type") == Some("move-branch")) {
        return true;
    }
    let added_paths = operations(proposal)
        .filter(|operation| field(operation, "type") == Some("add-node"))
        .filter_map(|operation| field(operation, "targetFilePath"))
        .collect::<BTreeSet<_>>();
    let deleted_paths = operations(proposal)
        .filter(|operation| field(operation, "type") == Some("delete-node"))
        .filter_map(|operation| field(operation, "targetFilePath"))
        .collect::<BTreeSet<_>>();
    deleted_paths
        .iter()
        .any(|deleted| added_paths.iter().any(|added| added != deleted))
}

fn is_link_target_change_operation(operation: &Value) -> bool {
    matches!(field(operation, "type"), Some("add-link" | "update-link"))
        && operation.get("target").is_some()
}

fn affected_files(proposal: &Value) -> impl Iterator<Item = &Value> {
    proposal
        .get("affectedFiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn operations(proposal: &Value) -> impl Iterator<Item = &Value> {
    proposal
        .get("operations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn validate_proposal_path(path: &str) -> Result<String, ()> {
    if path.trim().is_empty()
        || path.contains('\\')
        || path.starts_with('/')
        || path.starts_with("//")
        || has_windows_drive_prefix(path)
        || path.chars().any(char::is_control)
    {
        return Err(());
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(());
    }
    let lower = path.to_ascii_lowercase();
    if !lower.ends_with(".md") && !lower.ends_with(".markdown") {
        return Err(());
    }
    Ok(path.to_owned())
}

fn proposal_path_error(path: &str) -> (&'static str, &'static str) {
    if path.trim().is_empty() || path.contains('\\') || path.chars().any(char::is_control) {
        (
            "invalid_file_path",
            "Workspace-relative Markdown path is required.",
        )
    } else if path.starts_with('/')
        || path.starts_with("//")
        || has_windows_drive_prefix(path)
        || path
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        (
            "out_of_workspace_file",
            "Workspace-relative path must not escape the workspace.",
        )
    } else {
        (
            "unsupported_file_type",
            "AI proposals can only target Markdown files.",
        )
    }
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn require_string(
    value: Option<&str>,
    field: &str,
    subfield: &str,
    operation_id: &str,
    target_file_path: &str,
    errors: &mut Vec<ProposalValidationError>,
) {
    if value.is_some_and(|value| !value.trim().is_empty()) {
        return;
    }
    errors.push(operation_error(
        "malformed_operation",
        "A non-empty string value is required.",
        &format!("{field}.{subfield}"),
        operation_id,
        Some(target_file_path),
        None,
    ));
}

fn has_same_members(left: &[String], right: &[String]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut counts = BTreeMap::new();
    for item in left {
        *counts.entry(item).or_insert(0usize) += 1;
    }
    for item in right {
        let Some(count) = counts.get_mut(item) else {
            return false;
        };
        *count = count.saturating_sub(1);
        if *count == 0 {
            counts.remove(item);
        }
    }
    counts.is_empty()
}

fn insert_string(value: &Value, key: &str, target: &mut BTreeSet<String>) {
    if let Some(value) = value.get(key).and_then(Value::as_str) {
        target.insert(value.to_owned());
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn non_empty_value(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

fn error(
    code: impl Into<String>,
    message: impl Into<String>,
    field: Option<&str>,
) -> ProposalValidationError {
    ProposalValidationError {
        code: code.into(),
        message: message.into(),
        field: field.map(str::to_owned),
        operation_id: None,
        file_path: None,
        node_id: None,
        details: None,
    }
}

fn error_with_details(
    code: impl Into<String>,
    message: impl Into<String>,
    field: Option<&str>,
    details: BTreeMap<String, Value>,
) -> ProposalValidationError {
    ProposalValidationError {
        code: code.into(),
        message: message.into(),
        field: field.map(str::to_owned),
        operation_id: None,
        file_path: None,
        node_id: None,
        details: Some(details),
    }
}

fn error_with_file(
    code: impl Into<String>,
    message: impl Into<String>,
    field: Option<String>,
    file_path: Option<String>,
) -> ProposalValidationError {
    ProposalValidationError {
        code: code.into(),
        message: message.into(),
        field,
        operation_id: None,
        file_path,
        node_id: None,
        details: None,
    }
}

fn error_with_node(
    code: impl Into<String>,
    message: impl Into<String>,
    field: Option<String>,
    file_path: Option<String>,
    node_id: Option<String>,
) -> ProposalValidationError {
    ProposalValidationError {
        code: code.into(),
        message: message.into(),
        field,
        operation_id: None,
        file_path,
        node_id,
        details: None,
    }
}

fn operation_error(
    code: impl Into<String>,
    message: impl Into<String>,
    field: &str,
    operation_id: &str,
    file_path: Option<&str>,
    node_id: Option<&str>,
) -> ProposalValidationError {
    ProposalValidationError {
        code: code.into(),
        message: message.into(),
        field: Some(field.to_owned()),
        operation_id: (!operation_id.is_empty()).then(|| operation_id.to_owned()),
        file_path: file_path.map(str::to_owned),
        node_id: node_id.map(str::to_owned),
        details: None,
    }
}
