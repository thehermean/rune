// NoteEditor — the open note. Edit mode: Markdown textarea + formatting toolbar
// (lib/mdedit) + [[wiki-link]] autocomplete + image/file attach. Read mode:
// rendered markdown with tappable checkboxes, clickable [[wiki-links]] (open or
// auto-create) and #tags (filter the sidebar). A backlinks panel lists notes
// that link here; a pin toggle lives in the head.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNotesStore, type NotesStatus } from '../../store/notes';
import { renderMarkdown } from '../../lib/markdown';
import { apiUpload, type NoteMeta } from '../../lib/notes-api';
import { getCaretCoordinates, findOpenWikiLink } from '../../lib/caret';
import {
  wrapInline, toggleLinePrefix, numberList, insertLink, insertAt, toggleCheckboxLine,
  type EditState,
} from '../../lib/mdedit';

const STATUS_LABEL: Record<NotesStatus, string> = {
  idle: '', loading: '…', saving: 'Saving…', saved: 'Saved',
  conflict: 'Conflict — re-saved', error: 'Save error',
};

interface AC { bracketStart: number; items: NoteMeta[]; index: number; top: number; left: number; query: string }

export interface NoteEditorProps {
  onNotice?: (message: string, undo?: () => void) => void;
}

export function NoteEditor({ onNotice }: NoteEditorProps): JSX.Element | null {
  const currentId = useNotesStore((s) => s.currentId);
  const draft = useNotesStore((s) => s.draft);
  const status = useNotesStore((s) => s.status);
  const notes = useNotesStore((s) => s.notes);
  const setDraft = useNotesStore((s) => s.setDraft);
  const flush = useNotesStore((s) => s.flush);
  const removeNote = useNotesStore((s) => s.removeNote);
  const restore = useNotesStore((s) => s.restore);
  const moveTo = useNotesStore((s) => s.moveTo);
  const folders = useNotesStore((s) => s.folders);
  const openNote = useNotesStore((s) => s.open);
  const openByTitle = useNotesStore((s) => s.openByTitle);
  const setActiveTag = useNotesStore((s) => s.setActiveTag);
  const setPin = useNotesStore((s) => s.setPin);

  const [mode, setMode] = useState<'edit' | 'read'>('edit');
  const [ac, setAc] = useState<AC | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingSel = useRef<[number, number] | null>(null);

  const known = useMemo(() => new Set(notes.map((n) => n.title.toLowerCase())), [notes]);

  useEffect(() => () => void flush(), [currentId, flush]);
  useEffect(() => {
    if (pendingSel.current && taRef.current && mode === 'edit') {
      const [a, b] = pendingSel.current;
      pendingSel.current = null;
      taRef.current.focus();
      taRef.current.setSelectionRange(a, b);
    }
  });

  if (!currentId) return null;
  const meta = notes.find((n) => n.id === currentId);
  const folderList = folders();
  const title = meta?.title ?? '';
  const backlinks = notes.filter(
    (n) => n.id !== currentId && title && n.links.some((l) => l.toLowerCase() === title.toLowerCase()),
  );

  async function goBack(): Promise<void> {
    await flush();
    useNotesStore.setState({ currentId: null, draft: '', base: '' });
  }
  async function onDelete(): Promise<void> {
    const id = currentId;
    if (!id) return;
    const note = await removeNote(id);
    if (note) onNotice?.('Note deleted', () => void restore(note));
  }
  function applyEdit(fn: (s: EditState) => EditState): void {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? draft.length;
    const end = ta?.selectionEnd ?? draft.length;
    const r = fn({ text: draft, start, end });
    pendingSel.current = [r.start, r.end];
    setDraft(r.text);
  }
  async function uploadFiles(files: FileList | File[]): Promise<void> {
    const snippets: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const { url, name } = await apiUpload(f);
        snippets.push(`${/^image\//.test(f.type) ? '!' : ''}[${name}](${url})`);
      } catch { onNotice?.('Upload failed'); }
    }
    if (!snippets.length) return;
    const ta = taRef.current;
    const at = ta?.selectionStart ?? draft.length;
    const cur = useNotesStore.getState().draft;
    const block = (at > 0 && cur[at - 1] !== '\n' ? '\n' : '') + snippets.join('\n') + '\n';
    const r = insertAt({ text: cur, start: at, end: ta?.selectionEnd ?? at }, block);
    pendingSel.current = [r.start, r.end];
    setDraft(r.text);
  }
  function toggleCheck(target: HTMLElement): void {
    const li = target.closest('.rune-md-check') as HTMLElement | null;
    const line = li?.dataset.line;
    if (line == null) return;
    setDraft(toggleCheckboxLine(useNotesStore.getState().draft, Number(line)));
    void flush();
  }
  function onRenderClick(e: React.MouseEvent): void {
    const el = e.target as HTMLElement;
    if (el.closest('.rune-md-box')) { toggleCheck(el); return; }
    const wl = el.closest('.rune-wikilink') as HTMLElement | null;
    if (wl?.dataset.note) { void openByTitle(wl.dataset.note); return; }
    const tag = el.closest('.rune-tag') as HTMLElement | null;
    if (tag?.dataset.tag) setActiveTag(tag.dataset.tag);
  }

  // --- [[wiki-link]] autocomplete ---
  function refreshAc(): void {
    const ta = taRef.current;
    if (!ta) { setAc(null); return; }
    const open = findOpenWikiLink(ta.value, ta.selectionStart);
    if (!open) { setAc(null); return; }
    const q = open.query.toLowerCase();
    const items = notes.filter((n) => n.title.toLowerCase().includes(q)).slice(0, 8);
    const c = getCaretCoordinates(ta, open.bracketStart);
    setAc({ bracketStart: open.bracketStart, items, index: 0, query: open.query, top: ta.offsetTop + c.top + c.height, left: ta.offsetLeft + c.left });
  }
  function acceptTitle(t: string): void {
    const ta = taRef.current;
    if (!ta || !ac) return;
    const caret = ta.selectionStart;
    const v = ta.value;
    const insert = `[[${t}]]`;
    const nt = v.slice(0, ac.bracketStart) + insert + v.slice(caret);
    const pos = ac.bracketStart + insert.length;
    pendingSel.current = [pos, pos];
    setDraft(nt);
    setAc(null);
  }

  return (
    <section className="rune-notes-editor">
      <header className="rune-note-head">
        <button type="button" className="rune-chrome-btn rune-note-back" title="Back to list" onClick={() => void goBack()}>
          ‹ Notes
        </button>
        <select className="rune-note-folder-sel" value={meta?.folder ?? ''} aria-label="Note folder"
          onChange={(e) => void moveTo(currentId as string, e.target.value)}>
          <option value="">(No folder)</option>
          {folderList.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <button type="button" className={`rune-chrome-btn rune-note-pin${meta?.pinned ? ' is-on' : ''}`}
          title={meta?.pinned ? 'Unpin' : 'Pin to top'} aria-pressed={meta?.pinned}
          onClick={() => void setPin(currentId as string, !meta?.pinned)}>
          {meta?.pinned ? '📌' : '📍'}
        </button>
        <span className={`rune-note-status is-${status}`}>{STATUS_LABEL[status]}</span>
        <div className="rune-note-head-actions">
          <div className="rune-seg" role="tablist" aria-label="Editor mode">
            <button type="button" role="tab" aria-selected={mode === 'edit'}
              className={`rune-seg-btn${mode === 'edit' ? ' is-on' : ''}`} onClick={() => setMode('edit')}>Edit</button>
            <button type="button" role="tab" aria-selected={mode === 'read'}
              className={`rune-seg-btn${mode === 'read' ? ' is-on' : ''}`}
              onClick={() => { void flush(); setAc(null); setMode('read'); }}>Read</button>
          </div>
          <button type="button" className="rune-chrome-btn rune-note-del" title="Delete note" onClick={() => void onDelete()}>Delete</button>
        </div>
      </header>

      {mode === 'edit' && (
        <div className="rune-note-toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => wrapInline(s, '**'))}><b>B</b></button>
          <button type="button" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => wrapInline(s, '*'))}><i>I</i></button>
          <button type="button" title="Strikethrough" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => wrapInline(s, '~~'))}><s>S</s></button>
          <button type="button" title="Inline code" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => wrapInline(s, '`'))}>{'<>'}</button>
          <span className="rune-tb-sep" aria-hidden="true" />
          <button type="button" title="Heading 1" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => toggleLinePrefix(s, '# ', /^#{1,6}\s+/))}>H1</button>
          <button type="button" title="Heading 2" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => toggleLinePrefix(s, '## ', /^#{1,6}\s+/))}>H2</button>
          <span className="rune-tb-sep" aria-hidden="true" />
          <button type="button" title="Bulleted list" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => toggleLinePrefix(s, '- '))}>•</button>
          <button type="button" title="Numbered list" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit(numberList)}>1.</button>
          <button type="button" title="Checklist" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => toggleLinePrefix(s, '- [ ] '))}>☑</button>
          <button type="button" title="Quote" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => toggleLinePrefix(s, '> '))}>❝</button>
          <span className="rune-tb-sep" aria-hidden="true" />
          <button type="button" title="Link" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => insertLink(s))}>🔗</button>
          <button type="button" title="Wiki-link" onMouseDown={(e) => e.preventDefault()} onClick={() => applyEdit((s) => insertAt(s, '[[]]'))}>[[ ]]</button>
          <button type="button" title="Attach image or file" onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>📎</button>
          <input ref={fileRef} type="file" hidden multiple
            onChange={(e) => { if (e.target.files && e.target.files.length) void uploadFiles(e.target.files); e.target.value = ''; }} />
        </div>
      )}

      {mode === 'edit' ? (
        <div className="rune-note-editwrap">
          <textarea
            ref={taRef}
            className="rune-note-textarea"
            value={draft}
            spellCheck
            aria-label="Note markdown"
            placeholder="# Title on the first line — then write. Toolbar, [[links]], #tags, - [ ] todos."
            onChange={(e) => { setDraft(e.target.value); refreshAc(); }}
            onClick={refreshAc}
            onKeyUp={(e) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) refreshAc(); }}
            onBlur={() => { void flush(); setTimeout(() => setAc(null), 120); }}
            onKeyDown={(e) => {
              if (!ac) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setAc({ ...ac, index: Math.min(ac.index + 1, Math.max(ac.items.length - 1, 0)) }); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setAc({ ...ac, index: Math.max(ac.index - 1, 0) }); }
              else if (e.key === 'Enter' || e.key === 'Tab') {
                if (ac.items.length || ac.query.trim()) { e.preventDefault(); acceptTitle(ac.items[ac.index]?.title ?? ac.query.trim()); }
              } else if (e.key === 'Escape') { e.preventDefault(); setAc(null); }
            }}
            onPaste={(e) => { const f = Array.from(e.clipboardData.files); if (f.length) { e.preventDefault(); void uploadFiles(f); } }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { const f = Array.from(e.dataTransfer.files); if (f.length) { e.preventDefault(); void uploadFiles(f); } }}
          />
          {ac && (ac.items.length > 0 || ac.query.trim()) && (
            <ul className="rune-ac" style={{ top: ac.top, left: ac.left }} role="listbox">
              {ac.items.map((it, i) => (
                <li key={it.id} role="option" aria-selected={i === ac.index}
                  className={`rune-ac-item${i === ac.index ? ' is-on' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); acceptTitle(it.title); }}>
                  {it.title}
                </li>
              ))}
              {ac.query.trim() && !ac.items.some((it) => it.title.toLowerCase() === ac.query.trim().toLowerCase()) && (
                <li role="option" className={`rune-ac-item rune-ac-new${ac.items.length === 0 ? ' is-on' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); acceptTitle(ac.query.trim()); }}>
                  ＋ Link “{ac.query.trim()}” (creates on click)
                </li>
              )}
            </ul>
          )}
        </div>
      ) : (
        <div className="rune-note-render rune-md" onClick={onRenderClick}
          onKeyDown={(e) => { const b = (e.target as HTMLElement).closest('.rune-md-box'); if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleCheck(e.target as HTMLElement); } }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(draft, { known }) }} />
      )}

      {backlinks.length > 0 && (
        <div className="rune-note-backlinks">
          <div className="rune-note-backlinks-head">Linked from {backlinks.length}</div>
          {backlinks.map((n) => (
            <button key={n.id} type="button" className="rune-note-backlink" onClick={() => void openNote(n.id)}>
              {n.title}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
