// Stable item-id generation.
//
// IDs are `^t-<base36>` per the format (BRIEF §2, decision 4): trailing,
// near-invisible, base36, the `t-` prefix, >= 4 chars total after the prefix is
// not required by the format but we keep a comfortable length so collisions are
// vanishingly unlikely. IDs are assigned once at creation, never reused, never
// derived from text or position — this is what lets after:/[[ ]]/comments
// survive reflow.

import { customAlphabet } from 'nanoid';

// Lowercase base36 alphabet (digits + a-z), matching the `^t-[a-z0-9]+` shape
// the parser and example file use.
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

// 6 random base36 chars -> 36^6 ≈ 2.2e9 keyspace, well clear of the >=4 floor.
const gen = customAlphabet(ALPHABET, 6);

/** A fresh id WITHOUT the leading caret, e.g. `t-9k2af0`. */
export function newId(): string {
  return `t-${gen()}`;
}

/** True if `id` already exists in `taken` (the set of current doc ids). */
export function isTaken(id: string, taken: Iterable<string>): boolean {
  for (const t of taken) if (t === id) return true;
  return false;
}

/** A fresh id guaranteed not to collide with `taken`. */
export function uniqueId(taken: Iterable<string>): string {
  const set = new Set(taken);
  let id = newId();
  while (set.has(id)) id = newId();
  return id;
}
