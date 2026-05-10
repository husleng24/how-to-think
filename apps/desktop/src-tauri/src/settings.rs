use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::models::{WorkspaceRecord, WorkspaceRelativePath};
use crate::path_guard::validate_workspace_relative_path;
use crate::workspace::validate_workspace_root;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_RECENT_WORKSPACES: usize = 10;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
    #[serde(default)]
    pub remembered_workspace_id: Option<String>,
    #[serde(default)]
    pub recent_workspaces: Vec<RecentWorkspace>,
    #[serde(default)]
    pub last_opened_files: BTreeMap<String, WorkspaceRelativePath>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    pub id: String,
    pub canonical_path: String,
    pub display_name: String,
    pub display_path: String,
    pub last_opened_at: String,
}

#[derive(Debug, Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> Result<WorkspaceSettings, WorkspaceError> {
        if !self.path.exists() {
            return Ok(WorkspaceSettings::default());
        }

        let content = fs::read_to_string(&self.path).map_err(|error| {
            WorkspaceError::from_io(WorkspaceOperation::LoadWorkspace, None, &error)
                .with_detail("settingsPath", self.path.display().to_string())
        })?;

        serde_json::from_str(&content).map_err(|error| {
            WorkspaceError::new(
                WorkspaceErrorCode::UnknownIoError,
                WorkspaceOperation::LoadWorkspace,
                "Workspace settings could not be parsed.",
                true,
            )
            .with_detail("settingsPath", self.path.display().to_string())
            .with_detail("source", error.to_string())
        })
    }

    pub fn save(&self, settings: &WorkspaceSettings) -> Result<(), WorkspaceError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                WorkspaceError::from_io(WorkspaceOperation::LoadWorkspace, None, &error)
                    .with_detail("settingsPath", self.path.display().to_string())
            })?;
        }

        let content = serde_json::to_vec_pretty(settings).map_err(|error| {
            WorkspaceError::new(
                WorkspaceErrorCode::UnknownIoError,
                WorkspaceOperation::LoadWorkspace,
                "Workspace settings could not be serialized.",
                true,
            )
            .with_detail("source", error.to_string())
        })?;

        fs::write(&self.path, content).map_err(|error| {
            WorkspaceError::from_io(WorkspaceOperation::LoadWorkspace, None, &error)
                .with_detail("settingsPath", self.path.display().to_string())
        })
    }

    pub fn remember_workspace(&self, record: &WorkspaceRecord) -> Result<(), WorkspaceError> {
        let mut settings = self.load()?;
        settings.remembered_workspace_id = Some(record.info.id.clone());
        settings
            .recent_workspaces
            .retain(|workspace| workspace.id != record.info.id);
        settings
            .recent_workspaces
            .insert(0, RecentWorkspace::from_record(record));
        settings.recent_workspaces.truncate(MAX_RECENT_WORKSPACES);
        let retained_workspace_ids: BTreeSet<_> = settings
            .recent_workspaces
            .iter()
            .map(|workspace| workspace.id.clone())
            .collect();
        settings
            .last_opened_files
            .retain(|workspace_id, _| retained_workspace_ids.contains(workspace_id));
        self.save(&settings)
    }

    pub fn remember_last_opened_file(
        &self,
        workspace_id: &str,
        relative_path: &str,
        case_sensitive: bool,
    ) -> Result<(), WorkspaceError> {
        let relative_path = validate_workspace_relative_path(
            relative_path,
            case_sensitive,
            WorkspaceOperation::OpenFile,
        )?;
        let mut settings = self.load()?;

        if !settings
            .recent_workspaces
            .iter()
            .any(|workspace| workspace.id == workspace_id)
        {
            return Err(WorkspaceError::new(
                WorkspaceErrorCode::WorkspaceNotSelected,
                WorkspaceOperation::OpenFile,
                "The requested workspace is not in recent workspace settings.",
                true,
            ));
        }

        settings
            .last_opened_files
            .insert(workspace_id.to_owned(), relative_path);
        self.save(&settings)
    }

    pub fn last_opened_file(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceRelativePath>, WorkspaceError> {
        Ok(self.load()?.last_opened_files.get(workspace_id).cloned())
    }

    pub fn rename_last_opened_file(
        &self,
        workspace_id: &str,
        old_relative_path: &str,
        new_relative_path: &str,
        case_sensitive: bool,
    ) -> Result<(), WorkspaceError> {
        let old_relative_path = validate_workspace_relative_path(
            old_relative_path,
            case_sensitive,
            WorkspaceOperation::RenameFile,
        )?;
        let new_relative_path = validate_workspace_relative_path(
            new_relative_path,
            case_sensitive,
            WorkspaceOperation::RenameFile,
        )?;
        let mut settings = self.load()?;

        if settings
            .last_opened_files
            .get(workspace_id)
            .is_some_and(|path| paths_equal(path, &old_relative_path, case_sensitive))
        {
            settings
                .last_opened_files
                .insert(workspace_id.to_owned(), new_relative_path);
            self.save(&settings)?;
        }

        Ok(())
    }

    pub fn clear_last_opened_file(
        &self,
        workspace_id: &str,
        relative_path: &str,
        case_sensitive: bool,
    ) -> Result<(), WorkspaceError> {
        let relative_path = validate_workspace_relative_path(
            relative_path,
            case_sensitive,
            WorkspaceOperation::DeleteFile,
        )?;
        let mut settings = self.load()?;

        if settings
            .last_opened_files
            .get(workspace_id)
            .is_some_and(|path| paths_equal(path, &relative_path, case_sensitive))
        {
            settings.last_opened_files.remove(workspace_id);
            self.save(&settings)?;
        }

        Ok(())
    }

    pub fn clear_remembered_workspace(&self) -> Result<(), WorkspaceError> {
        let mut settings = self.load()?;
        settings.remembered_workspace_id = None;
        self.save(&settings)
    }

    pub fn remembered_workspace_record(&self) -> Result<Option<WorkspaceRecord>, WorkspaceError> {
        let settings = self.load()?;
        let Some(remembered_workspace_id) = settings.remembered_workspace_id else {
            return Ok(None);
        };

        let Some(recent_workspace) = settings
            .recent_workspaces
            .iter()
            .find(|workspace| workspace.id == remembered_workspace_id)
        else {
            return Ok(None);
        };

        validate_workspace_root(
            Path::new(&recent_workspace.canonical_path),
            WorkspaceOperation::LoadWorkspace,
        )
        .map(Some)
    }

    pub fn workspace_path_for_id(
        &self,
        workspace_id: &str,
        operation: WorkspaceOperation,
    ) -> Result<PathBuf, WorkspaceError> {
        let settings = self.load()?;
        settings
            .recent_workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .map(|workspace| PathBuf::from(&workspace.canonical_path))
            .ok_or_else(|| {
                WorkspaceError::new(
                    WorkspaceErrorCode::WorkspaceNotSelected,
                    operation,
                    "The requested workspace is not in recent workspace settings.",
                    true,
                )
            })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl RecentWorkspace {
    fn from_record(record: &WorkspaceRecord) -> Self {
        Self {
            id: record.info.id.clone(),
            canonical_path: record.canonical_root.display().to_string(),
            display_name: record.info.display_name.clone(),
            display_path: record.info.display_path.clone(),
            last_opened_at: record.info.last_opened_at.clone(),
        }
    }
}

fn paths_equal(left: &str, right: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        left == right
    } else {
        left.eq_ignore_ascii_case(right)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::WorkspaceOperation;
    use crate::workspace::validate_workspace_root;

    #[test]
    fn returns_default_settings_when_file_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(temp.path().join("settings/workspaces.json"));

        assert_eq!(store.load().unwrap(), WorkspaceSettings::default());
    }

    #[test]
    fn remembers_workspace_and_moves_it_to_front_of_recents() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_one = temp.path().join("one");
        let workspace_two = temp.path().join("two");
        fs::create_dir_all(&workspace_one).unwrap();
        fs::create_dir_all(&workspace_two).unwrap();
        let record_one =
            validate_workspace_root(&workspace_one, WorkspaceOperation::SelectWorkspace).unwrap();
        let record_two =
            validate_workspace_root(&workspace_two, WorkspaceOperation::SelectWorkspace).unwrap();
        let store = SettingsStore::new(temp.path().join("settings/workspaces.json"));

        store.remember_workspace(&record_one).unwrap();
        store.remember_workspace(&record_two).unwrap();
        store.remember_workspace(&record_one).unwrap();

        let settings = store.load().unwrap();
        assert_eq!(
            settings.remembered_workspace_id.as_deref(),
            Some(record_one.info.id.as_str())
        );
        assert_eq!(settings.recent_workspaces.len(), 2);
        assert_eq!(settings.recent_workspaces[0].id, record_one.info.id);
        assert_eq!(settings.recent_workspaces[1].id, record_two.info.id);
    }

    #[test]
    fn remembers_last_opened_file_by_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let record =
            validate_workspace_root(&workspace, WorkspaceOperation::SelectWorkspace).unwrap();
        let store = SettingsStore::new(temp.path().join("settings/workspaces.json"));
        store.remember_workspace(&record).unwrap();

        store
            .remember_last_opened_file(&record.info.id, "notes/idea.md", true)
            .unwrap();

        assert_eq!(
            store.last_opened_file(&record.info.id).unwrap().as_deref(),
            Some("notes/idea.md")
        );
    }

    #[test]
    fn rejects_invalid_last_opened_file_references() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let record =
            validate_workspace_root(&workspace, WorkspaceOperation::SelectWorkspace).unwrap();
        let store = SettingsStore::new(temp.path().join("settings/workspaces.json"));
        store.remember_workspace(&record).unwrap();

        let error = store
            .remember_last_opened_file(&record.info.id, "../secret.md", true)
            .unwrap_err();

        assert_eq!(error.code, WorkspaceErrorCode::InvalidRelativePath);
    }

    #[test]
    fn renames_matching_last_opened_file_reference() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let record =
            validate_workspace_root(&workspace, WorkspaceOperation::SelectWorkspace).unwrap();
        let store = SettingsStore::new(temp.path().join("settings/workspaces.json"));
        store.remember_workspace(&record).unwrap();
        store
            .remember_last_opened_file(&record.info.id, "notes/idea.md", true)
            .unwrap();

        store
            .rename_last_opened_file(&record.info.id, "notes/idea.md", "notes/renamed.md", true)
            .unwrap();

        assert_eq!(
            store.last_opened_file(&record.info.id).unwrap().as_deref(),
            Some("notes/renamed.md")
        );
    }

    #[test]
    fn clears_matching_last_opened_file_reference() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let record =
            validate_workspace_root(&workspace, WorkspaceOperation::SelectWorkspace).unwrap();
        let store = SettingsStore::new(temp.path().join("settings/workspaces.json"));
        store.remember_workspace(&record).unwrap();
        store
            .remember_last_opened_file(&record.info.id, "notes/idea.md", true)
            .unwrap();

        store
            .clear_last_opened_file(&record.info.id, "notes/idea.md", true)
            .unwrap();

        assert_eq!(store.last_opened_file(&record.info.id).unwrap(), None);
    }

    #[test]
    fn loads_remembered_workspace_record() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let record =
            validate_workspace_root(&workspace, WorkspaceOperation::SelectWorkspace).unwrap();
        let store = SettingsStore::new(temp.path().join("settings/workspaces.json"));
        store.remember_workspace(&record).unwrap();

        let remembered = store.remembered_workspace_record().unwrap().unwrap();

        assert_eq!(remembered.info.id, record.info.id);
        assert_eq!(remembered.canonical_root, record.canonical_root);
    }
}
