use crate::documents;
use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::file_index::index_markdown_files;
use crate::links::index::WorkspaceLinkIndex;
use crate::links::model::LinkIndexSnapshot;
use crate::models::{
    DocumentSnapshot, FileVersion, SaveReason, SaveRequest, SaveResult, WorkspaceFile, WorkspaceId,
    WorkspaceRecord, WorkspaceRelativePath,
};
use how_to_think_markdown::{
    parse_markdown, serialize_markdown, CompatibilityDiagnostic, DiagnosticSeverity,
    MarkdownLineEnding, MarkdownSerializeMode, MindMapDocument, ParseMarkdownRequest, ParseMode,
    SerializeMarkdownMetadata, SerializeMarkdownRequest, SerializePreservationPolicy,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParseMarkdownPreviewRequest {
    pub markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<WorkspaceRelativePath>,
    #[serde(default)]
    pub parse_mode: ParseMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParseMarkdownPreviewResult {
    pub status: ParseMarkdownPreviewStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<MindMapDocument>,
    pub diagnostics: Vec<CompatibilityDiagnostic>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ParseMarkdownPreviewStatus {
    Parsed,
    ParseError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenMarkdownMindMapRequest {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    #[serde(default)]
    pub parse_mode: ParseMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenMarkdownMindMapResult {
    pub status: OpenMarkdownMindMapStatus,
    pub snapshot: DocumentSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<MindMapDocument>,
    pub diagnostics: Vec<CompatibilityDiagnostic>,
    pub files: Vec<WorkspaceFile>,
    pub link_index: LinkIndexSnapshot,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OpenMarkdownMindMapStatus {
    Opened,
    ParseError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerializeMindMapRequest {
    pub document: MindMapDocument,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<WorkspaceRelativePath>,
    #[serde(default)]
    pub save_mode: MarkdownSerializeMode,
    #[serde(default)]
    pub preservation_policy: SerializePreservationPolicy,
    #[serde(default)]
    pub line_ending: MarkdownLineEnding,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerializeMindMapResult {
    pub status: SerializeMindMapStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    pub diagnostics: Vec<CompatibilityDiagnostic>,
    pub metadata: SerializeMarkdownMetadata,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SerializeMindMapStatus {
    Serialized,
    LossySaveBlocked,
    LossySaveConfirmationRequired,
    SerializationError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveMarkdownMindMapRequest {
    pub workspace_id: WorkspaceId,
    pub relative_path: WorkspaceRelativePath,
    pub expected_version: FileVersion,
    pub document: MindMapDocument,
    pub reason: SaveReason,
    #[serde(default)]
    pub save_mode: MarkdownSerializeMode,
    #[serde(default)]
    pub preservation_policy: SerializePreservationPolicy,
    #[serde(default)]
    pub line_ending: MarkdownLineEnding,
    #[serde(default)]
    pub confirm_lossy_save: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveMarkdownMindMapResult {
    pub status: SaveMarkdownMindMapStatus,
    pub diagnostics: Vec<CompatibilityDiagnostic>,
    pub metadata: SerializeMarkdownMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save: Option<SaveResult>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<WorkspaceFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_index: Option<LinkIndexSnapshot>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SaveMarkdownMindMapStatus {
    Saved,
    LossySaveBlocked,
    LossySaveConfirmationRequired,
    SerializationError,
}

pub fn parse_markdown_preview(request: ParseMarkdownPreviewRequest) -> ParseMarkdownPreviewResult {
    let response = parse_markdown(ParseMarkdownRequest {
        markdown: request.markdown,
        source_path: request.source_path,
        parse_mode: request.parse_mode,
    });
    let status = if response.document.is_some() {
        ParseMarkdownPreviewStatus::Parsed
    } else {
        ParseMarkdownPreviewStatus::ParseError
    };

    ParseMarkdownPreviewResult {
        status,
        document: response.document,
        diagnostics: response.diagnostics,
    }
}

pub fn open_markdown_mind_map(
    record: &WorkspaceRecord,
    request: OpenMarkdownMindMapRequest,
) -> Result<OpenMarkdownMindMapResult, WorkspaceError> {
    ensure_workspace_matches(record, &request.workspace_id, WorkspaceOperation::OpenFile)?;

    let snapshot = documents::open_document(record, &request.relative_path)?;
    let preview = parse_markdown_preview(ParseMarkdownPreviewRequest {
        markdown: snapshot.content.clone(),
        source_path: Some(snapshot.relative_path.clone()),
        parse_mode: request.parse_mode,
    });
    let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)?;
    let link_index = WorkspaceLinkIndex::from_files(record, &files)?.snapshot();

    Ok(OpenMarkdownMindMapResult {
        status: match preview.status {
            ParseMarkdownPreviewStatus::Parsed => OpenMarkdownMindMapStatus::Opened,
            ParseMarkdownPreviewStatus::ParseError => OpenMarkdownMindMapStatus::ParseError,
        },
        snapshot,
        document: preview.document,
        diagnostics: preview.diagnostics,
        files,
        link_index,
    })
}

pub fn serialize_mind_map(request: SerializeMindMapRequest) -> SerializeMindMapResult {
    let response = serialize_markdown(SerializeMarkdownRequest {
        document: request.document,
        target_path: request.target_path,
        save_mode: request.save_mode,
        preservation_policy: request.preservation_policy,
        line_ending: request.line_ending,
    });
    let status = classify_serialized_output(&response.markdown, &response.diagnostics);

    SerializeMindMapResult {
        status,
        markdown: response.markdown,
        diagnostics: response.diagnostics,
        metadata: response.metadata,
    }
}

pub fn save_markdown_mind_map(
    record: &WorkspaceRecord,
    request: SaveMarkdownMindMapRequest,
) -> Result<SaveMarkdownMindMapResult, WorkspaceError> {
    ensure_workspace_matches(record, &request.workspace_id, WorkspaceOperation::SaveFile)?;

    let serialized = serialize_mind_map(SerializeMindMapRequest {
        document: request.document,
        target_path: Some(request.relative_path.clone()),
        save_mode: request.save_mode,
        preservation_policy: request.preservation_policy,
        line_ending: request.line_ending,
    });
    let status = save_status_from_serialize_status(serialized.status);

    if status != SaveMarkdownMindMapStatus::Saved {
        return Ok(SaveMarkdownMindMapResult {
            status,
            diagnostics: serialized.diagnostics,
            metadata: serialized.metadata,
            markdown: serialized.markdown,
            save: None,
            files: Vec::new(),
            link_index: None,
        });
    }

    if requires_confirmation(&serialized.diagnostics) && !request.confirm_lossy_save {
        return Ok(SaveMarkdownMindMapResult {
            status: SaveMarkdownMindMapStatus::LossySaveConfirmationRequired,
            diagnostics: serialized.diagnostics,
            metadata: serialized.metadata,
            markdown: serialized.markdown,
            save: None,
            files: Vec::new(),
            link_index: None,
        });
    }

    let markdown = serialized.markdown.unwrap_or_default();
    let save = documents::save_document(
        record,
        SaveRequest {
            workspace_id: request.workspace_id,
            relative_path: request.relative_path,
            content: markdown.clone(),
            expected_version: request.expected_version,
            reason: request.reason,
        },
    )?;
    let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)?;
    let link_index = WorkspaceLinkIndex::from_files(record, &files)?.snapshot();

    Ok(SaveMarkdownMindMapResult {
        status: SaveMarkdownMindMapStatus::Saved,
        diagnostics: serialized.diagnostics,
        metadata: serialized.metadata,
        markdown: Some(markdown),
        save: Some(save),
        files,
        link_index: Some(link_index),
    })
}

fn ensure_workspace_matches(
    record: &WorkspaceRecord,
    workspace_id: &str,
    operation: WorkspaceOperation,
) -> Result<(), WorkspaceError> {
    if record.info.id == workspace_id {
        Ok(())
    } else {
        Err(WorkspaceError::new(
            WorkspaceErrorCode::WorkspaceNotSelected,
            operation,
            "The requested workspace id does not match the stored workspace path.",
            true,
        ))
    }
}

fn classify_serialized_output(
    markdown: &Option<String>,
    diagnostics: &[CompatibilityDiagnostic],
) -> SerializeMindMapStatus {
    if markdown.is_none() {
        if has_diagnostic(diagnostics, "lossy_save_blocked") {
            SerializeMindMapStatus::LossySaveBlocked
        } else {
            SerializeMindMapStatus::SerializationError
        }
    } else if requires_confirmation(diagnostics) {
        SerializeMindMapStatus::LossySaveConfirmationRequired
    } else {
        SerializeMindMapStatus::Serialized
    }
}

fn save_status_from_serialize_status(status: SerializeMindMapStatus) -> SaveMarkdownMindMapStatus {
    match status {
        SerializeMindMapStatus::Serialized
        | SerializeMindMapStatus::LossySaveConfirmationRequired => SaveMarkdownMindMapStatus::Saved,
        SerializeMindMapStatus::LossySaveBlocked => SaveMarkdownMindMapStatus::LossySaveBlocked,
        SerializeMindMapStatus::SerializationError => SaveMarkdownMindMapStatus::SerializationError,
    }
}

fn requires_confirmation(diagnostics: &[CompatibilityDiagnostic]) -> bool {
    diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic.code.as_str(),
            "lossy_save_requires_confirmation" | "unmapped_content_requires_confirmation"
        )
    })
}

fn has_diagnostic(diagnostics: &[CompatibilityDiagnostic], code: &str) -> bool {
    diagnostics.iter().any(|diagnostic| {
        diagnostic.code == code && diagnostic.severity == DiagnosticSeverity::Error
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::{WorkspaceErrorCode, WorkspaceOperation};
    use crate::workspace::validate_workspace_root;
    use how_to_think_markdown::{MarkdownBlockKind, PreservationPolicy};
    use std::fs;
    use std::path::Path;

    fn record(root: &Path) -> WorkspaceRecord {
        validate_workspace_root(root, WorkspaceOperation::SelectWorkspace).unwrap()
    }

    fn open_request(record: &WorkspaceRecord, relative_path: &str) -> OpenMarkdownMindMapRequest {
        OpenMarkdownMindMapRequest {
            workspace_id: record.info.id.clone(),
            relative_path: relative_path.to_owned(),
            parse_mode: ParseMode::Auto,
        }
    }

    fn save_request(
        snapshot: &DocumentSnapshot,
        document: MindMapDocument,
    ) -> SaveMarkdownMindMapRequest {
        SaveMarkdownMindMapRequest {
            workspace_id: snapshot.workspace_id.clone(),
            relative_path: snapshot.relative_path.clone(),
            expected_version: snapshot.version.clone(),
            document,
            reason: SaveReason::Manual,
            save_mode: MarkdownSerializeMode::CanonicalHeadings,
            preservation_policy: SerializePreservationPolicy::BlockLossy,
            line_ending: MarkdownLineEnding::Lf,
            confirm_lossy_save: false,
        }
    }

    #[test]
    fn opens_heading_markdown_as_mind_map_document() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("plan.md"),
            "# Plan\n\n## Step A\n\n## Step B\n",
        )
        .unwrap();
        let record = record(temp.path());

        let result = open_markdown_mind_map(&record, open_request(&record, "plan.md")).unwrap();
        let document = result.document.unwrap();
        let root = document.nodes.get(&document.root_node_id).unwrap();

        assert_eq!(result.status, OpenMarkdownMindMapStatus::Opened);
        assert_eq!(document.title, "Plan");
        assert_eq!(root.children.len(), 1);
        let plan = document.nodes.get(&root.children[0]).unwrap();
        assert_eq!(plan.children.len(), 2);
        assert_eq!(result.files[0].relative_path, "plan.md");
        assert_eq!(result.link_index.files[0].relative_path, "plan.md");
    }

    #[test]
    fn opens_nested_list_markdown_with_ordered_hierarchy() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("outline.md"),
            "- Root\n  - Child A\n  - Child B\n    - Grandchild\n",
        )
        .unwrap();
        let record = record(temp.path());

        let result = open_markdown_mind_map(&record, open_request(&record, "outline.md")).unwrap();
        let document = result.document.unwrap();
        let root = document.nodes.get(&document.root_node_id).unwrap();
        let list_root = document.nodes.get(&root.children[0]).unwrap();
        let child_titles: Vec<_> = list_root
            .children
            .iter()
            .map(|id| document.nodes.get(id).unwrap().title.as_str())
            .collect();

        assert_eq!(list_root.title, "Root");
        assert_eq!(child_titles, vec!["Child A", "Child B"]);
        let child_b = document.nodes.get(&list_root.children[1]).unwrap();
        assert_eq!(
            document.nodes.get(&child_b.children[0]).unwrap().title,
            "Grandchild"
        );
    }

    #[test]
    fn save_serializes_through_workspace_lifecycle_and_refreshes_indexes() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("plan.md"), "# Old\n").unwrap();
        let record = record(temp.path());
        let opened = open_markdown_mind_map(&record, open_request(&record, "plan.md")).unwrap();
        let mut document = opened.document.unwrap();
        let root = document.nodes.get(&document.root_node_id).unwrap();
        let child_id = root.children[0].clone();
        document.nodes.get_mut(&child_id).unwrap().title = "New".to_owned();

        let result =
            save_markdown_mind_map(&record, save_request(&opened.snapshot, document)).unwrap();

        assert_eq!(result.status, SaveMarkdownMindMapStatus::Saved);
        assert_eq!(
            fs::read_to_string(temp.path().join("plan.md")).unwrap(),
            "# New\n"
        );
        assert_eq!(result.files[0].relative_path, "plan.md");
        assert_eq!(result.link_index.unwrap().files[0].headings[0].text, "New");
    }

    #[test]
    fn save_preserves_external_modification_conflict() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("plan.md"), "# Old\n").unwrap();
        let record = record(temp.path());
        let opened = open_markdown_mind_map(&record, open_request(&record, "plan.md")).unwrap();
        fs::write(temp.path().join("plan.md"), "# External\n").unwrap();

        let error = save_markdown_mind_map(
            &record,
            save_request(&opened.snapshot, opened.document.unwrap()),
        )
        .unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::VersionConflict);
        assert_eq!(
            fs::read_to_string(temp.path().join("plan.md")).unwrap(),
            "# External\n"
        );
    }

    #[test]
    fn save_requires_confirmation_for_preserved_unmapped_content() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("plan.md"),
            "# Plan\n\nParagraph that is not a node.\n",
        )
        .unwrap();
        let record = record(temp.path());
        let opened = open_markdown_mind_map(&record, open_request(&record, "plan.md")).unwrap();

        let result = save_markdown_mind_map(
            &record,
            save_request(&opened.snapshot, opened.document.unwrap()),
        )
        .unwrap();

        assert_eq!(
            result.status,
            SaveMarkdownMindMapStatus::LossySaveConfirmationRequired
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("plan.md")).unwrap(),
            "# Plan\n\nParagraph that is not a node.\n"
        );
    }

    #[test]
    fn save_blocks_unplaceable_lossy_content_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("plan.md"), "# Plan\n").unwrap();
        let record = record(temp.path());
        let opened = open_markdown_mind_map(&record, open_request(&record, "plan.md")).unwrap();
        let mut document = opened.document.unwrap();
        let mut block = document
            .unmapped_blocks
            .first()
            .cloned()
            .unwrap_or_else(|| {
                let root = document.nodes.get(&document.root_node_id).unwrap();
                let first_child = root.children[0].clone();
                let origin = document.nodes.get(&first_child).unwrap().origin.clone();
                how_to_think_markdown::UnmappedMarkdownBlock {
                    id: "unplaceable".to_owned(),
                    kind: MarkdownBlockKind::Unknown,
                    raw: "raw".to_owned(),
                    origin,
                    placement: how_to_think_markdown::UnmappedPlacement {
                        after_node_id: Some("missing-node".to_owned()),
                        before_node_id: None,
                    },
                    preservation: PreservationPolicy::BlockLossySave,
                }
            });
        block.preservation = PreservationPolicy::BlockLossySave;
        block.placement.after_node_id = Some("missing-node".to_owned());
        document.unmapped_blocks = vec![block];

        let result =
            save_markdown_mind_map(&record, save_request(&opened.snapshot, document)).unwrap();

        assert_eq!(result.status, SaveMarkdownMindMapStatus::LossySaveBlocked);
        assert_eq!(
            fs::read_to_string(temp.path().join("plan.md")).unwrap(),
            "# Plan\n"
        );
    }

    #[test]
    fn open_missing_file_returns_workspace_error() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());

        let error =
            open_markdown_mind_map(&record, open_request(&record, "missing.md")).unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::FileNotFound);
    }
}
