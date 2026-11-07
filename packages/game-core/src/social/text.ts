import { BLOCKED_TERMS, RESERVED_NAME_TERMS, type BlockedTerm } from './blocklist.js';

/**
 * The player-text module (ticket 4.1, docs/SOCIAL.md "Player text"): every piece of text a player
 * writes goes through `validatePlayerText(kind, raw)` on the server before it is stored, and the
 * client runs the same check for instant feedback. One rule set per kind, as data.
 */
export const PLAYER_TEXT_KINDS = [
  'displayName',
  'guildName',
  'guildTag',
  'profileField',
  'chatMessage',
  'guildNotice',
  'reportNote',
  'sanctionReason',
] as const;

export type PlayerTextKind = (typeof PLAYER_TEXT_KINDS)[number];

export interface PlayerTextRule {
  /** Length in code points after normalisation. */
  min: number;
  max: number;
  /** Keeps single line breaks (at most two in a row); otherwise every break becomes a space. */
  multiline: boolean;
  /** Extra shape rule for names and tags, with the message shown when it fails. */
  pattern?: { re: RegExp; message: string };
  /** Checked against `BLOCKED_TERMS`. */
  blockList: boolean;
  /** Checked against `RESERVED_NAME_TERMS` (names that could pass for staff or the game). */
  reserved: boolean;
  /** `deny`: no links or domain-like text (the Phase 4 link policy). `allow`: kept as plain text. */
  links: 'deny' | 'allow';
}

// Letters (any script), digits, single spaces, hyphens, apostrophes and underscores, starting and
// ending with a letter or digit (the registration rule since ticket 1.2).
const NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}_'-]| (?! ))*[\p{L}\p{N}]$/u;

export const PLAYER_TEXT_RULES: Record<PlayerTextKind, PlayerTextRule> = {
  displayName: {
    min: 3,
    max: 20,
    multiline: false,
    pattern: {
      re: NAME_RE,
      message: 'Use letters, numbers, single spaces, hyphens or apostrophes.',
    },
    blockList: true,
    reserved: true,
    links: 'deny',
  },
  guildName: {
    min: 3,
    max: 24,
    multiline: false,
    pattern: {
      re: NAME_RE,
      message: 'Use letters, numbers, single spaces, hyphens or apostrophes.',
    },
    blockList: true,
    reserved: true,
    links: 'deny',
  },
  guildTag: {
    min: 2,
    max: 5,
    multiline: false,
    pattern: { re: /^[A-Z0-9]+$/, message: 'Use capital letters A–Z and digits only.' },
    blockList: true,
    reserved: true,
    links: 'deny',
  },
  profileField: {
    min: 0,
    max: 160,
    multiline: false,
    blockList: true,
    reserved: false,
    links: 'deny',
  },
  chatMessage: {
    min: 1,
    max: 300,
    multiline: false,
    blockList: true,
    reserved: false,
    links: 'deny',
  },
  // Ticket 4.5: the guild notice the leader and officers pin above the chat (a few short lines).
  guildNotice: {
    min: 1,
    max: 400,
    multiline: true,
    blockList: true,
    reserved: false,
    links: 'deny',
  },
  // Read only by moderators, who need the reported words as written, so no block list; a pasted
  // link is kept as plain text (never rendered as a link).
  reportNote: {
    min: 0,
    max: 500,
    multiline: true,
    blockList: false,
    reserved: false,
    links: 'allow',
  },
  // Written by moderators and shown to the sanctioned player.
  sanctionReason: {
    min: 3,
    max: 300,
    multiline: false,
    blockList: false,
    reserved: false,
    links: 'allow',
  },
};

export type PlayerTextProblem =
  'too_short' | 'too_long' | 'pattern' | 'blocked' | 'reserved' | 'link';

export type PlayerTextResult =
  | { ok: true; value: string }
  | { ok: false; value: string; problem: PlayerTextProblem; message: string };

/** Format and invisible characters: zero-width, bidi controls, soft hyphen, tag characters (all
 * `Cf`), plus fillers that render blank (Hangul fillers, the Braille blank). */
const INVISIBLE_RE = /[\p{Cf}ᅟᅠㅤﾠ⠀]/gu;
/** Control characters other than the line break (handled separately). */
const CONTROL_RE = /[\p{Cc}]/gu;
const MAX_MARKS_PER_LETTER = 2;

/**
 * Normalises raw player text: Unicode NFKC (full-width and stylised letters become plain ones),
 * invisible and control characters removed, whitespace runs collapsed to one space, stacked
 * combining marks capped at two per letter ("zalgo"), trimmed. Multiline kinds keep single line
 * breaks (at most two in a row).
 */
export function normalizePlayerText(raw: string, { multiline = false } = {}): string {
  let s = raw.normalize('NFKC').replace(/\r\n?/g, '\n').replace(INVISIBLE_RE, '');
  s = s.replace(multiline ? /[^\S\n]+/g : /\s+/g, ' ');
  s = s.replace(CONTROL_RE, (c) => (multiline && c === '\n' ? '\n' : ''));
  s = s.replace(/\p{M}+/gu, (marks) => [...marks].slice(0, MAX_MARKS_PER_LETTER).join(''));
  if (multiline) {
    s = s
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  }
  return s.trim();
}

/** Normalises and checks text of one kind. `value` is the normalised text either way. */
export function validatePlayerText(kind: PlayerTextKind, raw: string): PlayerTextResult {
  const rule = PLAYER_TEXT_RULES[kind];
  const value = normalizePlayerText(raw, { multiline: rule.multiline });
  const fail = (problem: PlayerTextProblem, message: string): PlayerTextResult => ({
    ok: false,
    value,
    problem,
    message,
  });
  const length = [...value].length;
  if (length < rule.min) {
    return fail(
      'too_short',
      rule.min === 1 ? 'Write something first.' : `Use at least ${rule.min} characters.`,
    );
  }
  if (length > rule.max) return fail('too_long', `Use at most ${rule.max} characters.`);
  if (rule.pattern && !rule.pattern.re.test(value)) return fail('pattern', rule.pattern.message);
  if (rule.links === 'deny' && containsLink(value)) {
    return fail('link', 'Links and web addresses are not allowed.');
  }
  if (rule.reserved && matchesAny(value, RESERVED_NAME_TERMS)) {
    return fail('reserved', 'That name is reserved. Choose another.');
  }
  if (rule.blockList && matchesAny(value, BLOCKED_TERMS)) {
    return fail('blocked', 'That contains a word that is not allowed here.');
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------
// Block list matching with simple evasion handling.

/** Letters from other scripts that look like Latin ones (Cyrillic, Greek, small capitals). */
const LOOKALIKES: Record<string, string> = {
  ᴀ: 'a',
  ʙ: 'b',
  ᴄ: 'c',
  ᴅ: 'd',
  ᴇ: 'e',
  ɢ: 'g',
  ʜ: 'h',
  ɪ: 'i',
  ᴊ: 'j',
  ᴋ: 'k',
  ʟ: 'l',
  ᴍ: 'm',
  ɴ: 'n',
  ᴏ: 'o',
  ᴘ: 'p',
  ʀ: 'r',
  ꜱ: 's',
  ᴛ: 't',
  ᴜ: 'u',
  ᴠ: 'v',
  ᴡ: 'w',
  ʏ: 'y',
  ᴢ: 'z',
  һ: 'h',
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ɡ: 'g',
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
};
/** Digits and symbols used for letters ("sh1t", "@ss", "$lut"). */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
  '8': 'b',
  '9': 'g',
  '(': 'c',
};

/** Lowercase Latin letters only, with look-alikes and leetspeak folded; everything else is a
 * separator (space). Accents are removed ("fück" → "fuck"). */
export function foldForMatching(text: string): string {
  return [...text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()]
    .map((c) => {
      const mapped = LOOKALIKES[c] ?? LEET[c] ?? c;
      return /^[a-z]$/.test(mapped) ? mapped : ' ';
    })
    .join('');
}

const SUFFIXES = '(?:s|z|es|ed|er|ers|ing|y)?';
const termPatterns = new Map<string, RegExp>();

/** "fuck" → /f+u+c+k+/: each letter may repeat ("fuuuck"); doubled letters stay required, so
 * "nigger" does not match "Niger". */
function termPattern(t: BlockedTerm): RegExp {
  const key = `${t.match}:${t.term}`;
  let re = termPatterns.get(key);
  if (!re) {
    const body = [...t.term].map((c) => `${c}+`).join('');
    re = t.match === 'anywhere' ? new RegExp(body) : new RegExp(`^${body}${SUFFIXES}$`);
    termPatterns.set(key, re);
  }
  return re;
}

/** Words of the folded text, with runs of single letters joined ("s h i t" → "shit"). */
function wordsOf(folded: string): string[] {
  const words: string[] = [];
  let run = '';
  for (const w of folded.split(' ').filter(Boolean)) {
    if (w.length === 1) run += w;
    else {
      if (run) words.push(run);
      run = '';
      words.push(w);
    }
  }
  if (run) words.push(run);
  return words;
}

/** Whether the text contains one of the terms (see `BlockMatch`). */
export function matchesAny(text: string, terms: readonly BlockedTerm[]): boolean {
  const folded = foldForMatching(text);
  const letters = folded.replace(/ /g, '');
  const words = wordsOf(folded);
  return terms.some((t) => {
    const re = termPattern(t);
    return t.match === 'anywhere' ? re.test(letters) : words.some((w) => re.test(w));
  });
}

// ---------------------------------------------------------------------------------------------
// Link policy: no links in Phase 4.

const TLDS =
  'com|net|org|io|gg|co|me|ru|de|uk|us|eu|xyz|info|biz|tv|app|dev|link|ly|to|cc|online|site|shop|top|club|live|stream|store|fun|pw|tk';
const LINK_RES = [
  /\b(?:https?|ftp)\s*:\s*\/\//,
  /\bwww\s*(?:\.|\(dot\)|\[dot\])/,
  new RegExp(`[a-z0-9-]{2,}\\s*(?:\\.|\\(dot\\)|\\[dot\\]|\\sdot\\s)\\s*(?:${TLDS})\\b`),
  /\bdiscord(?:app)?\s*(?:\.\s*)?(?:gg|com)\s*\//,
];

/** Whether the text holds something that reads as a link or web address ("discord . gg/x",
 * "shop(dot)com"). */
export function containsLink(text: string): boolean {
  const s = [...text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()]
    .map((c) => LOOKALIKES[c] ?? c)
    .join('');
  return LINK_RES.some((re) => re.test(s));
}
