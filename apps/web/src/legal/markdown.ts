/**
 * A deliberately small Markdown reader for the legal pages (ticket D.2). It knows headings,
 * paragraphs, lists, block quotes, rules, bold, italic, code and links, and nothing else: raw HTML
 * is shown as text (React escapes it) and HTML comments are dropped, so an owner's file can never
 * inject markup. Unlike CommonMark, a single line break inside a paragraph stays a line break, so
 * addresses can be written line by line.
 */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'hr' };

/** Only links that cannot run script: web, mail, phone and the app's own hash routes. */
export function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:|tel:|#\/)/i.test(href) ? href : null;
}

export function parseMarkdown(source: string): Block[] {
  const text = source.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  return parseBlocks(text.split('\n'));
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ t: 'h', level, c: parseInline(heading[2]!) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(QUOTE.exec(lines[i++]!)![1]!);
      blocks.push({ t: 'quote', blocks: parseBlocks(inner) });
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (list) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== '') {
        const m = list.exec(lines[i]!);
        if (m) items.push(m[1]!);
        else if (items.length > 0) items[items.length - 1] += `\n${lines[i]!.trim()}`;
        i++;
      }
      blocks.push({ t: list === BULLET ? 'ul' : 'ol', items: items.map(parseInline) });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !HEADING.test(lines[i]!) &&
      !RULE.test(lines[i]!) &&
      !QUOTE.test(lines[i]!) &&
      !BULLET.test(lines[i]!)
    ) {
      para.push(lines[i++]!.trim());
    }
    blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return blocks;
}

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && /[\\`*_[\]()#>-]/.test(s[i + 1]!)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' && s[i + 1] !== ' ') {
      const end = s.indexOf('*', i + 1);
      if (end > i + 1 && s[end - 1] !== ' ') {
        flush();
        out.push({ t: 'em', c: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = LINK.exec(s.slice(i));
      if (m) {
        flush();
        const href = safeHref(m[2]!);
        const label = parseInline(m[1]!);
        if (href) out.push({ t: 'link', href, c: label });
        else out.push(...label);
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}
