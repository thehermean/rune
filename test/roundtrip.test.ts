import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, serialize } from '../src/index';

const example = readFileSync(new URL('../examples/work.rune', import.meta.url), 'utf8');

describe('round-trip', () => {
  it('serialize(parse(x)) === x for the canonical example, byte-for-byte', () => {
    expect(serialize(parse(example))).toBe(example);
  });

  it('round-trips a representative line of every kind', () => {
    const lines = [
      '- [ ] Plain task',
      '- [x] Done #tag @ctx !! due:2026-07-01 ^t-001',
      '  - [/] Nested after:t-001 [[t-002]] [doc](./a/b.md) ^t-003',
      '    {>> @ai[id=c-1]: a note with spaces and -- dashes <<}',
      '- [ ] Quoted recur!:"every other monday" ^t-9',
      '- [ ] Inline {++ added ++} and {~~ a~>b ~~} edits ^t-x',
      '- [-] Cancelled #later',
      '- [>] Deferred scheduled:2026-08-01 ^t-z',
      '# A heading line @nope due:nope',
      '<!-- rune v1 -->',
      '  > a plain note',
      '',
    ];
    for (const l of lines) {
      expect(serialize(parse(l)), l).toBe(l);
    }
  });

  it('preserves unknown keys untouched (preserved-but-ignored)', () => {
    const l = '- [ ] Task weirdkey:whatever zone:emea ^t-z';
    expect(serialize(parse(l))).toBe(l);
  });

  it('preserves a trailing newline', () => {
    const text = '- [ ] one ^t-1\n- [ ] two ^t-2\n';
    expect(serialize(parse(text))).toBe(text);
  });

  it('preserves token order even when not canonical', () => {
    // `^id` is forced last on serialize, but other tokens keep their order.
    const l = '- [ ] Order #b @a !!! due:2026-01-01 #c ^t-7';
    expect(serialize(parse(l))).toBe(l);
  });

  it('is byte-lossless for legal-but-non-canonical lines (opening a hand-edit is a no-op)', () => {
    // types.ts promises serialize(parse(x)) === x for arbitrary input. These are
    // the nasty lines that previously got silently rewritten (phantom git diffs):
    const nasty = [
      '\t- [ ] tab-indented task ^t-1', // tab indentation
      '- [x]done', // missing space after `]`
      '- [ ] doubled   internal   spaces ^t-2', // collapsed on old serialize
      '- [ ] trailing spaces kept   ', // trailing whitespace dropped on old serialize
      '- [ ] measure 2 ^70kg', // caret-word that is NOT an id -> stays title text
      '- [ ] unknownkey:whatever oddKey:1 ^t-3', // preserved-but-ignored keys
      '   - [/] odd 3-space indent ^t-4', // non-even indent
      '- [ ] a {NOT_A_COMMENT} b ^t-5', // a `{token}` that is not real CriticMarkup
      '- [ ] unclosed {>> comment kept as text ^t-6', // unclosed critic -> text
      '- [ ] trailing CR survives ^t-7\r', // a stray CR (CRLF split) is preserved verbatim
    ];
    for (const l of nasty) {
      expect(serialize(parse(l)), l).toBe(l);
    }
  });

  it('round-trips a whole multi-line doc mixing canonical and non-canonical lines', () => {
    const text = [
      '# Heading',
      '\t- [x]done ^t-1',
      '- [ ] a  b   c ^t-2',
      '  > a note   with spaces',
      '- [ ] measure 2 ^70kg',
      '',
    ].join('\n');
    expect(serialize(parse(text))).toBe(text);
  });
});
