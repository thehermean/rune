// DetailCard — the point-and-click inspector for one task (the `o` action).
//
// Anti-clutter holds: quiet rows of mute-ink labels, tokens only, progressive
// disclosure. Every control routes through a store editing action; the .rune
// text stays canonical. No field requires typing tokens or the Source view:
// state, priority, due, scheduled, recurrence, tags, contexts, dependencies,
// attachments, and comments are all editable by point-and-click.
//
// Pickers (DatePicker / RecurrencePicker / DependencyPicker) are stubs with
// locked prop signatures; the Pickers phase swaps their chrome without touching
// this card. The CommentGutter is mounted interactive (reply + resolve) with a
// quiet composer below it.

import { useRef, useState } from 'react';
import { useStore } from '../store/store';
import { useModalScope } from '../lib/modalScope';
import { useModalFocus } from '../lib/useModalFocus';
import {
  findById,
  tasks,
  titleOf,
  tagsOf,
  contextsOf,
  priorityOf,
  getKey,
  afterOf,
  attachmentsOf,
} from '@core';
import type { State, TaskNode } from '@core';
import { attachmentsFromTransfer } from '../lib/attach';
import { CommentGutter } from './CommentGutter';
import { DatePicker } from './DatePicker';
import { DependencyPicker } from './DependencyPicker';
import { RecurrencePicker } from './RecurrencePicker';

export interface DetailCardProps {
  id: string;
  onClose: () => void;
  /** Surface a quiet toast (e.g. an unparseable date typed into a picker). */
  onNotice?: (message: string) => void;
}

const STATE_OPTIONS: Array<{ state: State; label: string }> = [
  { state: 'open', label: 'Open' },
  { state: 'doing', label: 'Doing' },
  { state: 'done', label: 'Done' },
  { state: 'cancelled', label: 'Cancelled' },
  { state: 'deferred', label: 'Deferred' },
];

export function DetailCard({ id, onClose, onNotice }: DetailCardProps): JSX.Element {
  const doc = useStore((s) => s.doc);
  const rename = useStore((s) => s.rename);
  const setState = useStore((s) => s.setState);
  const setDue = useStore((s) => s.setDue);
  const setScheduled = useStore((s) => s.setScheduled);
  const setPriority = useStore((s) => s.setPriority);
  const setRecurrence = useStore((s) => s.setRecurrence);
  const toggleTag = useStore((s) => s.toggleTag);
  const toggleContext = useStore((s) => s.toggleContext);
  const setAfter = useStore((s) => s.setAfter);
  const addChild = useStore((s) => s.addChild);
  const remove = useStore((s) => s.remove);
  const addAttachment = useStore((s) => s.addAttachment);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const attachFile = useStore((s) => s.attachFile);
  const openAttachment = useStore((s) => s.openAttachment);
  const hasDir = useStore((s) => s.dirHandle !== null);
  const addComment = useStore((s) => s.addComment);
  const replyToComment = useStore((s) => s.replyToComment);
  const resolveComment = useStore((s) => s.resolveComment);
  const [dropping, setDropping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The card is a modal surface: own the keyboard while open (so app shortcuts
  // don't act on the list behind the backdrop) and trap + restore focus
  // (WCAG 2.4.3 / 2.1.2). The card is only mounted while open, so `true`.
  useModalScope(true);
  useModalFocus(true, panelRef);

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>): void {
    const files = e.target.files;
    if (files) {
      for (const f of Array.from(files)) void attachFile(id, f);
    }
    e.target.value = ''; // allow re-selecting the same file
  }

  const task = findById(doc, id);

  if (!task) {
    return (
      <div className="rune-detail-backdrop" onClick={onClose}>
        <div
          ref={panelRef}
          className="rune-detail"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
            }
          }}
        >
          <p className="rune-detail-hint">Item not found.</p>
        </div>
      </div>
    );
  }

  const title = titleOf(task);
  const prio = priorityOf(task);
  const tags = tagsOf(task);
  const contexts = contextsOf(task);
  const due = getKey(task, 'due') ?? '';
  const scheduled = getKey(task, 'scheduled') ?? getKey(task, 'start') ?? '';
  const recurFixed = getKey(task, 'recur');
  const recurRolling = getKey(task, 'recur!');
  const recurRule = recurRolling ?? recurFixed ?? '';
  const recurIsRolling = recurRolling !== undefined;
  const deps = afterOf(task);
  const attachments = attachmentsOf(task);

  // Autocomplete suggestions: every tag/context already present in the doc.
  const allTags = collectAll(doc.nodes, tagsOf);
  const allContexts = collectAll(doc.nodes, contextsOf);

  // Dependency candidates: every other task with an id + a title, picked by TITLE.
  const depCandidates = tasks(doc)
    .filter((t): t is TaskNode & { id: string } => !!t.id && t.id !== id)
    .map((t) => ({ id: t.id, title: titleOf(t) || t.id }));

  function handleDelete(): void {
    remove(id);
    onClose();
  }

  function handleAddChild(): void {
    addChild(id);
  }

  function onDragOver(e: React.DragEvent): void {
    const types = e.dataTransfer?.types;
    if (types && !types.includes('Files') && !types.includes('text/uri-list')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  }

  function onDrop(e: React.DragEvent): void {
    setDropping(false);
    // Real files -> copy their bytes (when a folder is open) via attachFile.
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      for (const f of Array.from(files)) void attachFile(id, f);
      return;
    }
    // Otherwise a dragged URL / uri-list -> a link attachment.
    const found = attachmentsFromTransfer(e.dataTransfer);
    if (found.length === 0) return;
    e.preventDefault();
    for (const a of found) addAttachment(id, a.label, a.target);
  }

  function onPaste(e: React.ClipboardEvent): void {
    // Only treat a paste as "add attachment" when it lands on the card chrome —
    // NEVER when the user is pasting into a field (the comment box, title, date,
    // tag/context, dependency search). Otherwise a pasted URL is hijacked into an
    // attachment instead of going into the input the user is typing in.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      for (const f of Array.from(files)) void attachFile(id, f);
      return;
    }
    const found = attachmentsFromTransfer(e.clipboardData);
    if (found.length === 0) return; // not an attach paste — let inputs handle it
    e.preventDefault();
    for (const a of found) addAttachment(id, a.label, a.target);
  }

  return (
    <div className="rune-detail-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className={`rune-detail${dropping ? ' is-dropping' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Task: ${title || 'Untitled'}`}
        onClick={(e) => e.stopPropagation()}
        // The card owns Esc (the global handler early-returns while a modal scope
        // is active, so it can no longer close the card for us).
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        onDragOver={onDragOver}
        onDragLeave={() => dropping && setDropping(false)}
        onDrop={onDrop}
        onPaste={onPaste}
      >
        <header className="rune-detail-head">
          <div className="rune-detail-head-main">
            <TitleField value={title} onCommit={(v) => rename(id, v)} />
            <p className="rune-detail-id">^{task.id}</p>
          </div>
          <button
            type="button"
            className="rune-detail-close"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="rune-detail-fields">
          <StateField state={task.state} onSet={(s) => setState(id, s)} />

          <PriorityField level={prio} onSet={(lvl) => setPriority(id, lvl)} />

          <DatePicker
            label="Due"
            value={due}
            onCommit={(v) => setDue(id, v)}
            onInvalid={() => onNotice?.('Couldn’t read that date')}
          />

          <DatePicker
            label="Scheduled"
            value={scheduled}
            onCommit={(v) => setScheduled(id, v)}
            onInvalid={() => onNotice?.('Couldn’t read that date')}
          />

          <RecurrencePicker
            rule={recurRule}
            rolling={recurIsRolling}
            onCommit={(rule, rolling) => setRecurrence(id, rule, rolling)}
            onInvalid={() => onNotice?.('Couldn’t read that repeat rule')}
          />

          <TokenField
            label="Tags"
            sigil="#"
            tokens={tags}
            suggestions={allTags}
            onToggle={(t) => toggleTag(id, t)}
          />

          <TokenField
            label="Contexts"
            sigil="@"
            tokens={contexts}
            suggestions={allContexts}
            onToggle={(c) => toggleContext(id, c)}
          />

          <DependencyPicker
            value={deps}
            options={depCandidates}
            onCommit={(ids) => setAfter(id, ids)}
          />
        </div>

        <AttachmentsField
          attachments={attachments}
          hasDir={hasDir}
          onOpen={(target) => void openAttachment(target)}
          onRemove={(target) => removeAttachment(id, target)}
        />

        <div className="rune-detail-actions">
          <button type="button" className="rune-chrome-btn" onClick={handleAddChild}>
            Add sub-task
          </button>
          <button
            type="button"
            className="rune-chrome-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            Attach file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={onPickFiles}
          />
          <button
            type="button"
            className="rune-chrome-btn rune-detail-delete"
            onClick={handleDelete}
          >
            Delete
          </button>
        </div>

        <section className="rune-detail-comments">
          <span className="rune-detail-section-label">Comments</span>
          <CommentGutter
            doc={doc}
            itemId={id}
            onReply={(parentCommentId, body) => replyToComment(id, parentCommentId, body)}
            onResolve={(commentId, resolved) => resolveComment(commentId, resolved)}
          />
          <CommentComposer onSubmit={(body) => addComment(id, body)} />
        </section>
      </div>
    </div>
  );
}

/** Collect every distinct value produced by `pick` across all task nodes, sorted. */
function collectAll(
  nodes: ReadonlyArray<{ type: string }>,
  pick: (t: TaskNode) => string[],
): string[] {
  const set = new Set<string>();
  for (const n of nodes) {
    if (n.type === 'task') for (const v of pick(n as TaskNode)) if (v) set.add(v);
  }
  return [...set].sort();
}

/** Editable title: a quiet CONTROLLED input that reads like the heading. The
 *  draft re-seeds whenever the STORED value changes from outside (undo, a
 *  palette rename) so a stale draft can never be committed over a fresher title.
 *  (Retargeting to another task remounts the whole card — App keys it by id.) */
function TitleField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const lastValue = useRef(value);
  if (value !== lastValue.current) {
    // External change: drop the stale draft (render-phase reset, React-sanctioned).
    lastValue.current = value;
    setDraft(value);
  }
  return (
    <input
      className="rune-detail-title rune-detail-title-input"
      value={draft}
      spellCheck={false}
      placeholder="Untitled task"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const trimmed = draft.trim();
        if (trimmed && trimmed !== value) onCommit(trimmed);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** State: five quiet options (Open / Doing / Done / Cancelled / Deferred). */
function StateField({
  state,
  onSet,
}: {
  state: State;
  onSet: (s: State) => void;
}): JSX.Element {
  return (
    <div className="rune-detail-field">
      <span className="rune-detail-label">State</span>
      <span className="rune-detail-state">
        {STATE_OPTIONS.map((o) => (
          <button
            key={o.state}
            type="button"
            className={`rune-detail-state-opt${state === o.state ? ' is-active' : ''}`}
            onClick={() => onSet(o.state)}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** Priority: four quiet toggles (none / ! / !! / !!!). */
function PriorityField({
  level,
  onSet,
}: {
  level: number;
  onSet: (level: number) => void;
}): JSX.Element {
  const options: Array<{ lvl: number; label: string }> = [
    { lvl: 0, label: 'None' },
    { lvl: 1, label: '!' },
    { lvl: 2, label: '!!' },
    { lvl: 3, label: '!!!' },
  ];
  return (
    <div className="rune-detail-field">
      <span className="rune-detail-label">Priority</span>
      <span className="rune-detail-prio">
        {options.map((o) => (
          <button
            key={o.lvl}
            type="button"
            className={`rune-detail-prio-opt${level === o.lvl ? ' is-active' : ''}`}
            onClick={() => onSet(o.lvl)}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** A tag/context field: existing tokens as quiet removable text + an add input
 *  with a <datalist> of suggestions drawn from everything already in the doc. */
function TokenField({
  label,
  sigil,
  tokens,
  suggestions,
  onToggle,
}: {
  label: string;
  sigil: '#' | '@';
  tokens: string[];
  suggestions: string[];
  onToggle: (token: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const listId = `rune-suggest-${label.toLowerCase()}`;
  const stripRe = sigil === '#' ? /^#/ : /^@/;

  function add(): void {
    const clean = draft.replace(stripRe, '').trim();
    if (clean) onToggle(clean);
    setDraft('');
  }

  // Suggest only tokens not already on this task.
  const fresh = suggestions.filter((s) => !tokens.includes(s));

  return (
    <div className="rune-detail-field">
      <span className="rune-detail-label">{label}</span>
      <span className="rune-detail-tags">
        {tokens.map((t) => (
          <button
            key={t}
            type="button"
            className="rune-detail-tag"
            title={`Remove ${sigil}${t}`}
            onClick={() => onToggle(t)}
          >
            {sigil}
            {t} ✕
          </button>
        ))}
        <input
          className="rune-detail-input rune-detail-tag-input"
          value={draft}
          placeholder={`add ${label.toLowerCase().replace(/s$/, '')}`}
          spellCheck={false}
          list={fresh.length > 0 ? listId : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        {fresh.length > 0 && (
          <datalist id={listId}>
            {fresh.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </span>
    </div>
  );
}

/** Attachments: quiet mute-ink rows (NOT chips). Each row opens (http(s) target
 *  via window.open; a relative `attachments/…` ref shows a calm location hint)
 *  and can be removed. The section renders nothing when there are no attachments;
 *  drop/paste a file or URL onto the card to add one. */
function AttachmentsField({
  attachments,
  hasDir,
  onOpen,
  onRemove,
}: {
  attachments: Array<{ label: string; target: string }>;
  hasDir: boolean;
  onOpen: (target: string) => void;
  onRemove: (target: string) => void;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div className="rune-detail-attachments">
      <span className="rune-detail-label">Attachments</span>
      <ul className="rune-attach-list">
        {attachments.map((a) => {
          const isWeb = /^(https?:|mailto:)/i.test(a.target);
          const openable = isWeb || hasDir; // a stored file (folder open) opens too
          return (
            <li key={a.target} className="rune-attach-row">
              {openable ? (
                <button
                  type="button"
                  className="rune-attach-open"
                  title={a.target}
                  onClick={() => onOpen(a.target)}
                >
                  {a.label}
                </button>
              ) : (
                <span
                  className="rune-attach-rel"
                  title={`Lives at ${a.target}, next to the .rune file`}
                >
                  {a.label}
                </span>
              )}
              {!isWeb && !hasDir && <span className="rune-attach-hint">in attachments/</span>}
              <button
                type="button"
                className="rune-attach-remove"
                aria-label="Remove attachment"
                title="Remove"
                onClick={() => onRemove(a.target)}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A quiet "Add a comment…" composer below the gutter. Cmd/Ctrl+Enter submits. */
function CommentComposer({ onSubmit }: { onSubmit: (body: string) => void }): JSX.Element {
  const [body, setBody] = useState('');

  function submit(): void {
    const trimmed = body.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setBody('');
  }

  return (
    <div className="rune-comment-composer">
      <textarea
        className="rune-comment-input"
        value={body}
        placeholder="Add a comment…"
        rows={2}
        spellCheck={false}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="rune-comment-composer-actions">
        <button
          type="button"
          className="rune-comment-send"
          disabled={!body.trim()}
          onClick={submit}
        >
          Comment
        </button>
      </div>
    </div>
  );
}
