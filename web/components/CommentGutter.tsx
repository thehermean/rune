// CommentGutter — Wave 2 / M5 part 1; made interactive in Wave 5.
//
// A right-margin threaded gutter for one item's comments. The reading text never
// moves; discussion lives in the margin. Read comments via commentsFor(doc,id).
//
// Anti-clutter (CONTRACTS §3): render NOTHING when the item has no comments.
// Threads group by reply chains; @ai is distinguished from humans by a restrained
// thin left edge (var(--accent) for @ai, var(--mute) for humans) — not a badge.
// Resolved threads hide behind a small "show resolved" toggle. Edit-op comments
// render inline-styled: insert underlined, delete struck-through. Tokens only.
//
// Wave 5: optional onReply / onResolve make each thread actionable — a quiet
// Reply control (opens a tiny inline composer) and a Resolve toggle per thread.
// When neither handler is provided the gutter stays purely a display surface.

import { useState } from 'react';
import type { Doc } from '@core';
import { commentsFor, type Comment } from '@core/criticmarkup';
import { clsx } from 'clsx';

export interface CommentGutterProps {
  doc: Doc;
  /** The item whose comment thread to show; null = nothing. */
  itemId: string | null;
  /** Reply to a thread (parent = the thread root's comment id). Optional. */
  onReply?: (parentCommentId: string, body: string) => void;
  /** Mark a thread resolved/unresolved (by the root's comment id). Optional. */
  onResolve?: (commentId: string, resolved: boolean) => void;
}

interface Thread {
  root: Comment;
  replies: Comment[];
  resolved: boolean;
}

/** Group flat comments into reply-rooted threads in source order. */
function buildThreads(list: Comment[]): Thread[] {
  const byId = new Map<string, Comment>();
  for (const c of list) byId.set(c.commentId, c);

  const childrenOf = new Map<string, Comment[]>();
  const roots: Comment[] = [];
  for (const c of list) {
    if (c.reply && byId.has(c.reply)) {
      const arr = childrenOf.get(c.reply) ?? [];
      arr.push(c);
      childrenOf.set(c.reply, arr);
    } else {
      roots.push(c);
    }
  }

  return roots.map((root) => {
    // Flatten the reply subtree (depth-first) into an ordered list.
    const replies: Comment[] = [];
    const walk = (id: string): void => {
      for (const child of childrenOf.get(id) ?? []) {
        replies.push(child);
        walk(child.commentId);
      }
    };
    walk(root.commentId);
    const resolved = root.resolved === true || replies.some((r) => r.resolved === true);
    return { root, replies, resolved };
  });
}

function isAi(author: string): boolean {
  return author.toLowerCase() === 'ai';
}

function Card({ c }: { c: Comment }): JSX.Element {
  const ai = isAi(c.author);
  return (
    <div
      className={clsx('rune-comment-card', {
        'is-ai': ai,
        'is-human': !ai && c.kind === 'comment',
        [`is-${c.kind}`]: c.kind !== 'comment',
      })}
    >
      {c.kind === 'comment' ? (
        <>
          {c.author && <span className="rune-comment-author">@{c.author}</span>}
          <span className="rune-comment-body">{c.body}</span>
        </>
      ) : (
        <span className={clsx('rune-comment-body', `rune-op-${c.kind}`)}>{c.body}</span>
      )}
    </div>
  );
}

/** A tiny inline composer for a reply, shown when the Reply control is toggled. */
function ReplyComposer({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [body, setBody] = useState('');
  function submit(): void {
    const trimmed = body.trim();
    if (trimmed) onSubmit(trimmed);
    setBody('');
  }
  return (
    <div className="rune-comment-composer rune-comment-reply-composer">
      <textarea
        className="rune-comment-input"
        value={body}
        placeholder="Reply…"
        rows={2}
        spellCheck={false}
        autoFocus
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="rune-comment-composer-actions">
        <button type="button" className="rune-comment-send" onClick={submit}>
          Reply
        </button>
        <button type="button" className="rune-comment-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ThreadView({
  thread,
  onReply,
  onResolve,
}: {
  thread: Thread;
  onReply?: (parentCommentId: string, body: string) => void;
  onResolve?: (commentId: string, resolved: boolean) => void;
}): JSX.Element {
  const ai = isAi(thread.root.author);
  const [replying, setReplying] = useState(false);
  const interactive = !!onReply || !!onResolve;

  return (
    <div
      className={clsx('rune-comment-thread', ai ? 'edge-ai' : 'edge-human')}
      style={{ borderRadius: 'var(--radius-card)' }}
    >
      <Card c={thread.root} />
      {thread.replies.map((r) => (
        <div key={r.commentId} className="rune-comment-reply">
          <Card c={r} />
        </div>
      ))}

      {interactive && (
        <div className="rune-comment-actions">
          {onReply && !replying && (
            <button
              type="button"
              className="rune-comment-action"
              onClick={() => setReplying(true)}
            >
              Reply
            </button>
          )}
          {onResolve && (
            <button
              type="button"
              className="rune-comment-action"
              onClick={() => onResolve(thread.root.commentId, !thread.resolved)}
            >
              {thread.resolved ? 'Reopen' : 'Resolve'}
            </button>
          )}
        </div>
      )}

      {onReply && replying && (
        <ReplyComposer
          onSubmit={(body) => {
            onReply(thread.root.commentId, body);
            setReplying(false);
          }}
          onCancel={() => setReplying(false)}
        />
      )}
    </div>
  );
}

export function CommentGutter({
  doc,
  itemId,
  onReply,
  onResolve,
}: CommentGutterProps): JSX.Element | null {
  const [showResolved, setShowResolved] = useState(false);

  if (!itemId) return null;

  const list = commentsFor(doc, itemId);
  if (list.length === 0) return null;

  const threads = buildThreads(list);
  const active = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);

  if (active.length === 0 && resolved.length === 0) return null;

  return (
    <aside className="rune-gutter" aria-label="Comments">
      {active.map((t) => (
        <ThreadView
          key={t.root.commentId}
          thread={t}
          onReply={onReply}
          onResolve={onResolve}
        />
      ))}

      {resolved.length > 0 && (
        <div className="rune-gutter-resolved">
          <button
            type="button"
            className="rune-gutter-toggle"
            aria-expanded={showResolved}
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? 'Hide resolved' : `Show resolved (${resolved.length})`}
          </button>
          {showResolved &&
            resolved.map((t) => (
              <ThreadView
                key={t.root.commentId}
                thread={t}
                onReply={onReply}
                onResolve={onResolve}
              />
            ))}
        </div>
      )}
    </aside>
  );
}
