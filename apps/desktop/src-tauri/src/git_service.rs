use crate::documents;
use crate::errors::{WorkspaceError, WorkspaceErrorCode};
use crate::file_index::index_markdown_files;
use crate::git_contracts::{
    is_repository_token_stale, validate_git_workspace_relative_path, GitAuthorIdentity,
    GitBackendInfo, GitBackendKind, GitDiffContentKind, GitDiffFile, GitDiffFileChangeKind,
    GitDiffHunk, GitDiffLine, GitDiffLineKind, GitDiffMode, GitDiffRequest, GitDiffResult,
    GitDiffTruncation, GitExpectedFileState, GitHistoryEntry, GitHistoryRequest, GitOperationError,
    GitOperationErrorCode, GitRepositoryState, GitRepositoryStateKind, GitRepositoryStateToken,
    GitRepositoryWarning, GitRestoreRequest, GitRestoreResult, GitServiceOperation,
    GitSnapshotRequest, GitSnapshotResult, GitStatusChangeKind, GitStatusCounts, GitStatusEntry,
    GitStatusSummary,
};
use crate::models::{
    DocumentSnapshot, IsoDateTime, SaveReason, SaveRequest, WorkspaceRecord, WorkspaceRelativePath,
};
use crate::path_guard::supported_markdown_extension;
use crate::time_utils::now_iso;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const DEFAULT_GIT_EXECUTABLE: &str = "git";
const DEFAULT_HISTORY_LIMIT: usize = 100;
const MAX_HISTORY_LIMIT: usize = 500;
const MAX_DIFF_BYTES: usize = 512 * 1024;
const MAX_DIFF_FILES: usize = 100;
const MAX_DIFF_LINES: usize = 2_000;
const MAX_DIFF_HUNKS_PER_FILE: usize = 200;

pub fn detect_repository(
    record: &WorkspaceRecord,
) -> Result<GitRepositoryState, GitOperationError> {
    GitRepositoryService::default().detect(record)
}

pub fn enable_git_for_workspace(
    record: &WorkspaceRecord,
) -> Result<GitRepositoryState, GitOperationError> {
    GitRepositoryService::default().enable(record)
}

pub fn get_git_status(record: &WorkspaceRecord) -> Result<GitStatusSummary, GitOperationError> {
    GitRepositoryService::default().status(record)
}

pub fn refresh_git_state(record: &WorkspaceRecord) -> Result<GitStatusSummary, GitOperationError> {
    GitRepositoryService::default().refresh_state(record)
}

pub fn create_snapshot(
    record: &WorkspaceRecord,
    request: GitSnapshotRequest,
) -> Result<GitSnapshotResult, GitOperationError> {
    GitRepositoryService::default().create_snapshot(record, request)
}

pub fn list_git_history(
    record: &WorkspaceRecord,
    request: GitHistoryRequest,
) -> Result<Vec<GitHistoryEntry>, GitOperationError> {
    GitRepositoryService::default().list_history(record, request)
}

pub fn get_git_diff(
    record: &WorkspaceRecord,
    request: GitDiffRequest,
) -> Result<GitDiffResult, GitOperationError> {
    GitRepositoryService::default().diff(record, request)
}

pub fn restore_git_file(
    record: &WorkspaceRecord,
    request: GitRestoreRequest,
) -> Result<GitRestoreResult, GitOperationError> {
    GitRepositoryService::default().restore_file(record, request)
}

#[derive(Debug, Clone)]
struct GitRepositoryService {
    git_executable: String,
}

#[derive(Debug, Clone)]
struct GitCommandOutput {
    stdout: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorktreeState {
    Clean,
    MergeOrSequencer,
}

#[derive(Debug, Clone)]
struct RepositoryContext {
    repository_root: PathBuf,
    workspace_prefix_in_repo: Option<WorkspaceRelativePath>,
    repository_prefix_in_workspace: Option<WorkspaceRelativePath>,
}

#[derive(Debug, Clone)]
struct SnapshotEntry {
    workspace_path: WorkspaceRelativePath,
    repo_path: WorkspaceRelativePath,
    previous_repo_path: Option<WorkspaceRelativePath>,
}

impl Default for GitRepositoryService {
    fn default() -> Self {
        Self {
            git_executable: DEFAULT_GIT_EXECUTABLE.to_owned(),
        }
    }
}

impl GitRepositoryService {
    #[cfg(test)]
    fn with_executable(git_executable: impl Into<String>) -> Self {
        Self {
            git_executable: git_executable.into(),
        }
    }

    fn detect(&self, record: &WorkspaceRecord) -> Result<GitRepositoryState, GitOperationError> {
        self.detect_with_operation(record, GitServiceOperation::Detect)
    }

    fn enable(&self, record: &WorkspaceRecord) -> Result<GitRepositoryState, GitOperationError> {
        let current = self.detect_with_operation(record, GitServiceOperation::Init)?;

        match current.state {
            GitRepositoryStateKind::NotRepository => {}
            GitRepositoryStateKind::ValidRepository => return Ok(current),
            state => {
                return Err(GitOperationError::new(
                    blocked_by_state(state),
                    GitServiceOperation::Init,
                    "Git cannot be enabled for the selected workspace in its current repository state.",
                    true,
                ));
            }
        }

        self.run_git_result(
            &record.canonical_root,
            ["init", "--quiet"],
            GitServiceOperation::Init,
        )?;
        self.detect_with_operation(record, GitServiceOperation::Init)
    }

    fn status(&self, record: &WorkspaceRecord) -> Result<GitStatusSummary, GitOperationError> {
        let repository_state = self.detect_with_operation(record, GitServiceOperation::Status)?;
        self.status_for_state(record, repository_state)
    }

    fn refresh_state(
        &self,
        record: &WorkspaceRecord,
    ) -> Result<GitStatusSummary, GitOperationError> {
        let repository_state = self.detect_with_operation(record, GitServiceOperation::Refresh)?;
        match self.status_for_state(record, repository_state.clone()) {
            Ok(status) => Ok(status),
            Err(error)
                if matches!(
                    error.code,
                    GitOperationErrorCode::GitUnavailable
                        | GitOperationErrorCode::RepositoryCorrupt
                        | GitOperationErrorCode::BareRepository
                        | GitOperationErrorCode::PermissionDenied
                        | GitOperationErrorCode::NotRepository
                ) =>
            {
                Ok(empty_status_summary(record, repository_state))
            }
            Err(error) => Err(error),
        }
    }

    fn create_snapshot(
        &self,
        record: &WorkspaceRecord,
        request: GitSnapshotRequest,
    ) -> Result<GitSnapshotResult, GitOperationError> {
        if request.workspace_id != record.info.id {
            return Err(GitOperationError::new(
                GitOperationErrorCode::NotRepository,
                GitServiceOperation::Snapshot,
                "The snapshot request workspace id does not match the selected workspace.",
                true,
            ));
        }

        let message = validate_snapshot_message(&request.message)?;
        validate_snapshot_request_paths(&request)?;

        let repository_state = self.detect_with_operation(record, GitServiceOperation::Snapshot)?;
        self.ensure_snapshot_state(&repository_state)?;

        if is_repository_token_stale(
            Some(&request.expected_repo_token),
            repository_state.token.as_ref(),
        ) {
            return Err(GitOperationError::new(
                GitOperationErrorCode::ExternalStateChanged,
                GitServiceOperation::Snapshot,
                "The repository changed after the UI last refreshed Git status.",
                true,
            ));
        }
        ensure_snapshot_file_states(record, &request.expected_file_states)?;

        let context = repository_context(record, &repository_state, GitServiceOperation::Snapshot)?;
        let status = self.status_for_state(record, repository_state.clone())?;
        let snapshot_entries = select_snapshot_entries(&context, &status.entries, &request)?;

        if snapshot_entries.is_empty() {
            return Err(GitOperationError::new(
                GitOperationErrorCode::NoChanges,
                GitServiceOperation::Snapshot,
                "There are no eligible workspace changes to snapshot.",
                true,
            ));
        }

        let identity = self.resolve_author_identity(&context.repository_root, request.author)?;
        self.stage_snapshot_entries(&context, &snapshot_entries)?;

        if !self.has_staged_changes(&context.repository_root)? {
            return Err(GitOperationError::new(
                GitOperationErrorCode::NoChanges,
                GitServiceOperation::Snapshot,
                "There are no staged workspace changes to commit.",
                true,
            ));
        }

        self.commit_snapshot(&context.repository_root, &message, &identity)?;

        let commit_oid = self
            .run_git_result(
                &context.repository_root,
                ["rev-parse", "--verify", "HEAD"],
                GitServiceOperation::Snapshot,
            )?
            .stdout
            .trim()
            .to_owned();
        let parent_oids = self.parent_oids(&context.repository_root)?;
        let short_commit_oid = short_commit_oid(&commit_oid);
        let affected_paths = snapshot_entries
            .iter()
            .map(|entry| entry.workspace_path.clone())
            .collect::<Vec<_>>();
        let affected_file_count = affected_paths.len();
        let refreshed_status = self.status(record)?;
        let repository_state = refreshed_status.repository_state.clone();

        Ok(GitSnapshotResult {
            workspace_id: record.info.id.clone(),
            commit_oid,
            short_commit_oid,
            parent_oids,
            message,
            affected_paths,
            affected_file_count,
            repository_state,
            status: refreshed_status,
            snapshot_at: now_iso(),
        })
    }

    fn list_history(
        &self,
        record: &WorkspaceRecord,
        request: GitHistoryRequest,
    ) -> Result<Vec<GitHistoryEntry>, GitOperationError> {
        if request.workspace_id != record.info.id {
            return Err(GitOperationError::new(
                GitOperationErrorCode::NotRepository,
                GitServiceOperation::History,
                "The history request workspace id does not match the selected workspace.",
                true,
            ));
        }

        let repository_state = self.detect_with_operation(record, GitServiceOperation::History)?;
        self.ensure_read_state(
            repository_state.state,
            GitServiceOperation::History,
            "Git history is unavailable for the selected workspace in its current repository state.",
        )?;
        let context = repository_context(record, &repository_state, GitServiceOperation::History)?;
        let max_entries = request
            .max_entries
            .unwrap_or(DEFAULT_HISTORY_LIMIT)
            .clamp(1, MAX_HISTORY_LIMIT);
        let repo_path = request
            .relative_path
            .as_deref()
            .map(|path| {
                validate_git_workspace_relative_path(path, GitServiceOperation::History)?;
                workspace_path_to_repo_relative(&context, path).ok_or_else(|| {
                    GitOperationError::new(
                        GitOperationErrorCode::FileNotInHistory,
                        GitServiceOperation::History,
                        "The requested file is outside the addressable Git repository scope.",
                        true,
                    )
                    .with_relative_path(path)
                })
            })
            .transpose()?;

        let mut args = vec![
            OsString::from("-c"),
            OsString::from("core.quotepath=false"),
            OsString::from("log"),
            OsString::from(format!("-n{max_entries}")),
            OsString::from("--date=iso-strict"),
            OsString::from("--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s"),
        ];

        if repo_path.is_some() {
            args.push(OsString::from("--follow"));
        }

        args.push(OsString::from("--"));
        if let Some(path) = &repo_path {
            args.push(OsString::from(path));
        } else if let Some(prefix) = &context.workspace_prefix_in_repo {
            args.push(OsString::from(prefix));
        }

        let output =
            match self.run_git_result(&context.repository_root, args, GitServiceOperation::History)
            {
                Ok(output) => output,
                Err(error) if error.code == GitOperationErrorCode::NoChanges => {
                    return Ok(Vec::new())
                }
                Err(error) => return Err(error),
            };

        let mut entries = Vec::new();
        for line in output.stdout.lines().filter(|line| !line.trim().is_empty()) {
            let fields = line.split('\x1f').collect::<Vec<_>>();
            if fields.len() < 6 {
                continue;
            }

            let commit_oid = fields[0].to_owned();
            let touched_paths =
                self.commit_touched_paths(&context, &commit_oid, repo_path.as_deref())?;
            let affected_file_count = touched_paths.len();

            entries.push(GitHistoryEntry {
                short_commit_oid: short_commit_oid(&commit_oid),
                commit_oid,
                parent_oids: fields[1]
                    .split_whitespace()
                    .filter(|parent| !parent.is_empty())
                    .map(str::to_owned)
                    .collect(),
                author_name: fields[2].to_owned(),
                author_email: fields[3].to_owned(),
                authored_at: fields[4].to_owned(),
                subject: fields[5].to_owned(),
                touched_paths,
                affected_file_count,
            });
        }

        if repo_path.is_some() && entries.is_empty() {
            return Err(GitOperationError::new(
                GitOperationErrorCode::FileNotInHistory,
                GitServiceOperation::History,
                "The requested file was not found in Git history.",
                true,
            )
            .with_relative_path(request.relative_path.unwrap_or_default()));
        }

        Ok(entries)
    }

    fn diff(
        &self,
        record: &WorkspaceRecord,
        request: GitDiffRequest,
    ) -> Result<GitDiffResult, GitOperationError> {
        if request.workspace_id != record.info.id {
            return Err(GitOperationError::new(
                GitOperationErrorCode::NotRepository,
                GitServiceOperation::Diff,
                "The diff request workspace id does not match the selected workspace.",
                true,
            ));
        }

        let repository_state = self.detect_with_operation(record, GitServiceOperation::Diff)?;
        self.ensure_read_state(
            repository_state.state,
            GitServiceOperation::Diff,
            "Git diff is unavailable for the selected workspace in its current repository state.",
        )?;
        let context = repository_context(record, &repository_state, GitServiceOperation::Diff)?;
        let repo_path = request
            .relative_path
            .as_deref()
            .map(|path| {
                validate_git_workspace_relative_path(path, GitServiceOperation::Diff)?;
                workspace_path_to_repo_relative(&context, path).ok_or_else(|| {
                    GitOperationError::new(
                        GitOperationErrorCode::FileNotInHistory,
                        GitServiceOperation::Diff,
                        "The requested path is outside the addressable Git repository scope.",
                        true,
                    )
                    .with_relative_path(path)
                })
            })
            .transpose()?;

        let base_ref = require_ref(request.base_ref.as_deref(), "baseRef")?;
        let resolved_base = self.resolve_commit_ref(&context.repository_root, &base_ref)?;
        let resolved_head = if request.mode == GitDiffMode::RefRange {
            let head_ref = require_ref(request.head_ref.as_deref(), "headRef")?;
            Some(self.resolve_commit_ref(&context.repository_root, &head_ref)?)
        } else {
            None
        };

        let mut args = diff_base_args();
        match request.mode {
            GitDiffMode::WorkingTree => {
                args.push(OsString::from(resolved_base.as_str()));
            }
            GitDiffMode::Staged => {
                args.push(OsString::from("--cached"));
                args.push(OsString::from(resolved_base.as_str()));
            }
            GitDiffMode::RefRange => {
                args.push(OsString::from(resolved_base.as_str()));
                args.push(OsString::from(resolved_head.as_deref().unwrap_or_default()));
            }
        }
        args.push(OsString::from("--"));
        if let Some(path) = &repo_path {
            args.push(OsString::from(path));
        } else if let Some(prefix) = &context.workspace_prefix_in_repo {
            args.push(OsString::from(prefix));
        }

        let output =
            self.run_git_result(&context.repository_root, args, GitServiceOperation::Diff)?;
        let (patch, omitted_byte_count) = truncate_utf8(&output.stdout, MAX_DIFF_BYTES);
        let mut truncation = GitDiffTruncation {
            is_truncated: omitted_byte_count > 0,
            max_bytes: MAX_DIFF_BYTES,
            max_files: MAX_DIFF_FILES,
            max_lines: MAX_DIFF_LINES,
            max_hunks_per_file: MAX_DIFF_HUNKS_PER_FILE,
            included_file_count: 0,
            omitted_file_count: 0,
            included_line_count: 0,
            omitted_line_count: 0,
            omitted_byte_count,
        };
        let files = parse_diff_patch(
            &context,
            &patch,
            record.info.case_sensitive,
            &mut truncation,
        );
        let additions = files.iter().map(|file| file.additions).sum();
        let deletions = files.iter().map(|file| file.deletions).sum();
        let file_count = files.len();

        Ok(GitDiffResult {
            workspace_id: record.info.id.clone(),
            mode: request.mode,
            relative_path: request.relative_path,
            base_ref: request.base_ref,
            head_ref: request.head_ref,
            files,
            file_count,
            additions,
            deletions,
            changed_line_count: additions + deletions,
            truncation,
            generated_at: now_iso(),
        })
    }

    fn restore_file(
        &self,
        record: &WorkspaceRecord,
        request: GitRestoreRequest,
    ) -> Result<GitRestoreResult, GitOperationError> {
        if request.workspace_id != record.info.id {
            return Err(GitOperationError::new(
                GitOperationErrorCode::NotRepository,
                GitServiceOperation::Restore,
                "The restore request workspace id does not match the selected workspace.",
                true,
            ));
        }

        let relative_path =
            validate_restore_path(&request.relative_path, record.info.case_sensitive)?;
        if request.editor_has_unsaved_changes {
            return Err(GitOperationError::new(
                GitOperationErrorCode::RestoreConflict,
                GitServiceOperation::Restore,
                "Restore is blocked while the editor has unsaved changes.",
                true,
            )
            .with_relative_path(relative_path));
        }

        let repository_state = self.detect_with_operation(record, GitServiceOperation::Restore)?;
        self.ensure_restore_state(&repository_state)?;

        if is_repository_token_stale(
            Some(&request.expected_repo_token),
            repository_state.token.as_ref(),
        ) {
            return Err(GitOperationError::new(
                GitOperationErrorCode::ExternalStateChanged,
                GitServiceOperation::Restore,
                "The repository changed after the UI last refreshed Git status.",
                true,
            )
            .with_relative_path(relative_path));
        }

        let context = repository_context(record, &repository_state, GitServiceOperation::Restore)?;
        let repo_path =
            workspace_path_to_repo_relative(&context, &relative_path).ok_or_else(|| {
                GitOperationError::new(
                    GitOperationErrorCode::FileNotInHistory,
                    GitServiceOperation::Restore,
                    "The requested file is outside the addressable Git repository scope.",
                    true,
                )
                .with_relative_path(relative_path.clone())
            })?;
        let restored_from =
            self.resolve_restore_source_ref(&context.repository_root, &request.source_ref)?;
        let restored_content = self.read_historical_markdown_blob(
            &context.repository_root,
            &restored_from,
            &repo_path,
            &relative_path,
        )?;

        let expected_file_version = request.expected_file_version;
        let (snapshot, file_version) = if request.dry_run {
            let snapshot = documents::open_document(record, &relative_path)
                .map_err(workspace_error_to_restore_error)?;
            if snapshot.version != expected_file_version {
                return Err(GitOperationError::new(
                    GitOperationErrorCode::RestoreConflict,
                    GitServiceOperation::Restore,
                    "The Markdown file changed on disk after it was opened or last saved.",
                    true,
                )
                .with_relative_path(relative_path)
                .with_detail("expectedToken", expected_file_version.token)
                .with_detail("currentToken", snapshot.version.token));
            }
            let file_version = snapshot.version.clone();
            (snapshot, file_version)
        } else {
            let save = documents::save_document(
                record,
                SaveRequest {
                    workspace_id: record.info.id.clone(),
                    relative_path: relative_path.clone(),
                    content: restored_content.clone(),
                    expected_version: expected_file_version,
                    reason: SaveReason::Manual,
                },
            )
            .map_err(workspace_error_to_restore_error)?;
            let snapshot = DocumentSnapshot {
                workspace_id: record.info.id.clone(),
                relative_path: relative_path.clone(),
                content: restored_content,
                version: save.version.clone(),
                opened_at: now_iso(),
            };
            (snapshot, save.version)
        };

        let status = self.status(record)?;
        let repository_state = status.repository_state.clone();

        Ok(GitRestoreResult {
            workspace_id: record.info.id.clone(),
            relative_path,
            restored_from,
            snapshot,
            file_version,
            repository_state,
            status,
            restored_at: now_iso(),
        })
    }

    fn ensure_read_state(
        &self,
        state: GitRepositoryStateKind,
        operation: GitServiceOperation,
        message: &'static str,
    ) -> Result<(), GitOperationError> {
        if matches!(
            state,
            GitRepositoryStateKind::ValidRepository
                | GitRepositoryStateKind::NestedRepository
                | GitRepositoryStateKind::ParentRepository
                | GitRepositoryStateKind::DetachedHead
                | GitRepositoryStateKind::MergeConflict
        ) {
            Ok(())
        } else {
            Err(GitOperationError::new(
                blocked_by_state(state),
                operation,
                message,
                true,
            ))
        }
    }

    fn commit_touched_paths(
        &self,
        context: &RepositoryContext,
        commit_oid: &str,
        repo_path: Option<&str>,
    ) -> Result<Vec<WorkspaceRelativePath>, GitOperationError> {
        let mut args = vec![
            OsString::from("-c"),
            OsString::from("core.quotepath=false"),
            OsString::from("show"),
            OsString::from("--format="),
            OsString::from("--name-only"),
            OsString::from("-z"),
            OsString::from("--find-renames"),
            OsString::from(commit_oid),
            OsString::from("--"),
        ];

        if let Some(path) = repo_path {
            args.push(OsString::from(path));
        } else if let Some(prefix) = &context.workspace_prefix_in_repo {
            args.push(OsString::from(prefix));
        }

        let output =
            self.run_git_result(&context.repository_root, args, GitServiceOperation::History)?;
        let mut paths = output
            .stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .filter_map(|path| repo_path_to_workspace_relative(context, path))
            .collect::<BTreeSet<_>>();

        if let Some(prefix) = &context.repository_prefix_in_workspace {
            paths.retain(|path| path == prefix || path.starts_with(&format!("{prefix}/")));
        }

        Ok(paths.into_iter().collect())
    }

    fn resolve_commit_ref(&self, cwd: &Path, value: &str) -> Result<String, GitOperationError> {
        let value = value.trim();
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err(invalid_ref_error(
                "Git diff refs must be non-empty commit references.",
            ));
        }

        let peeled = format!("{value}^{{commit}}");
        self.run_git_result(
            cwd,
            [
                OsString::from("rev-parse"),
                OsString::from("--verify"),
                OsString::from("--end-of-options"),
                OsString::from(peeled),
            ],
            GitServiceOperation::Diff,
        )
        .map(|output| output.stdout.trim().to_owned())
        .map_err(|error| {
            if matches!(
                error.code,
                GitOperationErrorCode::InvalidRef | GitOperationErrorCode::UnknownGitError
            ) {
                invalid_ref_error("The requested Git revision could not be resolved to a commit.")
            } else {
                error
            }
        })
    }

    fn status_for_state(
        &self,
        record: &WorkspaceRecord,
        repository_state: GitRepositoryState,
    ) -> Result<GitStatusSummary, GitOperationError> {
        if repository_state.state == GitRepositoryStateKind::NotRepository {
            return Ok(empty_status_summary(record, repository_state));
        }

        if !matches!(
            repository_state.state,
            GitRepositoryStateKind::ValidRepository
                | GitRepositoryStateKind::NestedRepository
                | GitRepositoryStateKind::ParentRepository
                | GitRepositoryStateKind::DetachedHead
                | GitRepositoryStateKind::MergeConflict
        ) {
            return Err(GitOperationError::new(
                blocked_by_state(repository_state.state),
                GitServiceOperation::Status,
                "Git status is unavailable for the selected workspace in its current repository state.",
                true,
            ));
        }

        let context = repository_context(record, &repository_state, GitServiceOperation::Status)?;
        let mut entries = self.status_entries(record, &context)?;
        entries.extend(self.ignored_status_entries(record, &context, &entries)?);
        entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

        Ok(status_summary(record, repository_state, entries))
    }

    fn status_entries(
        &self,
        record: &WorkspaceRecord,
        context: &RepositoryContext,
    ) -> Result<Vec<GitStatusEntry>, GitOperationError> {
        let output = self.run_git_result(
            &context.repository_root,
            [
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--find-renames",
            ],
            GitServiceOperation::Status,
        )?;

        Ok(parse_status_entries(
            record,
            context,
            &output.stdout,
            GitServiceOperation::Status,
        ))
    }

    fn ignored_status_entries(
        &self,
        record: &WorkspaceRecord,
        context: &RepositoryContext,
        existing_entries: &[GitStatusEntry],
    ) -> Result<Vec<GitStatusEntry>, GitOperationError> {
        let output = self.run_git_result(
            &context.repository_root,
            [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "-z",
            ],
            GitServiceOperation::Status,
        )?;
        let existing = existing_entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<BTreeSet<_>>();

        Ok(output
            .stdout
            .split('\0')
            .filter(|path| !path.is_empty())
            .filter_map(|repo_path| {
                let relative_path = repo_path_to_workspace_relative(context, repo_path)?;
                if existing.contains(relative_path.as_str())
                    || !is_workspace_visible_markdown(&relative_path, record.info.case_sensitive)
                    || validate_git_workspace_relative_path(
                        &relative_path,
                        GitServiceOperation::Status,
                    )
                    .is_err()
                {
                    return None;
                }

                Some(GitStatusEntry {
                    relative_path,
                    previous_relative_path: None,
                    staged: GitStatusChangeKind::Unmodified,
                    unstaged: GitStatusChangeKind::Ignored,
                    conflicted: false,
                })
            })
            .collect())
    }

    fn ensure_snapshot_state(
        &self,
        repository_state: &GitRepositoryState,
    ) -> Result<(), GitOperationError> {
        if matches!(
            repository_state.state,
            GitRepositoryStateKind::ValidRepository | GitRepositoryStateKind::NestedRepository
        ) && repository_state.token.is_some()
        {
            return Ok(());
        }

        let code = if matches!(
            repository_state.state,
            GitRepositoryStateKind::ValidRepository | GitRepositoryStateKind::NestedRepository
        ) {
            GitOperationErrorCode::ExternalStateChanged
        } else {
            blocked_by_state(repository_state.state)
        };

        Err(GitOperationError::new(
            code,
            GitServiceOperation::Snapshot,
            "Git snapshot creation is blocked for the selected workspace in its current repository state.",
            true,
        ))
    }

    fn ensure_restore_state(
        &self,
        repository_state: &GitRepositoryState,
    ) -> Result<(), GitOperationError> {
        if matches!(
            repository_state.state,
            GitRepositoryStateKind::ValidRepository | GitRepositoryStateKind::NestedRepository
        ) && repository_state.token.is_some()
        {
            return Ok(());
        }

        let code = if matches!(
            repository_state.state,
            GitRepositoryStateKind::ValidRepository | GitRepositoryStateKind::NestedRepository
        ) {
            GitOperationErrorCode::ExternalStateChanged
        } else {
            blocked_by_state(repository_state.state)
        };

        Err(GitOperationError::new(
            code,
            GitServiceOperation::Restore,
            "Git restore is blocked for the selected workspace in its current repository state.",
            true,
        ))
    }

    fn resolve_restore_source_ref(
        &self,
        cwd: &Path,
        value: &str,
    ) -> Result<String, GitOperationError> {
        let value = require_restore_ref(value)?;
        let peeled = format!("{value}^{{commit}}");

        self.run_git_result(
            cwd,
            [
                OsString::from("rev-parse"),
                OsString::from("--verify"),
                OsString::from("--end-of-options"),
                OsString::from(peeled),
            ],
            GitServiceOperation::Restore,
        )
        .map(|output| output.stdout.trim().to_owned())
        .map_err(|error| {
            if matches!(
                error.code,
                GitOperationErrorCode::InvalidRef | GitOperationErrorCode::UnknownGitError
            ) {
                restore_invalid_ref_error(
                    "The requested Git revision could not be resolved to a commit.",
                )
            } else {
                error
            }
        })
    }

    fn read_historical_markdown_blob(
        &self,
        cwd: &Path,
        commit_oid: &str,
        repo_path: &str,
        relative_path: &str,
    ) -> Result<String, GitOperationError> {
        let object_spec = format!("{commit_oid}:{repo_path}");
        let object_type = self
            .run_git_result(
                cwd,
                [
                    OsString::from("cat-file"),
                    OsString::from("-t"),
                    OsString::from(object_spec.clone()),
                ],
                GitServiceOperation::Restore,
            )
            .map_err(|error| historical_blob_error(error, relative_path))?
            .stdout
            .trim()
            .to_owned();

        if object_type != "blob" {
            return Err(GitOperationError::new(
                GitOperationErrorCode::FileNotInHistory,
                GitServiceOperation::Restore,
                "The requested historical path is not a file blob.",
                true,
            )
            .with_relative_path(relative_path));
        }

        let output = self
            .raw_git_output(
                Some(cwd),
                [
                    OsString::from("cat-file"),
                    OsString::from("blob"),
                    OsString::from(object_spec),
                ],
            )
            .map_err(|error| git_error_from_io(GitServiceOperation::Restore, &error))?;

        if !output.status.success() {
            return Err(historical_blob_error(
                git_error_from_output(GitServiceOperation::Restore, &output),
                relative_path,
            ));
        }

        String::from_utf8(output.stdout).map_err(|error| {
            GitOperationError::new(
                GitOperationErrorCode::RestoreConflict,
                GitServiceOperation::Restore,
                "The historical Markdown file is not valid UTF-8 and cannot be restored safely.",
                true,
            )
            .with_relative_path(relative_path)
            .with_detail("source", error.to_string())
        })
    }

    fn resolve_author_identity(
        &self,
        cwd: &Path,
        author: Option<GitAuthorIdentity>,
    ) -> Result<GitAuthorIdentity, GitOperationError> {
        if let Some(author) = author {
            return validate_author_identity(author);
        }

        let name = self
            .run_git_result(
                cwd,
                ["config", "--get", "user.name"],
                GitServiceOperation::Snapshot,
            )
            .ok()
            .and_then(|output| non_empty_trimmed(output.stdout));
        let email = self
            .run_git_result(
                cwd,
                ["config", "--get", "user.email"],
                GitServiceOperation::Snapshot,
            )
            .ok()
            .and_then(|output| non_empty_trimmed(output.stdout));

        match (name, email) {
            (Some(name), Some(email)) => validate_author_identity(GitAuthorIdentity { name, email }),
            _ => Err(GitOperationError::new(
                GitOperationErrorCode::IdentityMissing,
                GitServiceOperation::Snapshot,
                "Git author identity is missing. Configure user.name and user.email or provide an explicit snapshot author.",
                true,
            )),
        }
    }

    fn stage_snapshot_entries(
        &self,
        context: &RepositoryContext,
        entries: &[SnapshotEntry],
    ) -> Result<(), GitOperationError> {
        let mut repo_paths = BTreeSet::new();
        for entry in entries {
            repo_paths.insert(entry.repo_path.clone());
            if let Some(previous_path) = &entry.previous_repo_path {
                repo_paths.insert(previous_path.clone());
            }
        }

        let mut args = vec![
            OsString::from("add"),
            OsString::from("--all"),
            OsString::from("--"),
        ];
        args.extend(repo_paths.into_iter().map(OsString::from));

        self.run_git_result(
            &context.repository_root,
            args,
            GitServiceOperation::Snapshot,
        )
        .map(|_| ())
    }

    fn has_staged_changes(&self, cwd: &Path) -> Result<bool, GitOperationError> {
        match self.raw_git_output(Some(cwd), ["diff", "--cached", "--quiet", "--"]) {
            Ok(output) if output.status.success() => Ok(false),
            Ok(output) if output.status.code() == Some(1) => Ok(true),
            Ok(output) => Err(git_error_from_output(
                GitServiceOperation::Snapshot,
                &output,
            )),
            Err(error) => Err(git_error_from_io(GitServiceOperation::Snapshot, &error)),
        }
    }

    fn commit_snapshot(
        &self,
        cwd: &Path,
        message: &str,
        identity: &GitAuthorIdentity,
    ) -> Result<(), GitOperationError> {
        let args = vec![
            OsString::from("commit"),
            OsString::from("--quiet"),
            OsString::from("--message"),
            OsString::from(message),
        ];
        let env = [
            ("GIT_AUTHOR_NAME", identity.name.as_str()),
            ("GIT_AUTHOR_EMAIL", identity.email.as_str()),
            ("GIT_COMMITTER_NAME", identity.name.as_str()),
            ("GIT_COMMITTER_EMAIL", identity.email.as_str()),
        ];

        self.run_git_result_with_env(cwd, args, GitServiceOperation::Snapshot, &env)
            .map(|_| ())
    }

    fn parent_oids(&self, cwd: &Path) -> Result<Vec<String>, GitOperationError> {
        let output = self.run_git_result(
            cwd,
            ["rev-list", "--parents", "-n", "1", "HEAD"],
            GitServiceOperation::Snapshot,
        )?;
        let mut parts = output.stdout.split_whitespace();
        let _commit = parts.next();
        Ok(parts.map(str::to_owned).collect())
    }

    fn detect_with_operation(
        &self,
        record: &WorkspaceRecord,
        operation: GitServiceOperation,
    ) -> Result<GitRepositoryState, GitOperationError> {
        let backend = match self.backend_info() {
            Ok(backend) => backend,
            Err(error) => {
                return Ok(base_state(
                    record,
                    GitRepositoryStateKind::GitUnavailable,
                    unavailable_backend(),
                    None,
                    None,
                    Some(error.code),
                    Vec::new(),
                ));
            }
        };

        if let Err(error) = fs::read_dir(&record.canonical_root) {
            return Ok(base_state(
                record,
                map_io_state(&error),
                backend,
                None,
                None,
                Some(map_io_code(&error)),
                Vec::new(),
            ));
        }

        let root_git_entry = record.canonical_root.join(".git");
        let root_git_entry_exists = root_git_entry.exists();

        if self.is_bare_repository(&record.canonical_root)? {
            return Ok(base_state(
                record,
                GitRepositoryStateKind::BareRepository,
                backend,
                Some(record.canonical_root.clone()),
                None,
                Some(GitOperationErrorCode::BareRepository),
                Vec::new(),
            ));
        }

        match self.git_output(&record.canonical_root, ["rev-parse", "--show-toplevel"]) {
            Ok(output) => {
                let repository_root =
                    normalize_git_path(&record.canonical_root, output.stdout.trim());
                let repository_root = canonicalize_lossy(&repository_root);

                if paths_equal(&repository_root, &record.canonical_root) {
                    return self.repository_state_for_root(record, backend, repository_root);
                }

                if record.canonical_root.starts_with(&repository_root) {
                    return self.parent_repository_state(record, backend, repository_root);
                }

                Ok(base_state(
                    record,
                    GitRepositoryStateKind::RepositoryCorrupt,
                    backend,
                    Some(repository_root),
                    None,
                    Some(GitOperationErrorCode::RepositoryCorrupt),
                    Vec::new(),
                ))
            }
            Err(error) => {
                if root_git_entry_exists {
                    let state = if error.code == GitOperationErrorCode::PermissionDenied {
                        GitRepositoryStateKind::PermissionDenied
                    } else {
                        GitRepositoryStateKind::RepositoryCorrupt
                    };
                    return Ok(base_state(
                        record,
                        state,
                        backend,
                        Some(record.canonical_root.clone()),
                        None,
                        Some(blocked_by_state(state)),
                        Vec::new(),
                    ));
                }

                if error.code == GitOperationErrorCode::PermissionDenied {
                    return Ok(base_state(
                        record,
                        GitRepositoryStateKind::PermissionDenied,
                        backend,
                        None,
                        None,
                        Some(GitOperationErrorCode::PermissionDenied),
                        Vec::new(),
                    ));
                }

                if let Some(nested_root) = first_nested_repository_root(&record.canonical_root)? {
                    return self.nested_repository_state(record, backend, nested_root);
                }

                if operation == GitServiceOperation::Init
                    || operation == GitServiceOperation::Detect
                {
                    return Ok(base_state(
                        record,
                        GitRepositoryStateKind::NotRepository,
                        backend,
                        None,
                        None,
                        None,
                        Vec::new(),
                    ));
                }

                Ok(base_state(
                    record,
                    GitRepositoryStateKind::NotRepository,
                    backend,
                    None,
                    None,
                    None,
                    Vec::new(),
                ))
            }
        }
    }

    fn repository_state_for_root(
        &self,
        record: &WorkspaceRecord,
        backend: GitBackendInfo,
        repository_root: PathBuf,
    ) -> Result<GitRepositoryState, GitOperationError> {
        let (branch_name, head_oid, detached) = self.head_state(&repository_root)?;
        let git_dir = self.git_dir(&repository_root)?;
        let worktree_state = self.worktree_state(&repository_root, &git_dir)?;
        let nested_root = first_nested_repository_root(&record.canonical_root)?;
        let checked_at = now_iso();
        let token =
            self.repository_token(&repository_root, &git_dir, head_oid.clone(), &checked_at)?;

        let (state, blocked_reason, warnings) = if nested_root.is_some() {
            (
                GitRepositoryStateKind::NestedRepository,
                Some(GitOperationErrorCode::NestedRepository),
                vec![GitRepositoryWarning {
                    code: "nested_repository_detected".to_owned(),
                    message: "A nested Git repository exists below the selected workspace."
                        .to_owned(),
                }],
            )
        } else if worktree_state == WorktreeState::MergeOrSequencer {
            (
                GitRepositoryStateKind::MergeConflict,
                Some(GitOperationErrorCode::MergeConflict),
                Vec::new(),
            )
        } else if detached {
            (
                GitRepositoryStateKind::DetachedHead,
                Some(GitOperationErrorCode::DetachedHead),
                Vec::new(),
            )
        } else {
            (GitRepositoryStateKind::ValidRepository, None, Vec::new())
        };

        Ok(GitRepositoryState {
            workspace_id: record.info.id.clone(),
            state,
            backend,
            selected_root_display_path: record.canonical_root.display().to_string(),
            repository_root_display_path: Some(repository_root.display().to_string()),
            relative_prefix: None,
            branch_name,
            head_oid,
            token: Some(token),
            blocked_reason,
            warnings,
            checked_at,
        })
    }

    fn parent_repository_state(
        &self,
        record: &WorkspaceRecord,
        backend: GitBackendInfo,
        repository_root: PathBuf,
    ) -> Result<GitRepositoryState, GitOperationError> {
        let (branch_name, head_oid, _) = self.head_state(&record.canonical_root)?;
        let git_dir = self.git_dir(&record.canonical_root)?;
        let checked_at = now_iso();
        let token = self.repository_token(
            &record.canonical_root,
            &git_dir,
            head_oid.clone(),
            &checked_at,
        )?;

        Ok(GitRepositoryState {
            workspace_id: record.info.id.clone(),
            state: GitRepositoryStateKind::ParentRepository,
            backend,
            selected_root_display_path: record.canonical_root.display().to_string(),
            repository_root_display_path: Some(repository_root.display().to_string()),
            relative_prefix: relative_path_between(&repository_root, &record.canonical_root),
            branch_name,
            head_oid,
            token: Some(token),
            blocked_reason: Some(GitOperationErrorCode::ParentRepository),
            warnings: vec![GitRepositoryWarning {
                code: "parent_repository_scope".to_owned(),
                message: "The selected workspace is inside a parent Git repository.".to_owned(),
            }],
            checked_at,
        })
    }

    fn nested_repository_state(
        &self,
        record: &WorkspaceRecord,
        backend: GitBackendInfo,
        nested_root: PathBuf,
    ) -> Result<GitRepositoryState, GitOperationError> {
        let nested_root = canonicalize_lossy(&nested_root);
        let (branch_name, head_oid, detached) =
            self.head_state(&nested_root).unwrap_or((None, None, false));
        let checked_at = now_iso();
        let token = self
            .git_dir(&nested_root)
            .and_then(|git_dir| {
                self.repository_token(&nested_root, &git_dir, head_oid.clone(), &checked_at)
            })
            .ok();

        Ok(GitRepositoryState {
            workspace_id: record.info.id.clone(),
            state: if detached {
                GitRepositoryStateKind::DetachedHead
            } else {
                GitRepositoryStateKind::NestedRepository
            },
            backend,
            selected_root_display_path: record.canonical_root.display().to_string(),
            repository_root_display_path: Some(nested_root.display().to_string()),
            relative_prefix: relative_path_between(&record.canonical_root, &nested_root),
            branch_name,
            head_oid,
            token,
            blocked_reason: Some(if detached {
                GitOperationErrorCode::DetachedHead
            } else {
                GitOperationErrorCode::NestedRepository
            }),
            warnings: vec![GitRepositoryWarning {
                code: "nested_repository_detected".to_owned(),
                message: "A nested Git repository exists below the selected workspace.".to_owned(),
            }],
            checked_at,
        })
    }

    fn backend_info(&self) -> Result<GitBackendInfo, GitOperationError> {
        match self.raw_git_output(None, ["--version"]) {
            Ok(output) if output.status.success() => Ok(GitBackendInfo {
                kind: GitBackendKind::SystemGit,
                version: Some(String::from_utf8_lossy(&output.stdout).trim().to_owned()),
                executable_display_path: Some(self.git_executable.clone()),
            }),
            Ok(output) => Err(GitOperationError::new(
                GitOperationErrorCode::GitUnavailable,
                GitServiceOperation::Detect,
                command_error_message("Git is unavailable.", &output),
                true,
            )),
            Err(error) => Err(GitOperationError::new(
                if error.kind() == io::ErrorKind::PermissionDenied {
                    GitOperationErrorCode::PermissionDenied
                } else {
                    GitOperationErrorCode::GitUnavailable
                },
                GitServiceOperation::Detect,
                format!("The system Git executable could not be started: {error}"),
                true,
            )),
        }
    }

    fn is_bare_repository(&self, cwd: &Path) -> Result<bool, GitOperationError> {
        match self.git_output(cwd, ["rev-parse", "--is-bare-repository"]) {
            Ok(output) => Ok(output.stdout.trim() == "true"),
            Err(error) if error.code == GitOperationErrorCode::NotRepository => Ok(false),
            Err(error) if error.code == GitOperationErrorCode::RepositoryCorrupt => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn head_state(
        &self,
        cwd: &Path,
    ) -> Result<(Option<String>, Option<String>, bool), GitOperationError> {
        let branch_name = self
            .git_output(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
            .ok()
            .and_then(|output| non_empty_trimmed(output.stdout));
        let head_oid = self
            .git_output(cwd, ["rev-parse", "--verify", "HEAD"])
            .ok()
            .and_then(|output| non_empty_trimmed(output.stdout));
        let detached = branch_name.is_none() && head_oid.is_some();

        Ok((branch_name, head_oid, detached))
    }

    fn git_dir(&self, cwd: &Path) -> Result<PathBuf, GitOperationError> {
        let output =
            self.run_git_result(cwd, ["rev-parse", "--git-dir"], GitServiceOperation::Detect)?;
        Ok(normalize_git_path(cwd, output.stdout.trim()))
    }

    fn worktree_state(
        &self,
        cwd: &Path,
        git_dir: &Path,
    ) -> Result<WorktreeState, GitOperationError> {
        for marker in [
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "rebase-apply",
            "rebase-merge",
        ] {
            if git_dir.join(marker).exists() {
                return Ok(WorktreeState::MergeOrSequencer);
            }
        }

        let output = self.run_git_result(
            cwd,
            ["status", "--porcelain=v1", "--untracked-files=no"],
            GitServiceOperation::Detect,
        )?;

        for line in output.stdout.lines() {
            let status = line.as_bytes();
            if status.len() >= 2
                && matches!(
                    (status[0], status[1]),
                    (b'U', _)
                        | (_, b'U')
                        | (b'A', b'A')
                        | (b'D', b'D')
                        | (b'A', b'D')
                        | (b'D', b'A')
                )
            {
                return Ok(WorktreeState::MergeOrSequencer);
            }
        }

        Ok(WorktreeState::Clean)
    }

    fn repository_token(
        &self,
        cwd: &Path,
        git_dir: &Path,
        head_oid: Option<String>,
        captured_at: &IsoDateTime,
    ) -> Result<GitRepositoryStateToken, GitOperationError> {
        let (index_version, index_checksum) = index_token_parts(&git_dir.join("index"))?;
        let status_output = self.run_git_result(
            cwd,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            GitServiceOperation::Detect,
        )?;
        let worktree_status_generation = sha256_hex(status_output.stdout.as_bytes());
        let token = sha256_hex(
            format!(
                "head={:?};index={:?};checksum={:?};status={}",
                head_oid, index_version, index_checksum, worktree_status_generation
            )
            .as_bytes(),
        );

        Ok(GitRepositoryStateToken {
            token,
            head_oid,
            index_version,
            index_checksum,
            worktree_status_generation,
            captured_at: captured_at.clone(),
        })
    }

    fn git_output<I, S>(&self, cwd: &Path, args: I) -> Result<GitCommandOutput, GitOperationError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.run_git_result(cwd, args, GitServiceOperation::Detect)
    }

    fn run_git_result<I, S>(
        &self,
        cwd: &Path,
        args: I,
        operation: GitServiceOperation,
    ) -> Result<GitCommandOutput, GitOperationError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        match self.raw_git_output(Some(cwd), args) {
            Ok(output) if output.status.success() => Ok(GitCommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            }),
            Ok(output) => Err(git_error_from_output(operation, &output)),
            Err(error) => Err(git_error_from_io(operation, &error)),
        }
    }

    fn run_git_result_with_env<I, S>(
        &self,
        cwd: &Path,
        args: I,
        operation: GitServiceOperation,
        env: &[(&str, &str)],
    ) -> Result<GitCommandOutput, GitOperationError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        match self.raw_git_output_with_env(Some(cwd), args, env) {
            Ok(output) if output.status.success() => Ok(GitCommandOutput {
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            }),
            Ok(output) => Err(git_error_from_output(operation, &output)),
            Err(error) => Err(git_error_from_io(operation, &error)),
        }
    }

    fn raw_git_output<I, S>(&self, cwd: Option<&Path>, args: I) -> io::Result<Output>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.raw_git_output_with_env(cwd, args, &[])
    }

    fn raw_git_output_with_env<I, S>(
        &self,
        cwd: Option<&Path>,
        args: I,
        env: &[(&str, &str)],
    ) -> io::Result<Output>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new(&self.git_executable);
        command.args(args);
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        command
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_EDITOR", ":")
            .env("GIT_PAGER", "cat")
            .envs(env.iter().copied())
            .output()
    }
}

fn diff_base_args() -> Vec<OsString> {
    vec![
        OsString::from("-c"),
        OsString::from("core.quotepath=false"),
        OsString::from("diff"),
        OsString::from("--find-renames"),
        OsString::from("--no-ext-diff"),
        OsString::from("--src-prefix=old/"),
        OsString::from("--dst-prefix=new/"),
        OsString::from("--unified=3"),
    ]
}

fn require_ref(value: Option<&str>, field_name: &'static str) -> Result<String, GitOperationError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(invalid_ref_error(format!(
            "Git diff requests must include a non-empty {field_name}."
        )));
    };

    Ok(value.to_owned())
}

fn require_restore_ref(value: &str) -> Result<String, GitOperationError> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(restore_invalid_ref_error(
            "Git restore requests must include a non-empty source revision.",
        ));
    }

    Ok(value.to_owned())
}

fn validate_restore_path(
    relative_path: &str,
    case_sensitive: bool,
) -> Result<WorkspaceRelativePath, GitOperationError> {
    let relative_path =
        validate_git_workspace_relative_path(relative_path, GitServiceOperation::Restore)?;
    let file_name = Path::new(&relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    if supported_markdown_extension(file_name, case_sensitive).is_none() {
        return Err(GitOperationError::new(
            GitOperationErrorCode::RestoreConflict,
            GitServiceOperation::Restore,
            "Only Markdown files ending in .md or .markdown can be restored safely.",
            true,
        )
        .with_relative_path(relative_path));
    }

    Ok(relative_path)
}

fn invalid_ref_error(message: impl Into<String>) -> GitOperationError {
    GitOperationError::new(
        GitOperationErrorCode::InvalidRef,
        GitServiceOperation::Diff,
        message,
        true,
    )
}

fn restore_invalid_ref_error(message: impl Into<String>) -> GitOperationError {
    GitOperationError::new(
        GitOperationErrorCode::InvalidRef,
        GitServiceOperation::Restore,
        message,
        true,
    )
}

fn historical_blob_error(error: GitOperationError, relative_path: &str) -> GitOperationError {
    if matches!(
        error.code,
        GitOperationErrorCode::InvalidRef | GitOperationErrorCode::UnknownGitError
    ) {
        return GitOperationError::new(
            GitOperationErrorCode::FileNotInHistory,
            GitServiceOperation::Restore,
            "The requested file was not found at the selected Git revision.",
            true,
        )
        .with_relative_path(relative_path)
        .with_detail("source", error.message);
    }

    error
}

fn workspace_error_to_snapshot_error(error: WorkspaceError) -> GitOperationError {
    let code = match error.code {
        WorkspaceErrorCode::WorkspaceUnwritable | WorkspaceErrorCode::PermissionDenied => {
            GitOperationErrorCode::PermissionDenied
        }
        WorkspaceErrorCode::InvalidRelativePath | WorkspaceErrorCode::PathOutsideWorkspace => {
            GitOperationErrorCode::PermissionDenied
        }
        WorkspaceErrorCode::WorkspaceMissing
        | WorkspaceErrorCode::WorkspaceNotSelected
        | WorkspaceErrorCode::WorkspaceNotDirectory
        | WorkspaceErrorCode::InvalidWorkspacePath => GitOperationErrorCode::NotRepository,
        _ => GitOperationErrorCode::ExternalStateChanged,
    };

    let mut git_error = GitOperationError::new(
        code,
        GitServiceOperation::Snapshot,
        error.message,
        error.recoverable,
    );

    if let Some(relative_path) = error.relative_path {
        git_error = git_error.with_relative_path(relative_path);
    }
    if let Some(details) = error.details {
        for (key, value) in details {
            git_error = git_error.with_detail(key, value);
        }
    }

    git_error
}

fn workspace_error_to_restore_error(error: WorkspaceError) -> GitOperationError {
    let code = match error.code {
        WorkspaceErrorCode::VersionConflict
        | WorkspaceErrorCode::FileNotFound
        | WorkspaceErrorCode::InvalidUtf8
        | WorkspaceErrorCode::UnsupportedFileType
        | WorkspaceErrorCode::FileAlreadyExists => GitOperationErrorCode::RestoreConflict,
        WorkspaceErrorCode::WorkspaceUnwritable | WorkspaceErrorCode::PermissionDenied => {
            GitOperationErrorCode::PermissionDenied
        }
        WorkspaceErrorCode::InvalidRelativePath | WorkspaceErrorCode::PathOutsideWorkspace => {
            GitOperationErrorCode::PermissionDenied
        }
        WorkspaceErrorCode::WorkspaceMissing
        | WorkspaceErrorCode::WorkspaceNotSelected
        | WorkspaceErrorCode::WorkspaceNotDirectory
        | WorkspaceErrorCode::InvalidWorkspacePath => GitOperationErrorCode::NotRepository,
        _ => GitOperationErrorCode::UnknownGitError,
    };

    let mut git_error = GitOperationError::new(
        code,
        GitServiceOperation::Restore,
        error.message,
        error.recoverable,
    );

    if let Some(relative_path) = error.relative_path {
        git_error = git_error.with_relative_path(relative_path);
    }
    if let Some(details) = error.details {
        for (key, value) in details {
            git_error = git_error.with_detail(key, value);
        }
    }

    git_error
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, usize) {
    if value.len() <= max_bytes {
        return (value.to_owned(), 0);
    }

    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }

    (value[..end].to_owned(), value.len() - end)
}

fn parse_diff_patch(
    context: &RepositoryContext,
    patch: &str,
    case_sensitive: bool,
    truncation: &mut GitDiffTruncation,
) -> Vec<GitDiffFile> {
    let mut parser = DiffPatchParser::new(context, case_sensitive, truncation);
    for line in patch.lines() {
        parser.parse_line(line);
    }
    parser.finish()
}

struct DiffPatchParser<'a> {
    context: &'a RepositoryContext,
    case_sensitive: bool,
    truncation: &'a mut GitDiffTruncation,
    files: Vec<GitDiffFile>,
    current_file: Option<GitDiffFile>,
    current_hunk: Option<GitDiffHunkBuilder>,
    skip_current_file: bool,
}

#[derive(Debug, Clone)]
struct GitDiffHunkBuilder {
    hunk: GitDiffHunk,
    next_old_line: u32,
    next_new_line: u32,
    should_store_lines: bool,
}

impl<'a> DiffPatchParser<'a> {
    fn new(
        context: &'a RepositoryContext,
        case_sensitive: bool,
        truncation: &'a mut GitDiffTruncation,
    ) -> Self {
        Self {
            context,
            case_sensitive,
            truncation,
            files: Vec::new(),
            current_file: None,
            current_hunk: None,
            skip_current_file: false,
        }
    }

    fn parse_line(&mut self, line: &str) {
        if let Some((old_repo_path, new_repo_path)) = parse_diff_git_paths(line) {
            self.finish_file();
            if self.files.len() >= self.truncation.max_files {
                self.truncation.is_truncated = true;
                self.truncation.omitted_file_count += 1;
                self.skip_current_file = true;
                return;
            }

            self.current_file = diff_file_for_paths(
                self.context,
                &old_repo_path,
                &new_repo_path,
                self.case_sensitive,
            );
            self.skip_current_file = self.current_file.is_none();
            return;
        }

        if self.skip_current_file {
            return;
        }

        if line.starts_with("new file mode ") {
            self.set_change(GitDiffFileChangeKind::Added);
            return;
        }
        if line.starts_with("deleted file mode ") {
            self.set_change(GitDiffFileChangeKind::Deleted);
            return;
        }
        if line.starts_with("similarity index ") {
            self.set_change(GitDiffFileChangeKind::Renamed);
            return;
        }
        if let Some(path) = line.strip_prefix("rename from ") {
            self.set_previous_path(path);
            self.set_change(GitDiffFileChangeKind::Renamed);
            return;
        }
        if let Some(path) = line.strip_prefix("rename to ") {
            self.set_current_path(path);
            self.set_change(GitDiffFileChangeKind::Renamed);
            return;
        }
        if let Some(path) = line.strip_prefix("copy from ") {
            self.set_previous_path(path);
            self.set_change(GitDiffFileChangeKind::Copied);
            return;
        }
        if let Some(path) = line.strip_prefix("copy to ") {
            self.set_current_path(path);
            self.set_change(GitDiffFileChangeKind::Copied);
            return;
        }
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            if let Some(file) = self.current_file.as_mut() {
                file.is_binary = true;
                file.content_kind = GitDiffContentKind::Binary;
                file.hunks.clear();
            }
            self.current_hunk = None;
            return;
        }
        if line.starts_with("--- ") {
            if line == "--- /dev/null" {
                self.set_change(GitDiffFileChangeKind::Added);
            }
            return;
        }
        if line.starts_with("+++ ") {
            if line == "+++ /dev/null" {
                self.set_change(GitDiffFileChangeKind::Deleted);
            }
            return;
        }
        if line.starts_with("@@ ") {
            self.start_hunk(line);
            return;
        }

        if line.starts_with('\\') {
            return;
        }

        self.parse_hunk_line(line);
    }

    fn finish(mut self) -> Vec<GitDiffFile> {
        self.finish_file();
        self.truncation.included_file_count = self.files.len();
        self.truncation.is_truncated |= self.truncation.omitted_file_count > 0
            || self.truncation.omitted_line_count > 0
            || self.truncation.omitted_byte_count > 0;
        self.files
    }

    fn finish_file(&mut self) {
        self.finish_hunk();
        if let Some(file) = self.current_file.take() {
            self.files.push(file);
        }
    }

    fn finish_hunk(&mut self) {
        let Some(builder) = self.current_hunk.take() else {
            return;
        };
        if builder.should_store_lines {
            if let Some(file) = self.current_file.as_mut() {
                file.hunks.push(builder.hunk);
            }
        }
    }

    fn set_change(&mut self, change: GitDiffFileChangeKind) {
        if let Some(file) = self.current_file.as_mut() {
            file.change = change;
        }
    }

    fn set_previous_path(&mut self, repo_path: &str) {
        if let (Some(file), Some(path)) = (
            self.current_file.as_mut(),
            repo_path_to_workspace_relative(self.context, repo_path),
        ) {
            file.previous_relative_path = Some(path);
            refresh_diff_content_kind(file, self.case_sensitive);
        }
    }

    fn set_current_path(&mut self, repo_path: &str) {
        if let (Some(file), Some(path)) = (
            self.current_file.as_mut(),
            repo_path_to_workspace_relative(self.context, repo_path),
        ) {
            file.relative_path = path;
            refresh_diff_content_kind(file, self.case_sensitive);
        }
    }

    fn start_hunk(&mut self, line: &str) {
        self.finish_hunk();

        let Some(parsed) = parse_hunk_header(line) else {
            return;
        };

        let should_store_lines = self.current_file.as_ref().is_some_and(|file| {
            file.content_kind == GitDiffContentKind::Text
                && file.hunks.len() < self.truncation.max_hunks_per_file
                && self.truncation.included_line_count < self.truncation.max_lines
        });

        if !should_store_lines {
            if let Some(file) = self.current_file.as_mut() {
                if file.content_kind == GitDiffContentKind::Text {
                    file.truncated = true;
                    self.truncation.is_truncated = true;
                }
            }
        }

        self.current_hunk = Some(GitDiffHunkBuilder {
            next_old_line: parsed.old_start,
            next_new_line: parsed.new_start,
            should_store_lines,
            hunk: GitDiffHunk {
                old_start: parsed.old_start,
                old_lines: parsed.old_lines,
                new_start: parsed.new_start,
                new_lines: parsed.new_lines,
                section_header: parsed.section_header,
                lines: Vec::new(),
            },
        });
    }

    fn parse_hunk_line(&mut self, line: &str) {
        let Some(builder) = self.current_hunk.as_mut() else {
            return;
        };
        let Some(file) = self.current_file.as_mut() else {
            return;
        };

        let Some(prefix) = line.as_bytes().first().copied() else {
            return;
        };
        let content = &line[1.min(line.len())..];

        match prefix {
            b'+' => {
                file.additions += 1;
                let new_line_number = builder.next_new_line;
                builder.next_new_line += 1;
                push_diff_line(
                    builder,
                    file,
                    self.truncation,
                    GitDiffLineKind::Addition,
                    None,
                    Some(new_line_number),
                    content,
                );
            }
            b'-' => {
                file.deletions += 1;
                let old_line_number = builder.next_old_line;
                builder.next_old_line += 1;
                push_diff_line(
                    builder,
                    file,
                    self.truncation,
                    GitDiffLineKind::Deletion,
                    Some(old_line_number),
                    None,
                    content,
                );
            }
            b' ' => {
                let old_line_number = builder.next_old_line;
                let new_line_number = builder.next_new_line;
                builder.next_old_line += 1;
                builder.next_new_line += 1;
                push_diff_line(
                    builder,
                    file,
                    self.truncation,
                    GitDiffLineKind::Context,
                    Some(old_line_number),
                    Some(new_line_number),
                    content,
                );
            }
            _ => {}
        }
    }
}

fn push_diff_line(
    builder: &mut GitDiffHunkBuilder,
    file: &mut GitDiffFile,
    truncation: &mut GitDiffTruncation,
    kind: GitDiffLineKind,
    old_line_number: Option<u32>,
    new_line_number: Option<u32>,
    content: &str,
) {
    if !builder.should_store_lines {
        return;
    }

    if truncation.included_line_count >= truncation.max_lines {
        file.truncated = true;
        builder.should_store_lines = false;
        truncation.is_truncated = true;
        truncation.omitted_line_count += 1;
        return;
    }

    builder.hunk.lines.push(GitDiffLine {
        kind,
        old_line_number,
        new_line_number,
        content: content.to_owned(),
    });
    truncation.included_line_count += 1;
}

fn diff_file_for_paths(
    context: &RepositoryContext,
    old_repo_path: &str,
    new_repo_path: &str,
    case_sensitive: bool,
) -> Option<GitDiffFile> {
    let previous_relative_path = repo_path_to_workspace_relative(context, old_repo_path);
    let relative_path = repo_path_to_workspace_relative(context, new_repo_path)
        .or_else(|| previous_relative_path.clone())?;
    let previous_relative_path =
        if previous_relative_path.as_deref() == Some(relative_path.as_str()) {
            None
        } else {
            previous_relative_path
        };
    let mut file = GitDiffFile {
        relative_path,
        previous_relative_path,
        change: GitDiffFileChangeKind::Modified,
        content_kind: GitDiffContentKind::UnsupportedResource,
        is_binary: false,
        additions: 0,
        deletions: 0,
        hunks: Vec::new(),
        truncated: false,
    };
    refresh_diff_content_kind(&mut file, case_sensitive);
    Some(file)
}

fn refresh_diff_content_kind(file: &mut GitDiffFile, case_sensitive: bool) {
    if file.is_binary {
        file.content_kind = GitDiffContentKind::Binary;
    } else if is_workspace_visible_markdown(&file.relative_path, case_sensitive)
        || file
            .previous_relative_path
            .as_deref()
            .is_some_and(|path| is_workspace_visible_markdown(path, case_sensitive))
    {
        file.content_kind = GitDiffContentKind::Text;
    } else {
        file.content_kind = GitDiffContentKind::UnsupportedResource;
        file.hunks.clear();
    }
}

fn parse_diff_git_paths(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("diff --git old/")?;
    let split_at = rest.find(" new/")?;
    let old_path = &rest[..split_at];
    let new_path = &rest[split_at + " new/".len()..];
    Some((old_path.to_owned(), new_path.to_owned()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedHunkHeader {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    section_header: Option<String>,
}

fn parse_hunk_header(line: &str) -> Option<ParsedHunkHeader> {
    let rest = line.strip_prefix("@@ -")?;
    let (old_range, rest) = rest.split_once(" +")?;
    let (new_range, section) = rest.split_once(" @@")?;
    let (old_start, old_lines) = parse_hunk_range(old_range)?;
    let (new_start, new_lines) = parse_hunk_range(new_range)?;
    let section_header = section
        .strip_prefix(' ')
        .filter(|section| !section.is_empty())
        .map(str::to_owned);

    Some(ParsedHunkHeader {
        old_start,
        old_lines,
        new_start,
        new_lines,
        section_header,
    })
}

fn parse_hunk_range(value: &str) -> Option<(u32, u32)> {
    if let Some((start, count)) = value.split_once(',') {
        Some((start.parse().ok()?, count.parse().ok()?))
    } else {
        Some((value.parse().ok()?, 1))
    }
}

fn empty_status_summary(
    record: &WorkspaceRecord,
    repository_state: GitRepositoryState,
) -> GitStatusSummary {
    status_summary(record, repository_state, Vec::new())
}

fn status_summary(
    record: &WorkspaceRecord,
    repository_state: GitRepositoryState,
    entries: Vec<GitStatusEntry>,
) -> GitStatusSummary {
    let counts = status_counts(&entries);
    let has_conflicts = entries.iter().any(|entry| entry.conflicted);
    let changed_file_count = entries
        .iter()
        .filter(|entry| primary_change_kind(entry) != GitStatusChangeKind::Ignored)
        .count();
    let untracked_file_count = counts.untracked;

    GitStatusSummary {
        workspace_id: record.info.id.clone(),
        token: repository_state.token.clone(),
        repository_state,
        entries,
        counts,
        has_changes: changed_file_count > 0,
        has_conflicts,
        changed_file_count,
        untracked_file_count,
        refreshed_at: now_iso(),
    }
}

fn parse_status_entries(
    record: &WorkspaceRecord,
    context: &RepositoryContext,
    output: &str,
    operation: GitServiceOperation,
) -> Vec<GitStatusEntry> {
    let fields = output
        .split('\0')
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut index = 0;

    while index < fields.len() {
        let field = fields[index];
        let bytes = field.as_bytes();
        if bytes.len() < 4 {
            index += 1;
            continue;
        }

        let staged = status_change_kind(bytes[0]);
        let unstaged = status_change_kind(bytes[1]);
        let repo_path = &field[3..];
        let previous_repo_path = if matches!(
            staged,
            GitStatusChangeKind::Renamed | GitStatusChangeKind::Copied
        ) {
            index += 1;
            fields.get(index).copied()
        } else {
            None
        };

        index += 1;

        let Some(relative_path) = repo_path_to_workspace_relative(context, repo_path) else {
            continue;
        };
        let previous_relative_path =
            previous_repo_path.and_then(|path| repo_path_to_workspace_relative(context, path));

        if !is_workspace_visible_status_path(
            &relative_path,
            previous_relative_path.as_deref(),
            record.info.case_sensitive,
        ) || validate_git_workspace_relative_path(&relative_path, operation).is_err()
            || previous_relative_path
                .as_deref()
                .is_some_and(|path| validate_git_workspace_relative_path(path, operation).is_err())
        {
            continue;
        }

        entries.push(GitStatusEntry {
            relative_path,
            previous_relative_path,
            staged,
            unstaged,
            conflicted: is_conflicted_status(staged, unstaged),
        });
    }

    entries
}

fn status_counts(entries: &[GitStatusEntry]) -> GitStatusCounts {
    let mut counts = GitStatusCounts::default();

    for entry in entries {
        match primary_change_kind(entry) {
            GitStatusChangeKind::Added => counts.added += 1,
            GitStatusChangeKind::Modified => counts.modified += 1,
            GitStatusChangeKind::Deleted => counts.deleted += 1,
            GitStatusChangeKind::Renamed | GitStatusChangeKind::Copied => counts.renamed += 1,
            GitStatusChangeKind::Untracked => counts.untracked += 1,
            GitStatusChangeKind::Ignored => counts.ignored += 1,
            GitStatusChangeKind::Unmerged => counts.modified += 1,
            GitStatusChangeKind::Unknown => counts.modified += 1,
            GitStatusChangeKind::Unmodified => {}
        }
    }

    counts
}

fn primary_change_kind(entry: &GitStatusEntry) -> GitStatusChangeKind {
    for kind in [entry.staged, entry.unstaged] {
        if matches!(kind, GitStatusChangeKind::Ignored) {
            return GitStatusChangeKind::Ignored;
        }
    }
    for kind in [entry.staged, entry.unstaged] {
        if matches!(kind, GitStatusChangeKind::Untracked) {
            return GitStatusChangeKind::Untracked;
        }
    }
    for kind in [entry.staged, entry.unstaged] {
        if matches!(
            kind,
            GitStatusChangeKind::Renamed | GitStatusChangeKind::Copied
        ) {
            return kind;
        }
    }
    for kind in [entry.staged, entry.unstaged] {
        if matches!(kind, GitStatusChangeKind::Added) {
            return GitStatusChangeKind::Added;
        }
    }
    for kind in [entry.staged, entry.unstaged] {
        if matches!(kind, GitStatusChangeKind::Deleted) {
            return GitStatusChangeKind::Deleted;
        }
    }
    for kind in [entry.staged, entry.unstaged] {
        if matches!(kind, GitStatusChangeKind::Unmerged) {
            return GitStatusChangeKind::Unmerged;
        }
    }
    for kind in [entry.staged, entry.unstaged] {
        if matches!(kind, GitStatusChangeKind::Modified) {
            return GitStatusChangeKind::Modified;
        }
    }
    for kind in [entry.staged, entry.unstaged] {
        if matches!(kind, GitStatusChangeKind::Unknown) {
            return GitStatusChangeKind::Unknown;
        }
    }

    GitStatusChangeKind::Unmodified
}

fn status_change_kind(value: u8) -> GitStatusChangeKind {
    match value {
        b' ' => GitStatusChangeKind::Unmodified,
        b'M' => GitStatusChangeKind::Modified,
        b'A' => GitStatusChangeKind::Added,
        b'D' => GitStatusChangeKind::Deleted,
        b'R' => GitStatusChangeKind::Renamed,
        b'C' => GitStatusChangeKind::Copied,
        b'?' => GitStatusChangeKind::Untracked,
        b'!' => GitStatusChangeKind::Ignored,
        b'U' => GitStatusChangeKind::Unmerged,
        _ => GitStatusChangeKind::Unknown,
    }
}

fn is_conflicted_status(staged: GitStatusChangeKind, unstaged: GitStatusChangeKind) -> bool {
    matches!(
        (staged, unstaged),
        (GitStatusChangeKind::Unmerged, _)
            | (_, GitStatusChangeKind::Unmerged)
            | (GitStatusChangeKind::Added, GitStatusChangeKind::Added)
            | (GitStatusChangeKind::Deleted, GitStatusChangeKind::Deleted)
            | (GitStatusChangeKind::Added, GitStatusChangeKind::Deleted)
            | (GitStatusChangeKind::Deleted, GitStatusChangeKind::Added)
    )
}

fn repository_context(
    record: &WorkspaceRecord,
    repository_state: &GitRepositoryState,
    operation: GitServiceOperation,
) -> Result<RepositoryContext, GitOperationError> {
    let repository_root = repository_state
        .repository_root_display_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| record.canonical_root.clone());
    let repository_root = canonicalize_lossy(&repository_root);

    if paths_equal(&repository_root, &record.canonical_root) {
        return Ok(RepositoryContext {
            repository_root,
            workspace_prefix_in_repo: None,
            repository_prefix_in_workspace: None,
        });
    }

    if record.canonical_root.starts_with(&repository_root) {
        let Some(prefix) = relative_path_between(&repository_root, &record.canonical_root) else {
            return Err(repository_scope_error(operation));
        };
        return Ok(RepositoryContext {
            repository_root,
            workspace_prefix_in_repo: Some(prefix),
            repository_prefix_in_workspace: None,
        });
    }

    if repository_root.starts_with(&record.canonical_root) {
        let Some(prefix) = relative_path_between(&record.canonical_root, &repository_root) else {
            return Err(repository_scope_error(operation));
        };
        return Ok(RepositoryContext {
            repository_root,
            workspace_prefix_in_repo: None,
            repository_prefix_in_workspace: Some(prefix),
        });
    }

    Err(repository_scope_error(operation))
}

fn repo_path_to_workspace_relative(
    context: &RepositoryContext,
    repo_path: &str,
) -> Option<WorkspaceRelativePath> {
    let repo_path = normalize_git_relative_path(repo_path)?;

    if let Some(prefix) = &context.workspace_prefix_in_repo {
        if repo_path == *prefix {
            return None;
        }

        return repo_path
            .strip_prefix(&format!("{prefix}/"))
            .map(str::to_owned);
    }

    if let Some(prefix) = &context.repository_prefix_in_workspace {
        return Some(format!("{prefix}/{repo_path}"));
    }

    Some(repo_path)
}

fn workspace_path_to_repo_relative(
    context: &RepositoryContext,
    workspace_path: &str,
) -> Option<WorkspaceRelativePath> {
    let workspace_path = normalize_git_relative_path(workspace_path)?;

    if let Some(prefix) = &context.workspace_prefix_in_repo {
        return Some(format!("{prefix}/{workspace_path}"));
    }

    if let Some(prefix) = &context.repository_prefix_in_workspace {
        if workspace_path == *prefix {
            return None;
        }

        return workspace_path
            .strip_prefix(&format!("{prefix}/"))
            .map(str::to_owned);
    }

    Some(workspace_path)
}

fn normalize_git_relative_path(path: &str) -> Option<WorkspaceRelativePath> {
    if path.is_empty() || path.ends_with('/') {
        return None;
    }

    validate_git_workspace_relative_path(path, GitServiceOperation::Status).ok()
}

fn repository_scope_error(operation: GitServiceOperation) -> GitOperationError {
    GitOperationError::new(
        GitOperationErrorCode::RepositoryCorrupt,
        operation,
        "The Git repository root cannot be safely mapped to the selected workspace.",
        true,
    )
}

fn is_workspace_visible_status_path(
    relative_path: &str,
    previous_relative_path: Option<&str>,
    case_sensitive: bool,
) -> bool {
    is_workspace_visible_markdown(relative_path, case_sensitive)
        || previous_relative_path
            .map(|path| is_workspace_visible_markdown(path, case_sensitive))
            .unwrap_or(false)
}

fn is_workspace_visible_markdown(relative_path: &str, case_sensitive: bool) -> bool {
    Path::new(relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| supported_markdown_extension(name, case_sensitive))
        .is_some()
}

fn validate_snapshot_message(message: &str) -> Result<String, GitOperationError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(GitOperationError::new(
            GitOperationErrorCode::NoChanges,
            GitServiceOperation::Snapshot,
            "Snapshot messages must be non-empty.",
            true,
        ));
    }

    Ok(message.to_owned())
}

fn validate_snapshot_request_paths(request: &GitSnapshotRequest) -> Result<(), GitOperationError> {
    for path in request.scope_paths.iter().chain(
        request
            .expected_file_states
            .iter()
            .map(|state| &state.relative_path),
    ) {
        validate_git_workspace_relative_path(path, GitServiceOperation::Snapshot)?;
    }

    Ok(())
}

fn ensure_snapshot_file_states(
    record: &WorkspaceRecord,
    expected_file_states: &[GitExpectedFileState],
) -> Result<(), GitOperationError> {
    if expected_file_states.is_empty() {
        return Ok(());
    }

    let files = index_markdown_files(&record.canonical_root, record.info.case_sensitive)
        .map_err(workspace_error_to_snapshot_error)?;

    for expected in expected_file_states {
        let current = files.iter().find(|file| {
            if record.info.case_sensitive {
                file.relative_path.as_str() == expected.relative_path.as_str()
            } else {
                file.relative_path
                    .eq_ignore_ascii_case(&expected.relative_path)
            }
        });

        let Some(current) = current else {
            return Err(GitOperationError::new(
                GitOperationErrorCode::ExternalStateChanged,
                GitServiceOperation::Snapshot,
                "A scoped Markdown file changed on disk before the Git snapshot could be created.",
                true,
            )
            .with_relative_path(expected.relative_path.clone())
            .with_detail("expectedToken", expected.expected_version.token.clone())
            .with_detail("currentToken", serde_json::Value::Null));
        };

        if current.version != expected.expected_version {
            return Err(GitOperationError::new(
                GitOperationErrorCode::ExternalStateChanged,
                GitServiceOperation::Snapshot,
                "A scoped Markdown file changed on disk before the Git snapshot could be created.",
                true,
            )
            .with_relative_path(expected.relative_path.clone())
            .with_detail("expectedToken", expected.expected_version.token.clone())
            .with_detail("currentToken", current.version.token.clone()));
        }
    }

    Ok(())
}

fn select_snapshot_entries(
    context: &RepositoryContext,
    status_entries: &[GitStatusEntry],
    request: &GitSnapshotRequest,
) -> Result<Vec<SnapshotEntry>, GitOperationError> {
    let requested_paths = request.scope_paths.iter().cloned().collect::<BTreeSet<_>>();
    let explicit_scope = !requested_paths.is_empty();
    let mut selected = BTreeMap::new();

    for entry in status_entries {
        if !is_snapshot_eligible(entry) {
            continue;
        }

        if explicit_scope && !requested_paths.contains(&entry.relative_path) {
            continue;
        }

        let Some(repo_path) = workspace_path_to_repo_relative(context, &entry.relative_path) else {
            continue;
        };
        let previous_repo_path = entry
            .previous_relative_path
            .as_deref()
            .and_then(|path| workspace_path_to_repo_relative(context, path));

        selected.insert(
            entry.relative_path.clone(),
            SnapshotEntry {
                workspace_path: entry.relative_path.clone(),
                repo_path,
                previous_repo_path,
            },
        );
    }

    Ok(selected.into_values().collect())
}

fn is_snapshot_eligible(entry: &GitStatusEntry) -> bool {
    if entry.conflicted {
        return false;
    }

    !matches!(
        primary_change_kind(entry),
        GitStatusChangeKind::Unmodified | GitStatusChangeKind::Ignored
    )
}

fn validate_author_identity(
    author: GitAuthorIdentity,
) -> Result<GitAuthorIdentity, GitOperationError> {
    let name = author.name.trim();
    let email = author.email.trim();

    if name.is_empty()
        || email.is_empty()
        || !email.contains('@')
        || name.chars().any(char::is_control)
        || email.chars().any(char::is_control)
    {
        return Err(GitOperationError::new(
            GitOperationErrorCode::IdentityMissing,
            GitServiceOperation::Snapshot,
            "Git author identity must include a non-empty name and email address.",
            true,
        ));
    }

    Ok(GitAuthorIdentity {
        name: name.to_owned(),
        email: email.to_owned(),
    })
}

fn short_commit_oid(commit_oid: &str) -> String {
    commit_oid.chars().take(12).collect()
}

fn base_state(
    record: &WorkspaceRecord,
    state: GitRepositoryStateKind,
    backend: GitBackendInfo,
    repository_root: Option<PathBuf>,
    relative_prefix: Option<WorkspaceRelativePath>,
    blocked_reason: Option<GitOperationErrorCode>,
    warnings: Vec<GitRepositoryWarning>,
) -> GitRepositoryState {
    let checked_at = now_iso();
    GitRepositoryState {
        workspace_id: record.info.id.clone(),
        state,
        backend,
        selected_root_display_path: record.canonical_root.display().to_string(),
        repository_root_display_path: repository_root.map(|path| path.display().to_string()),
        relative_prefix,
        branch_name: None,
        head_oid: None,
        token: None,
        blocked_reason,
        warnings,
        checked_at,
    }
}

fn unavailable_backend() -> GitBackendInfo {
    GitBackendInfo {
        kind: GitBackendKind::SystemGit,
        version: None,
        executable_display_path: Some(DEFAULT_GIT_EXECUTABLE.to_owned()),
    }
}

fn git_error_from_io(operation: GitServiceOperation, error: &io::Error) -> GitOperationError {
    GitOperationError::new(
        if error.kind() == io::ErrorKind::PermissionDenied {
            GitOperationErrorCode::PermissionDenied
        } else if error.kind() == io::ErrorKind::NotFound {
            GitOperationErrorCode::GitUnavailable
        } else {
            GitOperationErrorCode::UnknownGitError
        },
        operation,
        format!("The Git process could not be started: {error}"),
        true,
    )
}

fn git_error_from_output(operation: GitServiceOperation, output: &Output) -> GitOperationError {
    let message = command_error_message("Git command failed.", output);
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("permission denied") || lower.contains("access is denied") {
        GitOperationErrorCode::PermissionDenied
    } else if lower.contains("author identity unknown")
        || lower.contains("unable to auto-detect email address")
        || lower.contains("empty ident name")
    {
        GitOperationErrorCode::IdentityMissing
    } else if lower.contains("nothing to commit")
        || lower.contains("does not have any commits yet")
        || (lower.contains("your current branch") && lower.contains("does not have any commits"))
    {
        GitOperationErrorCode::NoChanges
    } else if lower.contains("needed a single revision")
        || lower.contains("unknown revision")
        || lower.contains("bad revision")
        || lower.contains("ambiguous argument")
        || lower.contains("invalid object name")
        || lower.contains("not a valid object name")
    {
        GitOperationErrorCode::InvalidRef
    } else if lower.contains("not a git repository") {
        GitOperationErrorCode::NotRepository
    } else if lower.contains("not a gitdir")
        || lower.contains("bad config")
        || lower.contains("invalid gitfile")
        || lower.contains("repository format version")
    {
        GitOperationErrorCode::RepositoryCorrupt
    } else {
        GitOperationErrorCode::UnknownGitError
    };

    GitOperationError::new(code, operation, message, true)
}

fn command_error_message(prefix: &str, output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();

    if !stderr.is_empty() {
        format!("{prefix} {stderr}")
    } else if !stdout.is_empty() {
        format!("{prefix} {stdout}")
    } else {
        format!("{prefix} exit code {:?}", output.status.code())
    }
}

fn map_io_state(error: &io::Error) -> GitRepositoryStateKind {
    if error.kind() == io::ErrorKind::PermissionDenied {
        GitRepositoryStateKind::PermissionDenied
    } else {
        GitRepositoryStateKind::RepositoryCorrupt
    }
}

fn map_io_code(error: &io::Error) -> GitOperationErrorCode {
    if error.kind() == io::ErrorKind::PermissionDenied {
        GitOperationErrorCode::PermissionDenied
    } else {
        GitOperationErrorCode::RepositoryCorrupt
    }
}

fn blocked_by_state(state: GitRepositoryStateKind) -> GitOperationErrorCode {
    match state {
        GitRepositoryStateKind::GitUnavailable => GitOperationErrorCode::GitUnavailable,
        GitRepositoryStateKind::NotRepository => GitOperationErrorCode::NotRepository,
        GitRepositoryStateKind::ValidRepository => GitOperationErrorCode::NoChanges,
        GitRepositoryStateKind::RepositoryCorrupt => GitOperationErrorCode::RepositoryCorrupt,
        GitRepositoryStateKind::ParentRepository => GitOperationErrorCode::ParentRepository,
        GitRepositoryStateKind::NestedRepository => GitOperationErrorCode::NestedRepository,
        GitRepositoryStateKind::BareRepository => GitOperationErrorCode::BareRepository,
        GitRepositoryStateKind::DetachedHead => GitOperationErrorCode::DetachedHead,
        GitRepositoryStateKind::MergeConflict => GitOperationErrorCode::MergeConflict,
        GitRepositoryStateKind::PermissionDenied => GitOperationErrorCode::PermissionDenied,
    }
}

fn first_nested_repository_root(root: &Path) -> Result<Option<PathBuf>, GitOperationError> {
    let mut stack = vec![root.to_path_buf()];

    while let Some(directory) = stack.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Err(GitOperationError::new(
                    GitOperationErrorCode::PermissionDenied,
                    GitServiceOperation::Detect,
                    "The operating system denied access while scanning for nested Git repositories.",
                    true,
                ));
            }
            Err(_) => continue,
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                    return Err(GitOperationError::new(
                        GitOperationErrorCode::PermissionDenied,
                        GitServiceOperation::Detect,
                        "The operating system denied access while scanning for nested Git repositories.",
                        true,
                    ));
                }
                Err(_) => continue,
            };
            let path = entry.path();
            let file_name = entry.file_name();
            let is_git_entry = file_name.to_string_lossy().eq_ignore_ascii_case(".git");

            if is_git_entry {
                if directory != root {
                    return Ok(Some(directory));
                }
                continue;
            }

            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                if path != root && is_bare_repository_layout(&path) {
                    return Ok(Some(path));
                }
                stack.push(path);
            }
        }
    }

    Ok(None)
}

fn is_bare_repository_layout(path: &Path) -> bool {
    path.join("HEAD").is_file() && path.join("objects").is_dir() && path.join("refs").is_dir()
}

fn normalize_git_path(cwd: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

fn canonicalize_lossy(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if cfg!(target_os = "windows") {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn relative_path_between(base: &Path, child: &Path) -> Option<WorkspaceRelativePath> {
    child.strip_prefix(base).ok().and_then(|path| {
        let relative = path_to_workspace_relative(path);
        if relative.is_empty() {
            None
        } else {
            Some(relative)
        }
    })
}

fn path_to_workspace_relative(path: &Path) -> WorkspaceRelativePath {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn non_empty_trimmed(value: String) -> Option<String> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn index_token_parts(
    index_path: &Path,
) -> Result<(Option<u64>, Option<String>), GitOperationError> {
    if !index_path.exists() {
        return Ok((None, None));
    }

    let bytes = fs::read(index_path).map_err(|error| {
        GitOperationError::new(
            map_io_code(&error),
            GitServiceOperation::Detect,
            format!("The Git index could not be read: {error}"),
            true,
        )
    })?;
    let version = if bytes.len() >= 8 && &bytes[0..4] == b"DIRC" {
        Some(u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as u64)
    } else {
        None
    };

    Ok((version, Some(sha256_hex(&bytes))))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::WorkspaceOperation;
    use crate::workspace::validate_workspace_root;
    use std::fs;

    fn record_for(path: &Path) -> WorkspaceRecord {
        validate_workspace_root(path, WorkspaceOperation::SelectWorkspace).unwrap()
    }

    fn service() -> GitRepositoryService {
        GitRepositoryService::default()
    }

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new(DEFAULT_GIT_EXECUTABLE)
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_stdout(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new(DEFAULT_GIT_EXECUTABLE)
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn configure_identity(cwd: &Path) {
        git(cwd, &["config", "user.email", "test@example.invalid"]);
        git(cwd, &["config", "user.name", "Test User"]);
    }

    fn commit_all(cwd: &Path, message: &str) {
        git(cwd, &["add", "--all"]);
        git(cwd, &["commit", "--quiet", "-m", message]);
    }

    fn snapshot_request(
        record: &WorkspaceRecord,
        status: &GitStatusSummary,
        message: &str,
    ) -> GitSnapshotRequest {
        GitSnapshotRequest {
            workspace_id: record.info.id.clone(),
            message: message.to_owned(),
            scope_paths: Vec::new(),
            expected_repo_token: status.token.clone().unwrap(),
            expected_file_states: Vec::new(),
            author: Some(GitAuthorIdentity {
                name: "Snapshot Bot".to_owned(),
                email: "snapshot@example.invalid".to_owned(),
            }),
        }
    }

    fn restore_request(
        record: &WorkspaceRecord,
        status: &GitStatusSummary,
        relative_path: &str,
        source_ref: &str,
        expected_file_version: crate::models::FileVersion,
    ) -> GitRestoreRequest {
        GitRestoreRequest {
            workspace_id: record.info.id.clone(),
            relative_path: relative_path.to_owned(),
            source_ref: source_ref.to_owned(),
            expected_repo_token: status.token.clone().unwrap(),
            expected_file_version,
            editor_has_unsaved_changes: false,
            dry_run: false,
        }
    }

    fn diff_truncation_for_tests() -> GitDiffTruncation {
        GitDiffTruncation {
            is_truncated: false,
            max_bytes: MAX_DIFF_BYTES,
            max_files: MAX_DIFF_FILES,
            max_lines: MAX_DIFF_LINES,
            max_hunks_per_file: MAX_DIFF_HUNKS_PER_FILE,
            included_file_count: 0,
            omitted_file_count: 0,
            included_line_count: 0,
            omitted_line_count: 0,
            omitted_byte_count: 0,
        }
    }

    #[test]
    fn normalizes_porcelain_status_to_workspace_entries_and_counts() {
        let temp = tempfile::tempdir().unwrap();
        let record = record_for(temp.path());
        let context = RepositoryContext {
            repository_root: temp.path().to_path_buf(),
            workspace_prefix_in_repo: None,
            repository_prefix_in_workspace: None,
        };
        let entries = parse_status_entries(
            &record,
            &context,
            " M notes/idea.md\0?? notes/new.md\0R  notes/new-name.md\0notes/old-name.md\0",
            GitServiceOperation::Status,
        );

        let counts = status_counts(&entries);

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].relative_path, "notes/idea.md");
        assert_eq!(entries[0].unstaged, GitStatusChangeKind::Modified);
        assert_eq!(entries[1].unstaged, GitStatusChangeKind::Untracked);
        assert_eq!(entries[2].relative_path, "notes/new-name.md");
        assert_eq!(
            entries[2].previous_relative_path.as_deref(),
            Some("notes/old-name.md")
        );
        assert_eq!(counts.modified, 1);
        assert_eq!(counts.untracked, 1);
        assert_eq!(counts.renamed, 1);
    }

    #[test]
    fn parses_structured_diff_and_suppresses_unsupported_resource_hunks() {
        let temp = tempfile::tempdir().unwrap();
        let context = RepositoryContext {
            repository_root: temp.path().to_path_buf(),
            workspace_prefix_in_repo: None,
            repository_prefix_in_workspace: None,
        };
        let patch = "\
diff --git old/notes/idea.md new/notes/idea.md
index 1111111..2222222 100644
--- old/notes/idea.md
+++ new/notes/idea.md
@@ -1,2 +1,2 @@
 # Idea
-old thought
+new thought
diff --git old/assets/data.txt new/assets/data.txt
index 3333333..4444444 100644
--- old/assets/data.txt
+++ new/assets/data.txt
@@ -1 +1 @@
-secret old
+secret new
diff --git old/assets/blob.bin new/assets/blob.bin
index 5555555..6666666 100644
Binary files old/assets/blob.bin and new/assets/blob.bin differ
";
        let mut truncation = diff_truncation_for_tests();

        let files = parse_diff_patch(&context, patch, true, &mut truncation);

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].relative_path, "notes/idea.md");
        assert_eq!(files[0].content_kind, GitDiffContentKind::Text);
        assert_eq!(files[0].additions, 1);
        assert_eq!(files[0].deletions, 1);
        assert_eq!(files[0].hunks[0].lines[1].kind, GitDiffLineKind::Deletion);
        assert_eq!(files[0].hunks[0].lines[1].old_line_number, Some(2));
        assert_eq!(files[0].hunks[0].lines[2].new_line_number, Some(2));
        assert_eq!(files[1].relative_path, "assets/data.txt");
        assert_eq!(
            files[1].content_kind,
            GitDiffContentKind::UnsupportedResource
        );
        assert!(files[1].hunks.is_empty());
        assert_eq!(files[1].additions, 1);
        assert_eq!(files[1].deletions, 1);
        assert_eq!(files[2].content_kind, GitDiffContentKind::Binary);
        assert!(files[2].is_binary);
        assert!(files[2].hunks.is_empty());
    }

    #[test]
    fn marks_large_markdown_diff_as_truncated() {
        let temp = tempfile::tempdir().unwrap();
        let context = RepositoryContext {
            repository_root: temp.path().to_path_buf(),
            workspace_prefix_in_repo: None,
            repository_prefix_in_workspace: None,
        };
        let mut patch = String::from(
            "diff --git old/large.md new/large.md\n--- old/large.md\n+++ new/large.md\n@@ -1,1 +1,4 @@\n",
        );
        for index in 0..4 {
            patch.push_str(&format!("+line {index}\n"));
        }
        let mut truncation = GitDiffTruncation {
            max_lines: 2,
            ..diff_truncation_for_tests()
        };

        let files = parse_diff_patch(&context, &patch, true, &mut truncation);

        assert_eq!(files.len(), 1);
        assert!(files[0].truncated);
        assert!(truncation.is_truncated);
        assert_eq!(truncation.included_line_count, 2);
        assert!(truncation.omitted_line_count > 0);
    }

    #[test]
    fn validates_snapshot_messages_and_author_identities() {
        assert_eq!(
            validate_snapshot_message("  Save useful checkpoint  ").unwrap(),
            "Save useful checkpoint"
        );
        assert_eq!(
            validate_snapshot_message(" \t ").unwrap_err().code,
            GitOperationErrorCode::NoChanges
        );
        assert_eq!(
            validate_author_identity(GitAuthorIdentity {
                name: "  Test User ".to_owned(),
                email: " test@example.invalid ".to_owned(),
            })
            .unwrap(),
            GitAuthorIdentity {
                name: "Test User".to_owned(),
                email: "test@example.invalid".to_owned(),
            }
        );
        assert_eq!(
            validate_author_identity(GitAuthorIdentity {
                name: "Test User".to_owned(),
                email: "not-an-email".to_owned(),
            })
            .unwrap_err()
            .code,
            GitOperationErrorCode::IdentityMissing
        );
    }

    #[test]
    fn restores_historical_markdown_as_pending_worktree_change_without_moving_head() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Old\n").unwrap();
        commit_all(temp.path(), "Old idea");
        let old_commit = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        fs::write(temp.path().join("idea.md"), "# Current\n").unwrap();
        commit_all(temp.path(), "Current idea");
        let head_before = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        let branch_before = git_stdout(temp.path(), &["branch", "--show-current"]);
        let record = record_for(temp.path());
        let snapshot = crate::documents::open_document(&record, "idea.md").unwrap();
        let status = service().status(&record).unwrap();

        let result = service()
            .restore_file(
                &record,
                restore_request(&record, &status, "idea.md", &old_commit, snapshot.version),
            )
            .unwrap();

        assert_eq!(
            fs::read_to_string(temp.path().join("idea.md")).unwrap(),
            "# Old\n"
        );
        assert_eq!(result.snapshot.content, "# Old\n");
        assert_eq!(result.restored_from, old_commit);
        assert_ne!(result.file_version.token, status.token.unwrap().token);
        assert_eq!(git_stdout(temp.path(), &["rev-parse", "HEAD"]), head_before);
        assert_eq!(
            git_stdout(temp.path(), &["branch", "--show-current"]),
            branch_before
        );
        assert!(result.status.has_changes);
        assert_eq!(result.status.entries[0].relative_path, "idea.md");
        assert_eq!(
            result.status.entries[0].unstaged,
            GitStatusChangeKind::Modified
        );
    }

    #[test]
    fn blocks_restore_when_repository_token_is_stale_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Old\n").unwrap();
        commit_all(temp.path(), "Old idea");
        let old_commit = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        fs::write(temp.path().join("idea.md"), "# Current\n").unwrap();
        commit_all(temp.path(), "Current idea");
        let record = record_for(temp.path());
        let snapshot = crate::documents::open_document(&record, "idea.md").unwrap();
        let status = service().status(&record).unwrap();
        fs::write(temp.path().join("later.md"), "# Later\n").unwrap();

        let error = service()
            .restore_file(
                &record,
                restore_request(&record, &status, "idea.md", &old_commit, snapshot.version),
            )
            .unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::ExternalStateChanged);
        assert_eq!(
            fs::read_to_string(temp.path().join("idea.md")).unwrap(),
            "# Current\n"
        );
    }

    #[test]
    fn blocks_restore_when_current_file_version_is_stale_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Old\n").unwrap();
        commit_all(temp.path(), "Old idea");
        let old_commit = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        fs::write(temp.path().join("idea.md"), "# Current\n").unwrap();
        commit_all(temp.path(), "Current idea");
        let record = record_for(temp.path());
        let stale_snapshot = crate::documents::open_document(&record, "idea.md").unwrap();
        fs::write(temp.path().join("idea.md"), "# External\n").unwrap();
        let current_status = service().status(&record).unwrap();

        let error = service()
            .restore_file(
                &record,
                restore_request(
                    &record,
                    &current_status,
                    "idea.md",
                    &old_commit,
                    stale_snapshot.version,
                ),
            )
            .unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::RestoreConflict);
        assert_eq!(
            fs::read_to_string(temp.path().join("idea.md")).unwrap(),
            "# External\n"
        );
    }

    #[test]
    fn blocks_restore_when_editor_reports_unsaved_changes_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Old\n").unwrap();
        commit_all(temp.path(), "Old idea");
        let old_commit = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        fs::write(temp.path().join("idea.md"), "# Current\n").unwrap();
        commit_all(temp.path(), "Current idea");
        let record = record_for(temp.path());
        let snapshot = crate::documents::open_document(&record, "idea.md").unwrap();
        let status = service().status(&record).unwrap();
        let mut request =
            restore_request(&record, &status, "idea.md", &old_commit, snapshot.version);
        request.editor_has_unsaved_changes = true;

        let error = service().restore_file(&record, request).unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::RestoreConflict);
        assert_eq!(
            fs::read_to_string(temp.path().join("idea.md")).unwrap(),
            "# Current\n"
        );
    }

    #[test]
    fn maps_invalid_ref_and_missing_historical_blob_to_typed_restore_errors() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("readme.md"), "# Readme\n").unwrap();
        commit_all(temp.path(), "Readme only");
        let missing_blob_commit = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        fs::write(temp.path().join("idea.md"), "# Current\n").unwrap();
        commit_all(temp.path(), "Add idea");
        let record = record_for(temp.path());
        let snapshot = crate::documents::open_document(&record, "idea.md").unwrap();
        let status = service().status(&record).unwrap();

        let invalid_ref = service()
            .restore_file(
                &record,
                restore_request(
                    &record,
                    &status,
                    "idea.md",
                    "missing-ref",
                    snapshot.version.clone(),
                ),
            )
            .unwrap_err();
        assert_eq!(invalid_ref.code, GitOperationErrorCode::InvalidRef);

        let missing_blob = service()
            .restore_file(
                &record,
                restore_request(
                    &record,
                    &status,
                    "idea.md",
                    &missing_blob_commit,
                    snapshot.version,
                ),
            )
            .unwrap_err();
        assert_eq!(missing_blob.code, GitOperationErrorCode::FileNotInHistory);
        assert_eq!(
            fs::read_to_string(temp.path().join("idea.md")).unwrap(),
            "# Current\n"
        );
    }

    #[test]
    fn blocks_restore_while_merge_conflict_marker_is_present() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Old\n").unwrap();
        commit_all(temp.path(), "Old idea");
        let old_commit = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        fs::write(temp.path().join("idea.md"), "# Current\n").unwrap();
        commit_all(temp.path(), "Current idea");
        let record = record_for(temp.path());
        let snapshot = crate::documents::open_document(&record, "idea.md").unwrap();
        fs::write(temp.path().join(".git").join("MERGE_HEAD"), &old_commit).unwrap();
        let status = service().status(&record).unwrap();

        let error = service()
            .restore_file(
                &record,
                restore_request(&record, &status, "idea.md", &old_commit, snapshot.version),
            )
            .unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::MergeConflict);
        assert_eq!(
            fs::read_to_string(temp.path().join("idea.md")).unwrap(),
            "# Current\n"
        );
    }

    #[test]
    fn reports_non_git_workspace_and_initializes_without_touching_file_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let note_path = temp.path().join("idea.md");
        fs::write(&note_path, b"# Idea\r\nbody").unwrap();
        let before = fs::read(&note_path).unwrap();
        let record = record_for(temp.path());

        let state = service().detect(&record).unwrap();
        assert_eq!(state.state, GitRepositoryStateKind::NotRepository);
        assert!(state.repository_root_display_path.is_none());

        let enabled = service().enable(&record).unwrap();
        assert_eq!(enabled.state, GitRepositoryStateKind::ValidRepository);
        assert!(temp.path().join(".git").is_dir());
        assert_eq!(fs::read(&note_path).unwrap(), before);

        let head = Command::new(DEFAULT_GIT_EXECUTABLE)
            .current_dir(temp.path())
            .args(["rev-parse", "--verify", "HEAD"])
            .output()
            .unwrap();
        assert!(!head.status.success());
    }

    #[test]
    fn detects_existing_root_repository_branch_and_head() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();
        git(temp.path(), &["add", "idea.md"]);
        git(temp.path(), &["commit", "--quiet", "-m", "Initial"]);
        let record = record_for(temp.path());

        let state = service().detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::ValidRepository);
        assert!(state.branch_name.is_some());
        assert_eq!(state.head_oid.as_deref().map(str::len), Some(40));
        assert!(state.token.is_some());
    }

    #[test]
    fn reports_status_counts_for_workspace_markdown_changes() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("modified.md"), "# Original").unwrap();
        fs::write(temp.path().join("deleted.md"), "# Delete").unwrap();
        fs::write(temp.path().join("old.md"), "# Rename").unwrap();
        commit_all(temp.path(), "Initial");
        git(temp.path(), &["mv", "old.md", "renamed.md"]);
        fs::write(temp.path().join("modified.md"), "# Changed").unwrap();
        fs::remove_file(temp.path().join("deleted.md")).unwrap();
        fs::write(temp.path().join("untracked.md"), "# New").unwrap();
        fs::write(temp.path().join(".gitignore"), "ignored.md\n").unwrap();
        fs::write(temp.path().join("ignored.md"), "# Ignored").unwrap();
        fs::write(temp.path().join("untracked.txt"), "not visible").unwrap();
        let record = record_for(temp.path());

        let status = service().status(&record).unwrap();
        let paths = status
            .entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(status.counts.modified, 1);
        assert_eq!(status.counts.deleted, 1);
        assert_eq!(status.counts.renamed, 1);
        assert_eq!(status.counts.untracked, 1);
        assert_eq!(status.counts.ignored, 1);
        assert_eq!(status.changed_file_count, 4);
        assert!(status.has_changes);
        assert_eq!(
            paths,
            vec![
                "deleted.md",
                "ignored.md",
                "modified.md",
                "renamed.md",
                "untracked.md"
            ]
        );
        assert!(status
            .entries
            .iter()
            .any(|entry| entry.previous_relative_path.as_deref() == Some("old.md")));
    }

    #[test]
    fn lists_workspace_and_file_history_with_rename_following() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea\n").unwrap();
        fs::write(temp.path().join("asset.bin"), b"\0one").unwrap();
        commit_all(temp.path(), "Initial snapshot");
        fs::write(temp.path().join("idea.md"), "# Idea\nSecond\n").unwrap();
        commit_all(temp.path(), "Expand idea");
        git(temp.path(), &["mv", "idea.md", "renamed.md"]);
        commit_all(temp.path(), "Rename idea");
        let record = record_for(temp.path());

        let history = service()
            .list_history(
                &record,
                GitHistoryRequest {
                    workspace_id: record.info.id.clone(),
                    relative_path: None,
                    max_entries: Some(10),
                },
            )
            .unwrap();
        let file_history = service()
            .list_history(
                &record,
                GitHistoryRequest {
                    workspace_id: record.info.id.clone(),
                    relative_path: Some("renamed.md".to_owned()),
                    max_entries: Some(10),
                },
            )
            .unwrap();

        assert_eq!(history.len(), 3);
        assert_eq!(history[0].subject, "Rename idea");
        assert_eq!(history[0].short_commit_oid.len(), 12);
        assert!(history[0].affected_file_count >= 1);
        assert_eq!(
            file_history
                .iter()
                .map(|entry| entry.subject.as_str())
                .collect::<Vec<_>>(),
            vec!["Rename idea", "Expand idea", "Initial snapshot"]
        );
    }

    #[test]
    fn returns_file_not_in_history_for_missing_file_history() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea\n").unwrap();
        commit_all(temp.path(), "Initial snapshot");
        let record = record_for(temp.path());

        let error = service()
            .list_history(
                &record,
                GitHistoryRequest {
                    workspace_id: record.info.id.clone(),
                    relative_path: Some("missing.md".to_owned()),
                    max_entries: Some(10),
                },
            )
            .unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::FileNotInHistory);
        assert_eq!(error.relative_path.as_deref(), Some("missing.md"));
    }

    #[test]
    fn diffs_current_markdown_against_historical_commit() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea\nold thought\n").unwrap();
        commit_all(temp.path(), "Initial snapshot");
        let initial = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        fs::write(temp.path().join("idea.md"), "# Idea\nnew thought\n").unwrap();
        let record = record_for(temp.path());

        let result = service()
            .diff(
                &record,
                GitDiffRequest {
                    workspace_id: record.info.id.clone(),
                    mode: GitDiffMode::WorkingTree,
                    relative_path: Some("idea.md".to_owned()),
                    base_ref: Some(initial),
                    head_ref: None,
                },
            )
            .unwrap();

        assert_eq!(result.file_count, 1);
        assert_eq!(result.files[0].content_kind, GitDiffContentKind::Text);
        assert_eq!(result.files[0].additions, 1);
        assert_eq!(result.files[0].deletions, 1);
        assert!(result.files[0]
            .hunks
            .iter()
            .flat_map(|hunk| hunk.lines.iter())
            .any(|line| line.kind == GitDiffLineKind::Addition && line.content == "new thought"));
    }

    #[test]
    fn diffs_commit_to_commit_renames() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea\n").unwrap();
        commit_all(temp.path(), "Initial snapshot");
        let initial = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        git(temp.path(), &["mv", "idea.md", "renamed.md"]);
        commit_all(temp.path(), "Rename idea");
        let renamed = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        let record = record_for(temp.path());

        let result = service()
            .diff(
                &record,
                GitDiffRequest {
                    workspace_id: record.info.id.clone(),
                    mode: GitDiffMode::RefRange,
                    relative_path: None,
                    base_ref: Some(initial),
                    head_ref: Some(renamed),
                },
            )
            .unwrap();

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].change, GitDiffFileChangeKind::Renamed);
        assert_eq!(result.files[0].relative_path, "renamed.md");
        assert_eq!(
            result.files[0].previous_relative_path.as_deref(),
            Some("idea.md")
        );
    }

    #[test]
    fn returns_invalid_ref_for_unknown_diff_base() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea\n").unwrap();
        commit_all(temp.path(), "Initial snapshot");
        let record = record_for(temp.path());

        let error = service()
            .diff(
                &record,
                GitDiffRequest {
                    workspace_id: record.info.id.clone(),
                    mode: GitDiffMode::WorkingTree,
                    relative_path: Some("idea.md".to_owned()),
                    base_ref: Some("missing-ref".to_owned()),
                    head_ref: None,
                },
            )
            .unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::InvalidRef);
    }

    #[test]
    fn represents_binary_diff_as_metadata_without_hunks() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("asset.bin"), b"\0one").unwrap();
        commit_all(temp.path(), "Initial binary");
        let initial = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        fs::write(temp.path().join("asset.bin"), b"\0two").unwrap();
        let record = record_for(temp.path());

        let result = service()
            .diff(
                &record,
                GitDiffRequest {
                    workspace_id: record.info.id.clone(),
                    mode: GitDiffMode::WorkingTree,
                    relative_path: Some("asset.bin".to_owned()),
                    base_ref: Some(initial),
                    head_ref: None,
                },
            )
            .unwrap();

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].content_kind, GitDiffContentKind::Binary);
        assert!(result.files[0].is_binary);
        assert!(result.files[0].hunks.is_empty());
    }

    #[test]
    fn truncates_large_markdown_diff_results() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("large.md"), "# Large\n").unwrap();
        commit_all(temp.path(), "Initial large file");
        let initial = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        let body = (0..2_500)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(temp.path().join("large.md"), format!("# Large\n{body}\n")).unwrap();
        let record = record_for(temp.path());

        let result = service()
            .diff(
                &record,
                GitDiffRequest {
                    workspace_id: record.info.id.clone(),
                    mode: GitDiffMode::WorkingTree,
                    relative_path: Some("large.md".to_owned()),
                    base_ref: Some(initial),
                    head_ref: None,
                },
            )
            .unwrap();

        assert!(result.truncation.is_truncated);
        assert_eq!(result.truncation.included_line_count, MAX_DIFF_LINES);
        assert!(result.files[0].truncated);
    }

    #[test]
    fn creates_initial_snapshot_commit_and_returns_refreshed_status() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();
        let record = record_for(temp.path());
        let status = service().status(&record).unwrap();
        let request = snapshot_request(&record, &status, "Save local snapshot");

        let result = service().create_snapshot(&record, request).unwrap();

        assert_eq!(result.workspace_id, record.info.id);
        assert_eq!(result.commit_oid.len(), 40);
        assert_eq!(result.short_commit_oid.len(), 12);
        assert_eq!(result.parent_oids, Vec::<String>::new());
        assert_eq!(result.affected_paths, vec!["idea.md"]);
        assert_eq!(result.affected_file_count, 1);
        assert_eq!(
            git_stdout(temp.path(), &["rev-parse", "--verify", "HEAD"]),
            result.commit_oid
        );
        assert_eq!(
            git_stdout(temp.path(), &["log", "--format=%s", "-n", "1"]),
            "Save local snapshot"
        );
        assert!(!result.status.has_changes);
        assert!(result.status.entries.is_empty());
    }

    #[test]
    fn snapshots_all_eligible_workspace_changes_without_staging_ignored_files() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join(".gitignore"), "ignored.md\n").unwrap();
        commit_all(temp.path(), "Ignore rules");
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();
        fs::write(temp.path().join("ignored.md"), "# Ignored").unwrap();
        let record = record_for(temp.path());
        let status = service().status(&record).unwrap();
        assert_eq!(status.counts.untracked, 1);
        assert_eq!(status.counts.ignored, 1);

        let result = service()
            .create_snapshot(&record, snapshot_request(&record, &status, "Save idea"))
            .unwrap();

        assert_eq!(result.affected_paths, vec!["idea.md"]);
        assert!(git_stdout(temp.path(), &["ls-files"])
            .lines()
            .any(|path| path == "idea.md"));
        assert!(!git_stdout(temp.path(), &["ls-files"])
            .lines()
            .any(|path| path == "ignored.md"));
    }

    #[test]
    fn snapshot_scope_paths_stage_only_explicit_eligible_files() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        fs::write(temp.path().join("one.md"), "# One").unwrap();
        fs::write(temp.path().join("two.md"), "# Two").unwrap();
        let record = record_for(temp.path());
        let status = service().status(&record).unwrap();
        let mut request = snapshot_request(&record, &status, "Save one");
        request.scope_paths = vec!["one.md".to_owned()];

        let result = service().create_snapshot(&record, request).unwrap();

        assert_eq!(result.affected_paths, vec!["one.md"]);
        assert_eq!(result.status.counts.untracked, 1);
        assert_eq!(result.status.entries[0].relative_path, "two.md");
        assert_eq!(git_stdout(temp.path(), &["ls-files"]), "one.md");
    }

    #[test]
    fn returns_no_changes_for_clean_or_ignored_only_snapshots() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join(".gitignore"), "ignored.md\n").unwrap();
        commit_all(temp.path(), "Ignore rules");
        let record = record_for(temp.path());
        let clean_status = service().status(&record).unwrap();
        let clean_error = service()
            .create_snapshot(
                &record,
                snapshot_request(&record, &clean_status, "Clean snapshot"),
            )
            .unwrap_err();
        assert_eq!(clean_error.code, GitOperationErrorCode::NoChanges);

        fs::write(temp.path().join("ignored.md"), "# Ignored").unwrap();
        let ignored_status = service().status(&record).unwrap();
        assert_eq!(ignored_status.counts.ignored, 1);
        assert!(!ignored_status.has_changes);

        let ignored_error = service()
            .create_snapshot(
                &record,
                snapshot_request(&record, &ignored_status, "Ignored snapshot"),
            )
            .unwrap_err();
        assert_eq!(ignored_error.code, GitOperationErrorCode::NoChanges);
    }

    #[test]
    fn blocks_snapshot_when_repository_token_is_stale() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();
        let record = record_for(temp.path());
        let status = service().status(&record).unwrap();
        fs::write(temp.path().join("later.md"), "# Later").unwrap();

        let error = service()
            .create_snapshot(&record, snapshot_request(&record, &status, "Stale"))
            .unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::ExternalStateChanged);
    }

    #[test]
    fn blocks_snapshot_when_expected_file_state_is_stale() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();
        let record = record_for(temp.path());
        let status = service().status(&record).unwrap();
        let mut request = snapshot_request(&record, &status, "Stale file state");
        request.expected_file_states = vec![GitExpectedFileState {
            relative_path: "missing.md".to_owned(),
            expected_version: crate::models::FileVersion {
                modified_at: "2026-05-11T00:00:00.000Z".to_owned(),
                byte_size: 0,
                content_hash: "sha256:missing".to_owned(),
                token: "missing-token".to_owned(),
            },
        }];

        let error = service().create_snapshot(&record, request).unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::ExternalStateChanged);
        assert_eq!(error.relative_path.as_deref(), Some("missing.md"));
        assert!(git_stdout(temp.path(), &["status", "--porcelain"])
            .lines()
            .any(|line| line.ends_with("idea.md")));
    }

    #[test]
    fn blocks_snapshot_without_author_identity() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        git(temp.path(), &["config", "user.name", ""]);
        git(temp.path(), &["config", "user.email", ""]);
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();
        let record = record_for(temp.path());
        let status = service().status(&record).unwrap();
        let mut request = snapshot_request(&record, &status, "Missing identity");
        request.author = None;

        let error = service().create_snapshot(&record, request).unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::IdentityMissing);
    }

    #[test]
    fn blocks_snapshot_for_detached_head_and_merge_states() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();
        commit_all(temp.path(), "Initial");
        let head = git_stdout(temp.path(), &["rev-parse", "HEAD"]);
        git(temp.path(), &["checkout", "--quiet", &head]);
        fs::write(temp.path().join("idea.md"), "# Changed").unwrap();
        let record = record_for(temp.path());
        let detached_status = service().status(&record).unwrap();

        let error = service()
            .create_snapshot(
                &record,
                snapshot_request(&record, &detached_status, "Detached"),
            )
            .unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::DetachedHead);

        let merge_temp = tempfile::tempdir().unwrap();
        git(merge_temp.path(), &["init", "--quiet"]);
        configure_identity(merge_temp.path());
        fs::write(merge_temp.path().join(".git").join("MERGE_HEAD"), &head).unwrap();
        fs::write(merge_temp.path().join("idea.md"), "# Merge").unwrap();
        let merge_record = record_for(merge_temp.path());
        let merge_status = service().status(&merge_record).unwrap();
        let merge_error = service()
            .create_snapshot(
                &merge_record,
                snapshot_request(&merge_record, &merge_status, "Merge"),
            )
            .unwrap_err();

        assert_eq!(merge_error.code, GitOperationErrorCode::MergeConflict);
    }

    #[test]
    fn rejects_unsafe_snapshot_scope_paths() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();
        let record = record_for(temp.path());
        let status = service().status(&record).unwrap();
        let mut request = snapshot_request(&record, &status, "Unsafe");
        request.scope_paths = vec![".git/config".to_owned()];

        let error = service().create_snapshot(&record, request).unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::PermissionDenied);
    }

    #[test]
    fn classifies_workspace_inside_parent_repository() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        let workspace = temp.path().join("notes");
        fs::create_dir(&workspace).unwrap();
        fs::write(workspace.join("idea.md"), "# Idea").unwrap();
        let record = record_for(&workspace);

        let state = service().detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::ParentRepository);
        assert_eq!(state.relative_prefix.as_deref(), Some("notes"));
        assert_eq!(
            state.blocked_reason,
            Some(GitOperationErrorCode::ParentRepository)
        );
    }

    #[test]
    fn classifies_nested_repository_under_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("nested");
        fs::create_dir(&nested).unwrap();
        git(&nested, &["init", "--quiet"]);
        let record = record_for(temp.path());

        let state = service().detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::NestedRepository);
        assert_eq!(state.relative_prefix.as_deref(), Some("nested"));
        assert_eq!(
            state.blocked_reason,
            Some(GitOperationErrorCode::NestedRepository)
        );
    }

    #[test]
    fn classifies_nested_bare_repository_under_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("nested-bare.git");
        fs::create_dir(&nested).unwrap();
        git(&nested, &["init", "--bare", "--quiet"]);
        let record = record_for(temp.path());

        let state = service().detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::NestedRepository);
        assert_eq!(state.relative_prefix.as_deref(), Some("nested-bare.git"));
    }

    #[test]
    fn classifies_nested_repository_inside_root_repository() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        let nested = temp.path().join("nested");
        fs::create_dir(&nested).unwrap();
        git(&nested, &["init", "--quiet"]);
        let record = record_for(temp.path());

        let state = service().detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::NestedRepository);
        assert!(state.repository_root_display_path.is_some());
        assert!(state.token.is_some());
    }

    #[test]
    fn classifies_corrupt_root_git_metadata() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".git")).unwrap();
        fs::write(temp.path().join(".git").join("HEAD"), "not a valid head").unwrap();
        let record = record_for(temp.path());

        let state = service().detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::RepositoryCorrupt);
        assert_eq!(
            state.blocked_reason,
            Some(GitOperationErrorCode::RepositoryCorrupt)
        );
    }

    #[test]
    fn refresh_state_returns_blocked_repository_summary_without_status_error() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".git")).unwrap();
        fs::write(temp.path().join(".git").join("HEAD"), "not a valid head").unwrap();
        let record = record_for(temp.path());

        let summary = service().refresh_state(&record).unwrap();

        assert_eq!(
            summary.repository_state.state,
            GitRepositoryStateKind::RepositoryCorrupt
        );
        assert!(summary.entries.is_empty());
        assert_eq!(
            summary.repository_state.blocked_reason,
            Some(GitOperationErrorCode::RepositoryCorrupt)
        );
    }

    #[test]
    fn classifies_bare_repository_at_workspace_root() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--bare", "--quiet"]);
        let record = record_for(temp.path());

        let state = service().detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::BareRepository);
        assert_eq!(
            state.blocked_reason,
            Some(GitOperationErrorCode::BareRepository)
        );
    }

    #[test]
    fn classifies_detached_head() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        configure_identity(temp.path());
        fs::write(temp.path().join("idea.md"), "# Idea").unwrap();
        git(temp.path(), &["add", "idea.md"]);
        git(temp.path(), &["commit", "--quiet", "-m", "Initial"]);
        let head = Command::new(DEFAULT_GIT_EXECUTABLE)
            .current_dir(temp.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();
        let head = String::from_utf8_lossy(&head.stdout).trim().to_owned();
        git(temp.path(), &["checkout", "--quiet", &head]);
        let record = record_for(temp.path());

        let state = service().detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::DetachedHead);
        assert!(state.branch_name.is_none());
        assert_eq!(state.head_oid.as_deref(), Some(head.as_str()));
    }

    #[test]
    fn classifies_merge_or_sequencer_markers() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        fs::write(temp.path().join(".git").join("MERGE_HEAD"), "abc").unwrap();
        let record = record_for(temp.path());

        let state = service().detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::MergeConflict);
        assert_eq!(
            state.blocked_reason,
            Some(GitOperationErrorCode::MergeConflict)
        );
    }

    #[test]
    fn blocks_enablement_for_unsupported_repository_states() {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--quiet"]);
        let workspace = temp.path().join("notes");
        fs::create_dir(&workspace).unwrap();
        let record = record_for(&workspace);

        let error = service().enable(&record).unwrap_err();

        assert_eq!(error.code, GitOperationErrorCode::ParentRepository);
        assert_eq!(error.operation, GitServiceOperation::Init);
    }

    #[test]
    fn maps_missing_git_executable_to_git_unavailable_state() {
        let temp = tempfile::tempdir().unwrap();
        let record = record_for(temp.path());
        let unavailable = GitRepositoryService::with_executable("__missing_how_to_think_git__");

        let state = unavailable.detect(&record).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::GitUnavailable);
        assert_eq!(
            state.blocked_reason,
            Some(GitOperationErrorCode::GitUnavailable)
        );
    }

    #[cfg(unix)]
    #[test]
    fn classifies_permission_denied_workspace_access() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let record = record_for(temp.path());
        let mut permissions = fs::metadata(temp.path()).unwrap().permissions();
        permissions.set_mode(0o000);
        fs::set_permissions(temp.path(), permissions).unwrap();

        let state = service().detect(&record).unwrap();

        let mut restored = fs::metadata(temp.path()).unwrap().permissions();
        restored.set_mode(0o700);
        fs::set_permissions(temp.path(), restored).unwrap();

        assert_eq!(state.state, GitRepositoryStateKind::PermissionDenied);
    }
}
