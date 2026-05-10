import { ExternalLink, FilePlus2, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

import { parseMarkdownTextSegments } from './linkTokens';
import type {
  LinkCandidate,
  LinkInteractionController,
  LinkReference,
  LinkResolution,
} from './types';
import './MarkdownLinkText.css';

interface MarkdownLinkTextProps {
  text: string;
  linkInteraction?: LinkInteractionController;
}

type LinkActionState =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'resolved'; resolution: LinkResolution }
  | { type: 'message'; title: string; message: string; severity: 'info' | 'warning' | 'error' };

export function MarkdownLinkText({ text, linkInteraction }: MarkdownLinkTextProps) {
  const segments = useMemo(() => parseMarkdownTextSegments(text), [text]);

  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <span key={`text-${index}`}>{segment.text}</span>
        ) : (
          <MarkdownLinkButton
            displayText={segment.displayText}
            external={segment.external}
            key={segment.key}
            linkInteraction={linkInteraction}
            token={segment.token}
          />
        ),
      )}
    </>
  );
}

function MarkdownLinkButton({
  displayText,
  external,
  linkInteraction,
  token,
}: {
  displayText: string;
  external: boolean;
  linkInteraction?: LinkInteractionController;
  token: LinkReference;
}) {
  const [actionState, setActionState] = useState<LinkActionState>({ type: 'idle' });

  useEffect(() => {
    setActionState({ type: 'idle' });
  }, [linkInteraction?.workspaceId, linkInteraction?.sourceRelativePath, token.raw, token.target]);

  const activateLink = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!linkInteraction) {
      setActionState({
        type: 'message',
        title: 'Link unavailable',
        message: 'Open a workspace file before resolving Markdown links.',
        severity: 'warning',
      });
      return;
    }

    setActionState({ type: 'loading' });

    try {
      const resolution = await linkInteraction.resolveLink({
        workspaceId: linkInteraction.workspaceId,
        sourceRelativePath: linkInteraction.sourceRelativePath,
        link: token,
      });

      if (resolution.status === 'resolved' && resolution.open) {
        await linkInteraction.openTarget(resolution.open.relativePath, resolution.open.fragment);
        setActionState({ type: 'idle' });
        return;
      }

      setActionState({ type: 'resolved', resolution });
    } catch (error) {
      setActionState({
        type: 'message',
        title: 'Link could not be resolved',
        message: error instanceof Error ? error.message : 'The resolver returned an unexpected error.',
        severity: 'error',
      });
    }
  };

  const stopNestedPointer = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const linkClassName = [
    'markdown-node-link',
    external ? 'is-external' : '',
    token.kind === 'image' ? 'is-unsupported' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className="markdown-node-link-shell">
      <button
        aria-label={`${displayText} link`}
        className={linkClassName}
        data-link-kind={token.kind}
        onClick={activateLink}
        onPointerDown={stopNestedPointer}
        title={external ? 'External links are resolved as diagnostics only' : 'Open Markdown link'}
        type="button"
      >
        {actionState.type === 'loading' ? <Loader2 aria-hidden="true" size={13} /> : null}
        <span>{displayText}</span>
        {external ? <ExternalLink aria-hidden="true" size={12} /> : null}
      </button>
      <LinkActionPopover
        actionState={actionState}
        displayText={displayText}
        linkInteraction={linkInteraction}
        onClose={() => setActionState({ type: 'idle' })}
        onPointerDown={stopNestedPointer}
      />
    </span>
  );
}

function LinkActionPopover({
  actionState,
  displayText,
  linkInteraction,
  onClose,
  onPointerDown,
}: {
  actionState: LinkActionState;
  displayText: string;
  linkInteraction?: LinkInteractionController;
  onClose(): void;
  onPointerDown(event: PointerEvent<HTMLElement>): void;
}) {
  if (actionState.type === 'idle' || actionState.type === 'loading') {
    return null;
  }

  if (actionState.type === 'message') {
    return (
      <div
        aria-label={`${displayText} link actions`}
        className={`markdown-link-popover is-${actionState.severity}`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={onPointerDown}
        role="dialog"
      >
        <strong>{actionState.title}</strong>
        <p>{actionState.message}</p>
        <button className="markdown-link-secondary-action" onClick={onClose} type="button">
          Dismiss
        </button>
      </div>
    );
  }

  const { resolution } = actionState;

  return (
    <div
      aria-label={`${displayText} link actions`}
      className={`markdown-link-popover is-${resolution.status}`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={onPointerDown}
      role="dialog"
    >
      <strong>{titleForResolution(resolution)}</strong>
      <p>{messageForResolution(resolution)}</p>
      {resolution.status === 'unresolved' && resolution.create && linkInteraction ? (
        <button
          className="markdown-link-primary-action"
          onClick={() => {
            void linkInteraction.createTarget(resolution.create?.relativePath ?? resolution.target);
            onClose();
          }}
          type="button"
        >
          <FilePlus2 aria-hidden="true" size={14} />
          Create {resolution.create.relativePath}
        </button>
      ) : null}
      {resolution.status === 'ambiguous' && linkInteraction ? (
        <div className="markdown-link-candidates">
          {resolution.candidates.map((candidate) => (
            <button
              className="markdown-link-candidate"
              key={candidateKey(candidate)}
              onClick={() => {
                void linkInteraction.openTarget(
                  candidate.relativePath,
                  candidate.heading?.anchor ?? resolution.fragment,
                );
                onClose();
              }}
              type="button"
            >
              <span>{candidate.relativePath}</span>
              {candidate.heading ? <small>{candidate.heading.text}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      {resolution.diagnostics.length > 0 ? (
        <ul className="markdown-link-diagnostics">
          {resolution.diagnostics.map((diagnostic) => (
            <li key={`${diagnostic.code}:${diagnostic.message}`}>{diagnostic.message}</li>
          ))}
        </ul>
      ) : null}
      <button className="markdown-link-secondary-action" onClick={onClose} type="button">
        Dismiss
      </button>
    </div>
  );
}

function titleForResolution(resolution: LinkResolution): string {
  switch (resolution.status) {
    case 'unresolved':
      return 'Missing Markdown file';
    case 'ambiguous':
      return 'Choose a target file';
    case 'rejected':
      return 'Link not opened';
    case 'resolved':
      return 'Markdown link';
  }
}

function messageForResolution(resolution: LinkResolution): string {
  const diagnosticMessage = resolution.diagnostics[0]?.message;

  switch (resolution.status) {
    case 'unresolved':
      return resolution.create
        ? `Create ${resolution.create.relativePath} before opening this link.`
        : diagnosticMessage ?? 'The target Markdown file was not found.';
    case 'ambiguous':
      return 'This link matches multiple Markdown files.';
    case 'rejected':
      return diagnosticMessage ?? 'The link target is unsafe or unsupported.';
    case 'resolved':
      return 'The target resolved successfully.';
  }
}

function candidateKey(candidate: LinkCandidate): string {
  return `${candidate.relativePath}:${candidate.heading?.anchor ?? ''}`;
}
