import { CircleStop, RefreshCw, Send, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MutableRefObject } from 'react';

import type { MindMapEditorState } from '../../../domain/mindMap';
import type {
  WorkspaceLifecycleState,
} from '../../workspace';
import {
  createAiContextSnapshotRequest,
  selectDefaultAiContextScope,
} from '../application/contextSelectors';
import { getProviderRunAvailability } from '../application/providerAvailability';
import type { AiProviderSettingsController } from '../application/useAiProviderSettings';
import {
  tauriAiConversationClient,
} from '../infrastructure/conversationApi';
import type { AiConversationClient } from '../infrastructure/conversationApi';
import type {
  AiContextScope,
  AiContextSnapshot,
  AiError,
  AiMessage,
  AiRun,
  WorkspaceRelativePath,
} from '../types';
import { ContextScopePicker } from './ContextScopePicker';
import { ConversationThread } from './ConversationThread';
import { ProviderSelector } from './ProviderSelector';
import './AiAssistantPanel.css';

interface AiAssistantPanelProps {
  open: boolean;
  editorState: MindMapEditorState;
  workspaceState?: WorkspaceLifecycleState;
  providerController: AiProviderSettingsController;
  client?: AiConversationClient;
  onClose(): void;
  onOpenProviderSettings?: () => void;
}

type PreviewState =
  | { status: 'idle'; snapshot: null; error: null }
  | { status: 'loading'; snapshot: AiContextSnapshot | null; error: null }
  | { status: 'ready'; snapshot: AiContextSnapshot; error: null }
  | { status: 'error'; snapshot: null; error: string };

interface RunContextMarker {
  contextLabel: string;
  contentRevision: number;
  documentRevision?: string;
}

const emptyPreviewState: PreviewState = {
  status: 'idle',
  snapshot: null,
  error: null,
};

export function AiAssistantPanel({
  open,
  editorState,
  workspaceState,
  providerController,
  client = tauriAiConversationClient,
  onClose,
  onOpenProviderSettings,
}: AiAssistantPanelProps) {
  const workspaceId = workspaceState?.workspace?.id ?? null;
  const activeDocument = workspaceState?.active ?? null;
  const activeDocumentKey = activeDocument?.key ?? null;
  const currentFile = activeDocument?.snapshot.relativePath ?? editorState.document.sourcePath;
  const [selectedScope, setSelectedScope] = useState<AiContextScope>(() =>
    workspaceId
      ? selectDefaultAiContextScope(editorState, { currentFile })
      : 'workspaceSummary',
  );
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    providerController.settings.activeProviderId ?? null,
  );
  const [previewState, setPreviewState] = useState<PreviewState>(emptyPreviewState);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [activeRun, setActiveRun] = useState<AiRun | null>(null);
  const [lastError, setLastError] = useState<AiError | null>(null);
  const [sending, setSending] = useState(false);
  const [lastRunContext, setLastRunContext] = useState<RunContextMarker | null>(null);
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const lastPromptRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const openFiles = useMemo(
    () => uniquePaths([currentFile, ...(workspaceState?.recentFiles ?? [])]),
    [currentFile, workspaceState?.recentFiles],
  );
  const hasSelectedNode = Boolean(editorState.document.nodes[editorState.selection.selectedNodeId]);
  const availableScopes = useMemo<Record<AiContextScope, boolean>>(
    () => ({
      selectedNode: Boolean(workspaceId && hasSelectedNode),
      selectedBranch: Boolean(workspaceId && hasSelectedNode),
      currentFile: Boolean(workspaceId && currentFile),
      workspaceSummary: Boolean(workspaceId),
    }),
    [currentFile, hasSelectedNode, workspaceId],
  );
  const defaultScope = useMemo<AiContextScope>(
    () =>
      workspaceId
        ? selectDefaultAiContextScope(editorState, { currentFile })
        : 'workspaceSummary',
    [currentFile, editorState, workspaceId],
  );
  const providerAvailability = useMemo(
    () => getProviderRunAvailability(providerController.settings, selectedProviderId),
    [providerController.settings, selectedProviderId],
  );
  const isRunInFlight = isInFlight(activeRun) || sending;
  const canCancel = Boolean(activeRun && isInFlight(activeRun) && !activeRun.id.startsWith('pending-'));
  const promptText = prompt.trim();
  const sendDisabledReason = getSendDisabledReason({
    activeDocumentAvailable: Boolean(activeDocument),
    contextReady: previewState.status === 'ready',
    hasPrompt: promptText.length > 0,
    providerReady: providerAvailability.usable,
    running: isRunInFlight,
    workspaceAvailable: Boolean(workspaceId),
  });
  const revisionNotice = useMemo(() => {
    if (!lastRunContext || editorState.contentRevision === lastRunContext.contentRevision) {
      return null;
    }

    const backendRevision = lastRunContext.documentRevision
      ? ` (${lastRunContext.documentRevision})`
      : '';
    return `Answered using ${lastRunContext.contextLabel} from editor revision ${lastRunContext.contentRevision}${backendRevision}; current editor is revision ${editorState.contentRevision}.`;
  }, [editorState.contentRevision, lastRunContext]);

  useEffect(() => {
    if (!selectedProviderId) {
      setSelectedProviderId(
        providerController.settings.activeProviderId ??
          providerController.settings.providers[0]?.id ??
          null,
      );
      return;
    }

    if (!providerController.settings.providers.some((provider) => provider.id === selectedProviderId)) {
      setSelectedProviderId(
        providerController.settings.activeProviderId ??
          providerController.settings.providers[0]?.id ??
          null,
      );
    }
  }, [providerController.settings, selectedProviderId]);

  useEffect(() => {
    if (!availableScopes[selectedScope]) {
      setSelectedScope(defaultScope);
    }
  }, [availableScopes, defaultScope, selectedScope]);

  useEffect(() => {
    setSelectedScope(defaultScope);
  }, [activeDocumentKey, defaultScope]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void client.onRunEvent((event) => {
      if (event.run.sessionId !== sessionIdRef.current) {
        return;
      }

      setActiveRun(event.run);
      setLastError(event.error ?? event.run.error ?? null);
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }

      unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [client]);

  useEffect(() => {
    if (!open || !workspaceId) {
      setPreviewState(emptyPreviewState);
      return undefined;
    }

    const request = createAiContextSnapshotRequest(editorState, {
      workspaceId,
      preferredScope: selectedScope,
      currentFile,
      openFiles,
    });
    let active = true;
    setPreviewState((current) => ({
      status: 'loading',
      snapshot: current.snapshot,
      error: null,
    }));

    client
      .previewContext(request)
      .then((snapshot) => {
        if (active) {
          setPreviewState({ status: 'ready', snapshot, error: null });
        }
      })
      .catch((error) => {
        if (active) {
          setPreviewState({ status: 'error', snapshot: null, error: toErrorMessage(error) });
        }
      });

    return () => {
      active = false;
    };
  }, [
    client,
    currentFile,
    editorState,
    open,
    openFiles,
    previewRefreshKey,
    selectedScope,
    workspaceId,
  ]);

  const sendPrompt = useCallback(
    async (nextPrompt: string) => {
      const trimmedPrompt = nextPrompt.trim();
      if (!workspaceId || !activeDocument || !providerAvailability.usable || !trimmedPrompt || isRunInFlight) {
        return;
      }

      const contextRequest = createAiContextSnapshotRequest(editorState, {
        workspaceId,
        preferredScope: selectedScope,
        currentFile,
        openFiles,
      });
      const sessionId = ensureSessionId(sessionIdRef);
      const providerId = providerAvailability.provider?.id ?? selectedProviderId ?? undefined;
      setSending(true);
      setLastError(null);

      try {
        const context = await client.previewContext(contextRequest);
        const contextLabel = context.displayLabel;
        const pendingRun = createPendingRun(sessionId, providerId ?? 'provider');
        const userMessage = createLocalUserMessage(sessionId, pendingRun.id, trimmedPrompt, contextLabel);
        lastPromptRef.current = trimmedPrompt;
        setPreviewState({ status: 'ready', snapshot: context, error: null });
        setLastRunContext({
          contextLabel,
          contentRevision: editorState.contentRevision,
          documentRevision: context.documentRevision,
        });
        setActiveRun(pendingRun);
        setMessages((currentMessages) => [...currentMessages, userMessage]);
        setPrompt('');

        const response = await client.sendMessage({
          workspaceId,
          sessionId,
          providerId,
          documentId: context.documentId ?? editorState.document.id,
          documentPath: context.documentPath ?? currentFile ?? undefined,
          prompt: trimmedPrompt,
          context,
        });
        sessionIdRef.current = response.session.id;
        setMessages(response.session.messages);
        setActiveRun(response.run);
        setLastError(response.error ?? response.run.error ?? null);
      } catch (error) {
        setLastError(toAiError(error));
        setActiveRun((currentRun) =>
          currentRun
            ? {
                ...currentRun,
                status: 'failed',
                error: toAiError(error),
              }
            : null,
        );
      } finally {
        setSending(false);
      }
    },
    [
      activeDocument,
      client,
      currentFile,
      editorState,
      isRunInFlight,
      openFiles,
      providerAvailability,
      selectedProviderId,
      selectedScope,
      workspaceId,
    ],
  );

  const cancelRun = useCallback(async () => {
    if (!activeRun || !canCancel) {
      return;
    }

    try {
      const cancelledRun = await client.cancelRun(activeRun.id);
      setActiveRun(cancelledRun);
      setLastError(cancelledRun.error ?? null);
    } catch (error) {
      setLastError(toAiError(error));
    }
  }, [activeRun, canCancel, client]);

  const retryLastPrompt = useCallback(() => {
    if (!lastPromptRef.current) {
      return;
    }

    void sendPrompt(lastPromptRef.current);
  }, [sendPrompt]);

  if (!open) {
    return null;
  }

  return (
    <aside className="ai-assistant-drawer" aria-label="AI assistant">
      <div className="ai-assistant-header">
        <div>
          <p className="panel-kicker">AI assistant</p>
          <h2>Conversation</h2>
        </div>
        <button className="icon-button compact" type="button" aria-label="Close AI assistant" onClick={onClose}>
          <X size={17} />
        </button>
      </div>

      <ProviderSelector
        settings={providerController.settings}
        selectedProviderId={selectedProviderId}
        onSelectProvider={setSelectedProviderId}
        onOpenSettings={onOpenProviderSettings}
      />

      <ContextScopePicker
        value={selectedScope}
        availableScopes={availableScopes}
        onChange={setSelectedScope}
      />

      <ContextPreview previewState={previewState} />

      <ConversationThread
        messages={messages}
        activeRun={activeRun}
        lastError={lastError}
        revisionNotice={revisionNotice}
        onRetry={lastPromptRef.current ? retryLastPrompt : undefined}
      />

      <form
        className="ai-assistant-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void sendPrompt(promptText);
        }}
      >
        <label className="ai-assistant-field">
          <span>Prompt</span>
          <textarea
            value={prompt}
            rows={4}
            placeholder="Ask about the selected context"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <div className="ai-assistant-actions">
          <button
            className="text-button"
            type="submit"
            disabled={Boolean(sendDisabledReason)}
            title={sendDisabledReason ?? 'Send prompt'}
          >
            <Send size={15} />
            Send
          </button>
          <button
            className="text-button"
            type="button"
            disabled={!canCancel}
            onClick={() => void cancelRun()}
          >
            <CircleStop size={15} />
            Cancel
          </button>
          <button
            className="icon-button compact"
            type="button"
            aria-label="Refresh AI context"
            disabled={previewState.status === 'loading' || !workspaceId}
            onClick={() => {
              setPreviewRefreshKey((key) => key + 1);
            }}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </form>
    </aside>
  );
}

interface SendDisabledInput {
  activeDocumentAvailable: boolean;
  contextReady: boolean;
  hasPrompt: boolean;
  providerReady: boolean;
  running: boolean;
  workspaceAvailable: boolean;
}

function ContextPreview({ previewState }: { previewState: PreviewState }) {
  if (previewState.status === 'idle') {
    return (
      <section className="ai-context-preview" aria-label="AI context preview">
        <p>No workspace context available.</p>
      </section>
    );
  }

  if (previewState.status === 'error') {
    return (
      <section className="ai-context-preview error" aria-label="AI context preview" role="alert">
        <strong>Context unavailable</strong>
        <p>{previewState.error}</p>
      </section>
    );
  }

  const snapshot = previewState.snapshot;

  return (
    <section className="ai-context-preview" aria-label="AI context preview">
      {snapshot ? (
        <>
          <div className="ai-context-preview-heading">
            <strong>{snapshot.displayLabel}</strong>
            <span>
              {snapshot.byteEstimate} bytes / {snapshot.tokenEstimate} tokens
            </span>
          </div>
          {snapshot.scope === 'workspaceSummary' ? (
            <p className="ai-context-warning">
              Workspace context uses a bounded Markdown summary and excludes ignored paths.
            </p>
          ) : null}
          {snapshot.truncated ? (
            <p className="ai-context-warning">Context content was truncated before sending.</p>
          ) : null}
          {snapshot.warnings && snapshot.warnings.length > 0 ? (
            <ul className="ai-context-warning-list">
              {snapshot.warnings.map((warning, index) => (
                <li key={`${warning.code}-${warning.itemId ?? warning.relativePath ?? index}`}>
                  {warning.message}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p>Loading context.</p>
      )}
      {previewState.status === 'loading' ? <p className="ai-context-loading">Refreshing context.</p> : null}
    </section>
  );
}

function getSendDisabledReason(input: SendDisabledInput): string | null {
  if (!input.workspaceAvailable) {
    return 'Open a workspace before starting an AI conversation.';
  }

  if (!input.activeDocumentAvailable) {
    return 'Open a Markdown mind map before starting an AI conversation.';
  }

  if (!input.providerReady) {
    return 'Select a healthy AI provider before sending.';
  }

  if (!input.contextReady) {
    return 'Wait for the context snapshot to finish loading.';
  }

  if (!input.hasPrompt) {
    return 'Type a question before sending.';
  }

  if (input.running) {
    return 'Wait for the current AI run to finish.';
  }

  return null;
}

function isInFlight(run: AiRun | null): boolean {
  return run?.status === 'queued' || run?.status === 'running' || run?.status === 'streaming';
}

function ensureSessionId(sessionIdRef: MutableRefObject<string | null>): string {
  if (!sessionIdRef.current) {
    sessionIdRef.current = `assistant-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  return sessionIdRef.current;
}

function createPendingRun(sessionId: string, providerId: string): AiRun {
  return {
    id: `pending-${Date.now().toString(36)}`,
    sessionId,
    providerId,
    status: 'queued',
    queuedAt: new Date().toISOString(),
  };
}

function createLocalUserMessage(
  sessionId: string,
  runId: string,
  content: string,
  contextLabel: string,
): AiMessage {
  return {
    id: `local-message-${Date.now().toString(36)}`,
    sessionId,
    runId,
    role: 'user',
    content,
    contextLabel,
    createdAt: new Date().toISOString(),
  };
}

function uniquePaths(paths: Array<WorkspaceRelativePath | null | undefined>): WorkspaceRelativePath[] {
  const seen = new Set<string>();
  const result: WorkspaceRelativePath[] = [];

  for (const path of paths) {
    const trimmed = path?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return 'AI conversation failed unexpectedly.';
}

function toAiError(error: unknown): AiError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as Partial<AiError> & { message: string };
    return {
      code: candidate.code ?? 'runtime_unavailable',
      message: candidate.message,
      recoverable: candidate.recoverable ?? true,
      guidance: candidate.guidance ?? 'Retry the request or check provider settings.',
      providerId: candidate.providerId,
      runId: candidate.runId,
      exitCode: candidate.exitCode,
      detail: candidate.detail,
    };
  }

  return {
    code: 'runtime_unavailable',
    message: toErrorMessage(error),
    recoverable: true,
    guidance: 'Retry the request or check provider settings.',
  };
}
