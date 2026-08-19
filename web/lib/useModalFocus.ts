// useModalFocus — a shared focus trap + focus restore for modal surfaces.
//
// WCAG 2.4.3 (Focus Order) + 2.1.2 (No Keyboard Trap, in the good sense: Tab
// cycles WITHIN the dialog and never escapes to the page behind the backdrop):
//   • on open, focus moves into the dialog (first focusable, else the container);
//   • Tab / Shift+Tab wrap around the dialog's focusable elements;
//   • on close, focus returns to whatever was focused before it opened.
//
// UI-only: no store dependency. Pass the same `open` flag the component renders
// on, plus a ref to the dialog container element.

import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useModalFocus(open: boolean, containerRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Move focus into the dialog. Defer a frame so freshly-mounted inputs exist.
    const raf = requestAnimationFrame(() => {
      const items = focusables();
      if (items.length > 0) {
        items[0].focus();
      } else if (!container.contains(document.activeElement)) {
        container.tabIndex = -1;
        container.focus();
      }
    });

    // An arrow (not a hoisted declaration) so TS keeps `container` narrowed here.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener('keydown', onKeyDown);
      // Return focus to where it was before the dialog opened (2.4.3).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open, containerRef]);
}
