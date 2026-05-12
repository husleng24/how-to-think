import type { MindMapCommand, MindMapCommandResult, MindMapEditorState } from './domain/mindMap';
import type { LinkInteractionController } from '../markdown-compat';

import { MindMapCanvas } from './MindMapCanvas';

interface MindMapCanvasPaneProps {
  state: MindMapEditorState;
  onCommand(command: MindMapCommand): MindMapCommandResult | void;
  onUndo?(): MindMapCommandResult | void;
  onRedo?(): MindMapCommandResult | void;
  linkInteraction?: LinkInteractionController;
}

export function MindMapCanvasPane({
  state,
  onCommand,
  onUndo,
  onRedo,
  linkInteraction,
}: MindMapCanvasPaneProps) {
  return (
    <div className="mindmap-canvas-pane">
      <MindMapCanvas
        state={state}
        onCommand={onCommand}
        onUndo={onUndo}
        onRedo={onRedo}
        linkInteraction={linkInteraction}
      />
    </div>
  );
}
