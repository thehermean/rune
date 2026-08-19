// CommandPalette — the Cmd+K power surface (BRIEF §3/§5).
//
// ONE fuzzy input + a result list, centered in an elevated panel. It is the
// single power surface across all views: add a task, jump to a task, edit the
// selected task (state, priority, due, tags, dependency, sub-tasks, delete),
// reorder it, undo/redo, clear completed, open/save the file, toggle the theme.
// Every command is backed by an EXISTING store action (CONTRACTS §2) — this file
// does not invent store actions and never touches `setText`.
//
// A handful of edit commands need a value (a due date, a priority, a tag, a
// dependency, a sub-task title). Rather than clutter the surface with widgets,
// those commands switch the ONE input into a small inline "prompt" mode: the
// list collapses to a hint, you type the value, Enter applies it via the store,
// Esc backs out to the command list. Still one input, still keyboard-only.
//
// Anti-clutter (CONTRACTS §3): tokens only, quiet mute-ink text, a 1px hairline
// between rows, a right-aligned caption-token keycap hint per row, focus trap,
// closes on Esc / backdrop / onClose. Recency ordering is kept in local state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { State, TaskNode } from '@core';
import { tasks, titleOf, priorityOf, tagsOf, contextsOf, afterOf, getKey } from '@core';
import { useStore } from '../store/store';
import { useModalScope } from '../lib/modalScope';

export type PaletteView = 'document' | 'today' | 'sequence' | 'source' | 'board';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Switch the active view (Document / Today / Sequence / Source). */
  onGoToView?: (view: PaletteView) => void;
  /** Open the keyboard-shortcuts help sheet. */
  onOpenHelp?: () => void;
  /** Surface a quiet near-miss toast (e.g. "Couldn't read that date"). */
  onNotice?: (message: string) => void;
}

interface Command {
  /** Stable id used for recency tracking. */
  id: string;
  /** The visible label. */
  label: string;
  /** Extra words folded into the fuzzy haystack (e.g. a task title). */
  hint?: string;
  /** Right-aligned keycap caption (e.g. "done", "↑", "⌘S"). */
  keycap?: string;
  /** Runs the command. Returning a Prompt switches the input into prompt mode
   *  instead of closing the palette. */
  run: () => Prompt | void;
}

/** An inline value-entry step hosted in the same input (see file header). */
interface Prompt {
  /** Stable id (for the input key + recency, if ever needed). */
  id: string;
  /** Placeholder / instruction shown in the input while entering the value. */
  placeholder: string;
  /** Optional initial value to pre-fill (e.g. the current title for rename). */
  initial?: string;
  /** Apply the typed value. Return false to keep the prompt open (invalid). */
  apply: (value: string) => void;
}

const STATE_VERBS: Array<{ verb: string; state: State }> = [
  { verb: 'done', state: 'done' },
  { verb: 'doing', state: 'doing' },
  { verb: 'open', state: 'open' },
  { verb: 'cancelled', state: 'cancelled' },
  { verb: 'deferred', state: 'deferred' },
];

export function CommandPalette({
  open,
  onClose,
  onGoToView,
  onOpenHelp,
  onNotice,
}: CommandPaletteProps): JSX.Element | null {
  const doc = useStore((s) => s.doc);
  const selectedId = useStore((s) => s.selectedId);
  const selectedIds = useStore((s) => s.selectedIds);
  const theme = useStore((s) => s.theme);
  const hideDone = useStore((s) => s.hideDone);
  const setHideDone = useStore((s) => s.setHideDone);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const addFromInput = useStore((s) => s.addFromInput);
  const select = useStore((s) => s.select);
  const setState = useStore((s) => s.setState);
  const move = useStore((s) => s.move);
  const indent = useStore((s) => s.indent);
  const outdent = useStore((s) => s.outdent);
  const remove = useStore((s) => s.remove);
  const removeMany = useStore((s) => s.removeMany);
  const setPriority = useStore((s) => s.setPriority);
  const setPriorityMany = useStore((s) => s.setPriorityMany);
  const setStateMany = useStore((s) => s.setStateMany);
  const addTagMany = useStore((s) => s.addTagMany);
  const indentMany = useStore((s) => s.indentMany);
  const outdentMany = useStore((s) => s.outdentMany);
  const setDue = useStore((s) => s.setDue);
  const setDueMany = useStore((s) => s.setDueMany);
  const toggleTag = useStore((s) => s.toggleTag);
  const setAfter = useStore((s) => s.setAfter);
  const rename = useStore((s) => s.rename);
  const addChild = useStore((s) => s.addChild);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const openFile = useStore((s) => s.openFile);
  const save = useStore((s) => s.save);
  const setTheme = useStore((s) => s.setTheme);

  // Own the keyboard while the palette is open (the global handler early-returns
  // on any active modal scope), so keys never act on the list behind the panel.
  useModalScope(open);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Recency: most-recently-run command ids, newest first. Local state only.
  const [recent, setRecent] = useState<string[]>([]);
  // When set, the input is an inline value-entry step rather than the command
  // list (see file header). Null = normal command mode.
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset the query each time the palette opens, and focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setPrompt(null);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Entering a prompt pre-fills its initial value and re-focuses the input.
  const enterPrompt = useCallback((p: Prompt) => {
    setPrompt(p);
    setQuery(p.initial ?? '');
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const runCommand = useCallback(
    (cmd: Command) => {
      const next = cmd.run();
      if (next) {
        // The command asked for a value: switch into prompt mode, stay open.
        setRecent((r) => [cmd.id, ...r.filter((x) => x !== cmd.id)].slice(0, 24));
        enterPrompt(next);
        return;
      }
      setRecent((r) => [cmd.id, ...r.filter((x) => x !== cmd.id)].slice(0, 24));
    },
    [enterPrompt],
  );

  // The selected task (if any), used to label and gate selection-scoped actions.
  const selected = useMemo<TaskNode | null>(() => {
    if (!selectedId) return null;
    return tasks(doc).find((t) => t.id === selectedId) ?? null;
  }, [doc, selectedId]);

  const trimmed = query.trim();

  // Tasks that are done/cancelled — for the "Clear completed" command.
  const completedCount = useMemo(
    () => tasks(doc).filter((t) => t.state === 'done' || t.state === 'cancelled').length,
    [doc],
  );

  // Build the full command set. Selection-scoped commands only appear when a
  // task is selected; "Add task" only when there is query text.
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];

    if (trimmed) {
      cmds.push({
        id: 'add',
        label: `Add task: ${trimmed}`,
        keycap: '↵',
        run: () => {
          addFromInput(trimmed);
          onClose();
        },
      });
    }

    // Multi-selection: the verbs operate over the whole set (each is ONE commit,
    // one undo step). The single-selection commands are replaced, not duplicated.
    if (selectedIds.length > 1) {
      const ids = selectedIds;
      const n = ids.length;

      cmds.push({
        id: 'bulk-done',
        label: `Mark ${n} selected done`,
        hint: 'done complete finish selected bulk',
        keycap: STATE_KEYCAP.done,
        run: () => {
          setStateMany(ids, 'done');
          onClose();
        },
      });
      cmds.push({
        id: 'bulk-open',
        label: `Mark ${n} selected open`,
        hint: 'open reopen undone selected bulk',
        keycap: STATE_KEYCAP.open,
        run: () => {
          setStateMany(ids, 'open');
          onClose();
        },
      });

      cmds.push({
        id: 'bulk-delete',
        label: `Delete ${n} selected`,
        hint: 'remove delete trash selected bulk',
        keycap: '⌫',
        run: () => {
          removeMany(ids); // one commit — a single ⌘Z brings all back
          onClose();
        },
      });

      for (const level of [1, 2, 3, 0]) {
        cmds.push({
          id: `bulk-priority-${level}`,
          label: level === 0
            ? `Clear priority on ${n} selected`
            : `Set priority ${'!'.repeat(level)} on ${n} selected`,
          hint: `priority p${level} ${'!'.repeat(Math.max(level, 0))} selected bulk`,
          keycap: level === 0 ? '·' : '!'.repeat(level),
          run: () => {
            setPriorityMany(ids, level);
            onClose();
          },
        });
      }

      cmds.push({
        id: 'bulk-tag',
        label: `Add tag to ${n} selected…`,
        hint: 'tag label add selected bulk',
        keycap: '#',
        run: () => ({
          id: 'prompt-bulk-tag',
          placeholder: 'Tag to add (no #)…',
          apply: (v) => {
            const t = v.trim().replace(/^#/, '');
            if (t) addTagMany(ids, t);
            onClose();
          },
        }),
      });

      cmds.push({
        id: 'bulk-due',
        label: `Set due on ${n} selected…`,
        hint: 'due date deadline when selected bulk',
        keycap: 'd',
        run: () => ({
          id: 'prompt-bulk-due',
          placeholder: 'Due date (friday, 2026-07-20, empty clears)…',
          apply: (v) => {
            if (!setDueMany(ids, v.trim())) onNotice?.('Couldn’t read that date');
            onClose();
          },
        }),
      });
      cmds.push({
        id: 'bulk-indent',
        label: `Indent ${n} selected`,
        hint: 'indent nest demote selected bulk tab',
        keycap: 'Tab',
        run: () => {
          indentMany(ids);
          onClose();
        },
      });
      cmds.push({
        id: 'bulk-outdent',
        label: `Outdent ${n} selected`,
        hint: 'outdent promote unnest selected bulk shift tab',
        keycap: '⇧Tab',
        run: () => {
          outdentMany(ids);
          onClose();
        },
      });
    } else if (selected && selected.id) {
      const sid = selected.id;
      const title = titleOf(selected) || '(untitled)';
      const short = truncate(title);

      // --- state ---
      for (const { verb, state } of STATE_VERBS) {
        if (selected.state === state) continue;
        cmds.push({
          id: `state-${state}`,
          label: `Mark "${short}" ${verb}`,
          hint: verb,
          keycap: STATE_KEYCAP[state],
          run: () => {
            setState(sid, state);
            onClose();
          },
        });
      }

      // --- edit: rename (the closest in-palette "edit task") ---
      cmds.push({
        id: 'edit-title',
        label: `Edit "${short}"…`,
        hint: 'rename title edit',
        keycap: 'e',
        run: () => ({
          id: 'prompt-rename',
          placeholder: 'New title…',
          initial: title,
          apply: (v) => {
            const t = v.trim();
            if (t) rename(sid, t);
            onClose();
          },
        }),
      });

      // --- delete ---
      cmds.push({
        id: 'delete',
        label: `Delete "${short}"`,
        hint: 'remove delete trash',
        keycap: '⌫',
        run: () => {
          remove(sid);
          onClose();
        },
      });

      // --- priority ---
      const curPri = priorityOf(selected);
      for (const level of [1, 2, 3, 0]) {
        if (level === curPri) continue;
        cmds.push({
          id: `priority-${level}`,
          label: level === 0
            ? `Clear priority on "${short}"`
            : `Set priority ${'!'.repeat(level)} on "${short}"`,
          hint: `priority p${level} ${'!'.repeat(Math.max(level, 0))}`,
          keycap: level === 0 ? '·' : '!'.repeat(level),
          run: () => {
            setPriority(sid, level);
            onClose();
          },
        });
      }

      // --- due date (inline value entry) ---
      const curDue = getKey(selected, 'due');
      cmds.push({
        id: 'due-set',
        label: `Set due date on "${short}"…`,
        hint: 'due date schedule when',
        keycap: '📅',
        run: () => ({
          id: 'prompt-due',
          placeholder: 'Due date (e.g. "fri", "jul 10", 2026-07-10)…',
          initial: curDue ?? '',
          apply: (v) => {
            // setDue returns false on an unparseable date (it no-ops) — surface
            // the same quiet near-miss the pickers show instead of silence.
            if (!setDue(sid, v.trim())) onNotice?.('Couldn’t read that date');
            onClose();
          },
        }),
      });
      if (curDue) {
        cmds.push({
          id: 'due-clear',
          label: `Clear due date on "${short}"`,
          hint: 'due date clear remove',
          run: () => {
            setDue(sid, '');
            onClose();
          },
        });
      }

      // --- tag (inline value entry) ---
      cmds.push({
        id: 'tag-toggle',
        label: `Toggle tag on "${short}"…`,
        hint: `tag label ${tagsOf(selected).map((x) => '#' + x).join(' ')}`,
        keycap: '#',
        run: () => ({
          id: 'prompt-tag',
          placeholder: 'Tag to add/remove (no #)…',
          apply: (v) => {
            const t = v.trim().replace(/^#/, '');
            if (t) toggleTag(sid, t);
            onClose();
          },
        }),
      });

      // --- dependency (after:) ---
      const curAfter = afterOf(selected);
      cmds.push({
        id: 'after-set',
        label: `Set dependency (after:) on "${short}"…`,
        hint: 'dependency after blocks depends needs',
        keycap: '⇢',
        run: () => ({
          id: 'prompt-after',
          placeholder: 'Depends on id(s), comma-separated (empty clears)…',
          initial: curAfter.join(','),
          apply: (v) => {
            const deps = v
              .split(',')
              .map((s) => s.trim().replace(/^\^/, ''))
              .filter(Boolean);
            setAfter(sid, deps);
            onClose();
          },
        }),
      });
      if (curAfter.length > 0) {
        cmds.push({
          id: 'after-clear',
          label: `Clear dependency on "${short}"`,
          hint: 'dependency after clear remove',
          run: () => {
            setAfter(sid, []);
            onClose();
          },
        });
      }

      // --- add sub-task (inline value entry) ---
      cmds.push({
        id: 'add-child',
        label: `Add sub-task under "${short}"…`,
        hint: 'subtask child add under',
        keycap: '↳',
        run: () => ({
          id: 'prompt-child',
          placeholder: 'Sub-task (empty adds a blank one)…',
          apply: (v) => {
            const childId = addChild(sid, v.trim());
            if (childId) select(childId);
            onClose();
          },
        }),
      });

      // --- reorder ---
      cmds.push({
        id: 'move-up',
        label: `Move "${short}" up`,
        hint: 'move up',
        keycap: '↑',
        run: () => {
          move(sid, 'up');
          onClose();
        },
      });
      cmds.push({
        id: 'move-down',
        label: `Move "${short}" down`,
        hint: 'move down',
        keycap: '↓',
        run: () => {
          move(sid, 'down');
          onClose();
        },
      });

      // --- indent / outdent ---
      cmds.push({
        id: 'indent',
        label: `Indent "${short}"`,
        hint: 'indent nest demote sub-task tab',
        keycap: 'Tab',
        run: () => {
          indent(sid);
          onClose();
        },
      });
      cmds.push({
        id: 'outdent',
        label: `Outdent "${short}"`,
        hint: 'outdent promote unnest shift tab',
        keycap: '⇧Tab',
        run: () => {
          outdent(sid);
          onClose();
        },
      });
    }

    // Jump to any task by fuzzy title — tags and contexts are in the haystack
    // too, so "jump #finance" or "@alice" finds the row. Running it selects AND
    // scrolls the row to the center of the viewport.
    for (const t of tasks(doc)) {
      if (!t.id) continue;
      if (t.id === selectedId) continue;
      const title = titleOf(t) || '(untitled)';
      const tokens = [
        ...tagsOf(t).map((x) => `#${x}`),
        ...contextsOf(t).map((x) => `@${x}`),
      ].join(' ');
      cmds.push({
        id: `jump-${t.id}`,
        label: `Jump to: ${title}`,
        hint: `${t.id} ${tokens}`,
        keycap: '→',
        run: () => {
          select(t.id);
          scrollRowIntoView(t.id!);
          onClose();
        },
      });
    }

    // --- history ---
    if (canUndo) {
      cmds.push({
        id: 'undo',
        label: 'Undo',
        hint: 'undo revert back history',
        keycap: '⌘Z',
        run: () => {
          undo();
          onClose();
        },
      });
    }
    if (canRedo) {
      cmds.push({
        id: 'redo',
        label: 'Redo',
        hint: 'redo forward history',
        keycap: '⇧⌘Z',
        run: () => {
          redo();
          onClose();
        },
      });
    }

    // --- bulk ---
    if (completedCount > 0) {
      cmds.push({
        id: 'clear-completed',
        label: `Clear completed (${completedCount})`,
        hint: 'clear completed done cancelled remove finished',
        run: () => {
          // Remove every done/cancelled task in ONE undoable commit (removeMany),
          // not a loop of remove() calls that each push a separate undo step.
          const ids = tasks(useStore.getState().doc)
            .filter((t) => (t.state === 'done' || t.state === 'cancelled') && t.id)
            .map((t) => t.id as string);
          removeMany(ids);
          onClose();
        },
      });
    }

    cmds.push({
      id: 'open-file',
      label: 'Open .rune…',
      hint: 'file',
      keycap: '⌘O',
      run: () => {
        void openFile();
        onClose();
      },
    });
    cmds.push({
      id: 'save-file',
      label: 'Save',
      hint: 'file write export',
      keycap: '⌘S',
      run: () => {
        void save();
        onClose();
      },
    });
    cmds.push({
      id: 'toggle-theme',
      label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
      hint: 'theme appearance dark light',
      run: () => {
        setTheme(theme === 'dark' ? 'light' : 'dark');
        onClose();
      },
    });

    // --- navigate views ---
    if (onGoToView) {
      const views: Array<[PaletteView, string]> = [
        ['document', 'Document'],
        ['today', 'Today'],
        ['sequence', 'Sequence'],
        ['source', 'Source'],
        ['board', 'Board'],
      ];
      for (const [name, label] of views) {
        cmds.push({
          id: `view-${name}`,
          label: `Go to ${label}`,
          hint: `view go to switch ${label}`,
          run: () => {
            onGoToView(name);
            onClose();
          },
        });
      }
    }

    // --- hide / show completed ---
    cmds.push({
      id: 'toggle-hidedone',
      label: hideDone ? 'Show completed tasks' : 'Hide completed tasks',
      hint: 'hide show done completed toggle',
      run: () => {
        setHideDone(!hideDone);
        onClose();
      },
    });

    // --- keyboard shortcuts help ---
    if (onOpenHelp) {
      cmds.push({
        id: 'help',
        label: 'Keyboard shortcuts',
        hint: 'help shortcuts keys grammar cheatsheet',
        keycap: '?',
        run: () => {
          onOpenHelp();
          onClose();
        },
      });
    }

    return cmds;
  }, [
    trimmed, selected, selectedId, selectedIds, doc, theme, hideDone, canUndo, canRedo,
    completedCount, addFromInput, setState, setStateMany, move, indent, outdent,
    indentMany, outdentMany, remove, removeMany, setPriority, setPriorityMany,
    addTagMany, setDueMany, setDue, toggleTag, setAfter, rename, addChild, undo, redo, select,
    openFile, save, setTheme, setHideDone, onGoToView, onOpenHelp, onNotice, onClose,
  ]);

  // Filter + rank. With no query, recency wins (then original order). With a
  // query, fuzzy score wins; the "Add task" row is always first.
  const results = useMemo<Command[]>(() => {
    if (!trimmed) {
      const recencyRank = (id: string): number => {
        const i = recent.indexOf(id);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      return [...commands].sort((a, b) => recencyRank(a.id) - recencyRank(b.id));
    }

    const scored: Array<{ cmd: Command; score: number }> = [];
    for (const cmd of commands) {
      if (cmd.id === 'add') {
        scored.push({ cmd, score: Number.POSITIVE_INFINITY });
        continue;
      }
      const hay = `${cmd.label} ${cmd.hint ?? ''}`;
      const score = fuzzyScore(hay, trimmed);
      if (score === null) continue;
      scored.push({ cmd, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.cmd);
  }, [commands, trimmed, recent]);

  // Keep the active index in range as the result set changes.
  useEffect(() => {
    setActive((a) => clamp(a, 0, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Scroll the active row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, results.length]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent): void {
    // ⌘K toggles the palette closed again. The App's global handler early-returns
    // while any modal scope is active, so the palette handles the toggle itself.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // In prompt mode, Esc backs out to the command list rather than closing.
      if (prompt) {
        setPrompt(null);
        setQuery('');
        setActive(0);
        return;
      }
      onClose();
      return;
    }
    if (prompt) {
      // Prompt mode: the input is a single free-text value. Enter applies it;
      // there is no list to navigate.
      if (e.key === 'Enter') {
        e.preventDefault();
        prompt.apply(query);
        return;
      }
      if (e.key === 'Tab') e.preventDefault(); // keep focus trapped
      return;
    }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => clamp(a + 1, 0, Math.max(0, results.length - 1)));
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => clamp(a - 1, 0, Math.max(0, results.length - 1)));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = results[active];
      if (cmd) runCommand(cmd);
      return;
    }
    if (e.key === 'Tab') {
      // Trap focus: the input is the only focusable control, so swallow Tab.
      e.preventDefault();
    }
  }

  return (
    <div
      className="rune-palette-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        className="rune-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={PANEL_STYLE}
      >
        <input
          ref={inputRef}
          type="text"
          className="rune-quickadd-input"
          value={query}
          // "N selected" is the ONLY multi-select indicator anywhere (no
          // checkboxes, no toolbar) — quiet, and only while the palette is open.
          placeholder={
            prompt
              ? prompt.placeholder
              : selectedIds.length > 1
                ? `${selectedIds.length} selected`
                : 'Type a command or search…'
          }
          spellCheck={false}
          autoComplete="off"
          role={prompt ? 'textbox' : 'combobox'}
          aria-expanded={prompt ? undefined : true}
          aria-controls={prompt ? undefined : 'rune-palette-list'}
          aria-activedescendant={
            prompt ? undefined : results[active] ? `cmd-${results[active].id}` : undefined
          }
          aria-label={prompt ? prompt.placeholder : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!prompt) setActive(0);
          }}
          style={INPUT_STYLE}
        />
        {prompt ? (
          <div className="rune-palette-hint" style={PROMPT_HINT_STYLE}>
            <span style={LABEL_STYLE}>Enter to apply · Esc to go back</span>
            <span style={KEYCAP_STYLE}>↵</span>
          </div>
        ) : (
          <div
            ref={listRef}
            id="rune-palette-list"
            role="listbox"
            aria-label="Commands"
            style={LIST_STYLE}
          >
            {results.length === 0 ? (
              <div className="rune-palette-hint" style={{ margin: 0 }}>
                No matching commands.
              </div>
            ) : (
              results.map((cmd, i) => (
                <div
                  key={cmd.id}
                  id={`cmd-${cmd.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => runCommand(cmd)}
                  style={rowStyle(i === active, i > 0)}
                >
                  <span style={LABEL_STYLE}>{cmd.label}</span>
                  {cmd.keycap && <span style={KEYCAP_STYLE}>{cmd.keycap}</span>}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const STATE_KEYCAP: Record<State, string> = {
  open: '○',
  done: '✓',
  doing: '/',
  cancelled: '✕',
  deferred: '»',
};

// --- styling (tokens only; the panel/backdrop classes come from app.css) -----

const PANEL_STYLE: CSSProperties = {
  padding: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

const INPUT_STYLE: CSSProperties = {
  width: '100%',
  border: 'none',
  borderBottom: '1px solid var(--hairline)',
  background: 'transparent',
  padding: 'var(--space-4) var(--space-5)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--size-row)',
  color: 'var(--ink)',
  outline: 'none',
};

const LIST_STYLE: CSSProperties = {
  maxHeight: '46vh',
  overflowY: 'auto',
  padding: 'var(--space-2) 0',
};

const PROMPT_HINT_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-4)',
  padding: 'var(--row-pad-y) var(--space-5)',
  margin: 0,
};

const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--size-row)',
  color: 'var(--body)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const KEYCAP_STYLE: CSSProperties = {
  fontFamily: 'var(--font-chrome)',
  fontSize: 'var(--size-caption)',
  fontWeight: 'var(--weight-caption)' as CSSProperties['fontWeight'],
  color: 'var(--faint)',
  marginLeft: 'var(--space-4)',
  flex: '0 0 auto',
};

function rowStyle(isActive: boolean, withHairline: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-4)',
    padding: 'var(--row-pad-y) var(--space-5)',
    cursor: 'pointer',
    background: isActive ? 'var(--surface)' : 'transparent',
    borderTop: withHairline ? '1px solid var(--hairline)' : '1px solid transparent',
    transition: 'background var(--dur-state) var(--ease)',
  };
}

// --- helpers -----------------------------------------------------------------

/** Scroll a task row to the center of the viewport after a Jump. Deferred a
 *  frame so the palette has closed and the row re-rendered (e.g. the selection
 *  tint applied). Smooth normally; instant under prefers-reduced-motion. */
function scrollRowIntoView(id: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(
      `.rune-row[data-id="${CSS.escape(id)}"]`,
    );
    if (!el) return;
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function truncate(s: string, max = 48): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Subsequence fuzzy match: every char of `needle` must appear in `hay` in
 * order. Returns a score (higher = better) or null when there is no match.
 * Rewards contiguous runs and word-boundary starts so tight matches rank above
 * scattered ones. Case-insensitive.
 */
function fuzzyScore(hay: string, needle: string): number | null {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  let score = 0;
  let hi = 0;
  let prevMatch = -2;
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    if (c === ' ') continue; // spaces only segment the needle
    const found = h.indexOf(c, hi);
    if (found === -1) return null;
    score += 1;
    if (found === prevMatch + 1) score += 3; // contiguous run
    const prevChar = found > 0 ? h[found - 1] : ' ';
    if (prevChar === ' ' || prevChar === '-' || prevChar === '/') score += 2; // word start
    prevMatch = found;
    hi = found + 1;
  }
  // Shorter haystacks that satisfy the same needle are tighter matches.
  return score - hay.length * 0.01;
}
