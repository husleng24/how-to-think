use how_to_think_desktop_lib::documents;
use how_to_think_desktop_lib::errors::WorkspaceOperation;
use how_to_think_desktop_lib::git_contracts::{
    GitAuthorIdentity, GitDiffMode, GitDiffRequest, GitExpectedFileState, GitHistoryRequest,
    GitOperationErrorCode, GitRepositoryStateKind, GitRestoreRequest, GitSnapshotRequest,
    GitStatusChangeKind, GitStatusSummary,
};
use how_to_think_desktop_lib::git_service;
use how_to_think_desktop_lib::markdown_lifecycle::{
    self, OpenMarkdownMindMapRequest, OpenMarkdownMindMapStatus, SerializeMindMapRequest,
    SerializeMindMapStatus,
};
use how_to_think_desktop_lib::models::{FileVersion, SaveReason, SaveRequest, WorkspaceRecord};
use how_to_think_desktop_lib::workspace::{validate_workspace_root, workspace_session};
use how_to_think_markdown::{
    MarkdownLineEnding, MarkdownSerializeMode, ParseMode, SerializePreservationPolicy,
};
use std::fs;
use std::path::Path;
use std::process::Command;

const LOCAL_GIT_GUIDE: &str = include_str!("../../docs/local-git-workflow.md");

const INITIAL_MARKDOWN: &str = "# Thinking Plan\n\n## Observe\n\n- Capture signal\n- Note constraints\n\n## Decide\n\n[Related note](related.md)\n";
const AI_APPLIED_MARKDOWN: &str = "# Thinking Plan\n\n## Observe\n\n- Capture signal\n- Note constraints\n\n## Decide\n\n[Related note](related.md)\n\n## AI Recovery\n\n- Deterministic suggestion\n";
const EXTERNAL_MARKDOWN: &str = "# External Draft\n\n## Changed outside app\n";

#[test]
fn full_local_git_flow_restores_markdown_and_recovers_ai_changes() {
    let temp = tempfile::tempdir().unwrap();
    let notes_dir = temp.path().join("notes");
    fs::create_dir(&notes_dir).unwrap();
    fs::write(notes_dir.join("root.md"), INITIAL_MARKDOWN).unwrap();
    fs::write(notes_dir.join("related.md"), "# Related\n").unwrap();
    fs::write(temp.path().join(".gitignore"), "ignored.md\n").unwrap();
    fs::write(temp.path().join("ignored.md"), "# Ignored\n").unwrap();
    let record = record(temp.path());

    let detected = git_service::detect_repository(&record).unwrap();
    assert_eq!(detected.state, GitRepositoryStateKind::NotRepository);

    let enabled = git_service::enable_git_for_workspace(&record).unwrap();
    assert_eq!(enabled.state, GitRepositoryStateKind::ValidRepository);
    assert!(temp.path().join(".git").exists());

    let initial_status = git_service::get_git_status(&record).unwrap();
    assert_eq!(initial_status.counts.untracked, 2);
    assert_eq!(initial_status.counts.ignored, 1);
    assert!(initial_status.has_changes);

    let initial_snapshot = git_service::create_snapshot(
        &record,
        snapshot_request(&record, &initial_status, "Initial local snapshot"),
    )
    .unwrap();
    let initial_commit = initial_snapshot.commit_oid.clone();
    assert_eq!(initial_snapshot.parent_oids, Vec::<String>::new());
    assert!(!initial_snapshot.status.has_changes);

    let opened = documents::open_document(&record, "notes/root.md").unwrap();
    documents::save_document(
        &record,
        SaveRequest {
            workspace_id: record.info.id.clone(),
            relative_path: "notes/root.md".to_owned(),
            content: AI_APPLIED_MARKDOWN.to_owned(),
            expected_version: opened.version,
            reason: SaveReason::Manual,
        },
    )
    .unwrap();

    let ai_status = git_service::get_git_status(&record).unwrap();
    assert_eq!(ai_status.changed_file_count, 1);
    let ai_entry = status_entry_for(&ai_status, "notes/root.md");
    assert_eq!(ai_entry.unstaged, GitStatusChangeKind::Modified);

    let ai_diff = git_service::get_git_diff(
        &record,
        GitDiffRequest {
            workspace_id: record.info.id.clone(),
            mode: GitDiffMode::WorkingTree,
            relative_path: Some("notes/root.md".to_owned()),
            base_ref: Some(initial_commit.clone()),
            head_ref: None,
        },
    )
    .unwrap();
    assert_eq!(ai_diff.file_count, 1);
    assert!(ai_diff.files[0]
        .hunks
        .iter()
        .flat_map(|hunk| hunk.lines.iter())
        .any(|line| line.content.contains("AI Recovery")));

    let ai_snapshot = git_service::create_snapshot(
        &record,
        snapshot_request(&record, &ai_status, "Apply deterministic AI suggestion"),
    )
    .unwrap();
    let ai_commit = ai_snapshot.commit_oid.clone();
    assert_eq!(ai_snapshot.parent_oids, vec![initial_commit.clone()]);
    assert!(!ai_snapshot.status.has_changes);

    let history = git_service::list_git_history(
        &record,
        GitHistoryRequest {
            workspace_id: record.info.id.clone(),
            relative_path: Some("notes/root.md".to_owned()),
            max_entries: Some(10),
        },
    )
    .unwrap();
    assert_eq!(
        history
            .iter()
            .map(|entry| entry.subject.as_str())
            .collect::<Vec<_>>(),
        vec![
            "Apply deterministic AI suggestion",
            "Initial local snapshot"
        ]
    );

    let head_before_restore = git_stdout(temp.path(), &["rev-parse", "--verify", "HEAD"]);
    let current_doc = documents::open_document(&record, "notes/root.md").unwrap();
    let clean_status = git_service::get_git_status(&record).unwrap();
    assert!(!clean_status.has_changes);

    let restored = git_service::restore_git_file(
        &record,
        restore_request(
            &record,
            &clean_status,
            "notes/root.md",
            &initial_commit,
            current_doc.version,
        ),
    )
    .unwrap();

    assert_eq!(
        git_stdout(temp.path(), &["rev-parse", "--verify", "HEAD"]),
        head_before_restore
    );
    assert_eq!(restored.snapshot.content, INITIAL_MARKDOWN);
    assert_eq!(
        fs::read_to_string(notes_dir.join("root.md")).unwrap(),
        INITIAL_MARKDOWN
    );
    assert!(restored.status.has_changes);
    let restored_entry = status_entry_for(&restored.status, "notes/root.md");
    assert_eq!(restored_entry.unstaged, GitStatusChangeKind::Modified);

    let reopened = markdown_lifecycle::open_markdown_mind_map(
        &record,
        OpenMarkdownMindMapRequest {
            workspace_id: record.info.id.clone(),
            relative_path: "notes/root.md".to_owned(),
            parse_mode: ParseMode::Auto,
        },
    )
    .unwrap();
    assert_eq!(reopened.status, OpenMarkdownMindMapStatus::Opened);
    let restored_document = reopened.document.unwrap();
    assert_eq!(restored_document.title, "Thinking Plan");

    let serialized = markdown_lifecycle::serialize_mind_map(SerializeMindMapRequest {
        document: restored_document,
        target_path: Some("notes/root.md".to_owned()),
        save_mode: MarkdownSerializeMode::CanonicalHeadings,
        preservation_policy: SerializePreservationPolicy::BlockLossy,
        line_ending: MarkdownLineEnding::Lf,
    });
    assert!(matches!(
        serialized.status,
        SerializeMindMapStatus::Serialized | SerializeMindMapStatus::LossySaveConfirmationRequired
    ));
    assert!(serialized
        .markdown
        .unwrap_or_default()
        .contains("# Thinking Plan"));

    let restored_old_status = git_service::get_git_status(&record).unwrap();
    let restored_old_doc = documents::open_document(&record, "notes/root.md").unwrap();
    let recovered_ai = git_service::restore_git_file(
        &record,
        restore_request(
            &record,
            &restored_old_status,
            "notes/root.md",
            &ai_commit,
            restored_old_doc.version,
        ),
    )
    .unwrap();
    assert_eq!(recovered_ai.snapshot.content, AI_APPLIED_MARKDOWN);
    assert_eq!(
        fs::read_to_string(notes_dir.join("root.md")).unwrap(),
        AI_APPLIED_MARKDOWN
    );
    assert!(!recovered_ai.status.has_changes);
}

#[test]
fn external_git_and_file_changes_block_stale_snapshot_and_restore_without_overwrite() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join("notes")).unwrap();
    fs::write(temp.path().join("notes").join("root.md"), INITIAL_MARKDOWN).unwrap();
    let record = record(temp.path());

    git_service::enable_git_for_workspace(&record).unwrap();
    let initial_status = git_service::get_git_status(&record).unwrap();
    let initial_snapshot = git_service::create_snapshot(
        &record,
        snapshot_request(&record, &initial_status, "Initial local snapshot"),
    )
    .unwrap();

    let clean_status = git_service::get_git_status(&record).unwrap();
    let clean_doc = documents::open_document(&record, "notes/root.md").unwrap();
    configure_identity(temp.path());
    fs::write(
        temp.path().join("notes").join("external.md"),
        "# External\n",
    )
    .unwrap();
    git(temp.path(), &["add", "notes/external.md"]);
    git(
        temp.path(),
        &["commit", "--quiet", "-m", "External Git commit"],
    );

    let stale_restore = git_service::restore_git_file(
        &record,
        restore_request(
            &record,
            &clean_status,
            "notes/root.md",
            &initial_snapshot.commit_oid,
            clean_doc.version,
        ),
    )
    .unwrap_err();
    assert_eq!(
        stale_restore.code,
        GitOperationErrorCode::ExternalStateChanged
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("notes").join("root.md")).unwrap(),
        INITIAL_MARKDOWN
    );

    fs::write(temp.path().join("notes").join("root.md"), "# Local draft\n").unwrap();
    let draft_status = git_service::get_git_status(&record).unwrap();
    let stale_snapshot_request = snapshot_request(&record, &draft_status, "Save local draft");
    fs::write(temp.path().join("notes").join("root.md"), EXTERNAL_MARKDOWN).unwrap();

    let stale_snapshot = git_service::create_snapshot(&record, stale_snapshot_request).unwrap_err();
    assert_eq!(
        stale_snapshot.code,
        GitOperationErrorCode::ExternalStateChanged
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("notes").join("root.md")).unwrap(),
        EXTERNAL_MARKDOWN
    );

    let before_file_change_status = git_service::get_git_status(&record).unwrap();
    let before_file_change = documents::open_document(&record, "notes/root.md").unwrap();
    fs::write(
        temp.path().join("notes").join("root.md"),
        "# Changed outside app again\n",
    )
    .unwrap();
    let current_status = git_service::get_git_status(&record).unwrap();

    let stale_file_restore = git_service::restore_git_file(
        &record,
        restore_request(
            &record,
            &current_status,
            "notes/root.md",
            &initial_snapshot.commit_oid,
            before_file_change.version,
        ),
    )
    .unwrap_err();
    assert_eq!(
        stale_file_restore.code,
        GitOperationErrorCode::RestoreConflict
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("notes").join("root.md")).unwrap(),
        "# Changed outside app again\n"
    );
    assert!(before_file_change_status.has_changes);
}

#[test]
fn local_git_guide_documents_scope_blockers_and_validation() {
    for section in [
        "## First-Version Scope",
        "## User Workflow",
        "## Restore Semantics",
        "## Blocked States",
        "## Supported Platforms And Packaging",
        "## Validation Commands",
        "## Non-Goals",
    ] {
        assert!(
            LOCAL_GIT_GUIDE.contains(section),
            "local Git guide should include {section}"
        );
    }

    for operation in [
        "enable Git",
        "status",
        "snapshot",
        "history",
        "diff",
        "restore",
        "external change",
    ] {
        assert!(
            LOCAL_GIT_GUIDE.contains(operation),
            "local Git guide should document {operation}"
        );
    }

    for blocked_state in [
        "Git unavailable",
        "Missing identity",
        "Merge conflict",
        "Detached HEAD",
        "Repository corruption",
        "Permission denied",
        "External modification",
    ] {
        assert!(
            LOCAL_GIT_GUIDE.contains(blocked_state),
            "local Git guide should document {blocked_state}"
        );
    }

    for command in [
        "cargo fmt --manifest-path apps\\desktop\\src-tauri\\Cargo.toml -- --check",
        "cargo test --manifest-path apps\\desktop\\src-tauri\\Cargo.toml",
        "npm.cmd run typecheck --prefix apps\\desktop",
        "npm.cmd run lint --prefix apps\\desktop",
        "npm.cmd test --prefix apps\\desktop",
        "git diff --check",
    ] {
        assert!(
            LOCAL_GIT_GUIDE.contains(command),
            "local Git guide should record validation command {command}"
        );
    }
}

fn record(root: &Path) -> WorkspaceRecord {
    validate_workspace_root(root, WorkspaceOperation::SelectWorkspace).unwrap()
}

fn snapshot_request(
    record: &WorkspaceRecord,
    status: &GitStatusSummary,
    message: &str,
) -> GitSnapshotRequest {
    let scope_paths = status
        .entries
        .iter()
        .filter(|entry| is_snapshot_eligible(entry))
        .map(|entry| entry.relative_path.clone())
        .collect::<Vec<_>>();
    let expected_file_states = expected_file_states(record, &scope_paths);

    GitSnapshotRequest {
        workspace_id: record.info.id.clone(),
        message: message.to_owned(),
        scope_paths,
        expected_repo_token: status.token.clone().unwrap(),
        expected_file_states,
        author: Some(GitAuthorIdentity {
            name: "How to Think Tests".to_owned(),
            email: "tests@example.invalid".to_owned(),
        }),
    }
}

fn restore_request(
    record: &WorkspaceRecord,
    status: &GitStatusSummary,
    relative_path: &str,
    source_ref: &str,
    expected_file_version: FileVersion,
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

fn expected_file_states(
    record: &WorkspaceRecord,
    scope_paths: &[String],
) -> Vec<GitExpectedFileState> {
    let session = workspace_session(record).unwrap();

    scope_paths
        .iter()
        .filter_map(|relative_path| {
            session
                .files
                .iter()
                .find(|file| file.relative_path == *relative_path)
                .map(|file| GitExpectedFileState {
                    relative_path: relative_path.clone(),
                    expected_version: file.version.clone(),
                })
        })
        .collect()
}

fn is_snapshot_eligible(entry: &how_to_think_desktop_lib::git_contracts::GitStatusEntry) -> bool {
    if entry.conflicted {
        return false;
    }

    !matches!(
        primary_change_kind(entry),
        GitStatusChangeKind::Unmodified | GitStatusChangeKind::Ignored
    )
}

fn status_entry_for<'a>(
    status: &'a GitStatusSummary,
    relative_path: &str,
) -> &'a how_to_think_desktop_lib::git_contracts::GitStatusEntry {
    status
        .entries
        .iter()
        .find(|entry| entry.relative_path == relative_path)
        .unwrap_or_else(|| panic!("expected status entry for {relative_path}"))
}

fn primary_change_kind(
    entry: &how_to_think_desktop_lib::git_contracts::GitStatusEntry,
) -> GitStatusChangeKind {
    for kind in [entry.staged, entry.unstaged] {
        if kind == GitStatusChangeKind::Ignored {
            return GitStatusChangeKind::Ignored;
        }
    }

    for kind in [entry.staged, entry.unstaged] {
        if kind != GitStatusChangeKind::Unmodified {
            return kind;
        }
    }

    GitStatusChangeKind::Unmodified
}

fn configure_identity(cwd: &Path) {
    git(cwd, &["config", "user.name", "External User"]);
    git(cwd, &["config", "user.email", "external@example.invalid"]);
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap_or_else(|error| panic!("failed to run git {args:?}: {error}"));

    assert!(
        output.status.success(),
        "git {args:?} failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_stdout(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap_or_else(|error| panic!("failed to run git {args:?}: {error}"));

    assert!(
        output.status.success(),
        "git {args:?} failed: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}
