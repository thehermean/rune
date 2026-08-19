import type { Doc, TaskNode } from './types';

export * from './types';
export { parse, classifyLine, classifySegment, ID_BODY } from './parse';
export { serialize, serializeNode } from './serialize';
export { scanBody } from './scan';

/** All task lines, in document order. */
export function tasks(doc: Doc): TaskNode[] {
  return doc.nodes.filter((n): n is TaskNode => n.type === 'task');
}

export function findById(doc: Doc, id: string): TaskNode | undefined {
  return tasks(doc).find((t) => t.id === id);
}

export function tagsOf(t: TaskNode): string[] {
  return t.segments.filter((s) => s.kind === 'tag').map((s) => s.value ?? '');
}

export function contextsOf(t: TaskNode): string[] {
  return t.segments.filter((s) => s.kind === 'context').map((s) => s.value ?? '');
}

export function priorityOf(t: TaskNode): number {
  return t.segments.find((s) => s.kind === 'priority')?.level ?? 0;
}

export function getKey(t: TaskNode, key: string): string | undefined {
  return t.segments.find((s) => s.kind === 'key' && s.key === key)?.value;
}

/** Dependency ids from `after:a,b` (finish-to-start). */
export function afterOf(t: TaskNode): string[] {
  const v = getKey(t, 'after');
  return v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

export function refsOf(t: TaskNode): string[] {
  return t.segments.filter((s) => s.kind === 'ref').map((s) => s.value ?? '');
}

export function attachmentsOf(t: TaskNode): Array<{ label: string; target: string }> {
  return t.segments
    .filter((s) => s.kind === 'link')
    .map((s) => ({ label: s.label ?? '', target: s.target ?? '' }));
}

/** The title text: the plain words of the body, in order, space-joined. */
export function titleOf(t: TaskNode): string {
  return t.segments
    .filter((s) => s.kind === 'text')
    .map((s) => s.raw)
    .join(' ');
}
