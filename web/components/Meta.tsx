// Meta — quiet inline mute-ink metadata for a task row.
//
// ANTI-CLUTTER (LOCKED): absent metadata renders NOTHING. Metadata is quiet
// inline mute-ink text, NOT chips/pills. Overdue is a desaturated --danger ink
// tint on the DATE ONLY — never a badge or a count. A dep/ref/attachment/comment
// is a single small marker, not a row of icons.

import type { TaskNode } from '@core';
import {
  tagsOf,
  contextsOf,
  priorityOf,
  getKey,
  afterOf,
  refsOf,
  attachmentsOf,
} from '@core';
import { formatShort, isOverdue } from '../lib/dates';
import { clsx } from 'clsx';

export interface MetaProps {
  task: TaskNode;
  /** "now" for overdue tinting; defaults to the real clock. */
  now?: Date;
}

export function Meta({ task, now = new Date() }: MetaProps): JSX.Element | null {
  const tags = tagsOf(task);
  const contexts = contextsOf(task);
  const prio = priorityOf(task);
  const due = getKey(task, 'due');
  const scheduled = getKey(task, 'scheduled') ?? getKey(task, 'start');
  const recur = getKey(task, 'recur') ?? getKey(task, 'recur!');
  const deps = afterOf(task);
  const refs = refsOf(task);
  const attachments = attachmentsOf(task);

  // Comment count: critic segments of kind 'comment'.
  const comments = task.segments.filter((s) => s.kind === 'critic' && s.critic === 'comment').length;
  const suggestions = task.segments.filter((s) => s.kind === 'critic' && s.critic !== 'comment').length;

  const hasAny =
    tags.length ||
    contexts.length ||
    prio > 0 ||
    due ||
    scheduled ||
    recur ||
    deps.length ||
    refs.length ||
    attachments.length ||
    comments ||
    suggestions;

  // Absent metadata renders NOTHING.
  if (!hasAny) return null;

  return (
    <span className="rune-meta">
      {tags.map((t) => (
        <span key={`tag-${t}`} className="rune-meta-tag">
          #{t}
        </span>
      ))}
      {contexts.map((c) => (
        <span key={`ctx-${c}`} className="rune-meta-ctx">
          @{c}
        </span>
      ))}
      {prio > 0 && <span className="rune-meta-prio">{'!'.repeat(prio)}</span>}
      {due && (
        <span className={clsx('rune-meta-date', isOverdue(due, now) && 'is-overdue')}>
          {formatShort(due, now)}
        </span>
      )}
      {!due && scheduled && (
        <span className="rune-meta-date rune-meta-soft">{formatShort(scheduled, now)}</span>
      )}
      {recur && <span className="rune-meta-recur">↻ {recur}</span>}
      {deps.length > 0 && <span className="rune-meta-marker" title={`after ${deps.join(', ')}`}>after</span>}
      {refs.length > 0 && <span className="rune-meta-marker" title={refs.join(', ')}>↔</span>}
      {attachments.length > 0 && (
        <span className="rune-meta-marker" title={attachments.map((a) => a.label).join(', ')}>
          ◇
        </span>
      )}
      {comments > 0 && <span className="rune-meta-marker" title={`${comments} comment(s)`}>{comments}💬</span>}
      {suggestions > 0 && <span className="rune-meta-marker" title={`${suggestions} suggestion(s)`}>±</span>}
    </span>
  );
}
