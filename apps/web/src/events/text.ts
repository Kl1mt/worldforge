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
  // Ticket 8.3: the Lantern Procession's track has a crest style and a hero appearance.
  crest: 'Crest style',
  appearance: 'Hero appearance',
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
        : t.cosmetic.kind === 'appearance'
          ? 'Dress any of your heroes in it from your collection book.'
          : 'Show it from your collection book.',
  }));
}

/** "34 of 50 bone tallies". */
export function talliesLine(event: EventView, track: HeroEvent['track']): string {
  const top = event.track.at(-1)?.tallies ?? 0;
  return `${Math.min(track?.tallies ?? 0, top).toLocaleString('en-GB')} of ${top.toLocaleString('en-GB')} ${event.tallyName}`;
}

const opens = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/** Ticket 8.3: "Opens Monday 16 June" (local time). */
export function weekOpens(opensAt: string): string {
  return `Opens ${opens.format(new Date(opensAt))}`;
}

export interface WeekGroup<Q> {
  week: number;
  /** Begun (its tasks advance), under way now, or still to come. */
  state: 'past' | 'now' | 'later';
  opensAt: string;
  quests: { quest: Q; index: number }[];
}

/**
 * Ticket 8.3: an event's quests by week, in order. A one-week event (the Harvest) is one group.
 * `index` is the quest's place in the definition (the hero's progress list).
 */
export function questWeeks<Q extends { week: number; opensAt: string }>(event: {
  week: number;
  quests: readonly Q[];
}): WeekGroup<Q>[] {
  const groups = new Map<number, WeekGroup<Q>>();
  event.quests.forEach((quest, index) => {
    const w = quest.week;
    if (!groups.has(w)) {
      groups.set(w, {
        week: w,
        state: w < event.week ? 'past' : w === event.week ? 'now' : 'later',
        opensAt: quest.opensAt,
        quests: [],
      });
    }
    groups.get(w)!.quests.push({ quest, index });
  });
  return [...groups.values()].sort((a, b) => a.week - b.week);
}

/** Ticket 8.3: bonus materials in words, e.g. "3 extra Iron Ore" (empty: none yet). */
export function bonusWords(bonus: Record<string, number>, name: (id: string) => string): string {
  return Object.entries(bonus)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${n.toLocaleString('en-GB')} extra ${name(id)}`)
    .join(' and ');
}
