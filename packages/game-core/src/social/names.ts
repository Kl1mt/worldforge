import { ENEMIES } from '../world/enemies.js';
import { GUILD_BOSSES } from '../guild-boss/definitions.js';
import { STORY_QUESTS } from '../quests/definitions.js';
import { foldScripts, normalizePlayerText } from './text.js';

/**
 * Look-alike names and reserved names (ticket 6.9, docs/SOCIAL.md "Look-alike and reserved
 * names"). Shared by the server (authoritative) and the client (hints only).
 *
 * A name's **skeleton** is what it looks like, not how it is spelled: two names with the same
 * skeleton could be told apart only by a careful reader, so a new or changed name may not share
 * its skeleton with an existing name of the same kind (display names, hero names, guild names).
 * Names taken before 6.9 are grandfathered: they are compared against, never re-checked.
 *
 * The skeleton: the player-text normalisation (NFKC, invisible characters removed), accents
 * removed, look-alike letters of other scripts folded to Latin (Cyrillic `а`, Greek `Α`, small
 * capitals, Armenian, Cherokee; the same tables as the block list), lower-cased, digits and
 * symbols read as the letters they imitate (`0`→o, `1`→i, `3`→e, `4`→a, `5`→s, `7`→t, `8`→b,
 * `9`→g, `@`→a, `$`→s, `|`/`!`→i), `l` and `i` read alike (a capital `I` and a small `l` look the
 * same), `rn`→m and `vv`→w, and separators (spaces, hyphens, apostrophes, underscores) dropped.
 * So `Admín`, `Adm1n`, `ADMlN` and `Аdmin` (Cyrillic а) all read `admin`, and `Аlice` next to
 * `Alice` is refused.
 *
 * Accepted: names that differ only by `i`/`l` (`Lia` and `Ila`) or by `rn`/`m` count as alike;
 * the player picks another. Letters of other scripts with no Latin look-alike stay as they are
 * (a Japanese name never collides with a Latin one).
 */
export const NAME_SKELETON_VERSION = 1;

const SKELETON_DIGITS: Record<string, string> = {
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
  '8': 'b',
  '9': 'g',
};

/** The skeleton's words (letters and digits of other scripts kept, separators dropped). */
export function nameSkeletonWords(raw: string): string[] {
  const folded = foldScripts(normalizePlayerText(raw))
    .map((c) => {
      const m = SKELETON_DIGITS[c] ?? c;
      if (m === 'l') return 'i';
      return /^[\p{L}\p{N}]$/u.test(m) ? m : ' ';
    })
    .join('');
  return folded
    .split(' ')
    .filter(Boolean)
    .map((w) => w.replace(/rn/g, 'm').replace(/vv/g, 'w'));
}

/** The skeleton as one string (the stored, compared form). */
export function nameSkeleton(raw: string): string {
  return nameSkeletonWords(raw).join('');
}

/** Whether two names look alike (same skeleton). */
export function namesLookAlike(a: string, b: string): boolean {
  return nameSkeleton(a) === nameSkeleton(b);
}

/** One reserved name: who it belongs to, for the admin panel. */
export interface ReservedNameDefault {
  name: string;
  group: 'staff' | 'boss' | 'npc';
}

/** One-word names this long or longer are also refused inside a longer word ("Gravewardenfan"). */
const RESERVED_INSIDE_WORD_MIN = 6;

const stripThe = (name: string) => name.replace(/^The /, '');

/**
 * The built-in reserved names (always on; the admin panel and CLI add more): staff and the game
 * itself, every boss, and the town's people as players meet them. Bare first names of the town's
 * people (`Maud`) stay free: they are ordinary names.
 */
export const RESERVED_NAME_DEFAULTS: readonly ReservedNameDefault[] = [
  ...[
    'Admin',
    'Administrator',
    'Moderator',
    'Game Master',
    'Staff',
    'Support',
    'System',
    'Official',
    'Developer',
    'Dev Team',
    'Worldforge',
  ].map((name) => ({ name, group: 'staff' as const })),
  ...[
    ...new Set([
      ...ENEMIES.filter((e) => e.rank === 'boss').map((e) => stripThe(e.name)),
      ...GUILD_BOSSES.map((b) => stripThe(b.name)),
    ]),
  ].map((name) => ({ name, group: 'boss' as const })),
  ...[
    ...new Set(
      STORY_QUESTS.flatMap((q) => {
        const full = q.giver.split(',')[0]!.trim();
        // "Old Reeve Hadric" → also "Reeve Hadric"; "Captain Ysolde of the Watch" → "Captain Ysolde".
        const parts = full.split(' ');
        const titled = full.replace(/^Old /, '').replace(/ of the .*$/, '');
        return parts.length > 1 ? [full, titled] : [full];
      }),
    ),
  ].map((name) => ({ name, group: 'npc' as const })),
];

/**
 * Whether `candidate` imitates the reserved `entry`: the same skeleton, the entry's words in a row
 * inside the candidate's ("Captain Ysolde Jr"), or a long one-word entry inside one of its words
 * ("TheGravewarden").
 */
export function matchesReservedName(candidate: string, entry: string): boolean {
  const c = nameSkeletonWords(candidate);
  const e = nameSkeletonWords(entry);
  if (e.length === 0 || c.length === 0) return false;
  const cs = c.join('');
  const es = e.join('');
  if (cs === es) return true;
  for (let i = 0; i + e.length <= c.length; i++) {
    if (e.every((w, j) => c[i + j] === w)) return true;
  }
  // A one-word entry inside a longer word; a several-word one only as its words ("Ashen Wardens"
  // stays free: the boss is "Ashen Warden").
  return e.length === 1 && es.length >= RESERVED_INSIDE_WORD_MIN && cs.includes(es);
}

/** The first reserved name (built in or from the store) the candidate imitates, or null. */
export function reservedNameMatch(candidate: string, extra: readonly string[] = []): string | null {
  for (const d of RESERVED_NAME_DEFAULTS) if (matchesReservedName(candidate, d.name)) return d.name;
  for (const name of extra) if (matchesReservedName(candidate, name)) return name;
  return null;
}
