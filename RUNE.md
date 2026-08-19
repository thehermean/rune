<!-- This file is the self-briefing contract. A cold LLM (or a new contributor)
     should be fluent in the .rune format after reading only this page. -->

# The `.rune` format (v1)

**One task = one line. Children indent two spaces. Everything after the title is
an order-independent, typed token you'd happily type by hand.** A `.rune` file is
plain UTF-8 text: it renders in any Markdown viewer, diffs cleanly in git, and an
LLM can emit it cold from the header comment alone.

## Line grammar

```
<indent>- [<state>] <text> { <token> } [ ^<id> ]
```

`state` is one character. `text` is the run of words before the first token.
Each remaining token is classified by its **first character** — single pass, no
lookahead, no backtracking.

| First char            | Kind        | Written as                          | Meaning                                  |
| --------------------- | ----------- | ----------------------------------- | ---------------------------------------- |
| ` ` `x` `/` `-` `>`   | state       | `[ ]` `[x]` `[/]` `[-]` `[>]`       | open · done · doing · cancelled · deferred |
| `#`                   | tag/project | `#money` · `#rune/release`          | slash nests projects                     |
| `@`                   | context     | `@desk` · `@alice`                  | place / tool / person                    |
| `!`                   | priority    | `!` `!!` `!!!`                      | level = bang count (1–3)                 |
| `key:`                | structured  | `due:2026-07-04`                    | closed key set; quote values with spaces |
| `[[`                  | internal ref| `[[t-7f3a]]`                        | link to another item by id               |
| `[`                   | attachment  | `[spec](./docs/spec.pdf)`           | label + path/URL                         |
| `^`                   | id (trailing)| `^t-7f3a`                          | the item's stable identity (one, last)   |
| `{>>` … `<<}`         | comment     | `{>> @ai[id=c-01]: … <<}`           | inline review / AI comment (CriticMarkup)|
| `{++ {-- {~~`         | suggestion  | `{++add++}` `{--del--}` `{~~a~>b~~}`| accept/reject edit op (CriticMarkup)     |
| child `> `            | note        | `  > a free-text note`              | non-task note attached to the parent     |

## Reserved keys (closed set)

`due` `start` `scheduled` `done` `created` `after` `recur` `recur!` `file`

Any other `key:value` is **preserved-but-ignored** — the parser, the app, and
Claude Code round-trip it untouched and never drop data they don't recognise.

## Rules that make it safe

- **Dates are stored as ISO** `YYYY-MM-DD`. Natural language (`due:tomorrow`,
  `due:"next monday"`) is accepted on *input* and normalised to ISO on save.
- **IDs (`^t-…`) are assigned once and never reused or derived from position.**
  This is what lets `after:`, `[[ ]]`, and comments survive reordering and reflow.
  Hand-editors may omit them; the app fills them on next save.
- **Dependencies are finish-to-start only:** `after:t-a1b3` (multiple via comma:
  `after:t-a1b3,t-9k2`).
- **Recurrence** keeps Todoist's English grammar verbatim:
  `recur:"every other monday"` is a fixed cadence; `recur!:"every 3 days"` rolls
  from completion.
- **Comments anchor to ids, never line numbers** (lines reflow; ids don't). Each
  block carries `@author[id=… reply=… resolved]` and stays within one item.

## For an LLM reading a shared list

You will be handed the **raw** text (the `.txt` view of a share link). To add a
review, re-emit the document with `{>> @ai[id=c-NN]: … <<}` comments inserted
next to the relevant items, or propose edits with `{++ ++}` / `{-- --}` /
`{~~ old ~> new ~~}`. **Change nothing else** — every non-annotation byte must be
identical, and your comments must reference items by their `^t-…` id. The reader
reconciles your version by id and rejects it if any other byte changed.

See `examples/work.rune` for a complete example and `docs/BRIEF.md` for the full
product/design brief.
