import {
  findAchievement,
  findEventDefinition,
  findPrestigeTier,
  type CosmeticKind,
  type CosmeticMilestone,
  type CosmeticSource,
} from '@worldforge/game-core';

/** Ticket 6.8: the collection book's words (docs/COSMETICS.md). */

export const KIND_LABELS: Record<CosmeticKind, { one: string; many: string }> = {
  appearance: { one: 'Appearance', many: 'Appearances' },
  banner: { one: 'Banner', many: 'Banners' },
  crest: { one: 'Crest', many: 'Crests' },
  titleColour: { one: 'Title colour', many: 'Title colours' },
  title: { one: 'Title', many: 'Titles' },
};

/** The book's tabs, in order. */
export const BOOK_KINDS: readonly CosmeticKind[] = [
  'appearance',
  'banner',
  'crest',
  'titleColour',
  'title',
];

function milestoneText(m: CosmeticMilestone): string {
  switch (m.kind) {
    case 'characterLevel':
      return `Bring a hero to level ${m.level}.`;
    case 'bossDefeated':
      return m.boss === 'ashenWarden'
        ? 'Slay the Ashen Warden in the Warden’s Watch.'
        : 'Slay the Forge Tyrant in the Tyrant’s Forge.';
    case 'cryptTier':
      return m.tier >= 4
        ? 'Clear the Nameless Crypt on Heroic.'
        : `Clear tier ${m.tier} of the Nameless Crypt.`;
  }
}

/** "How to earn it", in plain words. */
export function howToEarn(source: CosmeticSource): string {
  switch (source.kind) {
    case 'default':
      return 'Every hero has it.';
    case 'event': {
      const e = findEventDefinition(source.eventId);
      return e
        ? `A keepsake of the ${e.name} event’s reward track, while it runs.`
        : 'A keepsake of a past event.';
    }
    case 'achievement': {
      const a = findAchievement(source.achievementId);
      return a ? `Earn the deed “${a.name}”: ${a.description}` : 'Earn a deed.';
    }
    case 'milestone':
      return milestoneText(source.milestone);
    case 'season': {
      const t = findPrestigeTier(source.minTier);
      if (source.minTier === 'veteran') return 'Win any honour at a season’s end.';
      if (source.minTier === 'champion') return 'Finish first on a season roll (Champion).';
      return `Win a ${t?.name ?? source.minTier} honour or better at a season’s end.`;
    }
  }
}

/** A short source label for the card's corner. */
export function sourceLabel(source: CosmeticSource): string {
  switch (source.kind) {
    case 'default':
      return 'Default';
    case 'event':
      return 'Event';
    case 'achievement':
      return 'Deed';
    case 'milestone':
      return 'Milestone';
    case 'season':
      return 'Season';
  }
}

/** A refusal in plain words. */
export function equipFailure(code: string): string {
  switch (code) {
    case 'not_owned':
      return 'You have not earned that keepsake yet.';
    case 'wrong_kind':
    case 'unknown_cosmetic':
      return 'That keepsake does not go there.';
    case 'network':
      return 'The herald could not be reached. Try again in a moment.';
    case 'rate_limited':
      return 'Too many changes at once. Wait a moment and try again.';
    default:
      return 'That did not work. Try again in a moment.';
  }
}
