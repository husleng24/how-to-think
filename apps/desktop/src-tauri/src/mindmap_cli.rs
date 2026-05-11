use crate::models::{FileVersion, SaveResult, WorkspaceInfo, WorkspaceRelativePath};
use how_to_think_markdown::{
    CompatibilityDiagnostic, LinkToken, ListMarker, MarkdownBlockKind, MarkdownOrigin,
    MindMapDocument, MindMapNode, MindMapNodeKind, ParseMode, SourceSpan,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub const DEFAULT_NODE_TEXT: &str = "New thought";
pub const LARGE_RESTRUCTURE_NODE_THRESHOLD: usize = 25;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MindMapSiblingPosition {
    Before,
    After,
}

impl Default for MindMapSiblingPosition {
    fn default() -> Self {
        Self::After
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindMapNodeSelector {
    pub node_id: Option<String>,
    pub node_path: Option<String>,
}

impl MindMapNodeSelector {
    pub fn new(node_id: Option<String>, node_path: Option<String>) -> Self {
        Self { node_id, node_path }
    }

    pub fn is_empty(&self) -> bool {
        self.node_id.is_none() && self.node_path.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindMapAddNodeRequest {
    pub parent: MindMapNodeSelector,
    pub sibling: MindMapNodeSelector,
    pub text: Option<String>,
    pub index: Option<usize>,
    pub position: MindMapSiblingPosition,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindMapUpdateNodeRequest {
    pub node: MindMapNodeSelector,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindMapMoveBranchRequest {
    pub node: MindMapNodeSelector,
    pub new_parent: MindMapNodeSelector,
    pub index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindMapDeleteBranchRequest {
    pub node: MindMapNodeSelector,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindMapReorderSiblingsRequest {
    pub parent: MindMapNodeSelector,
    pub child_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindMapTemplateRequest {
    pub relative_path: WorkspaceRelativePath,
    pub title: Option<String>,
    pub root_text: Option<String>,
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MindMapReadResult {
    pub workspace: WorkspaceInfo,
    pub relative_path: WorkspaceRelativePath,
    pub version: FileVersion,
    pub summary: MindMapDocumentSummary,
    pub nodes: Vec<MindMapNodeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_node: Option<MindMapNodeSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtree: Vec<MindMapNodeSummary>,
    pub document: MindMapDocument,
    pub diagnostics: Vec<CompatibilityDiagnostic>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<MindMapCliWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MindMapDocumentSummary {
    pub title: String,
    pub source_path: Option<String>,
    pub root_node_id: String,
    pub total_node_count: usize,
    pub content_node_count: usize,
    pub leaf_node_count: usize,
    pub max_depth: usize,
    pub unmapped_block_count: usize,
    pub diagnostic_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MindMapNodeSummary {
    pub id: String,
    pub title: String,
    pub node_kind: MindMapNodeKind,
    pub depth: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    pub child_count: usize,
    pub subtree_node_count: usize,
    pub path: Vec<String>,
    pub links: Vec<LinkToken>,
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MindMapMutationResult {
    pub status: MindMapMutationStatus,
    pub command: String,
    pub workspace_id: String,
    pub relative_path: WorkspaceRelativePath,
    pub affected_file: WorkspaceRelativePath,
    pub version: FileVersion,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save: Option<SaveResult>,
    pub changed_node_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted_node_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_node_id: Option<String>,
    pub affected_subtree_node_count: usize,
    pub summary: MindMapDocumentSummary,
    pub nodes: Vec<MindMapNodeSummary>,
    pub diagnostics: Vec<CompatibilityDiagnostic>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<MindMapCliWarning>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MindMapMutationStatus {
    Created,
    Saved,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MindMapCliWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MindMapMutationImpact {
    pub command: String,
    pub changed: bool,
    pub changed_node_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted_node_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_node_id: Option<String>,
    pub affected_subtree_node_count: usize,
    pub requires_destructive_confirmation: bool,
    pub risks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MindMapCliError {
    pub code: MindMapCliErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MindMapCliErrorCode {
    InvalidArguments,
    NodeNotFound,
    AmbiguousNodePath,
    RootOperationForbidden,
    DuplicateNodeId,
    InvalidIndex,
    InvalidSiblingOrder,
    CannotMoveIntoDescendant,
    ValidationError,
    UnsupportedOperation,
}

impl MindMapCliError {
    fn new(code: MindMapCliErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub fn read_mindmap(
    workspace: WorkspaceInfo,
    relative_path: WorkspaceRelativePath,
    version: FileVersion,
    document: MindMapDocument,
    selector: MindMapNodeSelector,
) -> Result<MindMapReadResult, MindMapCliError> {
    let summaries = summarize_nodes(&document)?;
    let selected_node = if selector.is_empty() {
        None
    } else {
        let selected_id = resolve_node_id(&document, &selector, "node")?;
        summaries
            .iter()
            .find(|summary| summary.id == selected_id)
            .cloned()
    };
    let subtree = if let Some(selected) = &selected_node {
        let subtree_ids = subtree_node_ids(&document, &selected.id)?;
        summaries
            .iter()
            .filter(|summary| subtree_ids.contains(&summary.id))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };

    Ok(MindMapReadResult {
        workspace,
        relative_path,
        version,
        summary: summarize_document(&document)?,
        nodes: summaries,
        selected_node,
        subtree,
        diagnostics: document.diagnostics.clone(),
        document,
        warnings: Vec::new(),
    })
}

pub fn create_template_document(
    request: MindMapTemplateRequest,
) -> Result<MindMapDocument, MindMapCliError> {
    if let Some(template) = &request.template {
        if !matches!(template.as_str(), "blank" | "root" | "default") {
            return Err(MindMapCliError::new(
                MindMapCliErrorCode::UnsupportedOperation,
                format!("Unsupported mind map template `{template}`."),
            ));
        }
    }

    let title = request
        .root_text
        .or(request.title)
        .unwrap_or_else(|| title_from_path(&request.relative_path));
    let root_id = "root".to_owned();
    let first_node_id = unique_node_id_for_parts([&request.relative_path, &title], 1);
    let mut nodes = BTreeMap::new();
    nodes.insert(
        root_id.clone(),
        MindMapNode {
            id: root_id.clone(),
            title: title.clone(),
            raw_text: String::new(),
            node_kind: MindMapNodeKind::VirtualRoot,
            children: vec![first_node_id.clone()],
            origin: synthetic_origin(Some(request.relative_path.clone()), 0),
            links: Vec::new(),
            list_marker: None,
        },
    );
    nodes.insert(
        first_node_id.clone(),
        MindMapNode {
            id: first_node_id,
            title: title.clone(),
            raw_text: raw_text_for_depth(&title, 1),
            node_kind: MindMapNodeKind::Heading,
            children: Vec::new(),
            origin: synthetic_origin(Some(request.relative_path.clone()), 1),
            links: Vec::new(),
            list_marker: None,
        },
    );

    let mut document = MindMapDocument {
        schema_version: "mindmap-document.v1".to_owned(),
        source_path: Some(request.relative_path),
        title,
        parse_mode: ParseMode::Auto,
        root_node_id: root_id,
        nodes,
        unmapped_blocks: Vec::new(),
        diagnostics: Vec::new(),
    };
    refresh_document_metadata(&mut document)?;
    Ok(document)
}

pub fn add_node(
    document: &mut MindMapDocument,
    request: MindMapAddNodeRequest,
) -> Result<MindMapMutationImpact, MindMapCliError> {
    validate_document(document)?;
    if request.parent.is_empty() == request.sibling.is_empty() {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::InvalidArguments,
            "Provide either --parent-id/--parent-path or --node-id/--node-path for mindmap.node.add.",
        ));
    }

    let text = request
        .text
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_NODE_TEXT.to_owned());
    let parents = parent_map(document)?;
    let depths = depth_map(document)?;
    let parent_id;
    let insert_index;

    if request.parent.is_empty() {
        let sibling_id = resolve_node_id(document, &request.sibling, "sibling node")?;
        if sibling_id == document.root_node_id {
            return Err(MindMapCliError::new(
                MindMapCliErrorCode::RootOperationForbidden,
                "Cannot add a sibling for the virtual root node.",
            ));
        }
        let sibling_parent_id = parents.get(&sibling_id).ok_or_else(|| {
            MindMapCliError::new(
                MindMapCliErrorCode::ValidationError,
                format!("Parent not found for sibling node `{sibling_id}`."),
            )
        })?;
        let sibling_parent = node(document, sibling_parent_id)?;
        let sibling_index = sibling_parent
            .children
            .iter()
            .position(|id| id == &sibling_id)
            .ok_or_else(|| {
                MindMapCliError::new(
                    MindMapCliErrorCode::ValidationError,
                    format!("Sibling node `{sibling_id}` is not listed by its parent."),
                )
            })?;
        parent_id = sibling_parent_id.clone();
        insert_index = match request.position {
            MindMapSiblingPosition::Before => sibling_index,
            MindMapSiblingPosition::After => sibling_index + 1,
        };
    } else {
        parent_id = resolve_node_id(document, &request.parent, "parent node")?;
        let child_count = node(document, &parent_id)?.children.len();
        insert_index = request.index.unwrap_or(child_count);
        if insert_index > child_count {
            return Err(MindMapCliError::new(
                MindMapCliErrorCode::InvalidIndex,
                format!("Child index {insert_index} is outside 0..{child_count}."),
            ));
        }
    }

    let depth = depths.get(&parent_id).copied().unwrap_or_default() + 1;
    let new_node_id = next_available_node_id(document, &parent_id, &text);
    let parent = node(document, &parent_id)?.clone();
    let mut children = parent.children.clone();
    children.insert(insert_index, new_node_id.clone());
    document
        .nodes
        .insert(parent_id.clone(), MindMapNode { children, ..parent });
    document.nodes.insert(
        new_node_id.clone(),
        MindMapNode {
            id: new_node_id.clone(),
            title: text.clone(),
            raw_text: raw_text_for_depth(&text, depth),
            node_kind: node_kind_for_depth(depth),
            children: Vec::new(),
            origin: synthetic_origin(document.source_path.clone(), depth),
            links: Vec::new(),
            list_marker: list_marker_for_depth(depth),
        },
    );

    refresh_document_metadata(document)?;
    validate_document(document)?;

    Ok(MindMapMutationImpact {
        command: "mindmap.node.add".to_owned(),
        changed: true,
        changed_node_ids: vec![parent_id, new_node_id.clone()],
        added_node_id: Some(new_node_id),
        deleted_node_ids: Vec::new(),
        moved_node_id: None,
        affected_subtree_node_count: 1,
        requires_destructive_confirmation: false,
        risks: Vec::new(),
    })
}

pub fn update_node(
    document: &mut MindMapDocument,
    request: MindMapUpdateNodeRequest,
) -> Result<MindMapMutationImpact, MindMapCliError> {
    validate_document(document)?;
    let node_id = resolve_node_id(document, &request.node, "node")?;
    if node_id == document.root_node_id {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::RootOperationForbidden,
            "Cannot update the virtual root node because it is derived from document content.",
        ));
    }

    let depth = depth_map(document)?.get(&node_id).copied().unwrap_or(1);
    let current = node(document, &node_id)?.clone();
    if current.title == request.text {
        return Ok(MindMapMutationImpact {
            command: "mindmap.node.update".to_owned(),
            changed: false,
            changed_node_ids: Vec::new(),
            added_node_id: None,
            deleted_node_ids: Vec::new(),
            moved_node_id: None,
            affected_subtree_node_count: subtree_node_ids(document, &node_id)?.len(),
            requires_destructive_confirmation: false,
            risks: Vec::new(),
        });
    }

    document.nodes.insert(
        node_id.clone(),
        MindMapNode {
            title: request.text.clone(),
            raw_text: raw_text_for_depth(&request.text, depth),
            links: Vec::new(),
            ..current
        },
    );
    refresh_document_metadata(document)?;
    validate_document(document)?;

    Ok(MindMapMutationImpact {
        command: "mindmap.node.update".to_owned(),
        changed: true,
        changed_node_ids: vec![node_id.clone()],
        added_node_id: None,
        deleted_node_ids: Vec::new(),
        moved_node_id: None,
        affected_subtree_node_count: subtree_node_ids(document, &node_id)?.len(),
        requires_destructive_confirmation: false,
        risks: Vec::new(),
    })
}

pub fn delete_branch(
    document: &mut MindMapDocument,
    request: MindMapDeleteBranchRequest,
) -> Result<MindMapMutationImpact, MindMapCliError> {
    validate_document(document)?;
    let node_id = resolve_node_id(document, &request.node, "node")?;
    if node_id == document.root_node_id {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::RootOperationForbidden,
            "Cannot delete the virtual root node.",
        ));
    }

    let parents = parent_map(document)?;
    let parent_id = parents.get(&node_id).ok_or_else(|| {
        MindMapCliError::new(
            MindMapCliErrorCode::ValidationError,
            format!("Parent not found for node `{node_id}`."),
        )
    })?;
    let deleted_node_ids = subtree_node_ids(document, &node_id)?;
    let deleted: BTreeSet<_> = deleted_node_ids.iter().cloned().collect();
    let mut parent = node(document, parent_id)?.clone();
    parent.children.retain(|child_id| child_id != &node_id);
    document.nodes.insert(parent_id.clone(), parent);
    document
        .nodes
        .retain(|candidate_id, _| !deleted.contains(candidate_id));

    refresh_document_metadata(document)?;
    validate_document(document)?;

    Ok(MindMapMutationImpact {
        command: "mindmap.branch.delete".to_owned(),
        changed: true,
        changed_node_ids: vec![parent_id.clone()],
        added_node_id: None,
        deleted_node_ids: deleted_node_ids.clone(),
        moved_node_id: None,
        affected_subtree_node_count: deleted_node_ids.len(),
        requires_destructive_confirmation: true,
        risks: vec![format!(
            "{} node(s) will be removed from the mind map.",
            deleted_node_ids.len()
        )],
    })
}

pub fn move_branch(
    document: &mut MindMapDocument,
    request: MindMapMoveBranchRequest,
) -> Result<MindMapMutationImpact, MindMapCliError> {
    validate_document(document)?;
    let node_id = resolve_node_id(document, &request.node, "node")?;
    let new_parent_id = resolve_node_id(document, &request.new_parent, "new parent node")?;
    if node_id == document.root_node_id {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::RootOperationForbidden,
            "Cannot move the virtual root node.",
        ));
    }
    if node_id == new_parent_id || is_descendant(document, &new_parent_id, &node_id)? {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::CannotMoveIntoDescendant,
            "Cannot move a node into itself or one of its descendants.",
        ));
    }

    let parents = parent_map(document)?;
    let old_parent_id = parents.get(&node_id).ok_or_else(|| {
        MindMapCliError::new(
            MindMapCliErrorCode::ValidationError,
            format!("Parent not found for node `{node_id}`."),
        )
    })?;
    let old_parent = node(document, old_parent_id)?.clone();
    let new_parent = node(document, &new_parent_id)?.clone();
    let remaining_old_children = old_parent
        .children
        .iter()
        .filter(|child_id| *child_id != &node_id)
        .cloned()
        .collect::<Vec<_>>();
    let new_parent_children = if old_parent_id == &new_parent_id {
        remaining_old_children.clone()
    } else {
        new_parent.children.clone()
    };
    let insert_index = request.index.unwrap_or(new_parent_children.len());
    if insert_index > new_parent_children.len() {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::InvalidIndex,
            format!(
                "Move index {insert_index} is outside 0..{}.",
                new_parent_children.len()
            ),
        ));
    }

    let mut next_new_parent_children = new_parent_children;
    next_new_parent_children.insert(insert_index, node_id.clone());
    if old_parent_id == &new_parent_id && next_new_parent_children == old_parent.children {
        return Ok(MindMapMutationImpact {
            command: "mindmap.branch.move".to_owned(),
            changed: false,
            changed_node_ids: Vec::new(),
            added_node_id: None,
            deleted_node_ids: Vec::new(),
            moved_node_id: Some(node_id.clone()),
            affected_subtree_node_count: subtree_node_ids(document, &node_id)?.len(),
            requires_destructive_confirmation: true,
            risks: Vec::new(),
        });
    }

    if old_parent_id == &new_parent_id {
        document.nodes.insert(
            old_parent_id.clone(),
            MindMapNode {
                children: next_new_parent_children,
                ..old_parent
            },
        );
    } else {
        document.nodes.insert(
            old_parent_id.clone(),
            MindMapNode {
                children: remaining_old_children,
                ..old_parent
            },
        );
        document.nodes.insert(
            new_parent_id.clone(),
            MindMapNode {
                children: next_new_parent_children,
                ..new_parent
            },
        );
    }

    refresh_document_metadata(document)?;
    validate_document(document)?;
    let affected = subtree_node_ids(document, &node_id)?.len();

    Ok(MindMapMutationImpact {
        command: "mindmap.branch.move".to_owned(),
        changed: true,
        changed_node_ids: vec![old_parent_id.clone(), new_parent_id, node_id.clone()],
        added_node_id: None,
        deleted_node_ids: Vec::new(),
        moved_node_id: Some(node_id),
        affected_subtree_node_count: affected,
        requires_destructive_confirmation: true,
        risks: vec![format!(
            "{affected} node(s) will be moved to a different branch position."
        )],
    })
}

pub fn reorder_siblings(
    document: &mut MindMapDocument,
    request: MindMapReorderSiblingsRequest,
) -> Result<MindMapMutationImpact, MindMapCliError> {
    validate_document(document)?;
    let parent_id = resolve_node_id(document, &request.parent, "parent node")?;
    let parent = node(document, &parent_id)?.clone();
    if !has_same_members(&parent.children, &request.child_ids) {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::InvalidSiblingOrder,
            "Reordered child ids must contain exactly the same siblings once.",
        ));
    }

    let large_restructure = request.child_ids.len() > LARGE_RESTRUCTURE_NODE_THRESHOLD;
    if parent.children == request.child_ids {
        return Ok(MindMapMutationImpact {
            command: "mindmap.siblings.reorder".to_owned(),
            changed: false,
            changed_node_ids: Vec::new(),
            added_node_id: None,
            deleted_node_ids: Vec::new(),
            moved_node_id: None,
            affected_subtree_node_count: request.child_ids.len(),
            requires_destructive_confirmation: large_restructure,
            risks: Vec::new(),
        });
    }

    document.nodes.insert(
        parent_id.clone(),
        MindMapNode {
            children: request.child_ids.clone(),
            ..parent
        },
    );
    refresh_document_metadata(document)?;
    validate_document(document)?;

    Ok(MindMapMutationImpact {
        command: "mindmap.siblings.reorder".to_owned(),
        changed: true,
        changed_node_ids: vec![parent_id],
        added_node_id: None,
        deleted_node_ids: Vec::new(),
        moved_node_id: None,
        affected_subtree_node_count: request.child_ids.len(),
        requires_destructive_confirmation: large_restructure,
        risks: large_restructure
            .then(|| {
                format!(
                    "{} sibling node(s) will be reordered.",
                    request.child_ids.len()
                )
            })
            .into_iter()
            .collect(),
    })
}

pub fn summarize_document(
    document: &MindMapDocument,
) -> Result<MindMapDocumentSummary, MindMapCliError> {
    validate_document(document)?;
    let depths = depth_map(document)?;
    let leaf_node_count = document
        .nodes
        .values()
        .filter(|node| node.id != document.root_node_id && node.children.is_empty())
        .count();

    Ok(MindMapDocumentSummary {
        title: document.title.clone(),
        source_path: document.source_path.clone(),
        root_node_id: document.root_node_id.clone(),
        total_node_count: document.nodes.len(),
        content_node_count: document.nodes.len().saturating_sub(1),
        leaf_node_count,
        max_depth: depths.values().copied().max().unwrap_or_default(),
        unmapped_block_count: document.unmapped_blocks.len(),
        diagnostic_count: document.diagnostics.len(),
    })
}

pub fn summarize_nodes(
    document: &MindMapDocument,
) -> Result<Vec<MindMapNodeSummary>, MindMapCliError> {
    validate_document(document)?;
    let parents = parent_map(document)?;
    let depths = depth_map(document)?;
    let order = traversal_order(document)?;
    let mut subtree_counts = BTreeMap::new();
    count_subtree_nodes(document, &document.root_node_id, &mut subtree_counts)?;

    Ok(order
        .into_iter()
        .map(|node_id| {
            let node = document
                .nodes
                .get(&node_id)
                .expect("validated traversal only contains existing nodes");
            MindMapNodeSummary {
                id: node.id.clone(),
                title: node.title.clone(),
                node_kind: node.node_kind,
                depth: depths.get(&node_id).copied().unwrap_or_default(),
                parent_id: parents.get(&node_id).cloned(),
                child_ids: node.children.clone(),
                child_count: node.children.len(),
                subtree_node_count: subtree_counts.get(&node_id).copied().unwrap_or(1),
                path: node_path(document, &parents, &node_id),
                links: node.links.clone(),
                collapsed: false,
            }
        })
        .collect())
}

pub fn mutation_result(
    status: MindMapMutationStatus,
    workspace_id: String,
    relative_path: WorkspaceRelativePath,
    version: FileVersion,
    save: Option<SaveResult>,
    document: &MindMapDocument,
    impact: MindMapMutationImpact,
    diagnostics: Vec<CompatibilityDiagnostic>,
    warnings: Vec<MindMapCliWarning>,
) -> Result<MindMapMutationResult, MindMapCliError> {
    Ok(MindMapMutationResult {
        status,
        command: impact.command,
        workspace_id,
        affected_file: relative_path.clone(),
        relative_path,
        version,
        save,
        changed_node_ids: impact.changed_node_ids,
        added_node_id: impact.added_node_id,
        deleted_node_ids: impact.deleted_node_ids,
        moved_node_id: impact.moved_node_id,
        affected_subtree_node_count: impact.affected_subtree_node_count,
        summary: summarize_document(document)?,
        nodes: summarize_nodes(document)?,
        diagnostics,
        warnings,
    })
}

pub fn unsupported_persisted_state_error(action: &str) -> MindMapCliError {
    MindMapCliError::new(
        MindMapCliErrorCode::UnsupportedOperation,
        format!(
            "`{action}` cannot run headlessly because collapsed state and viewport state are not persisted in Markdown."
        ),
    )
}

fn validate_document(document: &MindMapDocument) -> Result<(), MindMapCliError> {
    if !document.nodes.contains_key(&document.root_node_id) {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::ValidationError,
            format!("Root node does not exist: {}.", document.root_node_id),
        ));
    }

    parent_map(document)?;
    traversal_order(document)?;
    Ok(())
}

fn parent_map(document: &MindMapDocument) -> Result<BTreeMap<String, String>, MindMapCliError> {
    let mut parents = BTreeMap::new();
    for (node_id, node) in &document.nodes {
        if node.id != *node_id {
            return Err(MindMapCliError::new(
                MindMapCliErrorCode::ValidationError,
                format!("Node key `{node_id}` does not match node id `{}`.", node.id),
            ));
        }
        let mut seen_children = BTreeSet::new();
        for child_id in &node.children {
            if !seen_children.insert(child_id.clone()) {
                return Err(MindMapCliError::new(
                    MindMapCliErrorCode::ValidationError,
                    format!("Node `{node_id}` lists child `{child_id}` more than once."),
                ));
            }
            if !document.nodes.contains_key(child_id) {
                return Err(MindMapCliError::new(
                    MindMapCliErrorCode::ValidationError,
                    format!("Node `{node_id}` references missing child `{child_id}`."),
                ));
            }
            if let Some(existing_parent) = parents.insert(child_id.clone(), node_id.clone()) {
                return Err(MindMapCliError::new(
                    MindMapCliErrorCode::ValidationError,
                    format!(
                        "Node `{child_id}` is listed under multiple parents: `{existing_parent}` and `{node_id}`."
                    ),
                ));
            }
        }
    }
    if parents.contains_key(&document.root_node_id) {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::ValidationError,
            "The virtual root node cannot have a parent.",
        ));
    }
    Ok(parents)
}

fn traversal_order(document: &MindMapDocument) -> Result<Vec<String>, MindMapCliError> {
    let mut order = Vec::new();
    let mut active = BTreeSet::new();
    let mut visited = BTreeSet::new();
    traverse(
        document,
        &document.root_node_id,
        &mut active,
        &mut visited,
        &mut order,
    )?;
    if visited.len() != document.nodes.len() {
        let missing = document
            .nodes
            .keys()
            .find(|node_id| !visited.contains(*node_id))
            .cloned()
            .unwrap_or_else(|| "<unknown>".to_owned());
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::ValidationError,
            format!(
                "Node `{missing}` is not reachable from root `{}`.",
                document.root_node_id
            ),
        ));
    }
    Ok(order)
}

fn traverse(
    document: &MindMapDocument,
    node_id: &str,
    active: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
    order: &mut Vec<String>,
) -> Result<(), MindMapCliError> {
    if active.contains(node_id) {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::ValidationError,
            format!("Cycle detected at node `{node_id}`."),
        ));
    }
    if !visited.insert(node_id.to_owned()) {
        return Ok(());
    }
    active.insert(node_id.to_owned());
    order.push(node_id.to_owned());
    let current = node(document, node_id)?;
    for child_id in &current.children {
        traverse(document, child_id, active, visited, order)?;
    }
    active.remove(node_id);
    Ok(())
}

fn depth_map(document: &MindMapDocument) -> Result<BTreeMap<String, usize>, MindMapCliError> {
    let mut depths = BTreeMap::new();
    assign_depth(document, &document.root_node_id, 0, &mut depths)?;
    Ok(depths)
}

fn assign_depth(
    document: &MindMapDocument,
    node_id: &str,
    depth: usize,
    depths: &mut BTreeMap<String, usize>,
) -> Result<(), MindMapCliError> {
    depths.insert(node_id.to_owned(), depth);
    for child_id in &node(document, node_id)?.children {
        assign_depth(document, child_id, depth + 1, depths)?;
    }
    Ok(())
}

fn count_subtree_nodes(
    document: &MindMapDocument,
    node_id: &str,
    counts: &mut BTreeMap<String, usize>,
) -> Result<usize, MindMapCliError> {
    let mut count = 1;
    for child_id in &node(document, node_id)?.children {
        count += count_subtree_nodes(document, child_id, counts)?;
    }
    counts.insert(node_id.to_owned(), count);
    Ok(count)
}

fn subtree_node_ids(
    document: &MindMapDocument,
    node_id: &str,
) -> Result<Vec<String>, MindMapCliError> {
    node(document, node_id)?;
    let mut ids = Vec::new();
    collect_subtree_node_ids(document, node_id, &mut ids)?;
    Ok(ids)
}

fn collect_subtree_node_ids(
    document: &MindMapDocument,
    node_id: &str,
    ids: &mut Vec<String>,
) -> Result<(), MindMapCliError> {
    ids.push(node_id.to_owned());
    for child_id in &node(document, node_id)?.children {
        collect_subtree_node_ids(document, child_id, ids)?;
    }
    Ok(())
}

fn resolve_node_id(
    document: &MindMapDocument,
    selector: &MindMapNodeSelector,
    label: &str,
) -> Result<String, MindMapCliError> {
    match (&selector.node_id, &selector.node_path) {
        (Some(_), Some(_)) => Err(MindMapCliError::new(
            MindMapCliErrorCode::InvalidArguments,
            format!("Provide either {label} id or {label} path, not both."),
        )),
        (Some(node_id), None) => {
            if document.nodes.contains_key(node_id) {
                Ok(node_id.clone())
            } else {
                Err(MindMapCliError::new(
                    MindMapCliErrorCode::NodeNotFound,
                    format!("{label} not found: `{node_id}`."),
                ))
            }
        }
        (None, Some(path)) => resolve_node_path(document, path, label),
        (None, None) => Err(MindMapCliError::new(
            MindMapCliErrorCode::InvalidArguments,
            format!("A {label} id or path is required."),
        )),
    }
}

fn resolve_node_path(
    document: &MindMapDocument,
    path: &str,
    label: &str,
) -> Result<String, MindMapCliError> {
    let requested = split_node_path(path)?;
    let parents = parent_map(document)?;
    let mut matches = Vec::new();
    for node_id in document.nodes.keys() {
        if node_id == &document.root_node_id {
            continue;
        }
        if node_path(document, &parents, node_id) == requested {
            matches.push(node_id.clone());
        }
    }

    match matches.len() {
        0 => Err(MindMapCliError::new(
            MindMapCliErrorCode::NodeNotFound,
            format!("{label} path not found: `{path}`."),
        )),
        1 => Ok(matches.remove(0)),
        _ => Err(MindMapCliError::new(
            MindMapCliErrorCode::AmbiguousNodePath,
            format!("{label} path is ambiguous: `{path}`."),
        )),
    }
}

fn split_node_path(path: &str) -> Result<Vec<String>, MindMapCliError> {
    let parts = path
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return Err(MindMapCliError::new(
            MindMapCliErrorCode::InvalidArguments,
            "Node path must contain at least one non-empty segment.",
        ));
    }
    Ok(parts)
}

fn node_path(
    document: &MindMapDocument,
    parents: &BTreeMap<String, String>,
    node_id: &str,
) -> Vec<String> {
    if node_id == document.root_node_id {
        return Vec::new();
    }

    let mut parts = Vec::new();
    let mut current = Some(node_id);
    while let Some(current_id) = current {
        if current_id == document.root_node_id {
            break;
        }
        if let Some(current_node) = document.nodes.get(current_id) {
            parts.push(current_node.title.clone());
        }
        current = parents.get(current_id).map(String::as_str);
    }
    parts.reverse();
    parts
}

fn is_descendant(
    document: &MindMapDocument,
    node_id: &str,
    ancestor_id: &str,
) -> Result<bool, MindMapCliError> {
    Ok(subtree_node_ids(document, ancestor_id)?
        .iter()
        .any(|candidate_id| candidate_id == node_id))
}

fn refresh_document_metadata(document: &mut MindMapDocument) -> Result<(), MindMapCliError> {
    validate_document(document)?;
    let depths = depth_map(document)?;
    let root_node_id = document.root_node_id.clone();
    let root_title = document
        .nodes
        .get(&root_node_id)
        .and_then(|root| root.children.first())
        .and_then(|first_child_id| document.nodes.get(first_child_id))
        .map(|node| node.title.clone())
        .unwrap_or_else(|| title_from_path(document.source_path.as_deref().unwrap_or("")));

    document.title = root_title.clone();
    for (node_id, node) in document.nodes.iter_mut() {
        let depth = depths.get(node_id).copied().unwrap_or_default();
        if node_id == &root_node_id {
            node.title = root_title.clone();
            node.raw_text.clear();
            node.node_kind = MindMapNodeKind::VirtualRoot;
            node.origin = synthetic_origin(document.source_path.clone(), 0);
            node.list_marker = None;
            continue;
        }

        node.node_kind = node_kind_for_depth(depth);
        node.raw_text = raw_text_for_depth(&node.title, depth);
        node.origin = synthetic_origin(document.source_path.clone(), depth);
        if node.node_kind == MindMapNodeKind::ListItem && node.list_marker.is_none() {
            node.list_marker = list_marker_for_depth(depth);
        }
    }
    Ok(())
}

fn node<'a>(
    document: &'a MindMapDocument,
    node_id: &str,
) -> Result<&'a MindMapNode, MindMapCliError> {
    document.nodes.get(node_id).ok_or_else(|| {
        MindMapCliError::new(
            MindMapCliErrorCode::NodeNotFound,
            format!("Node not found: `{node_id}`."),
        )
    })
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

fn next_available_node_id(document: &MindMapDocument, parent_id: &str, text: &str) -> String {
    for counter in 1.. {
        let candidate = unique_node_id_for_parts(
            [
                document.source_path.as_deref().unwrap_or(""),
                parent_id,
                text,
            ],
            counter,
        );
        if !document.nodes.contains_key(&candidate) {
            return candidate;
        }
    }
    unreachable!("unbounded counter should eventually find an unused node id")
}

fn unique_node_id_for_parts<const N: usize>(parts: [&str; N], counter: usize) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0xff]);
    }
    hasher.update(counter.to_string().as_bytes());
    format!("node-cli-{}", &format!("{:x}", hasher.finalize())[..16])
}

fn node_kind_for_depth(depth: usize) -> MindMapNodeKind {
    if depth == 0 {
        MindMapNodeKind::VirtualRoot
    } else if depth <= 6 {
        MindMapNodeKind::Heading
    } else {
        MindMapNodeKind::ListItem
    }
}

fn raw_text_for_depth(title: &str, depth: usize) -> String {
    if depth == 0 {
        String::new()
    } else if depth <= 6 {
        format!("{} {}", "#".repeat(depth), title)
    } else {
        format!("{}- {}", "  ".repeat(depth - 7), title)
    }
}

fn list_marker_for_depth(depth: usize) -> Option<ListMarker> {
    if depth <= 6 {
        None
    } else {
        Some(ListMarker {
            raw: "-".to_owned(),
            kind: how_to_think_markdown::ListMarkerKind::Unordered,
            ordinal: None,
            checked: None,
        })
    }
}

fn synthetic_origin(source_path: Option<String>, depth: usize) -> MarkdownOrigin {
    let block_kind = if depth == 0 {
        MarkdownBlockKind::DocumentRoot
    } else if depth <= 6 {
        MarkdownBlockKind::Heading
    } else {
        MarkdownBlockKind::ListItem
    };
    MarkdownOrigin {
        source_path,
        span: SourceSpan {
            start_line: depth.max(1),
            start_column: 1,
            end_line: depth.max(1),
            end_column: 1,
        },
        block_kind,
        heading_level: if depth > 0 && depth <= 6 {
            Some(depth as u8)
        } else {
            None
        },
        list_depth: if depth > 6 { Some(depth - 7) } else { None },
    }
}

fn title_from_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "Untitled map".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use how_to_think_markdown::{parse_markdown_to_mindmap, ParseMode};

    fn document(markdown: &str) -> MindMapDocument {
        parse_markdown_to_mindmap(markdown, Some("plan.md"), ParseMode::Auto)
            .document
            .unwrap()
    }

    fn selector_by_path(path: &str) -> MindMapNodeSelector {
        MindMapNodeSelector::new(None, Some(path.to_owned()))
    }

    fn selector_by_id(id: impl Into<String>) -> MindMapNodeSelector {
        MindMapNodeSelector::new(Some(id.into()), None)
    }

    #[test]
    fn adds_child_by_path_and_summarizes_subtree() {
        let mut document = document("# Plan\n\n## Alpha\n");

        let impact = add_node(
            &mut document,
            MindMapAddNodeRequest {
                parent: selector_by_path("Plan/Alpha"),
                sibling: MindMapNodeSelector::new(None, None),
                text: Some("Detail".to_owned()),
                index: None,
                position: MindMapSiblingPosition::After,
            },
        )
        .unwrap();

        assert!(impact.changed);
        let alpha_id = resolve_node_path(&document, "Plan/Alpha", "node").unwrap();
        let alpha = document.nodes.get(&alpha_id).unwrap();
        assert_eq!(alpha.children.len(), 1);
        assert_eq!(
            document.nodes.get(&alpha.children[0]).unwrap().title,
            "Detail"
        );
        assert_eq!(summarize_document(&document).unwrap().content_node_count, 3);
    }

    #[test]
    fn rejects_delete_of_virtual_root() {
        let mut document = document("# Plan\n");
        let root_id = document.root_node_id.clone();

        let error = delete_branch(
            &mut document,
            MindMapDeleteBranchRequest {
                node: selector_by_id(root_id),
            },
        )
        .unwrap_err();

        assert_eq!(error.code, MindMapCliErrorCode::RootOperationForbidden);
    }

    #[test]
    fn rejects_move_into_descendant() {
        let mut document = document("# Plan\n\n## Alpha\n\n### Detail\n");

        let error = move_branch(
            &mut document,
            MindMapMoveBranchRequest {
                node: selector_by_path("Plan/Alpha"),
                new_parent: selector_by_path("Plan/Alpha/Detail"),
                index: None,
            },
        )
        .unwrap_err();

        assert_eq!(error.code, MindMapCliErrorCode::CannotMoveIntoDescendant);
    }

    #[test]
    fn reorders_siblings_only_with_exact_same_members() {
        let mut document = document("# Plan\n\n## Alpha\n\n## Beta\n");
        let plan_id = resolve_node_path(&document, "Plan", "node").unwrap();
        let plan = document.nodes.get(&plan_id).unwrap();
        let mut reversed = plan.children.clone();
        reversed.reverse();

        let impact = reorder_siblings(
            &mut document,
            MindMapReorderSiblingsRequest {
                parent: selector_by_id(plan_id.clone()),
                child_ids: reversed.clone(),
            },
        )
        .unwrap();

        assert!(impact.changed);
        assert_eq!(document.nodes.get(&plan_id).unwrap().children, reversed);

        let error = reorder_siblings(
            &mut document,
            MindMapReorderSiblingsRequest {
                parent: selector_by_id(plan_id),
                child_ids: vec!["missing".to_owned()],
            },
        )
        .unwrap_err();
        assert_eq!(error.code, MindMapCliErrorCode::InvalidSiblingOrder);
    }
}
