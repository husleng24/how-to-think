import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useSyncExternalStore } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createMindMapEditorStore } from '../../domain/mindMap';
import type { MindMapCommand, MindMapEditorStore } from '../../domain/mindMap';
import { MindMapCanvas } from '../mindmap/MindMapCanvas';
import { CompatibilityDiagnosticsPanel } from './CompatibilityDiagnosticsPanel';
import { parseMarkdownTextSegments } from './linkTokens';
import type { LinkInteractionController, LinkResolution } from './types';

const fixedDate = new Date('2026-05-10T00:00:00.000Z');

function StoreBackedCanvas({
  store,
  linkInteraction,
}: {
  store: MindMapEditorStore;
  linkInteraction?: LinkInteractionController;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const dispatch = useCallback(
    (command: MindMapCommand) => {
      return store.dispatch(command);
    },
    [store],
  );

  return (
    <MindMapCanvas
      state={state}
      linkInteraction={linkInteraction}
      onCommand={dispatch}
      onUndo={() => store.undo()}
      onRedo={() => store.redo()}
    />
  );
}

function createLinkStore(text: string): MindMapEditorStore {
  const store = createMindMapEditorStore({
    now: fixedDate,
    rootText: 'Root',
    clock: () => fixedDate,
  });

  store.dispatch({ type: 'add-child', parentId: 'root', text, newNodeId: 'link-node' });
  store.dispatch({ type: 'select-node', nodeId: 'root' });

  return store;
}

function createController(resolution: LinkResolution): LinkInteractionController & {
  resolveLink: ReturnType<typeof vi.fn<LinkInteractionController['resolveLink']>>;
  openTarget: ReturnType<typeof vi.fn<LinkInteractionController['openTarget']>>;
  createTarget: ReturnType<typeof vi.fn<LinkInteractionController['createTarget']>>;
} {
  const resolveLink = vi.fn<LinkInteractionController['resolveLink']>().mockResolvedValue(resolution);
  const openTarget = vi.fn<LinkInteractionController['openTarget']>();
  const createTarget = vi.fn<LinkInteractionController['createTarget']>();

  return {
    workspaceId: 'workspace-1',
    sourceRelativePath: 'current.md',
    resolveLink,
    openTarget,
    createTarget,
  };
}

describe('Markdown compatibility link UI', () => {
  it('parses standard Markdown links, wikilinks, and image links without losing surrounding text', () => {
    const segments = parseMarkdownTextSegments(
      'Read [[Topic|Alias]], [Plan](notes/Plan.md), and ![Diagram](image.png).',
    );

    expect(segments).toEqual([
      { type: 'text', text: 'Read ' },
      expect.objectContaining({
        type: 'link',
        displayText: 'Alias',
        token: expect.objectContaining({ kind: 'obsidian_wiki', target: 'Topic', alias: 'Alias' }),
      }),
      { type: 'text', text: ', ' },
      expect.objectContaining({
        type: 'link',
        displayText: 'Plan',
        token: expect.objectContaining({ kind: 'standard_markdown', target: 'notes/Plan.md' }),
      }),
      { type: 'text', text: ', and ' },
      expect.objectContaining({
        type: 'link',
        displayText: 'Diagram',
        token: expect.objectContaining({ kind: 'image', target: 'image.png' }),
      }),
      { type: 'text', text: '.' },
    ]);
  });

  it('opens a uniquely resolved link without changing node selection', async () => {
    const store = createLinkStore('Read [[Topic]] today');
    const controller = createController(resolution({
      status: 'resolved',
      target: 'Topic',
      openPath: 'Topic.md',
    }));

    render(<StoreBackedCanvas store={store} linkInteraction={controller} />);

    fireEvent.click(screen.getByRole('button', { name: 'Topic link' }));

    await waitFor(() => expect(controller.openTarget).toHaveBeenCalledWith('Topic.md', null));
    expect(controller.resolveLink).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourceRelativePath: 'current.md',
      link: expect.objectContaining({
        kind: 'obsidian_wiki',
        raw: '[[Topic]]',
        target: 'Topic',
      }),
    });
    expect(store.getState().selection.selectedNodeId).toBe('root');
  });

  it('requires confirmation before creating a missing Markdown target', async () => {
    const store = createLinkStore('Read [[Missing Topic]]');
    const controller = createController(resolution({
      status: 'unresolved',
      target: 'Missing Topic',
      createPath: 'Missing Topic.md',
      diagnostic: 'The link target does not exist in the workspace.',
    }));

    render(<StoreBackedCanvas store={store} linkInteraction={controller} />);

    fireEvent.click(screen.getByRole('button', { name: 'Missing Topic link' }));

    expect(await screen.findByRole('dialog', { name: 'Missing Topic link actions' })).toBeVisible();
    expect(controller.createTarget).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Create Missing Topic.md' }));

    expect(controller.createTarget).toHaveBeenCalledWith('Missing Topic.md');
  });

  it('shows ambiguous candidates and opens only the selected file', async () => {
    const store = createLinkStore('Read [[Topic]]');
    const controller = createController({
      ...resolution({ status: 'ambiguous', target: 'Topic' }),
      candidates: [
        { relativePath: 'Topic.md', name: 'Topic.md', stem: 'Topic' },
        { relativePath: 'archive/Topic.md', name: 'Topic.md', stem: 'Topic' },
      ],
      diagnostics: [
        {
          code: 'ambiguous_target',
          severity: 'error',
          message: 'The link target matches multiple Markdown files.',
          candidates: [],
        },
      ],
    });

    render(<StoreBackedCanvas store={store} linkInteraction={controller} />);

    fireEvent.click(screen.getByRole('button', { name: 'Topic link' }));

    expect(await screen.findByText('This link matches multiple Markdown files.')).toBeVisible();
    expect(controller.openTarget).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'archive/Topic.md' }));

    expect(controller.openTarget).toHaveBeenCalledWith('archive/Topic.md', null);
  });

  it('marks rejected external links without opening arbitrary targets', async () => {
    const store = createLinkStore('Read [site](https://example.test)');
    const controller = createController(resolution({
      status: 'rejected',
      target: 'https://example.test',
      diagnostic: 'The link target uses an unsupported protocol.',
    }));

    render(<StoreBackedCanvas store={store} linkInteraction={controller} />);

    fireEvent.click(screen.getByRole('button', { name: 'site link' }));

    const dialog = await screen.findByRole('dialog', { name: 'site link actions' });
    expect(within(dialog).getAllByText('The link target uses an unsupported protocol.')).not.toHaveLength(0);
    expect(controller.openTarget).not.toHaveBeenCalled();
    expect(controller.createTarget).not.toHaveBeenCalled();
  });

  it('keeps raw Markdown text in node edit mode', () => {
    const store = createLinkStore('Read [[Topic]] and [Plan](Plan.md)');

    render(<StoreBackedCanvas store={store} />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Read [[Topic]] and [Plan](Plan.md)' }));

    expect(screen.getByRole('textbox', { name: 'Rename Read [[Topic]] and [Plan](Plan.md)' })).toHaveValue(
      'Read [[Topic]] and [Plan](Plan.md)',
    );
    expect(screen.queryByRole('button', { name: 'Topic link' })).not.toBeInTheDocument();
  });
});

describe('CompatibilityDiagnosticsPanel', () => {
  it('renders parser, save, and link diagnostics in one user-facing surface', () => {
    render(
      <CompatibilityDiagnosticsPanel
        documentDiagnostics={[
          {
            code: 'mixed_hierarchy',
            severity: 'warning',
            message: 'Mixed heading and list hierarchy was interpreted as a mind map.',
            nodeId: 'root',
            origin: {
              sourcePath: 'current.md',
              span: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 12 },
              blockKind: 'list_item',
              headingLevel: null,
              listDepth: 1,
            },
          },
        ]}
        linkIndex={{
          workspaceId: 'workspace-1',
          files: [],
          diagnostics: [
            {
              code: 'duplicate_filename_stem',
              severity: 'warning',
              message: 'Two files share the same Markdown filename stem.',
              candidates: [],
            },
          ],
        }}
        saveStatus={{
          kind: 'saveFailed',
          message: 'Save blocked',
          diagnostics: [
            {
              code: 'lossy_save_blocked',
              severity: 'error',
              message: 'Unmapped Markdown content would be lost.',
              nodeId: null,
              origin: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText('Mixed heading and list hierarchy was interpreted as a mind map.')).toBeVisible();
    expect(screen.getByText('Unmapped Markdown content would be lost.')).toBeVisible();
    expect(screen.getByText('Two files share the same Markdown filename stem.')).toBeVisible();
    expect(screen.getByText('3')).toBeVisible();
  });
});

function resolution({
  status,
  target,
  openPath,
  createPath,
  diagnostic,
}: {
  status: LinkResolution['status'];
  target: string;
  openPath?: string;
  createPath?: string;
  diagnostic?: string;
}): LinkResolution {
  return {
    workspaceId: 'workspace-1',
    sourceRelativePath: 'current.md',
    kind: 'obsidian_wiki',
    raw: `[[${target}]]`,
    target,
    label: null,
    alias: null,
    displayText: target,
    fragment: null,
    status,
    open: openPath
      ? {
          workspaceId: 'workspace-1',
          relativePath: openPath,
          fragment: null,
        }
      : null,
    create: createPath
      ? {
          workspaceId: 'workspace-1',
          relativePath: createPath,
          title: target,
          normalizedFilename: createPath.split('/').pop() ?? createPath,
        }
      : null,
    candidates: [],
    diagnostics: diagnostic
      ? [
          {
            code: status === 'rejected' ? 'unsupported_protocol' : 'missing_target',
            severity: status === 'rejected' ? 'error' : 'warning',
            message: diagnostic,
            candidates: [],
          },
        ]
      : [],
  };
}
