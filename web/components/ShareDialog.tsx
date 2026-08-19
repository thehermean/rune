// ShareDialog (Wave 4) — publish the current doc + copyable links.
//
// Consent fix: publishing sends your list to the server, so we do NOT publish on
// open. The user clicks "Create share link" to publish `useStore.getState().text`
// via `publish(text)`, which returns `{ id, writeToken, url, rawUrl }` already
// absolutized (the writeToken is stashed locally so Unpublish works later). We
// show the human `url` and the raw `.txt` link as quiet, copyable rows (Clipboard
// API), with a calm note that the raw link is what you hand an LLM, plus an
// Unpublish action that DELETEs the snapshot. Loading and error states surface
// inline. Renders nothing when `!open`. Chrome: `.rune-modal*` in app.css.

import { useCallback, useEffect, useRef, useState } from 'react';
import { publish, unpublish, type PublishResult } from '../lib/share';
import { useStore } from '../store/store';
import { useModalScope } from '../lib/modalScope';
import { useModalFocus } from '../lib/useModalFocus';

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
}

type Status = 'idle' | 'loading' | 'done' | 'error';

export function ShareDialog({ open, onClose }: ShareDialogProps): JSX.Element | null {
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string>('');
  // Guards against a slow in-flight publish resolving after the dialog closed or
  // a newer publish superseded it (avoids setting state for a stale request).
  const reqRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);

  // Own the keyboard while open (app shortcuts don't leak to the list behind us)
  // and trap + restore focus (WCAG 2.4.3 / 2.1.2).
  useModalScope(open);
  useModalFocus(open, panelRef);

  const run = useCallback(async () => {
    const req = ++reqRef.current;
    setStatus('loading');
    setError('');
    try {
      const res = await publish(useStore.getState().text);
      if (reqRef.current !== req) return; // superseded / dialog closed
      setResult(res);
      setStatus('done');
    } catch (err) {
      if (reqRef.current !== req) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  const doUnpublish = useCallback(async () => {
    if (!result) return;
    const req = ++reqRef.current;
    setStatus('loading');
    setError('');
    try {
      await unpublish(result.id);
      if (reqRef.current !== req) return;
      setResult(null);
      setStatus('idle');
    } catch (err) {
      if (reqRef.current !== req) return;
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, [result]);

  // Reset everything when the dialog closes so a re-open starts clean (and never
  // flashes a stale link). We deliberately do NOT publish on open — publishing
  // sends your list to the server, so it waits for an explicit click.
  useEffect(() => {
    if (!open) {
      reqRef.current++; // invalidate any in-flight request
      setStatus('idle');
      setResult(null);
      setError('');
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="rune-modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="rune-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Share"
        onClick={(e) => e.stopPropagation()}
        // Keep keystrokes inside the dialog (Esc closes it) from leaking to the
        // app's global keyboard handler underneath.
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
      >
        <p className="rune-modal-title">Share</p>

        {status === 'idle' && !result && (
          <p className="rune-modal-hint">
            Publish sends the current list to the server and returns an
            unguessable link. Nothing is sent until you click.
          </p>
        )}

        {status === 'loading' && (
          <p className="rune-modal-hint">Working…</p>
        )}

        {status === 'error' && (
          <p className="rune-modal-error">{error}</p>
        )}

        {status === 'done' && result && (
          <>
            <LinkRow label="Link" value={result.url} />
            <LinkRow label="Raw" value={result.rawUrl} />
            <p className="rune-modal-hint">
              The raw link is the one you hand an LLM — it serves the exact
              canonical bytes as plain text.
            </p>
          </>
        )}

        <div className="rune-modal-actions">
          <button
            type="button"
            className="rune-chrome-btn"
            onClick={() => void run()}
            disabled={status === 'loading'}
          >
            {status === 'done' ? 'Publish again'
              : status === 'error' ? 'Try again'
              : 'Create share link'}
          </button>
          {result && (
            <button
              type="button"
              className="rune-chrome-btn"
              onClick={() => void doUnpublish()}
              disabled={status === 'loading'}
            >
              Unpublish
            </button>
          )}
          <button type="button" className="rune-chrome-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** A quiet, copyable link row: label · monospace value · Copy control. */
function LinkRow({ label, value }: { label: string; value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (no permission / insecure context): leave the value
      // visible so it can still be selected and copied by hand.
    }
  }, [value]);

  return (
    <div className="rune-modal-link">
      <span className="rune-modal-hint">{label}</span>
      <a
        className="rune-modal-link-value"
        href={value}
        target="_blank"
        rel="noreferrer noopener"
        title={value}
      >
        {value}
      </a>
      <button type="button" className="rune-chrome-btn" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
