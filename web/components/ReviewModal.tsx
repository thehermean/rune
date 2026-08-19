// ReviewModal (Wave 4) — the in-app AI paste round-trip.
//
// The flow (BRIEF §6): the user copies the whole canonical doc to an LLM, asks
// it to add `{>> @ai: ... <<}` CriticMarkup comments and change NOTHING else, the
// model re-emits the doc, the user PASTES it back here, and we reconcile BY ^id
// via `mergeAnnotated(originalText, annotatedText)` from `@core/reconcile` (it is
// browser-safe). The guard is mandatory — on `{ ok:false }` we show the
// `rejectedReason` quietly and accept nothing; on `{ ok:true }` we show a calm
// summary + an added-lines preview and let the user Apply via
// `useStore.getState().setText(mergedText)` (undoable). Tokens/classes only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { mergeAnnotated, type MergeResult } from '@core/reconcile';
import { useStore } from '../store/store';
import { useModalScope } from '../lib/modalScope';
import { useModalFocus } from '../lib/useModalFocus';

export interface ReviewModalProps {
  open: boolean;
  onClose: () => void;
}

/** The lines present in `annotated` but not in `original` — a cheap, readable
 *  preview of what the round-trip added. Order-preserving, set-difference by
 *  exact line; trivially correct for the "added comments, changed nothing else"
 *  case the guard has already validated. */
function addedLines(original: string, annotated: string): string[] {
  const before = new Set(original.split('\n'));
  return annotated
    .split('\n')
    .filter((line) => line.trim() !== '' && !before.has(line));
}

export function ReviewModal({ open, onClose }: ReviewModalProps): JSX.Element | null {
  const setText = useStore((s) => s.setText);

  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  // null = not yet reviewed; otherwise the last merge result for `pasted`.
  const [result, setResult] = useState<MergeResult | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Own the keyboard while open + trap/restore focus (WCAG 2.4.3 / 2.1.2).
  useModalScope(open);
  useModalFocus(open, panelRef);

  // Reset the transient state every time the modal opens — a fresh round-trip.
  useEffect(() => {
    if (!open) return;
    setPasted('');
    setCopied(false);
    setResult(null);
  }, [open]);

  // Esc closes, even when focus is inside the textarea.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const added = useMemo(
    () =>
      result?.ok && result.mergedText
        ? addedLines(useStore.getState().text, result.mergedText)
        : [],
    [result],
  );

  if (!open) return null;

  async function onCopyDocument(): Promise<void> {
    try {
      await navigator.clipboard.writeText(useStore.getState().text);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context / denied): leave the affordance
      // unconfirmed rather than throw. The user can select the Source view text.
      setCopied(false);
    }
  }

  function onReview(): void {
    // Reconcile the paste against the CURRENT canonical doc, by ^id. The guard is
    // strict: a tampered body is rejected with a reason, nothing is applied.
    setResult(mergeAnnotated(useStore.getState().text, pasted));
  }

  function onApply(): void {
    if (!result?.ok || result.mergedText === undefined) return;
    // Re-validate against the LIVE doc, not the snapshot captured at Review time:
    // a modal can stay open across an intervening mutation (the App's global
    // keydown handler is live while focus is on a button, so Ctrl+Z / Space /
    // Backspace can change the doc behind us). Applying the stale snapshot would
    // overwrite a now-different document and silently break the unchanged-bytes
    // guarantee. If the doc still reconciles we apply the fresh result; if it no
    // longer does we surface the rejection instead of corrupting the doc.
    const fresh = mergeAnnotated(useStore.getState().text, pasted);
    if (fresh.ok && fresh.mergedText !== undefined) {
      setText(fresh.mergedText);
      onClose();
    } else {
      setResult(fresh);
    }
  }

  const summary =
    result?.ok && result.addedComments !== undefined
      ? `${result.addedComments} comment${result.addedComments === 1 ? '' : 's'} added`
      : null;

  return (
    <div className="rune-modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="rune-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Review AI changes"
      >
        <p className="rune-modal-title">Review AI changes</p>

        {/* 1. Copy the doc for the LLM. */}
        <div className="rune-modal-actions">
          <button type="button" className="rune-chrome-btn" onClick={onCopyDocument}>
            {copied ? 'Copied' : 'Copy document'}
          </button>
        </div>
        <p className="rune-modal-hint">
          Paste it to an LLM and ask it to add <code>{'{>> @ai: ... <<}'}</code>{' '}
          comments and change nothing else, then paste the result back below.
        </p>

        {/* 2. Paste the LLM-returned annotated doc. */}
        <textarea
          ref={pasteRef}
          className="rune-modal-paste"
          value={pasted}
          spellCheck={false}
          placeholder="Paste the annotated document here…"
          aria-label="Annotated document"
          onChange={(e) => {
            setPasted(e.target.value);
            // A new paste invalidates the prior review.
            if (result) setResult(null);
          }}
        />

        {/* 3a. Rejected — the guard refused a tampered doc. Apply nothing. */}
        {result && !result.ok && (
          <p className="rune-modal-error">
            Can’t apply: {result.rejectedReason}
          </p>
        )}

        {/* 3b. Accepted — calm summary + a minimal added-lines preview. */}
        {result?.ok && (
          <>
            <p className="rune-modal-hint">{summary}.</p>
            {added.length > 0 && (
              <textarea
                className="rune-modal-paste"
                value={added.join('\n')}
                readOnly
                aria-label="Added lines preview"
              />
            )}
          </>
        )}

        <div className="rune-modal-actions">
          {result?.ok ? (
            <button type="button" className="rune-chrome-btn" onClick={onApply}>
              Apply
            </button>
          ) : (
            <button
              type="button"
              className="rune-chrome-btn"
              onClick={onReview}
              disabled={pasted.trim() === ''}
            >
              Review changes
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
