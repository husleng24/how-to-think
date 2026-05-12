import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import type {
  GitOperationError,
  GitRepositoryState,
  GitRepositoryStateToken,
  GitSnapshotRequest,
  GitSnapshotResult,
  GitStatusEntry,
  GitStatusSummary,
} from './features/git-service';
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

  it('enables Git, shows grouped status, and creates a local snapshot', async () => {
    const dirtyStatus = gitStatusSummary([
      gitStatusEntry('notes/added.md', 'added'),
      gitStatusEntry('notes/plan.md', 'modified'),
      gitStatusEntry('notes/new.md', 'untracked'),
      gitStatusEntry('notes/old.md', 'deleted'),
      gitStatusEntry('notes/renamed.md', 'renamed', 'notes/draft.md'),
    ]);
    const cleanStatus = gitStatusSummary([], {
      token: 'clean-token',
      hasChanges: false,
      changedFileCount: 0,
      untrackedFileCount: 0,
    });
    let gitEnabled = false;

    invokeMock.mockImplementation((command, args) => {
      const payload = args as InvokePayload | undefined;

      switch (command) {
        case 'load_remembered_workspace':
          return Promise.resolve(
            workspaceSession([
              workspaceFile('notes/added.md'),
              workspaceFile('notes/plan.md'),
              workspaceFile('notes/new.md'),
              workspaceFile('notes/renamed.md'),
            ]),
          );
        case 'git_refresh':
          return Promise.resolve(gitEnabled ? dirtyStatus : notRepositoryStatus());
        case 'git_init_repository':
          gitEnabled = true;
          return Promise.resolve(dirtyStatus.repositoryState);
        case 'git_create_snapshot': {
          const request = payload?.request as GitSnapshotRequest;
          expect(request.message).toBe('Save local work');
          expect(request.scopePaths).toEqual([
            'notes/added.md',
            'notes/plan.md',
            'notes/new.md',
            'notes/old.md',
            'notes/renamed.md',
          ]);
          expect(request.expectedFileStates.map((state) => state.relativePath)).toEqual([
            'notes/added.md',
            'notes/new.md',
            'notes/plan.md',
            'notes/renamed.md',
          ]);
          return Promise.resolve(snapshotResult(request, cleanStatus));
        }
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    expect(await screen.findByText('Git is off for this workspace')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Enable Git' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm enable Git' }));

    expect(await screen.findByText('Modified')).toBeVisible();
    expect(screen.getByText('Added')).toBeVisible();
    expect(screen.getAllByText('Untracked').length).toBeGreaterThan(0);
    expect(screen.getByText('Deleted')).toBeVisible();
    expect(screen.getByText('Renamed')).toBeVisible();
    expect(screen.getByText('notes/draft.md -> notes/renamed.md')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /create snapshot/i }));
    fireEvent.change(await screen.findByLabelText(/snapshot message/i), {
      target: { value: 'Save local work' },
    });
    fireEvent.click(screen.getByRole('button', { name: /confirm snapshot/i }));

    expect(await screen.findAllByText('Snapshot abc123def456 created')).toHaveLength(2);
    expect(screen.getAllByText('Save local work')).toHaveLength(2);
    expect(screen.getAllByText('Clean').length).toBeGreaterThan(0);
  });

  it('surfaces blocked Git repository states and disables snapshot creation', async () => {
    invokeMock.mockImplementation((command) => {
      switch (command) {
        case 'load_remembered_workspace':
          return Promise.resolve(workspaceSession([workspaceFile('notes/plan.md')]));
        case 'git_refresh':
          return Promise.resolve(
            gitStatusSummary([gitStatusEntry('notes/plan.md', 'modified')], {
              repositoryState: 'merge_conflict',
              blockedReason: 'merge_conflict',
              hasConflicts: true,
            }),
          );
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    expect(await screen.findByText('Merge conflict active')).toBeVisible();
    expect(
      screen.getByText('Resolve the Git conflict before creating snapshots or restoring files.'),
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /create snapshot/i }));
    expect(await screen.findByRole('dialog', { name: /create git snapshot/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /confirm snapshot/i })).toBeDisabled();
  });

  it('shows stale snapshot failures and clears them after Git status refresh', async () => {
    const initialStatus = gitStatusSummary([gitStatusEntry('notes/plan.md', 'modified')]);
    const refreshedStatus = gitStatusSummary([gitStatusEntry('notes/plan.md', 'modified')], {
      token: 'refreshed-token',
    });
    let refreshCount = 0;

    invokeMock.mockImplementation((command) => {
      switch (command) {
        case 'load_remembered_workspace':
          return Promise.resolve(workspaceSession([workspaceFile('notes/plan.md')]));
        case 'git_refresh':
          refreshCount += 1;
          return Promise.resolve(refreshCount > 1 ? refreshedStatus : initialStatus);
        case 'git_create_snapshot':
          return Promise.reject(gitError('external_state_changed', 'Repository changed.'));
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    expect(await screen.findByText('Workspace changes')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /create snapshot/i }));
    const staleDialog = await screen.findByRole('dialog', { name: /create git snapshot/i });
    fireEvent.change(within(staleDialog).getByLabelText(/snapshot message/i), {
      target: { value: 'Save plan' },
    });
    fireEvent.click(within(staleDialog).getByRole('button', { name: /confirm snapshot/i }));

    expect(await screen.findByText('Git state changed')).toBeVisible();
    expect(screen.getAllByText('Repository changed.')).toHaveLength(2);

    fireEvent.click(within(staleDialog).getByRole('button', { name: 'Refresh Git status' }));

    await waitFor(() => expect(screen.queryByText('Repository changed.')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /confirm snapshot/i })).toBeEnabled();
  });

  it('does not represent unsaved editor content as snapshot-ready changes', async () => {
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
        case 'git_refresh':
          return Promise.resolve(gitStatusSummary([gitStatusEntry('notes/plan.md', 'modified')]));
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /add child node/i }));

    expect(await screen.findByText('Unsaved editor changes')).toBeVisible();
    expect(screen.getByText(/save markdown before snapshotting/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /create snapshot/i }));
    expect(await screen.findByRole('dialog', { name: /create git snapshot/i })).toBeVisible();
    expect(screen.getByText(/unsaved editor content is not included/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /confirm snapshot/i })).toBeDisabled();
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

  it('keeps AI chat and suggestion drafts review-only without saving Markdown', async () => {
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

    expect(await screen.findByText('Selected node: Plan')).toBeVisible();
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: 'Summarize this map' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Assistant shell response')).toBeVisible();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'saveMarkdownMindMap')).toHaveLength(0);
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: 'Rewrite the selected branch with clearer steps.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === 'send_ai_conversation_message'),
      ).toHaveLength(2),
    );
    expect(await screen.findByText('Preview-only suggestion')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /create preview/i }));
    expect(await screen.findByText('Suggestion preview')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /review preview/i }));

    expect(await screen.findByText('Suggestion preview saved')).toBeVisible();
    expect(screen.getByRole('button', { name: /accept whole proposal/i })).toBeDisabled();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'saveMarkdownMindMap')).toHaveLength(0);
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();
  });
});

function gitStatusEntry(
  relativePath: string,
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked',
  previousRelativePath?: string,
): GitStatusEntry {
  if (kind === 'modified') {
    return {
      relativePath,
      staged: 'unmodified',
      unstaged: 'modified',
      conflicted: false,
    };
  }

  if (kind === 'untracked') {
    return {
      relativePath,
      staged: 'untracked',
      unstaged: 'untracked',
      conflicted: false,
    };
  }

  return {
    relativePath,
    previousRelativePath,
    staged: kind,
    unstaged: 'unmodified',
    conflicted: false,
  };
}

function gitStatusSummary(
  entries: GitStatusEntry[],
  input: {
    token?: string;
    repositoryState?: GitRepositoryState['state'];
    blockedReason?: GitRepositoryState['blockedReason'];
    hasChanges?: boolean;
    hasConflicts?: boolean;
    changedFileCount?: number;
    untrackedFileCount?: number;
  } = {},
): GitStatusSummary {
  const token = gitRepositoryToken(input.token ?? 'repo-token');
  const counts = {
    added: entries.filter((entry) => entry.staged === 'added' || entry.unstaged === 'added').length,
    modified: entries.filter((entry) => entry.staged === 'modified' || entry.unstaged === 'modified').length,
    deleted: entries.filter((entry) => entry.staged === 'deleted' || entry.unstaged === 'deleted').length,
    renamed: entries.filter((entry) => entry.staged === 'renamed' || entry.unstaged === 'renamed').length,
    untracked: entries.filter((entry) => entry.staged === 'untracked' || entry.unstaged === 'untracked').length,
    ignored: 0,
  };
  const repositoryState = gitRepositoryState(input.repositoryState ?? 'valid_repository', {
    token,
    blockedReason: input.blockedReason,
  });

  return {
    workspaceId: 'workspace-1',
    repositoryState,
    token,
    entries,
    counts,
    hasChanges: input.hasChanges ?? entries.length > 0,
    hasConflicts: input.hasConflicts ?? false,
    changedFileCount: input.changedFileCount ?? entries.length,
    untrackedFileCount: input.untrackedFileCount ?? counts.untracked,
    refreshedAt: '2026-05-10T00:02:00Z',
  };
}

function notRepositoryStatus(): GitStatusSummary {
  return {
    workspaceId: 'workspace-1',
    repositoryState: gitRepositoryState('not_repository', { token: null }),
    token: null,
    entries: [],
    counts: {
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      untracked: 0,
      ignored: 0,
    },
    hasChanges: false,
    hasConflicts: false,
    changedFileCount: 0,
    untrackedFileCount: 0,
    refreshedAt: '2026-05-10T00:02:00Z',
  };
}

function gitRepositoryState(
  state: GitRepositoryState['state'],
  input: {
    token: GitRepositoryStateToken | null;
    blockedReason?: GitRepositoryState['blockedReason'];
  },
): GitRepositoryState {
  return {
    workspaceId: 'workspace-1',
    state,
    backend: {
      kind: 'system_git',
      version: 'git version 2.52.0',
    },
    selectedRootDisplayPath: 'C:\\Notes',
    repositoryRootDisplayPath: state === 'not_repository' ? null : 'C:\\Notes',
    branchName: state === 'detached_head' ? null : 'main',
    headOid: input.token?.headOid ?? null,
    token: input.token,
    blockedReason: input.blockedReason ?? null,
    warnings: [],
    checkedAt: '2026-05-10T00:02:00Z',
  };
}

function gitRepositoryToken(token: string): GitRepositoryStateToken {
  return {
    token,
    headOid: 'abc123def4567890',
    indexVersion: 3,
    indexChecksum: 'index-checksum',
    worktreeStatusGeneration: token,
    capturedAt: '2026-05-10T00:02:00Z',
  };
}

function snapshotResult(
  request: GitSnapshotRequest,
  status: GitStatusSummary,
): GitSnapshotResult {
  return {
    workspaceId: request.workspaceId,
    commitOid: 'abc123def4567890abc123def4567890abc123de',
    shortCommitOid: 'abc123def456',
    parentOids: [],
    message: request.message,
    affectedPaths: request.scopePaths,
    affectedFileCount: request.scopePaths.length,
    repositoryState: status.repositoryState,
    status,
    snapshotAt: '2026-05-10T00:03:00Z',
  };
}

function gitError(code: GitOperationError['code'], message: string): GitOperationError {
  return {
    code,
    operation: 'snapshot',
    message,
    recoverable: true,
  };
}

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
