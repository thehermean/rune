// Server data directory resolution (self-hosted, single-node).
//
// Everything the server persists — the single synced doc and every published
// share snapshot — lives under ONE data directory so the whole instance backs
// up as a plain folder. Resolution order:
//   1. $RUNE_DATA_DIR (explicit override; what the systemd unit sets)
//   2. ~/.local/share/rune-server (XDG-ish default)
//
// Resolved lazily (read on each call) so tests can point it at a temp dir by
// setting the env var before the first request.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Absolute path to the instance data directory (not guaranteed to exist yet). */
export function dataDir(): string {
  const override = process.env.RUNE_DATA_DIR;
  if (override && override.trim() !== '') return override;
  return join(homedir(), '.local', 'share', 'rune-server');
}

/** Directory holding published share snapshots (`<id>.json` each). */
export function sharesDir(): string {
  return join(dataDir(), 'shares');
}

/** Path of the single synced document's JSON sidecar. */
export function docFile(): string {
  return join(dataDir(), 'doc.json');
}
