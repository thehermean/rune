// GraphView — a force-directed map of notes ([[wiki-link]] graph), hand-rolled
// on a canvas (no dep). Repulsion (O(n²), fine for hundreds of notes) + edge
// springs + a gentle centering, cooled over ~500 ticks then static.
//
// Pan/zoom: a {scale, offset} view transform. Drag (one pointer) pans; wheel or
// pinch (two pointers) zooms toward the cursor/midpoint; +/-/Fit buttons in the
// header. A single pointer that doesn't move is a TAP -> open the node under it
// (a ghost node auto-creates its target). The current note is highlighted.

import { useEffect, useRef } from 'react';
import { useNotesStore } from '../../store/notes';
import { buildGraph } from '../../lib/graph';

interface SimNode {
  id: string; title: string; ghost: boolean; degree: number;
  x: number; y: number; vx: number; vy: number; fx: number; fy: number;
}

export function GraphView(): JSX.Element {
  const setGraphOpen = useNotesStore((s) => s.setGraphOpen);
  const open = useNotesStore((s) => s.open);
  const openByTitle = useNotesStore((s) => s.openByTitle);
  const notes = useNotesStore((s) => s.notes);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<string | null>(null);
  const apiRef = useRef<{ zoom: (factor: number) => void; fit: () => void } | null>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return undefined;
    const canvas: HTMLCanvasElement = canvasEl;
    const currentId = useNotesStore.getState().currentId;
    const g = buildGraph(useNotesStore.getState().notes);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const paint: CanvasRenderingContext2D = ctx;

    const dpr = window.devicePixelRatio || 1;
    let W = canvas.clientWidth || 600;
    let H = canvas.clientHeight || 400;
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    const view = { scale: 1, ox: 0, oy: 0 };

    const map = new Map<string, SimNode>();
    const nodes: SimNode[] = g.nodes.map((n, i) => {
      const a = (i / Math.max(g.nodes.length, 1)) * Math.PI * 2;
      const sn: SimNode = {
        ...n, vx: 0, vy: 0, fx: 0, fy: 0,
        x: W / 2 + Math.cos(a) * Math.min(W, H) * 0.3,
        y: H / 2 + Math.sin(a) * Math.min(W, H) * 0.3,
      };
      map.set(n.id, sn);
      return sn;
    });
    const edges = g.edges
      .map((e) => ({ a: map.get(e.source), b: map.get(e.target) }))
      .filter((e): e is { a: SimNode; b: SimNode } => !!e.a && !!e.b);

    const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888';
    const resize = (): void => {
      W = canvas.clientWidth || 600;
      H = canvas.clientHeight || 400;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    };
    resize();

    function step(): number {
      const cx = W / 2, cy = H / 2, REP = 2500, SPRING = 0.02, REST = 90, CENTER = 0.006, DAMP = 0.86;
      for (const n of nodes) { n.fx = 0; n.fy = 0; }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const d = Math.sqrt(d2);
          const f = REP / d2;
          a.fx += (dx / d) * f; a.fy += (dy / d) * f;
          b.fx -= (dx / d) * f; b.fy -= (dy / d) * f;
        }
      }
      for (const e of edges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - REST) * SPRING;
        e.a.fx += (dx / d) * f; e.a.fy += (dy / d) * f;
        e.b.fx -= (dx / d) * f; e.b.fy -= (dy / d) * f;
      }
      let energy = 0;
      for (const n of nodes) {
        n.fx += (cx - n.x) * CENTER; n.fy += (cy - n.y) * CENTER;
        n.vx = (n.vx + n.fx) * DAMP; n.vy = (n.vy + n.fy) * DAMP;
        n.x += n.vx; n.y += n.vy;
        energy += n.vx * n.vx + n.vy * n.vy;
      }
      return energy;
    }

    const radius = (n: SimNode): number => 4 + Math.min(n.degree, 8) * 1.4;

    function draw(): void {
      const faint = css('--faint'), hairline = css('--hairline'), accent = css('--accent'),
        ink = css('--ink'), canvasBg = css('--canvas');
      paint.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint.clearRect(0, 0, W, H);
      paint.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
      paint.lineWidth = 1 / view.scale;
      paint.strokeStyle = hairline;
      for (const e of edges) { paint.beginPath(); paint.moveTo(e.a.x, e.a.y); paint.lineTo(e.b.x, e.b.y); paint.stroke(); }
      for (const n of nodes) {
        const r = radius(n);
        const isCur = n.id === currentId, isHover = n.id === hoverRef.current;
        paint.beginPath();
        paint.arc(n.x, n.y, isHover ? r + 2 : r, 0, Math.PI * 2);
        if (n.ghost) { paint.fillStyle = canvasBg; paint.strokeStyle = faint; paint.fill(); paint.stroke(); }
        else { paint.fillStyle = isCur || isHover ? accent : faint; paint.fill(); }
        paint.fillStyle = isCur || isHover ? ink : faint;
        paint.font = `${11 / view.scale}px Inter, system-ui, sans-serif`;
        paint.textAlign = 'center';
        paint.fillText(n.title.length > 18 ? n.title.slice(0, 17) + '…' : n.title, n.x, n.y - r - 4 / view.scale);
      }
    }
    function writeNodes(): void {
      canvas.setAttribute('data-nodes', JSON.stringify(nodes.map((n) => ({
        id: n.id, title: n.title, ghost: n.ghost,
        x: Math.round(n.x * view.scale + view.ox), y: Math.round(n.y * view.scale + view.oy),
      }))));
    }
    const render = (): void => { draw(); writeNodes(); };

    let ticks = 0;
    let raf = 0;
    let settled = false;
    const loop = (): void => {
      const e = step();
      draw();
      ticks++;
      if (ticks < 500 && e > 0.05) raf = requestAnimationFrame(loop);
      else { settled = true; render(); }
    };
    loop();

    // --- view transform ---
    const clampScale = (s: number): number => Math.max(0.2, Math.min(4, s));
    function zoomAt(sx: number, sy: number, factor: number): void {
      const wx = (sx - view.ox) / view.scale, wy = (sy - view.oy) / view.scale;
      view.scale = clampScale(view.scale * factor);
      view.ox = sx - wx * view.scale;
      view.oy = sy - wy * view.scale;
      render();
    }
    function fit(): void {
      if (!nodes.length) return;
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const n of nodes) { minx = Math.min(minx, n.x); miny = Math.min(miny, n.y); maxx = Math.max(maxx, n.x); maxy = Math.max(maxy, n.y); }
      const pad = 50;
      view.scale = clampScale(Math.min((W - pad * 2) / ((maxx - minx) || 1), (H - pad * 2) / ((maxy - miny) || 1)));
      view.ox = W / 2 - ((minx + maxx) / 2) * view.scale;
      view.oy = H / 2 - ((miny + maxy) / 2) * view.scale;
      render();
    }
    apiRef.current = { zoom: (f) => zoomAt(W / 2, H / 2, f), fit };

    const nodeAt = (sx: number, sy: number): SimNode | null => {
      const wx = (sx - view.ox) / view.scale, wy = (sy - view.oy) / view.scale;
      let best: SimNode | null = null;
      let bd = Infinity;
      for (const n of nodes) {
        const dx = n.x - wx, dy = n.y - wy, d = dx * dx + dy * dy;
        const rr = radius(n) + (coarse ? 18 : 7) / view.scale;
        if (d < rr * rr && d < bd) { bd = d; best = n; }
      }
      return best;
    };

    // --- pan / pinch / tap via pointer events ---
    const pointers = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number } | null = null;
    let moved = false;
    let pinch = 0;
    const rectOf = () => canvas.getBoundingClientRect();

    const onDown = (e: PointerEvent): void => {
      canvas.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) { down = { x: e.clientX, y: e.clientY }; moved = false; canvas.style.cursor = 'grabbing'; }
      else if (pointers.size === 2) {
        const p = [...pointers.values()];
        pinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      }
    };
    const onMove = (e: PointerEvent): void => {
      if (!pointers.has(e.pointerId)) {
        if (e.pointerType !== 'touch' && settled) {
          const r = rectOf();
          const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
          const h = n ? n.id : null;
          if (h !== hoverRef.current) { hoverRef.current = h; canvas.style.cursor = n ? 'pointer' : 'grab'; render(); }
        }
        return;
      }
      const prev = pointers.get(e.pointerId) as { x: number; y: number };
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        const p = [...pointers.values()];
        const dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        const r = rectOf();
        if (pinch > 0) zoomAt((p[0].x + p[1].x) / 2 - r.left, (p[0].y + p[1].y) / 2 - r.top, dist / pinch);
        pinch = dist;
        moved = true;
      } else {
        if (down && (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4)) moved = true;
        view.ox += e.clientX - prev.x;
        view.oy += e.clientY - prev.y;
        render();
      }
    };
    const onUp = (e: PointerEvent): void => {
      const wasTap = pointers.size === 1 && !moved;
      const pt = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      canvas.style.cursor = 'grab';
      if (wasTap && pt) {
        const r = rectOf();
        const n = nodeAt(pt.x - r.left, pt.y - r.top);
        if (n) { if (n.ghost) void openByTitle(n.title); else void open(n.id); setGraphOpen(false); }
      }
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = rectOf();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 0.9);
    };
    const onResize = (): void => { resize(); render(); };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      apiRef.current = null;
    };
  }, [open, openByTitle, setGraphOpen]);

  return (
    <section className="rune-graph">
      <header className="rune-graph-head">
        <span className="rune-graph-title">Graph · {notes.length} notes</span>
        <div className="rune-graph-controls">
          <button type="button" className="rune-graph-zoom" title="Zoom out" aria-label="Zoom out" onClick={() => apiRef.current?.zoom(1 / 1.2)}>−</button>
          <button type="button" className="rune-graph-zoom" title="Zoom in" aria-label="Zoom in" onClick={() => apiRef.current?.zoom(1.2)}>+</button>
          <button type="button" className="rune-graph-zoom" title="Fit to view" aria-label="Fit to view" onClick={() => apiRef.current?.fit()}>⤢</button>
          <button type="button" className="rune-chrome-btn" onClick={() => setGraphOpen(false)}>Close</button>
        </div>
      </header>
      {notes.length === 0 ? (
        <div className="rune-notes-empty"><p className="rune-empty-line">No notes to graph yet.</p></div>
      ) : (
        <canvas ref={canvasRef} className="rune-graph-canvas" />
      )}
    </section>
  );
}
