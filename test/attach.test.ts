import { describe, it, expect } from 'vitest';
import { isUrl, urlToAttachment, fileToAttachment } from '../web/lib/attach';
import { parse, findById, attachmentsOf } from '../src/index';

describe('isUrl', () => {
  it('accepts a clean http(s) url, rejects plain text', () => {
    expect(isUrl('https://example.com/docs/spec.md')).toBe(true);
    expect(isUrl('http://example.com')).toBe(true);
    expect(isUrl('just some words')).toBe(false);
    // A sentence that merely contains a url is NOT a url (inner whitespace).
    expect(isUrl('see https://example.com for more')).toBe(false);
    expect(isUrl('   ')).toBe(false);
    expect(isUrl('example.com')).toBe(false); // no scheme
  });

  it('accepts a well-formed mailto and trims surrounding whitespace', () => {
    expect(isUrl('  mailto:alice@example.com  ')).toBe(true);
    expect(isUrl('mailto:not-an-email')).toBe(false);
  });
});

describe('urlToAttachment', () => {
  it('labels with the decoded last path segment and keeps the url as target', () => {
    const a = urlToAttachment('https://example.com/docs/My%20Spec.md');
    expect(a.label).toBe('My Spec.md');
    expect(a.target).toBe('https://example.com/docs/My%20Spec.md');
  });

  it('falls back to the host when there is no path segment', () => {
    const a = urlToAttachment('https://example.com/');
    expect(a.label).toBe('example.com');
    expect(a.target).toBe('https://example.com/');
  });
});

describe('fileToAttachment', () => {
  it('maps a {name} to label=name and an attachments/ relative target', () => {
    const a = fileToAttachment({ name: 'auth.pdf' });
    expect(a).toEqual({ label: 'auth.pdf', target: 'attachments/auth.pdf' });
  });
});

describe('round-trip through @core', () => {
  // Mirror the store's addAttachment: build a `[label](target)` line on a task
  // body, then re-parse via @core and assert the link segment survives.
  function addAttachment(label: string, target: string) {
    const line = `- [ ] task [${label}](${target}) ^t-1`;
    const doc = parse(line);
    return attachmentsOf(findById(doc, 't-1')!);
  }

  it('a url attachment re-parses to a link segment with the same label/target', () => {
    const { label, target } = urlToAttachment('https://example.com/docs/grammar.md');
    expect(addAttachment(label, target)).toEqual([
      { label: 'grammar.md', target: 'https://example.com/docs/grammar.md' },
    ]);
  });

  it('a file attachment re-parses to its relative attachments/ link', () => {
    const { label, target } = fileToAttachment({ name: 'auth.pdf' });
    expect(addAttachment(label, target)).toEqual([
      { label: 'auth.pdf', target: 'attachments/auth.pdf' },
    ]);
  });
});
