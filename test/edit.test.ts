import { describe, it, expect } from 'vitest';
import { parse, serialize } from '../src/index';
import {
  removeTask,
  replaceBody,
  insertChild,
  insertSibling,
  moveBlock,
  moveBlockTo,
} from '../web/lib/edit';

// Each test parses .rune TEXT, applies a transform, and serializes back — the
// canonical contract the store relies on (parse -> transform -> serialize).

describe('removeTask', () => {
  it('removes a task AND its nested children/notes/comments, not following siblings', () => {
    const src = [
      '- [ ] Parent ^t-1',
      '  - [ ] Child A ^t-2',
      '    > a note under child A',
      '    {>> @ai: a comment <<}',
      '  - [ ] Child B ^t-3',
      '- [ ] Sibling ^t-4',
    ].join('\n');

    const out = serialize(removeTask(parse(src), 't-1'));

    expect(out).toBe('- [ ] Sibling ^t-4');
  });

  it('removes only a leaf task, leaving everything else intact', () => {
    const src = [
      '- [ ] First ^t-1',
      '- [ ] Leaf ^t-2',
      '- [ ] Third ^t-3',
    ].join('\n');

    const out = serialize(removeTask(parse(src), 't-2'));

    expect(out).toBe(['- [ ] First ^t-1', '- [ ] Third ^t-3'].join('\n'));
  });

  it('block ends at the first same-or-shallower task/heading, sweeping notes', () => {
    // The note at indent 0 after Child does NOT stop the block (only a
    // task/heading does), but the next top-level task DOES.
    const src = [
      '- [ ] Top ^t-1',
      '  - [ ] Child ^t-2',
      '> a top-level note that hangs after the child',
      '- [ ] Next top ^t-3',
    ].join('\n');

    const out = serialize(removeTask(parse(src), 't-1'));

    expect(out).toBe('- [ ] Next top ^t-3');
  });

  it('leaves the doc unchanged (but a new object) for an unknown id', () => {
    const src = ['- [ ] Only ^t-1'].join('\n');
    const doc = parse(src);

    const next = removeTask(doc, 'nope');

    expect(serialize(next)).toBe(src);
    expect(next).not.toBe(doc);
    expect(next.nodes).not.toBe(doc.nodes);
  });
});

describe('replaceBody', () => {
  it('preserves id, state char, and indent while changing the body', () => {
    const src = [
      '- [ ] Top ^t-1',
      '  - [/] old body ^t-2',
      '- [ ] After ^t-3',
    ].join('\n');

    const out = serialize(replaceBody(parse(src), 't-2', 'brand new body'));

    expect(out).toBe(
      [
        '- [ ] Top ^t-1',
        '  - [/] brand new body ^t-2',
        '- [ ] After ^t-3',
      ].join('\n'),
    );
  });

  it('re-tokenizes new tags/keys in the replacement body', () => {
    const src = ['- [x] plain ^t-9'].join('\n');

    const next = replaceBody(parse(src), 't-9', 'review #work due:2026-07-01 !!');
    const out = serialize(next);

    expect(out).toBe('- [x] review #work due:2026-07-01 !! ^t-9');

    // Confirm the segments were actually re-derived by @core, not pasted as text.
    const task = next.nodes.find(
      (n) => n.type === 'task' && n.id === 't-9',
    );
    expect(task?.type).toBe('task');
    if (task?.type === 'task') {
      const kinds = task.segments.map((s) => s.kind);
      expect(kinds).toContain('tag');
      expect(kinds).toContain('key');
      expect(kinds).toContain('priority');
    }
  });

  it('strips a stray trailing ^id left in the new body (id comes from the node)', () => {
    const src = ['- [ ] original ^t-keep'].join('\n');

    const out = serialize(replaceBody(parse(src), 't-keep', 'changed text ^t-bogus'));

    // The bogus id is dropped; the original id is preserved and re-appended.
    expect(out).toBe('- [ ] changed text ^t-keep');
  });

  it('strips a trailing ^id even when the body is exactly that id (no leading space)', () => {
    const src = ['- [ ] original ^t-keep'].join('\n');

    // Regression: a body of just "^t-bogus" must not leak a stray caret token
    // into the title. The id always comes from the original node.
    const out = serialize(replaceBody(parse(src), 't-keep', '^t-bogus'));

    expect(out).toBe('- [ ] ^t-keep');
  });

  it('leaves the doc unchanged for an unknown id', () => {
    const src = ['- [ ] one ^t-1'].join('\n');
    const next = replaceBody(parse(src), 'missing', 'whatever');
    expect(serialize(next)).toBe(src);
  });

  it('does NOT strip a caret-word that is not a real id (^2 in "raise to ^2")', () => {
    // stripTrailingId must only eat a genuine `^t-…` id; `^2` is title text and
    // has to survive, or "raise to ^2" silently loses its exponent.
    const src = ['- [ ] placeholder ^t-keep'].join('\n');
    const out = serialize(replaceBody(parse(src), 't-keep', 'raise to ^2'));
    expect(out).toBe('- [ ] raise to ^2 ^t-keep');
  });
});

describe('insertChild', () => {
  it('inserts at parent.indent+2 right after the parent block', () => {
    const src = [
      '- [ ] Parent ^t-1',
      '  - [ ] Existing child ^t-2',
      '- [ ] Sibling ^t-3',
    ].join('\n');

    const out = serialize(
      insertChild(parse(src), 't-1', '- [ ] New child ^t-new'),
    );

    expect(out).toBe(
      [
        '- [ ] Parent ^t-1',
        '  - [ ] Existing child ^t-2',
        '  - [ ] New child ^t-new',
        '- [ ] Sibling ^t-3',
      ].join('\n'),
    );
  });

  it('re-indents an over-indented input line to exactly parent.indent+2', () => {
    // Parent is at indent 2, so the child must land at indent 4 regardless of
    // the leading whitespace the caller passed in.
    const src = [
      '- [ ] Top ^t-1',
      '  - [ ] Parent ^t-2',
    ].join('\n');

    const out = serialize(
      insertChild(parse(src), 't-2', '        - [ ] Deep ^t-3'),
    );

    expect(out).toBe(
      [
        '- [ ] Top ^t-1',
        '  - [ ] Parent ^t-2',
        '    - [ ] Deep ^t-3',
      ].join('\n'),
    );
  });
});

describe('insertSibling', () => {
  it('inserts at the same indent after the target block', () => {
    const src = [
      '- [ ] Target ^t-1',
      '  - [ ] Targets child ^t-2',
      '- [ ] After ^t-3',
    ].join('\n');

    const out = serialize(
      insertSibling(parse(src), 't-1', '- [ ] New sibling ^t-new'),
    );

    // The new sibling lands AFTER t-1's descendant block (past t-2), at indent 0.
    expect(out).toBe(
      [
        '- [ ] Target ^t-1',
        '  - [ ] Targets child ^t-2',
        '- [ ] New sibling ^t-new',
        '- [ ] After ^t-3',
      ].join('\n'),
    );
  });

  it('matches the target indent for a nested sibling', () => {
    const src = [
      '- [ ] Top ^t-1',
      '  - [ ] Nested target ^t-2',
      '- [ ] Bottom ^t-3',
    ].join('\n');

    const out = serialize(
      insertSibling(parse(src), 't-2', '- [ ] Nested new ^t-4'),
    );

    expect(out).toBe(
      [
        '- [ ] Top ^t-1',
        '  - [ ] Nested target ^t-2',
        '  - [ ] Nested new ^t-4',
        '- [ ] Bottom ^t-3',
      ].join('\n'),
    );
  });
});

describe('moveBlock', () => {
  it('moves a parent WITH children up, keeping the whole block attached', () => {
    const src = [
      '- [ ] First ^t-1',
      '  - [ ] First child ^t-1a',
      '- [ ] Second ^t-2',
      '  - [ ] Second child ^t-2a',
      '    > a note under the second child',
      '  - [ ] Second child 2 ^t-2b',
      '- [ ] Third ^t-3',
    ].join('\n');

    const out = serialize(moveBlock(parse(src), 't-2', 'up'));

    // The whole Second block (children + note) hops above the whole First block.
    expect(out).toBe(
      [
        '- [ ] Second ^t-2',
        '  - [ ] Second child ^t-2a',
        '    > a note under the second child',
        '  - [ ] Second child 2 ^t-2b',
        '- [ ] First ^t-1',
        '  - [ ] First child ^t-1a',
        '- [ ] Third ^t-3',
      ].join('\n'),
    );
  });

  it('moves a parent WITH children down past the next sibling block', () => {
    const src = [
      '- [ ] First ^t-1',
      '  - [ ] First child ^t-1a',
      '- [ ] Second ^t-2',
      '  - [ ] Second child ^t-2a',
      '- [ ] Third ^t-3',
    ].join('\n');

    const out = serialize(moveBlock(parse(src), 't-1', 'down'));

    // First (and its child) lands after the entire Second block, before Third.
    expect(out).toBe(
      [
        '- [ ] Second ^t-2',
        '  - [ ] Second child ^t-2a',
        '- [ ] First ^t-1',
        '  - [ ] First child ^t-1a',
        '- [ ] Third ^t-3',
      ].join('\n'),
    );
  });

  it('children/notes/comments travel with their parent (down)', () => {
    const src = [
      '- [ ] Alpha ^t-1',
      '  - [ ] Alpha child ^t-1a',
      '  > a note hanging under Alpha',
      '  {>> @ai: a comment on Alpha <<}',
      '- [ ] Beta ^t-2',
      '- [ ] Gamma ^t-3',
    ].join('\n');

    const out = serialize(moveBlock(parse(src), 't-1', 'down'));

    expect(out).toBe(
      [
        '- [ ] Beta ^t-2',
        '- [ ] Alpha ^t-1',
        '  - [ ] Alpha child ^t-1a',
        '  > a note hanging under Alpha',
        '  {>> @ai: a comment on Alpha <<}',
        '- [ ] Gamma ^t-3',
      ].join('\n'),
    );
  });

  it('moving a leaf swaps just that leaf, not its siblings block', () => {
    const src = [
      '- [ ] Parent ^t-1',
      '  - [ ] Leaf A ^t-2',
      '  - [ ] Leaf B ^t-3',
      '  - [ ] Leaf C ^t-4',
    ].join('\n');

    const out = serialize(moveBlock(parse(src), 't-3', 'up'));

    // Leaf B swaps with Leaf A only; Parent and Leaf C are untouched.
    expect(out).toBe(
      [
        '- [ ] Parent ^t-1',
        '  - [ ] Leaf B ^t-3',
        '  - [ ] Leaf A ^t-2',
        '  - [ ] Leaf C ^t-4',
      ].join('\n'),
    );
  });

  it('a nested leaf moves down past its next same-indent sibling only', () => {
    const src = [
      '- [ ] Parent ^t-1',
      '  - [ ] Leaf A ^t-2',
      '  - [ ] Leaf B ^t-3',
    ].join('\n');

    const out = serialize(moveBlock(parse(src), 't-2', 'down'));

    expect(out).toBe(
      [
        '- [ ] Parent ^t-1',
        '  - [ ] Leaf B ^t-3',
        '  - [ ] Leaf A ^t-2',
      ].join('\n'),
    );
  });

  it('move up at the TOP of a sibling run is a no-op (fresh Doc)', () => {
    const src = [
      '- [ ] First ^t-1',
      '  - [ ] Child ^t-1a',
      '- [ ] Second ^t-2',
    ].join('\n');
    const doc = parse(src);

    const next = moveBlock(doc, 't-1', 'up');

    expect(serialize(next)).toBe(src);
    expect(next).not.toBe(doc);
    expect(next.nodes).not.toBe(doc.nodes);
  });

  it('move down at the BOTTOM of a sibling run is a no-op (fresh Doc)', () => {
    const src = [
      '- [ ] First ^t-1',
      '- [ ] Last ^t-2',
      '  - [ ] Last child ^t-2a',
    ].join('\n');
    const doc = parse(src);

    const next = moveBlock(doc, 't-2', 'down');

    expect(serialize(next)).toBe(src);
    expect(next).not.toBe(doc);
  });

  it('a task cannot move up across a section heading (no-op, symmetric with down)', () => {
    // Down is already a no-op (the heading stops A's block), so up must be too —
    // otherwise B jumps its section boundary and orphans the heading.
    const src = ['- [ ] A ^a', '# Section', '- [ ] B ^b'].join('\n');
    const doc = parse(src);

    expect(serialize(moveBlock(doc, 'a', 'down'))).toBe(src);
    const upB = moveBlock(doc, 'b', 'up');
    expect(serialize(upB)).toBe(src);
    expect(upB).not.toBe(doc);
    expect(upB.nodes).not.toBe(doc.nodes);
  });

  it('a task cannot move up out of its own section into the section above', () => {
    const src = ['# H1', '- [ ] A ^a', '# H2', '- [ ] B ^b'].join('\n');

    // B under H2 must not tear up into H1, leaving H2 empty and trailing.
    expect(serialize(moveBlock(parse(src), 'b', 'up'))).toBe(src);
  });

  it('the first child cannot move up past its parent (no-op)', () => {
    const src = [
      '- [ ] Parent ^t-1',
      '  - [ ] Only child ^t-2',
      '- [ ] Sibling ^t-3',
    ].join('\n');

    const out = serialize(moveBlock(parse(src), 't-2', 'up'));

    expect(out).toBe(src);
  });

  it('the last child cannot move down past its parent boundary (no-op)', () => {
    const src = [
      '- [ ] Parent ^t-1',
      '  - [ ] Only child ^t-2',
      '- [ ] Sibling ^t-3',
    ].join('\n');

    const out = serialize(moveBlock(parse(src), 't-2', 'down'));

    // The next node after the child block is the shallower Sibling, not a
    // same-indent sibling, so there is nothing to swap with.
    expect(out).toBe(src);
  });

  it('leaves the doc unchanged (fresh Doc) for an unknown id', () => {
    const src = ['- [ ] Only ^t-1'].join('\n');
    const doc = parse(src);

    const next = moveBlock(doc, 'nope', 'up');

    expect(serialize(next)).toBe(src);
    expect(next).not.toBe(doc);
    expect(next.nodes).not.toBe(doc.nodes);
  });
});

describe('moveBlockTo (drag reorder)', () => {
  it('moves a block AFTER a later sibling, carrying its subtree', () => {
    const src = [
      '- [ ] First ^t-1',
      '  - [ ] First child ^t-1a',
      '- [ ] Second ^t-2',
      '- [ ] Third ^t-3',
    ].join('\n');

    const out = serialize(moveBlockTo(parse(src), 't-1', 't-3', 'after'));

    expect(out).toBe(
      [
        '- [ ] Second ^t-2',
        '- [ ] Third ^t-3',
        '- [ ] First ^t-1',
        '  - [ ] First child ^t-1a',
      ].join('\n'),
    );
  });

  it('moves a block BEFORE an earlier sibling', () => {
    const src = ['- [ ] First ^t-1', '- [ ] Second ^t-2', '- [ ] Third ^t-3'].join('\n');
    const out = serialize(moveBlockTo(parse(src), 't-3', 't-1', 'before'));
    expect(out).toBe(
      ['- [ ] Third ^t-3', '- [ ] First ^t-1', '- [ ] Second ^t-2'].join('\n'),
    );
  });

  it('reorders leaves among their siblings (before)', () => {
    const src = [
      '- [ ] Parent ^t-1',
      '  - [ ] Leaf A ^t-2',
      '  - [ ] Leaf B ^t-3',
      '  - [ ] Leaf C ^t-4',
    ].join('\n');
    const out = serialize(moveBlockTo(parse(src), 't-4', 't-2', 'before'));
    expect(out).toBe(
      [
        '- [ ] Parent ^t-1',
        '  - [ ] Leaf C ^t-4',
        '  - [ ] Leaf A ^t-2',
        '  - [ ] Leaf B ^t-3',
      ].join('\n'),
    );
  });

  it('dropping onto itself is a no-op (fresh Doc)', () => {
    const src = ['- [ ] First ^t-1', '- [ ] Second ^t-2'].join('\n');
    const doc = parse(src);
    const next = moveBlockTo(doc, 't-1', 't-1', 'after');
    expect(serialize(next)).toBe(src);
    expect(next).not.toBe(doc);
  });

  it('dropping into the source own subtree is a no-op', () => {
    const src = ['- [ ] Parent ^t-1', '  - [ ] Child ^t-1a', '- [ ] Other ^t-2'].join('\n');
    const next = moveBlockTo(parse(src), 't-1', 't-1a', 'after');
    expect(serialize(next)).toBe(src);
  });

  it('does NOT move across a heading/section boundary', () => {
    const src = ['# Work', '- [ ] Work task ^t-1', '# Home', '- [ ] Home task ^t-2'].join('\n');
    const next = moveBlockTo(parse(src), 't-1', 't-2', 'after');
    expect(serialize(next)).toBe(src);
  });

  it('does NOT move between different indent levels (not siblings)', () => {
    const src = ['- [ ] Parent ^t-1', '  - [ ] Child ^t-1a', '- [ ] Other ^t-2'].join('\n');
    const next = moveBlockTo(parse(src), 't-2', 't-1a', 'before');
    expect(serialize(next)).toBe(src);
  });

  it('does not accumulate a blank line when dropping after the last task', () => {
    const src = ['- [ ] Alpha ^t-a', '- [ ] Bravo ^t-b', '- [ ] Charlie ^t-c', ''].join('\n');
    const out = serialize(moveBlockTo(parse(src), 't-a', 't-c', 'after'));
    expect(out).toBe(
      ['- [ ] Bravo ^t-b', '- [ ] Charlie ^t-c', '- [ ] Alpha ^t-a', ''].join('\n'),
    );
  });
});
