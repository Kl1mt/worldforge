import { RARITY_IDS } from '../rarity.js';
import {
  LOOT_FILTER_CATEGORIES,
  parseLootFilter,
  type LootFilterCategory,
  type LootFilterProblem,
  type LootFilterRules,
} from './lootFilter.js';

/**
 * Loot-filter presets and share codes (ticket 8.5, docs/LOOT.md "Presets and share codes").
 *
 * A **share code** carries one set of rules as a short, versioned, checksummed string that needs no
 * server lookup: `wf1.<payload>.<check>`.
 * - `wf1` is the format version. A code of another version is refused (`version`), never guessed.
 * - `<payload>` is base64url (no padding) of the ASCII text `action|belowRarity|affixes|effects|include`:
 *   the action letter (`s` salvage, `v` sell), the rarity id or empty, comma-separated affix and
 *   effect ids, and one letter per included category (`l` Legendary, `m` Mythic, `s` set, `v` Void,
 *   `p` Prismatic).
 * - `<check>` is a 32-bit FNV-1a of the payload in base36, so a mistyped code is refused
 *   (`checksum`) instead of turning into other rules.
 *
 * Decoding only reads text; the rules it yields then go through `parseLootFilter`, the same
 * validation as a filter sent by hand, so a code can never carry what the filter would refuse.
 * The server decodes codes itself and never trusts a client's decoding.
 */

export const LOOT_FILTER_CODE_VERSION = 1;
const PREFIX = `wf${LOOT_FILTER_CODE_VERSION}`;
/** Longer codes are refused before any decoding (16 + 16 long ids fit well under it). */
export const LOOT_FILTER_CODE_MAX_LENGTH = 1200;
/** Presets a hero may keep. */
export const LOOT_FILTER_PRESET_LIMIT = 5;
/** A preset's name: 1–24 characters after trimming. */
export const LOOT_FILTER_PRESET_NAME_MAX = 24;

const CATEGORY_LETTER: Record<LootFilterCategory, string> = {
  legendary: 'l',
  mythic: 'm',
  set: 's',
  void: 'v',
  prismatic: 'p',
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

function toBase64Url(ascii: string): string {
  let out = '';
  for (let i = 0; i < ascii.length; i += 3) {
    const a = ascii.charCodeAt(i);
    const b = i + 1 < ascii.length ? ascii.charCodeAt(i + 1) : 0;
    const c = i + 2 < ascii.length ? ascii.charCodeAt(i + 2) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < ascii.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < ascii.length) out += B64[n & 63]!;
  }
  return out;
}

/** Null when the text is not canonical base64url of printable ASCII. */
function fromBase64Url(text: string): string | null {
  if (text.length % 4 === 1) return null;
  let out = '';
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4);
    const v = [...chunk].map((ch) => B64.indexOf(ch));
    if (v.some((x) => x < 0)) return null;
    const n = ((v[0]! << 18) | (v[1]! << 12) | ((v[2] ?? 0) << 6) | (v[3] ?? 0)) >>> 0;
    out += String.fromCharCode((n >> 16) & 255);
    if (chunk.length > 2) out += String.fromCharCode((n >> 8) & 255);
    if (chunk.length > 3) out += String.fromCharCode(n & 255);
  }
  if (!/^[\x20-\x7e]*$/.test(out)) return null;
  // Canonical only: unused low bits must be zero (one text per payload).
  return toBase64Url(out) === text ? out : null;
}

function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The share code of a set of rules (null rules: the code of the empty filter). */
export function encodeLootFilterCode(rules: LootFilterRules | null): string {
  const r = rules ?? {
    action: 'salvage',
    belowRarity: null,
    wantedAffixes: [],
    wantedEffects: [],
    include: [],
  };
  const payload = [
    r.action === 'sell' ? 'v' : 's',
    r.belowRarity ?? '',
    r.wantedAffixes.join(','),
    r.wantedEffects.join(','),
    LOOT_FILTER_CATEGORIES.filter((c) => r.include.includes(c))
      .map((c) => CATEGORY_LETTER[c])
      .join(''),
  ].join('|');
  const body = toBase64Url(payload);
  return `${PREFIX}.${body}.${checksum(body)}`;
}

export type LootFilterCodeError =
  /** Not a share code at all (wrong shape, characters or length). */
  | 'malformed'
  /** A share code of a format this game does not read. */
  | 'version'
  /** The code was changed or mistyped. */
  | 'checksum'
  /** A well-formed code whose rules the filter refuses (e.g. an id this game does not know). */
  | 'invalid';

export type LootFilterCodeResult =
  | { ok: true; rules: LootFilterRules }
  | { ok: false; error: LootFilterCodeError; problems?: LootFilterProblem[] };

function splitIds(text: string): string[] | null {
  if (text === '') return [];
  const ids = text.split(',');
  return ids.every((id) => ID_PATTERN.test(id)) ? ids : null;
}

/** Reads a share code (surrounding whitespace allowed) into validated rules. */
export function decodeLootFilterCode(input: unknown): LootFilterCodeResult {
  if (typeof input !== 'string') return { ok: false, error: 'malformed' };
  const code = input.trim();
  if (code.length === 0 || code.length > LOOT_FILTER_CODE_MAX_LENGTH) {
    return { ok: false, error: 'malformed' };
  }
  const parts = code.split('.');
  const version = /^wf(\d{1,3})$/.exec(parts[0] ?? '');
  if (!version) return { ok: false, error: 'malformed' };
  if (Number(version[1]) !== LOOT_FILTER_CODE_VERSION) return { ok: false, error: 'version' };
  if (parts.length !== 3) return { ok: false, error: 'malformed' };
  const [, body, check] = parts as [string, string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[0-9a-z]{1,7}$/.test(check)) {
    return { ok: false, error: 'malformed' };
  }
  if (checksum(body) !== check) return { ok: false, error: 'checksum' };
  const payload = fromBase64Url(body);
  if (payload === null) return { ok: false, error: 'malformed' };
  const fields = payload.split('|');
  if (fields.length !== 5) return { ok: false, error: 'malformed' };
  const [action, below, affixText, effectText, letters] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (action !== 's' && action !== 'v') return { ok: false, error: 'malformed' };
  const affixes = splitIds(affixText);
  const effects = splitIds(effectText);
  if (!affixes || !effects) return { ok: false, error: 'malformed' };
  const include: string[] = [];
  for (const letter of letters) {
    const category = LOOT_FILTER_CATEGORIES.find((c) => CATEGORY_LETTER[c] === letter);
    if (!category || include.includes(category)) return { ok: false, error: 'malformed' };
    include.push(category);
  }
  if (below !== '' && !(RARITY_IDS as readonly string[]).includes(below)) {
    return {
      ok: false,
      error: 'invalid',
      problems: [{ field: 'belowRarity', message: 'Unknown rarity.' }],
    };
  }
  const parsed = parseLootFilter({
    action: action === 'v' ? 'sell' : 'salvage',
    belowRarity: below === '' ? null : below,
    wantedAffixes: affixes,
    wantedEffects: effects,
    include,
  });
  if (!parsed.ok) return { ok: false, error: 'invalid', problems: parsed.problems };
  // Duplicates would be dropped silently by the parser; a code with them was not made here.
  if (
    parsed.rules.wantedAffixes.length !== affixes.length ||
    parsed.rules.wantedEffects.length !== effects.length
  ) {
    return { ok: false, error: 'malformed' };
  }
  return { ok: true, rules: parsed.rules };
}

/** A preset as stored on the hero (`characters.loot_filter_presets`). */
export interface LootFilterPreset {
  name: string;
  /** Null = "no filter". */
  rules: LootFilterRules | null;
}

/** Trims and checks a preset name; null when it is empty, too long or has control characters. */
export function normalisePresetName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.replace(/\s+/g, ' ').trim();
  if (name.length === 0 || [...name].length > LOOT_FILTER_PRESET_NAME_MAX) return null;
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    // Control characters, zero-width marks and bidirectional overrides.
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return null;
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)) return null;
    if (c >= 0x2066 && c <= 0x2069) return null;
  }
  return name;
}
