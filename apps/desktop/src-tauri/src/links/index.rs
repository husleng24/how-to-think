use crate::errors::{WorkspaceError, WorkspaceOperation};
use crate::file_index::index_markdown_files;
use crate::links::model::{
    HeadingAnchor, LinkCandidate, LinkDiagnostic, LinkDiagnosticCode, LinkDiagnosticSeverity,
    LinkIndexFile, LinkIndexSnapshot,
};
use crate::models::{WorkspaceFile, WorkspaceId, WorkspaceRecord, WorkspaceRelativePath};
use crate::path_guard::relative_path_to_path_buf;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct WorkspaceLinkIndex {
    workspace_id: WorkspaceId,
    case_sensitive: bool,
    files: Vec<LinkIndexEntry>,
    by_exact_path: BTreeMap<String, usize>,
    by_folded_path: BTreeMap<String, Vec<usize>>,
    by_exact_stem: BTreeMap<String, Vec<usize>>,
    by_folded_stem: BTreeMap<String, Vec<usize>>,
    diagnostics: Vec<LinkDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkIndexEntry {
    pub relative_path: WorkspaceRelativePath,
    pub absolute_path: PathBuf,
    pub name: String,
    pub stem: String,
    pub path_lookup_key: String,
    pub stem_lookup_key: String,
    pub headings: Vec<HeadingAnchor>,
}

impl WorkspaceLinkIndex {
    pub fn from_record(record: &WorkspaceRecord) -> Result<Self, WorkspaceError> {
        let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)?;
        Self::from_files(record, &files)
    }

    pub fn from_files(
        record: &WorkspaceRecord,
        files: &[WorkspaceFile],
    ) -> Result<Self, WorkspaceError> {
        let mut entries = Vec::new();

        for file in files {
            let absolute_path = record
                .canonical_root
                .join(relative_path_to_path_buf(&file.relative_path));
            let canonical_path = fs::canonicalize(&absolute_path).map_err(|error| {
                WorkspaceError::from_io(
                    WorkspaceOperation::ListFiles,
                    Some(&file.relative_path),
                    &error,
                )
            })?;

            entries.push(LinkIndexEntry {
                relative_path: file.relative_path.clone(),
                absolute_path: canonical_path.clone(),
                name: file.name.clone(),
                stem: file_stem(&file.name),
                path_lookup_key: folded_lookup_key(&file.relative_path),
                stem_lookup_key: folded_lookup_key(&file_stem(&file.name)),
                headings: read_heading_anchors(&canonical_path),
            });
        }

        entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

        let mut index = Self {
            workspace_id: record.info.id.clone(),
            case_sensitive: record.info.case_sensitive,
            files: entries,
            by_exact_path: BTreeMap::new(),
            by_folded_path: BTreeMap::new(),
            by_exact_stem: BTreeMap::new(),
            by_folded_stem: BTreeMap::new(),
            diagnostics: Vec::new(),
        };
        index.rebuild_maps();
        index.diagnostics = index.duplicate_stem_diagnostics();

        Ok(index)
    }

    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    pub fn case_sensitive(&self) -> bool {
        self.case_sensitive
    }

    pub fn files(&self) -> &[LinkIndexEntry] {
        &self.files
    }

    pub fn diagnostics(&self) -> &[LinkDiagnostic] {
        &self.diagnostics
    }

    pub fn snapshot(&self) -> LinkIndexSnapshot {
        LinkIndexSnapshot {
            workspace_id: self.workspace_id.clone(),
            files: self
                .files
                .iter()
                .map(LinkIndexEntry::snapshot_file)
                .collect(),
            diagnostics: self.diagnostics.clone(),
        }
    }

    pub fn exact_path(&self, relative_path: &str) -> Option<&LinkIndexEntry> {
        self.by_exact_path
            .get(relative_path)
            .and_then(|index| self.files.get(*index))
    }

    pub fn folded_path_candidates(&self, relative_path: &str) -> Vec<&LinkIndexEntry> {
        self.candidates_from_indices(
            self.by_folded_path
                .get(&folded_lookup_key(relative_path))
                .into_iter()
                .flatten(),
        )
    }

    pub fn exact_stem_candidates(&self, stem: &str) -> Vec<&LinkIndexEntry> {
        self.candidates_from_indices(self.by_exact_stem.get(stem).into_iter().flatten())
    }

    pub fn folded_stem_candidates(&self, stem: &str) -> Vec<&LinkIndexEntry> {
        self.candidates_from_indices(
            self.by_folded_stem
                .get(&folded_lookup_key(stem))
                .into_iter()
                .flatten(),
        )
    }

    fn rebuild_maps(&mut self) {
        for (index, entry) in self.files.iter().enumerate() {
            self.by_exact_path
                .insert(entry.relative_path.clone(), index);
            self.by_folded_path
                .entry(entry.path_lookup_key.clone())
                .or_default()
                .push(index);
            self.by_exact_stem
                .entry(entry.stem.clone())
                .or_default()
                .push(index);
            self.by_folded_stem
                .entry(entry.stem_lookup_key.clone())
                .or_default()
                .push(index);
        }
    }

    fn duplicate_stem_diagnostics(&self) -> Vec<LinkDiagnostic> {
        let mut diagnostics = Vec::new();

        for (stem_key, indices) in &self.by_folded_stem {
            if indices.len() < 2 {
                continue;
            }

            diagnostics.push(LinkDiagnostic {
                code: LinkDiagnosticCode::DuplicateFilenameStem,
                severity: LinkDiagnosticSeverity::Warning,
                message: format!("Multiple Markdown files share the filename stem '{stem_key}'."),
                source_relative_path: None,
                target: Some(stem_key.clone()),
                candidates: self
                    .candidates_from_indices(indices.iter())
                    .into_iter()
                    .map(LinkIndexEntry::candidate)
                    .collect(),
            });
        }

        diagnostics
    }

    fn candidates_from_indices<'a>(
        &'a self,
        indices: impl Iterator<Item = &'a usize>,
    ) -> Vec<&'a LinkIndexEntry> {
        indices
            .filter_map(|index| self.files.get(*index))
            .collect::<Vec<_>>()
    }
}

impl LinkIndexEntry {
    pub fn candidate(&self) -> LinkCandidate {
        LinkCandidate {
            relative_path: self.relative_path.clone(),
            name: self.name.clone(),
            stem: self.stem.clone(),
            heading: None,
        }
    }

    pub fn candidate_with_heading(&self, heading: HeadingAnchor) -> LinkCandidate {
        LinkCandidate {
            relative_path: self.relative_path.clone(),
            name: self.name.clone(),
            stem: self.stem.clone(),
            heading: Some(heading),
        }
    }

    pub fn matching_heading(&self, fragment: &str) -> Option<HeadingAnchor> {
        let key = heading_reference_key(fragment);

        self.headings.iter().find_map(|heading| {
            (heading_reference_key(&heading.text) == key
                || heading_reference_key(&heading.anchor) == key)
                .then(|| heading.clone())
        })
    }

    fn snapshot_file(&self) -> LinkIndexFile {
        LinkIndexFile {
            relative_path: self.relative_path.clone(),
            absolute_path: self.absolute_path.display().to_string(),
            name: self.name.clone(),
            stem: self.stem.clone(),
            path_lookup_key: self.path_lookup_key.clone(),
            stem_lookup_key: self.stem_lookup_key.clone(),
            headings: self.headings.clone(),
        }
    }
}

pub fn folded_lookup_key(value: &str) -> String {
    value.replace('\\', "/").to_lowercase()
}

pub fn heading_reference_key(value: &str) -> String {
    let trimmed = value.trim().trim_start_matches('#').trim();
    let mut key = String::new();
    let mut pending_separator = false;

    for character in trimmed.chars() {
        if character.is_alphanumeric() {
            if pending_separator && !key.is_empty() {
                key.push('-');
            }
            for lowercase in character.to_lowercase() {
                key.push(lowercase);
            }
            pending_separator = false;
        } else if character.is_whitespace() || character == '-' || character == '_' {
            pending_separator = true;
        }
    }

    key.trim_matches('-').to_owned()
}

fn file_stem(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(name)
        .to_owned()
}

fn read_heading_anchors(path: &PathBuf) -> Vec<HeadingAnchor> {
    let Ok(markdown) = fs::read_to_string(path) else {
        return Vec::new();
    };

    markdown
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            parse_heading_line(line).map(|(level, text)| HeadingAnchor {
                anchor: heading_reference_key(&text),
                text,
                line: index + 1,
                level,
            })
        })
        .collect()
}

fn parse_heading_line(line: &str) -> Option<(u8, String)> {
    let leading_spaces = line
        .chars()
        .take_while(|character| *character == ' ')
        .count();
    if leading_spaces > 3 {
        return None;
    }

    let trimmed = line.trim_start();
    let level = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if level == 0 || level > 6 {
        return None;
    }

    let after_hashes = &trimmed[level..];
    if !after_hashes.is_empty() && !after_hashes.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }

    let mut text = after_hashes.trim().to_owned();
    if let Some(closing_start) = closing_hash_sequence_start(&text) {
        text = text[..closing_start].trim_end().to_owned();
    }

    (!text.is_empty()).then_some((level as u8, text))
}

fn closing_hash_sequence_start(text: &str) -> Option<usize> {
    let trimmed_end = text.trim_end();
    let hash_start = trimmed_end
        .char_indices()
        .rev()
        .find_map(|(index, character)| {
            (character != '#').then_some(index + character.len_utf8())
        })?;

    if hash_start == trimmed_end.len() {
        return None;
    }

    let before_hashes = &trimmed_end[..hash_start];
    before_hashes
        .chars()
        .last()
        .is_some_and(char::is_whitespace)
        .then_some(hash_start)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::WorkspaceOperation;
    use crate::workspace::validate_workspace_root;

    #[test]
    fn builds_workspace_link_index_with_headings_and_duplicates() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("archive")).unwrap();
        fs::write(
            root.join("Topic.md"),
            "# Topic\n\n## Deep Thought\n\nContent",
        )
        .unwrap();
        fs::write(root.join("archive/Topic.md"), "# Archived").unwrap();
        fs::write(root.join("Other.markdown"), "# Other").unwrap();

        let record = validate_workspace_root(root, WorkspaceOperation::SelectWorkspace).unwrap();
        let index = WorkspaceLinkIndex::from_record(&record).unwrap();

        let paths: Vec<_> = index
            .files()
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        assert_eq!(
            paths,
            vec!["Other.markdown", "Topic.md", "archive/Topic.md"]
        );
        assert_eq!(index.diagnostics().len(), 1);
        assert_eq!(
            index.diagnostics()[0].code,
            LinkDiagnosticCode::DuplicateFilenameStem
        );

        let topic = index.exact_path("Topic.md").unwrap();
        assert_eq!(topic.stem, "Topic");
        assert_eq!(
            topic.matching_heading("deep-thought").unwrap().text,
            "Deep Thought"
        );
        assert!(topic.absolute_path.is_absolute());
    }
}
