// Server snapshot store — Wave 2 / M4 (BRIEF §7), self-hosted revision.
//
// Local-canonical, hosted-projected: the .rune file is the source of truth; the
// server is a CACHE + capability-granter, never the owner. A shared doc is a
// published snapshot (the latest canonical bytes, served at /d/<id> and
// /d/<id>.txt). <docId> is a 128-bit-class unguessable token = the READ
// capability: minted with nanoid(22) (~132 bits over a 64-symbol alphabet), so
// it cannot be guessed or enumerated. Possession of the id IS read access.
//
// A DISTINCT write capability (`writeToken`) gates comment-writes and unpublish.
// It is returned once, at publish time, and stored only as a sha256 hash — the
// read url alone is read-only.
//
// Persistence is an in-process Map first (fast path) plus a file mirror under
// $RUNE_DATA_DIR/shares/ so snapshots survive a restart and back up as plain
// files. The Map is authoritative for a running process; the files are hydrated
// on a cold miss. Writes go to both, atomically (temp file + rename).

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { sha256Hex } from './auth';
import { sharesDir } from './config';

export interface Snapshot {
  id: string;
  text: string;
  updatedAt: string; // ISO timestamp
  /** sha256 of the write token minted at publish. Absent on legacy snapshots. */
  writeTokenHash?: string;
}

export interface Published {
  snapshot: Snapshot;
  /** The plaintext write token — returned to the publisher ONCE, never stored. */
  writeToken: string;
}

/** Cap the number of snapshots a single instance will hold so a tailnet peer
 *  can't fill the disk one publish at a time. */
const MAX_SNAPSHOTS = 200;

/** Thrown by createSnapshot when the instance is at capacity → 507 upstream. */
export class SnapshotCapError extends Error {
  constructor() {
    super('snapshot capacity reached');
    this.name = 'SnapshotCapError';
  }
}

const snapshots = new Map<string, Snapshot>();

/** A valid snapshot id is a long URL-safe token; reject anything else (no `/`,
 *  `.`, etc.) so a hostile id can never escape the shares dir as a path. */
const ID_RE = /^[A-Za-z0-9_-]{16,}$/;

function fileFor(id: string): string {
  return join(sharesDir(), `${id}.json`);
}

/** Lazily read a snapshot off disk into the in-memory Map (cold-start hydrate). */
function hydrate(id: string): Snapshot | undefined {
  if (!ID_RE.test(id)) return undefined;
  const path = fileFor(id);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<Snapshot>;
    if (typeof parsed.id !== 'string' || typeof parsed.text !== 'string') return undefined;
    const snap: Snapshot = {
      id: parsed.id,
      text: parsed.text,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      writeTokenHash: typeof parsed.writeTokenHash === 'string' ? parsed.writeTokenHash : undefined,
    };
    snapshots.set(id, snap);
    return snap;
  } catch {
    return undefined;
  }
}

/** Best-effort durable mirror, written atomically (temp + rename) so a reader
 *  never sees a half-written file. A failed write never breaks the request path. */
function persist(snap: Snapshot): void {
  try {
    mkdirSync(sharesDir(), { recursive: true });
    const path = fileFor(snap.id);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), 'utf-8');
    renameSync(tmp, path);
  } catch {
    // The in-memory copy still serves this process; disk is a convenience.
  }
}

/** Current snapshot count (disk ∪ memory), used to enforce the cap. */
function snapshotCount(): number {
  const ids = new Set(snapshots.keys());
  try {
    for (const name of readdirSync(sharesDir())) {
      if (name.endsWith('.json')) ids.add(name.slice(0, -5));
    }
  } catch {
    // dir may not exist yet — memory count stands.
  }
  return ids.size;
}

export function getSnapshot(id: string): Snapshot | undefined {
  return snapshots.get(id) ?? hydrate(id);
}

export function hasSnapshot(id: string): boolean {
  return snapshots.has(id) || hydrate(id) !== undefined;
}

/**
 * Store (or overwrite) a snapshot under an explicit id. `updatedAt` may be
 * supplied by the caller (e.g. to carry a source timestamp); otherwise it is
 * stamped now. An existing snapshot's writeTokenHash is preserved across an
 * overwrite (a comment append must not rotate the write capability).
 */
export function putSnapshot(id: string, text: string, updatedAt?: string): Snapshot {
  const prev = getSnapshot(id);
  const snap: Snapshot = {
    id,
    text,
    updatedAt: updatedAt ?? new Date().toISOString(),
    writeTokenHash: prev?.writeTokenHash,
  };
  snapshots.set(id, snap);
  persist(snap);
  return snap;
}

/**
 * Mint a fresh READ capability id and a distinct WRITE token, store the text as
 * a new snapshot (with only the write token's sha256 at rest), and return both
 * the snapshot and the plaintext write token (shown to the publisher once).
 * Throws {@link SnapshotCapError} when the instance is at capacity.
 */
export function createSnapshot(text: string, updatedAt?: string): Published {
  if (snapshotCount() >= MAX_SNAPSHOTS) throw new SnapshotCapError();
  const id = nanoid(22);
  const writeToken = nanoid(32);
  const snap: Snapshot = {
    id,
    text,
    updatedAt: updatedAt ?? new Date().toISOString(),
    writeTokenHash: sha256Hex(writeToken),
  };
  snapshots.set(id, snap);
  persist(snap);
  return { snapshot: snap, writeToken };
}

/** Remove a snapshot from memory and disk. Returns true if anything was removed. */
export function deleteSnapshot(id: string): boolean {
  const had = snapshots.delete(id);
  let onDisk = false;
  if (ID_RE.test(id)) {
    const path = fileFor(id);
    try {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        onDisk = true;
      }
    } catch {
      // best effort
    }
  }
  return had || onDisk;
}
