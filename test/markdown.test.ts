import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../web/lib/markdown';
import { findOpenWikiLink } from '../web/lib/caret';

describe('renderMarkdown', () => {
  it('renders headings, bold, italic, inline code', () => {
    const h = renderMarkdown('# Title\n\nsome **bold** and *em* and `code`');
    expect(h).toContain('<h1 class="rune-md-h1">Title</h1>');
    expect(h).toContain('<strong>bold</strong>');
    expect(h).toContain('<em>em</em>');
    expect(h).toContain('<code class="rune-md-code">code</code>');
  });

  it('renders checklists with the source line index + checked state', () => {
    const h = renderMarkdown('- [ ] todo\n- [x] done');
    expect(h).toContain('data-line="0"');
    expect(h).toContain('data-checked="false"');
    expect(h).toContain('data-line="1"');
    expect(h).toContain('data-checked="true"');
  });

  it('escapes HTML — no raw tag passthrough (XSS)', () => {
    const h = renderMarkdown('<script>alert(1)</script> & <b>x</b>');
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;');
  });

  it('blocks javascript: links, keeps http(s)', () => {
    expect(renderMarkdown('[x](javascript:alert)')).not.toContain('href="javascript');
    expect(renderMarkdown('[x](https://a.com)')).toContain('href="https://a.com"');
  });

  it('renders wiki-links and tags with navigation data attrs', () => {
    const h = renderMarkdown('see [[Other Note]] about #work');
    expect(h).toContain('class="rune-wikilink" data-note="Other Note"');
    expect(h).toContain('class="rune-tag" data-tag="work"');
  });

  it('marks a wiki-link missing when the target is not in the known set', () => {
    const known = new Set(['existing note']);
    const h = renderMarkdown('[[Existing Note]] and [[Ghost]]', { known });
    expect(h).toContain('class="rune-wikilink" data-note="Existing Note"');
    expect(h).toContain('class="rune-wikilink is-missing" data-note="Ghost"');
  });

  it('renders a blockquote and a fenced code block', () => {
    expect(renderMarkdown('> quoted')).toContain('<blockquote class="rune-md-quote">quoted</blockquote>');
    expect(renderMarkdown('```\nx = 1\n```')).toContain('<pre class="rune-md-pre"><code>x = 1</code></pre>');
  });
});

describe('findOpenWikiLink', () => {
  it('detects an open [[ before the caret', () => {
    expect(findOpenWikiLink('see [[Ro', 8)).toEqual({ bracketStart: 4, query: 'Ro' });
  });
  it('is null once closed or across a newline', () => {
    expect(findOpenWikiLink('[[Done]] x', 10)).toBeNull();
    expect(findOpenWikiLink('[[\nx', 4)).toBeNull();
  });
});
