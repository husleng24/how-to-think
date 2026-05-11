use crate::atomic_write::write_file_atomically;
use crate::cli_guard::{
    confirmation_request_for, CliConfirmationKind, CliConfirmationRequestInput,
    CliConfirmationScope,
};
use crate::command_service::{CliErrorCode, CliResultEnvelope, CliWarning};
use crate::errors::{WorkspaceErrorCode, WorkspaceOperation};
use crate::markdown_lifecycle::{
    self, OpenMarkdownMindMapResult, SerializeMindMapRequest, SerializeMindMapStatus,
};
use crate::mindmap_cli::{self, MindMapCliError, MindMapCliErrorCode, MindMapNodeSelector};
use crate::models::{FileVersion, WorkspaceRecord, WorkspaceRelativePath};
use crate::path_guard::relative_path_to_path_buf;
use how_to_think_markdown::{
    MarkdownLineEnding, MarkdownSerializeMode, MindMapDocument, MindMapNode, ParseMode,
    SerializePreservationPolicy,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const EXPORT_CONTRACT_VERSION: &str = "2026-05-11.v1";
pub const RENDER_OPERATION_ID: &str = "render";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenderExportFormat {
    Svg,
    Png,
    Pdf,
    Markdown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenderExportScope {
    CurrentFile,
    Branch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderCliRequest {
    pub workspace_path: Option<PathBuf>,
    pub source_relative_path: WorkspaceRelativePath,
    pub output_relative_path: Option<WorkspaceRelativePath>,
    pub format: RenderExportFormat,
    pub scope: RenderExportScope,
    pub node_id: Option<String>,
    pub node_path: Option<String>,
    pub expected_version: Option<FileVersion>,
    pub confirmation_token: Option<String>,
    pub non_interactive: bool,
    pub overwrite: bool,
    pub parse_mode: ParseMode,
    pub line_ending: MarkdownLineEnding,
    pub preservation_policy: SerializePreservationPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderCliResult {
    pub status: RenderStatus,
    pub contract_version: &'static str,
    pub source_relative_path: WorkspaceRelativePath,
    pub output_path: WorkspaceRelativePath,
    pub format: RenderExportFormat,
    pub scope: RenderScopeSummary,
    pub artifact: RenderArtifactMetadata,
    pub warnings: Vec<RenderWarning>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RenderStatus {
    Exported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderScopeSummary {
    pub kind: RenderExportScope,
    pub root_node_id: String,
    pub rendered_node_count: usize,
    pub rendered_edge_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderArtifactMetadata {
    pub mime_type: &'static str,
    pub byte_size: u64,
    pub checksum_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenderWarning {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderCliError {
    pub code: CliErrorCode,
    pub export_code: &'static str,
    pub message: String,
    pub details: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
struct ExportOutputPath {
    relative_path: WorkspaceRelativePath,
    absolute_path: PathBuf,
    existed: bool,
}

#[derive(Debug, Clone)]
struct ScopedExport {
    root_node_id: String,
    node_ids: Vec<String>,
    nodes: Vec<LayoutNode>,
    edges: Vec<LayoutEdge>,
    bounds: Bounds,
    warnings: Vec<RenderWarning>,
}

#[derive(Debug, Clone)]
struct LayoutNode {
    id: String,
    title: String,
    parent_id: Option<String>,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Debug, Clone)]
struct LayoutEdge {
    from_x: f32,
    from_y: f32,
    to_x: f32,
    to_y: f32,
}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    width: f32,
    height: f32,
}

pub fn render_cli_export(
    record: &WorkspaceRecord,
    workspace_path: PathBuf,
    request: RenderCliRequest,
    opened: OpenMarkdownMindMapResult,
) -> CliResultEnvelope {
    let output_relative_path = match request.output_relative_path.clone() {
        Some(path) => path,
        None => default_output_path(&request.source_relative_path, request.format),
    };
    let output = match prepare_output_path(record, &output_relative_path, request.format) {
        Ok(output) => output,
        Err(error) => return error_envelope(error),
    };

    if output.existed && !request.overwrite {
        let confirmation = confirmation_request_for(CliConfirmationRequestInput {
            kind: CliConfirmationKind::DestructiveFile,
            command_id: RENDER_OPERATION_ID.to_owned(),
            prompt: "Confirm `render` before replacing an existing export artifact.".to_owned(),
            risks: vec![format!(
                "Existing export artifact `{}` will be replaced.",
                output.relative_path
            )],
            scope: CliConfirmationScope {
                workspace_id: Some(record.info.id.clone()),
                relative_paths: vec![request.source_relative_path.clone()],
                expected_version_tokens: vec![opened.snapshot.version.token.clone()],
                details: [("outputPath".to_owned(), output.relative_path.clone())]
                    .into_iter()
                    .collect(),
            },
        });
        if request.confirmation_token.as_deref() != Some(confirmation.confirm_token.as_str()) {
            return CliResultEnvelope::confirmation_required(RENDER_OPERATION_ID, confirmation);
        }
    }

    if let Some(expected) = &request.expected_version {
        if expected != &opened.snapshot.version {
            let mut error = RenderCliError::new(
                CliErrorCode::VersionConflict,
                "source_file_stale",
                "Source file version changed before export.",
            );
            error
                .details
                .insert("expectedToken".to_owned(), json!(expected.token));
            error.details.insert(
                "currentToken".to_owned(),
                json!(opened.snapshot.version.token),
            );
            return error_envelope(error);
        }
    }

    let Some(document) = opened.document else {
        return error_envelope(RenderCliError::new(
            CliErrorCode::ValidationError,
            "markdown_parse_failed",
            "Markdown could not be parsed into a mind map document.",
        ));
    };

    let scoped = match scoped_export(&document, &request) {
        Ok(scope) => scope,
        Err(error) => return error_envelope(mindmap_error_to_render_error(error)),
    };

    let artifact = match render_artifact(&document, &opened.snapshot.content, &scoped, &request) {
        Ok(artifact) => artifact,
        Err(error) => return error_envelope(error),
    };

    if let Err(error) = write_file_atomically(&output.absolute_path, &artifact.bytes) {
        return error_envelope(write_error(&output.relative_path, error));
    }

    let byte_size = fs::metadata(&output.absolute_path)
        .map(|metadata| metadata.len())
        .unwrap_or(artifact.bytes.len() as u64);
    let checksum_sha256 = checksum_hex(&artifact.bytes);
    let mut warnings = scoped.warnings;
    if output.existed {
        warnings.push(RenderWarning::new(
            "output_overwrite_requested",
            "Existing export artifact was replaced.",
            Some(details([("outputPath", json!(output.relative_path))])),
        ));
    }
    warnings.extend(artifact.warnings);

    let data = RenderCliResult {
        status: RenderStatus::Exported,
        contract_version: EXPORT_CONTRACT_VERSION,
        source_relative_path: request.source_relative_path,
        output_path: output.relative_path,
        format: request.format,
        scope: RenderScopeSummary {
            kind: request.scope,
            root_node_id: scoped.root_node_id,
            rendered_node_count: scoped.nodes.len(),
            rendered_edge_count: scoped.edges.len(),
        },
        artifact: RenderArtifactMetadata {
            mime_type: mime_type(request.format),
            byte_size,
            checksum_sha256,
            width: artifact.width,
            height: artifact.height,
            page_count: artifact.page_count,
        },
        warnings,
    };
    let mut envelope = CliResultEnvelope::success(RENDER_OPERATION_ID, &data);
    envelope.warnings = data
        .warnings
        .iter()
        .map(|warning| CliWarning {
            code: warning.code.clone(),
            message: warning.message.clone(),
            details: warning.details.clone(),
        })
        .collect();
    let _ = workspace_path;
    envelope
}

pub fn default_output_path(source_relative_path: &str, format: RenderExportFormat) -> String {
    let normalized = normalize_cli_relative_path(source_relative_path);
    let path = Path::new(&normalized);
    let parent = path
        .parent()
        .and_then(|parent| parent.to_str())
        .filter(|parent| !parent.is_empty());
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("export");
    let file_name = match format {
        RenderExportFormat::Markdown => format!("{stem}.export.md"),
        _ => format!("{stem}.{}", format.extension()),
    };
    match parent {
        Some(parent) => format!("{}/{}", parent.replace('\\', "/"), file_name),
        None => file_name,
    }
}

pub fn parse_render_export_format(value: &str) -> Result<RenderExportFormat, String> {
    match value {
        "svg" => Ok(RenderExportFormat::Svg),
        "png" => Ok(RenderExportFormat::Png),
        "pdf" => Ok(RenderExportFormat::Pdf),
        "markdown" | "md" => Ok(RenderExportFormat::Markdown),
        _ => Err(format!(
            "Unsupported render format `{value}`. Expected png, svg, pdf, or markdown."
        )),
    }
}

pub fn parse_render_scope(value: &str) -> Result<RenderExportScope, String> {
    match value {
        "file" | "current-file" | "current_file" => Ok(RenderExportScope::CurrentFile),
        "branch" | "selected-branch" | "selected_branch" => Ok(RenderExportScope::Branch),
        _ => Err(format!(
            "Unsupported render scope `{value}`. Expected file or branch."
        )),
    }
}

pub fn normalize_cli_relative_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while let Some(rest) = normalized.strip_prefix("./") {
        normalized = rest.to_owned();
    }
    normalized
}

impl RenderExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Svg => "svg",
            Self::Png => "png",
            Self::Pdf => "pdf",
            Self::Markdown => "md",
        }
    }
}

impl RenderCliError {
    fn new(code: CliErrorCode, export_code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            export_code,
            message: message.into(),
            details: details([("exportCode", json!(export_code))]),
        }
    }
}

impl RenderWarning {
    fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<BTreeMap<String, Value>>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details,
        }
    }
}

struct RenderedArtifact {
    bytes: Vec<u8>,
    width: Option<u32>,
    height: Option<u32>,
    page_count: Option<u32>,
    warnings: Vec<RenderWarning>,
}

fn prepare_output_path(
    record: &WorkspaceRecord,
    relative_path: &str,
    format: RenderExportFormat,
) -> Result<ExportOutputPath, RenderCliError> {
    let relative_path =
        validate_export_relative_path(relative_path, record.info.case_sensitive, format)?;
    let target = record
        .canonical_root
        .join(relative_path_to_path_buf(&relative_path));
    let parent = target.parent().ok_or_else(|| {
        RenderCliError::new(
            CliErrorCode::InvalidRelativePath,
            "invalid_output_path",
            "Export output path must have a parent directory.",
        )
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        io_export_error(
            CliErrorCode::ValidationError,
            "output_not_writable",
            "Export output parent directory cannot be accessed.",
            &relative_path,
            error,
        )
    })?;
    if !canonical_parent.starts_with(&record.canonical_root) {
        let mut error = RenderCliError::new(
            CliErrorCode::PathOutsideWorkspace,
            "invalid_output_path",
            "Export output path resolves outside the selected workspace.",
        );
        error
            .details
            .insert("outputPath".to_owned(), json!(relative_path));
        return Err(error);
    }

    let file_name = target.file_name().ok_or_else(|| {
        RenderCliError::new(
            CliErrorCode::InvalidRelativePath,
            "invalid_output_path",
            "Export output path must include a file name.",
        )
    })?;
    let absolute_path = canonical_parent.join(file_name);
    let existed = match fs::symlink_metadata(&absolute_path) {
        Ok(metadata) if metadata.is_dir() => {
            let mut error = RenderCliError::new(
                CliErrorCode::ValidationError,
                "output_path_conflict",
                "Export output path is a directory.",
            );
            error
                .details
                .insert("outputPath".to_owned(), json!(relative_path));
            return Err(error);
        }
        Ok(_) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(io_export_error(
                CliErrorCode::ValidationError,
                "output_not_writable",
                "Export output path cannot be inspected.",
                &relative_path,
                error,
            ))
        }
    };

    Ok(ExportOutputPath {
        relative_path,
        absolute_path,
        existed,
    })
}

fn validate_export_relative_path(
    relative_path: &str,
    case_sensitive: bool,
    format: RenderExportFormat,
) -> Result<WorkspaceRelativePath, RenderCliError> {
    let relative_path = normalize_cli_relative_path(relative_path);
    if relative_path.is_empty()
        || relative_path.starts_with('/')
        || relative_path.starts_with("//")
        || has_windows_drive_prefix(&relative_path)
        || relative_path.chars().any(char::is_control)
    {
        return Err(invalid_output_path(
            &relative_path,
            "Export output path must be workspace-relative.",
        ));
    }

    for segment in relative_path.split('/') {
        if segment.is_empty()
            || matches!(segment, "." | "..")
            || is_windows_reserved_segment(segment)
        {
            return Err(invalid_output_path(
                &relative_path,
                "Export output path contains an invalid segment.",
            ));
        }
    }

    let file_name = relative_path.rsplit('/').next().unwrap_or_default();
    if !extension_matches(file_name, format, case_sensitive) {
        let mut error = invalid_output_path(
            &relative_path,
            "Export output path extension must match the selected format.",
        );
        error
            .details
            .insert("expectedExtension".to_owned(), json!(format.extension()));
        return Err(error);
    }

    Ok(relative_path)
}

fn scoped_export(
    document: &MindMapDocument,
    request: &RenderCliRequest,
) -> Result<ScopedExport, MindMapCliError> {
    let root_node_id = match request.scope {
        RenderExportScope::CurrentFile => document.root_node_id.clone(),
        RenderExportScope::Branch => mindmap_cli::resolve_node_selector(
            document,
            &MindMapNodeSelector::new(request.node_id.clone(), request.node_path.clone()),
            "branch root",
        )?,
    };
    let node_ids = scoped_node_ids(document, &root_node_id)?;
    let layout_ids = node_ids
        .iter()
        .filter(|node_id| *node_id != &document.root_node_id)
        .cloned()
        .collect::<Vec<_>>();
    if layout_ids.is_empty() {
        return Err(MindMapCliError {
            code: MindMapCliErrorCode::ValidationError,
            message: "Export scope does not contain any renderable mind map nodes.".to_owned(),
        });
    }

    let depths = depth_map(document)?;
    let base_depth = layout_ids
        .iter()
        .filter_map(|node_id| depths.get(node_id))
        .min()
        .copied()
        .unwrap_or(1);
    let included: BTreeSet<_> = layout_ids.iter().cloned().collect();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut row = 0usize;
    for node_id in &layout_ids {
        let node = document.nodes.get(node_id).ok_or_else(|| MindMapCliError {
            code: MindMapCliErrorCode::NodeNotFound,
            message: format!("Node not found: `{node_id}`."),
        })?;
        let depth = depths.get(node_id).copied().unwrap_or(base_depth) - base_depth;
        let x = 48.0 + depth as f32 * 260.0;
        let y = 48.0 + row as f32 * 86.0;
        let width = 198.0;
        let height = 54.0;
        let parent_id = parent_id(document, node_id).filter(|parent| included.contains(parent));
        if let Some(parent_id) = &parent_id {
            if let Some(parent_index) = nodes
                .iter()
                .position(|candidate: &LayoutNode| candidate.id == *parent_id)
            {
                let parent = &nodes[parent_index];
                edges.push(LayoutEdge {
                    from_x: parent.x + parent.width,
                    from_y: parent.y + parent.height / 2.0,
                    to_x: x,
                    to_y: y + height / 2.0,
                });
            }
        }
        nodes.push(LayoutNode {
            id: node_id.clone(),
            title: node.title.clone(),
            parent_id,
            x,
            y,
            width,
            height,
        });
        row += 1;
    }

    let max_x = nodes
        .iter()
        .map(|node| node.x + node.width + 48.0)
        .fold(1.0, f32::max);
    let max_y = nodes
        .iter()
        .map(|node| node.y + node.height + 48.0)
        .fold(1.0, f32::max);
    let mut warnings = Vec::new();
    for diagnostic in &document.diagnostics {
        warnings.push(RenderWarning::new(
            "markdown_compatibility_warning",
            diagnostic.message.clone(),
            Some(details([
                ("diagnosticCode", json!(diagnostic.code)),
                ("nodeId", json!(diagnostic.node_id)),
            ])),
        ));
    }
    if !document.unmapped_blocks.is_empty() {
        warnings.push(RenderWarning::new(
            "unmapped_markdown_block",
            "Markdown blocks are not represented as mind map nodes.",
            Some(details([(
                "unmappedBlockCount",
                json!(document.unmapped_blocks.len()),
            )])),
        ));
    }

    Ok(ScopedExport {
        root_node_id: if request.scope == RenderExportScope::CurrentFile {
            layout_ids[0].clone()
        } else {
            root_node_id
        },
        node_ids: layout_ids,
        nodes,
        edges,
        bounds: Bounds {
            width: max_x,
            height: max_y,
        },
        warnings,
    })
}

fn render_artifact(
    document: &MindMapDocument,
    source_markdown: &str,
    scoped: &ScopedExport,
    request: &RenderCliRequest,
) -> Result<RenderedArtifact, RenderCliError> {
    match request.format {
        RenderExportFormat::Svg => {
            let svg = render_svg(scoped);
            Ok(RenderedArtifact {
                bytes: svg.into_bytes(),
                width: Some(scoped.bounds.width.ceil() as u32),
                height: Some(scoped.bounds.height.ceil() as u32),
                page_count: None,
                warnings: Vec::new(),
            })
        }
        RenderExportFormat::Png => Ok(render_png(scoped)),
        RenderExportFormat::Pdf => Ok(render_pdf(scoped)),
        RenderExportFormat::Markdown => {
            let markdown = match request.scope {
                RenderExportScope::CurrentFile => ensure_trailing_newline(source_markdown),
                RenderExportScope::Branch => render_branch_markdown(document, scoped, request)?,
            };
            Ok(RenderedArtifact {
                bytes: markdown.into_bytes(),
                width: None,
                height: None,
                page_count: None,
                warnings: Vec::new(),
            })
        }
    }
}

fn render_branch_markdown(
    document: &MindMapDocument,
    scoped: &ScopedExport,
    request: &RenderCliRequest,
) -> Result<String, RenderCliError> {
    let Some(root) = scoped.node_ids.first() else {
        return Err(RenderCliError::new(
            CliErrorCode::ValidationError,
            "invalid_export_scope",
            "Branch export scope is empty.",
        ));
    };
    let lines = serialize_branch_node(document, root, 0)?;
    let markdown = lines.join("\n");
    let serialized = markdown_lifecycle::serialize_mind_map(SerializeMindMapRequest {
        document: document.clone(),
        target_path: Some(default_output_path(
            &request.source_relative_path,
            RenderExportFormat::Markdown,
        )),
        save_mode: MarkdownSerializeMode::CanonicalHeadings,
        preservation_policy: request.preservation_policy,
        line_ending: request.line_ending,
    });
    if serialized.status == SerializeMindMapStatus::LossySaveBlocked {
        return Err(RenderCliError::new(
            CliErrorCode::ValidationError,
            "markdown_serialization_lossy",
            "Markdown export was blocked by compatibility diagnostics.",
        ));
    }
    Ok(ensure_trailing_newline(&markdown))
}

fn render_svg(scoped: &ScopedExport) -> String {
    let mut edges = String::new();
    for edge in &scoped.edges {
        edges.push_str(&format!(
            "    <path d=\"M {} {} C {} {}, {} {}, {} {}\" stroke=\"#8aa0b8\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\" />\n",
            number(edge.from_x),
            number(edge.from_y),
            number(edge.from_x + 72.0),
            number(edge.from_y),
            number(edge.to_x - 72.0),
            number(edge.to_y),
            number(edge.to_x),
            number(edge.to_y)
        ));
    }

    let mut nodes = String::new();
    for node in &scoped.nodes {
        let is_root = node.parent_id.is_none();
        let fill = if is_root { "#153a5b" } else { "#ffffff" };
        let stroke = if is_root { "#0d263d" } else { "#c8d3df" };
        let text = if is_root { "#ffffff" } else { "#1d2b3a" };
        nodes.push_str(&format!(
            "    <g id=\"node-{}\" data-source-node-id=\"{}\">\n      <rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"8\" fill=\"{}\" stroke=\"{}\" stroke-width=\"1.3\" />\n      <text x=\"{}\" y=\"{}\" font-family=\"Inter, Segoe UI, Arial, sans-serif\" font-size=\"13\" fill=\"{}\">{}</text>\n    </g>\n",
            escape_xml(&node.id),
            escape_xml(&node.id),
            number(node.x),
            number(node.y),
            number(node.width),
            number(node.height),
            fill,
            stroke,
            number(node.x + 14.0),
            number(node.y + 32.0),
            text,
            escape_xml(&node.title)
        ));
    }

    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\" role=\"img\">\n  <title>{}</title>\n  <metadata data-contract-version=\"{}\" />\n  <rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"#ffffff\" />\n  <g id=\"edges\">\n{}  </g>\n  <g id=\"nodes\">\n{}  </g>\n</svg>\n",
        number(scoped.bounds.width),
        number(scoped.bounds.height),
        number(scoped.bounds.width),
        number(scoped.bounds.height),
        escape_xml(&scoped.nodes[0].title),
        EXPORT_CONTRACT_VERSION,
        number(scoped.bounds.width),
        number(scoped.bounds.height),
        edges,
        nodes
    )
}

fn render_png(scoped: &ScopedExport) -> RenderedArtifact {
    let width = scoped.bounds.width.ceil().clamp(1.0, 4096.0) as u32;
    let height = scoped.bounds.height.ceil().clamp(1.0, 4096.0) as u32;
    let mut pixels = vec![255u8; width as usize * height as usize * 3];
    for edge in &scoped.edges {
        draw_line(
            &mut pixels,
            width,
            height,
            edge.from_x as i32,
            edge.from_y as i32,
            edge.to_x as i32,
            edge.to_y as i32,
            [138, 160, 184],
        );
    }
    for node in &scoped.nodes {
        let fill = if node.parent_id.is_none() {
            [21, 58, 91]
        } else {
            [250, 252, 255]
        };
        let stroke = if node.parent_id.is_none() {
            [13, 38, 61]
        } else {
            [200, 211, 223]
        };
        fill_rect(
            &mut pixels,
            width,
            height,
            node.x as i32,
            node.y as i32,
            node.width as i32,
            node.height as i32,
            fill,
        );
        stroke_rect(
            &mut pixels,
            width,
            height,
            node.x as i32,
            node.y as i32,
            node.width as i32,
            node.height as i32,
            stroke,
        );
    }

    RenderedArtifact {
        bytes: encode_png(width, height, &pixels),
        width: Some(width),
        height: Some(height),
        page_count: None,
        warnings: Vec::new(),
    }
}

fn render_pdf(scoped: &ScopedExport) -> RenderedArtifact {
    let mut width = scoped.bounds.width.ceil().max(1.0);
    let mut height = scoped.bounds.height.ceil().max(1.0);
    let mut scale = 1.0f32;
    let mut warnings = Vec::new();
    let max_page = 2400.0;
    if width > max_page || height > max_page {
        scale = (max_page / width).min(max_page / height);
        width *= scale;
        height *= scale;
        warnings.push(RenderWarning::new(
            "pdf_fit_to_page",
            "Map was scaled to fit the PDF page.",
            Some(details([("scale", json!(round(scale)))])),
        ));
    }

    let mut content = String::new();
    content.push_str("1 1 1 rg 0 0 ");
    content.push_str(&number(width));
    content.push(' ');
    content.push_str(&number(height));
    content.push_str(" re f\n");
    for edge in &scoped.edges {
        let from = pdf_point(edge.from_x, edge.from_y, height, scale);
        let to = pdf_point(edge.to_x, edge.to_y, height, scale);
        content.push_str(&format!(
            "0.54 0.63 0.72 RG 2 w {} {} m {} {} l S\n",
            number(from.0),
            number(from.1),
            number(to.0),
            number(to.1)
        ));
    }
    for node in &scoped.nodes {
        let x = node.x * scale;
        let y = height - (node.y + node.height) * scale;
        let w = node.width * scale;
        let h = node.height * scale;
        if node.parent_id.is_none() {
            content.push_str("0.08 0.23 0.36 rg 0.05 0.15 0.24 RG\n");
        } else {
            content.push_str("1 1 1 rg 0.78 0.83 0.87 RG\n");
        }
        content.push_str(&format!(
            "{} {} {} {} re B\nBT /F1 12 Tf {} {} Td ({}) Tj ET\n",
            number(x),
            number(y),
            number(w),
            number(h),
            number(x + 12.0 * scale),
            number(y + h / 2.0),
            escape_pdf_text(&node.title)
        ));
    }

    RenderedArtifact {
        bytes: build_pdf(width, height, &content),
        width: Some(width.ceil() as u32),
        height: Some(height.ceil() as u32),
        page_count: Some(1),
        warnings,
    }
}

fn scoped_node_ids(
    document: &MindMapDocument,
    root_node_id: &str,
) -> Result<Vec<String>, MindMapCliError> {
    let mut ids = Vec::new();
    collect_node_ids(document, root_node_id, &mut ids)?;
    Ok(ids)
}

fn collect_node_ids(
    document: &MindMapDocument,
    node_id: &str,
    ids: &mut Vec<String>,
) -> Result<(), MindMapCliError> {
    let node = document.nodes.get(node_id).ok_or_else(|| MindMapCliError {
        code: MindMapCliErrorCode::NodeNotFound,
        message: format!("Node not found: `{node_id}`."),
    })?;
    ids.push(node_id.to_owned());
    for child_id in &node.children {
        collect_node_ids(document, child_id, ids)?;
    }
    Ok(())
}

fn depth_map(document: &MindMapDocument) -> Result<BTreeMap<String, usize>, MindMapCliError> {
    fn assign(
        document: &MindMapDocument,
        node_id: &str,
        depth: usize,
        depths: &mut BTreeMap<String, usize>,
    ) -> Result<(), MindMapCliError> {
        let node = document.nodes.get(node_id).ok_or_else(|| MindMapCliError {
            code: MindMapCliErrorCode::NodeNotFound,
            message: format!("Node not found: `{node_id}`."),
        })?;
        depths.insert(node_id.to_owned(), depth);
        for child_id in &node.children {
            assign(document, child_id, depth + 1, depths)?;
        }
        Ok(())
    }
    let mut depths = BTreeMap::new();
    assign(document, &document.root_node_id, 0, &mut depths)?;
    Ok(depths)
}

fn parent_id(document: &MindMapDocument, target_id: &str) -> Option<String> {
    document
        .nodes
        .iter()
        .find(|(_, node)| node.children.iter().any(|child_id| child_id == target_id))
        .map(|(node_id, _)| node_id.clone())
}

fn serialize_branch_node(
    document: &MindMapDocument,
    node_id: &str,
    depth: usize,
) -> Result<Vec<String>, RenderCliError> {
    let node = document.nodes.get(node_id).ok_or_else(|| {
        RenderCliError::new(
            CliErrorCode::ValidationError,
            "invalid_export_scope",
            format!("Branch node not found: `{node_id}`."),
        )
    })?;
    let mut lines = vec![format!(
        "{}- {}",
        "  ".repeat(depth),
        safe_markdown_title(node)
    )];
    for child_id in &node.children {
        lines.extend(serialize_branch_node(document, child_id, depth + 1)?);
    }
    Ok(lines)
}

fn safe_markdown_title(node: &MindMapNode) -> String {
    let title = node.title.replace(['\r', '\n'], " ").trim().to_owned();
    if title.is_empty() {
        "Untitled".to_owned()
    } else {
        title
    }
}

fn ensure_trailing_newline(markdown: &str) -> String {
    if markdown.ends_with('\n') {
        markdown.to_owned()
    } else {
        format!("{markdown}\n")
    }
}

fn error_envelope(error: RenderCliError) -> CliResultEnvelope {
    let mut envelope = CliResultEnvelope::error(RENDER_OPERATION_ID, error.code, error.message);
    if let Some(cli_error) = &mut envelope.error {
        cli_error.details = Some(error.details);
    }
    envelope
}

fn mindmap_error_to_render_error(error: MindMapCliError) -> RenderCliError {
    let code = match error.code {
        MindMapCliErrorCode::InvalidArguments => CliErrorCode::InvalidArguments,
        MindMapCliErrorCode::NodeNotFound
        | MindMapCliErrorCode::AmbiguousNodePath
        | MindMapCliErrorCode::ValidationError => CliErrorCode::ValidationError,
        _ => CliErrorCode::UnsupportedOperation,
    };
    RenderCliError::new(code, "invalid_export_scope", error.message)
}

fn invalid_output_path(path: &str, message: impl Into<String>) -> RenderCliError {
    let mut error = RenderCliError::new(
        CliErrorCode::InvalidRelativePath,
        "invalid_output_path",
        message,
    );
    error.details.insert("outputPath".to_owned(), json!(path));
    error
}

fn io_export_error(
    code: CliErrorCode,
    export_code: &'static str,
    message: impl Into<String>,
    relative_path: &str,
    source: io::Error,
) -> RenderCliError {
    let mut error = RenderCliError::new(code, export_code, message);
    error
        .details
        .insert("outputPath".to_owned(), json!(relative_path));
    error
        .details
        .insert("source".to_owned(), json!(source.to_string()));
    error
}

fn write_error(relative_path: &str, source: io::Error) -> RenderCliError {
    let code = if source.kind() == io::ErrorKind::PermissionDenied {
        CliErrorCode::ValidationError
    } else {
        CliErrorCode::InternalError
    };
    io_export_error(
        code,
        if code == CliErrorCode::ValidationError {
            "output_not_writable"
        } else {
            "write_failed"
        },
        "Export output write failed.",
        relative_path,
        source,
    )
}

fn extension_matches(file_name: &str, format: RenderExportFormat, case_sensitive: bool) -> bool {
    let Some(extension) = file_name.rsplit_once('.').map(|(_, extension)| extension) else {
        return false;
    };
    let matches = |expected: &str| {
        if case_sensitive {
            extension == expected
        } else {
            extension.eq_ignore_ascii_case(expected)
        }
    };
    match format {
        RenderExportFormat::Svg => matches("svg"),
        RenderExportFormat::Png => matches("png"),
        RenderExportFormat::Pdf => matches("pdf"),
        RenderExportFormat::Markdown => matches("md") || matches("markdown"),
    }
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn is_windows_reserved_segment(segment: &str) -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }
    let stem = segment
        .split_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(segment)
        .trim_end_matches(|character| character == ' ' || character == '.')
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn mime_type(format: RenderExportFormat) -> &'static str {
    match format {
        RenderExportFormat::Svg => "image/svg+xml",
        RenderExportFormat::Png => "image/png",
        RenderExportFormat::Pdf => "application/pdf",
        RenderExportFormat::Markdown => "text/markdown",
    }
}

fn checksum_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn details<const N: usize>(entries: [(&str, Value); N]) -> BTreeMap<String, Value> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_pdf_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
        .replace(['\r', '\n'], " ")
}

fn number(value: f32) -> String {
    if (value.fract()).abs() < 0.001 {
        format!("{}", value.round() as i32)
    } else {
        format!("{value:.2}")
    }
}

fn round(value: f32) -> f32 {
    (value * 10_000.0).round() / 10_000.0
}

fn pdf_point(x: f32, y: f32, page_height: f32, scale: f32) -> (f32, f32) {
    (x * scale, page_height - y * scale)
}

fn build_pdf(width: f32, height: f32, content: &str) -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            number(width),
            number(height)
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{}endstream", content.len(), content),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref_offset = pdf.len();
    pdf.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            objects.len() + 1,
            xref_offset
        )
        .as_bytes(),
    );
    pdf
}

fn draw_line(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    mut x0: i32,
    mut y0: i32,
    x1: i32,
    y1: i32,
    color: [u8; 3],
) {
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;
    loop {
        set_pixel(pixels, width, height, x0, y0, color);
        if x0 == x1 && y0 == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x0 += sx;
        }
        if e2 <= dx {
            err += dx;
            y0 += sy;
        }
    }
}

fn fill_rect(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    rect_width: i32,
    rect_height: i32,
    color: [u8; 3],
) {
    for yy in y.max(0)..(y + rect_height).min(height as i32) {
        for xx in x.max(0)..(x + rect_width).min(width as i32) {
            set_pixel(pixels, width, height, xx, yy, color);
        }
    }
}

fn stroke_rect(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    rect_width: i32,
    rect_height: i32,
    color: [u8; 3],
) {
    draw_line(pixels, width, height, x, y, x + rect_width, y, color);
    draw_line(
        pixels,
        width,
        height,
        x,
        y + rect_height,
        x + rect_width,
        y + rect_height,
        color,
    );
    draw_line(pixels, width, height, x, y, x, y + rect_height, color);
    draw_line(
        pixels,
        width,
        height,
        x + rect_width,
        y,
        x + rect_width,
        y + rect_height,
        color,
    );
}

fn set_pixel(pixels: &mut [u8], width: u32, height: u32, x: i32, y: i32, color: [u8; 3]) {
    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
        return;
    }
    let index = (y as usize * width as usize + x as usize) * 3;
    pixels[index..index + 3].copy_from_slice(&color);
}

fn encode_png(width: u32, height: u32, rgb: &[u8]) -> Vec<u8> {
    let row_len = width as usize * 3;
    let mut raw = Vec::with_capacity((row_len + 1) * height as usize);
    for row in 0..height as usize {
        raw.push(0);
        raw.extend_from_slice(&rgb[row * row_len..(row + 1) * row_len]);
    }
    let compressed = zlib_store(&raw);
    let mut png = Vec::new();
    png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    png_chunk(&mut png, b"IHDR", {
        let mut data = Vec::new();
        data.extend_from_slice(&width.to_be_bytes());
        data.extend_from_slice(&height.to_be_bytes());
        data.extend_from_slice(&[8, 2, 0, 0, 0]);
        data
    });
    png_chunk(&mut png, b"IDAT", compressed);
    png_chunk(&mut png, b"IEND", Vec::new());
    png
}

fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut output = vec![0x78, 0x01];
    let mut offset = 0;
    while offset < data.len() {
        let remaining = data.len() - offset;
        let len = remaining.min(65_535);
        let final_block = offset + len >= data.len();
        output.push(if final_block { 0x01 } else { 0x00 });
        let len_u16 = len as u16;
        output.extend_from_slice(&len_u16.to_le_bytes());
        output.extend_from_slice(&(!len_u16).to_le_bytes());
        output.extend_from_slice(&data[offset..offset + len]);
        offset += len;
    }
    output.extend_from_slice(&adler32(data).to_be_bytes());
    output
}

fn png_chunk(png: &mut Vec<u8>, name: &[u8; 4], data: Vec<u8>) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    png.extend_from_slice(name);
    png.extend_from_slice(&data);
    let mut crc_data = Vec::with_capacity(name.len() + data.len());
    crc_data.extend_from_slice(name);
    crc_data.extend_from_slice(&data);
    png.extend_from_slice(&crc32(&crc_data).to_be_bytes());
}

fn adler32(data: &[u8]) -> u32 {
    let mut a = 1u32;
    let mut b = 0u32;
    for byte in data {
        a = (a + *byte as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[allow(dead_code)]
fn _assert_workspace_error_codes(_: WorkspaceErrorCode, _: WorkspaceOperation) {}

#[cfg(test)]
mod tests {
    use super::*;
    use how_to_think_markdown::{parse_markdown_to_mindmap, ParseMode};

    fn document(markdown: &str) -> MindMapDocument {
        parse_markdown_to_mindmap(markdown, Some("plan.md"), ParseMode::Auto)
            .document
            .unwrap()
    }

    #[test]
    fn default_paths_use_source_stem_and_safe_markdown_suffix() {
        assert_eq!(
            default_output_path("./notes/plan.md", RenderExportFormat::Svg),
            "notes/plan.svg"
        );
        assert_eq!(
            default_output_path("notes/plan.markdown", RenderExportFormat::Markdown),
            "notes/plan.export.md"
        );
    }

    #[test]
    fn branch_scope_requires_deterministic_node_selector() {
        let document = document("# Plan\n\n## Alpha\n\n## Alpha\n");
        let request = RenderCliRequest {
            workspace_path: None,
            source_relative_path: "plan.md".to_owned(),
            output_relative_path: None,
            format: RenderExportFormat::Svg,
            scope: RenderExportScope::Branch,
            node_id: None,
            node_path: Some("Plan/Alpha".to_owned()),
            expected_version: None,
            confirmation_token: None,
            non_interactive: true,
            overwrite: false,
            parse_mode: ParseMode::Auto,
            line_ending: MarkdownLineEnding::Lf,
            preservation_policy: SerializePreservationPolicy::BlockLossy,
        };

        let error = scoped_export(&document, &request).unwrap_err();

        assert_eq!(error.code, MindMapCliErrorCode::AmbiguousNodePath);
    }

    #[test]
    fn png_encoder_emits_png_signature() {
        let document = document("# Plan\n\n## Alpha\n");
        let request = RenderCliRequest {
            workspace_path: None,
            source_relative_path: "plan.md".to_owned(),
            output_relative_path: None,
            format: RenderExportFormat::Png,
            scope: RenderExportScope::CurrentFile,
            node_id: None,
            node_path: None,
            expected_version: None,
            confirmation_token: None,
            non_interactive: true,
            overwrite: false,
            parse_mode: ParseMode::Auto,
            line_ending: MarkdownLineEnding::Lf,
            preservation_policy: SerializePreservationPolicy::BlockLossy,
        };
        let scoped = scoped_export(&document, &request).unwrap();
        let artifact = render_png(&scoped);

        assert_eq!(&artifact.bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert!(artifact.width.unwrap() > 0);
        assert!(artifact.height.unwrap() > 0);
    }
}
