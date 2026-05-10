import { useMemo } from 'react';

import { EditorShell } from './components/EditorShell';
import { createMindMapEditorState } from './domain/mindMap';

export default function App() {
  const editorState = useMemo(() => createMindMapEditorState(), []);

  return <EditorShell state={editorState} />;
}
