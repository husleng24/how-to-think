import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  LocateFixed,
  Maximize2,
  Pencil,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, WheelEvent } from 'react';

import type {
  MindMapCommand,
  MindMapCommandResult,
  MindMapEditorState,
  NodeId,
  ViewportState,
} from './domain/mindMap';
import type { LinkInteractionController } from '../markdown-compat';
import { MarkdownLinkText } from '../markdown-compat';
import {
  getClosestVisibleNodeId,
  getMindMapCommandAvailability,
  mindMapDropIntentToCommand,
  resolveMindMapDropIntent,
  resolveMindMapShortcut,
} from './interaction';
import type { MindMapDropIntent, MindMapEditorAction } from './interaction';
import { getMindMapLayoutNode, layoutMindMapDocument } from './layout';
import type { MindMapLayoutNode, MindMapLayoutResult } from './layout';
import './MindMapCanvas.css';

interface MindMapCanvasProps {
  state: MindMapEditorState;
  onCommand(command: MindMapCommand): MindMapCommandResult | void;
  onUndo?(): MindMapCommandResult | void;
  onRedo?(): MindMapCommandResult | void;
  linkInteraction?: LinkInteractionController;
}

interface PanDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startViewport: ViewportState;
}

interface BranchDragState {
  pointerId: number;
  nodeId: NodeId;
  startClientX: number;
  startClientY: number;
  active: boolean;
}

interface EditingState {
  nodeId: NodeId;
  draft: string;
}

const CONTENT_PADDING = 160;
const VIEWPORT_MARGIN = 72;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.4;
const FIT_MAX_ZOOM = 1.25;
const DEFAULT_VIEWPORT_WIDTH = 900;
const DEFAULT_VIEWPORT_HEIGHT = 540;
const BRANCH_DRAG_THRESHOLD = 5;

export function MindMapCanvas({
  state,
  onCommand,
  onUndo,
  onRedo,
  linkInteraction,
}: MindMapCanvasProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panDragRef = useRef<PanDragState | null>(null);
  const branchDragRef = useRef<BranchDragState | null>(null);
  const suppressNextNodeClickRef = useRef(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [dropIntent, setDropIntent] = useState<MindMapDropIntent | null>(null);
  const layout = useMemo(
    () => layoutMindMapDocument(state.document),
    [state.document],
  );
  const availability = useMemo(() => getMindMapCommandAvailability(state), [state]);
  const selectedNode = state.document.nodes[state.selection.selectedNodeId];
  const contentWidth = Math.max(1, layout.bounds.width + CONTENT_PADDING * 2);
  const contentHeight = Math.max(1, layout.bounds.height + CONTENT_PADDING * 2);
  const zoomPercent = Math.round(state.viewport.zoom * 100);
  const collapseSelectedLabel = selectedNode?.collapsed
    ? 'Expand selected branch'
    : 'Collapse selected branch';
  const rendererClassName = [
    'mindmap-renderer',
    panDragRef.current ? 'is-panning' : '',
    dropIntent ? 'is-branch-dragging' : '',
    dropIntent?.type === 'invalid' ? 'is-invalid-drop' : '',
  ]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    if (editing && !state.document.nodes[editing.nodeId]) {
      setEditing(null);
    }
  }, [editing, state.document.nodes]);

  const updateViewport = (viewport: Partial<ViewportState>): void => {
    onCommand({ type: 'update-viewport', viewport });
  };

  const beginEditing = useCallback(
    (nodeId: NodeId, text?: string): void => {
      const node = state.document.nodes[nodeId];
      const draft = text ?? node?.text;

      if (draft === undefined) {
        return;
      }

      setEditing({ nodeId, draft });
      onCommand({ type: 'select-node', nodeId });
      onCommand({ type: 'focus-node', nodeId });
    },
    [onCommand, state.document.nodes],
  );

  const commitEditing = useCallback((): void => {
    if (!editing) {
      return;
    }

    const node = state.document.nodes[editing.nodeId];
    if (node && node.text !== editing.draft) {
      onCommand({ type: 'rename-node', nodeId: editing.nodeId, text: editing.draft });
    }

    setEditing(null);
  }, [editing, onCommand, state.document.nodes]);

  const cancelEditing = useCallback((): void => {
    setEditing(null);
  }, []);

  const updateEditingDraft = useCallback((draft: string): void => {
    setEditing((current) => (current ? { ...current, draft } : current));
  }, []);

  const runCommand = useCallback(
    (command: MindMapCommand): MindMapCommandResult | void => {
      return onCommand(command);
    },
    [onCommand],
  );

  const runCommandAndEditAddedNode = useCallback(
    (command: MindMapCommand): void => {
      const result = runCommand(command);

      if (result?.ok && result.change.addedNodeId) {
        const addedNode = result.state.document.nodes[result.change.addedNodeId];
        beginEditing(result.change.addedNodeId, addedNode?.text);
      }
    },
    [beginEditing, runCommand],
  );

  const executeAction = useCallback(
    (action: MindMapEditorAction): void => {
      switch (action.type) {
        case 'command':
          if (action.command.type === 'add-child' || action.command.type === 'add-sibling') {
            runCommandAndEditAddedNode(action.command);
          } else {
            runCommand(action.command);
          }
          return;
        case 'undo':
          setEditing(null);
          onUndo?.();
          return;
        case 'redo':
          setEditing(null);
          onRedo?.();
          return;
        case 'begin-edit':
          beginEditing(action.nodeId);
          return;
        case 'none':
          return;
      }
    },
    [beginEditing, onRedo, onUndo, runCommand, runCommandAndEditAddedNode],
  );

  const handleShortcut = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (isTextEditingTarget(event.target)) {
      return;
    }

    const action = resolveMindMapShortcut(event, state, layout);

    if (action.type === 'none') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    executeAction(action);
  };

  const fitToContent = (): void => {
    updateViewport(calculateFitViewport(layout, getViewportSize(viewportRef.current)));
  };

  const focusSelectedNode = (): void => {
    const nodeId = getClosestVisibleNodeId(layout, state.document.nodes, state.selection.selectedNodeId);
    const layoutNode = nodeId ? getMindMapLayoutNode(layout, nodeId) : undefined;

    if (!layoutNode) {
      return;
    }

    const size = getViewportSize(viewportRef.current);
    const zoom = clampZoom(state.viewport.zoom);
    const center = getLayoutNodeCenter(layoutNode);

    onCommand({ type: 'focus-node', nodeId: state.selection.selectedNodeId });
    updateViewport({
      x: size.width / 2 - center.x * zoom,
      y: size.height / 2 - center.y * zoom,
      zoom,
    });
  };

  const zoomBy = (factor: number): void => {
    const size = getViewportSize(viewportRef.current);
    const nextZoom = clampZoom(state.viewport.zoom * factor);
    const centerX = size.width / 2;
    const centerY = size.height / 2;
    const worldX = (centerX - state.viewport.x) / state.viewport.zoom;
    const worldY = (centerY - state.viewport.y) / state.viewport.zoom;

    updateViewport({
      x: centerX - worldX * nextZoom,
      y: centerY - worldY * nextZoom,
      zoom: nextZoom,
    });
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();

    const rect = event.currentTarget.getBoundingClientRect();
    const nextZoom = clampZoom(state.viewport.zoom * (event.deltaY > 0 ? 0.9 : 1.1));
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const worldX = (localX - state.viewport.x) / state.viewport.zoom;
    const worldY = (localY - state.viewport.y) / state.viewport.zoom;

    updateViewport({
      x: localX - worldX * nextZoom,
      y: localY - worldY * nextZoom,
      zoom: nextZoom,
    });
  };

  const handleNodePointerDown = (
    nodeId: NodeId,
    event: PointerEvent<HTMLElement>,
  ): void => {
    if (!isPrimaryPointerButton(event) || editing) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    branchDragRef.current = {
      pointerId: event.pointerId,
      nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      active: false,
    };
    capturePointer(viewport, event.pointerId);
    event.stopPropagation();
  };

  const handleNodeClick = (
    nodeId: NodeId,
    event: MouseEvent<HTMLElement>,
  ): void => {
    if (suppressNextNodeClickRef.current) {
      suppressNextNodeClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    onCommand({ type: 'select-node', nodeId });
    onCommand({ type: 'focus-node', nodeId });
  };

  const handleNodeFocus = (nodeId: NodeId): void => {
    if (branchDragRef.current) {
      return;
    }

    onCommand({ type: 'focus-node', nodeId });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!isPrimaryPointerButton(event) || !canStartPan(event.target)) {
      return;
    }

    panDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewport: state.viewport,
    };
    capturePointer(event.currentTarget, event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const branchDrag = branchDragRef.current;
    if (branchDrag && branchDrag.pointerId === event.pointerId) {
      const deltaX = event.clientX - branchDrag.startClientX;
      const deltaY = event.clientY - branchDrag.startClientY;

      if (!branchDrag.active) {
        if (Math.hypot(deltaX, deltaY) < BRANCH_DRAG_THRESHOLD) {
          return;
        }

        branchDrag.active = true;
        suppressNextNodeClickRef.current = true;
      }

      setDropIntent(
        resolveMindMapDropIntent(state, layout, {
          draggedNodeId: branchDrag.nodeId,
          point: getLayoutPointFromPointer(event, state.viewport),
        }),
      );
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    updateViewport({
      x: drag.startViewport.x + event.clientX - drag.startClientX,
      y: drag.startViewport.y + event.clientY - drag.startClientY,
    });
  };

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const branchDrag = branchDragRef.current;
    if (branchDrag && branchDrag.pointerId === event.pointerId) {
      releasePointer(event.currentTarget, event.pointerId);

      if (branchDrag.active) {
        const intent = resolveMindMapDropIntent(state, layout, {
          draggedNodeId: branchDrag.nodeId,
          point: getLayoutPointFromPointer(event, state.viewport),
        });
        const command = mindMapDropIntentToCommand(intent);

        suppressNextNodeClickRef.current = true;
        window.setTimeout(() => {
          suppressNextNodeClickRef.current = false;
        }, 0);

        if (command) {
          runCommand(command);
        }

        event.preventDefault();
        event.stopPropagation();
      }

      branchDragRef.current = null;
      setDropIntent(null);
      return;
    }

    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    releasePointer(event.currentTarget, event.pointerId);
    panDragRef.current = null;
  };

  return (
    <section
      className={rendererClassName}
      aria-label="Editable mind map canvas"
    >
      <div className="mindmap-controls" aria-label="Canvas controls">
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Add child node"
          title="Add child node"
          disabled={!availability.canAddChild}
          onClick={() =>
            runCommandAndEditAddedNode({
              type: 'add-child',
              parentId: state.selection.selectedNodeId,
            })
          }
        >
          <Plus size={16} />
        </button>
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Add sibling node"
          title="Add sibling node"
          disabled={!availability.canAddSibling}
          onClick={() =>
            runCommandAndEditAddedNode({
              type: 'add-sibling',
              nodeId: state.selection.selectedNodeId,
            })
          }
        >
          <CornerDownRight size={16} />
        </button>
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Rename selected node"
          title="Rename selected node"
          disabled={!availability.canRename}
          onClick={() => beginEditing(state.selection.selectedNodeId)}
        >
          <Pencil size={16} />
        </button>
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Delete selected branch"
          title="Delete selected branch"
          disabled={!availability.canDelete}
          onClick={() =>
            runCommand({
              type: 'delete-subtree',
              nodeId: state.selection.selectedNodeId,
            })
          }
        >
          <Trash2 size={16} />
        </button>
        <button
          className="mindmap-control-button"
          type="button"
          aria-label={collapseSelectedLabel}
          title={collapseSelectedLabel}
          disabled={!availability.canToggleCollapse}
          onClick={() =>
            selectedNode
              ? runCommand({
                  type: selectedNode.collapsed ? 'expand-node' : 'collapse-node',
                  nodeId: selectedNode.id,
                })
              : undefined
          }
        >
          {selectedNode?.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <span className="mindmap-control-divider" aria-hidden="true" />
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Undo"
          title="Undo"
          disabled={!availability.canUndo}
          onClick={() => onUndo?.()}
        >
          <Undo2 size={16} />
        </button>
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Redo"
          title="Redo"
          disabled={!availability.canRedo}
          onClick={() => onRedo?.()}
        >
          <Redo2 size={16} />
        </button>
        <span className="mindmap-control-divider" aria-hidden="true" />
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomBy(0.88)}
        >
          <ZoomOut size={16} />
        </button>
        <span className="mindmap-zoom-level">{zoomPercent}%</span>
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomBy(1.14)}
        >
          <ZoomIn size={16} />
        </button>
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Fit to content"
          title="Fit to content"
          onClick={fitToContent}
        >
          <Maximize2 size={16} />
        </button>
        <button
          className="mindmap-control-button"
          type="button"
          aria-label="Focus selected node"
          title="Focus selected node"
          onClick={focusSelectedNode}
        >
          <LocateFixed size={16} />
        </button>
      </div>

      <div
        className="mindmap-pan-surface"
        ref={viewportRef}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
        onKeyDown={handleShortcut}
        tabIndex={0}
      >
        {layout.nodes.length === 0 ? (
          <p className="mindmap-empty-state">No mind map nodes to display.</p>
        ) : (
          <div
            className="mindmap-content"
            style={{
              width: contentWidth,
              height: contentHeight,
              transform: `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.zoom})`,
            }}
          >
            <svg
              className="mindmap-edges"
              width={contentWidth}
              height={contentHeight}
              viewBox={`0 0 ${contentWidth} ${contentHeight}`}
              data-testid="mindmap-edges"
              aria-hidden="true"
            >
              {layout.edges.map((edge) => (
                <path
                  className={`mindmap-edge${edge.sourceId === state.document.rootNodeId ? ' is-root-edge' : ''}`}
                  d={edgePath(edge.source, edge.target)}
                  data-testid="mindmap-edge"
                  key={edge.id}
                />
              ))}
            </svg>
            {layout.nodes.map((node) => (
              <MindMapNodeView
                key={node.id}
                layoutNode={node}
                selected={state.selection.selectedNodeId === node.id}
                focused={state.selection.focusedNodeId === node.id}
                editing={editing?.nodeId === node.id}
                editDraft={editing?.nodeId === node.id ? editing.draft : ''}
                linkInteraction={linkInteraction}
                onBeginEditing={beginEditing}
                onCancelEditing={cancelEditing}
                onCommand={onCommand}
                onCommitEditing={commitEditing}
                onFocusNode={handleNodeFocus}
                onNodeClick={handleNodeClick}
                onNodePointerDown={handleNodePointerDown}
                onUpdateEditDraft={updateEditingDraft}
              />
            ))}
            <MindMapDropIndicator intent={dropIntent} layout={layout} />
          </div>
        )}
      </div>
    </section>
  );
}

function MindMapNodeView({
  layoutNode,
  selected,
  focused,
  editing,
  editDraft,
  linkInteraction,
  onBeginEditing,
  onCancelEditing,
  onCommand,
  onCommitEditing,
  onFocusNode,
  onNodeClick,
  onNodePointerDown,
  onUpdateEditDraft,
}: {
  layoutNode: MindMapLayoutNode;
  selected: boolean;
  focused: boolean;
  editing: boolean;
  editDraft: string;
  linkInteraction?: LinkInteractionController;
  onBeginEditing(nodeId: NodeId): void;
  onCancelEditing(): void;
  onCommand(command: MindMapCommand): MindMapCommandResult | void;
  onCommitEditing(): void;
  onFocusNode(nodeId: NodeId): void;
  onNodeClick(nodeId: NodeId, event: MouseEvent<HTMLElement>): void;
  onNodePointerDown(nodeId: NodeId, event: PointerEvent<HTMLElement>): void;
  onUpdateEditDraft(draft: string): void;
}) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const displayText = layoutNode.node.text.trim() || 'Empty thought';
  const childLabel =
    layoutNode.childCount === 1 ? '1 child' : `${layoutNode.childCount} children`;
  const className = [
    'mindmap-node',
    layoutNode.isRoot ? 'is-root' : '',
    selected ? 'is-selected' : '',
    focused ? 'is-focused' : '',
    layoutNode.node.text.trim() ? '' : 'is-empty',
  ]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    if (!editing) {
      return;
    }

    editorRef.current?.focus();
    editorRef.current?.select();
  }, [editing]);

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancelEditing();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onCommitEditing();
    }
  };

  return (
    <div
      className={className}
      data-mindmap-node={layoutNode.id}
      style={{
        left: layoutNode.x + CONTENT_PADDING,
        top: layoutNode.y + CONTENT_PADDING,
        width: layoutNode.width,
        height: layoutNode.height,
      }}
    >
      {editing ? (
        <div className="mindmap-node-main mindmap-node-editor-shell">
          <span className="mindmap-node-kicker">
            <span className="mindmap-node-depth">
              {layoutNode.isRoot ? 'Center topic' : `Level ${layoutNode.depth}`}
            </span>
            {layoutNode.childCount > 0 ? (
              <span className="mindmap-node-count">{childLabel}</span>
            ) : null}
          </span>
          <textarea
            className="mindmap-node-editor"
            ref={editorRef}
            aria-label={`Rename ${displayText}`}
            value={editDraft}
            onBlur={onCommitEditing}
            onChange={(event) => onUpdateEditDraft(event.currentTarget.value)}
            onKeyDown={handleEditorKeyDown}
          />
        </div>
      ) : (
        <div
          className="mindmap-node-main"
          role="button"
          tabIndex={0}
          aria-label={displayText}
          aria-pressed={selected}
          onClick={(event) => onNodeClick(layoutNode.id, event)}
          onDoubleClick={() => onBeginEditing(layoutNode.id)}
          onFocus={() => onFocusNode(layoutNode.id)}
          onPointerDown={(event) => onNodePointerDown(layoutNode.id, event)}
        >
          <span className="mindmap-node-kicker">
            <span className="mindmap-node-depth">
              {layoutNode.isRoot ? 'Center topic' : `Level ${layoutNode.depth}`}
            </span>
            {layoutNode.childCount > 0 ? (
              <span className="mindmap-node-count">{childLabel}</span>
            ) : null}
          </span>
          <span className="mindmap-node-text">
            <MarkdownLinkText text={displayText} linkInteraction={linkInteraction} />
          </span>
        </div>
      )}

      {layoutNode.childCount > 0 ? (
        <button
          className="mindmap-node-toggle"
          type="button"
          aria-label={`${layoutNode.node.collapsed ? 'Expand' : 'Collapse'} ${displayText}`}
          title={`${layoutNode.node.collapsed ? 'Expand' : 'Collapse'} branch`}
          onClick={() =>
            onCommand({
              type: layoutNode.node.collapsed ? 'expand-node' : 'collapse-node',
              nodeId: layoutNode.id,
            })
          }
        >
          {layoutNode.node.collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
        </button>
      ) : null}

      {layoutNode.hasHiddenChildren ? (
        <span className="mindmap-hidden-count" aria-label={`${layoutNode.hiddenDescendantCount} hidden descendants`}>
          {layoutNode.hiddenDescendantCount}
        </span>
      ) : null}
    </div>
  );
}

function MindMapDropIndicator({
  intent,
  layout,
}: {
  intent: MindMapDropIntent | null;
  layout: MindMapLayoutResult;
}) {
  if (!intent?.targetNodeId) {
    return null;
  }

  const targetNode = getMindMapLayoutNode(layout, intent.targetNodeId);
  if (!targetNode) {
    return null;
  }

  if (intent.type === 'move-as-child' || intent.type === 'invalid') {
    return (
      <div
        className={`mindmap-drop-indicator ${
          intent.type === 'invalid' ? 'is-invalid' : 'is-child'
        }`}
        data-drop-intent={intent.type}
        data-testid="mindmap-drop-indicator"
        aria-hidden="true"
        style={{
          left: targetNode.x + CONTENT_PADDING,
          top: targetNode.y + CONTENT_PADDING,
          width: targetNode.width,
          height: targetNode.height,
        }}
      />
    );
  }

  const indicatorTop =
    intent.type === 'reorder-before'
      ? targetNode.y + CONTENT_PADDING
      : targetNode.y + targetNode.height + CONTENT_PADDING;

  return (
    <div
      className="mindmap-drop-indicator is-reorder"
      data-drop-intent={intent.type}
      data-testid="mindmap-drop-indicator"
      aria-hidden="true"
      style={{
        left: targetNode.x + CONTENT_PADDING - 16,
        top: indicatorTop - 2,
        width: targetNode.width + 32,
      }}
    />
  );
}

function edgePath(
  source: { x: number; y: number },
  target: { x: number; y: number },
): string {
  const startX = source.x + CONTENT_PADDING;
  const startY = source.y + CONTENT_PADDING;
  const endX = target.x + CONTENT_PADDING;
  const endY = target.y + CONTENT_PADDING;
  const distance = Math.max(80, endX - startX);
  const controlOffset = distance * 0.48;

  return `M ${startX} ${startY} C ${startX + controlOffset} ${startY}, ${endX - controlOffset} ${endY}, ${endX} ${endY}`;
}

function calculateFitViewport(
  layout: MindMapLayoutResult,
  size: { width: number; height: number },
): ViewportState {
  const contentWidth = Math.max(1, layout.bounds.width + CONTENT_PADDING * 2);
  const contentHeight = Math.max(1, layout.bounds.height + CONTENT_PADDING * 2);
  const availableWidth = Math.max(1, size.width - VIEWPORT_MARGIN * 2);
  const availableHeight = Math.max(1, size.height - VIEWPORT_MARGIN * 2);
  const zoom = clampZoom(Math.min(FIT_MAX_ZOOM, availableWidth / contentWidth, availableHeight / contentHeight));

  return {
    x: (size.width - contentWidth * zoom) / 2,
    y: (size.height - contentHeight * zoom) / 2,
    zoom,
  };
}

function getLayoutNodeCenter(node: MindMapLayoutNode): { x: number; y: number } {
  return {
    x: node.x + CONTENT_PADDING + node.width / 2,
    y: node.y + CONTENT_PADDING + node.height / 2,
  };
}

function getViewportSize(element: HTMLDivElement | null): { width: number; height: number } {
  return {
    width: element?.clientWidth || DEFAULT_VIEWPORT_WIDTH,
    height: element?.clientHeight || DEFAULT_VIEWPORT_HEIGHT,
  };
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function getLayoutPointFromPointer(
  event: PointerEvent<HTMLElement>,
  viewport: ViewportState,
): { x: number; y: number } {
  const rect = event.currentTarget.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;

  return {
    x: (localX - viewport.x) / viewport.zoom - CONTENT_PADDING,
    y: (localY - viewport.y) / viewport.zoom - CONTENT_PADDING,
  };
}

function capturePointer(element: HTMLElement, pointerId: number): void {
  if (typeof element.setPointerCapture === 'function') {
    element.setPointerCapture(pointerId);
  }
}

function releasePointer(element: HTMLElement, pointerId: number): void {
  if (
    typeof element.hasPointerCapture === 'function' &&
    element.hasPointerCapture(pointerId) &&
    typeof element.releasePointerCapture === 'function'
  ) {
    element.releasePointerCapture(pointerId);
  }
}

function isPrimaryPointerButton(event: PointerEvent<HTMLElement>): boolean {
  const button = (event as PointerEvent<HTMLElement> & { button?: number }).button;
  return button === undefined || button === 0;
}

function canStartPan(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !target.closest('button, input, textarea, select, [contenteditable="true"]')
  );
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
  );
}
