use crate::errors::WorkspaceOperation;
use crate::models::WorkspaceRecord;
use crate::workspace::validate_workspace_root;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

pub(crate) struct LocalFirstWorkspaceFixture {
    temp_dir: TempDir,
    record: WorkspaceRecord,
}

impl LocalFirstWorkspaceFixture {
    pub(crate) fn create() -> Self {
        let temp_dir = tempfile::tempdir().expect("temp workspace should be created");
        let root = temp_dir.path();

        create_dir(root, "notes");
        create_dir(root, "projects");
        create_dir(root, "assets");
        create_dir(root, ".git");
        create_dir(root, "node_modules/pkg");
        create_dir(root, "target");

        write_text(root, "README.md", "# Workspace\n");
        write_text(root, "notes/plan.md", "# Plan\n\n## Step A\n");
        write_text(root, "notes/empty.md", "");
        write_text(
            root,
            "notes/plain.md",
            "This file has prose only and should still be indexed as Markdown.\n",
        );
        write_bytes(root, "notes/invalid-utf8.md", &[0xff, 0xfe, 0xfd]);
        write_text(root, "projects/restart.md", "# Restart\n\n## Saved child\n");
        write_text(root, "assets/diagram.png", "not markdown");
        write_text(root, "notes/todo.txt", "not markdown");
        write_text(root, ".git/ignored.md", "# Ignored\n");
        write_text(root, "node_modules/pkg/readme.md", "# Ignored dependency\n");
        write_text(root, "target/generated.md", "# Ignored build output\n");

        let record = validate_workspace_root(root, WorkspaceOperation::SelectWorkspace)
            .expect("fixture workspace should validate");

        Self { temp_dir, record }
    }

    pub(crate) fn root(&self) -> &Path {
        self.temp_dir.path()
    }

    pub(crate) fn record(&self) -> &WorkspaceRecord {
        &self.record
    }

    pub(crate) fn restarted_record(&self) -> WorkspaceRecord {
        validate_workspace_root(self.root(), WorkspaceOperation::LoadWorkspace)
            .expect("fixture workspace should reload")
    }

    pub(crate) fn expected_indexed_markdown_paths(&self) -> Vec<&'static str> {
        vec![
            "README.md",
            "notes/empty.md",
            "notes/invalid-utf8.md",
            "notes/plain.md",
            "notes/plan.md",
            "projects/restart.md",
        ]
    }
}

fn create_dir(root: &Path, relative_path: &str) {
    fs::create_dir_all(root.join(relative_path)).expect("fixture directory should be created");
}

fn write_text(root: &Path, relative_path: &str, content: &str) {
    fs::write(root.join(relative_path), content).expect("fixture text file should be written");
}

fn write_bytes(root: &Path, relative_path: &str, content: &[u8]) {
    fs::write(root.join(relative_path), content).expect("fixture byte file should be written");
}
