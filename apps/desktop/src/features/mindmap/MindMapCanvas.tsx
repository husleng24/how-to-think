import {
  ChevronDown,
  ChevronRight,
  LocateFixed,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useMemo, useRef } from 'react';
import type { PointerEvent, WheelEvent } from 'react';

import type { MindMapCommand, MindMapEditorState, NodeId, ViewportState } from './domain/mindMap';
import { getMindMapLayoutNode, layoutMindMapDocument } from './layout';
import type { MindMapLayoutNode, MindMapLayoutResult } from './layout';
import './MindMapCanvas.css';

interface MindMapCanvasProps {
  state: MindMapEditorState;
  onCommand(command: MindMapCommand): void;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startViewport: ViewportState;
}

const CONTENT_PADDING = 160;
const VIEWPORT_MARGIN = 72;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.4;
const FIT_MAX_ZOOM = 1.25;
const DEFAULT_VIEWPORT_WIDTH = 900;
const DEFAULT_VIEWPORT_HEIGHT = 540;

export function MindMapCanvas({ state, onCommand }: MindMapCanvasProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const layout = useMemo(
    () => layoutMindMapDocument(state.document),
    [state.document],
  );
  const contentWidth = Math.max(1, layout.bounds.width + CONTENT_PADDING * 2);
  const contentHeight = Math.max(1, layout.bounds.height + CONTENT_PADDING * 2);
  const zoomPercent = Math.round(state.viewport.zoom * 100);

  const updateViewport = (viewport: Partial<ViewportState>): void => {
    onCommand({ type: 'update-viewport', viewport });
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

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !canStartPan(event.target)) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewport: state.viewport,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    updateViewport({
      x: drag.startViewport.x + event.clientX - drag.startClientX,
      y: drag.startViewport.y + event.clientY - drag.startClientY,
    });
  };

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  return (
    <section
      className={`mindmap-renderer${dragRef.current ? ' is-panning' : ''}`}
      aria-label="Editable mind map canvas"
    >
      <div className="mindmap-controls" aria-label="Canvas controls">
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
                onCommand={onCommand}
              />
            ))}
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
  onCommand,
}: {
  layoutNode: MindMapLayoutNode;
  selected: boolean;
  focused: boolean;
  onCommand(command: MindMapCommand): void;
}) {
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
      <button
        className="mindmap-node-main"
        type="button"
        aria-label={displayText}
        aria-pressed={selected}
        onClick={() => onCommand({ type: 'select-node', nodeId: layoutNode.id })}
        onFocus={() => onCommand({ type: 'focus-node', nodeId: layoutNode.id })}
      >
        <span className="mindmap-node-kicker">
          <span className="mindmap-node-depth">
            {layoutNode.isRoot ? 'Center topic' : `Level ${layoutNode.depth}`}
          </span>
          {layoutNode.childCount > 0 ? (
            <span className="mindmap-node-count">{childLabel}</span>
          ) : null}
        </span>
        <span className="mindmap-node-text">{displayText}</span>
      </button>

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

function getClosestVisibleNodeId(
  layout: MindMapLayoutResult,
  nodes: MindMapEditorState['document']['nodes'],
  selectedNodeId: NodeId,
): NodeId | null {
  const visible = new Set(layout.visibleNodeIds);
  let currentId: NodeId | null = selectedNodeId;

  while (currentId) {
    if (visible.has(currentId)) {
      return currentId;
    }

    currentId = nodes[currentId]?.parentId ?? null;
  }

  return layout.visibleNodeIds[0] ?? null;
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

function canStartPan(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest('button');
}
