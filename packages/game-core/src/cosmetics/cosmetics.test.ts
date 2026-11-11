import { describe, expect, it } from 'vitest';
import {
  COSMETIC_EXCHANGE,
  ENGRAVINGS,
  ENGRAVING_PRICES,
  engravingKey,
  engravingRefusal,
  exchangeOffer,
  parseEngraving,
} from './exchange.js';
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
      // Ticket 6.11: the exchange's entries (A.13's art, tinted in code).
      'title-colour.seal-wax',
      'title-colour.abbey-silver',
      'banner.silvered-seal',
      'crest.abbey-silver',
      'crest.seal-wax',
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
        case 'exchange':
          // Ticket 6.11: every exchange cosmetic has exactly one offer (and every offer one entry).
          expect(exchangeOffer(c.id), c.id).toBeDefined();
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

  it('has no price and no stats in its definition: only words and a source', () => {
    for (const c of COSMETICS) {
      expect(Object.keys(c).sort()).toEqual(['description', 'id', 'kind', 'name', 'source']);
      expect(['default', 'event', 'achievement', 'milestone', 'season', 'exchange']).toContain(
        c.source.kind,
      );
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

describe('ticket 6.11: the exchange and the engraver', () => {
  it('offers only exchange-sourced cosmetics, once each, priced in Seals and Abbey silver only', () => {
    const ids = COSMETIC_EXCHANGE.map((o) => o.cosmeticId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      COSMETICS.filter((c) => c.source.kind === 'exchange')
        .map((c) => c.id)
        .sort(),
    );
    for (const o of COSMETIC_EXCHANGE) {
      expect(findCosmetic(o.cosmeticId)?.source.kind).toBe('exchange');
      expect(['title', 'appearance']).not.toContain(findCosmetic(o.cosmeticId)!.kind);
      const keys = Object.keys(o.price);
      expect(keys.length, o.cosmeticId).toBeGreaterThan(0);
      for (const k of keys) expect(['gravewardenSeal', 'abbeySilver']).toContain(k);
      for (const n of Object.values(o.price)) expect(Number.isInteger(n) && n! > 0).toBe(true);
    }
    // The prices as documented (docs/ECONOMY.md "Seal and silver sinks").
    expect(Object.fromEntries(COSMETIC_EXCHANGE.map((o) => [o.cosmeticId, o.price]))).toEqual({
      'title-colour.seal-wax': { gravewardenSeal: 3 },
      'title-colour.abbey-silver': { abbeySilver: 25 },
      'banner.silvered-seal': { gravewardenSeal: 2, abbeySilver: 20 },
      'crest.abbey-silver': { abbeySilver: 30 },
      'crest.seal-wax': { gravewardenSeal: 4 },
    });
    expect(ENGRAVING_PRICES).toEqual({ seal: { gravewardenSeal: 2 }, silver: { abbeySilver: 15 } });
  });

  it('engraves only listed epithets, and refuses the same engraving twice', () => {
    expect(new Set(ENGRAVINGS.map((e) => e.id)).size).toBe(ENGRAVINGS.length);
    for (const e of ENGRAVINGS) {
      expect(e.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(e.text.length).toBeLessThanOrEqual(20);
    }
    const ash = { finish: 'seal' as const, engravingId: 'ashbound' };
    expect(engravingKey(ash)).toBe('seal:ashbound');
    expect(parseEngraving('seal:ashbound')).toEqual(ash);
    expect(parseEngraving('silver:ashbound')).toEqual({
      finish: 'silver',
      engravingId: 'ashbound',
    });
    for (const bad of [null, '', 'seal', 'gold:ashbound', 'seal:nope']) {
      expect(parseEngraving(bad)).toBeNull();
    }
    expect(engravingRefusal(null, ash)).toBeNull();
    expect(engravingRefusal('silver:ashbound', ash)).toBeNull();
    expect(engravingRefusal('seal:ashbound', ash)).toBe('same_engraving');
    expect(engravingRefusal(null, { finish: 'seal', engravingId: 'free text' })).toBe(
      'unknown_engraving',
    );
    expect(engravingRefusal(null, { finish: 'gold' as never, engravingId: 'ashbound' })).toBe(
      'unknown_engraving',
    );
  });
});
