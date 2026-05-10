import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useSyncExternalStore } from 'react';

import {
  createMindMapEditorStore,
} from './domain/mindMap';
import {
  getMindMapCommandAvailability,
  resolveMindMapDropIntent,
  resolveMindMapShortcut,
} from './interaction';
import { getMindMapLayoutNode, layoutMindMapDocument } from './layout';
import { MindMapCanvas } from './MindMapCanvas';
import type { MindMapCommand, MindMapCommandResult, MindMapEditorStore } from './domain/mindMap';
import type { MindMapLayoutNode, MindMapLayoutResult } from './layout';

const fixedDate = new Date('2026-01-02T03:04:05.000Z');
const contentPadding = 160;

function expectOk(result: MindMapCommandResult): Extract<MindMapCommandResult, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  return result as Extract<MindMapCommandResult, { ok: true }>;
}

function createSeedStore(): MindMapEditorStore {
  const store = createMindMapEditorStore({
    now: fixedDate,
    rootText: 'Root topic',
    clock: () => fixedDate,
  });

  expectOk(store.dispatch({ type: 'add-child', parentId: 'root', text: 'Alpha', newNodeId: 'a' }));
  expectOk(store.dispatch({ type: 'add-child', parentId: 'root', text: 'Beta', newNodeId: 'b' }));
  expectOk(store.dispatch({ type: 'add-child', parentId: 'a', text: 'Alpha detail', newNodeId: 'a-1' }));
  expectOk(store.dispatch({ type: 'select-node', nodeId: 'root' }));

  return store;
}

function StoreBackedCanvas({ store }: { store: MindMapEditorStore }) {
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
      onCommand={dispatch}
      onUndo={() => store.undo()}
      onRedo={() => store.redo()}
    />
  );
}

function getSurface(container: HTMLElement): HTMLElement {
  const surface = container.querySelector('.mindmap-pan-surface');

  expect(surface).toBeInstanceOf(HTMLElement);
  if (!surface) {
    throw new Error('Mind map pan surface missing');
  }

  return surface as HTMLElement;
}

function getRequiredLayoutNode(
  layout: MindMapLayoutResult,
  nodeId: string,
): MindMapLayoutNode {
  const node = getMindMapLayoutNode(layout, nodeId);

  expect(node).toBeDefined();
  if (!node) {
    throw new Error(`Layout node missing: ${nodeId}`);
  }

  return node;
}

function nodeClientPoint(
  layout: MindMapLayoutResult,
  nodeId: string,
  yRatio = 0.5,
): { clientX: number; clientY: number } {
  const node = getRequiredLayoutNode(layout, nodeId);

  return {
    clientX: contentPadding + node.x + node.width / 2,
    clientY: contentPadding + node.y + node.height * yRatio,
  };
}

function dispatchPointerEvent(
  target: Element,
  type: 'down' | 'move' | 'up',
  point: { clientX: number; clientY: number },
  pointerId: number,
): void {
  const event =
    type === 'down'
      ? createEvent.pointerDown(target, { bubbles: true, cancelable: true })
      : type === 'move'
        ? createEvent.pointerMove(target, { bubbles: true, cancelable: true })
        : createEvent.pointerUp(target, { bubbles: true, cancelable: true });

  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: point.clientX },
    clientY: { value: point.clientY },
    pointerId: { value: pointerId },
  });

  fireEvent(target, event);
}

describe('MindMapCanvas', () => {
  it('maps shortcuts to editor commands and exposes disabled command states', () => {
    const store = createSeedStore();
    const state = store.getState();
    const layout = layoutMindMapDocument(state.document);

    expect(getMindMapCommandAvailability(state)).toMatchObject({
      canAddChild: true,
      canAddSibling: false,
      canRename: true,
      canDelete: false,
      canToggleCollapse: true,
      canUndo: true,
      canRedo: false,
    });
    expect(resolveMindMapShortcut({ key: 'Enter' }, state, layout)).toEqual({ type: 'none' });
    expect(resolveMindMapShortcut({ key: 'Tab' }, state, layout)).toEqual({
      type: 'command',
      command: { type: 'add-child', parentId: 'root' },
    });
    expect(resolveMindMapShortcut({ key: 'Delete' }, state, layout)).toEqual({ type: 'none' });
    expect(resolveMindMapShortcut({ key: 'z', ctrlKey: true }, state, layout)).toEqual({
      type: 'undo',
    });

    expectOk(store.dispatch({ type: 'select-node', nodeId: 'a' }));
    const childState = store.getState();
    const childLayout = layoutMindMapDocument(childState.document);

    expect(getMindMapCommandAvailability(childState)).toMatchObject({
      canAddSibling: true,
      canDelete: true,
      canCollapse: true,
      canExpand: false,
    });
    expect(resolveMindMapShortcut({ key: 'Enter' }, childState, childLayout)).toEqual({
      type: 'command',
      command: { type: 'add-sibling', nodeId: 'a' },
    });
    expect(resolveMindMapShortcut({ key: 'F2' }, childState, childLayout)).toEqual({
      type: 'begin-edit',
      nodeId: 'a',
    });
    expect(resolveMindMapShortcut({ key: 'Tab', shiftKey: true }, childState, childLayout)).toEqual({
      type: 'command',
      command: { type: 'select-node', nodeId: 'root' },
    });
    expect(resolveMindMapShortcut({ key: 'Delete' }, childState, childLayout)).toEqual({
      type: 'command',
      command: { type: 'delete-subtree', nodeId: 'a' },
    });
  });

  it('resolves drag targets from layout geometry and rejects invalid branch targets', () => {
    const store = createSeedStore();
    const state = store.getState();
    const layout = layoutMindMapDocument(state.document);
    const alpha = getRequiredLayoutNode(layout, 'a');
    const beta = getRequiredLayoutNode(layout, 'b');
    const alphaDetail = getRequiredLayoutNode(layout, 'a-1');

    expect(
      resolveMindMapDropIntent(state, layout, {
        draggedNodeId: 'a',
        point: { x: beta.x + beta.width / 2, y: beta.y + beta.height / 2 },
      }),
    ).toMatchObject({
      type: 'move-as-child',
      draggedNodeId: 'a',
      targetNodeId: 'b',
      newParentId: 'b',
      index: 0,
    });

    expect(
      resolveMindMapDropIntent(state, layout, {
        draggedNodeId: 'b',
        point: { x: alpha.x + alpha.width / 2, y: alpha.y - 8 },
      }),
    ).toMatchObject({
      type: 'reorder-before',
      draggedNodeId: 'b',
      targetNodeId: 'a',
      newParentId: 'root',
      index: 0,
    });

    expect(
      resolveMindMapDropIntent(state, layout, {
        draggedNodeId: 'a',
        point: {
          x: alphaDetail.x + alphaDetail.width / 2,
          y: alphaDetail.y + alphaDetail.height / 2,
        },
      }),
    ).toMatchObject({
      type: 'invalid',
      reason: 'descendant',
      targetNodeId: 'a-1',
    });

    expect(
      resolveMindMapDropIntent(state, layout, {
        draggedNodeId: 'root',
        point: { x: beta.x + beta.width / 2, y: beta.y + beta.height / 2 },
      }),
    ).toMatchObject({
      type: 'invalid',
      reason: 'root',
    });
  });

  it('renders generated nodes and edges from store state', () => {
    const store = createSeedStore();

    render(<StoreBackedCanvas store={store} />);

    expect(screen.getByRole('button', { name: 'Root topic' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Alpha detail' })).toBeVisible();
    expect(screen.getAllByTestId('mindmap-edge')).toHaveLength(3);
  });

  it('updates selection and collapse state without deleting descendants', () => {
    const store = createSeedStore();

    render(<StoreBackedCanvas store={store} />);

    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(store.getState().selection.selectedNodeId).toBe('b');
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Alpha' }));
    expect(screen.queryByRole('button', { name: 'Alpha detail' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('mindmap-edge')).toHaveLength(2);
    expect(store.getState().document.nodes['a-1']).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Alpha' }));
    expect(screen.getByRole('button', { name: 'Alpha detail' })).toBeVisible();
    expect(screen.getAllByTestId('mindmap-edge')).toHaveLength(3);
  });

  it('drags a branch onto a new parent and preserves descendants', () => {
    const store = createSeedStore();
    const { container } = render(<StoreBackedCanvas store={store} />);
    const surface = getSurface(container);
    const layout = layoutMindMapDocument(store.getState().document);
    const alphaStart = nodeClientPoint(layout, 'a');
    const betaCenter = nodeClientPoint(layout, 'b');

    dispatchPointerEvent(screen.getByRole('button', { name: 'Alpha' }), 'down', alphaStart, 1);
    dispatchPointerEvent(surface, 'move', betaCenter, 1);

    expect(screen.getByTestId('mindmap-drop-indicator')).toHaveAttribute(
      'data-drop-intent',
      'move-as-child',
    );

    dispatchPointerEvent(surface, 'up', betaCenter, 1);

    expect(store.getState().document.nodes.root.childIds).toEqual(['b']);
    expect(store.getState().document.nodes.b.childIds).toEqual(['a']);
    expect(store.getState().document.nodes.a.parentId).toBe('b');
    expect(store.getState().document.nodes.a.childIds).toEqual(['a-1']);
    expect(store.getState().document.nodes['a-1'].parentId).toBe('a');
    expect(store.getState().selection).toEqual({ selectedNodeId: 'a', focusedNodeId: 'a' });
  });

  it('drags siblings before and after visible layout targets', () => {
    const store = createSeedStore();
    const { container } = render(<StoreBackedCanvas store={store} />);
    const surface = getSurface(container);
    const layout = layoutMindMapDocument(store.getState().document);
    const betaStart = nodeClientPoint(layout, 'b');
    const alphaTop = nodeClientPoint(layout, 'a', 0.08);

    dispatchPointerEvent(screen.getByRole('button', { name: 'Beta' }), 'down', betaStart, 2);
    dispatchPointerEvent(surface, 'move', alphaTop, 2);

    expect(screen.getByTestId('mindmap-drop-indicator')).toHaveAttribute(
      'data-drop-intent',
      'reorder-before',
    );

    dispatchPointerEvent(surface, 'up', alphaTop, 2);

    expect(store.getState().document.nodes.root.childIds).toEqual(['b', 'a']);
    expect(store.getState().document.nodes.a.childIds).toEqual(['a-1']);
    expect(store.getState().selection.selectedNodeId).toBe('b');
  });

  it('shows invalid drop feedback without changing the document', () => {
    const store = createSeedStore();
    const { container } = render(<StoreBackedCanvas store={store} />);
    const surface = getSurface(container);
    const layout = layoutMindMapDocument(store.getState().document);
    const beforeDocument = store.getState().document;
    const alphaStart = nodeClientPoint(layout, 'a');
    const alphaDetailCenter = nodeClientPoint(layout, 'a-1');

    dispatchPointerEvent(screen.getByRole('button', { name: 'Alpha' }), 'down', alphaStart, 3);
    dispatchPointerEvent(surface, 'move', alphaDetailCenter, 3);

    expect(screen.getByTestId('mindmap-drop-indicator')).toHaveAttribute(
      'data-drop-intent',
      'invalid',
    );

    dispatchPointerEvent(surface, 'up', alphaDetailCenter, 3);

    expect(store.getState().document).toBe(beforeDocument);
    expect(store.getState().selection.selectedNodeId).toBe('root');
    expect(screen.queryByTestId('mindmap-drop-indicator')).not.toBeInTheDocument();
  });

  it('exposes zoom, fit, and focus controls through the editor store viewport', () => {
    const store = createSeedStore();

    render(<StoreBackedCanvas store={store} />);

    fireEvent.click(screen.getByRole('button', { name: 'Alpha detail' }));
    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    expect(store.getState().viewport.zoom).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole('button', { name: /fit to content/i }));
    expect(store.getState().viewport.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(store.getState().viewport.x)).toBe(true);
    expect(Number.isFinite(store.getState().viewport.y)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /focus selected node/i }));
    expect(store.getState().selection.focusedNodeId).toBe('a-1');
    expect(Number.isFinite(store.getState().viewport.x)).toBe(true);
    expect(Number.isFinite(store.getState().viewport.y)).toBe(true);
  });

  it('adds, renames, deletes, and restores nodes through visible controls', () => {
    const store = createSeedStore();

    render(<StoreBackedCanvas store={store} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add child node' }));
    const childEditor = screen.getByRole('textbox', { name: 'Rename New thought' });
    fireEvent.change(childEditor, { target: { value: 'Gamma branch' } });
    fireEvent.keyDown(childEditor, { key: 'Enter' });

    expect(screen.getByRole('button', { name: 'Gamma branch' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(store.getState().document.nodes.root.childIds).toContain(
      store.getState().selection.selectedNodeId,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add sibling node' }));
    const siblingEditor = screen.getByRole('textbox', { name: 'Rename New thought' });
    fireEvent.change(siblingEditor, { target: { value: 'Delta branch' } });
    fireEvent.keyDown(siblingEditor, { key: 'Enter' });

    expect(screen.getByRole('button', { name: 'Delta branch' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected branch' }));
    expect(screen.queryByRole('button', { name: 'Delta branch' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Delta branch' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.queryByRole('button', { name: 'Delta branch' })).not.toBeInTheDocument();
  });

  it('commits and cancels inline edits without corrupting empty or long text', () => {
    const store = createSeedStore();

    render(<StoreBackedCanvas store={store} />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Alpha' }));
    const cancelEditor = screen.getByRole('textbox', { name: 'Rename Alpha' });
    fireEvent.change(cancelEditor, { target: { value: 'Cancelled Alpha' } });
    fireEvent.keyDown(cancelEditor, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeVisible();
    expect(store.getState().document.nodes.a.text).toBe('Alpha');

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Alpha' }));
    const emptyEditor = screen.getByRole('textbox', { name: 'Rename Alpha' });
    fireEvent.change(emptyEditor, { target: { value: '' } });
    fireEvent.keyDown(emptyEditor, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Empty thought' })).toBeVisible();
    expect(store.getState().document.nodes.a.text).toBe('');

    const longText = 'Long editable thought '.repeat(24);
    fireEvent.click(screen.getByRole('button', { name: 'Rename selected node' }));
    const longEditor = screen.getByRole('textbox', { name: 'Rename Empty thought' });
    fireEvent.change(longEditor, { target: { value: longText } });
    fireEvent.blur(longEditor);
    expect(store.getState().document.nodes.a.text).toBe(longText);
  });

  it('handles keyboard creation, visible-node navigation, and collapse commands', () => {
    const store = createSeedStore();
    const { container } = render(<StoreBackedCanvas store={store} />);
    const surface = getSurface(container);

    fireEvent.keyDown(surface, { key: 'Tab' });
    const childEditor = screen.getByRole('textbox', { name: 'Rename New thought' });
    fireEvent.change(childEditor, { target: { value: 'Keyboard child' } });
    fireEvent.keyDown(childEditor, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Keyboard child' })).toBeVisible();

    fireEvent.keyDown(surface, { key: 'Tab', shiftKey: true });
    expect(store.getState().selection.selectedNodeId).toBe('root');

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.keyDown(surface, { key: 'ArrowRight' });
    expect(store.getState().selection.selectedNodeId).toBe('a-1');

    fireEvent.keyDown(surface, { key: 'ArrowLeft' });
    expect(store.getState().selection.selectedNodeId).toBe('a');

    fireEvent.keyDown(surface, { key: ' ' });
    expect(store.getState().document.nodes.a.collapsed).toBe(true);
    expect(screen.queryByRole('button', { name: 'Alpha detail' })).not.toBeInTheDocument();

    fireEvent.keyDown(surface, { key: 'ArrowDown' });
    expect(store.getState().selection.selectedNodeId).toBe('b');
  });

  it('supports keyboard branch reorder and reparent with undo and redo', () => {
    const store = createSeedStore();
    const { container } = render(<StoreBackedCanvas store={store} />);
    const surface = getSurface(container);

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Alpha' }));
    expect(store.getState().document.nodes.a.collapsed).toBe(true);

    fireEvent.keyDown(surface, { key: 'ArrowDown', altKey: true });
    expect(store.getState().document.nodes.root.childIds).toEqual(['b', 'a']);
    expect(store.getState().document.nodes.a.childIds).toEqual(['a-1']);
    expect(store.getState().document.nodes.a.collapsed).toBe(true);
    expect(store.getState().selection).toEqual({ selectedNodeId: 'a', focusedNodeId: 'a' });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(store.getState().document.nodes.root.childIds).toEqual(['a', 'b']);
    expect(store.getState().document.nodes.a.collapsed).toBe(true);
    expect(store.getState().selection.selectedNodeId).toBe('a');

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(store.getState().document.nodes.root.childIds).toEqual(['b', 'a']);
    expect(store.getState().document.nodes.a.collapsed).toBe(true);

    fireEvent.keyDown(surface, { key: 'ArrowRight', altKey: true });
    expect(store.getState().document.nodes.root.childIds).toEqual(['b']);
    expect(store.getState().document.nodes.b.childIds).toEqual(['a']);
    expect(store.getState().document.nodes.a.parentId).toBe('b');
    expect(store.getState().document.nodes.a.childIds).toEqual(['a-1']);

    fireEvent.keyDown(surface, { key: 'ArrowLeft', altKey: true });
    expect(store.getState().document.nodes.root.childIds).toEqual(['b', 'a']);
    expect(store.getState().document.nodes.b.childIds).toEqual([]);
    expect(store.getState().document.nodes.a.parentId).toBe('root');
  });

  it('supports repeated inline edits followed by undo and redo from the UI', () => {
    const store = createSeedStore();

    render(<StoreBackedCanvas store={store} />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Alpha' }));
    let editor = screen.getByRole('textbox', { name: 'Rename Alpha' });
    fireEvent.change(editor, { target: { value: 'Alpha one' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Alpha one' }));
    editor = screen.getByRole('textbox', { name: 'Rename Alpha one' });
    fireEvent.change(editor, { target: { value: 'Alpha two' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Alpha two' }));
    editor = screen.getByRole('textbox', { name: 'Rename Alpha two' });
    fireEvent.change(editor, { target: { value: 'Alpha three' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Alpha two' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'Alpha one' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByRole('button', { name: 'Alpha two' })).toBeVisible();
  });
});
