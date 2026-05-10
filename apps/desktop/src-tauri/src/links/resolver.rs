use crate::errors::WorkspaceOperation;
use crate::links::index::{folded_lookup_key, LinkIndexEntry, WorkspaceLinkIndex};
use crate::links::model::{
    LinkCandidate, LinkCreateIntent, LinkDiagnostic, LinkDiagnosticCode, LinkDiagnosticSeverity,
    LinkKind, LinkOpenIntent, LinkReference, LinkResolution, LinkResolutionStatus,
    ResolveLinksResponse,
};
use crate::models::WorkspaceRelativePath;
use crate::path_guard::{supported_markdown_extension, validate_workspace_relative_path};
use std::collections::BTreeMap;

pub fn resolve_link(
    index: &WorkspaceLinkIndex,
    source_relative_path: &str,
    link: LinkReference,
) -> LinkResolution {
    let parts = LinkParts::from_reference(&link);
    let mut resolution = base_resolution(index, source_relative_path, link, &parts);

    if let Err(error) = validate_workspace_relative_path(
        source_relative_path,
        index.case_sensitive(),
        WorkspaceOperation::OpenFile,
    ) {
        resolution.status = LinkResolutionStatus::Rejected;
        resolution.diagnostics.push(diagnostic(
            LinkDiagnosticCode::InvalidPath,
            LinkDiagnosticSeverity::Error,
            "The source document path is not a valid workspace-relative Markdown path.",
            Some(source_relative_path),
            Some(resolution.target.as_str()),
            Vec::new(),
        ));
        if let Some(relative_path) = error.relative_path {
            resolution.source_relative_path = relative_path;
        }
        return resolution;
    }

    match resolution.kind {
        LinkKind::Image => reject(
            resolution,
            LinkDiagnosticCode::UnsupportedTarget,
            "Image links are not part of Markdown document link resolution.",
        ),
        LinkKind::StandardMarkdown => resolve_standard_markdown(index, resolution, &parts),
        LinkKind::ObsidianWiki => resolve_wikilink(index, resolution, &parts),
    }
}

pub fn resolve_links(
    index: &WorkspaceLinkIndex,
    source_relative_path: &str,
    links: Vec<LinkReference>,
) -> ResolveLinksResponse {
    ResolveLinksResponse {
        workspace_id: index.workspace_id().to_owned(),
        source_relative_path: source_relative_path.to_owned(),
        links: links
            .into_iter()
            .map(|link| resolve_link(index, source_relative_path, link))
            .collect(),
    }
}

fn resolve_wikilink(
    index: &WorkspaceLinkIndex,
    resolution: LinkResolution,
    parts: &LinkParts,
) -> LinkResolution {
    if parts.target.is_empty() {
        return reject(
            resolution,
            LinkDiagnosticCode::InvalidPath,
            "The wikilink target is empty.",
        );
    }

    if unsupported_protocol(&parts.target).is_some() {
        return reject(
            resolution,
            LinkDiagnosticCode::UnsupportedProtocol,
            "The link target uses an unsupported protocol.",
        );
    }

    if parts.target.contains('\\') || parts.target.chars().any(char::is_control) {
        return reject(
            resolution,
            LinkDiagnosticCode::InvalidPath,
            "The wikilink target is not a valid workspace-relative path.",
        );
    }

    if looks_path_based(&parts.target) {
        return resolve_wiki_path(index, resolution, &parts.target);
    }

    resolve_bare_wiki_stem(index, resolution, &parts.target)
}

fn resolve_wiki_path(
    index: &WorkspaceLinkIndex,
    resolution: LinkResolution,
    target: &str,
) -> LinkResolution {
    let normalized = match normalize_workspace_path(target) {
        Ok(path) => path,
        Err(code) => return reject_with_code(resolution, code),
    };

    if has_unsupported_extension(&normalized, index.case_sensitive()) {
        return reject(
            resolution,
            LinkDiagnosticCode::UnsupportedTarget,
            "The link target is not a supported Markdown file.",
        );
    }

    let variants = if has_supported_extension(&normalized, index.case_sensitive()) {
        vec![normalized.clone()]
    } else {
        vec![format!("{normalized}.md"), format!("{normalized}.markdown")]
    };
    let create_path = if has_supported_extension(&normalized, index.case_sensitive()) {
        normalized
    } else {
        format!("{normalized}.md")
    };
    let title = title_from_path(&create_path);

    resolve_path_variants(index, resolution, variants, Some((create_path, title)))
}

fn resolve_bare_wiki_stem(
    index: &WorkspaceLinkIndex,
    mut resolution: LinkResolution,
    stem: &str,
) -> LinkResolution {
    if has_unsupported_extension(stem, index.case_sensitive()) {
        return reject(
            resolution,
            LinkDiagnosticCode::UnsupportedTarget,
            "The wikilink target is not a supported Markdown file.",
        );
    }

    let exact_candidates = index.exact_stem_candidates(stem);
    if exact_candidates.len() == 1 {
        return resolve_entry(index, resolution, exact_candidates[0]);
    }
    if exact_candidates.len() > 1 {
        return ambiguous(resolution, exact_candidates);
    }

    let folded_candidates = index.folded_stem_candidates(stem);
    if folded_candidates.len() == 1 {
        resolution.diagnostics.push(case_mismatch_diagnostic(
            &resolution.source_relative_path,
            stem,
            folded_candidates[0],
        ));
        return resolve_entry(index, resolution, folded_candidates[0]);
    }
    if folded_candidates.len() > 1 {
        resolution.diagnostics.push(diagnostic(
            LinkDiagnosticCode::CaseMismatch,
            LinkDiagnosticSeverity::Warning,
            "The link target differs from one or more candidate paths by letter case.",
            Some(&resolution.source_relative_path),
            Some(stem),
            folded_candidates
                .iter()
                .map(|entry| entry.candidate())
                .collect(),
        ));
        return ambiguous(resolution, folded_candidates);
    }

    let create_path = format!("{}.md", sanitize_create_stem(stem));
    unresolved_with_create(index, resolution, create_path, stem.to_owned())
}

fn resolve_standard_markdown(
    index: &WorkspaceLinkIndex,
    resolution: LinkResolution,
    parts: &LinkParts,
) -> LinkResolution {
    if unsupported_protocol(&parts.target).is_some() {
        return reject(
            resolution,
            LinkDiagnosticCode::UnsupportedProtocol,
            "The link target uses an unsupported protocol.",
        );
    }

    let normalized = if parts.target.is_empty() {
        if parts.fragment.is_some() {
            resolution.source_relative_path.clone()
        } else {
            return reject(
                resolution,
                LinkDiagnosticCode::InvalidPath,
                "The Markdown link target is empty.",
            );
        }
    } else {
        match normalize_relative_markdown_path(&resolution.source_relative_path, &parts.target) {
            Ok(path) => path,
            Err(code) => return reject_with_code(resolution, code),
        }
    };

    if has_unsupported_extension(&normalized, index.case_sensitive()) {
        return reject(
            resolution,
            LinkDiagnosticCode::UnsupportedTarget,
            "The link target is not a supported Markdown file.",
        );
    }

    if !has_supported_extension(&normalized, index.case_sensitive()) {
        return reject(
            resolution,
            LinkDiagnosticCode::UnsupportedTarget,
            "Standard Markdown document links must target .md or .markdown files.",
        );
    }

    let title = title_from_path(&normalized);
    resolve_path_variants(
        index,
        resolution,
        vec![normalized.clone()],
        Some((normalized, title)),
    )
}

fn resolve_path_variants(
    index: &WorkspaceLinkIndex,
    mut resolution: LinkResolution,
    variants: Vec<WorkspaceRelativePath>,
    create: Option<(WorkspaceRelativePath, String)>,
) -> LinkResolution {
    let exact_candidates = variants
        .iter()
        .filter_map(|path| index.exact_path(path))
        .collect::<Vec<_>>();
    if exact_candidates.len() == 1 {
        return resolve_entry(index, resolution, exact_candidates[0]);
    }
    if exact_candidates.len() > 1 {
        return ambiguous(resolution, exact_candidates);
    }

    let folded_candidates = unique_entries(
        variants
            .iter()
            .flat_map(|path| index.folded_path_candidates(path))
            .collect(),
    );
    if folded_candidates.len() == 1 {
        resolution.diagnostics.push(case_mismatch_diagnostic(
            &resolution.source_relative_path,
            variants.first().map(String::as_str).unwrap_or_default(),
            folded_candidates[0],
        ));
        return resolve_entry(index, resolution, folded_candidates[0]);
    }
    if folded_candidates.len() > 1 {
        resolution.diagnostics.push(diagnostic(
            LinkDiagnosticCode::CaseMismatch,
            LinkDiagnosticSeverity::Warning,
            "The link target differs from one or more candidate paths by letter case.",
            Some(&resolution.source_relative_path),
            variants.first().map(String::as_str),
            folded_candidates
                .iter()
                .map(|entry| entry.candidate())
                .collect(),
        ));
        return ambiguous(resolution, folded_candidates);
    }

    if let Some((relative_path, title)) = create {
        return unresolved_with_create(index, resolution, relative_path, title);
    }

    resolution.status = LinkResolutionStatus::Unresolved;
    resolution.diagnostics.push(missing_target_diagnostic(
        &resolution.source_relative_path,
        &resolution.target,
    ));
    resolution
}

fn resolve_entry(
    index: &WorkspaceLinkIndex,
    mut resolution: LinkResolution,
    entry: &LinkIndexEntry,
) -> LinkResolution {
    let candidate = match resolution.fragment.as_deref() {
        Some(fragment) if !fragment.trim().is_empty() => match entry.matching_heading(fragment) {
            Some(heading) => entry.candidate_with_heading(heading),
            None => {
                resolution.diagnostics.push(diagnostic(
                    LinkDiagnosticCode::MissingHeading,
                    LinkDiagnosticSeverity::Warning,
                    "The target Markdown file exists, but the requested heading was not found.",
                    Some(&resolution.source_relative_path),
                    Some(&resolution.target),
                    vec![entry.candidate()],
                ));
                entry.candidate()
            }
        },
        _ => entry.candidate(),
    };

    resolution.status = LinkResolutionStatus::Resolved;
    resolution.open = Some(LinkOpenIntent {
        workspace_id: index.workspace_id().to_owned(),
        relative_path: entry.relative_path.clone(),
        fragment: resolution.fragment.clone(),
    });
    resolution.candidates = vec![candidate];
    resolution
}

fn unresolved_with_create(
    index: &WorkspaceLinkIndex,
    mut resolution: LinkResolution,
    relative_path: WorkspaceRelativePath,
    title: String,
) -> LinkResolution {
    match validate_workspace_relative_path(
        &relative_path,
        index.case_sensitive(),
        WorkspaceOperation::CreateFile,
    ) {
        Ok(relative_path) => {
            let normalized_filename = relative_path
                .rsplit('/')
                .next()
                .unwrap_or(relative_path.as_str())
                .to_owned();
            resolution.status = LinkResolutionStatus::Unresolved;
            resolution.create = Some(LinkCreateIntent {
                workspace_id: index.workspace_id().to_owned(),
                relative_path: relative_path.clone(),
                title,
                normalized_filename,
            });
            resolution.diagnostics.push(missing_target_diagnostic(
                &resolution.source_relative_path,
                &resolution.target,
            ));
            resolution
        }
        Err(_) => reject(
            resolution,
            LinkDiagnosticCode::InvalidPath,
            "The missing link target cannot be converted to a safe Markdown file path.",
        ),
    }
}

fn ambiguous(mut resolution: LinkResolution, candidates: Vec<&LinkIndexEntry>) -> LinkResolution {
    let candidates = candidates
        .into_iter()
        .map(LinkIndexEntry::candidate)
        .collect::<Vec<_>>();
    resolution.status = LinkResolutionStatus::Ambiguous;
    resolution.candidates = candidates.clone();
    resolution.diagnostics.push(diagnostic(
        LinkDiagnosticCode::AmbiguousTarget,
        LinkDiagnosticSeverity::Error,
        "The link target matches multiple Markdown files.",
        Some(&resolution.source_relative_path),
        Some(&resolution.target),
        candidates,
    ));
    resolution
}

fn reject(
    mut resolution: LinkResolution,
    code: LinkDiagnosticCode,
    message: &'static str,
) -> LinkResolution {
    resolution.status = LinkResolutionStatus::Rejected;
    resolution.diagnostics.push(diagnostic(
        code,
        LinkDiagnosticSeverity::Error,
        message,
        Some(&resolution.source_relative_path),
        Some(&resolution.target),
        Vec::new(),
    ));
    resolution
}

fn reject_with_code(resolution: LinkResolution, code: LinkDiagnosticCode) -> LinkResolution {
    match code {
        LinkDiagnosticCode::WorkspaceEscape => reject(
            resolution,
            LinkDiagnosticCode::WorkspaceEscape,
            "The link target resolves outside the selected workspace.",
        ),
        LinkDiagnosticCode::UnsupportedProtocol => reject(
            resolution,
            LinkDiagnosticCode::UnsupportedProtocol,
            "The link target uses an unsupported protocol.",
        ),
        LinkDiagnosticCode::UnsupportedTarget => reject(
            resolution,
            LinkDiagnosticCode::UnsupportedTarget,
            "The link target is not a supported Markdown file.",
        ),
        _ => reject(
            resolution,
            LinkDiagnosticCode::InvalidPath,
            "The link target is not a valid workspace-relative path.",
        ),
    }
}

fn missing_target_diagnostic(source: &str, target: &str) -> LinkDiagnostic {
    diagnostic(
        LinkDiagnosticCode::MissingTarget,
        LinkDiagnosticSeverity::Warning,
        "The link target does not exist in the workspace.",
        Some(source),
        Some(target),
        Vec::new(),
    )
}

fn case_mismatch_diagnostic(source: &str, target: &str, entry: &LinkIndexEntry) -> LinkDiagnostic {
    diagnostic(
        LinkDiagnosticCode::CaseMismatch,
        LinkDiagnosticSeverity::Warning,
        "The link target differs from the indexed Markdown path by letter case.",
        Some(source),
        Some(target),
        vec![entry.candidate()],
    )
}

fn diagnostic(
    code: LinkDiagnosticCode,
    severity: LinkDiagnosticSeverity,
    message: &'static str,
    source_relative_path: Option<&str>,
    target: Option<&str>,
    candidates: Vec<LinkCandidate>,
) -> LinkDiagnostic {
    LinkDiagnostic {
        code,
        severity,
        message: message.to_owned(),
        source_relative_path: source_relative_path.map(str::to_owned),
        target: target.map(str::to_owned),
        candidates,
    }
}

fn base_resolution(
    index: &WorkspaceLinkIndex,
    source_relative_path: &str,
    link: LinkReference,
    parts: &LinkParts,
) -> LinkResolution {
    LinkResolution {
        workspace_id: index.workspace_id().to_owned(),
        source_relative_path: source_relative_path.to_owned(),
        kind: link.kind,
        raw: link.raw,
        target: parts.target.clone(),
        label: link.label,
        alias: parts.alias.clone(),
        display_text: parts.display_text.clone(),
        fragment: parts.fragment.clone(),
        status: LinkResolutionStatus::Rejected,
        open: None,
        create: None,
        candidates: Vec::new(),
        diagnostics: Vec::new(),
    }
}

#[derive(Debug, Clone)]
struct LinkParts {
    target: String,
    alias: Option<String>,
    fragment: Option<String>,
    display_text: String,
}

impl LinkParts {
    fn from_reference(reference: &LinkReference) -> Self {
        let (target_without_alias, alias_from_target) = if reference.kind == LinkKind::ObsidianWiki
        {
            split_once_owned(reference.target.trim(), '|')
        } else {
            (reference.target.trim().to_owned(), None)
        };
        let alias = reference.alias.clone().or(alias_from_target);
        let (target, fragment) = split_once_owned(target_without_alias.trim(), '#');
        let display_text = alias
            .clone()
            .or_else(|| reference.label.clone())
            .unwrap_or_else(|| {
                if target.is_empty() {
                    reference.target.clone()
                } else {
                    target.clone()
                }
            });

        Self {
            target,
            alias,
            fragment: fragment.filter(|fragment| !fragment.trim().is_empty()),
            display_text,
        }
    }
}

fn split_once_owned(value: &str, delimiter: char) -> (String, Option<String>) {
    match value.split_once(delimiter) {
        Some((left, right)) => (left.trim().to_owned(), Some(right.trim().to_owned())),
        None => (value.trim().to_owned(), None),
    }
}

fn looks_path_based(target: &str) -> bool {
    target.contains('/') || has_supported_extension(target, false)
}

fn normalize_workspace_path(target: &str) -> Result<WorkspaceRelativePath, LinkDiagnosticCode> {
    if target.starts_with('/') || target.starts_with("//") || has_windows_drive_prefix(target) {
        return Err(LinkDiagnosticCode::WorkspaceEscape);
    }

    let mut segments = Vec::new();
    for segment in target.split('/') {
        if segment.is_empty() || segment == "." {
            return Err(LinkDiagnosticCode::InvalidPath);
        }
        if segment == ".." {
            return Err(LinkDiagnosticCode::WorkspaceEscape);
        }
        segments.push(segment);
    }

    Ok(segments.join("/"))
}

fn normalize_relative_markdown_path(
    source_relative_path: &str,
    target: &str,
) -> Result<WorkspaceRelativePath, LinkDiagnosticCode> {
    if target.starts_with('/') || target.starts_with("//") || has_windows_drive_prefix(target) {
        return Err(LinkDiagnosticCode::WorkspaceEscape);
    }
    if target.contains('\\') || target.chars().any(char::is_control) {
        return Err(LinkDiagnosticCode::InvalidPath);
    }

    let mut segments = source_relative_path.split('/').collect::<Vec<_>>();
    segments.pop();

    for segment in target.split('/') {
        match segment {
            "" => return Err(LinkDiagnosticCode::InvalidPath),
            "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err(LinkDiagnosticCode::WorkspaceEscape);
                }
            }
            segment => segments.push(segment),
        }
    }

    if segments.is_empty() {
        return Err(LinkDiagnosticCode::InvalidPath);
    }

    Ok(segments.join("/"))
}

fn unsupported_protocol(target: &str) -> Option<&str> {
    let scheme_end = target.find(':')?;
    if scheme_end == 1 && has_windows_drive_prefix(target) {
        return None;
    }
    let scheme = &target[..scheme_end];
    (!scheme.is_empty()
        && scheme.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
        && scheme
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic()))
    .then_some(scheme)
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn has_supported_extension(path: &str, case_sensitive: bool) -> bool {
    path.rsplit('/')
        .next()
        .and_then(|name| supported_markdown_extension(name, case_sensitive))
        .is_some()
}

fn has_unsupported_extension(path: &str, case_sensitive: bool) -> bool {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    file_name.contains('.') && supported_markdown_extension(file_name, case_sensitive).is_none()
}

fn sanitize_create_stem(stem: &str) -> String {
    stem.trim()
        .trim_end_matches(".md")
        .trim_end_matches(".markdown")
        .trim()
        .to_owned()
}

fn title_from_path(relative_path: &str) -> String {
    let file_name = relative_path.rsplit('/').next().unwrap_or(relative_path);
    file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name)
        .to_owned()
}

fn unique_entries(entries: Vec<&LinkIndexEntry>) -> Vec<&LinkIndexEntry> {
    let mut by_path = BTreeMap::new();
    for entry in entries {
        by_path.insert(folded_lookup_key(&entry.relative_path), entry);
    }
    by_path.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::WorkspaceOperation;
    use crate::workspace::validate_workspace_root;
    use std::fs;
    use std::path::Path;

    fn index(root: &Path) -> WorkspaceLinkIndex {
        let record = validate_workspace_root(root, WorkspaceOperation::SelectWorkspace).unwrap();
        WorkspaceLinkIndex::from_record(&record).unwrap()
    }

    fn wiki(target: &str) -> LinkReference {
        LinkReference {
            kind: LinkKind::ObsidianWiki,
            raw: Some(format!("[[{target}]]")),
            label: None,
            target: target.to_owned(),
            alias: None,
        }
    }

    fn markdown(target: &str) -> LinkReference {
        LinkReference {
            kind: LinkKind::StandardMarkdown,
            raw: Some(format!("[label]({target})")),
            label: Some("label".to_owned()),
            target: target.to_owned(),
            alias: None,
        }
    }

    #[test]
    fn resolves_unique_wikilink_by_filename_stem() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("Current.md"), "# Current").unwrap();
        fs::write(temp.path().join("Topic.md"), "# Topic").unwrap();

        let result = resolve_link(&index(temp.path()), "Current.md", wiki("Topic"));

        assert_eq!(result.status, LinkResolutionStatus::Resolved);
        assert_eq!(result.open.unwrap().relative_path, "Topic.md");
    }

    #[test]
    fn preserves_wikilink_alias_as_display_text() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("Current.md"), "# Current").unwrap();
        fs::write(temp.path().join("Topic.md"), "# Topic").unwrap();

        let result = resolve_link(&index(temp.path()), "Current.md", wiki("Topic|Alias"));

        assert_eq!(result.status, LinkResolutionStatus::Resolved);
        assert_eq!(result.target, "Topic");
        assert_eq!(result.alias.as_deref(), Some("Alias"));
        assert_eq!(result.display_text, "Alias");
    }

    #[test]
    fn resolves_path_based_wikilinks_with_or_without_extension() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("notes")).unwrap();
        fs::write(temp.path().join("Current.md"), "# Current").unwrap();
        fs::write(temp.path().join("notes/Topic.md"), "# Topic").unwrap();

        let index = index(temp.path());
        let without_extension = resolve_link(&index, "Current.md", wiki("notes/Topic"));
        let with_extension = resolve_link(&index, "Current.md", wiki("notes/Topic.md"));

        assert_eq!(
            without_extension.open.unwrap().relative_path,
            "notes/Topic.md"
        );
        assert_eq!(with_extension.open.unwrap().relative_path, "notes/Topic.md");
    }

    #[test]
    fn resolves_standard_markdown_links_relative_to_source() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("notes/deep")).unwrap();
        fs::write(temp.path().join("notes/Current.md"), "# Current").unwrap();
        fs::write(temp.path().join("notes/deep/Topic.md"), "# Topic").unwrap();

        let result = resolve_link(
            &index(temp.path()),
            "notes/Current.md",
            markdown("./deep/Topic.md"),
        );

        assert_eq!(result.status, LinkResolutionStatus::Resolved);
        assert_eq!(result.open.unwrap().relative_path, "notes/deep/Topic.md");
    }

    #[test]
    fn resolves_parent_relative_markdown_links_within_workspace() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("notes/deep")).unwrap();
        fs::write(temp.path().join("notes/Topic.md"), "# Topic").unwrap();
        fs::write(temp.path().join("notes/deep/Current.md"), "# Current").unwrap();

        let result = resolve_link(
            &index(temp.path()),
            "notes/deep/Current.md",
            markdown("../Topic.md"),
        );

        assert_eq!(result.status, LinkResolutionStatus::Resolved);
        assert_eq!(result.open.unwrap().relative_path, "notes/Topic.md");
    }

    #[test]
    fn resolves_heading_fragments_and_warns_for_missing_heading() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("Current.md"), "# Current").unwrap();
        fs::write(temp.path().join("Topic.md"), "# Topic\n\n## Deep Thought").unwrap();
        let index = index(temp.path());

        let resolved = resolve_link(&index, "Current.md", wiki("Topic#deep-thought"));
        assert_eq!(resolved.status, LinkResolutionStatus::Resolved);
        assert_eq!(
            resolved.candidates[0].heading.as_ref().unwrap().text,
            "Deep Thought"
        );

        let missing = resolve_link(&index, "Current.md", wiki("Topic#Missing"));
        assert_eq!(missing.status, LinkResolutionStatus::Resolved);
        assert_eq!(
            missing.diagnostics[0].code,
            LinkDiagnosticCode::MissingHeading
        );
    }

    #[test]
    fn unresolved_internal_targets_return_create_intents() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("notes")).unwrap();
        fs::write(temp.path().join("notes/Current.md"), "# Current").unwrap();

        let result = resolve_link(
            &index(temp.path()),
            "notes/Current.md",
            markdown("Missing.md"),
        );

        assert_eq!(result.status, LinkResolutionStatus::Unresolved);
        let create = result.create.unwrap();
        assert_eq!(create.relative_path, "notes/Missing.md");
        assert_eq!(create.normalized_filename, "Missing.md");
    }

    #[test]
    fn duplicate_filename_stems_return_ambiguity() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("archive")).unwrap();
        fs::write(temp.path().join("Current.md"), "# Current").unwrap();
        fs::write(temp.path().join("Topic.md"), "# Topic").unwrap();
        fs::write(temp.path().join("archive/Topic.md"), "# Archived").unwrap();

        let result = resolve_link(&index(temp.path()), "Current.md", wiki("Topic"));

        assert_eq!(result.status, LinkResolutionStatus::Ambiguous);
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(
            result.diagnostics[0].code,
            LinkDiagnosticCode::AmbiguousTarget
        );
    }

    #[test]
    fn case_mismatch_resolves_with_diagnostic() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("Current.md"), "# Current").unwrap();
        fs::write(temp.path().join("Topic.md"), "# Topic").unwrap();

        let result = resolve_link(&index(temp.path()), "Current.md", wiki("topic"));

        assert_eq!(result.status, LinkResolutionStatus::Resolved);
        assert_eq!(result.open.unwrap().relative_path, "Topic.md");
        assert_eq!(result.diagnostics[0].code, LinkDiagnosticCode::CaseMismatch);
    }

    #[test]
    fn rejects_workspace_escape_attempts() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("notes")).unwrap();
        fs::write(temp.path().join("notes/Current.md"), "# Current").unwrap();

        let result = resolve_link(
            &index(temp.path()),
            "notes/Current.md",
            markdown("../../outside.md"),
        );

        assert_eq!(result.status, LinkResolutionStatus::Rejected);
        assert_eq!(
            result.diagnostics[0].code,
            LinkDiagnosticCode::WorkspaceEscape
        );
        assert!(result.open.is_none());
        assert!(result.create.is_none());
    }

    #[test]
    fn rejects_unsupported_protocols_and_non_markdown_targets() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("Current.md"), "# Current").unwrap();
        let index = index(temp.path());

        let protocol = resolve_link(&index, "Current.md", markdown("https://example.test"));
        assert_eq!(protocol.status, LinkResolutionStatus::Rejected);
        assert_eq!(
            protocol.diagnostics[0].code,
            LinkDiagnosticCode::UnsupportedProtocol
        );

        let pdf = resolve_link(&index, "Current.md", markdown("paper.pdf"));
        assert_eq!(pdf.status, LinkResolutionStatus::Rejected);
        assert_eq!(
            pdf.diagnostics[0].code,
            LinkDiagnosticCode::UnsupportedTarget
        );
    }
}
