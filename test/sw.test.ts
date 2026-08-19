// Exercises the hand-rolled offline service worker (web/public/sw.js) by loading
// it into a mock ServiceWorkerGlobalScope and driving install / activate / fetch.
//
// The worker is a classic (non-module) worker script — no imports/exports — so we
// run its source in a vm context with lightweight mocks for `self`, `caches`,
// `fetch`, `Request`, and `Response`. This locks in the invariants that matter:
// cache versioning + cleanup, skipWaiting/claim, and the per-request routing
// (never touch /api/* or /d/* or cross-origin; navigations network-first;
// /assets/* cache-first).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const SW_SOURCE = readFileSync(
  fileURLToPath(new URL('../web/public/sw.js', import.meta.url)),
  'utf8',
);

const ORIGIN = 'https://rune.example.ts.net';

// --- Mocks --------------------------------------------------------------

class MockResponse {
  constructor(
    public url: string,
    public ok = true,
    public tag = 'net',
  ) {}
  clone() {
    return new MockResponse(this.url, this.ok, this.tag);
  }
}

class MockRequest {
  url: string;
  method: string;
  mode: string;
  constructor(input: string, init: { method?: string; mode?: string } = {}) {
    // Resolve relative URLs against the worker origin, like the browser does.
    this.url = input.startsWith('http') ? input : ORIGIN + (input.startsWith('/') ? input : '/' + input);
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'cors';
  }
}

function keyOf(req: unknown): string {
  if (typeof req === 'string') {
    return req.startsWith('http') ? req : ORIGIN + (req.startsWith('/') ? req : '/' + req);
  }
  return (req as MockRequest).url;
}

class MockCache {
  store = new Map<string, MockResponse>();
  constructor(private fetchImpl: (req: MockRequest) => Promise<MockResponse>) {}
  async match(req: unknown) {
    return this.store.get(keyOf(req));
  }
  async put(req: unknown, res: MockResponse) {
    this.store.set(keyOf(req), res);
  }
  async add(req: MockRequest) {
    const res = await this.fetchImpl(req);
    if (res && res.ok) this.store.set(keyOf(req), res);
  }
}

interface Harness {
  handlers: Record<string, (event: any) => void>;
  caches: Map<string, MockCache>;
  cacheNames: () => string[];
  skipWaitingCalled: boolean;
  claimCalled: boolean;
}

function loadWorker(fetchImpl: (req: MockRequest) => Promise<MockResponse>) {
  const cacheStore = new Map<string, MockCache>();
  const state = { skipWaitingCalled: false, claimCalled: false };
  const handlers: Record<string, (event: any) => void> = {};

  const cachesApi = {
    async open(name: string) {
      let c = cacheStore.get(name);
      if (!c) {
        c = new MockCache(fetchImpl);
        cacheStore.set(name, c);
      }
      return c;
    },
    async keys() {
      return [...cacheStore.keys()];
    },
    async delete(name: string) {
      return cacheStore.delete(name);
    },
    async match(req: unknown) {
      for (const c of cacheStore.values()) {
        const hit = await c.match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const self: any = {
    location: { origin: ORIGIN },
    addEventListener(type: string, handler: (event: any) => void) {
      handlers[type] = handler;
    },
    async skipWaiting() {
      state.skipWaitingCalled = true;
    },
    clients: {
      async claim() {
        state.claimCalled = true;
      },
    },
  };

  const sandbox: any = {
    self,
    caches: cachesApi,
    fetch: fetchImpl,
    URL,
    Request: MockRequest,
    Response: MockResponse,
    console,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);

  const harness: Harness = {
    handlers,
    caches: cacheStore,
    cacheNames: () => [...cacheStore.keys()],
    get skipWaitingCalled() {
      return state.skipWaitingCalled;
    },
    get claimCalled() {
      return state.claimCalled;
    },
  } as Harness;
  return harness;
}

// Drives a lifecycle event and awaits whatever waitUntil() was handed.
async function dispatchLifecycle(handler: (event: any) => void) {
  let waited: Promise<unknown> = Promise.resolve();
  handler({ waitUntil: (p: Promise<unknown>) => (waited = p) });
  await waited;
}

// Drives a fetch event; returns the response respondWith() got, or undefined
// if the worker chose not to intercept (bypass).
async function dispatchFetch(handler: (event: any) => void, request: MockRequest) {
  let responded: Promise<MockResponse> | undefined;
  handler({ request, respondWith: (p: Promise<MockResponse>) => (responded = p) });
  return responded ? await responded : undefined;
}

// --- Tests --------------------------------------------------------------

describe('offline service worker', () => {
  let netFail: boolean;
  let harness: Harness;

  const fetchImpl = async (req: MockRequest) => {
    if (netFail) throw new Error('offline');
    return new MockResponse(req.url, true, 'net');
  };

  beforeEach(async () => {
    netFail = false;
    harness = loadWorker(fetchImpl);
    // Registers install/activate/fetch handlers on load.
    expect(Object.keys(harness.handlers).sort()).toEqual(['activate', 'fetch', 'install']);
  });

  it('precaches the shell and calls skipWaiting on install', async () => {
    await dispatchLifecycle(harness.handlers.install);
    expect(harness.skipWaitingCalled).toBe(true);

    const names = harness.cacheNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^rune-shell-/);

    const cache = harness.caches.get(names[0])!;
    expect(cache.store.has(ORIGIN + '/index.html')).toBe(true);
    expect(cache.store.has(ORIGIN + '/manifest.webmanifest')).toBe(true);
    expect(cache.store.has(ORIGIN + '/icon-192.png')).toBe(true);
  });

  it('deletes stale rune-shell caches and claims clients on activate', async () => {
    // Seed an old-version cache the current worker should evict.
    harness.caches.set('rune-shell-v0', new MockCache(fetchImpl));
    harness.caches.set('unrelated-cache', new MockCache(fetchImpl));

    await dispatchLifecycle(harness.handlers.activate);
    expect(harness.claimCalled).toBe(true);

    const names = harness.cacheNames();
    expect(names).not.toContain('rune-shell-v0');
    // Non-rune caches are left untouched.
    expect(names).toContain('unrelated-cache');
  });

  it('never intercepts /api/* (live share/sync)', async () => {
    const res = await dispatchFetch(harness.handlers.fetch, new MockRequest('/api/publish'));
    expect(res).toBeUndefined();
  });

  it('never intercepts /d/* raw snapshot bytes', async () => {
    const res = await dispatchFetch(harness.handlers.fetch, new MockRequest('/d/abc123.txt'));
    expect(res).toBeUndefined();
  });

  it('never intercepts cross-origin requests', async () => {
    const res = await dispatchFetch(
      harness.handlers.fetch,
      new MockRequest('https://other.example.com/thing.js'),
    );
    expect(res).toBeUndefined();
  });

  it('never intercepts non-GET requests', async () => {
    const res = await dispatchFetch(
      harness.handlers.fetch,
      new MockRequest('/api/publish', { method: 'POST' }),
    );
    expect(res).toBeUndefined();
  });

  it('serves /assets/* cache-first (hit wins without hitting the network)', async () => {
    // Prime the cache via a first (network) fetch, then go offline.
    const asset = new MockRequest('/assets/index-abc123.js');
    const first = await dispatchFetch(harness.handlers.fetch, asset);
    expect(first?.tag).toBe('net');

    netFail = true; // network now dead
    const second = await dispatchFetch(harness.handlers.fetch, asset);
    expect(second).toBeDefined(); // served from cache despite offline
    expect(second!.url).toContain('/assets/index-abc123.js');
  });

  it('serves navigations network-first, falling back to cached index.html offline', async () => {
    await dispatchLifecycle(harness.handlers.install); // seeds /index.html

    // Online: a navigation gets the live response.
    const online = await dispatchFetch(
      harness.handlers.fetch,
      new MockRequest('/', { mode: 'navigate' }),
    );
    expect(online?.tag).toBe('net');

    // Offline: falls back to the precached shell.
    netFail = true;
    const offline = await dispatchFetch(
      harness.handlers.fetch,
      new MockRequest('/some/deep/route', { mode: 'navigate' }),
    );
    expect(offline).toBeDefined();
    expect(offline!.url).toBe(ORIGIN + '/index.html');
  });
});
