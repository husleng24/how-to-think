use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::file_index::index_markdown_files;
use crate::models::{
    DocumentExternalChangeStatus, DocumentExternalChangeType, ExternalChangeBatch,
    ExternalChangeEvent, ExternalChangeKind, ExternalChangeSource, FileVersion, WorkspaceFile,
    WorkspaceRecord, WorkspaceRelativePath,
};
use crate::path_guard::validate_workspace_relative_path;
use crate::time_utils::now_iso;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

const EXTERNAL_CHANGE_EVENT: &str = "workspace://external-change";
const WATCH_ERROR_EVENT: &str = "workspace://watch-error";

#[derive(Default)]
pub struct WorkspaceWatchState {
    active: Mutex<Option<ActiveWorkspaceWatch>>,
}

struct ActiveWorkspaceWatch {
    workspace_id: String,
    detector: Arc<Mutex<WorkspaceChangeDetector>>,
    _watcher: Option<RecommendedWatcher>,
    watcher_active: bool,
    watch_error: Option<WorkspaceError>,
}

#[derive(Debug)]
pub struct WorkspaceChangeDetector {
    record: WorkspaceRecord,
    files: BTreeMap<WorkspaceRelativePath, WorkspaceFile>,
}

impl WorkspaceWatchState {
    pub fn start(
        &self,
        app: AppHandle,
        record: WorkspaceRecord,
    ) -> Result<ExternalChangeBatch, WorkspaceError> {
        let detector = Arc::new(Mutex::new(WorkspaceChangeDetector::new(record.clone())?));
        let detector_for_callback = Arc::clone(&detector);
        let app_for_callback = app.clone();
        let workspace_root = record.canonical_root.clone();
        let mut watch_error = None;

        let watcher = match RecommendedWatcher::new(
            move |result| match result {
                Ok(_) => {
                    let refresh = detector_for_callback
                        .lock()
                        .map_err(|_| poisoned_watch_error())
                        .and_then(|mut detector| {
                            detector.refresh(ExternalChangeSource::Watcher, true, None)
                        });

                    match refresh {
                        Ok(batch) if !batch.events.is_empty() => {
                            let _ = app_for_callback.emit(EXTERNAL_CHANGE_EVENT, batch);
                        }
                        Ok(_) => {}
                        Err(error) => {
                            let _ = app_for_callback.emit(WATCH_ERROR_EVENT, error);
                        }
                    }
                }
                Err(error) => {
                    let _ = app_for_callback.emit(WATCH_ERROR_EVENT, watch_unavailable(error));
                }
            },
            Config::default(),
        )
        .and_then(|mut watcher| {
            watcher.watch(&workspace_root, RecursiveMode::Recursive)?;
            Ok(watcher)
        }) {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                watch_error = Some(watch_unavailable(error));
                None
            }
        };

        let watcher_active = watcher.is_some();
        let batch = detector
            .lock()
            .map_err(|_| poisoned_watch_error())?
            .baseline(
                ExternalChangeSource::Watcher,
                watcher_active,
                watch_error.clone(),
            );

        *self.lock_active()? = Some(ActiveWorkspaceWatch {
            workspace_id: record.info.id.clone(),
            detector,
            _watcher: watcher,
            watcher_active,
            watch_error,
        });

        Ok(batch)
    }

    pub fn refresh(&self, record: WorkspaceRecord) -> Result<ExternalChangeBatch, WorkspaceError> {
        let mut active = self.lock_active()?;

        if let Some(active_watch) = active.as_ref() {
            if active_watch.workspace_id == record.info.id {
                return active_watch
                    .detector
                    .lock()
                    .map_err(|_| poisoned_watch_error())?
                    .refresh(
                        ExternalChangeSource::Refresh,
                        active_watch.watcher_active,
                        active_watch.watch_error.clone(),
                    );
            }
        }

        let detector = Arc::new(Mutex::new(WorkspaceChangeDetector::new(record.clone())?));
        let batch = detector
            .lock()
            .map_err(|_| poisoned_watch_error())?
            .baseline(ExternalChangeSource::Refresh, false, None);

        *active = Some(ActiveWorkspaceWatch {
            workspace_id: record.info.id,
            detector,
            _watcher: None,
            watcher_active: false,
            watch_error: None,
        });

        Ok(batch)
    }

    pub fn stop(&self, workspace_id: &str) -> Result<(), WorkspaceError> {
        let mut active = self.lock_active()?;
        if active
            .as_ref()
            .is_some_and(|watch| watch.workspace_id == workspace_id)
        {
            *active = None;
        }
        Ok(())
    }

    fn lock_active(&self) -> Result<MutexGuard<'_, Option<ActiveWorkspaceWatch>>, WorkspaceError> {
        self.active.lock().map_err(|_| poisoned_watch_error())
    }
}

impl WorkspaceChangeDetector {
    pub fn new(record: WorkspaceRecord) -> Result<Self, WorkspaceError> {
        let files = file_map(index_markdown_files(
            &record.canonical_root,
            record.info.case_sensitive,
        )?);

        Ok(Self { record, files })
    }

    pub fn refresh(
        &mut self,
        source: ExternalChangeSource,
        watcher_active: bool,
        watch_error: Option<WorkspaceError>,
    ) -> Result<ExternalChangeBatch, WorkspaceError> {
        let new_files = file_map(index_markdown_files(
            &self.record.canonical_root,
            self.record.info.case_sensitive,
        )?);
        let events = diff_files(&self.record.info.id, &self.files, &new_files, source);
        self.files = new_files;

        Ok(ExternalChangeBatch {
            workspace_id: self.record.info.id.clone(),
            source,
            events,
            files: self.current_files(),
            detected_at: now_iso(),
            watcher_active,
            watch_error,
        })
    }

    pub fn baseline(
        &self,
        source: ExternalChangeSource,
        watcher_active: bool,
        watch_error: Option<WorkspaceError>,
    ) -> ExternalChangeBatch {
        ExternalChangeBatch {
            workspace_id: self.record.info.id.clone(),
            source,
            events: Vec::new(),
            files: self.current_files(),
            detected_at: now_iso(),
            watcher_active,
            watch_error,
        }
    }

    fn current_files(&self) -> Vec<WorkspaceFile> {
        self.files.values().cloned().collect()
    }
}

pub fn document_external_change_status(
    record: &WorkspaceRecord,
    relative_path: &str,
    expected_version: &FileVersion,
) -> Result<DocumentExternalChangeStatus, WorkspaceError> {
    let relative_path = validate_workspace_relative_path(
        relative_path,
        record.info.case_sensitive,
        WorkspaceOperation::WatchWorkspace,
    )?;
    let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)?;
    let current_file = files
        .iter()
        .find(|file| {
            paths_equal(
                &file.relative_path,
                &relative_path,
                record.info.case_sensitive,
            )
        })
        .cloned();
    let moved_file = current_file.is_none().then(|| {
        files
            .iter()
            .find(|file| version_matches_fingerprint(&file.version, expected_version))
            .cloned()
    });
    let moved_file = moved_file.flatten();

    let change_type = if let Some(file) = current_file.as_ref() {
        if file.version == *expected_version {
            DocumentExternalChangeType::Unchanged
        } else {
            DocumentExternalChangeType::Modified
        }
    } else if moved_file.is_some() {
        DocumentExternalChangeType::Moved
    } else {
        DocumentExternalChangeType::Missing
    };

    Ok(DocumentExternalChangeStatus {
        workspace_id: record.info.id.clone(),
        relative_path,
        change_type,
        expected_version: expected_version.clone(),
        current_file,
        moved_to: moved_file.as_ref().map(|file| file.relative_path.clone()),
        moved_file,
        files,
        checked_at: now_iso(),
    })
}

fn diff_files(
    workspace_id: &str,
    old_files: &BTreeMap<WorkspaceRelativePath, WorkspaceFile>,
    new_files: &BTreeMap<WorkspaceRelativePath, WorkspaceFile>,
    source: ExternalChangeSource,
) -> Vec<ExternalChangeEvent> {
    let mut events = Vec::new();
    let mut created_paths: BTreeSet<_> = new_files
        .keys()
        .filter(|path| !old_files.contains_key(*path))
        .cloned()
        .collect();
    let deleted_paths: Vec<_> = old_files
        .keys()
        .filter(|path| !new_files.contains_key(*path))
        .cloned()
        .collect();

    let mut created_by_fingerprint: BTreeMap<String, Vec<WorkspaceRelativePath>> = BTreeMap::new();
    for relative_path in &created_paths {
        if let Some(file) = new_files.get(relative_path) {
            created_by_fingerprint
                .entry(version_fingerprint(&file.version))
                .or_default()
                .push(relative_path.clone());
        }
    }

    for deleted_path in &deleted_paths {
        let Some(old_file) = old_files.get(deleted_path) else {
            continue;
        };
        let fingerprint = version_fingerprint(&old_file.version);
        let Some(candidates) = created_by_fingerprint.get_mut(&fingerprint) else {
            continue;
        };
        let Some(new_path) = candidates
            .iter()
            .find(|path| created_paths.contains(*path))
            .cloned()
        else {
            continue;
        };

        created_paths.remove(&new_path);
        events.push(change_event(
            workspace_id,
            ExternalChangeKind::Renamed,
            new_path.clone(),
            Some(deleted_path.clone()),
            new_files.get(&new_path).cloned(),
            Some(old_file.version.clone()),
            source,
        ));
    }

    for relative_path in old_files
        .keys()
        .filter(|path| new_files.contains_key(*path))
    {
        let old_file = old_files.get(relative_path).expect("old path should exist");
        let new_file = new_files.get(relative_path).expect("new path should exist");

        if old_file.version != new_file.version {
            events.push(change_event(
                workspace_id,
                ExternalChangeKind::Modified,
                relative_path.clone(),
                None,
                Some(new_file.clone()),
                Some(old_file.version.clone()),
                source,
            ));
        }
    }

    for relative_path in created_paths {
        events.push(change_event(
            workspace_id,
            ExternalChangeKind::Created,
            relative_path.clone(),
            None,
            new_files.get(&relative_path).cloned(),
            None,
            source,
        ));
    }

    for relative_path in deleted_paths {
        if events.iter().any(|event| {
            event.kind == ExternalChangeKind::Renamed
                && event.previous_relative_path.as_deref() == Some(relative_path.as_str())
        }) {
            continue;
        }

        let old_file = old_files
            .get(&relative_path)
            .expect("deleted path should exist");
        events.push(change_event(
            workspace_id,
            ExternalChangeKind::Deleted,
            relative_path,
            None,
            None,
            Some(old_file.version.clone()),
            source,
        ));
    }

    events
}

fn change_event(
    workspace_id: &str,
    kind: ExternalChangeKind,
    relative_path: WorkspaceRelativePath,
    previous_relative_path: Option<WorkspaceRelativePath>,
    file: Option<WorkspaceFile>,
    previous_version: Option<FileVersion>,
    source: ExternalChangeSource,
) -> ExternalChangeEvent {
    ExternalChangeEvent {
        workspace_id: workspace_id.to_owned(),
        kind,
        relative_path,
        previous_relative_path,
        file,
        previous_version,
        source,
        detected_at: now_iso(),
    }
}

fn file_map(files: Vec<WorkspaceFile>) -> BTreeMap<WorkspaceRelativePath, WorkspaceFile> {
    files
        .into_iter()
        .map(|file| (file.relative_path.clone(), file))
        .collect()
}

fn paths_equal(left: &str, right: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        left == right
    } else {
        left.eq_ignore_ascii_case(right)
    }
}

fn version_matches_fingerprint(left: &FileVersion, right: &FileVersion) -> bool {
    left.byte_size == right.byte_size && left.content_hash == right.content_hash
}

fn version_fingerprint(version: &FileVersion) -> String {
    format!("{}:{}", version.byte_size, version.content_hash)
}

fn watch_unavailable(error: notify::Error) -> WorkspaceError {
    WorkspaceError::new(
        WorkspaceErrorCode::WatchUnavailable,
        WorkspaceOperation::WatchWorkspace,
        "The workspace filesystem watcher could not be started or read.",
        true,
    )
    .with_detail("source", error.to_string())
}

fn poisoned_watch_error() -> WorkspaceError {
    WorkspaceError::new(
        WorkspaceErrorCode::WatchUnavailable,
        WorkspaceOperation::WatchWorkspace,
        "The workspace filesystem watcher state is unavailable.",
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::validate_workspace_root;
    use std::fs;

    fn record(root: &std::path::Path) -> WorkspaceRecord {
        validate_workspace_root(root, WorkspaceOperation::SelectWorkspace).unwrap()
    }

    #[test]
    fn refresh_detects_external_create_modify_delete_and_deduplicates() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        fs::write(temp.path().join("one.md"), "one").unwrap();
        let mut detector = WorkspaceChangeDetector::new(record).unwrap();

        fs::write(temp.path().join("one.md"), "one changed").unwrap();
        fs::write(temp.path().join("two.markdown"), "two").unwrap();
        let batch = detector
            .refresh(ExternalChangeSource::Refresh, false, None)
            .unwrap();

        let kinds: Vec<_> = batch
            .events
            .iter()
            .map(|event| (&event.kind, event.relative_path.as_str()))
            .collect();
        assert_eq!(
            kinds,
            vec![
                (&ExternalChangeKind::Modified, "one.md"),
                (&ExternalChangeKind::Created, "two.markdown")
            ]
        );

        let duplicate = detector
            .refresh(ExternalChangeSource::Refresh, false, None)
            .unwrap();
        assert!(duplicate.events.is_empty());

        fs::remove_file(temp.path().join("one.md")).unwrap();
        let batch = detector
            .refresh(ExternalChangeSource::Refresh, false, None)
            .unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].kind, ExternalChangeKind::Deleted);
        assert_eq!(batch.events[0].relative_path, "one.md");
    }

    #[test]
    fn refresh_normalizes_rename_when_content_fingerprint_matches() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        fs::write(temp.path().join("old.md"), "same").unwrap();
        let mut detector = WorkspaceChangeDetector::new(record).unwrap();

        fs::rename(temp.path().join("old.md"), temp.path().join("new.md")).unwrap();
        let batch = detector
            .refresh(ExternalChangeSource::Refresh, false, None)
            .unwrap();

        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].kind, ExternalChangeKind::Renamed);
        assert_eq!(batch.events[0].relative_path, "new.md");
        assert_eq!(
            batch.events[0].previous_relative_path.as_deref(),
            Some("old.md")
        );
        assert!(batch.events[0].file.is_some());
    }

    #[test]
    fn manager_refresh_fallback_tracks_changes_without_active_watcher() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        let state = WorkspaceWatchState::default();

        let baseline = state.refresh(record.clone()).unwrap();
        assert!(baseline.events.is_empty());
        assert!(!baseline.watcher_active);

        fs::write(temp.path().join("created.md"), "created").unwrap();
        let batch = state.refresh(record).unwrap();

        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].kind, ExternalChangeKind::Created);
        assert_eq!(batch.events[0].relative_path, "created.md");
        assert!(!batch.watcher_active);
    }

    #[test]
    fn external_status_reports_modified_missing_and_moved_documents() {
        let temp = tempfile::tempdir().unwrap();
        let record = record(temp.path());
        fs::write(temp.path().join("notes.md"), "original").unwrap();
        let original = index_markdown_files(temp.path(), record.info.case_sensitive)
            .unwrap()
            .pop()
            .unwrap();

        fs::write(temp.path().join("notes.md"), "external").unwrap();
        let modified =
            document_external_change_status(&record, "notes.md", &original.version).unwrap();
        assert_eq!(modified.change_type, DocumentExternalChangeType::Modified);
        assert!(modified.current_file.is_some());

        fs::remove_file(temp.path().join("notes.md")).unwrap();
        let missing =
            document_external_change_status(&record, "notes.md", &original.version).unwrap();
        assert_eq!(missing.change_type, DocumentExternalChangeType::Missing);

        fs::write(temp.path().join("notes.md"), "original").unwrap();
        let original = index_markdown_files(temp.path(), record.info.case_sensitive)
            .unwrap()
            .pop()
            .unwrap();
        fs::rename(temp.path().join("notes.md"), temp.path().join("moved.md")).unwrap();
        let moved =
            document_external_change_status(&record, "notes.md", &original.version).unwrap();
        assert_eq!(moved.change_type, DocumentExternalChangeType::Moved);
        assert_eq!(moved.moved_to.as_deref(), Some("moved.md"));
    }
}
