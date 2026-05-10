import { useMemo } from 'react';

import { EditorShell } from './components/EditorShell';
import { createEmptyMindMapDocument } from './domain/mindMap';

export default function App() {
  const document = useMemo(() => createEmptyMindMapDocument(), []);

  return <EditorShell document={document} />;
}
