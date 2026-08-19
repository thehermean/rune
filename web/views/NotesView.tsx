// NotesView — the Notes tab: a sidebar (folders + note list) beside the editor,
// or the knowledge-graph when graphOpen. A second content type over /api/notes;
// NOT a lens over the single .rune doc. On narrow screens the sidebar and the
// editor/graph swap (list when nothing is open, otherwise the open surface).

import { useEffect } from 'react';
import { useNotesStore } from '../store/notes';
import { NotesSidebar } from '../components/notes/NotesSidebar';
import { NoteEditor } from '../components/notes/NoteEditor';
import { GraphView } from '../components/notes/GraphView';

export interface NotesViewProps {
  onNotice?: (message: string, undo?: () => void) => void;
}

export function NotesView({ onNotice }: NotesViewProps): JSX.Element {
  const loaded = useNotesStore((s) => s.loaded);
  const loadManifest = useNotesStore((s) => s.loadManifest);
  const currentId = useNotesStore((s) => s.currentId);
  const graphOpen = useNotesStore((s) => s.graphOpen);

  useEffect(() => {
    if (!loaded) void loadManifest();
  }, [loaded, loadManifest]);

  return (
    <div className={`rune-notes${currentId || graphOpen ? ' has-open' : ''}`}>
      <NotesSidebar />
      {graphOpen ? (
        <GraphView />
      ) : currentId ? (
        <NoteEditor onNotice={onNotice} />
      ) : (
        <div className="rune-notes-editor rune-notes-empty">
          <p className="rune-empty-line">No note selected.</p>
          <p className="rune-empty-hint">Pick one from the list, or press New note.</p>
        </div>
      )}
    </div>
  );
}
