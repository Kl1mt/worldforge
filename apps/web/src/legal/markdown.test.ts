import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref } from './markdown';

describe('legal markdown', () => {
  it('reads headings, paragraphs with line breaks, lists, quotes and rules', () => {
    const blocks = parseMarkdown(
      '# Impressum\n\n**Erika Musterfrau**\nHauptstraße 1\n\n- one\n- *two*\n\n1. first\n2. second\n\n> note\n\n---\n',
    );
    expect(blocks).toEqual([
      { t: 'h', level: 1, c: [{ t: 'text', v: 'Impressum' }] },
      {
        t: 'p',
        c: [
          { t: 'strong', c: [{ t: 'text', v: 'Erika Musterfrau' }] },
          { t: 'br' },
          { t: 'text', v: 'Hauptstraße 1' },
        ],
      },
      {
        t: 'ul',
        items: [[{ t: 'text', v: 'one' }], [{ t: 'em', c: [{ t: 'text', v: 'two' }] }]],
      },
      { t: 'ol', items: [[{ t: 'text', v: 'first' }], [{ t: 'text', v: 'second' }]] },
      { t: 'quote', blocks: [{ t: 'p', c: [{ t: 'text', v: 'note' }] }] },
      { t: 'hr' },
    ]);
  });

  it('drops comments and keeps raw HTML as plain text', () => {
    expect(parseMarkdown('<!-- worldforge:template -->\n<script>x</script>')).toEqual([
      { t: 'p', c: [{ t: 'text', v: '<script>x</script>' }] },
    ]);
  });

  it('only links to safe targets', () => {
    expect(safeHref('https://example.de')).toBe('https://example.de');
    expect(safeHref('mailto:a@b.de')).toBe('mailto:a@b.de');
    expect(safeHref('#/datenschutz')).toBe('#/datenschutz');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(parseInline('[x](javascript:alert(1))')).toEqual([
      { t: 'text', v: 'x' },
      { t: 'text', v: ')' },
    ]);
    expect(parseInline('see [policy](#/datenschutz) and `code`')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: '#/datenschutz', c: [{ t: 'text', v: 'policy' }] },
      { t: 'text', v: ' and ' },
      { t: 'code', v: 'code' },
    ]);
    expect(parseInline('a \\*b\\* § 5')).toEqual([{ t: 'text', v: 'a *b* § 5' }]);
  });

  it('reads the shipped templates', () => {
    for (const page of ['impressum', 'datenschutz']) {
      const md = readFileSync(
        new URL(`../../../../content/legal/${page}.md`, import.meta.url),
        'utf8',
      );
      const blocks = parseMarkdown(md);
      expect(blocks[0]).toMatchObject({ t: 'h', level: 1 });
      expect(blocks.some((b) => b.t === 'quote')).toBe(true);
    }
  });
});
