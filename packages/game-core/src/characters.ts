/**
 * Character creation rules (GDD §5.1–5.3). Shared by the server (authoritative) and the client
 * (hints only). The class list itself lives in `classes.ts`.
 */

/** Slots a new account starts with (GDD §5.3). The per-account value is stored on the account. */
export const DEFAULT_CHARACTER_SLOTS = 2;

export const CHARACTER_NAME_MIN = 3;
export const CHARACTER_NAME_MAX = 16;

/**
 * Letters A–Z only, optionally joined by a single `'` or `-` (e.g. `Edric`, `Mael-Dun`,
 * `O'Rourke`). ASCII only, so names cannot impersonate each other with look-alike letters.
 */
const NAME_PATTERN = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;

/** Names that would read as staff or system messages. Compared case-insensitively. */
export const RESERVED_CHARACTER_NAMES: readonly string[] = [
  'admin',
  'administrator',
  'moderator',
  'gamemaster',
  'system',
  'server',
  'worldforge',
];

export type CharacterNameResult = { ok: true; name: string } | { ok: false; message: string };

/** Trims, checks the rules and returns the name as it will be stored, or a player-facing reason. */
export function validateCharacterName(raw: string): CharacterNameResult {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, message: 'Enter a name.' };
  if (name.length < CHARACTER_NAME_MIN || name.length > CHARACTER_NAME_MAX) {
    return {
      ok: false,
      message: `Use ${CHARACTER_NAME_MIN}–${CHARACTER_NAME_MAX} letters.`,
    };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: "Use letters only, with at most one ' or - between parts.",
    };
  }
  if (RESERVED_CHARACTER_NAMES.includes(name.toLowerCase())) {
    return { ok: false, message: 'This name is reserved.' };
  }
  return { ok: true, name };
}

/**
 * The one cosmetic choice in Phase 1: the colour of the banner behind the portrait. Every class
 * uses the warrior portrait until class art exists (GDD §5.1: static images first).
 */
export const BANNER_IDS = ['ash', 'ember', 'moss', 'dusk'] as const;

export type BannerId = (typeof BANNER_IDS)[number];

export interface BannerDefinition {
  id: BannerId;
  name: string;
}

export const BANNERS: readonly BannerDefinition[] = [
  { id: 'ash', name: 'Ash' },
  { id: 'ember', name: 'Ember' },
  { id: 'moss', name: 'Moss' },
  { id: 'dusk', name: 'Dusk' },
];

export interface CharacterAppearance {
  banner: BannerId;
}

export const DEFAULT_APPEARANCE: CharacterAppearance = { banner: 'ash' };

export function isBannerId(value: unknown): value is BannerId {
  return typeof value === 'string' && (BANNER_IDS as readonly string[]).includes(value);
}

/** Level, experience and gold of a freshly created character. */
export const STARTING_CHARACTER = { level: 1, experience: 0, gold: 0 } as const;
