import type { EventView, HeroEvent } from './api';

/**
 * Ticket 6.6: plain words for events (the Tavern, the banner, the admin folio). Pure, tested in
 * `text.test.ts`.
 */

const until = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

/** "until Monday 30 November, 01:00" (the window's end is exclusive; local time). */
export function eventUntil(e: Pick<EventView, 'endsAt'>): string {
  return `until ${until.format(new Date(e.endsAt))}`;
}

/** "from Monday 23 November, 01:00". */
export function eventFrom(e: Pick<EventView, 'startsAt'>): string {
  return `from ${until.format(new Date(e.startsAt))}`;
}

/** Days and hours left, e.g. "6 days left", "5 hours left", "less than an hour left". */
export function timeLeft(endsAt: string, now: string): string {
  const ms = Math.max(0, Date.parse(endsAt) - Date.parse(now));
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 48) return `${Math.floor(hours / 24)} days left`;
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} left`;
  return 'less than an hour left';
}

export type TierState = 'granted' | 'reached' | 'open';

export interface TierLine {
  tier: number;
  tallies: number;
  name: string;
  kind: string;
  state: TierState;
  /** Where the reward is worn: Season honours (titles) or the collection book (6.8). */
  where: string;
}

const KIND_WORD: Record<string, string> = {
  title: 'Title',
  banner: 'Banner style',
  titleColour: 'Title colour',
};

/** The reward track for the account, tier by tier. */
export function trackLines(event: EventView, track: HeroEvent['track']): TierLine[] {
  const tallies = track?.tallies ?? 0;
  const granted = new Set(track?.granted.map((g) => g.tier) ?? []);
  return event.track.map((t) => ({
    tier: t.tier,
    tallies: t.tallies,
    name: t.cosmetic.name,
    kind: KIND_WORD[t.cosmetic.kind] ?? 'Keepsake',
    state: granted.has(t.tier) ? 'granted' : tallies >= t.tallies ? 'reached' : 'open',
    // Ticket 6.8: every keepsake is worn from the collection book; titles also from honours.
    where:
      t.cosmetic.kind === 'title'
        ? 'Choose it on your profile, under Season honours, or in the collection book.'
        : 'Show it from your collection book.',
  }));
}

/** "34 of 50 bone tallies". */
export function talliesLine(event: EventView, track: HeroEvent['track']): string {
  const top = event.track.at(-1)?.tallies ?? 0;
  return `${Math.min(track?.tallies ?? 0, top).toLocaleString('en-GB')} of ${top.toLocaleString('en-GB')} ${event.tallyName}`;
}
