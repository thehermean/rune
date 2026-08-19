// The canonical model. A Doc is an ordered list of Nodes, one per source line.
// Task lines carry a structured, typed segment list; every other line is kept
// verbatim. `raw` holds each line's exact source bytes; the serializer emits it
// verbatim for any node it has not structurally edited, which is what makes
// serialize(parse(x)) === x byte-for-byte for arbitrary input (tabs, doubled or
// trailing spaces, a missing space after `]`, unusual token order all survive).

export type State = 'open' | 'done' | 'doing' | 'cancelled' | 'deferred';

/** The single char inside `[ ]` -> a named state. */
export const STATE_CHARS: Record<string, State> = {
  ' ': 'open',
  x: 'done',
  '/': 'doing',
  '-': 'cancelled',
  '>': 'deferred',
};

export type SegmentKind =
  | 'text' // a plain word of the title / body
  | 'tag' // #tag, #proj/sub
  | 'context' // @place, @person
  | 'priority' // !, !!, !!!
  | 'key' // due:, after:, recur!:, or any unknown key:value
  | 'ref' // [[t-id]] internal reference
  | 'link' // [label](target) or a bare URL
  | 'critic'; // {>> .. <<}, {++ .. ++}, {-- .. --}, {~~ .. ~~}, {== .. ==}

export type CriticKind = 'comment' | 'insert' | 'delete' | 'substitute' | 'highlight';

/** One body token. `raw` is the exact source text (no surrounding spaces); the
 *  other fields are the parsed view, populated by kind. */
export interface Segment {
  kind: SegmentKind;
  raw: string;
  value?: string; // tag/context name · ref id · key value
  key?: string; // for kind 'key' (may end in '!', e.g. 'recur!')
  label?: string; // for kind 'link'
  target?: string; // for kind 'link'
  level?: number; // for kind 'priority' (1..3)
  critic?: CriticKind; // for kind 'critic'
}

export interface TaskNode {
  type: 'task';
  indent: number; // leading spaces
  depth: number; // indent / 2
  state: State;
  stateChar: string; // original char, preserved for exact serialization
  segments: Segment[]; // ordered body tokens (excludes the trailing id)
  id: string | null; // value after the trailing ^, without the caret
  raw: string; // the original line, for reference/debugging
}

/** Every non-task line is preserved verbatim and serialized from `raw`. */
export interface RawNode {
  type: 'blank' | 'heading' | 'html-comment' | 'note' | 'comment' | 'text';
  raw: string;
  indent?: number;
}

export type Node = TaskNode | RawNode;

export interface Doc {
  nodes: Node[];
}
