import type {
  DocumentSnapshot,
  FileVersion,
  LinkIndexSnapshot,
  MarkdownMindMapDocument,
  OpenMarkdownMindMapResult,
  SaveMarkdownMindMapResult,
  WorkspaceFile,
  WorkspaceRelativePath,
} from '../../types/markdownLifecycle';
import type { WorkspaceError, WorkspaceErrorCode, WorkspaceOperation, WorkspaceSession } from './types';

export interface WorkspaceLifecycleFixture {
  workspaceId: string;
  displayName: string;
  displayPath: string;
  markdownFiles: Record<WorkspaceRelativePath, string>;
  nonMarkdownPaths: WorkspaceRelativePath[];
  skippedMarkdownPaths: WorkspaceRelativePath[];
  files(): WorkspaceFile[];
  file(relativePath: WorkspaceRelativePath, content?: string): WorkspaceFile;
  session(input?: {
    files?: WorkspaceFile[];
    lastOpenedFile?: WorkspaceRelativePath | null;
  }): WorkspaceSession;
  snapshot(
    relativePath: WorkspaceRelativePath,
    input?: { content?: string; versionToken?: string; openedAt?: string },
  ): DocumentSnapshot;
  openResult(
    relativePath: WorkspaceRelativePath,
    input?: { content?: string; files?: WorkspaceFile[]; versionToken?: string },
  ): OpenMarkdownMindMapResult;
  savedResult(
    relativePath: WorkspaceRelativePath,
    input?: { markdown?: string; files?: WorkspaceFile[]; versionToken?: string },
  ): SaveMarkdownMindMapResult;
  error(
    code: WorkspaceErrorCode,
    relativePath: WorkspaceRelativePath,
    operation?: WorkspaceOperation,
  ): WorkspaceError;
}

const FIXTURE_TIME = '2026-05-10T00:00:00Z';
const SAVED_TIME = '2026-05-10T00:01:00Z';

const DEFAULT_MARKDOWN_FILES: Record<WorkspaceRelativePath, string> = {
  'README.md': '# Workspace\n',
  'notes/plan.md': '# Plan\n\n## Step A\n',
  'notes/empty.md': '',
  'notes/plain.md': 'This file has prose only and should still be treated as Markdown.\n',
  'projects/restart.md': '# Restart\n\n## Saved child\n',
};

const DEFAULT_NON_MARKDOWN_PATHS = ['assets/diagram.png', 'notes/todo.txt'];
const DEFAULT_SKIPPED_MARKDOWN_PATHS = [
  '.git/ignored.md',
  'node_modules/pkg/readme.md',
  'target/generated.md',
];

export function createWorkspaceLifecycleFixture(input: {
  workspaceId?: string;
  displayName?: string;
  displayPath?: string;
  markdownFiles?: Record<WorkspaceRelativePath, string>;
  nonMarkdownPaths?: WorkspaceRelativePath[];
  skippedMarkdownPaths?: WorkspaceRelativePath[];
} = {}): WorkspaceLifecycleFixture {
  const workspaceId = input.workspaceId ?? 'workspace-1';
  const displayName = input.displayName ?? 'Notes';
  const displayPath = input.displayPath ?? 'C:\\Notes';
  const markdownFiles = input.markdownFiles ?? DEFAULT_MARKDOWN_FILES;
  const nonMarkdownPaths = input.nonMarkdownPaths ?? DEFAULT_NON_MARKDOWN_PATHS;
  const skippedMarkdownPaths = input.skippedMarkdownPaths ?? DEFAULT_SKIPPED_MARKDOWN_PATHS;

  function file(relativePath: WorkspaceRelativePath, content = markdownFiles[relativePath] ?? ''): WorkspaceFile {
    const extension = relativePath.toLowerCase().endsWith('.markdown') ? '.markdown' : '.md';

    return {
      relativePath,
      name: relativePath.split('/').pop() ?? relativePath,
      extension,
      byteSize: content.length,
      modifiedAt: FIXTURE_TIME,
      version: fileVersion(`${relativePath}-token`, content),
    };
  }

  function files(): WorkspaceFile[] {
    return Object.entries(markdownFiles)
      .map(([relativePath, content]) => file(relativePath, content))
      .sort((left, right) => {
        if (left.relativePath === right.relativePath) {
          return 0;
        }

        return left.relativePath < right.relativePath ? -1 : 1;
      });
  }

  function session(inputSession: {
    files?: WorkspaceFile[];
    lastOpenedFile?: WorkspaceRelativePath | null;
  } = {}): WorkspaceSession {
    return {
      workspace: {
        id: workspaceId,
        displayName,
        displayPath,
        platform: 'windows',
        caseSensitive: false,
        writable: true,
        lastOpenedAt: FIXTURE_TIME,
      },
      files: inputSession.files ?? files(),
      lastOpenedFile: inputSession.lastOpenedFile ?? null,
    };
  }

  function snapshot(
    relativePath: WorkspaceRelativePath,
    snapshotInput: { content?: string; versionToken?: string; openedAt?: string } = {},
  ): DocumentSnapshot {
    const content = snapshotInput.content ?? markdownFiles[relativePath] ?? `# ${titleForPath(relativePath)}\n`;

    return {
      workspaceId,
      relativePath,
      content,
      version: fileVersion(snapshotInput.versionToken ?? `${relativePath}-token`, content),
      openedAt: snapshotInput.openedAt ?? FIXTURE_TIME,
    };
  }

  function openResult(
    relativePath: WorkspaceRelativePath,
    resultInput: { content?: string; files?: WorkspaceFile[]; versionToken?: string } = {},
  ): OpenMarkdownMindMapResult {
    const openedSnapshot = snapshot(relativePath, {
      content: resultInput.content,
      versionToken: resultInput.versionToken,
    });

    return {
      status: 'opened',
      snapshot: openedSnapshot,
      document: markdownDocument(relativePath, openedSnapshot.content),
      diagnostics: [],
      files: resultInput.files ?? files(),
      linkIndex: linkIndex(workspaceId, resultInput.files ?? files()),
    };
  }

  function savedResult(
    relativePath: WorkspaceRelativePath,
    resultInput: { markdown?: string; files?: WorkspaceFile[]; versionToken?: string } = {},
  ): SaveMarkdownMindMapResult {
    const markdown = resultInput.markdown ?? markdownFiles[relativePath] ?? `# ${titleForPath(relativePath)}\n`;
    const version = fileVersion(resultInput.versionToken ?? 'saved-token', markdown);
    const savedFile = file(relativePath, markdown);
    const resultFiles = resultInput.files ?? [savedFile];

    return {
      status: 'saved',
      diagnostics: [],
      metadata: {
        schemaVersion: 'mindmap-document.v1',
        sourcePath: relativePath,
        targetPath: relativePath,
        saveMode: 'canonical_headings',
        preservationPolicy: 'block_lossy',
        lineEnding: 'lf',
        canonicalized: true,
        nodeCount: 1,
        unmappedBlockCount: 0,
      },
      markdown,
      save: {
        workspaceId,
        relativePath,
        version,
        savedAt: SAVED_TIME,
        byteSize: markdown.length,
      },
      files: resultFiles,
      linkIndex: linkIndex(workspaceId, resultFiles),
    };
  }

  function error(
    code: WorkspaceErrorCode,
    relativePath: WorkspaceRelativePath,
    operation: WorkspaceOperation = 'saveFile',
  ): WorkspaceError {
    return {
      code,
      message: workspaceErrorMessage(code),
      recoverable: true,
      operation,
      relativePath,
    };
  }

  return {
    workspaceId,
    displayName,
    displayPath,
    markdownFiles,
    nonMarkdownPaths,
    skippedMarkdownPaths,
    files,
    file,
    session,
    snapshot,
    openResult,
    savedResult,
    error,
  };
}

function fileVersion(token: string, content: string): FileVersion {
  return {
    modifiedAt: FIXTURE_TIME,
    byteSize: content.length,
    contentHash: `${stableHash(content)}-${token}`,
    token,
  };
}

function markdownDocument(
  relativePath: WorkspaceRelativePath,
  content: string,
): MarkdownMindMapDocument {
  const title = firstHeading(content) ?? titleForPath(relativePath);
  const hasHeading = firstHeading(content) != null;

  return {
    schemaVersion: 'mindmap-document.v1',
    sourcePath: relativePath,
    title,
    parseMode: 'auto',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        title,
        rawText: '',
        nodeKind: 'virtual_root',
        children: hasHeading ? ['heading-1'] : [],
        origin: origin(relativePath, 'document_root'),
        links: [],
        listMarker: null,
      },
      ...(hasHeading
        ? {
            'heading-1': {
              id: 'heading-1',
              title,
              rawText: `# ${title}`,
              nodeKind: 'heading' as const,
              children: [],
              origin: origin(relativePath, 'heading', 1),
              links: [],
              listMarker: null,
            },
          }
        : {}),
    },
    unmappedBlocks: [],
    diagnostics: [],
  };
}

function origin(
  relativePath: WorkspaceRelativePath,
  blockKind: 'document_root' | 'heading',
  headingLevel: number | null = null,
) {
  return {
    sourcePath: relativePath,
    span: {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    },
    blockKind,
    headingLevel,
    listDepth: null,
  };
}

function linkIndex(workspaceId: string, files: WorkspaceFile[]): LinkIndexSnapshot {
  return {
    workspaceId,
    files: files.map((file) => ({
      relativePath: file.relativePath,
      absolutePath: `C:\\Notes\\${file.relativePath.replace(/\//g, '\\')}`,
      name: file.name,
      stem: file.name.replace(/\.(md|markdown)$/i, ''),
      pathLookupKey: file.relativePath.toLowerCase(),
      stemLookupKey: file.name.replace(/\.(md|markdown)$/i, '').toLowerCase(),
      headings: [],
    })),
    diagnostics: [],
  };
}

function firstHeading(content: string): string | null {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+)$/)?.[1]?.trim())
    .find((value): value is string => Boolean(value));

  return heading ?? null;
}

function titleForPath(relativePath: WorkspaceRelativePath): string {
  const fileName = relativePath.split('/').pop() ?? relativePath;
  const withoutExtension = fileName.replace(/\.(md|markdown)$/i, '');
  const title = withoutExtension.replace(/[-_]+/g, ' ').trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function stableHash(content: string): string {
  let hash = 0;

  for (const character of content) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}

function workspaceErrorMessage(code: WorkspaceErrorCode): string {
  switch (code) {
    case 'version_conflict':
      return 'The Markdown file changed on disk after it was opened or last saved.';
    case 'file_not_found':
      return 'The requested file does not exist.';
    case 'workspace_missing':
      return 'The workspace directory does not exist.';
    default:
      return 'The workspace operation failed.';
  }
}
