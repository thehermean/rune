import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Store-level regression tests for the sync reconciliation on init(). The
// persistence adapter is mocked so we drive pullDoc/loadLocal directly; a small
// in-memory localStorage shim backs the store's lsGet/lsSet (the store reads its
// initial sync state from localStorage at create() time, so each test seeds it
// BEFORE importing the store).

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

async function bootStore(
  ls: Record<string, string>,
  local: { text: string; fileName: string | null } | null,
  remote: { text: string; updatedAt: string } | null,
): Promise<typeof import('../web/store/store')['useStore']> {
  for (const [k, v] of Object.entries(ls)) globalThis.localStorage.setItem(k, v);
  const persist = await import('../web/lib/persist');
  (persist.loadLocal as unknown as Mock).mockReturnValue(local);
  (persist.pullDoc as unknown as Mock).mockResolvedValue(remote);
  const { useStore } = await import('../web/store/store');
  return useStore;
}

const ENABLED = { 'rune:sync:enabled': '1', 'rune:sync:token': 't' };

describe('init() sync reconciliation', () => {
  it('does NOT clobber dirty local text when the server also changed', async () => {
    const useStore = await bootStore(
      { ...ENABLED, 'rune:sync:updatedAt': 'OLD', 'rune:sync:dirty': '1' },
      { text: 'LOCAL EDIT', fileName: null },
      { text: 'SERVER VERSION', updatedAt: 'NEW' },
    );
    await useStore.getState().init();
    const s = useStore.getState();
    // Local edits survive; the divergence is surfaced, not silently resolved.
    expect(s.text).toBe('LOCAL EDIT');
    expect(s.syncConflict).toBe(true);
    expect(s.conflictText).toBe('SERVER VERSION');
    expect(s.conflictUpdatedAt).toBe('NEW');
  });

  it('adopts the server version when local has no unpushed edits', async () => {
    const useStore = await bootStore(
      { ...ENABLED, 'rune:sync:updatedAt': 'OLD' }, // no dirty flag
      { text: 'OLD LOCAL', fileName: null },
      { text: 'SERVER NEW', updatedAt: 'NEW' },
    );
    await useStore.getState().init();
    const s = useStore.getState();
    expect(s.text).toBe('SERVER NEW');
    expect(s.syncConflict).toBe(false);
    expect(s.lastSyncedUpdatedAt).toBe('NEW');
  });

  it('keeps local (no conflict) when server has not moved since the last sync', async () => {
    // Server updatedAt equals our last-synced stamp -> only local diverged, so we
    // keep local and schedule a push; nothing is clobbered, no conflict.
    const useStore = await bootStore(
      { ...ENABLED, 'rune:sync:updatedAt': 'SAME', 'rune:sync:dirty': '1' },
      { text: 'LOCAL ONLY', fileName: null },
      { text: 'STALE SERVER', updatedAt: 'SAME' },
    );
    await useStore.getState().init();
    const s = useStore.getState();
    expect(s.text).toBe('LOCAL ONLY');
    expect(s.syncConflict).toBe(false);
    expect(s.syncDirty).toBe(true);
  });

  it('leaves local untouched and quiet when sync is off', async () => {
    const useStore = await bootStore(
      {},
      { text: 'JUST LOCAL', fileName: null },
      { text: 'IGNORED', updatedAt: 'NEW' },
    );
    await useStore.getState().init();
    const s = useStore.getState();
    expect(s.text).toBe('JUST LOCAL');
    expect(s.syncStatus).toBe('off');
    expect(s.syncConflict).toBe(false);
  });
});
