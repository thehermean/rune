import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// End-to-end (store-level) regression tests for the data-loss incident: a fresh
// device seeded with the bundled onboarding doc auto-synced and unconditionally
// PUT that seed over the owner's real list. Mirrors test/store-sync.test.ts
// mocking: the persist adapter is mocked so we drive loadLocal/fetchSeed/pullDoc/
// pushDoc, and an in-memory localStorage shim backs lsGet/lsSet.

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
  vi.clearAllMocks();
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    new MemStorage() as unknown as Storage;
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function bootStore(
  ls: Record<string, string>,
  local: { text: string; fileName: string | null } | null,
  remote: { text: string; updatedAt: string } | null,
  seed: string | null = null,
): Promise<{
  useStore: typeof import('../web/store/store')['useStore'];
  pullDoc: Mock;
  pushDoc: Mock;
}> {
  for (const [k, v] of Object.entries(ls)) globalThis.localStorage.setItem(k, v);
  const persist = await import('../web/lib/persist');
  (persist.loadLocal as unknown as Mock).mockReturnValue(local);
  (persist.pullDoc as unknown as Mock).mockResolvedValue(remote);
  if (seed !== null) (persist.fetchSeed as unknown as Mock).mockResolvedValue(seed);
  const { useStore } = await import('../web/store/store');
  return {
    useStore,
    pullDoc: persist.pullDoc as unknown as Mock,
    pushDoc: persist.pushDoc as unknown as Mock,
  };
}

const ENABLED = { 'rune:sync:enabled': '1', 'rune:sync:token': 't' };
const PRISTINE = 'rune:pristine';
const SEED = '# Welcome to Rune\n- [ ] Press c to add a task ^t-w1\n';

describe('incident: onboarding seed is never sync-authoritative', () => {
  it('(a) fresh pristine seed + non-empty server -> adopts server, no conflict, no push', async () => {
    const { useStore, pushDoc } = await bootStore(
      ENABLED,
      null, // fresh device: no localStorage doc -> seeded (pristine)
      { text: 'REAL LIST', updatedAt: 'NEW' },
      SEED,
    );
    await useStore.getState().init();
    const s = useStore.getState();
    expect(s.text).toBe('REAL LIST'); // adopted the owner's real list
    expect(s.syncConflict).toBe(false);
    expect(s.lastSyncedUpdatedAt).toBe('NEW');
    expect(pushDoc).not.toHaveBeenCalled(); // the seed was NEVER pushed
    expect(globalThis.localStorage.getItem(PRISTINE)).toBe(null); // cleared on adopt
  });

  it('(b) fresh pristine seed + empty server -> pushes nothing, server stays empty', async () => {
    const { useStore, pushDoc } = await bootStore(ENABLED, null, null, SEED);
    await useStore.getState().init();
    const s = useStore.getState();
    expect(s.text).toBe(SEED); // local keeps showing the onboarding seed
    expect(pushDoc).not.toHaveBeenCalled(); // never seeds the server with onboarding
    expect(s.syncDirty).toBe(false);
    expect(globalThis.localStorage.getItem(PRISTINE)).toBe('1'); // still pristine
  });

  it('(c) user-edited local + never-synced + non-empty server -> conflict, pushes blocked, Keep-mine force-pushes', async () => {
    const { useStore, pushDoc } = await bootStore(
      ENABLED, // no rune:sync:updatedAt -> lastSynced null; no dirty flag
      { text: 'USER EDITED', fileName: null }, // real localStorage doc -> NOT pristine
      { text: 'REAL LIST', updatedAt: 'NEW' },
    );
    await useStore.getState().init();
    let s = useStore.getState();
    // Local kept, divergence surfaced (the wave-1 safety behaviour, preserved).
    expect(s.syncConflict).toBe(true);
    expect(s.text).toBe('USER EDITED');
    expect(s.conflictText).toBe('REAL LIST');

    // Pushes are blocked while the conflict is unresolved.
    pushDoc.mockClear();
    await useStore.getState().syncNow();
    expect(pushDoc).not.toHaveBeenCalled();

    // Keep-mine: the ONLY sanctioned overwrite, and it is an explicit force push.
    pushDoc.mockResolvedValue({ conflict: false, updatedAt: 'FORCED' });
    useStore.getState().dismissConflict();
    await tick();
    s = useStore.getState();
    expect(pushDoc).toHaveBeenCalledTimes(1);
    const opts = pushDoc.mock.calls[0][2] ?? {};
    expect(opts.ifMatch).toBeUndefined(); // force = unconditional overwrite
    expect(opts.expectEmpty).toBeUndefined();
    expect(s.syncConflict).toBe(false);
    expect(s.lastSyncedUpdatedAt).toBe('FORCED');
  });

  it('(c-reload) same conflict -> Reload adopts the server version', async () => {
    const { useStore, pushDoc } = await bootStore(
      ENABLED,
      { text: 'USER EDITED', fileName: null },
      { text: 'REAL LIST', updatedAt: 'NEW' },
    );
    await useStore.getState().init();
    expect(useStore.getState().syncConflict).toBe(true);

    pushDoc.mockClear();
    useStore.getState().reloadFromSync();
    const s = useStore.getState();
    expect(s.text).toBe('REAL LIST');
    expect(s.syncConflict).toBe(false);
    expect(s.lastSyncedUpdatedAt).toBe('NEW');
    expect(pushDoc).not.toHaveBeenCalled(); // Reload adopts; it never pushes
  });

  it('(e) pristine flag clears on the first real commit; sync then seeds via expect-empty', async () => {
    const { useStore, pushDoc } = await bootStore(ENABLED, null, null, SEED);
    await useStore.getState().init();
    expect(pushDoc).not.toHaveBeenCalled(); // stayed quiet (pristine + empty server)
    expect(globalThis.localStorage.getItem(PRISTINE)).toBe('1');

    // The first user-driven edit makes the doc real and enables normal sync.
    pushDoc.mockResolvedValue({ conflict: false, updatedAt: 'SEEDED' });
    useStore.getState().setText('- [ ] a real task ^t-x');
    expect(globalThis.localStorage.getItem(PRISTINE)).toBe(null); // pristine cleared
    expect(useStore.getState().syncDirty).toBe(true);

    await useStore.getState().syncNow(); // flush the debounced push now
    const s = useStore.getState();
    expect(pushDoc).toHaveBeenCalledTimes(1);
    const opts = pushDoc.mock.calls[0][2] ?? {};
    expect(opts.expectEmpty).toBe(true); // never-synced -> expect-empty seed
    expect(opts.ifMatch).toBeUndefined();
    expect(s.lastSyncedUpdatedAt).toBe('SEEDED');
    expect(s.syncDirty).toBe(false);
  });
});
