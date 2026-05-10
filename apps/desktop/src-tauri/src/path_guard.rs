use crate::errors::{WorkspaceError, WorkspaceErrorCode, WorkspaceOperation};
use crate::models::WorkspaceRelativePath;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWorkspacePath {
    pub relative_path: WorkspaceRelativePath,
    pub absolute_path: PathBuf,
}

pub fn validate_workspace_relative_path(
    relative_path: &str,
    case_sensitive: bool,
    operation: WorkspaceOperation,
) -> Result<WorkspaceRelativePath, WorkspaceError> {
    if relative_path.is_empty() {
        return Err(invalid_relative_path(
            operation,
            relative_path,
            "Workspace-relative paths cannot be empty.",
        ));
    }

    if relative_path.starts_with("//") {
        return Err(invalid_relative_path(
            operation,
            relative_path,
            "Workspace-relative paths cannot use UNC prefixes.",
        ));
    }

    if relative_path.starts_with('/') {
        return Err(invalid_relative_path(
            operation,
            relative_path,
            "Workspace-relative paths cannot start with a slash.",
        ));
    }

    if has_windows_drive_prefix(relative_path) {
        return Err(invalid_relative_path(
            operation,
            relative_path,
            "Workspace-relative paths cannot use a Windows drive prefix.",
        ));
    }

    if relative_path.contains('\\') {
        return Err(invalid_relative_path(
            operation,
            relative_path,
            "Workspace-relative paths must use forward slashes.",
        ));
    }

    if relative_path.chars().any(char::is_control) {
        return Err(invalid_relative_path(
            operation,
            relative_path,
            "Workspace-relative paths cannot contain control characters.",
        ));
    }

    let segments: Vec<&str> = relative_path.split('/').collect();
    for segment in &segments {
        if segment.is_empty() {
            return Err(invalid_relative_path(
                operation,
                relative_path,
                "Workspace-relative paths cannot contain empty segments.",
            ));
        }

        if matches!(*segment, "." | "..") {
            return Err(invalid_relative_path(
                operation,
                relative_path,
                "Workspace-relative paths cannot contain dot segments.",
            ));
        }

        if is_windows_reserved_segment(segment) {
            return Err(invalid_relative_path(
                operation,
                relative_path,
                "Workspace-relative paths cannot contain Windows reserved device names.",
            ));
        }
    }

    let file_name = segments.last().copied().unwrap_or_default();
    if supported_markdown_extension(file_name, case_sensitive).is_none() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::UnsupportedFileType,
            operation,
            "Only Markdown files ending in .md or .markdown are supported.",
            true,
        )
        .with_relative_path(relative_path));
    }

    Ok(relative_path.to_owned())
}

pub fn resolve_existing_markdown_file(
    workspace_root: &Path,
    relative_path: &str,
    case_sensitive: bool,
    operation: WorkspaceOperation,
) -> Result<ResolvedWorkspacePath, WorkspaceError> {
    let relative_path = validate_workspace_relative_path(relative_path, case_sensitive, operation)?;
    let canonical_root = canonical_workspace_root(workspace_root, operation)?;
    let candidate = canonical_root.join(relative_path_to_path_buf(&relative_path));
    let canonical_candidate = fs::canonicalize(&candidate)
        .map_err(|error| WorkspaceError::from_io(operation, Some(&relative_path), &error))?;

    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::PathOutsideWorkspace,
            operation,
            "The resolved path is outside the selected workspace.",
            true,
        )
        .with_relative_path(relative_path));
    }

    let metadata = fs::metadata(&canonical_candidate)
        .map_err(|error| WorkspaceError::from_io(operation, Some(&relative_path), &error))?;
    if !metadata.is_file() {
        return Err(WorkspaceError::new(
            WorkspaceErrorCode::FileNotFound,
            operation,
            "The requested Markdown file does not exist.",
            true,
        )
        .with_relative_path(relative_path));
    }

    Ok(ResolvedWorkspacePath {
        relative_path,
        absolute_path: canonical_candidate,
    })
}

pub fn relative_path_to_path_buf(relative_path: &str) -> PathBuf {
    relative_path.split('/').collect()
}

pub fn supported_markdown_extension(file_name: &str, case_sensitive: bool) -> Option<&'static str> {
    let extension = file_name.rsplit_once('.')?.1;

    if matches_extension(extension, "md", case_sensitive) {
        Some(".md")
    } else if matches_extension(extension, "markdown", case_sensitive) {
        Some(".markdown")
    } else {
        None
    }
}

fn canonical_workspace_root(
    workspace_root: &Path,
    operation: WorkspaceOperation,
) -> Result<PathBuf, WorkspaceError> {
    fs::canonicalize(workspace_root).map_err(|error| {
        WorkspaceError::new(
            WorkspaceErrorCode::InvalidWorkspacePath,
            operation,
            "The workspace path cannot be canonicalized.",
            true,
        )
        .with_detail("source", error.to_string())
    })
}

fn matches_extension(extension: &str, expected: &str, case_sensitive: bool) -> bool {
    if case_sensitive {
        extension == expected
    } else {
        extension.eq_ignore_ascii_case(expected)
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
        .trim_end_matches(|character| character == ' ' || character == '.');
    let stem = stem.to_ascii_uppercase();

    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

fn invalid_relative_path(
    operation: WorkspaceOperation,
    relative_path: &str,
    message: &'static str,
) -> WorkspaceError {
    WorkspaceError::new(
        WorkspaceErrorCode::InvalidRelativePath,
        operation,
        message,
        true,
    )
    .with_relative_path(relative_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validate(path: &str) -> Result<WorkspaceRelativePath, WorkspaceError> {
        validate_workspace_relative_path(path, true, WorkspaceOperation::OpenFile)
    }

    #[test]
    fn accepts_markdown_relative_paths() {
        assert_eq!(validate("notes/idea.md").unwrap(), "notes/idea.md");
        assert_eq!(
            validate("notes/deeper/idea.markdown").unwrap(),
            "notes/deeper/idea.markdown"
        );
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        for path in [
            "../notes.md",
            "notes/../../secret.md",
            "/Users/example/notes.md",
            "C:/Users/example/notes.md",
            "//server/share/notes.md",
            "notes\\idea.md",
            "notes//idea.md",
            "notes/.hidden/../idea.md",
        ] {
            let error = validate(path).unwrap_err();
            assert_eq!(error.code, WorkspaceErrorCode::InvalidRelativePath);
        }
    }

    #[test]
    fn rejects_unsupported_extensions() {
        let error = validate("notes/idea.txt").unwrap_err();
        assert_eq!(error.code, WorkspaceErrorCode::UnsupportedFileType);
    }

    #[test]
    fn supports_case_insensitive_markdown_extensions_when_requested() {
        assert!(validate_workspace_relative_path(
            "notes/idea.MD",
            false,
            WorkspaceOperation::OpenFile
        )
        .is_ok());

        let error =
            validate_workspace_relative_path("notes/idea.MD", true, WorkspaceOperation::OpenFile)
                .unwrap_err();
        assert_eq!(error.code, WorkspaceErrorCode::UnsupportedFileType);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_windows_reserved_device_names() {
        for path in ["CON.md", "folder/aux.markdown", "LPT1.md", "com9.markdown"] {
            let error = validate(path).unwrap_err();
            assert_eq!(error.code, WorkspaceErrorCode::InvalidRelativePath);
        }
    }
}
