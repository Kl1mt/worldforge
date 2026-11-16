import type { ShrineRarity } from '@worldforge/game-core';

/** Ticket 9.5: the Shrine's words (docs/SHRINE.md). Pure, so they are tested on their own. */

export const RARITY_NAMES: Record<ShrineRarity, string> = {
  common: 'Common',
  rare: 'Rare',
  hallowed: 'Hallowed',
};

/** A chance as the Shrine prints it: `11.667 %`, `70 %`. */
export function percent(chance: number): string {
  const p = chance * 100;
  const fixed = p.toFixed(3);
  return `${fixed.replace(/\.?0+$/, '')} %`;
}

/** "3 draws", "1 draw". */
export function drawsWord(n: number): string {
  return `${n} draw${n === 1 ? '' : 's'}`;
}

/** The free bank in a line: what is kept, and when the next one comes. */
export function bankLine(
  daily: number,
  limit: number,
  nextFreeAt: string | null,
  now: Date,
): string {
  if (nextFreeAt === null) {
    return `Your free bank is full (${limit} of ${limit}). Draw to make room for tomorrow’s.`;
  }
  const ms = Date.parse(nextFreeAt) - now.getTime();
  const hours = Math.max(0, Math.floor(ms / 3_600_000));
  const minutes = Math.max(0, Math.floor((ms % 3_600_000) / 60_000));
  const when = hours > 0 ? `in ${hours} h ${minutes} min` : `in ${minutes} min`;
  return `${daily} of ${limit} free draws kept. The next comes ${when} (midnight UTC).`;
}

/** A refusal in plain words. */
export function shrineFailure(code: string): string {
  switch (code) {
    case 'no_draws':
      return 'You have no draws left. A free one comes every day; events, deeds and seasons give more.';
    case 'already_owned':
      return 'You already have that keepsake.';
    case 'insufficient_marks':
      return 'You do not have enough Shrine marks for that yet.';
    case 'unknown_offer':
      return 'The Shrine does not offer that.';
    case 'network':
      return 'The Shrine could not be reached. Try again in a moment.';
    case 'rate_limited':
      return 'Too many at once. Wait a moment and try again.';
    default:
      return 'That did not work. Try again in a moment.';
  }
}

/** What a draw gave, in a line. */
export function drawLine(name: string, outcome: 'grant' | 'marks', marks: number): string {
  return outcome === 'grant'
    ? `${name} is yours. It waits in the collection book.`
    : `${name} again: it turns into ${marks} Shrine mark${marks === 1 ? '' : 's'}.`;
}
