import { describe, expect, it } from 'vitest';
import {
  DUEL_REFUSALS,
  ITEM_BASES,
  RATED_DUELS_PER_DAY,
  RATED_DUEL_MIN_LEVEL,
  RELATIONS,
  canClassUseItem,
  createRng,
  duelDay,
  duelDecision,
  duelFighter,
  duelSnapshot,
  equipmentSlotsForKind,
  friendlyBracket,
  generateItem,
  nextDuelDayAt,
  simulateDuel,
  type ClassId,
  type DuelFacts,
  type DuelKind,
  type Relation,
  type ScoredItem,
} from '../index.js';

/** Ticket 5.5: the arena's rules (limits, duel day, permission matrix, snapshots). */

function kit(classId: ClassId, itemLevel: number): ScoredItem[] {
  const rng = createRng(`arena-kit:${classId}:${itemLevel}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= itemLevel && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const out: ScoredItem[] = [];
  const taken = new Set<string>();
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of equipmentSlotsForKind(base.slot)) {
      const item = generateItem({
        seed: rng.int(0, 2 ** 31),
        itemLevel,
        baseId: base.id,
        rarityId: 'rare',
        classId,
      })!;
      out.push({ ...item, slot, upgradeLevel: 2 });
    }
  }
  return out;
}

const facts = (over: Partial<DuelFacts> = {}): DuelFacts => ({
  relation: 'stranger',
  guildmate: false,
  defenderSanctioned: false,
  challengerLevel: 14,
  defenderLevel: 17,
  ratedToday: 0,
  ...over,
});

describe('the permission matrix (relation × kind)', () => {
  // Hand-written: the documented table in `arena.ts` and docs/PVP.md.
  const expected: Record<Relation, Record<DuelKind, string>> = {
    self: { rated: 'cannot_target_self', friendly: 'cannot_target_self' },
    stranger: { rated: 'allowed', friendly: 'not_friend_or_guildmate' },
    'requested-by-me': { rated: 'allowed', friendly: 'not_friend_or_guildmate' },
    'requested-by-them': { rated: 'allowed', friendly: 'not_friend_or_guildmate' },
    friend: { rated: 'allowed', friendly: 'allowed' },
    'blocked-by-me': { rated: 'not_found', friendly: 'not_found' },
    'blocked-by-them': { rated: 'not_found', friendly: 'not_found' },
  };
  const code = (d: ReturnType<typeof duelDecision>) => (d === 'allowed' ? d : d.code);

  for (const relation of RELATIONS) {
    for (const kind of ['rated', 'friendly'] as const) {
      it(`${relation} × ${kind}`, () => {
        expect(code(duelDecision(kind, facts({ relation })))).toBe(expected[relation][kind]);
      });
    }
  }

  it('a shared guild opens friendly challenges, but never past a block', () => {
    for (const relation of ['stranger', 'requested-by-me', 'requested-by-them'] as const)
      expect(duelDecision('friendly', facts({ relation, guildmate: true }))).toBe('allowed');
    for (const relation of ['blocked-by-me', 'blocked-by-them'] as const)
      expect(duelDecision('friendly', facts({ relation, guildmate: true }))).toBe(
        DUEL_REFUSALS.notFound,
      );
  });

  it('a sanctioned defender is never fought', () => {
    for (const kind of ['rated', 'friendly'] as const)
      expect(duelDecision(kind, facts({ relation: 'friend', defenderSanctioned: true }))).toBe(
        DUEL_REFUSALS.notFound,
      );
  });

  it('rated duels open at level 10; friendly challenges at any level', () => {
    expect(RATED_DUEL_MIN_LEVEL).toBe(10);
    for (let level = 1; level < 10; level++) {
      expect(duelDecision('rated', facts({ challengerLevel: level, defenderLevel: level }))).toBe(
        DUEL_REFUSALS.levelTooLow,
      );
      expect(duelDecision('friendly', facts({ relation: 'friend', challengerLevel: level }))).toBe(
        'allowed',
      );
    }
    expect(duelDecision('rated', facts({ challengerLevel: 10, defenderLevel: 19 }))).toBe(
      'allowed',
    );
  });

  it('rated duels stay inside one bracket', () => {
    expect(duelDecision('rated', facts({ challengerLevel: 19, defenderLevel: 20 }))).toBe(
      DUEL_REFUSALS.wrongBracket,
    );
    expect(
      duelDecision(
        'friendly',
        facts({ relation: 'friend', challengerLevel: 3, defenderLevel: 31 }),
      ),
    ).toBe('allowed');
  });

  it('ten rated duels a day; friendly challenges are not counted', () => {
    expect(RATED_DUELS_PER_DAY).toBe(10);
    expect(duelDecision('rated', facts({ ratedToday: 9 }))).toBe('allowed');
    expect(duelDecision('rated', facts({ ratedToday: 10 }))).toBe(DUEL_REFUSALS.noDuelsLeft);
    expect(duelDecision('friendly', facts({ relation: 'friend', ratedToday: 10 }))).toBe('allowed');
  });
});

describe('the duel day', () => {
  it('is the UTC date of the game clock and turns at UTC midnight', () => {
    expect(duelDay(new Date('2026-11-08T23:59:59.999Z'))).toBe('2026-11-08');
    expect(duelDay(new Date('2026-11-09T00:00:00.000Z'))).toBe('2026-11-09');
    expect(nextDuelDayAt(new Date('2026-11-08T23:59:59.999Z')).toISOString()).toBe(
      '2026-11-09T00:00:00.000Z',
    );
    expect(nextDuelDayAt(new Date('2026-12-31T08:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});

describe('snapshots', () => {
  it('stores the checked items only, and lists what it left out', () => {
    const items = kit('warrior', 14);
    const forged = { ...items[0]!, itemLevel: 99 };
    const tooHigh = { ...items[1]!, upgradeLevel: 99 };
    const snap = duelSnapshot({
      classId: 'warrior',
      level: 15,
      xp: 120,
      name: 'Brannoc',
      equipment: [forged, tooHigh, ...items.slice(2)],
    });
    expect(snap.equipment).toHaveLength(items.length - 2);
    expect(snap.rejected.sort()).toEqual(['invalid_item', 'invalid_upgrade']);
    expect(snap).toMatchObject({ classId: 'warrior', level: 15, xp: 120, heroName: 'Brannoc' });
  });

  it('a forged item stored in a snapshot still counts nothing in the duel', () => {
    const items = kit('mage', 22);
    const clean = duelSnapshot({ classId: 'mage', level: 24, xp: 0, name: 'A', equipment: items });
    const forged = {
      ...clean,
      equipment: [
        ...clean.equipment,
        { ...items[0]!, slot: 'trinket', itemLevel: 99, affixes: [] } as ScoredItem,
      ],
    };
    expect(duelFighter(forged)).toEqual(duelFighter(clean));
  });

  it('replays the same duel from the stored snapshots and seed', () => {
    const a = duelSnapshot({
      classId: 'hunter',
      level: 12,
      xp: 0,
      name: 'A',
      equipment: kit('hunter', 11),
    });
    const b = duelSnapshot({
      classId: 'warlock',
      level: 33,
      xp: 0,
      name: 'B',
      equipment: kit('warlock', 29),
    });
    const stored = JSON.parse(JSON.stringify({ a, b })) as { a: typeof a; b: typeof b };
    const input = (x: typeof a, y: typeof b) => ({
      challenger: duelFighter(x),
      defender: duelFighter(y),
      seed: 'arena-replay',
      bracketId: friendlyBracket(x.level, y.level).id,
    });
    expect(simulateDuel(input(stored.a, stored.b))).toEqual(simulateDuel(input(a, b)));
    expect(simulateDuel(input(a, b)).bracketId).toBe('10-19');
  });
});
