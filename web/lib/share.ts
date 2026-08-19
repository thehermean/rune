// In-app publish/unpublish client (tiny, dependency-free).
//
// `publish(text)` POSTs the canonical `.rune` bytes to the server's
// `/api/publish`. The server is same-origin in production (one node process
// serves the app AND the API) and in dev (the Vite proxy forwards `/api` and
// `/d` to :8787), so this is a SAME-ORIGIN fetch by default — empty base, no
// CORS. `VITE_RUNE_API` overrides the base for a split dev setup.
//
// Capability model: publishing is gated by the instance secret (the same token
// pasted into the Sync dialog, stored at `rune:sync:token`) so a stranger on the
// tailnet can't fill the disk. The response carries a per-snapshot `writeToken`
// — the capability to append comments or unpublish. We stash it locally, keyed
// by docId, so a later re-publish/unpublish can present it. The READ url
// (`/d/<id>`) alone stays read-only.

const SYNC_TOKEN_KEY = 'rune:sync:token';
const WRITE_TOKEN_PREFIX = 'rune:share:write:';

/** Base URL for the API. Empty = same-origin (the default in prod and dev). A
 *  split dev setup can point the app at a remote server with `VITE_RUNE_API`. */
function apiBase(): string {
  const base = (import.meta.env.VITE_RUNE_API as string | undefined) ?? '';
  return base.replace(/\/$/, '');
}

/** The instance secret the user pasted into the Sync dialog (publish auth). */
function instanceToken(): string {
  try {
    return localStorage.getItem(SYNC_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Persist / read / clear the per-snapshot write token. */
function storeWriteToken(id: string, token: string): void {
  try {
    localStorage.setItem(WRITE_TOKEN_PREFIX + id, token);
  } catch {
    // storage blocked/full — the token is still returned to the caller for this
    // session; a later reload just won't be able to unpublish silently.
  }
}
export function getWriteToken(id: string): string | null {
  try {
    return localStorage.getItem(WRITE_TOKEN_PREFIX + id);
  } catch {
    return null;
  }
}
function clearWriteToken(id: string): void {
  try {
    localStorage.removeItem(WRITE_TOKEN_PREFIX + id);
  } catch {
    /* best effort */
  }
}

export interface PublishResult {
  /** The snapshot id minted by the server (the read capability). */
  id: string;
  /** The per-snapshot write capability (append comments / unpublish). */
  writeToken: string;
  /** Absolute URL of the human-readable HTML view. */
  url: string;
  /** Absolute URL of the raw canonical-bytes endpoint (text/plain). */
  rawUrl: string;
}

interface PublishResponse {
  id?: unknown;
  writeToken?: unknown;
  url?: unknown;
  rawUrl?: unknown;
  error?: unknown;
}

/** Publish `text` and return absolute, shareable links plus the write token.
 *  Throws a clear Error on any non-2xx response or a malformed payload. */
export async function publish(text: string): Promise<PublishResult> {
  const token = instanceToken();
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
    });
  } catch (cause) {
    throw new Error('Could not reach the share server.', { cause });
  }

  if (res.status === 401) {
    throw new Error(
      'Publish needs the sync token. Open Sync, paste the token, then try again.',
    );
  }
  if (!res.ok) {
    const detail = await readError(res);
    throw new Error(`Publish failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }

  let data: PublishResponse;
  try {
    data = (await res.json()) as PublishResponse;
  } catch (cause) {
    throw new Error('Publish returned a non-JSON response.', { cause });
  }

  if (
    typeof data.id !== 'string' ||
    typeof data.writeToken !== 'string' ||
    typeof data.url !== 'string' ||
    typeof data.rawUrl !== 'string'
  ) {
    throw new Error('Publish response was missing id/writeToken/url/rawUrl.');
  }

  storeWriteToken(data.id, data.writeToken);

  return {
    id: data.id,
    writeToken: data.writeToken,
    url: absolutize(data.url),
    rawUrl: absolutize(data.rawUrl),
  };
}

/** Unpublish a snapshot (DELETE /api/d/:id), presenting its write token. Throws
 *  a clear Error on failure; a 404 is treated as already-gone (resolves). */
export async function unpublish(id: string): Promise<void> {
  const writeToken = getWriteToken(id);
  if (!writeToken) {
    throw new Error('No write token stored for this link — cannot unpublish it here.');
  }
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/d/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${writeToken}` },
    });
  } catch (cause) {
    throw new Error('Could not reach the share server.', { cause });
  }
  if (res.status === 404) {
    clearWriteToken(id); // already gone — clean up the stale token
    return;
  }
  if (res.status === 401) {
    throw new Error('Unpublish was rejected (401) — the write token no longer matches.');
  }
  if (!res.ok) {
    const detail = await readError(res);
    throw new Error(`Unpublish failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  clearWriteToken(id);
}

/** Make a server-returned path absolute against the API base (or current origin
 *  when same-origin). */
function absolutize(pathOrUrl: string): string {
  const base = apiBase() || location.origin;
  try {
    return new URL(pathOrUrl, base).toString();
  } catch {
    return pathOrUrl;
  }
}

/** Best-effort error detail from a failed response (JSON `error`, else text). */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON — fall through to text
  }
  try {
    return (await res.text()).trim().slice(0, 200);
  } catch {
    return '';
  }
}
