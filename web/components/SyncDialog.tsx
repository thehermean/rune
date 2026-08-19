// SyncDialog — the calm cross-device sync surface.
//
// Paste the SAME token on each device to share one list. The store owns the
// protocol (same-origin `/api/doc`, bearer token, last-write-wins); this modal is
// just the control panel: a token field, an Enable/Disable toggle, the current
// status + last-synced note, and a "Sync now" button. It mirrors ShareDialog's
// `.rune-modal*` chrome so it reads as a sibling of the other dialogs.
//
// Safety notes:
//  - The token is only ever shown inside its own <input> (a password-style field
//    with a reveal toggle); it is never rendered back in plain sight elsewhere.
//  - Enabling with a NON-EMPTY server doc REPLACES this device's local list with
//    the synced one, so we warn before that happens and require confirmation.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { useModalScope } from '../lib/modalScope';
import { useModalFocus } from '../lib/useModalFocus';

export interface SyncDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Human-friendly one-liner for each sync status. */
function statusLabel(status: string, enabled: boolean): string {
  switch (status) {
    case 'syncing':
      return 'Syncing…';
    case 'synced':
      return 'Synced';
    case 'error':
      return 'Sync error';
    case 'idle':
      return enabled ? 'On — waiting for changes' : 'Idle';
    case 'off':
    default:
      return 'Off';
  }
}

/** "just now" / "3 min ago" / a short local time for the last-synced note. */
function relTime(iso: string | null): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(then).toLocaleString();
}

export function SyncDialog({ open, onClose }: SyncDialogProps): JSX.Element | null {
  const syncEnabled = useStore((s) => s.syncEnabled);
  const syncToken = useStore((s) => s.syncToken);
  const syncOpen = useStore((s) => s.syncOpen);
  const syncStatus = useStore((s) => s.syncStatus);
  const syncLastAt = useStore((s) => s.syncLastAt);
  const syncError = useStore((s) => s.syncError);
  const syncConflict = useStore((s) => s.syncConflict);
  const setSyncToken = useStore((s) => s.setSyncToken);
  const enableSync = useStore((s) => s.enableSync);
  const syncNow = useStore((s) => s.syncNow);
  const reloadFromSync = useStore((s) => s.reloadFromSync);
  const dismissConflict = useStore((s) => s.dismissConflict);

  // A local draft of the token so typing doesn't churn localStorage on each key;
  // it is committed to the store on enable / explicit save.
  const [draft, setDraft] = useState(syncToken ?? '');
  const [reveal, setReveal] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Own the keyboard while open + trap/restore focus (WCAG 2.4.3 / 2.1.2).
  useModalScope(open);
  useModalFocus(open, panelRef);

  // Re-seed the draft from the store whenever the dialog (re)opens, so it always
  // reflects the persisted token and never a stale in-flight edit.
  useEffect(() => {
    if (open) {
      setDraft(syncToken ?? '');
      setReveal(false);
    }
  }, [open, syncToken]);

  if (!open) return null;

  const busy = syncStatus === 'syncing';
  // A trusted-network ("open") server syncs with no token: this device either
  // auto-enabled against it or was told the server is open by the probe. Hide the
  // token field and present sync as a simple on/off.
  const openMode = syncOpen;

  async function onEnable(): Promise<void> {
    if (openMode) {
      // Open server: no token, no scary "replaces your list" confirm — the same
      // reconcile guards (adopt-when-clean / seed-when-empty / conflict) apply.
      await enableSync(true);
      return;
    }
    const token = draft.trim();
    if (!token) return;
    setSyncToken(token);
    // Adopting a non-empty server list replaces the local one — confirm first.
    if (
      !window.confirm(
        'Enable sync?\n\nIf a list already exists on the server for this token, ' +
          "it will REPLACE this device's current list. If the server is empty, " +
          'your current list is uploaded to seed it.',
      )
    ) {
      return;
    }
    await enableSync(true);
  }

  async function onDisable(): Promise<void> {
    await enableSync(false);
  }

  return (
    <div className="rune-modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="rune-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Sync"
        onClick={(e) => e.stopPropagation()}
        // Keep keystrokes inside the dialog (Esc closes it) from leaking to the
        // app's global keyboard handler underneath.
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
      >
        <p className="rune-modal-title">Sync</p>

        <p className="rune-modal-hint">
          {openMode
            ? 'This server syncs your list automatically across every device on ' +
              'your private network — no token needed. Turn it off here if you ' +
              "don't want this device to sync."
            : 'Paste the same token on each device to share one list. The list is ' +
              'stored on the server for whoever holds this token — keep it private.'}
        </p>

        {!openMode && (
          <div className="rune-modal-link">
            <span className="rune-modal-hint">Token</span>
            <input
              className="rune-detail-input"
              type={reveal ? 'text' : 'password'}
              value={draft}
              placeholder="Paste your sync token"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Sync token"
            />
            <button
              type="button"
              className="rune-chrome-btn"
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? 'Hide' : 'Show'}
            </button>
          </div>
        )}

        <div className="rune-modal-link">
          <span className="rune-modal-hint">Status</span>
          <span className="rune-modal-link-value" aria-live="polite">
            {openMode && syncEnabled ? 'Syncing with this server' : statusLabel(syncStatus, syncEnabled)}
            {syncEnabled && syncLastAt && syncStatus !== 'syncing'
              ? ` · last synced ${relTime(syncLastAt)}`
              : ''}
          </span>
        </div>

        {syncStatus === 'error' && syncError && (
          <p className="rune-modal-error" role="alert">{syncError}</p>
        )}

        {syncConflict && (
          <div className="rune-modal-conflict">
            <p className="rune-modal-hint">
              This list changed on another device. Your local changes are kept —
              reload to take the other device's version, or keep yours and
              overwrite it on the next sync.
            </p>
            <div className="rune-modal-actions">
              <button
                type="button"
                className="rune-chrome-btn"
                onClick={() => reloadFromSync()}
                title="Replace this device's list with the version from the other device"
              >
                Reload
              </button>
              <button
                type="button"
                className="rune-chrome-btn"
                onClick={() => dismissConflict()}
                title="Keep this device's list and overwrite the server on the next sync"
              >
                Keep mine
              </button>
            </div>
          </div>
        )}

        <div className="rune-modal-actions">
          {syncEnabled ? (
            <button
              type="button"
              className="rune-chrome-btn"
              onClick={() => void onDisable()}
              disabled={busy}
            >
              Disable
            </button>
          ) : (
            <button
              type="button"
              className="rune-chrome-btn"
              onClick={() => void onEnable()}
              disabled={busy || (!openMode && !draft.trim())}
            >
              Enable
            </button>
          )}
          <button
            type="button"
            className="rune-chrome-btn"
            onClick={() => void syncNow()}
            disabled={!syncEnabled || busy}
            title="Push this device's current list to the server now"
          >
            Sync now
          </button>
          <button type="button" className="rune-chrome-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
