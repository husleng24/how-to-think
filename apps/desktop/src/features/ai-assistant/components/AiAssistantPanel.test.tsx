import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  createMindMapEditorState,
} from '../../../domain/mindMap';
import type { MindMapEditorState } from '../../../domain/mindMap';
import { createWorkspaceLifecycleFixture } from '../../workspace/testFixtures';
import type { WorkspaceLifecycleState } from '../../workspace';
import {
  getAiProviderSetupState,
} from '../application/providerSetup';
import type { AiProviderSettingsController } from '../application/useAiProviderSettings';
import type { AiConversationClient } from '../infrastructure/conversationApi';
import type {
  AiContextScope,
  AiContextSnapshot,
  AiContextSnapshotRequest,
  AiConversationRequest,
  AiError,
  AiMessage,
  AiProviderConfig,
  AiProviderSettings,
  AiResponse,
  AiRun,
  AiRunEvent,
  AiSession,
} from '../types';
import { AiAssistantPanel } from './AiAssistantPanel';

describe('AiAssistantPanel', () => {
  it('blocks send when no healthy provider is available', async () => {
    const client = createMockClient();

    renderPanel({
      client,
      providerController: providerController({
        activeProviderId: null,
        providers: [],
      }),
    });

    expect(await screen.findByText('Selected node: Plan')).toBeVisible();
    expect(screen.getByText('No local AI provider is configured.')).toBeVisible();

    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: 'Summarize this' },
    });

    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /provider settings/i })).toBeVisible();
  });

  it('updates scope preview and displays truncation warnings', async () => {
    const client = createMockClient({
      previewContext: async (request) =>
        contextSnapshot(request, {
          truncated: request.scope === 'selectedBranch',
          warnings:
            request.scope === 'selectedBranch'
              ? [
                  {
                    code: 'context_truncated',
                    message: 'AI context content was truncated to 1024 bytes.',
                  },
                ]
              : [],
        }),
    });

    renderPanel({ client });

    expect(await screen.findByText('Selected node: Plan')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /selected branch/i }));

    expect(await screen.findByText('Selected branch: Plan')).toBeVisible();
    expect(screen.getByText('Context content was truncated before sending.')).toBeVisible();
    expect(screen.getByText('AI context content was truncated to 1024 bytes.')).toBeVisible();
    expect(client.previewContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'selectedBranch' }),
    );
  });

  it('sends successful messages and keeps follow-ups in the same session', async () => {
    const client = createMockClient();
    const history: AiMessage[] = [];

    client.sendMessage.mockImplementation(async (request: AiConversationRequest) => {
      const response = responseFor(request, {
        runStatus: 'completed',
        assistantContent: `Answer to ${request.prompt}`,
        priorMessages: history,
      });
      history.splice(0, history.length, ...response.session.messages);
      return response;
    });

    renderPanel({ client });

    await screen.findByText('Selected node: Plan');
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: 'What is next?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Answer to What is next?')).toBeVisible();

    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: 'Follow up?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Answer to Follow up?')).toBeVisible();
    expect(screen.getByText('Answer to What is next?')).toBeVisible();
    expect(client.sendMessage.mock.calls[1][0].sessionId).toBe(
      client.sendMessage.mock.calls[0][0].sessionId,
    );
  });

  it('shows recoverable failures and retries the last prompt', async () => {
    const client = createMockClient();
    const timeoutError = aiError('provider_timed_out', 'The AI provider did not finish in time.');

    client.sendMessage
      .mockResolvedValueOnce(
        responseFor(
          {
            workspaceId: 'workspace-1',
            sessionId: 'session',
            providerId: 'provider-1',
            prompt: 'Explain risk',
            context: contextSnapshot(requestForScope('selectedNode')),
          },
          {
            runStatus: 'failed',
            error: timeoutError,
          },
        ),
      )
      .mockImplementationOnce(async (request: AiConversationRequest) =>
        responseFor(request, {
          runStatus: 'completed',
          assistantContent: 'Retry answer',
        }),
      );

    renderPanel({ client });

    await screen.findByText('Selected node: Plan');
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: 'Explain risk' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Timed out')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByText('Retry answer')).toBeVisible();
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    expect(client.sendMessage.mock.calls[1][0].prompt).toBe('Explain risk');
  });

  it('cancels a running backend run after receiving the run id event', async () => {
    const client = createMockClient();
    let resolveSend: ((response: AiResponse) => void) | null = null;

    client.sendMessage.mockImplementation(
      (request: AiConversationRequest) =>
        new Promise<AiResponse>((resolve) => {
          resolveSend = (response) => resolve(response);
          client.pendingRequest = request;
        }),
    );

    renderPanel({ client });

    await screen.findByText('Selected node: Plan');
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: 'Long run' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));

    act(() => {
      client.emit({
        status: 'running',
        run: run('run-1', client.pendingRequest?.sessionId ?? 'session', 'running'),
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(client.cancelRun).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByText('AI run cancelled.')).toBeVisible();

    await act(async () => {
      resolveSend?.(
        responseFor(client.pendingRequest as AiConversationRequest, {
          runStatus: 'cancelled',
        }),
      );
    });
  });

  it('indicates when a response used an older editor snapshot revision', async () => {
    const client = createMockClient();
    const { rerender, workspaceState, provider } = renderPanel({ client });

    await screen.findByText('Selected node: Plan');
    fireEvent.change(screen.getByLabelText(/prompt/i), {
      target: { value: 'Summarize revision' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText('Assistant response')).toBeVisible();

    rerender(
      <AiAssistantPanel
        open
        editorState={editorState({ contentRevision: 2 })}
        workspaceState={workspaceState}
        providerController={provider}
        client={client}
        onClose={vi.fn()}
        onOpenProviderSettings={vi.fn()}
      />,
    );

    expect(screen.getByText(/Answered using Selected node: Plan from editor revision 1/i)).toBeVisible();
  });
});

interface MockClient extends AiConversationClient {
  emit(event: AiRunEvent): void;
  pendingRequest: AiConversationRequest | null;
  previewContext: Mock<(request: AiContextSnapshotRequest) => Promise<AiContextSnapshot>>;
  sendMessage: Mock<(request: AiConversationRequest) => Promise<AiResponse>>;
  cancelRun: Mock<(runId: string) => Promise<AiRun>>;
}

function renderPanel(input: {
  client?: MockClient;
  providerController?: AiProviderSettingsController;
  editor?: MindMapEditorState;
} = {}) {
  const fixture = createWorkspaceLifecycleFixture({
    markdownFiles: {
      'notes/plan.md': '# Plan\n',
    },
  });
  const state = input.editor ?? editorState();
  const opened = fixture.openResult('notes/plan.md');
  const workspaceState: WorkspaceLifecycleState = {
    startupStatus: 'ready',
    workspace: fixture.session().workspace,
    files: fixture.files(),
    active: {
      key: 'workspace-1:notes/plan.md',
      snapshot: fixture.snapshot('notes/plan.md'),
      markdownDocument: opened.document!,
      editorDocument: state.document,
      linkIndex: opened.linkIndex,
      savedContentRevision: state.savedContentRevision,
      contentRevision: state.contentRevision,
      inFlightSave: null,
    },
    recentFiles: ['notes/plan.md'],
    saveStatus: { kind: 'saved', message: 'Saved' },
    prompt: null,
    lastError: null,
    isBusy: false,
  };
  const provider = input.providerController ?? providerController(healthyProviderSettings());
  const client = input.client ?? createMockClient();

  return {
    ...render(
      <AiAssistantPanel
        open
        editorState={state}
        workspaceState={workspaceState}
        providerController={provider}
        client={client}
        onClose={vi.fn()}
        onOpenProviderSettings={vi.fn()}
      />,
    ),
    workspaceState,
    provider,
  };
}

function editorState(input: { contentRevision?: number } = {}): MindMapEditorState {
  const state = createMindMapEditorState({
    sourcePath: 'notes/plan.md',
    title: 'Plan',
    rootText: 'Plan',
  });

  return {
    ...state,
    contentRevision: input.contentRevision ?? state.contentRevision,
  };
}

function createMockClient(input: {
  previewContext?: (request: AiContextSnapshotRequest) => Promise<AiContextSnapshot>;
} = {}): MockClient {
  let handler: ((event: AiRunEvent) => void) | null = null;
  const client: MockClient = {
    pendingRequest: null,
    previewContext: vi.fn((request: AiContextSnapshotRequest) =>
      input.previewContext ? input.previewContext(request) : Promise.resolve(contextSnapshot(request)),
    ),
    sendMessage: vi.fn(async (request) => responseFor(request)),
    cancelRun: vi.fn(async (runId) => run(runId, client.pendingRequest?.sessionId ?? 'session', 'cancelled')),
    listSessions: vi.fn(async () => []),
    onRunEvent: vi.fn(async (nextHandler) => {
      handler = nextHandler;
      return () => {
        handler = null;
      };
    }),
    emit(event) {
      handler?.(event);
    },
  };
  return client;
}

function providerController(settings: AiProviderSettings): AiProviderSettingsController {
  return {
    settings,
    setupState: getAiProviderSetupState(settings),
    loading: false,
    error: null,
    reload: vi.fn(async () => settings),
    saveProvider: vi.fn(),
    selectProvider: vi.fn(),
    removeProvider: vi.fn(),
    checkProviderHealth: vi.fn(),
    clearError: vi.fn(),
  };
}

function healthyProviderSettings(): AiProviderSettings {
  return {
    activeProviderId: 'provider-1',
    providers: [healthyProvider()],
  };
}

function healthyProvider(): AiProviderConfig {
  return {
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
  };
}

function requestForScope(scope: AiContextScope): AiContextSnapshotRequest {
  const state = editorState();
  return {
    workspaceId: 'workspace-1',
    scope,
    document: state.document,
    selectedNodeId: state.selection.selectedNodeId,
    currentFile: 'notes/plan.md',
    openFiles: ['notes/plan.md'],
    contentRevision: state.contentRevision,
  };
}

function contextSnapshot(
  request: AiContextSnapshotRequest,
  input: Partial<Pick<AiContextSnapshot, 'truncated' | 'warnings'>> = {},
): AiContextSnapshot {
  const scope = request.scope ?? 'selectedNode';
  const displayLabel = contextLabel(scope);

  return {
    workspaceId: request.workspaceId,
    scope,
    displayLabel,
    documentId: request.document?.id,
    documentPath: request.currentFile,
    documentRevision: `mindmap:${request.document?.version ?? 1}:content:${request.contentRevision ?? 1}`,
    documentContentHash: 'hash',
    selectedNodeIds: request.selectedNodeId ? [request.selectedNodeId] : [],
    items: [
      {
        id: 'item-1',
        kind: scope === 'workspaceSummary' ? 'workspaceFileTree' : 'mindMapNode',
        label: displayLabel,
        relativePath: request.currentFile,
        nodeIds: request.selectedNodeId ? [request.selectedNodeId] : [],
        content: 'Plan context',
        byteEstimate: 12,
      },
    ],
    byteEstimate: input.truncated ? 1024 : 12,
    tokenEstimate: input.truncated ? 256 : 3,
    truncated: input.truncated ?? false,
    warnings: input.warnings ?? [],
  };
}

function responseFor(
  request: AiConversationRequest,
  input: {
    runStatus?: AiRun['status'];
    assistantContent?: string;
    error?: AiError;
    priorMessages?: AiMessage[];
  } = {},
): AiResponse {
  const runStatus = input.runStatus ?? 'completed';
  const currentRun = run('run-1', request.sessionId ?? 'session', runStatus, input.error);
  const userMessage: AiMessage = {
    id: `message-user-${request.prompt}`,
    sessionId: currentRun.sessionId,
    runId: currentRun.id,
    role: 'user',
    content: request.prompt,
    contextLabel: request.context.displayLabel,
    createdAt: '2026-05-10T00:00:00Z',
  };
  const assistantMessage: AiMessage | undefined =
    runStatus === 'completed'
      ? {
          id: `message-assistant-${request.prompt}`,
          sessionId: currentRun.sessionId,
          runId: currentRun.id,
          role: 'assistant',
          content: input.assistantContent ?? 'Assistant response',
          createdAt: '2026-05-10T00:00:01Z',
        }
      : undefined;
  const errorMessage: AiMessage | undefined = input.error
    ? {
        id: `message-error-${request.prompt}`,
        sessionId: currentRun.sessionId,
        runId: currentRun.id,
        role: 'error',
        content: input.error.message,
        createdAt: '2026-05-10T00:00:01Z',
        errorCode: input.error.code,
      }
    : undefined;
  const messages = [
    ...(input.priorMessages ?? []),
    userMessage,
    ...(assistantMessage ? [assistantMessage] : []),
    ...(errorMessage ? [errorMessage] : []),
  ];

  return {
    run: currentRun,
    session: session(request, messages, currentRun.status),
    assistantMessage,
    error: input.error,
  };
}

function session(
  request: AiConversationRequest,
  messages: AiMessage[],
  lastRunStatus: AiRun['status'],
): AiSession {
  return {
    id: request.sessionId ?? 'session',
    workspaceId: request.workspaceId,
    providerId: request.providerId ?? 'provider-1',
    documentId: request.documentId ?? undefined,
    documentPath: request.documentPath ?? undefined,
    messages,
    createdAt: '2026-05-10T00:00:00Z',
    updatedAt: '2026-05-10T00:00:01Z',
    lastRunStatus,
  };
}

function run(id: string, sessionId: string, status: AiRun['status'], error?: AiError): AiRun {
  return {
    id,
    sessionId,
    providerId: 'provider-1',
    status,
    queuedAt: '2026-05-10T00:00:00Z',
    startedAt: '2026-05-10T00:00:00Z',
    completedAt:
      status === 'completed' || status === 'failed' || status === 'cancelled'
        ? '2026-05-10T00:00:01Z'
        : undefined,
    error,
  };
}

function aiError(code: string, message: string): AiError {
  return {
    code,
    message,
    recoverable: true,
    guidance: 'Try again.',
  };
}

function contextLabel(scope: AiContextScope): string {
  switch (scope) {
    case 'selectedNode':
      return 'Selected node: Plan';
    case 'selectedBranch':
      return 'Selected branch: Plan';
    case 'currentFile':
      return 'Current file: notes/plan.md';
    case 'workspaceSummary':
      return 'Workspace summary: 1 Markdown files';
  }
}
