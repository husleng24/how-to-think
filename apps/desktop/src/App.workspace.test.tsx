import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import type {
  FileVersion,
  MarkdownMindMapDocument,
  OpenMarkdownMindMapResult,
  SaveMarkdownMindMapResult,
  WorkspaceFile,
} from './types/markdownLifecycle';
import type { WorkspaceSession } from './features/workspace';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe('App workspace lifecycle', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a workspace selection and creation path on first launch', async () => {
    invokeMock.mockResolvedValueOnce(null);

    render(<App />);

    const pathInput = await screen.findByLabelText(/workspace path/i);
    expect(pathInput).toBeVisible();
    expect(screen.getByRole('button', { name: /open workspace/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /create workspace/i })).toBeDisabled();

    fireEvent.change(pathInput, { target: { value: 'C:\\Notes' } });

    expect(screen.getByRole('button', { name: /open workspace/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /create workspace/i })).toBeEnabled();
  });

  it('creates, opens, saves, renames, and deletes Markdown files through Tauri commands', async () => {
    invokeMock.mockImplementation((command, args) => {
      const payload = args as InvokePayload | undefined;

      switch (command) {
        case 'load_remembered_workspace':
          return Promise.resolve(workspaceSession([]));
        case 'create_markdown_document':
          return Promise.resolve(snapshot(payload?.relativePath ?? 'ideas.md'));
        case 'openMarkdownMindMap':
          return Promise.resolve(openResult(payload?.request?.relativePath ?? 'ideas.md'));
        case 'remember_last_opened_file':
          return Promise.resolve();
        case 'saveMarkdownMindMap':
          return Promise.resolve(savedResult(payload?.request?.relativePath ?? 'ideas.md'));
        case 'rename_markdown_document':
          return Promise.resolve({
            workspaceId: 'workspace-1',
            relativePath: payload?.relativePath,
            newRelativePath: payload?.newRelativePath,
            file: workspaceFile(payload?.newRelativePath ?? 'renamed.md', 'renamed-token'),
            files: [workspaceFile(payload?.newRelativePath ?? 'renamed.md', 'renamed-token')],
            renamedAt: '2026-05-10T00:02:00Z',
          });
        case 'delete_markdown_document':
          return Promise.resolve({
            workspaceId: 'workspace-1',
            relativePath: payload?.relativePath,
            files: [],
            deletedAt: '2026-05-10T00:03:00Z',
          });
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    await screen.findByText('Notes');

    fireEvent.change(screen.getByLabelText(/new markdown path/i), {
      target: { value: 'ideas' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create markdown file/i }));

    expect(await screen.findByRole('button', { name: 'ideas.md' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /save markdown/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'saveMarkdownMindMap',
        expect.objectContaining({
          request: expect.objectContaining({
            relativePath: 'ideas.md',
            reason: 'manual',
          }),
        }),
      ),
    );

    fireEvent.change(screen.getByLabelText('Markdown path'), {
      target: { value: 'renamed.md' },
    });
    fireEvent.click(screen.getByRole('button', { name: /rename file/i }));

    expect(await screen.findByRole('button', { name: 'renamed.md' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /delete file/i }));

    expect(await screen.findByText(/no markdown files yet/i)).toBeVisible();
  });

  it('prompts Save, Discard, or Cancel before switching away from dirty editor state', async () => {
    invokeMock.mockImplementation((command, args) => {
      const payload = args as InvokePayload | undefined;

      switch (command) {
        case 'load_remembered_workspace':
          return Promise.resolve(
            workspaceSession([workspaceFile('plan.md'), workspaceFile('other.md')], 'plan.md'),
          );
        case 'openMarkdownMindMap':
          return Promise.resolve(openResult(payload?.request?.relativePath ?? 'plan.md'));
        case 'remember_last_opened_file':
          return Promise.resolve();
        case 'saveMarkdownMindMap':
          return Promise.resolve(savedResult(payload?.request?.relativePath ?? 'plan.md'));
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    await screen.findByRole('heading', { name: 'Plan' });

    fireEvent.click(screen.getByRole('button', { name: /add child node/i }));
    expect(screen.getByText(/unsaved changes in plan.md/i)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'other.md' }));

    const dialog = await screen.findByRole('dialog', { name: /unsaved changes/i });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'other.md' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard' }));

    expect(await screen.findByRole('heading', { name: 'Other' })).toBeVisible();
  });
});

interface InvokePayload {
  workspaceId?: string;
  relativePath?: string;
  newRelativePath?: string;
  request?: {
    workspaceId?: string;
    relativePath?: string;
  };
}

function workspaceSession(
  files: WorkspaceFile[],
  lastOpenedFile: string | null = null,
): WorkspaceSession {
  return {
    workspace: {
      id: 'workspace-1',
      displayName: 'Notes',
      displayPath: 'C:\\Notes',
      platform: 'windows',
      caseSensitive: false,
      writable: true,
      lastOpenedAt: '2026-05-10T00:00:00Z',
    },
    files,
    lastOpenedFile,
  };
}

function openResult(relativePath: string): OpenMarkdownMindMapResult {
  return {
    status: 'opened',
    snapshot: snapshot(relativePath),
    document: markdownDocument(relativePath),
    diagnostics: [],
    files:
      relativePath === 'other.md'
        ? [workspaceFile('plan.md'), workspaceFile('other.md')]
        : [workspaceFile(relativePath), ...(relativePath === 'plan.md' ? [workspaceFile('other.md')] : [])],
    linkIndex: {
      workspaceId: 'workspace-1',
      files: [],
      diagnostics: [],
    },
  };
}

function snapshot(relativePath: string) {
  return {
    workspaceId: 'workspace-1',
    relativePath,
    content: `# ${titleForPath(relativePath)}\n`,
    version: fileVersion(`${relativePath}-token`),
    openedAt: '2026-05-10T00:00:00Z',
  };
}

function workspaceFile(relativePath: string, token = `${relativePath}-token`): WorkspaceFile {
  return {
    relativePath,
    name: relativePath,
    extension: '.md',
    byteSize: 8,
    modifiedAt: '2026-05-10T00:00:00Z',
    version: fileVersion(token),
  };
}

function fileVersion(token: string): FileVersion {
  return {
    modifiedAt: '2026-05-10T00:00:00Z',
    byteSize: 8,
    contentHash: `${token}-hash`,
    token,
  };
}

function savedResult(relativePath: string): SaveMarkdownMindMapResult {
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
    markdown: `# ${titleForPath(relativePath)}\n`,
    save: {
      workspaceId: 'workspace-1',
      relativePath,
      version: fileVersion('saved-token'),
      savedAt: '2026-05-10T00:01:00Z',
      byteSize: 8,
    },
    files: [workspaceFile(relativePath, 'saved-token')],
    linkIndex: {
      workspaceId: 'workspace-1',
      files: [],
      diagnostics: [],
    },
  };
}

function markdownDocument(relativePath: string): MarkdownMindMapDocument {
  const title = titleForPath(relativePath);

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
        children: [],
        origin: {
          sourcePath: relativePath,
          span: {
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1,
          },
          blockKind: 'document_root',
          headingLevel: null,
          listDepth: null,
        },
        links: [],
        listMarker: null,
      },
    },
    unmappedBlocks: [],
    diagnostics: [],
  };
}

function titleForPath(relativePath: string): string {
  const fileName = relativePath.replace(/\.(md|markdown)$/i, '');
  return fileName.charAt(0).toUpperCase() + fileName.slice(1);
}
