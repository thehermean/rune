// Attachment intake helpers (PURE — no React, no store, no IO).
//
// An attachment is just a `[label](target)` link segment on a task body. These
// helpers turn a dropped/pasted URL or a dropped File into that `{ label, target }`
// pair; the store appends it via `addAttachment` (edit.replaceBody). Browsers
// sandbox file bytes, so a dropped File is recorded as a RELATIVE reference into
// an `attachments/` folder sitting next to the `.rune` — we never copy bytes.
//
// Kept pure and total so they are trivially unit-testable in plain vitest.

export interface Attachment {
  /** Human-readable label shown in the meta + the `[label]` of the link. */
  label: string;
  /** The link target: an absolute URL, or a relative `attachments/<name>` ref. */
  target: string;
}

/**
 * True when `text` looks like a single http(s)/mailto URL (trimmed, no inner
 * whitespace). Deliberately conservative: a sentence that merely contains a URL
 * is NOT a URL. Used to decide whether a paste/drop of plain text is a link.
 */
export function isUrl(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) return false;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(t)) return true;
  if (!/^https?:\/\//i.test(t)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(t);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a URL into an attachment. The label is a readable handle: the last
 * non-empty path segment (decoded) if there is one, else the host. Falls back to
 * the raw url when it cannot be parsed (isUrl should gate this, but stay total).
 */
export function urlToAttachment(url: string): Attachment {
  const target = url.trim();
  let label = target;
  try {
    const u = new URL(target);
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs.length > 0 ? segs[segs.length - 1] : '';
    label = decodeLabel(last) || u.host || target;
  } catch {
    // mailto: or an unparseable shape — keep the raw text as the label.
    label = target.replace(/^mailto:/i, '') || target;
  }
  return { label, target };
}

/**
 * Turn a dropped File-like object into an attachment. We do NOT copy bytes (the
 * browser sandbox forbids it): the target is a RELATIVE path into an
 * `attachments/` folder beside the `.rune`, so the reference resolves once the
 * user drops the file there themselves. Only `name` is read, so a plain
 * `{ name }` works in tests.
 */
export function fileToAttachment(file: { name: string }): Attachment {
  const name = file.name.trim() || 'file';
  return { label: name, target: `attachments/${name}` };
}

/** Decode a percent-encoded path segment for display, tolerating bad input. */
function decodeLabel(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** A minimal DataTransfer-shaped view (drop/paste). Kept structural so the
 *  extraction below is unit-testable without a real browser event. */
export interface TransferLike {
  /** Dropped/pasted files, if any. */
  files?: ArrayLike<{ name: string }>;
  /** Read a transfer data type ("text/uri-list", "text/plain"). */
  getData?(type: string): string;
}

/**
 * Extract the attachments a drop/paste carries, in priority order:
 *   1. every dropped File -> a relative `attachments/<name>` ref, ELSE
 *   2. a `text/uri-list` payload (one url per non-comment line), ELSE
 *   3. plain text that is itself a single URL.
 * Returns [] when nothing attach-worthy is present (e.g. a plain-text paste that
 * is not a URL), so callers can fall through to their normal handling.
 */
export function attachmentsFromTransfer(dt: TransferLike): Attachment[] {
  const files = dt.files;
  if (files && files.length > 0) {
    return Array.from(files, (f) => fileToAttachment(f));
  }

  const uriList = dt.getData?.('text/uri-list') ?? '';
  const fromUriList = uriList
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && isUrl(l))
    .map(urlToAttachment);
  if (fromUriList.length > 0) return fromUriList;

  const plain = (dt.getData?.('text/plain') ?? '').trim();
  if (plain && isUrl(plain)) return [urlToAttachment(plain)];

  return [];
}
