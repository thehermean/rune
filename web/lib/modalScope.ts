// modalScope — a tiny UI-owned registry of "a modal owns the keyboard right now".
//
// PROBLEM this fixes: the App's single global window keydown handler implements
// the whole keyboard model (j/k, Space, Backspace, …). When a modal/dialog/menu
// is open over the list, those shortcuts must NOT act on the list sitting behind
// the backdrop (Backspace deleting the selected task, Space toggling it, …).
//
// Rather than teach the global handler about every modal's open flag (the old,
// leaky helpOpen/overflowOpen special-cases), every modal registers a scope while
// it is open and the global handler early-returns whenever ANY scope is active.
//
// UI-only: no store dependency, no React dependency in the core registry (the
// hook is a thin convenience). The global handler reads `isModalScopeActive()` at
// event time, so it always sees the live set — no re-render needed.

import { useEffect } from 'react';

/** Live set of open modal-scope tokens. Non-empty ⇒ a modal owns the keyboard. */
const scopes = new Set<symbol>();

/** Register a new modal scope; returns its token (pass it back to {@link popModalScope}). */
export function pushModalScope(label = 'modal'): symbol {
  const token = Symbol(label);
  scopes.add(token);
  return token;
}

/** Remove a previously-pushed scope token (idempotent). */
export function popModalScope(token: symbol): void {
  scopes.delete(token);
}

/** True while at least one modal/dialog/menu is open and owns the keyboard. */
export function isModalScopeActive(): boolean {
  return scopes.size > 0;
}

/** Test-only: drop every registered scope (guards against cross-test leakage). */
export function _resetModalScopes(): void {
  scopes.clear();
}

/**
 * Register a modal scope for as long as `active` is true. Every modal/dialog/menu
 * calls this while open; the App's global keyboard handler early-returns when any
 * scope is active, so app shortcuts never leak to the list behind the backdrop.
 */
export function useModalScope(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const token = pushModalScope();
    return () => popModalScope(token);
  }, [active]);
}
