// buildGraph — pure: turn the notes manifest into a graph of nodes (notes) and
// undirected edges ([[wiki-links]]). Unresolved link targets become faint
// "ghost" nodes (referenced but not yet created — clicking one creates it).
// Edges are deduped; each node's degree is its edge count. No DOM — unit-tested.

export interface GraphNote {
  id: string;
  title: string;
  links: string[];
}
export interface GNode {
  id: string;
  title: string;
  ghost: boolean;
  degree: number;
}
export interface GEdge {
  source: string;
  target: string;
}

export function buildGraph(notes: GraphNote[]): { nodes: GNode[]; edges: GEdge[] } {
  const byTitle = new Map<string, string>();
  for (const n of notes) byTitle.set(n.title.toLowerCase(), n.id);

  const nodes = new Map<string, GNode>();
  for (const n of notes) nodes.set(n.id, { id: n.id, title: n.title, ghost: false, degree: 0 });

  const edges: GEdge[] = [];
  for (const n of notes) {
    for (const raw of n.links) {
      const t = raw.trim();
      if (!t) continue;
      const targetId = byTitle.get(t.toLowerCase());
      if (targetId) {
        if (targetId !== n.id) edges.push({ source: n.id, target: targetId });
      } else {
        const gid = `ghost:${t.toLowerCase()}`;
        if (!nodes.has(gid)) nodes.set(gid, { id: gid, title: t, ghost: true, degree: 0 });
        edges.push({ source: n.id, target: gid });
      }
    }
  }

  const seen = new Set<string>();
  const uniq: GEdge[] = [];
  for (const e of edges) {
    const k = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(e);
    const a = nodes.get(e.source);
    const b = nodes.get(e.target);
    if (a) a.degree++;
    if (b) b.degree++;
  }
  return { nodes: [...nodes.values()], edges: uniq };
}
