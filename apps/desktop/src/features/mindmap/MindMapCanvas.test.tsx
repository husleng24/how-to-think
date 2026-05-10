import { fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useSyncExternalStore } from 'react';

import {
  createMindMapEditorStore,
} from './domain/mindMap';
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
      store.dispatch(command);
    },
    [store],
  );

  return <MindMapCanvas state={state} onCommand={dispatch} />;
}

describe('MindMapCanvas', () => {
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
});
