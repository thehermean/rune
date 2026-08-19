// Auth helpers for the self-hosted server.
//
// Two capabilities live here:
//   - RUNE_TOKEN bearer auth (constant-time) gates sync (/api/doc) and the
//     write side of sharing (publish / comments / unpublish). This is the
//     single-user instance secret.
//   - Per-snapshot write tokens gate comment-writes and unpublish on an
//     individual share. Stored hashed (sha256) so a leaked snapshot file never
//     reveals the live write capability. The READ url (the docId) stays a pure
//     read capability.
//
// Kept Redis/HTTP-framework-free so it unit-tests without any dependency
// (see test/sync-auth.test.ts).

import { createHash } from 'node:crypto';

/**
 * Constant-time string equality. Compares every character regardless of where
 * the first mismatch is, so timing does not leak how much of a guessed token
 * matched the secret. Returns false immediately on a length mismatch — the
 * length itself is not a secret, and short-circuiting there avoids indexing
 * past the end of either string.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Extract the bearer token from an Authorization header and compare it, in
 * constant time, to the expected secret.
 *
 * @param header the raw Authorization header value (may be undefined/empty)
 * @param expected the configured RUNE_TOKEN
 * @returns true only when the header is exactly `Bearer <expected>`
 */
export function checkToken(header: string | undefined | null, expected: string): boolean {
  if (!header || !expected) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length);
  return constantTimeEqual(token, expected);
}

/** Hex sha256 of a value — used to store per-snapshot write tokens at rest. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time check that `presented` hashes to `storedHash`. */
export function checkWriteToken(
  presented: string | undefined | null,
  storedHash: string | undefined | null,
): boolean {
  if (!presented || !storedHash) return false;
  return constantTimeEqual(sha256Hex(presented), storedHash);
}
