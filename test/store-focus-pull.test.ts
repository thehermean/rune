import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Store-level tests for the quiet pull-on-focus in the sync layer. Mirrors
// test/store-open-sync.test.ts: the persist adapter is mocked so we drive
// pullDoc, and an in-memory localStorage shim backs lsGet/lsSet. Here the window
// mock also CAPTURES the listeners installLifecycleHandlers registers, so a test
// can fire the 'focus' handler and observe the pull.

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

// Captured window listeners, keyed by event type, so tests can fire them.
let handlers: Record<string, Array<(e?: unknown) => void>>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  handlers = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    new MemStorage() as unknown as Storage;
  (globalThis as unknown as { window: unknown }).window = {
    location: { protocol: 'https:' },
    addEventListener: (type: string, fn: (e?: unknown) => void) => {
      (handlers[type] ??= []).push(fn);
    },
    removeEventListener: () => {},
  };
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: 'visible',
    documentElement: { setAttribute: () => {} },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { document?: unknown }).document;
});

/** Fire every captured 'focus' listener and let the async pull settle. */
async function fireFocus(): Promise<void> {
  for (const fn of handlers['focus'] ?? []) fn();
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Boot the store enabled+synced against a token server, with `initialRemote` as
 * the doc the init reconcile pulls. Returns the store and the pullDoc mock. After
 * this the store is a clean, in-sync baseline (lastSyncedUpdatedAt = the remote
 * stamp); tests then re-arm pullDoc for the focus pull.
 */
async function bootSynced(
  ls: Record<string, string>,
  local: { text: string; fileName: string | null },
  initialRemote: { text: string; updatedAt: string } | null,
): Promise<{
  useStore: typeof import('../web/store/store')['useStore'];
  pullDoc: Mock;
}> {
  for (const [k, v] of Object.entries(ls)) globalThis.localStorage.setItem(k, v);
  const persist = await import('../web/lib/persist');
  (persist.loadLocal as unknown as Mock).mockReturnValue(local);
  (persist.pullDoc as unknown as Mock).mockResolvedValue(initialRemote);
  const { useStore } = await import('../web/store/store');
  await useStore.getState().init();
  return { useStore, pullDoc: persist.pullDoc as unknown as Mock };
}

const ENABLED = { 'rune:sync:token': 't', 'rune:sync:enabled': '1' };

describe('quiet pull-on-focus', () => {
  it('adopts a newer remote when local is clean', async () => {
    const { useStore, pullDoc } = await bootSynced(
      { ...ENABLED, 'rune:sync:updatedAt': 'NEW' },
      { text: 'SHARED', fileName: null },
      { text: 'SHARED', updatedAt: 'NEW' }, // init settles clean, in sync
    );
    expect(useStore.getState().lastSyncedUpdatedAt).toBe('NEW');
    expect(useStore.getState().syncDirty).toBe(false);

    // Another device advanced the server while we were away.
    pullDoc.mockClear();
    pullDoc.mockResolvedValue({ text: 'REMOTE-NEXT', updatedAt: 'NEWER' });

    await fireFocus();

    const s = useStore.getState();
    expect(pullDoc).toHaveBeenCalledTimes(1);
    expect(s.text).toBe('REMOTE-NEXT'); // adopted quietly
    expect(s.lastSyncedUpdatedAt).toBe('NEWER');
    expect(s.syncDirty).toBe(false);
    // Adopted through loadText -> undo history is fresh, exactly like the init adopt.
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
  });

  it('skips entirely when local is dirty', async () => {
    const { useStore, pullDoc } = await bootSynced(
      { ...ENABLED, 'rune:sync:updatedAt': 'NEW' },
      { text: 'SHARED', fileName: null },
      { text: 'SHARED', updatedAt: 'NEW' },
    );
    // Local has an unpushed edit pending.
    useStore.setState({ syncDirty: true });

    pullDoc.mockClear();
    pullDoc.mockResolvedValue({ text: 'REMOTE-NEXT', updatedAt: 'NEWER' });

    await fireFocus();

    expect(pullDoc).not.toHaveBeenCalled(); // never even pulled
    expect(useStore.getState().text).toBe('SHARED'); // local untouched
  });

  it('does nothing when the server stamp is unchanged', async () => {
    const { useStore, pullDoc } = await bootSynced(
      { ...ENABLED, 'rune:sync:updatedAt': 'NEW' },
      { text: 'SHARED', fileName: null },
      { text: 'SHARED', updatedAt: 'NEW' },
    );

    pullDoc.mockClear();
    // Same stamp as last sync (text differs, but we key off updatedAt).
    pullDoc.mockResolvedValue({ text: 'WOULD-NOT-ADOPT', updatedAt: 'NEW' });

    await fireFocus();

    const s = useStore.getState();
    expect(pullDoc).toHaveBeenCalledTimes(1); // it DID pull...
    expect(s.text).toBe('SHARED'); // ...but adopted nothing
    expect(s.lastSyncedUpdatedAt).toBe('NEW');
  });

  it('throttles repeat focus events to one pull', async () => {
    const { useStore, pullDoc } = await bootSynced(
      { ...ENABLED, 'rune:sync:updatedAt': 'NEW' },
      { text: 'SHARED', fileName: null },
      { text: 'SHARED', updatedAt: 'NEW' },
    );

    pullDoc.mockClear();
    pullDoc.mockResolvedValue({ text: 'REMOTE-NEXT', updatedAt: 'NEWER' });

    await fireFocus();
    await fireFocus(); // within the throttle window -> suppressed

    expect(pullDoc).toHaveBeenCalledTimes(1);
    expect(useStore.getState().text).toBe('REMOTE-NEXT');
  });
});
