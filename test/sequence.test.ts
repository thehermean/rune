import { describe, it, expect } from 'vitest';
import { parse, titleOf } from '../src/index';
import { sequence } from '../web/lib/sequence';

function doc(text: string) {
  return parse(text);
}

describe('sequence — ready / blocked / done bands', () => {
  it('orders a simple finish-to-start chain', () => {
    const d = doc(
      [
        '- [x] A done:2026-06-30 ^t-a',
        '- [ ] B after:t-a ^t-b',
        '- [ ] C after:t-b ^t-c',
      ].join('\n'),
    );
    const { ready, blocked, done } = sequence(d);

    expect(done.map((t) => t.id)).toEqual(['t-a']);
    // B's only dep (A) is done -> ready. C waits on B (not done) -> blocked.
    expect(ready.map((t) => t.id)).toEqual(['t-b']);
    expect(blocked.map((b) => b.task.id)).toEqual(['t-c']);
    expect(blocked[0].waitingOn.map((w) => w.id)).toEqual(['t-b']);
  });

  it('treats tasks with no deps (or only unknown deps) as ready', () => {
    const d = doc(['- [ ] A ^t-a', '- [/] B after:t-ghost ^t-b'].join('\n'));
    const { ready, blocked } = sequence(d);
    expect(ready.map((t) => t.id)).toEqual(['t-a', 't-b']);
    expect(blocked).toEqual([]);
  });

  it('blocks a task while ANY dep is unfinished and names every unfinished dep', () => {
    const d = doc(
      [
        '- [x] A done:2026-06-30 ^t-a',
        '- [ ] B ^t-b',
        '- [ ] C after:t-a,t-b ^t-c',
      ].join('\n'),
    );
    const { ready, blocked } = sequence(d);
    expect(ready.map((t) => t.id)).toContain('t-b');
    const c = blocked.find((x) => x.task.id === 't-c');
    expect(c).toBeDefined();
    // Only the UNFINISHED dep (B) is surfaced; the done dep (A) is not.
    expect(c!.waitingOn.map((w) => w.id)).toEqual(['t-b']);
  });

  it('detects a cycle and treats every node in it as blocked (no infinite loop)', () => {
    const d = doc(['- [ ] A after:t-b ^t-a', '- [ ] B after:t-a ^t-b'].join('\n'));
    const { ready, blocked } = sequence(d);
    expect(ready).toEqual([]);
    expect(blocked.map((b) => b.task.id).sort()).toEqual(['t-a', 't-b']);
    // Each is reported as waiting on the other.
    const a = blocked.find((x) => x.task.id === 't-a')!;
    expect(a.waitingOn.map((w) => w.id)).toEqual(['t-b']);
  });

  it('classifies done | cancelled as done; ignores deferred', () => {
    const d = doc(
      ['- [x] A ^t-a', '- [-] B ^t-b', '- [>] C ^t-c', '- [ ] D ^t-d'].join('\n'),
    );
    const { ready, blocked, done } = sequence(d);
    expect(done.map((t) => t.id).sort()).toEqual(['t-a', 't-b']);
    expect(ready.map((t) => t.id)).toEqual(['t-d']);
    expect(blocked).toEqual([]);
  });

  it('matches the shipped example graph', () => {
    const d = doc(
      [
        '- [/] Ship parser v1 ^t-a1b2',
        '- [x] Survey existing formats done:2026-06-30 ^t-a1b3',
        '- [/] Draft grammar after:t-a1b3 ^t-a1b4',
        '- [ ] Review with @alice after:t-a1b4 ^t-a1b5',
        '- [ ] Ship web renderer after:t-a1b4 ^t-a1b6',
      ].join('\n'),
    );
    const { ready, blocked, done } = sequence(d);
    expect(done.map((t) => t.id)).toEqual(['t-a1b3']);
    // a1b2 (no deps) and a1b4 (dep a1b3 done) are ready.
    expect(ready.map((t) => t.id)).toEqual(['t-a1b2', 't-a1b4']);
    // a1b5 and a1b6 both wait on a1b4 (still doing).
    expect(blocked.map((b) => b.task.id)).toEqual(['t-a1b5', 't-a1b6']);
    expect(titleOf(blocked[0].waitingOn[0])).toBe('Draft grammar');
  });
});
