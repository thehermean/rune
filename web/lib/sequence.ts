// Sequence — resolve the `after:` (finish-to-start) dependency graph.
//
// The payoff view of a dependency-aware format (BRIEF §5): surface what's
// unblocked NOW, and dim what is still waiting (with the exact unfinished
// predecessors named).
//
// Buckets:
//   done    — the task's own state is done | cancelled.
//   ready   — open | doing AND every after: dep is DONE (or it has no deps /
//             only unknown deps). Emitted in a stable topological order: a ready
//             task never appears before a ready dep of its own. (In practice a
//             ready task's deps are all done, so this is document order; the
//             topological guard is kept for robustness against unknown states.)
//   blocked — open | doing with >= 1 unfinished (or cyclic) dep; each carries
//             waitingOn = the unfinished dependency TaskNodes.
//
// Unknown dep ids (no matching ^id in the doc) are ignored. Cycles never loop
// forever: readiness is decided per task by a single lookup of each dep's own
// state, so a dependency cycle simply leaves every node in it blocked.

import type { Doc, TaskNode } from '@core';
import { tasks, findById, afterOf } from '@core';

export interface SequenceResult {
  ready: TaskNode[];
  blocked: Array<{ task: TaskNode; waitingOn: TaskNode[] }>;
  done: TaskNode[];
}

function isDone(t: TaskNode): boolean {
  return t.state === 'done' || t.state === 'cancelled';
}

function isActive(t: TaskNode): boolean {
  return t.state === 'open' || t.state === 'doing';
}

/** Resolve the `after:` graph into ready / blocked / done bands. */
export function sequence(doc: Doc): SequenceResult {
  const all = tasks(doc);

  // done = done|cancelled; pending = open|doing (in document order). Any other
  // state (e.g. deferred) belongs to none of the three bands and is omitted.
  const done: TaskNode[] = [];
  const pending: TaskNode[] = [];
  for (const t of all) {
    if (isDone(t)) done.push(t);
    else if (isActive(t)) pending.push(t);
  }

  // The unfinished deps of a task: each distinct after: id that resolves to a
  // task which is NOT done. Unknown ids (no match in the doc) are ignored.
  const unfinishedDeps = (t: TaskNode): TaskNode[] => {
    const seen = new Set<string>();
    const out: TaskNode[] = [];
    for (const depId of afterOf(t)) {
      if (seen.has(depId)) continue;
      seen.add(depId);
      const dep = findById(doc, depId);
      if (dep && !isDone(dep)) out.push(dep);
    }
    return out;
  };

  // A pending task is ready iff it has no unfinished deps; otherwise blocked.
  const readySet: TaskNode[] = [];
  const blocked: Array<{ task: TaskNode; waitingOn: TaskNode[] }> = [];
  for (const t of pending) {
    const waitingOn = unfinishedDeps(t);
    if (waitingOn.length === 0) readySet.push(t);
    else blocked.push({ task: t, waitingOn });
  }

  // Stable topological order over the ready set, deps before dependents. Ready
  // tasks have only done deps (which are not in this set), so the ordering is
  // already valid; we run a defensive Kahn pass that preserves document order
  // and, in the impossible event of a residual cycle, appends the rest as-is.
  const ready = topoOrder(readySet);

  return { ready, blocked, done };
}

/** Stable topological sort honoring after: edges that point WITHIN `set`. */
function topoOrder(set: TaskNode[]): TaskNode[] {
  const inSet = new Map<string, TaskNode>();
  for (const t of set) if (t.id != null) inSet.set(t.id, t);

  const emitted = new Set<TaskNode>();
  const out: TaskNode[] = [];

  let progressed = true;
  while (progressed && out.length < set.length) {
    progressed = false;
    for (const t of set) {
      if (emitted.has(t)) continue;
      const depsReady = afterOf(t)
        .map((id) => inSet.get(id))
        .every((d) => d == null || emitted.has(d));
      if (depsReady) {
        out.push(t);
        emitted.add(t);
        progressed = true;
      }
    }
  }
  // Any residual (cyclic) members keep their document order.
  for (const t of set) if (!emitted.has(t)) out.push(t);
  return out;
}
