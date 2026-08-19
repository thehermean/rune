import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parse, serialize, tasks, findById } from '../src/index';

// Store-level regression tests for the Phase-2 editing work: the transaction-aware
// commit funnel (skipIfEqual + coalesceKey), bulk remove, scoped delete undo, the
// recurring-completion re-parent fix, whole-block reindent, and URL link capture.
//
// The persistence adapter is mocked (no real IO); a small in-memory localStorage
// shim backs lsGet/lsSet. Each test boots a FRESH store module so the module-scope
// coalesce cursor never leaks between tests.

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
  await import('../web/lib/persist'); // ensure the mock is registered post-reset
  const { useStore } = await import('../web/store/store');
  if (seed) useStore.getState().loadText(seed);
  return useStore;
}

describe('commit funnel: skipIfEqual (default) drops phantom undo entries', () => {
  it('outdent at indent 0 is a no-op — no undo entry pushed', async () => {
    const useStore = await freshStore('- [ ] a ^t-a');
    useStore.getState().outdent('t-a');
    const s = useStore.getState();
    expect(s.canUndo).toBe(false);
    expect(s.undoStack).toHaveLength(0);
    expect(s.text).toBe('- [ ] a ^t-a');
  });

  it('setDue to the same value twice pushes only one undo step', async () => {
    const useStore = await freshStore('- [ ] a due:2026-07-03 ^t-a');
    useStore.getState().setDue('t-a', '2026-07-03'); // identical -> dropped
    expect(useStore.getState().undoStack).toHaveLength(0);
    useStore.getState().setDue('t-a', '2026-07-04'); // real change
    expect(useStore.getState().undoStack).toHaveLength(1);
  });

  it('a no-op move at the end of a sibling run pushes nothing', async () => {
    const useStore = await freshStore('- [ ] a ^t-a\n- [ ] b ^t-b');
    useStore.getState().move('t-a', 'up'); // already first
    expect(useStore.getState().canUndo).toBe(false);
  });
});

describe('commit funnel: coalesceKey folds a burst into one undo step', () => {
  it('same key across edits => one undo reverts the whole burst', async () => {
    const useStore = await freshStore('start');
    const { setText } = useStore.getState();
    setText('start!', { coalesceKey: 'k' });
    setText('start!!', { coalesceKey: 'k' });
    setText('start!!!', { coalesceKey: 'k' });
    expect(useStore.getState().undoStack).toHaveLength(1);
    useStore.getState().undo();
    expect(useStore.getState().text).toBe('start');
  });

  it('a different key starts a new undo step', async () => {
    const useStore = await freshStore('a');
    const { setText } = useStore.getState();
    setText('ab', { coalesceKey: 'k1' });
    setText('abc', { coalesceKey: 'k2' });
    expect(useStore.getState().undoStack).toHaveLength(2);
  });
});

describe('removeMany: bulk delete in one commit', () => {
  it('removes several blocks as a single undo step', async () => {
    const useStore = await freshStore('- [ ] a ^t-a\n- [ ] b ^t-b\n- [ ] c ^t-c');
    useStore.getState().removeMany(['t-a', 'c-nope', 't-c']);
    const s = useStore.getState();
    expect(tasks(s.doc).map((t) => t.id)).toEqual(['t-b']);
    expect(s.undoStack).toHaveLength(1); // ONE step, not two
    useStore.getState().undo();
    expect(tasks(useStore.getState().doc).map((t) => t.id)).toEqual(['t-a', 't-b', 't-c']);
  });

  it('a parent id + a now-gone descendant id is a harmless skip', async () => {
    const useStore = await freshStore('- [ ] p ^t-p\n  - [ ] c ^t-c');
    useStore.getState().removeMany(['t-p', 't-c']);
    expect(tasks(useStore.getState().doc)).toHaveLength(0);
    expect(useStore.getState().undoStack).toHaveLength(1);
  });

  it('an all-no-op call pushes nothing', async () => {
    const useStore = await freshStore('- [ ] a ^t-a');
    useStore.getState().removeMany(['nope']);
    expect(useStore.getState().canUndo).toBe(false);
  });
});

describe('scoped delete undo: removeTaskWithTicket + restoreDeleted', () => {
  it('restores the deleted block after its predecessor, even after other edits', async () => {
    const useStore = await freshStore('- [ ] a ^t-a\n- [ ] b ^t-b\n- [ ] c ^t-c');
    const ticket = useStore.getState().removeTaskWithTicket('t-b');
    expect(ticket).not.toBeNull();
    expect(ticket!.afterId).toBe('t-a');
    // An UNRELATED edit lands in between (global undo would revert THIS, not the delete).
    useStore.getState().rename('t-c', 'cc');
    useStore.getState().restoreDeleted(ticket!);
    const ids = tasks(useStore.getState().doc).map((t) => t.id);
    expect(ids).toEqual(['t-a', 't-b', 't-c']); // b is back in its original slot
    // The unrelated rename is preserved (not undone).
    expect(findById(useStore.getState().doc, 't-c')!.segments[0].raw).toBe('cc');
  });

  it('restores a whole block (task + descendants) as its first child of a parent', async () => {
    const useStore = await freshStore('- [ ] p ^t-p\n  - [ ] a ^t-a\n    - [ ] a1 ^t-a1\n  - [ ] b ^t-b');
    const ticket = useStore.getState().removeTaskWithTicket('t-a');
    expect(ticket!.afterId).toBe('t-p'); // shallower anchor => re-inserts as first child
    useStore.getState().restoreDeleted(ticket!);
    expect(tasks(useStore.getState().doc).map((t) => t.id)).toEqual([
      't-p',
      't-a',
      't-a1',
      't-b',
    ]);
  });

  it('appends at the end when the anchor no longer exists', async () => {
    const useStore = await freshStore('- [ ] a ^t-a\n- [ ] b ^t-b');
    const ticket = useStore.getState().removeTaskWithTicket('t-b');
    useStore.getState().remove('t-a'); // the anchor is gone
    useStore.getState().restoreDeleted(ticket!);
    expect(tasks(useStore.getState().doc).map((t) => t.id)).toEqual(['t-b']);
  });
});

describe('recurring completion: the spawned occurrence sits after the whole block', () => {
  it('done task keeps all descendants; the new occurrence has none and sits after them', async () => {
    const seed = [
      '- [ ] Water plants recur:"every day" due:2026-06-30 ^t-p',
      '  - [ ] a ^t-a',
      '  - [ ] b ^t-b',
      '  - [ ] c ^t-c',
      '  > a note',
    ].join('\n');
    const useStore = await freshStore(seed);
    useStore.getState().toggle('t-p');

    const doc = parse(useStore.getState().text);
    const nodes = doc.nodes;
    // idx0 parent (done), 1..3 children, 4 note, 5 the new occurrence.
    const parent = nodes[0];
    expect(parent.type).toBe('task');
    if (parent.type === 'task') expect(parent.state).toBe('done');

    const kids = tasks(doc);
    // The 3 original children still follow the DONE parent (not the new occurrence).
    expect(kids.slice(1, 4).map((t) => t.id)).toEqual(['t-a', 't-b', 't-c']);

    // The last task is the new OPEN occurrence: fresh id, advanced date, no kids.
    const occ = kids[kids.length - 1];
    expect(occ.state).toBe('open');
    expect(occ.id).not.toBe('t-p');
    const due = occ.segments.find((s) => s.kind === 'key' && s.key === 'due');
    expect(due?.value).toBe('2026-07-01');
    // It comes AFTER the note (i.e. after the whole done block).
    const occIdx = nodes.indexOf(nodes.find((n) => n.type === 'task' && n.id === occ.id)!);
    const noteIdx = nodes.findIndex((n) => n.type === 'note');
    expect(occIdx).toBeGreaterThan(noteIdx);
  });
});

describe('reindent shifts the whole block (parent + descendants)', () => {
  it('Tab on a parent at level 0 moves parent to 1 and children to 2', async () => {
    const useStore = await freshStore('- [ ] p ^t-p\n  - [ ] c ^t-c\n  > note');
    useStore.getState().indent('t-p');
    const doc = parse(useStore.getState().text);
    const p = doc.nodes.find((n) => n.type === 'task' && n.id === 't-p');
    const c = doc.nodes.find((n) => n.type === 'task' && n.id === 't-c');
    const note = doc.nodes.find((n) => n.type === 'note');
    expect(p && p.type === 'task' && p.indent).toBe(2); // level 1
    expect(c && c.type === 'task' && c.indent).toBe(4); // level 2
    expect(note?.indent).toBe(4); // the child note shifts too
  });

  it('Shift-Tab on the whole block un-indents parent and descendants together', async () => {
    const useStore = await freshStore('  - [ ] p ^t-p\n    - [ ] c ^t-c');
    useStore.getState().outdent('t-p');
    const doc = parse(useStore.getState().text);
    const p = doc.nodes.find((n) => n.type === 'task' && n.id === 't-p');
    const c = doc.nodes.find((n) => n.type === 'task' && n.id === 't-c');
    expect(p && p.type === 'task' && p.indent).toBe(0);
    expect(c && c.type === 'task' && c.indent).toBe(2); // stays one level under p
  });
});

describe('URL capture: bare URLs become round-tripping [link](url) tokens', () => {
  it('addFromInput emits a link token and the line round-trips through parse', async () => {
    const useStore = await freshStore('');
    const id = useStore.getState().addFromInput('Read https://example.com/docs');
    expect(id).not.toBeNull();
    const text = useStore.getState().text;
    expect(text).toContain('[link](https://example.com/docs)');
    expect(text).toContain('Read');
    // The emitted canonical line survives a parse -> serialize round-trip.
    expect(serialize(parse(text))).toBe(text);
  });

  it('a URL with parens is percent-encoded so the link grammar survives', async () => {
    const useStore = await freshStore('');
    useStore.getState().addFromInput('Ref https://en.wikipedia.org/wiki/Foo_(bar)');
    const text = useStore.getState().text;
    expect(serialize(parse(text))).toBe(text);
    const link = tasks(parse(text))[0].segments.find((s) => s.kind === 'link');
    expect(link).toBeDefined();
  });
});
