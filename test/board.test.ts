// Board (kanban) lens — the pure column/contract helpers and the store's
// moveToColumn action. The doc is canonical; the Board is a view over the same
// parsed items (no second store). These tests pin the `#board` / `col:` contract:
//   - only #board tasks are cards; unknown/absent col: falls to Backlog
//   - a move sets col: AND the mirrored state, in one commit, touching only that line
//   - every OTHER card's col: round-trips byte-for-byte untouched
//   - the > Next: child note is read for the card face

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parse, serialize, findById, getKey } from '../src/index';
import {
  COLUMNS,
  boardColumns,
  columnOf,
  isBoardTask,
  nextNoteOf,
  stateForColumn,
} from '../web/lib/board';

// --- pure helpers ----------------------------------------------------------

const SAMPLE = [
  '## Fleet & Projects  #board',
  '- [/] Invisible Cities — XR4 garden #board @grok col:doing ^t-e184f8',
  '  > Next: cit-invisible finishing motion-flash QA.',
  '- [>] grok CLI — finish auth #board @grok col:input ^t-82c0a8',
  '  > Next: type a test prompt in fleet:4.',
  '- [ ] DO Spaces — second Space #board @claude col:backlog ^t-cffde5',
  '- [ ] board card, no col yet #board @sam ^t-nocol',
  '- [ ] board card, junk col #board col:weird ^t-junk',
  '- [x] not a board task @claude ^t-plain',
].join('\n');

describe('board contract: which tasks are cards, and their column', () => {
  it('only #board tasks are cards', () => {
    const doc = parse(SAMPLE);
    expect(findById(doc, 't-plain') && isBoardTask(findById(doc, 't-plain')!)).toBe(false);
    expect(isBoardTask(findById(doc, 't-e184f8')!)).toBe(true);
  });

  it('col: slug maps to its column; absent/unknown falls to Backlog', () => {
    const doc = parse(SAMPLE);
    expect(columnOf(findById(doc, 't-e184f8')!)).toBe('doing');
    expect(columnOf(findById(doc, 't-82c0a8')!)).toBe('input');
    expect(columnOf(findById(doc, 't-nocol')!)).toBe('backlog');
    expect(columnOf(findById(doc, 't-junk')!)).toBe('backlog');
  });

  it('boardColumns groups every card, keeps all five columns, excludes non-board', () => {
    const cols = boardColumns(parse(SAMPLE));
    expect(Object.keys(cols).sort()).toEqual(
      ['backlog', 'blocked', 'doing', 'done', 'input'].sort(),
    );
    expect(cols.doing.map((t) => t.id)).toEqual(['t-e184f8']);
    expect(cols.input.map((t) => t.id)).toEqual(['t-82c0a8']);
    expect(cols.backlog.map((t) => t.id)).toEqual(['t-cffde5', 't-nocol', 't-junk']);
    expect(cols.blocked).toEqual([]); // empty Blocked still present
    const all = Object.values(cols).flat().map((t) => t.id);
    expect(all).not.toContain('t-plain');
  });

  it('the column→state map is what the parser writes back', () => {
    expect(stateForColumn('backlog')).toBe('open');
    expect(stateForColumn('doing')).toBe('doing');
    expect(stateForColumn('blocked')).toBe('deferred');
    expect(stateForColumn('input')).toBe('deferred');
    expect(stateForColumn('done')).toBe('done');
    expect(COLUMNS.map((c) => c.key)).toEqual([
      'backlog', 'doing', 'blocked', 'input', 'done',
    ]);
  });

  it('nextNoteOf reads the child "> Next:" note text', () => {
    const doc = parse(SAMPLE);
    expect(nextNoteOf(doc, 't-e184f8')).toBe('cit-invisible finishing motion-flash QA.');
    expect(nextNoteOf(doc, 't-cffde5')).toBe(''); // no next note
  });
});

// --- store.moveToColumn ----------------------------------------------------

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

async function freshStore(seed = '') {
  await import('../web/lib/persist');
  const { useStore } = await import('../web/store/store');
  if (seed) useStore.getState().loadText(seed);
  return useStore;
}

describe('store.moveToColumn: col: + state move, minimal touch', () => {
  it('moving a card sets col: AND the mirrored state, in one undo step', async () => {
    const useStore = await freshStore(SAMPLE);
    useStore.getState().moveToColumn('t-e184f8', 'done');
    const s = useStore.getState();
    const t = findById(s.doc, 't-e184f8')!;
    expect(getKey(t, 'col')).toBe('done');
    expect(t.state).toBe('done');
    expect(s.undoStack).toHaveLength(1); // exactly one commit
  });

  it('a move rewrites col: IN PLACE and leaves every OTHER line untouched', async () => {
    const useStore = await freshStore(SAMPLE);
    const before = useStore.getState().text.split('\n');
    useStore.getState().moveToColumn('t-82c0a8', 'blocked');
    const after = useStore.getState().text.split('\n');
    // Only the moved card's line changed; all others are byte-identical.
    const changed = after.filter((l, i) => l !== before[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('col:blocked');
    expect(changed[0]).toContain('- [>]'); // blocked → deferred state char
    // The child note and the other cards' col: survive verbatim.
    expect(after).toContain('  > Next: type a test prompt in fleet:4.');
    expect(after.join('\n')).toContain('col:doing ^t-e184f8');
  });

  it('adds a col: token to a card that had none', async () => {
    const useStore = await freshStore(SAMPLE);
    useStore.getState().moveToColumn('t-nocol', 'doing');
    const t = findById(useStore.getState().doc, 't-nocol')!;
    expect(getKey(t, 'col')).toBe('doing');
    expect(t.state).toBe('doing');
  });

  it('moving to the SAME column is a no-op (no phantom undo / push)', async () => {
    const useStore = await freshStore(SAMPLE);
    // t-e184f8 is already col:doing with state doing.
    useStore.getState().moveToColumn('t-e184f8', 'doing');
    expect(useStore.getState().canUndo).toBe(false);
    expect(useStore.getState().undoStack).toHaveLength(0);
  });

  it('is a no-op for an unknown id or an unknown column', async () => {
    const useStore = await freshStore(SAMPLE);
    useStore.getState().moveToColumn('t-nope', 'done');
    // @ts-expect-error — exercising the runtime guard against a bad slug
    useStore.getState().moveToColumn('t-e184f8', 'nonsense');
    expect(useStore.getState().canUndo).toBe(false);
  });

  it('round-trips: serialize(parse(text)) is stable after a move', async () => {
    const useStore = await freshStore(SAMPLE);
    useStore.getState().moveToColumn('t-cffde5', 'done');
    const text = useStore.getState().text;
    expect(serialize(parse(text))).toBe(text);
  });
});
