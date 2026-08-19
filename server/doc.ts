// Single-doc cross-device sync, ported off Vercel+Upstash to a file on disk.
//
// Wire contract (same-origin; mounted at /api/doc), preserved from the old
// api/doc.ts so web/lib/persist.ts is unchanged:
//   GET  /api/doc   Authorization: Bearer <token>
//     -> 200 { text: string, updatedAt: string }   (text "" when no doc yet)
//     -> 401 on missing/wrong token
//   PUT  /api/doc   Authorization: Bearer <token>   JSON { text: string }
//     Optional precondition (conditional PUT): If-Match header or a
//     `baseUpdatedAt` body field carrying the updatedAt the client last saw. The
//     sentinel value "expect-empty" means "only write when NO doc exists yet" (a
//     never-synced device seeding the server); it 409s if any doc is present.
//     -> 200 { ok: true, updatedAt }
//     -> 409 { error:"conflict", updatedAt, text }  (server moved on; no write)
//     -> 400 on a malformed body
//     -> 413 { error:"document too large" } over the 5MB cap
//     -> 401 on a bad token
//   -> 503 { error:"sync not configured" } when RUNE_TOKEN is unset
//   -> 503 { error:"sync unavailable" } on a disk error
//
// The doc is a single JSON sidecar { text, updatedAt } under $RUNE_DATA_DIR,
// written atomically (temp file + rename) so a reader never observes a half
// write. Node is single-threaded and readDoc/writeDoc are synchronous, so the
// conditional-PUT compare-and-set is atomic within the event loop — no Lua
// script needed.
//
// Trusted-network ("open") mode: when RUNE_OPEN_SYNC=1 the sync endpoints
// (GET/PUT /api/doc, and NOTHING else) accept requests with NO bearer token —
// the point of a private Tailscale-only instance where every device on the
// tailnet is trusted. A request that DOES carry a non-empty token must still
// present the RIGHT one (so a misconfigured client fails loudly with 401 rather
// than silently syncing to the wrong place). Share publish stays RUNE_TOKEN
// gated regardless — it is a separate capability (see server/index.ts).
//
// Discovery/probe: a client learns the mode by GETting /api/doc with NO
// Authorization header. 200 => open (auto-enable, empty token). 401 => a token
// is required (fall back to the manual paste flow). No dedicated endpoint.

import { Hono, type Context } from 'hono';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkToken } from './auth';
import { docFile } from './config';

const MAX_BYTES = 5 * 1024 * 1024; // 5MB cap on the stored text.

// Sentinel precondition value meaning "only write when NO doc exists yet" — sent
// by a never-synced client seeding a shared server. MUST match
// EXPECT_EMPTY_PRECONDITION in web/lib/persist.ts. It can never collide with a
// real updatedAt (an ISO timestamp) so it is unambiguous.
const EXPECT_EMPTY = 'expect-empty';

interface Doc {
  text: string;
  updatedAt: string;
}

/** Read the current doc. A missing file is an empty doc (200); any other read
 *  or parse failure throws so the caller can degrade to 503 rather than silently
 *  reporting an existing doc as empty. */
function readDoc(): Doc {
  const path = docFile();
  if (!existsSync(path)) return { text: '', updatedAt: '' };
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Doc>;
  return {
    text: typeof parsed.text === 'string' ? parsed.text : '',
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  };
}

/** Atomic durable write (temp + rename). */
function writeDoc(doc: Doc): void {
  const path = docFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc), 'utf-8');
  renameSync(tmp, path);
}

const docApp = new Hono();

/** The single-user instance secret, or undefined when sync isn't configured. */
function expectedToken(): string | undefined {
  const t = process.env.RUNE_TOKEN;
  return t && t !== '' ? t : undefined;
}

/** True when the instance runs in trusted-network mode (RUNE_OPEN_SYNC=1). */
function openSync(): boolean {
  return process.env.RUNE_OPEN_SYNC === '1';
}

/**
 * Authorise a /api/doc request. Returns null when allowed, or a Response to
 * short-circuit. Two modes:
 *   - open (RUNE_OPEN_SYNC=1): no token required; but a PRESENTED non-empty
 *     bearer must still match RUNE_TOKEN or it 401s (loud misconfig).
 *   - default: strictly token-gated, exactly as before (503 with no token
 *     configured, 401 on a missing/wrong token).
 */
function authDoc(c: Context): Response | null {
  const expected = expectedToken();
  const header = c.req.header('authorization');
  const presented =
    header && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  if (openSync()) {
    // A non-empty token was presented -> it must be the real one.
    if (presented !== '' && !(expected && checkToken(header, expected))) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return null;
  }

  if (!expected) return c.json({ error: 'sync not configured' }, 503);
  if (!checkToken(header, expected)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return null;
}

docApp.get('/', (c) => {
  const denied = authDoc(c);
  if (denied) return denied;
  try {
    return c.json(readDoc());
  } catch {
    return c.json({ error: 'sync unavailable' }, 503);
  }
});

docApp.put('/', async (c) => {
  const denied = authDoc(c);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (
    body === null ||
    typeof body !== 'object' ||
    typeof (body as { text?: unknown }).text !== 'string'
  ) {
    return c.json({ error: 'expected { text: string }' }, 400);
  }
  const text = (body as { text: string }).text;
  // Byte length, not string length — a 5MB cap on the encoded UTF-8.
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    return c.json({ error: 'document too large' }, 413);
  }

  // Precondition: header takes priority, else a body field (so a keepalive
  // flush that can only send a body still gets conditional semantics).
  const bodyBase = (body as { baseUpdatedAt?: unknown }).baseUpdatedAt;
  const precondition =
    c.req.header('if-match') ?? (typeof bodyBase === 'string' ? bodyBase : undefined);

  const updatedAt = new Date().toISOString();
  try {
    if (precondition !== undefined && precondition !== '') {
      const cur = readDoc();
      if (precondition === EXPECT_EMPTY) {
        // Expect-empty: a never-synced client may only SEED a server with no doc.
        // Any existing doc is a conflict — this is what stops a fresh device from
        // clobbering an already-populated shared list.
        if (cur.updatedAt !== '') {
          return c.json({ error: 'conflict', updatedAt: cur.updatedAt, text: cur.text }, 409);
        }
      } else if (cur.updatedAt !== '' && cur.updatedAt !== precondition) {
        // Stamp precondition: conflict only when a doc EXISTS and its stamp differs.
        return c.json({ error: 'conflict', updatedAt: cur.updatedAt, text: cur.text }, 409);
      }
      writeDoc({ text, updatedAt });
      return c.json({ ok: true, updatedAt });
    }
    // Unconditional last-write-wins.
    writeDoc({ text, updatedAt });
    return c.json({ ok: true, updatedAt });
  } catch {
    return c.json({ error: 'sync unavailable' }, 503);
  }
});

docApp.options('/', (c) => {
  c.header('Allow', 'GET, PUT, OPTIONS');
  return c.body(null, 204);
});

// Any other method on /api/doc.
docApp.all('/', (c) => {
  c.header('Allow', 'GET, PUT, OPTIONS');
  return c.json({ error: 'method not allowed' }, 405);
});

export { docApp };
