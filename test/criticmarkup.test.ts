import { describe, it, expect } from 'vitest';
import { parse } from '../src/index';
import { comments, commentsFor } from '../src/criticmarkup';

// A sample .rune doc exercising BOTH comment forms plus threading, a resolved
// flag, and an edit-op:
//   - an INLINE {>> comment as a critic segment on task t-1
//   - a STANDALONE {>> comment line under a different task t-2 (anchors to the
//     nearest PRECEDING task), with a reply and a resolved sibling
//   - a standalone {++ ++} edit-op under t-2
const SAMPLE = [
  '# Sample',
  '',
  '- [/] Draft grammar {>> @sam[id=c-10]: needs another pass <<} ^t-1',
  '- [ ] Ship renderer ^t-2',
  '  {>> @ai[id=c-20]: this looks blocked on [[t-1]] <<}',
  '  {>> @sam[id=c-21 reply=c-20]: agreed, sequence it first <<}',
  '  {>> @ai[id=c-22 resolved]: resolved after the merge <<}',
  '  {++ added signed read scope ++}',
].join('\n');

const doc = parse(SAMPLE);

describe('comments — parsing and anchoring', () => {
  it('parses both forms with correct itemId anchoring', () => {
    const all = comments(doc);

    const inline = all.find((c) => c.commentId === 'c-10');
    expect(inline).toBeDefined();
    // An inline critic segment anchors to its OWN task line's ^id.
    expect(inline?.itemId).toBe('t-1');
    expect(inline?.author).toBe('sam');
    expect(inline?.body).toBe('needs another pass');
    expect(inline?.kind).toBe('comment');

    const standalone = all.find((c) => c.commentId === 'c-20');
    expect(standalone).toBeDefined();
    // A standalone {>> line anchors to the nearest PRECEDING task line's ^id.
    expect(standalone?.itemId).toBe('t-2');
    expect(standalone?.author).toBe('ai');
    expect(standalone?.body).toBe('this looks blocked on [[t-1]]');
  });

  it('strips the leading @ from the author', () => {
    const inline = comments(doc).find((c) => c.commentId === 'c-10');
    expect(inline?.author).toBe('sam');
    expect(inline?.author.startsWith('@')).toBe(false);
  });

  it('threads replies via the reply attribute', () => {
    const reply = comments(doc).find((c) => c.commentId === 'c-21');
    expect(reply?.reply).toBe('c-20');
    expect(reply?.itemId).toBe('t-2');
  });

  it('parses resolved=true from the bare flag', () => {
    const r = comments(doc).find((c) => c.commentId === 'c-22');
    expect(r?.resolved).toBe(true);
    // Non-resolved comments do not get a stray truthy flag.
    const open = comments(doc).find((c) => c.commentId === 'c-10');
    expect(open?.resolved).toBeFalsy();
  });

  it('parses edit-op kinds with the inner text as body', () => {
    const ops = comments(doc).filter((c) => c.kind !== 'comment');
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('insert');
    expect(ops[0].body).toBe('added signed read scope');
    // The edit-op anchors to the same preceding task as the standalone comments.
    expect(ops[0].itemId).toBe('t-2');
  });
});

describe('commentsFor — filtering by item', () => {
  it('returns only the comments anchored to the given item', () => {
    expect(commentsFor(doc, 't-1').map((c) => c.commentId)).toEqual(['c-10']);

    const t2 = commentsFor(doc, 't-2');
    expect(
      t2
        .filter((c) => c.kind === 'comment')
        .map((c) => c.commentId)
        .sort(),
    ).toEqual(['c-20', 'c-21', 'c-22']);
    // The edit-op is also anchored to t-2 (its commentId is auto-generated).
    expect(t2.filter((c) => c.kind === 'insert')).toHaveLength(1);
  });

  it('returns [] for an item with no comments', () => {
    expect(commentsFor(doc, 't-nope')).toEqual([]);
  });
});

describe('unclosed critic blocks do not mint phantom comments', () => {
  it('an unclosed standalone `{>>` yields no comment (no empty auto-id)', () => {
    const src = ['- [ ] Task ^t-9', '  {>> a note with no closer'].join('\n');
    expect(comments(parse(src))).toHaveLength(0);
  });

  it('an unclosed inline `{>>` is plain text, not a critic comment', () => {
    // With the classifier fix the segment is text, so it never reaches unwrap;
    // this pins that no comment is produced either way.
    const src = '- [ ] Draft {>>unclosed inline ^t-1';
    expect(comments(parse(src))).toHaveLength(0);
  });

  it('a properly closed block still parses to exactly one comment', () => {
    const src = '- [ ] Draft {>> @ai[id=c-1]: closed <<} ^t-1';
    const all = comments(parse(src));
    expect(all).toHaveLength(1);
    expect(all[0].commentId).toBe('c-1');
  });
});

describe('empty id= falls through to a distinct auto id', () => {
  it('treats an empty id like a missing one and mints DISTINCT auto ids', () => {
    const src = [
      '- [ ] Task ^t-9',
      '  {>> @a[id=]: first <<}',
      '  {>> @b[id=]: second <<}',
    ].join('\n');
    const all = comments(parse(src));
    expect(all).toHaveLength(2);
    // Neither comment keeps an empty commentId...
    expect(all[0].commentId).not.toBe('');
    expect(all[1].commentId).not.toBe('');
    // ...and the two auto-generated ids are distinct.
    expect(all[0].commentId).not.toBe(all[1].commentId);
    // Bodies still parse from the head correctly.
    expect(all[0].body).toBe('first');
    expect(all[1].body).toBe('second');
  });
});
