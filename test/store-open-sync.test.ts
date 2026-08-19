import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Store-level tests for zero-setup ("open server") auto-enable on init(). Mirrors
// test/store-sync.test.ts: the persist adapter is mocked so we drive pullDoc, and
// an in-memory localStorage shim backs lsGet/lsSet. The auto-enable probe only
// runs when served from a real origin, so we install a minimal window here (the
// plain store-sync tests deliberately have NO window, so they never auto-probe).

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
  vi.clearAllMocks(); // reset call history so per-test probe-count assertions hold
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    new MemStorage() as unknown as Storage;
  // A real (non-file://) origin so servedFromRealOrigin() lets the probe run.
  (globalThis as unknown as { window: unknown }).window = {
    location: { protocol: 'https:' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

async function bootStore(
  ls: Record<string, string>,
  local: { text: string; fileName: string | null } | null,
  remote: { text: string; updatedAt: string } | null,
  opts: { probeThrows?: boolean } = {},
): Promise<{
  useStore: typeof import('../web/store/store')['useStore'];
  pullDoc: Mock;
}> {
  for (const [k, v] of Object.entries(ls)) globalThis.localStorage.setItem(k, v);
  const persist = await import('../web/lib/persist');
  (persist.loadLocal as unknown as Mock).mockReturnValue(local);
  if (opts.probeThrows) {
    (persist.pullDoc as unknown as Mock).mockRejectedValue(new Error('401 token required'));
  } else {
    (persist.pullDoc as unknown as Mock).mockResolvedValue(remote);
  }
  const { useStore } = await import('../web/store/store');
  return { useStore, pullDoc: persist.pullDoc as unknown as Mock };
}

const OPTOUT = 'rune:sync:optout';

describe('init() zero-setup auto-enable', () => {
  it('probe OK + empty server + local content -> auto-enables and seeds', async () => {
    const { useStore } = await bootStore({}, { text: 'MY LOCAL', fileName: null }, null);
    await useStore.getState().init();
    const s = useStore.getState();
    expect(s.syncEnabled).toBe(true);
    expect(s.syncToken).toBe(''); // open server: empty token, no bearer
    expect(s.syncOpen).toBe(true);
    expect(s.syncDirty).toBe(true); // local content queued to seed the server
    expect(s.syncStatus).toBe('idle');
    expect(globalThis.localStorage.getItem('rune:sync:enabled')).toBe('1');
    expect(globalThis.localStorage.getItem('rune:sync:token')).toBe('');
  });

  it('probe OK + server already holds our text -> auto-enables and adopts the stamp', async () => {
    const { useStore } = await bootStore(
      {},
      { text: 'SHARED', fileName: null },
      { text: 'SHARED', updatedAt: 'NEW' },
    );
    await useStore.getState().init();
    const s = useStore.getState();
    expect(s.syncEnabled).toBe(true);
    expect(s.syncToken).toBe('');
    expect(s.lastSyncedUpdatedAt).toBe('NEW');
    expect(s.syncStatus).toBe('synced');
    expect(s.syncConflict).toBe(false);
  });

  it('probe 401/fails -> stays OFF, silent (token-gated or offline server)', async () => {
    const { useStore, pullDoc } = await bootStore(
      {},
      { text: 'JUST LOCAL', fileName: null },
      null,
      { probeThrows: true },
    );
    await useStore.getState().init();
    const s = useStore.getState();
    expect(s.syncEnabled).toBe(false);
    expect(s.syncToken).toBe(null);
    expect(s.syncOpen).toBe(false);
    expect(s.syncStatus).toBe('off');
    expect(s.text).toBe('JUST LOCAL'); // local untouched
    expect(pullDoc).toHaveBeenCalledTimes(1); // probed exactly once
  });

  it('respects a prior opt-out: never auto-enables (and never even probes)', async () => {
    const { useStore, pullDoc } = await bootStore(
      { [OPTOUT]: '1' },
      { text: 'LOCAL', fileName: null },
      null, // probe WOULD succeed if it ran
    );
    await useStore.getState().init();
    const s = useStore.getState();
    expect(s.syncEnabled).toBe(false);
    expect(s.syncStatus).toBe('off');
    expect(pullDoc).not.toHaveBeenCalled();
  });

  it('does NOT probe when there is no real origin (file:// / headless)', async () => {
    // Drop the window installed in beforeEach: no origin -> no probe.
    delete (globalThis as unknown as { window?: unknown }).window;
    const { useStore, pullDoc } = await bootStore({}, { text: 'LOCAL', fileName: null }, null);
    await useStore.getState().init();
    expect(useStore.getState().syncEnabled).toBe(false);
    expect(pullDoc).not.toHaveBeenCalled();
  });
});

describe('explicit enable/disable manages the opt-out preference', () => {
  it('disabling sync sets the opt-out flag', async () => {
    const { useStore } = await bootStore(
      { 'rune:sync:token': 't', 'rune:sync:enabled': '1' },
      { text: 'X', fileName: null },
      null,
    );
    await useStore.getState().enableSync(false);
    expect(useStore.getState().syncEnabled).toBe(false);
    expect(globalThis.localStorage.getItem(OPTOUT)).toBe('1');
  });

  it('enabling sync clears the opt-out flag', async () => {
    const { useStore } = await bootStore(
      { 'rune:sync:token': 't', [OPTOUT]: '1' },
      { text: 'X', fileName: null },
      null,
    );
    await useStore.getState().enableSync(true);
    expect(useStore.getState().syncEnabled).toBe(true);
    expect(globalThis.localStorage.getItem(OPTOUT)).toBe(null);
  });
});
