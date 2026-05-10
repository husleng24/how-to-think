import {
  applyMindMapCommand,
  createEmptyMindMapDocument,
  createMindMapEditorState,
  createMindMapEditorStore,
  createSequentialNodeIdGenerator,
  getMindMapNode,
  getSubtreeNodeIds,
  listChildNodes,
  redoMindMapCommand,
  undoMindMapCommand,
  validateMindMapDocument,
} from './mindMap';
import type { MindMapDocument, MindMapEditorState, NodeId } from './mindMap';

const fixedDate = new Date('2026-01-02T03:04:05.000Z');
const laterDate = new Date('2026-01-02T03:04:06.000Z');

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  return result as Extract<T, { ok: true }>;
}

function expectError<T extends { ok: boolean }>(result: T, code: string): Extract<T, { ok: false }> {
  expect(result).toMatchObject({ ok: false, error: { code } });
  return result as Extract<T, { ok: false }>;
}

function command(
  state: MindMapEditorState,
  input: Parameters<typeof applyMindMapCommand>[1],
  nodeId = 'node-1',
): MindMapEditorState {
  return expectOk(
    applyMindMapCommand(state, input, {
      generateId: () => nodeId,
      now: laterDate,
    }),
  ).state;
}

function addChild(
  state: MindMapEditorState,
  parentId: NodeId,
  nodeId: NodeId,
  text = nodeId,
): MindMapEditorState {
  return command(state, { type: 'add-child', parentId, text }, nodeId);
}

describe('mind map document initialization and validation', () => {
  it('bootstraps an unsaved document with one selected center topic and valid invariants', () => {
    const document = createEmptyMindMapDocument(fixedDate);
    const state = createMindMapEditorState({ document });
    const root = getMindMapNode(document, document.rootNodeId);

    expect(document.title).toBe('Untitled map');
    expect(document.sourcePath).toBeNull();
    expect(document.version).toBe(1);
    expect(state.selection.selectedNodeId).toBe(document.rootNodeId);
    expect(state.selection.focusedNodeId).toBe(document.rootNodeId);
    expect(root.text).toBe('Untitled thought');
    expect(root.parentId).toBeNull();
    expect(root.childIds).toEqual([]);
    expect(root.collapsed).toBe(false);
    expect(document.createdAt).toBe(fixedDate.toISOString());
    expect(document.updatedAt).toBe(fixedDate.toISOString());
    expect(validateMindMapDocument(document)).toEqual({ ok: true, errors: [] });
  });

  it('reports broken tree invariants', () => {
    const document = createEmptyMindMapDocument(fixedDate);
    const invalid: MindMapDocument = {
      ...document,
      nodes: {
        ...document.nodes,
        root: {
          ...document.nodes.root,
          childIds: ['missing', 'orphan', 'orphan'],
        },
        orphan: {
          id: 'orphan',
          text: 'Orphan',
          parentId: null,
          childIds: [],
          collapsed: false,
          createdAt: fixedDate.toISOString(),
          updatedAt: fixedDate.toISOString(),
        },
        keyed: {
          id: 'other-id',
          text: 'Key mismatch',
          parentId: 'root',
          childIds: [],
          collapsed: false,
          createdAt: fixedDate.toISOString(),
          updatedAt: fixedDate.toISOString(),
        },
      },
    };

    const result = validateMindMapDocument(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(
        expect.arrayContaining([
          'missing_child',
          'duplicate_child',
          'multiple_roots',
          'parent_mismatch',
          'node_key_mismatch',
          'unreachable_node',
        ]),
      );
    }
  });
});

describe('mind map commands', () => {
  it('adds a child deterministically and selects it', () => {
    const state = createMindMapEditorState({ now: fixedDate });
    const result = applyMindMapCommand(
      state,
      { type: 'add-child', parentId: 'root', text: 'First child' },
      { generateId: () => 'child-1', now: laterDate },
    );
    const next = expectOk(result).state;

    expect(next.document.nodes.root.childIds).toEqual(['child-1']);
    expect(next.document.nodes['child-1']).toMatchObject({
      id: 'child-1',
      text: 'First child',
      parentId: 'root',
      childIds: [],
      collapsed: false,
    });
    expect(next.selection).toEqual({ selectedNodeId: 'child-1', focusedNodeId: 'child-1' });
    expect(next.document.updatedAt).toBe(laterDate.toISOString());
    expect(next.isDirty).toBe(true);
    expect(next.changeRevision).toBe(1);
    expect(next.history.undoStack).toHaveLength(1);
    expect(state.document.nodes.root.childIds).toEqual([]);
  });

  it('adds a sibling before or after an existing branch', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    state = addChild(state, 'root', 'a');
    state = addChild(state, 'root', 'b');

    const before = command(
      state,
      { type: 'add-sibling', nodeId: 'b', text: 'Before B', position: 'before' },
      'before-b',
    );
    const after = command(
      before,
      { type: 'add-sibling', nodeId: 'b', text: 'After B', position: 'after' },
      'after-b',
    );

    expect(after.document.nodes.root.childIds).toEqual(['a', 'before-b', 'b', 'after-b']);
    expect(after.document.nodes['before-b'].parentId).toBe('root');
    expect(after.document.nodes['after-b'].parentId).toBe('root');
  });

  it('renames nodes with empty and long text without trimming', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    state = addChild(state, 'root', 'a');

    state = command(state, { type: 'rename-node', nodeId: 'a', text: '' });
    expect(state.document.nodes.a.text).toBe('');

    const longText = 'Long thought '.repeat(200);
    state = command(state, { type: 'rename-node', nodeId: 'a', text: longText });
    expect(state.document.nodes.a.text).toBe(longText);
  });

  it('deletes a subtree exactly and moves selection to the surviving parent', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    state = addChild(state, 'root', 'a');
    state = addChild(state, 'a', 'a-1');
    state = addChild(state, 'a-1', 'a-1-1');
    state = addChild(state, 'root', 'b');
    state = command(state, { type: 'select-node', nodeId: 'a-1' });
    state = command(state, { type: 'focus-node', nodeId: 'a-1' });

    const result = applyMindMapCommand(state, { type: 'delete-subtree', nodeId: 'a' }, { now: laterDate });
    const okResult = expectOk(result);
    const next = okResult.state;

    expect(okResult.change.deletedNodeIds).toEqual(['a', 'a-1', 'a-1-1']);
    expect(Object.keys(next.document.nodes).sort()).toEqual(['b', 'root']);
    expect(next.document.nodes.root.childIds).toEqual(['b']);
    expect(next.selection.selectedNodeId).toBe('root');
    expect(next.selection.focusedNodeId).toBe('root');
  });

  it('deletes a large branch', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    state = addChild(state, 'root', 'branch');

    for (let index = 0; index < 50; index += 1) {
      state = addChild(state, 'branch', `child-${index}`);
      state = addChild(state, `child-${index}`, `grandchild-${index}`);
    }

    const result = expectOk(
      applyMindMapCommand(state, { type: 'delete-subtree', nodeId: 'branch' }, { now: laterDate }),
    );

    expect(result.change.deletedNodeIds).toHaveLength(101);
    expect(Object.keys(result.state.document.nodes)).toEqual(['root']);
    expect(validateMindMapDocument(result.state.document)).toEqual({ ok: true, errors: [] });
  });

  it('moves subtrees across parents and reorders siblings within the same parent', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    state = addChild(state, 'root', 'a');
    state = addChild(state, 'root', 'b');
    state = addChild(state, 'root', 'c');
    state = addChild(state, 'a', 'a-1');

    state = command(state, { type: 'move-subtree', nodeId: 'a-1', newParentId: 'b' });
    expect(state.document.nodes.a.childIds).toEqual([]);
    expect(state.document.nodes.b.childIds).toEqual(['a-1']);
    expect(state.document.nodes['a-1'].parentId).toBe('b');

    state = command(state, { type: 'move-subtree', nodeId: 'c', newParentId: 'root', index: 0 });
    expect(state.document.nodes.root.childIds).toEqual(['c', 'a', 'b']);
  });

  it('reorders siblings with exact sibling sets only', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    state = addChild(state, 'root', 'a');
    state = addChild(state, 'root', 'b');
    state = addChild(state, 'root', 'c');

    const reordered = command(state, {
      type: 'reorder-siblings',
      parentId: 'root',
      childIds: ['c', 'a', 'b'],
    });

    expect(reordered.document.nodes.root.childIds).toEqual(['c', 'a', 'b']);

    const invalid = applyMindMapCommand(reordered, {
      type: 'reorder-siblings',
      parentId: 'root',
      childIds: ['c', 'a', 'a'],
    });
    expectError(invalid, 'invalid_sibling_order');
    expect(invalid.state).toBe(reordered);
  });

  it('collapses, expands, selects, focuses, and updates viewport state', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    state = addChild(state, 'root', 'a');

    state = command(state, { type: 'collapse-node', nodeId: 'a' });
    expect(state.document.nodes.a.collapsed).toBe(true);

    state = command(state, { type: 'expand-node', nodeId: 'a' });
    expect(state.document.nodes.a.collapsed).toBe(false);

    state = command(state, { type: 'select-node', nodeId: 'root' });
    expect(state.selection.selectedNodeId).toBe('root');
    expect(state.isDirty).toBe(true);

    const beforeUiRevision = state.contentRevision;
    state = command(state, { type: 'focus-node', nodeId: null });
    state = command(state, { type: 'update-viewport', viewport: { x: 120, y: -40, zoom: 1.75 } });

    expect(state.selection.focusedNodeId).toBeNull();
    expect(state.viewport).toEqual({ x: 120, y: -40, zoom: 1.75 });
    expect(state.contentRevision).toBe(beforeUiRevision);
  });

  it('supports deep nesting traversal', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    let parentId = 'root';

    for (let index = 0; index < 25; index += 1) {
      const nodeId = `deep-${index}`;
      state = addChild(state, parentId, nodeId);
      parentId = nodeId;
    }

    expect(getSubtreeNodeIds(state.document, 'root')).toHaveLength(26);
    expect(validateMindMapDocument(state.document)).toEqual({ ok: true, errors: [] });
  });

  it('returns typed errors and leaves state unchanged for invalid commands', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    state = addChild(state, 'root', 'a');
    state = addChild(state, 'a', 'a-1');

    expectError(applyMindMapCommand(state, { type: 'add-child', parentId: 'missing' }), 'node_not_found');
    expectError(applyMindMapCommand(state, { type: 'add-sibling', nodeId: 'root' }), 'root_operation_forbidden');
    expectError(applyMindMapCommand(state, { type: 'delete-subtree', nodeId: 'root' }), 'root_operation_forbidden');
    expectError(applyMindMapCommand(state, { type: 'move-subtree', nodeId: 'root', newParentId: 'a' }), 'root_operation_forbidden');
    expectError(applyMindMapCommand(state, { type: 'move-subtree', nodeId: 'a', newParentId: 'a-1' }), 'cannot_move_into_descendant');
    expectError(applyMindMapCommand(state, { type: 'update-viewport', viewport: { zoom: 0 } }), 'invalid_viewport');

    const invalid = applyMindMapCommand(state, {
      type: 'add-child',
      parentId: 'root',
      newNodeId: 'a',
    });
    expectError(invalid, 'duplicate_node_id');
    expect(invalid.state).toBe(state);
  });
});

describe('mind map undo and redo', () => {
  it('restores content, selection, collapse state, and sibling order', () => {
    let state = createMindMapEditorState({ now: fixedDate });
    state = addChild(state, 'root', 'a', 'A');
    state = addChild(state, 'root', 'b', 'B');
    state = command(state, { type: 'collapse-node', nodeId: 'a' });
    state = command(state, { type: 'reorder-siblings', parentId: 'root', childIds: ['b', 'a'] });
    state = command(state, { type: 'select-node', nodeId: 'root' });

    const undoneSelect = expectOk(undoMindMapCommand(state)).state;
    expect(undoneSelect.selection.selectedNodeId).toBe('b');

    const undoneReorder = expectOk(undoMindMapCommand(undoneSelect)).state;
    expect(undoneReorder.document.nodes.root.childIds).toEqual(['a', 'b']);
    expect(undoneReorder.document.nodes.a.collapsed).toBe(true);

    const undoneCollapse = expectOk(undoMindMapCommand(undoneReorder)).state;
    expect(undoneCollapse.document.nodes.a.collapsed).toBe(false);

    const redoneCollapse = expectOk(redoMindMapCommand(undoneCollapse)).state;
    const redoneReorder = expectOk(redoMindMapCommand(redoneCollapse)).state;
    const redoneSelect = expectOk(redoMindMapCommand(redoneReorder)).state;

    expect(redoneSelect.document.nodes.root.childIds).toEqual(['b', 'a']);
    expect(redoneSelect.document.nodes.a.collapsed).toBe(true);
    expect(redoneSelect.selection.selectedNodeId).toBe('root');
  });

  it('bounds history and reports empty history errors', () => {
    let state = createMindMapEditorState({ now: fixedDate, historyLimit: 2 });

    state = addChild(state, 'root', 'a');
    state = addChild(state, 'root', 'b');
    state = addChild(state, 'root', 'c');

    expect(state.history.undoStack).toHaveLength(2);
    state = expectOk(undoMindMapCommand(state)).state;
    state = expectOk(undoMindMapCommand(state)).state;

    expectError(undoMindMapCommand(state), 'history_empty');
    expect(state.document.nodes.root.childIds).toEqual(['a']);
  });

  it('handles rapid sequential edits followed by multi-step undo and redo', () => {
    let state = createMindMapEditorState({ now: fixedDate });

    for (let index = 0; index < 10; index += 1) {
      state = addChild(state, 'root', `node-${index}`);
      state = command(state, {
        type: 'rename-node',
        nodeId: `node-${index}`,
        text: `Renamed ${index}`,
      });
    }

    expect(listChildNodes(state.document, 'root')).toHaveLength(10);

    for (let index = 0; index < 20; index += 1) {
      state = expectOk(undoMindMapCommand(state)).state;
    }
    expect(listChildNodes(state.document, 'root')).toHaveLength(0);

    for (let index = 0; index < 20; index += 1) {
      state = expectOk(redoMindMapCommand(state)).state;
    }
    expect(listChildNodes(state.document, 'root').map((node) => node.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Renamed ${index}`),
    );
  });
});

describe('mind map editor store', () => {
  it('dispatches commands, publishes change signals, and tracks dirty state', () => {
    const idGenerator = createSequentialNodeIdGenerator('test-node');
    const store = createMindMapEditorStore({
      now: fixedDate,
      generateId: idGenerator,
      clock: () => laterDate,
    });
    const changes: string[] = [];
    const unsubscribe = store.subscribe((_state, change) => {
      changes.push(`${change.command}:${change.changeRevision}:${change.isDirty}`);
    });

    const addResult = expectOk(
      store.dispatch({ type: 'add-child', parentId: 'root', text: 'Store child' }),
    );
    const childId = addResult.change.addedNodeId as NodeId;

    expect(childId).toBe('test-node-1');
    expect(store.getState().document.nodes.root.childIds).toEqual([childId]);
    expect(store.getState().isDirty).toBe(true);

    store.markClean();
    expect(store.getState().isDirty).toBe(false);

    expectOk(store.dispatch({ type: 'update-viewport', viewport: { zoom: 2 } }));
    expect(store.getState().isDirty).toBe(false);

    expectOk(store.dispatch({ type: 'rename-node', nodeId: childId, text: 'Renamed in store' }));
    expect(store.getState().isDirty).toBe(true);

    expectOk(store.undo());
    expect(store.getState().document.nodes[childId].text).toBe('Store child');
    expectOk(store.redo());
    expect(store.getState().document.nodes[childId].text).toBe('Renamed in store');

    unsubscribe();
    expectOk(store.dispatch({ type: 'select-node', nodeId: 'root' }));

    expect(changes).toEqual([
      'add-child:1:true',
      'mark-clean:2:false',
      'update-viewport:3:false',
      'rename-node:4:true',
      'undo:5:false',
      'redo:6:true',
    ]);
  });
});
