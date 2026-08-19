import { describe, it, expect } from 'vitest';
import { buildGraph } from '../web/lib/graph';

describe('buildGraph', () => {
  it('resolves links to existing notes; missing targets become ghosts', () => {
    const { nodes, edges } = buildGraph([
      { id: 'a', title: 'Alpha', links: ['Beta', 'Ghost'] },
      { id: 'b', title: 'Beta', links: [] },
    ]);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId['a'].ghost).toBe(false);
    expect(byId['b'].ghost).toBe(false);
    expect(nodes.find((n) => n.ghost)?.title).toBe('Ghost');
    expect(edges).toHaveLength(2);
    expect(byId['a'].degree).toBe(2);
    expect(byId['b'].degree).toBe(1);
  });

  it('dedupes reciprocal/duplicate links into one edge', () => {
    const { edges } = buildGraph([
      { id: 'a', title: 'A', links: ['B', 'B'] },
      { id: 'b', title: 'B', links: ['A'] },
    ]);
    expect(edges).toHaveLength(1);
  });

  it('ignores self-links', () => {
    const { edges } = buildGraph([{ id: 'a', title: 'A', links: ['A'] }]);
    expect(edges).toHaveLength(0);
  });
});
