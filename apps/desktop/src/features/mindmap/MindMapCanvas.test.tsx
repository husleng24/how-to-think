import { fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useSyncExternalStore } from 'react';

import {
  createMindMapEditorStore,
} from './domain/mindMap';
import {
  getMindMapCommandAvailability,
  resolveMindMapShortcut,
} from './interaction';
import { layoutMindMapDocument } from './layout';
import { MindMapCanvas } from './MindMapCanvas';
import type { MindMapCommand, MindMapCommandResult, MindMapEditorStore } from './domain/mindMap';

const fixedDate = new Date('2026-01-02T03:04:05.000Z');

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
    const surface = container.querySelector('.mindmap-pan-surface');

    expect(surface).toBeInstanceOf(HTMLElement);
    if (!surface) {
      throw new Error('Mind map pan surface missing');
    }

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
