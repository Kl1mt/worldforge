import { describe, expect, it } from 'vitest';
import {
  PLAYER_TEXT_KINDS,
  PLAYER_TEXT_RULES,
  containsLink,
  normalizePlayerText,
  validatePlayerText,
  type PlayerTextKind,
} from './text.js';

const problem = (kind: PlayerTextKind, raw: string) => {
  const r = validatePlayerText(kind, raw);
  return r.ok ? null : r.problem;
};

describe('normalizePlayerText', () => {
  it('applies NFKC, so full-width and stylised letters become plain ones', () => {
    expect(normalizePlayerText('Ｗｏｌｆ')).toBe('Wolf');
    expect(normalizePlayerText('𝐀𝐬𝐡')).toBe('Ash');
    expect(normalizePlayerText('ﬁre')).toBe('fire');
  });

  it('removes invisible and control characters', () => {
    expect(normalizePlayerText('A​sh‍⁠en')).toBe('Ashen');
    expect(normalizePlayerText('‮evil‬')).toBe('evil');
    expect(normalizePlayerText('soft­hyphen')).toBe('softhyphen');
    expect(normalizePlayerText('bell\u0007 and\u0000 nul')).toBe('bell and nul');
    expect(normalizePlayerText('ㅤㅤ')).toBe('');
    expect(normalizePlayerText('tag\u{E0041}\u{E0042}')).toBe('tag');
  });

  it('trims and collapses whitespace; single line unless multiline', () => {
    expect(normalizePlayerText('  two   words \t\n here  ')).toBe('two words here');
    expect(normalizePlayerText('a  b')).toBe('a b');
    expect(normalizePlayerText(' line one \r\n\n\n\n  line two ', { multiline: true })).toBe(
      'line one\n\nline two',
    );
  });

  it('caps stacked combining marks ("zalgo") at two per letter', () => {
    const zalgo = 'á̂̃̄̅';
    expect([...normalizePlayerText(zalgo)].length).toBe(3);
  });
});

describe('validatePlayerText limits', () => {
  it('has rules for every kind', () => {
    for (const kind of PLAYER_TEXT_KINDS) expect(PLAYER_TEXT_RULES[kind]).toBeDefined();
  });

  it('counts code points after normalisation', () => {
    expect(problem('displayName', 'Ab')).toBe('too_short');
    expect(problem('displayName', 'Abc')).toBeNull();
    expect(problem('displayName', 'A'.repeat(20))).toBeNull();
    expect(problem('displayName', 'A'.repeat(21))).toBe('too_long');
    // Invisible padding does not count towards the minimum.
    expect(problem('displayName', 'A​​​b')).toBe('too_short');
    expect(problem('chatMessage', '   ')).toBe('too_short');
    expect(problem('chatMessage', 'x'.repeat(300))).toBeNull();
    expect(problem('chatMessage', 'x'.repeat(301))).toBe('too_long');
    expect(problem('reportNote', '')).toBeNull();
    expect(problem('reportNote', 'y'.repeat(501))).toBe('too_long');
    expect(problem('guildTag', 'ASH')).toBeNull();
    expect(problem('guildTag', 'ash')).toBe('pattern');
    expect(problem('guildTag', 'A')).toBe('too_short');
  });

  it('keeps the display-name shape rule', () => {
    expect(problem('displayName', 'Ash  Wolf')).toBeNull(); // collapsed to one space
    expect(problem('displayName', 'Ash--Wolf')).toBeNull();
    expect(problem('displayName', '-Ash')).toBe('pattern');
    expect(problem('displayName', 'Ash!')).toBe('pattern');
    expect(problem('displayName', 'Ölmühle')).toBeNull();
  });

  it('returns the normalised value', () => {
    expect(validatePlayerText('displayName', '  Ｗｏｌｆ  ')).toEqual({ ok: true, value: 'Wolf' });
  });
});

describe('block list with evasion handling', () => {
  const blocked = [
    'fuck',
    'FUCK',
    'fuuuuck you',
    'f u c k',
    'f.u.c.k',
    'f_u-c*k',
    'fück',
    'phuck', // not covered: documented gap
    'xxfuckxx',
    'sh1t',
    's h i t',
    'shits',
    '$hit',
    '@ss',
    'a$$hole',
    'bitches',
    'ѕһit', // Cyrillic look-alikes
    'Ｆｕｃｋ',
    'f​u​c​k',
    'kys',
  ];
  const expectations: Record<string, boolean> = {
    phuck: false,
  };

  it.each(blocked)('%s', (text) => {
    const want = expectations[text] ?? true;
    expect(problem('chatMessage', text) === 'blocked').toBe(want);
  });

  it('lets innocent words through (no Scunthorpe problem)', () => {
    for (const text of [
      'Scunthorpe',
      'class assassin',
      'grass and glass',
      'cocktail',
      'Dickens',
      'shitake',
      'Niger',
      'a hitch in the plan',
      'passage',
      'skyscraper',
      'fire retardant',
      'therapist',
    ]) {
      expect({ text, problem: problem('chatMessage', text) }).toEqual({ text, problem: null });
    }
  });

  it('does not filter report notes (moderators need the words as written)', () => {
    expect(problem('reportNote', 'he called me a fuck')).toBeNull();
  });

  it('reserves staff-like names for name kinds only', () => {
    expect(problem('displayName', 'Admin')).toBe('reserved');
    expect(problem('displayName', 'xX4dm1nXx')).toBe('reserved');
    expect(problem('displayName', 'Mod Ash')).toBe('reserved');
    expect(problem('displayName', 'Modric')).toBeNull();
    expect(problem('displayName', 'GM Wolf')).toBe('reserved');
    expect(problem('displayName', 'Worldforge Team')).toBe('reserved');
    expect(problem('guildName', 'The Moderators')).toBe('reserved');
    expect(problem('chatMessage', 'ask an admin')).toBeNull();
  });
});

describe('link policy', () => {
  const links = [
    'http://evil.example',
    'https ://x.y',
    'visit www.gold-shop.biz',
    'cheapgold.com',
    'cheapgold . com',
    'cheapgold(dot)com',
    'cheapgold dot com',
    'discord.gg/abc',
    'discord gg/abc',
    'ᴄheapgold.ᴄom'.normalize('NFKC'),
    'Ｇold.ｃｏｍ',
  ];
  it.each(links)('%s is a link', (text) => {
    expect(problem('chatMessage', text)).toBe('link');
    expect(containsLink(normalizePlayerText(text))).toBe(true);
  });

  it('leaves ordinary sentences alone', () => {
    for (const text of [
      'Mr. Smith went home.',
      'e.g. a ring',
      'gg well played',
      'Done. Come on',
      '3.5 gold',
    ]) {
      expect({ text, problem: problem('chatMessage', text) }).toEqual({ text, problem: null });
    }
  });

  it('allows links as plain text in report notes', () => {
    expect(problem('reportNote', 'he posted cheapgold.com')).toBeNull();
  });
});
