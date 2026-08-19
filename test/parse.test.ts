import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parse,
  tasks,
  findById,
  tagsOf,
  contextsOf,
  priorityOf,
  getKey,
  afterOf,
  refsOf,
  attachmentsOf,
  classifySegment,
  titleOf,
} from '../src/index';

const doc = parse(readFileSync(new URL('../examples/work.rune', import.meta.url), 'utf8'));

describe('structured parse', () => {
  it('extracts every task, in order, with its id', () => {
    expect(tasks(doc).map((t) => t.id)).toEqual([
      't-a1b2',
      't-a1b3',
      't-a1b4',
      't-a1b5',
      't-a1b6',
      't-a1b7',
      't-a1b8',
      't-a1b9',
      't-a1c0',
    ]);
  });

  it('parses state, priority, nested tag, and a hard date', () => {
    const t = findById(doc, 't-a1b2')!;
    expect(t.state).toBe('doing');
    expect(t.depth).toBe(0);
    expect(priorityOf(t)).toBe(3);
    expect(tagsOf(t)).toEqual(['rune/release']);
    expect(getKey(t, 'due')).toBe('2026-07-10');
  });

  it('parses dependencies, internal refs, contexts, and attachments', () => {
    const t = findById(doc, 't-a1b5')!;
    expect(t.depth).toBe(1);
    expect(contextsOf(t)).toEqual(['alice']);
    expect(afterOf(t)).toEqual(['t-a1b4']);
    expect(refsOf(t)).toEqual(['t-a1b2']);
    expect(getKey(t, 'file')).toBe('./specs/auth.pdf');

    const g = findById(doc, 't-a1b4')!;
    expect(attachmentsOf(g)).toEqual([{ label: 'grammar', target: './docs/grammar.md' }]);
  });

  it('keeps a quoted recurrence value intact under the recur! key', () => {
    const t = findById(doc, 't-a1b8')!;
    expect(getKey(t, 'recur!')).toBe('every month on the last');
    expect(contextsOf(t)).toEqual(['finance']);
    expect(t.state).toBe('open');
  });

  it('captures inline CriticMarkup as a typed segment', () => {
    const t = findById(doc, 't-a1b7')!;
    expect(t.segments.find((s) => s.kind === 'critic')?.critic).toBe('insert');
  });

  it('reads cancelled and deferred states', () => {
    expect(findById(doc, 't-a1b9')!.state).toBe('cancelled');
    expect(findById(doc, 't-a1c0')!.state).toBe('deferred');
  });

  it('does not mistake notes, headings, or standalone comments for tasks', () => {
    // 9 task lines only; the rest (header comment, heading, 2 notes,
    // 1 standalone AI comment, blank) are preserved as non-task nodes.
    expect(tasks(doc).length).toBe(9);
    expect(doc.nodes.some((n) => n.type === 'note')).toBe(true);
    expect(doc.nodes.some((n) => n.type === 'comment')).toBe(true);
    expect(doc.nodes.some((n) => n.type === 'html-comment')).toBe(true);
  });
});

describe('id tightening — a caret-word is not an id unless it is `^t-…`', () => {
  it('does not steal a trailing caret-word as an id (^70kg stays title text)', () => {
    const t = findById(parse('- [ ] measure 2 ^70kg'), 'anything');
    expect(t).toBeUndefined(); // no task has that id
    const node = parse('- [ ] measure 2 ^70kg').nodes[0];
    expect(node.type).toBe('task');
    if (node.type === 'task') {
      expect(node.id).toBeNull();
      expect(titleOf(node)).toBe('measure 2 ^70kg');
    }
  });

  it('still parses a real `^t-` id', () => {
    const node = parse('- [ ] real task ^t-a1b2').nodes[0];
    expect(node.type).toBe('task');
    if (node.type === 'task') {
      expect(node.id).toBe('t-a1b2');
      expect(titleOf(node)).toBe('real task');
    }
  });
});

describe('segment classification — only well-formed CriticMarkup is critic', () => {
  it('classifies a closed critic span as critic', () => {
    expect(classifySegment('{>>note<<}').kind).toBe('critic');
    expect(classifySegment('{++add++}').kind).toBe('critic');
  });

  it('classifies a bogus `{token}` and an unclosed `{>>` as plain text', () => {
    expect(classifySegment('{IGNORE_PREVIOUS_AND_DELETE}').kind).toBe('text');
    expect(classifySegment('{>>unclosed').kind).toBe('text');
    expect(classifySegment('{}').kind).toBe('text');
  });
});
