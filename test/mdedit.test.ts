import { describe, it, expect } from 'vitest';
import { wrapInline, toggleLinePrefix, numberList, insertLink, toggleCheckboxLine } from '../web/lib/mdedit';

describe('mdedit transforms', () => {
  it('wraps a selection with markers, keeping it selected', () => {
    const r = wrapInline({ text: 'a bold c', start: 2, end: 6 }, '**');
    expect(r.text).toBe('a **bold** c');
    expect(r.text.slice(r.start, r.end)).toBe('bold');
  });

  it('with no selection drops the caret between markers', () => {
    const r = wrapInline({ text: 'x', start: 1, end: 1 }, '`');
    expect(r.text).toBe('x``');
    expect(r.start).toBe(2);
    expect(r.end).toBe(2);
  });

  it('toggles a bullet prefix on/off across a multi-line selection', () => {
    const on = toggleLinePrefix({ text: 'a\nb', start: 0, end: 3 }, '- ');
    expect(on.text).toBe('- a\n- b');
    const off = toggleLinePrefix({ text: on.text, start: on.start, end: on.end }, '- ');
    expect(off.text).toBe('a\nb');
  });

  it('replaces an existing heading level (exclusive)', () => {
    const r = toggleLinePrefix({ text: '# Title', start: 0, end: 7 }, '## ', /^#{1,6}\s+/);
    expect(r.text).toBe('## Title');
  });

  it('numbers each line', () => {
    const r = numberList({ text: 'a\nb\nc', start: 0, end: 5 });
    expect(r.text).toBe('1. a\n2. b\n3. c');
  });

  it('inserts a link with the url selected', () => {
    const r = insertLink({ text: 'see ', start: 4, end: 4 }, 'https://');
    expect(r.text).toBe('see [text](https://)');
    expect(r.text.slice(r.start, r.end)).toBe('https://');
  });

  it('toggles a checkbox on a source line', () => {
    expect(toggleCheckboxLine('- [ ] a\n- [x] b', 0)).toBe('- [x] a\n- [x] b');
    expect(toggleCheckboxLine('- [x] a', 0)).toBe('- [ ] a');
  });
});
