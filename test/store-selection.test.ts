// Store-level tests for the multi-select slice + bulk verbs.
//
// The selection model: `selectedId` is the lead/focus row, `selectedIds` the
// full set (always containing the lead), `anchorId` the fixed end a range
// extends from. Bulk verbs fold existing single-task transforms over ONE commit
// so each is a single undo step; a bulk delete returns ONE ticket whose restore
// is also a single commit (the toast's Undo brings every block back).
//
// Harness mirrors store-editing.test.ts: persistence mocked, in-memory
// localStorage, a fresh store module per test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tasks, findById } from '../src/index';

vi.mock('../web/lib/persist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/lib/persist')>();
  return {
    ...actual,
    saveLocal: vi.fn(() => true),
    loadLocal: vi.fn(() => null),
    fetchSeed: vi.fn(async () => null),
    pullDoc: vi.fn(async () => null),
    pushDoc: vi.fn(async () => ({ conflict: false, updatedAt: 'NEW' })),
    loadHandles: vi.fn(async () => null),
    saveHandles: vi.fn(async () => {}),
  };
});

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    new MemStorage() as unknown as Storage;
});

async function freshStore(
  seed = '',
): Promise<typeof import('../web/store/store')['useStore']> {
  await import('../web/lib/persist');
  const { useStore } = await import('../web/store/store');
  if (seed) useStore.getState().loadText(seed);
  return useStore;
}

const FIVE = ['- [ ] a ^t-a', '- [ ] b ^t-b', '- [ ] c ^t-c', '- [ ] d ^t-d', '- [ ] e ^t-e'].join('\n');
const VISIBLE = ['t-a', 't-b', 't-c', 't-d', 't-e'];

describe('selection slice', () => {
  it('select(id) collapses to a single selection and re-anchors', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-b');
    expect(useStore.getState().selectedId).toBe('t-b');
    expect(useStore.getState().selectedIds).toEqual(['t-b']);
    expect(useStore.getState().anchorId).toBe('t-b');
  });

  it('select(null) clears everything', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-b');
    useStore.getState().select(null);
    expect(useStore.getState().selectedId).toBeNull();
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().anchorId).toBeNull();
  });

  it('selectRange extends from the anchor over the visible rows (down)', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-b');
    useStore.getState().selectRange('t-d', VISIBLE);
    expect(useStore.getState().selectedIds).toEqual(['t-b', 't-c', 't-d']);
    expect(useStore.getState().selectedId).toBe('t-d'); // lead moved
    expect(useStore.getState().anchorId).toBe('t-b'); // anchor fixed
  });

  it('selectRange works upward (lead above the anchor)', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-d');
    useStore.getState().selectRange('t-b', VISIBLE);
    expect(useStore.getState().selectedIds).toEqual(['t-b', 't-c', 't-d']);
    expect(useStore.getState().selectedId).toBe('t-b');
    expect(useStore.getState().anchorId).toBe('t-d');
  });

  it('shrinking a range keeps the anchor (shift-j then shift-k)', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-b');
    useStore.getState().selectRange('t-d', VISIBLE); // b..d
    useStore.getState().selectRange('t-c', VISIBLE); // back up to b..c
    expect(useStore.getState().selectedIds).toEqual(['t-b', 't-c']);
    expect(useStore.getState().anchorId).toBe('t-b');
  });

  it('a plain select after a range collapses to a single row', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-a');
    useStore.getState().selectRange('t-c', VISIBLE);
    useStore.getState().select('t-e');
    expect(useStore.getState().selectedIds).toEqual(['t-e']);
    expect(useStore.getState().anchorId).toBe('t-e');
  });

  it('selectRange with an off-screen anchor falls back to a single selection', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-a');
    // Visible list that no longer contains the anchor (e.g. filtered away).
    useStore.getState().selectRange('t-d', ['t-c', 't-d', 't-e']);
    expect(useStore.getState().selectedIds).toEqual(['t-d']);
    expect(useStore.getState().selectedId).toBe('t-d');
  });
});

describe('bulk verbs — one commit, one undo step', () => {
  it('toggleManyDone marks a mixed set done in ONE undo step', async () => {
    const useStore = await freshStore(FIVE);
    const before = useStore.getState().text;
    const depth = useStore.getState().undoStack.length;

    useStore.getState().toggleManyDone(['t-a', 't-b', 't-c']);
    const doc = useStore.getState().doc;
    for (const id of ['t-a', 't-b', 't-c']) {
      expect(findById(doc, id)?.state).toBe('done');
    }
    expect(useStore.getState().undoStack.length).toBe(depth + 1);

    useStore.getState().undo();
    expect(useStore.getState().text).toBe(before);
  });

  it('toggleManyDone on an all-done set reopens them (and clears done:)', async () => {
    const useStore = await freshStore('- [x] a done:2026-07-01 ^t-a\n- [x] b done:2026-07-01 ^t-b');
    useStore.getState().toggleManyDone(['t-a', 't-b']);
    const doc = useStore.getState().doc;
    expect(findById(doc, 't-a')?.state).toBe('open');
    expect(findById(doc, 't-b')?.state).toBe('open');
    expect(useStore.getState().text).not.toContain('done:');
  });

  it('setPriorityMany sets the !-count on every id in one commit', async () => {
    const useStore = await freshStore(FIVE);
    const depth = useStore.getState().undoStack.length;
    useStore.getState().setPriorityMany(['t-a', 't-c'], 3);
    expect(useStore.getState().text).toContain('a !!!');
    expect(useStore.getState().text).toContain('c !!!');
    expect(useStore.getState().undoStack.length).toBe(depth + 1);
  });

  it('addTagMany adds the tag only where absent (idempotent per row)', async () => {
    const useStore = await freshStore('- [ ] a #x ^t-a\n- [ ] b ^t-b');
    useStore.getState().addTagMany(['t-a', 't-b'], 'x');
    const text = useStore.getState().text;
    expect(text.match(/#x/g)?.length).toBe(2); // not duplicated on t-a
  });

  it('indentMany / outdentMany move each block one level in one commit', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-b');
    const depth = useStore.getState().undoStack.length;
    useStore.getState().indentMany(['t-b', 't-c']);
    expect(useStore.getState().undoStack.length).toBe(depth + 1);
    const doc = useStore.getState().doc;
    expect(findById(doc, 't-b')?.indent).toBe(2);
    expect(findById(doc, 't-c')?.indent).toBe(2);
    useStore.getState().outdentMany(['t-b', 't-c']);
    expect(findById(useStore.getState().doc, 't-b')?.indent).toBe(0);
  });

  it('a fully no-op bulk call pushes NO undo entry', async () => {
    const useStore = await freshStore(FIVE);
    const depth = useStore.getState().undoStack.length;
    useStore.getState().outdentMany(['t-a', 't-b']); // already at column 0
    useStore.getState().setStateMany(['zzz'], 'done'); // unknown ids
    expect(useStore.getState().undoStack.length).toBe(depth);
  });
});

describe('bulk delete — one ticket, one restore', () => {
  it('removeManyWithTicket removes all blocks in one commit and prunes the selection', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-b');
    useStore.getState().selectRange('t-d', VISIBLE);
    const depth = useStore.getState().undoStack.length;

    const bulk = useStore.getState().removeManyWithTicket(['t-b', 't-c', 't-d']);
    expect(bulk).not.toBeNull();
    expect(bulk!.tickets.length).toBe(3);
    expect(useStore.getState().undoStack.length).toBe(depth + 1);
    expect(tasks(useStore.getState().doc).map((t) => t.id)).toEqual(['t-a', 't-e']);
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().selectedId).toBeNull();
  });

  it('restoreDeletedMany brings every block back in ONE commit, byte-identical', async () => {
    const useStore = await freshStore(FIVE);
    const before = useStore.getState().text;
    const bulk = useStore.getState().removeManyWithTicket(['t-b', 't-d'])!;

    const depth = useStore.getState().undoStack.length;
    useStore.getState().restoreDeletedMany(bulk);
    expect(useStore.getState().text).toBe(before);
    expect(useStore.getState().undoStack.length).toBe(depth + 1); // one step
  });

  it('a parent + its descendant in the same set is a harmless skip; a whole block restores with its children', async () => {
    const seed = ['- [ ] p ^t-p', '  - [ ] kid ^t-k', '- [ ] q ^t-q'].join('\n');
    const useStore = await freshStore(seed);
    const before = useStore.getState().text;

    // t-k is swept away with t-p's block; its own removal is a skip.
    const bulk = useStore.getState().removeManyWithTicket(['t-p', 't-k'])!;
    expect(tasks(useStore.getState().doc).map((t) => t.id)).toEqual(['t-q']);

    useStore.getState().restoreDeletedMany(bulk);
    expect(useStore.getState().text).toBe(before);
  });

  it('adjacent deletes restore in order (an earlier block anchors a later one)', async () => {
    const useStore = await freshStore(FIVE);
    const before = useStore.getState().text;
    // b and c are adjacent: c's anchor is b, which is ALSO deleted — the ordered
    // restore re-inserts b first so c re-anchors correctly.
    const bulk = useStore.getState().removeManyWithTicket(['t-b', 't-c'])!;
    useStore.getState().restoreDeletedMany(bulk);
    expect(useStore.getState().text).toBe(before);
  });

  it('removeManyWithTicket returns null when nothing resolves', async () => {
    const useStore = await freshStore(FIVE);
    expect(useStore.getState().removeManyWithTicket(['nope'])).toBeNull();
  });
});

describe('setDue returns whether the date was applied (near-miss surface)', () => {
  it('true for a parseable / ISO / clearing input', async () => {
    const useStore = await freshStore('- [ ] a ^t-a');
    expect(useStore.getState().setDue('t-a', '2026-07-10')).toBe(true);
    expect(useStore.getState().text).toContain('due:2026-07-10');
    expect(useStore.getState().setDue('t-a', '')).toBe(true);
    expect(useStore.getState().text).not.toContain('due:');
  });

  it('false for an unparseable date (and the text is untouched)', async () => {
    const useStore = await freshStore('- [ ] a ^t-a');
    const before = useStore.getState().text;
    expect(useStore.getState().setDue('t-a', 'blorp qux')).toBe(false);
    expect(useStore.getState().text).toBe(before);
  });

  it('false for an unknown id', async () => {
    const useStore = await freshStore('- [ ] a ^t-a');
    expect(useStore.getState().setDue('t-zzz', 'friday')).toBe(false);
  });
});

describe('toggleSelect — additive ctrl/cmd-click selection', () => {
  it('adds rows to the set, each becoming the lead + anchor', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-a');
    useStore.getState().toggleSelect('t-c');
    expect(useStore.getState().selectedIds).toEqual(['t-a', 't-c']);
    expect(useStore.getState().selectedId).toBe('t-c');
    expect(useStore.getState().anchorId).toBe('t-c');
  });

  it('toggling a selected row off removes it and re-leads the remainder', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-a');
    useStore.getState().toggleSelect('t-c');
    useStore.getState().toggleSelect('t-a'); // remove the first
    expect(useStore.getState().selectedIds).toEqual(['t-c']);
    expect(useStore.getState().selectedId).toBe('t-c');
  });

  it('toggling off the last row clears the selection', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-b');
    useStore.getState().toggleSelect('t-b');
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().selectedId).toBeNull();
    expect(useStore.getState().anchorId).toBeNull();
  });
});

describe('clearSelection empties the whole set', () => {
  it('drops selectedIds, lead and anchor', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-a');
    useStore.getState().selectRange('t-c', VISIBLE);
    useStore.getState().clearSelection();
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().selectedId).toBeNull();
    expect(useStore.getState().anchorId).toBeNull();
  });
});

describe('setDueMany — bulk due date in one commit', () => {
  it('sets an ISO due on every id in one undo step', async () => {
    const useStore = await freshStore(FIVE);
    const depth = useStore.getState().undoStack.length;
    expect(useStore.getState().setDueMany(['t-a', 't-c'], '2026-07-20')).toBe(true);
    expect(useStore.getState().text).toContain('a due:2026-07-20');
    expect(useStore.getState().text).toContain('c due:2026-07-20');
    expect(useStore.getState().undoStack.length).toBe(depth + 1);
  });

  it('parses natural language once and applies it to all', async () => {
    const useStore = await freshStore(FIVE);
    expect(useStore.getState().setDueMany(['t-a', 't-b'], '2026-07-20')).toBe(true);
    const text = useStore.getState().text;
    expect(text.match(/due:2026-07-20/g)?.length).toBe(2);
  });

  it('empty input clears due on every id', async () => {
    const useStore = await freshStore('- [ ] a due:2026-07-01 ^t-a\n- [ ] b due:2026-07-02 ^t-b');
    expect(useStore.getState().setDueMany(['t-a', 't-b'], '')).toBe(true);
    expect(useStore.getState().text).not.toContain('due:');
  });

  it('an unparseable date changes nothing and returns false', async () => {
    const useStore = await freshStore(FIVE);
    const before = useStore.getState().text;
    const depth = useStore.getState().undoStack.length;
    expect(useStore.getState().setDueMany(['t-a', 't-b'], 'blorp qux')).toBe(false);
    expect(useStore.getState().text).toBe(before);
    expect(useStore.getState().undoStack.length).toBe(depth);
  });
});


describe('touch select mode (long-press)', () => {
  it('enterSelectMode turns it on and ensures the row is selected', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().enterSelectMode('t-b');
    expect(useStore.getState().selectMode).toBe(true);
    expect(useStore.getState().selectedIds).toEqual(['t-b']);
  });

  it('enterSelectMode on an already-selected row keeps it (no toggle-off)', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().select('t-b');
    useStore.getState().enterSelectMode('t-b');
    expect(useStore.getState().selectMode).toBe(true);
    expect(useStore.getState().selectedIds).toEqual(['t-b']);
  });

  it('in select mode, tapping (toggleSelect) adds rows; deselecting the last exits', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().enterSelectMode('t-b');
    useStore.getState().toggleSelect('t-c'); // [b, c]
    expect(useStore.getState().selectedIds).toEqual(['t-b', 't-c']);
    expect(useStore.getState().selectMode).toBe(true);
    useStore.getState().toggleSelect('t-c'); // [b]
    expect(useStore.getState().selectMode).toBe(true);
    useStore.getState().toggleSelect('t-b'); // []
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().selectMode).toBe(false);
  });

  it('clearSelection (Done) exits select mode and empties the set', async () => {
    const useStore = await freshStore(FIVE);
    useStore.getState().enterSelectMode('t-a');
    useStore.getState().toggleSelect('t-b');
    useStore.getState().clearSelection();
    expect(useStore.getState().selectMode).toBe(false);
    expect(useStore.getState().selectedIds).toEqual([]);
  });
});
