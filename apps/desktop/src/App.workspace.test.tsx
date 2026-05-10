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
import type { WorkspaceErrorCode, WorkspaceSession } from './features/workspace';
import { createWorkspaceLifecycleFixture } from './features/workspace/testFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

const invokeMock = vi.mocked(invoke);

describe('App workspace lifecycle', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
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

  it('loads the remembered workspace and auto-opens the last Markdown file after restart', async () => {
    const fixture = createWorkspaceLifecycleFixture();
    const restartedContent = '# Restart\n\n## Saved child\n';

    invokeMock.mockImplementation((command, args) => {
      const payload = args as InvokePayload | undefined;

      switch (command) {
        case 'load_remembered_workspace':
          return Promise.resolve(fixture.session({ lastOpenedFile: 'projects/restart.md' }));
        case 'openMarkdownMindMap':
          return Promise.resolve(
            fixture.openResult(payload?.request?.relativePath ?? 'projects/restart.md', {
              content: restartedContent,
            }),
          );
        case 'remember_last_opened_file':
          return Promise.resolve();
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Restart' })).toBeVisible();
    expect(invokeMock).toHaveBeenCalledWith('openMarkdownMindMap', {
      request: {
        workspaceId: fixture.workspaceId,
        relativePath: 'projects/restart.md',
      },
    });
    expect(invokeMock).toHaveBeenCalledWith('remember_last_opened_file', {
      workspaceId: fixture.workspaceId,
      relativePath: 'projects/restart.md',
    });
  });

  it('runs create, open, and save through local Tauri commands without browser network APIs', async () => {
    const fixture = createWorkspaceLifecycleFixture({
      markdownFiles: {
        'notes/offline.md': '# Offline\n',
      },
    });
    const fetchMock = vi.fn();
    const webSocketMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', webSocketMock);

    invokeMock.mockImplementation((command, args) => {
      const payload = args as InvokePayload | undefined;
      const relativePath = payload?.request?.relativePath ?? payload?.relativePath ?? 'notes/offline.md';

      switch (command) {
        case 'load_remembered_workspace':
          return Promise.resolve(null);
        case 'create_workspace_at_path':
          return Promise.resolve(fixture.session({ files: [] }));
        case 'create_markdown_document':
          return Promise.resolve(fixture.snapshot(relativePath, { content: payload?.content }));
        case 'openMarkdownMindMap':
          return Promise.resolve(fixture.openResult(relativePath));
        case 'remember_last_opened_file':
          return Promise.resolve();
        case 'saveMarkdownMindMap':
          return Promise.resolve(fixture.savedResult(relativePath));
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    fireEvent.change(await screen.findByLabelText(/workspace path/i), {
      target: { value: fixture.displayPath },
    });
    fireEvent.click(screen.getByRole('button', { name: /create workspace/i }));

    expect(await screen.findByText(fixture.displayName)).toBeVisible();

    fireEvent.change(screen.getByLabelText(/new markdown path/i), {
      target: { value: 'notes/offline' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create markdown file/i }));

    expect(await screen.findByRole('heading', { name: 'Offline' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /save markdown/i }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('saveMarkdownMindMap', expect.any(Object)));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(webSocketMock).not.toHaveBeenCalled();
  });

  it.each([
    ['external edit conflict', 'version_conflict', /changed on disk/i],
    ['external deletion', 'file_not_found', /no longer exists/i],
  ] satisfies Array<[string, WorkspaceErrorCode, RegExp]>)(
    'keeps dirty content visible when save is blocked by %s',
    async (_label, code, expectedMessage) => {
      const fixture = createWorkspaceLifecycleFixture();

      invokeMock.mockImplementation((command, args) => {
        const payload = args as InvokePayload | undefined;

        switch (command) {
          case 'load_remembered_workspace':
            return Promise.resolve(fixture.session({ lastOpenedFile: 'notes/plan.md' }));
          case 'openMarkdownMindMap':
            return Promise.resolve(fixture.openResult(payload?.request?.relativePath ?? 'notes/plan.md'));
          case 'remember_last_opened_file':
            return Promise.resolve();
          case 'saveMarkdownMindMap':
            return Promise.reject(fixture.error(code, 'notes/plan.md'));
          default:
            return Promise.reject(new Error(`Unexpected command: ${command}`));
        }
      });

      render(<App />);

      expect(await screen.findByRole('heading', { name: 'Plan' })).toBeVisible();

      fireEvent.click(screen.getByRole('button', { name: /add child node/i }));
      expect(screen.getByRole('textbox', { name: /rename new thought/i })).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: /save markdown/i }));

      expect(await screen.findByText(expectedMessage)).toBeVisible();
      expect(screen.getByRole('heading', { name: 'Plan' })).toBeVisible();
      expect(screen.getByRole('textbox', { name: /rename new thought/i })).toBeVisible();
    },
  );

  it('prevents browser close when the active Markdown document has unsaved changes', async () => {
    const fixture = createWorkspaceLifecycleFixture();

    invokeMock.mockImplementation((command, args) => {
      const payload = args as InvokePayload | undefined;

      switch (command) {
        case 'load_remembered_workspace':
          return Promise.resolve(fixture.session({ lastOpenedFile: 'notes/plan.md' }));
        case 'openMarkdownMindMap':
          return Promise.resolve(fixture.openResult(payload?.request?.relativePath ?? 'notes/plan.md'));
        case 'remember_last_opened_file':
          return Promise.resolve();
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /add child node/i }));

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('opens the AI assistant and keeps mind map editing usable with the panel open', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    const fixture = createWorkspaceLifecycleFixture({
      markdownFiles: {
        'notes/plan.md': '# Plan\n',
      },
    });

    invokeMock.mockImplementation((command, args) => {
      const payload = args as InvokePayload | undefined;

      switch (command) {
        case 'load_remembered_workspace':
          return Promise.resolve(fixture.session({ lastOpenedFile: 'notes/plan.md' }));
        case 'openMarkdownMindMap':
          return Promise.resolve(fixture.openResult(payload?.request?.relativePath ?? 'notes/plan.md'));
        case 'remember_last_opened_file':
          return Promise.resolve();
        case 'list_ai_providers':
          return Promise.resolve(healthyAiProviderSettings());
        case 'preview_ai_context_snapshot':
          return Promise.resolve(aiContextSnapshot(payload?.request));
        case 'send_ai_conversation_message':
          return Promise.resolve(aiResponse(payload?.request));
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /open ai assistant/i }));

    expect(await screen.findByRole('complementary', { name: /ai assistant/i })).toBeVisible();
    expect(await screen.findByText('Selected node: Plan')).toBeVisible();

    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: 'Summarize this map' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Assistant shell response')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /add child node/i }));

    expect(screen.getByRole('textbox', { name: /rename new thought/i })).toBeVisible();
  });
});

interface InvokePayload {
  workspaceId?: string;
  relativePath?: string;
  newRelativePath?: string;
  content?: string;
  request?: {
    workspaceId?: string;
    relativePath?: string;
    scope?: 'selectedNode' | 'selectedBranch' | 'currentFile' | 'workspaceSummary';
    document?: {
      id?: string;
      version?: number;
    };
    selectedNodeId?: string;
    contentRevision?: number;
    prompt?: string;
    context?: {
      displayLabel: string;
      workspaceId: string;
    };
    sessionId?: string;
    providerId?: string;
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

function healthyAiProviderSettings() {
  return {
    activeProviderId: 'provider-1',
    providers: [
      {
        id: 'provider-1',
        displayName: 'Local Codex',
        kind: 'codex',
        executablePath: 'codex',
        argumentTemplate: [],
        healthCheckArgs: ['--version'],
        timeoutSeconds: 30,
        maxOutputBytes: 64 * 1024,
        enabled: true,
        lastHealthStatus: {
          status: 'ok',
          checkedAt: '2026-05-10T00:00:00Z',
          message: 'Healthy',
        },
      },
    ],
  };
}

function aiContextSnapshot(request: InvokePayload['request']) {
  return {
    workspaceId: request?.workspaceId ?? 'workspace-1',
    scope: request?.scope ?? 'selectedNode',
    displayLabel: 'Selected node: Plan',
    documentId: request?.document?.id ?? 'notes/plan.md',
    documentPath: request?.relativePath ?? 'notes/plan.md',
    documentRevision: `mindmap:${request?.document?.version ?? 1}:content:${request?.contentRevision ?? 1}`,
    documentContentHash: 'hash',
    selectedNodeIds: request?.selectedNodeId ? [request.selectedNodeId] : ['root'],
    items: [
      {
        id: 'item-1',
        kind: 'mindMapNode',
        label: 'Selected node: Plan',
        relativePath: 'notes/plan.md',
        nodeIds: ['root'],
        content: 'Plan context',
        byteEstimate: 12,
      },
    ],
    byteEstimate: 12,
    tokenEstimate: 3,
    truncated: false,
    warnings: [],
  };
}

function aiResponse(request: InvokePayload['request']) {
  const sessionId = request?.sessionId ?? 'session';
  const run = {
    id: 'run-1',
    sessionId,
    providerId: request?.providerId ?? 'provider-1',
    status: 'completed',
    queuedAt: '2026-05-10T00:00:00Z',
    startedAt: '2026-05-10T00:00:00Z',
    completedAt: '2026-05-10T00:00:01Z',
  };
  const messages = [
    {
      id: 'message-user',
      sessionId,
      runId: run.id,
      role: 'user',
      content: request?.prompt ?? '',
      contextLabel: request?.context?.displayLabel ?? 'Selected node: Plan',
      createdAt: '2026-05-10T00:00:00Z',
    },
    {
      id: 'message-assistant',
      sessionId,
      runId: run.id,
      role: 'assistant',
      content: 'Assistant shell response',
      createdAt: '2026-05-10T00:00:01Z',
    },
  ];

  return {
    run,
    session: {
      id: sessionId,
      workspaceId: request?.workspaceId ?? request?.context?.workspaceId ?? 'workspace-1',
      providerId: request?.providerId ?? 'provider-1',
      documentId: request?.document?.id ?? 'notes/plan.md',
      documentPath: 'notes/plan.md',
      messages,
      createdAt: '2026-05-10T00:00:00Z',
      updatedAt: '2026-05-10T00:00:01Z',
      lastRunStatus: 'completed',
    },
    assistantMessage: messages[1],
  };
}
