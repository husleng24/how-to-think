use crate::git_contracts::{
    is_repository_token_stale, validate_git_workspace_relative_path, GitAuthorIdentity,
    GitBackendInfo, GitBackendKind, GitOperationError, GitOperationErrorCode, GitRepositoryState,
    GitRepositoryStateKind, GitRepositoryStateToken, GitRepositoryWarning, GitServiceOperation,
    GitSnapshotRequest, GitSnapshotResult, GitStatusChangeKind, GitStatusCounts, GitStatusEntry,
    GitStatusSummary,
};
use crate::models::{IsoDateTime, WorkspaceRecord, WorkspaceRelativePath};
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

pub fn create_snapshot(
    record: &WorkspaceRecord,
    request: GitSnapshotRequest,
) -> Result<GitSnapshotResult, GitOperationError> {
    GitRepositoryService::default().create_snapshot(record, request)
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
    } else if lower.contains("nothing to commit") {
        GitOperationErrorCode::NoChanges
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
