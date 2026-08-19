// Minimal, safe Markdown -> HTML renderer for Notes (hand-rolled, no deps — the
// same lossless-plain-text ethos as the .rune parser). Covers the subset a
// notes app needs: headings, bold/italic/strike, inline + fenced code, links,
// images, blockquotes, hr, bulleted/ordered lists, GFM checklists, plus Rune's
// own [[wiki-links]] and #tags. All text is HTML-escaped first, so only the tags
// this file emits ever reach the DOM (notes are shareable -> treat as untrusted).
//
// Checklist <li>s carry data-line (the SOURCE line index) so a tap can toggle
// the exact `- [ ]` in the markdown (Phase 2). Wiki-links carry data-note and
// tags carry data-tag for navigation/filtering (Phase 3).

let knownTitles: Set<string> | null = null;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Allow http(s)/mailto and relative URLs; block javascript:, data:, etc. */
function safeUrl(url: string): string | null {
  const u = url.replace(/&amp;/g, '&').trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // some other scheme -> block
  return u; // relative (e.g. /api/notes-attachments/...)
}

/** Inline pass - run on already block-split text. */
function inline(text: string): string {
  // Protect inline-code content before escaping so markup inside code is literal.
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return ` ${codes.length - 1} `;
  });
  s = escapeHtml(s);

  // images ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) => {
    const safe = safeUrl(url);
    return safe ? `<img class="rune-md-img" src="${safe}" alt="${alt}" />` : m;
  });
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t: string, url: string) => {
    const safe = safeUrl(url);
    return safe
      ? `<a class="rune-md-link" href="${safe}" target="_blank" rel="noopener noreferrer">${t}</a>`
      : m;
  });
  // wiki-links [[target]] / [[target|label]]
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => {
    const t = target.trim();
    const missing = knownTitles ? !knownTitles.has(t.toLowerCase()) : false;
    return `<a class="rune-wikilink${missing ? ' is-missing' : ''}" data-note="${escapeHtml(t)}">${escapeHtml((label ?? target).trim())}</a>`;
  });
  // bold / italic / strike
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // #tags (preceded by start or whitespace)
  s = s.replace(/(^|\s)#([a-z0-9][a-z0-9_/-]*)/gi, (_m, pre: string, tag: string) =>
    `${pre}<span class="rune-tag" data-tag="${escapeHtml(tag.toLowerCase())}">#${escapeHtml(tag)}</span>`);
  // restore inline code
  s = s.replace(/ (\d+) /g, (_m, n: string) => `<code class="rune-md-code">${escapeHtml(codes[+n])}</code>`);
  return s;
}

const isListLine = (l: string): boolean => /^\s*([-*+]|\d+\.)\s+/.test(l);

function renderList(lines: string[], start: number): [string, number] {
  let i = start;
  const ordered = /^\s*\d+\.\s+/.test(lines[i]);
  const items: string[] = [];
  const re = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
  while (i < lines.length && isListLine(lines[i])) {
    const m = re.exec(lines[i]);
    if (!m) break;
    if (/\d+\./.test(m[2]) !== ordered) break; // list type switch ends this list
    const content = m[3];
    const check = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (check) {
      const checked = check[1].toLowerCase() === 'x';
      items.push(
        `<li class="rune-md-check${checked ? ' is-checked' : ''}" data-line="${i}" data-checked="${checked}">` +
        `<span class="rune-md-box" role="checkbox" aria-checked="${checked}" tabindex="0"></span>` +
        `<span class="rune-md-checktext">${inline(check[2])}</span></li>`);
    } else {
      items.push(`<li>${inline(content)}</li>`);
    }
    i++;
  }
  const tag = ordered ? 'ol' : 'ul';
  return [`<${tag} class="rune-md-${tag}">${items.join('')}</${tag}>`, i];
}

/** Render Markdown source to a safe HTML string. */
export function renderMarkdown(src: string, opts?: { known?: Set<string> }): string {
  knownTitles = opts?.known ?? null;
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre class="rune-md-pre"><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const n = h[1].length; out.push(`<h${n} class="rune-md-h${n}">${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr class="rune-md-hr" />'); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote class="rune-md-quote">${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (isListLine(line)) { const [html, next] = renderList(lines, i); out.push(html); i = next; continue; }

    const buf: string[] = [];
    while (
      i < lines.length && lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^>\s?/.test(lines[i]) &&
      !isListLine(lines[i]) && !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) { buf.push(lines[i]); i++; }
    out.push(`<p class="rune-md-p">${inline(buf.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }
  const html = out.join('\n');
  knownTitles = null;
  return html;
}
