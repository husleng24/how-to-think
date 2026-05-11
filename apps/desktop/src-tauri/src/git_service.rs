use crate::git_contracts::{
    GitBackendInfo, GitBackendKind, GitOperationError, GitOperationErrorCode, GitRepositoryState,
    GitRepositoryStateKind, GitRepositoryStateToken, GitRepositoryWarning, GitServiceOperation,
};
use crate::models::{IsoDateTime, WorkspaceRecord, WorkspaceRelativePath};
use crate::time_utils::now_iso;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
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
            token: None,
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
            ["status", "--porcelain=v1", "-z"],
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

    fn raw_git_output<I, S>(&self, cwd: Option<&Path>, args: I) -> io::Result<Output>
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
            .output()
    }
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
        git(
            temp.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        git(temp.path(), &["config", "user.name", "Test User"]);
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
        git(
            temp.path(),
            &["config", "user.email", "test@example.invalid"],
        );
        git(temp.path(), &["config", "user.name", "Test User"]);
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
