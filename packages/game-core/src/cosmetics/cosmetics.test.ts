import { describe, expect, it } from 'vitest';
import { ACHIEVEMENT_IDS } from '../achievements/definitions.js';
import { EVENT_DEFINITIONS } from '../events/definitions.js';
import {
  COSMETICS,
  COSMETIC_KINDS,
  DEFAULT_APPEARANCE_ID,
  cosmeticScope,
  cosmeticsForAchievements,
  cosmeticsOfKind,
  equipProblem,
  findCosmetic,
  isDefaultCosmetic,
  milestoneCosmeticsEarned,
  seasonCosmeticsEarned,
} from './catalogue.js';

/** Ticket 6.8: the cosmetic catalogue (docs/COSMETICS.md). */

const PREFIX: Record<string, string> = {
  appearance: 'appearance.',
  banner: 'banner.',
  crest: 'crest.',
  titleColour: 'title-colour.',
  title: 'title.',
};

describe('the cosmetic catalogue', () => {
  it('has unique ids named after their kind', () => {
    const ids = COSMETICS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COSMETICS) {
      expect(COSMETIC_KINDS).toContain(c.kind);
      expect(c.id.startsWith(PREFIX[c.kind]!), c.id).toBe(true);
      expect(c.id).toMatch(/^[a-z-]+\.[a-z0-9-]+$/);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('holds every id the art ticket (A.13) and 6.6 use', () => {
    const want = [
      'appearance.default',
      'appearance.ashen',
      'appearance.ember',
      'appearance.grave-moss',
      'appearance.midnight',
      'banner.harvest-sheaf',
      'banner.forgeward',
      'banner.crypt-seal',
      'banner.season-laurel',
      'banner.warden-flame',
      'banner.ember-standard',
      'crest.iron',
      'crest.gilt',
      'crest.bone',
      'crest.ember',
      'title-colour.bone-white',
      'title-colour.ember',
      'title-colour.verdigris',
      'title-colour.royal',
      'title.reaper-of-the-harvest',
    ];
    expect(COSMETICS.map((c) => c.id).sort()).toEqual([...want].sort());
  });

  it('gives every cosmetic one earned source that exists', () => {
    for (const c of COSMETICS) {
      const s = c.source;
      switch (s.kind) {
        case 'default':
          expect(c.id).toBe(DEFAULT_APPEARANCE_ID);
          break;
        case 'event': {
          const def = EVENT_DEFINITIONS.find((e) => e.id === s.eventId);
          expect(def, c.id).toBeDefined();
          expect(def!.track.map((t) => t.cosmeticId)).toContain(c.id);
          break;
        }
        case 'achievement':
          expect(ACHIEVEMENT_IDS, c.id).toContain(s.achievementId);
          break;
        case 'milestone':
        case 'season':
          break;
      }
    }
    // Every event track tier pays a catalogued cosmetic of that event.
    for (const e of EVENT_DEFINITIONS) {
      for (const t of e.track) {
        expect(findCosmetic(t.cosmeticId)?.source).toEqual({ kind: 'event', eventId: e.id });
      }
    }
  });

  it('is never purchasable and has no stats: only words and a source', () => {
    for (const c of COSMETICS) {
      expect(Object.keys(c).sort()).toEqual(['description', 'id', 'kind', 'name', 'source']);
      expect(['default', 'event', 'achievement', 'milestone', 'season']).toContain(c.source.kind);
      // No number anywhere but a milestone's level/tier.
      const json = JSON.stringify(c);
      expect(json).not.toMatch(/\b(price|cost|stats?|power|damage|armou?r|bonus|buy|sell)\b/i);
    }
  });

  // The import scan (nothing in the rules reads this module) is in the server's
  // `cosmetics/cosmetics.test.ts`: game-core's tests have no file system.

  it('scopes appearance to the hero and the rest to the account', () => {
    expect(cosmeticScope('appearance')).toBe('hero');
    for (const k of ['banner', 'crest', 'titleColour', 'title'] as const) {
      expect(cosmeticScope(k)).toBe('account');
    }
    expect(cosmeticsOfKind('appearance').map((c) => c.id)[0]).toBe(DEFAULT_APPEARANCE_ID);
    expect(isDefaultCosmetic(DEFAULT_APPEARANCE_ID)).toBe(true);
    expect(isDefaultCosmetic('banner.forgeward')).toBe(false);
  });
});

describe('earning rules', () => {
  it('maps achievements to their cosmetics', () => {
    expect(cosmeticsForAchievements(['forgewardBuilder'])).toEqual(['banner.forgeward']);
    expect(cosmeticsForAchievements(['gravewardenSlain', 'level10']).sort()).toEqual([
      'appearance.grave-moss',
    ]);
    expect(cosmeticsForAchievements([])).toEqual([]);
  });

  it('reads milestones from the hero', () => {
    const hero = (level: number, progress = {}) => ({ level, progress });
    expect(milestoneCosmeticsEarned(hero(39))).toEqual([]);
    expect(milestoneCosmeticsEarned(hero(40))).toEqual(['appearance.ashen']);
    expect(milestoneCosmeticsEarned(hero(12, { forgeTyrantDefeated: true }))).toEqual([
      'appearance.ember',
    ]);
    expect(milestoneCosmeticsEarned(hero(12, { ashenWardenDefeated: true }))).toEqual([
      'banner.warden-flame',
    ]);
    expect(milestoneCosmeticsEarned(hero(12, { cryptTierCleared: 3 }))).toEqual([]);
    expect(milestoneCosmeticsEarned(hero(12, { cryptTierCleared: 4 }))).toEqual([
      'appearance.midnight',
    ]);
    // A pre-3.6 Gravewarden kill counts as tier I only.
    expect(milestoneCosmeticsEarned(hero(12, { gravewardenDefeated: true }))).toEqual([]);
  });

  it('reads season honours by the best tier', () => {
    expect(seasonCosmeticsEarned([])).toEqual([]);
    expect(seasonCosmeticsEarned(['veteran'])).toEqual(['banner.season-laurel']);
    expect(seasonCosmeticsEarned(['renowned', 'veteran'])).toEqual(['banner.season-laurel']);
    expect(seasonCosmeticsEarned(['exalted']).sort()).toEqual([
      'banner.season-laurel',
      'crest.gilt',
    ]);
    expect(seasonCosmeticsEarned(['veteran', 'champion']).sort()).toEqual([
      'banner.season-laurel',
      'crest.gilt',
      'title-colour.royal',
    ]);
  });

  it('only equips owned cosmetics of the slot’s kind', () => {
    const owned = new Set(['banner.forgeward', 'crest.iron']);
    expect(equipProblem('banner', null, owned)).toBeNull();
    expect(equipProblem('banner', 'banner.forgeward', owned)).toBeNull();
    expect(equipProblem('banner', 'banner.crypt-seal', owned)).toBe('not_owned');
    expect(equipProblem('banner', 'crest.iron', owned)).toBe('wrong_kind');
    expect(equipProblem('crest', 'crest.nope', owned)).toBe('unknown');
    expect(equipProblem('appearance', DEFAULT_APPEARANCE_ID, new Set())).toBeNull();
    expect(equipProblem('appearance', 'appearance.ember', new Set())).toBe('not_owned');
  });
});
