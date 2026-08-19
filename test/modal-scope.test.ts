import { describe, it, expect, afterEach } from 'vitest';
import {
  pushModalScope,
  popModalScope,
  isModalScopeActive,
  _resetModalScopes,
} from '../web/lib/modalScope';

// The modal-scope registry is the structural fix for "global shortcuts stay live
// behind modals": every modal registers a scope while open and the App's global
// keydown handler early-returns when ANY scope is active. These tests pin the
// registry's core semantics (the React hook is a one-line wrapper over these).

afterEach(() => {
  _resetModalScopes();
});

describe('modalScope registry', () => {
  it('is inactive with no scopes registered', () => {
    expect(isModalScopeActive()).toBe(false);
  });

  it('activates while a scope is pushed and deactivates when popped', () => {
    const token = pushModalScope('palette');
    expect(isModalScopeActive()).toBe(true);
    popModalScope(token);
    expect(isModalScopeActive()).toBe(false);
  });

  it('stays active until EVERY overlapping scope is popped (stacked modals)', () => {
    // e.g. the detail card open, then the help sheet over it.
    const detail = pushModalScope('detail');
    const help = pushModalScope('help');
    popModalScope(detail);
    expect(isModalScopeActive()).toBe(true); // help still open
    popModalScope(help);
    expect(isModalScopeActive()).toBe(false);
  });

  it('pop is idempotent and unknown tokens are harmless', () => {
    const token = pushModalScope();
    popModalScope(token);
    popModalScope(token); // double-pop
    popModalScope(Symbol('never-pushed'));
    expect(isModalScopeActive()).toBe(false);
  });

  it('each push mints a distinct token (two dialogs of the same kind)', () => {
    const a = pushModalScope('dialog');
    const b = pushModalScope('dialog');
    expect(a).not.toBe(b);
    popModalScope(a);
    expect(isModalScopeActive()).toBe(true);
    popModalScope(b);
    expect(isModalScopeActive()).toBe(false);
  });
});
