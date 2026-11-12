import { describe, expect, it } from 'vitest';
import {
  GUILD_HALL_ACTIONS,
  GUILD_HALL_KINDS,
  GUILD_HALL_UPGRADES,
  canAfford,
  findGuildHallUpgrade,
  guildHallDecision,
  hallDisplayProblem,
  hallTotalPrice,
  planTreasuryGift,
  treasuryCap,
  treasuryRoom,
} from './halls.js';

/** Ticket 8.4: guild halls (docs/GUILD_HALLS.md). */

describe('the hall catalogue', () => {
  it('has unique ids, every kind, and carries no stats', () => {
    const ids = GUILD_HALL_UPGRADES.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const k of GUILD_HALL_KINDS)
      expect(GUILD_HALL_UPGRADES.some((u) => u.kind === k)).toBe(true);
    for (const u of GUILD_HALL_UPGRADES) {
      expect(Object.keys(u).sort()).toEqual(['description', 'id', 'kind', 'name', 'price']);
      expect(Object.keys(u.price).sort()).toEqual(['gold', 'materials']);
      expect(u.price.gold).toBeGreaterThan(0);
      expect(u.id).toMatch(/^[a-z-]+\.[a-z0-9-]+$/);
    }
  });

  it('prices the whole hall (pinned)', () => {
    expect(hallTotalPrice()).toEqual({
      gold: 238_000,
      timber: 120,
      rawHide: 100,
      ironOre: 290,
      soulShard: 390,
      abbeySilver: 70,
    });
    expect(treasuryCap('gold')).toBe(23_800);
    expect(treasuryCap('abbeySilver')).toBe(7);
  });
});

describe('treasury gifts', () => {
  const none = new Set<string>();
  it('take at most the daily cap and the room left', () => {
    const p = planTreasuryGift(none, {}, {}, { gold: 50_000, timber: 5 });
    expect(p.accepted).toEqual({ gold: 23_800, timber: 5 });
    expect(p.limited).toEqual({ gold: 'cap' });
    const again = planTreasuryGift(none, { gold: 23_800 }, { gold: 23_800 }, { gold: 1 });
    expect(again.accepted).toEqual({});
    expect(again.limited).toEqual({ gold: 'cap' });
    const owned = new Set(
      GUILD_HALL_UPGRADES.filter((u) => u.id !== 'guild-colour.forge-gold').map((u) => u.id),
    );
    expect(treasuryRoom(owned, { gold: 2_000 }).gold).toBe(10_000);
    const room = planTreasuryGift(owned, { gold: 2_000 }, {}, { gold: 20_000, ironOre: 3 });
    expect(room.accepted).toEqual({ gold: 10_000 });
    expect(room.limited).toEqual({ gold: 'room', ironOre: 'room' });
  });

  it('refuse odd offers', () => {
    expect(() => planTreasuryGift(none, {}, {}, { gold: 0 })).toThrow(RangeError);
    expect(() => planTreasuryGift(none, {}, {}, { gold: 1.5 })).toThrow(RangeError);
    expect(() => planTreasuryGift(none, {}, {}, { crownShard: 1 } as never)).toThrow(RangeError);
  });

  it('one account alone needs at least ten days for the whole hall', () => {
    const total = hallTotalPrice();
    for (const [r, n] of Object.entries(total)) {
      expect(Math.ceil(n / treasuryCap(r as never))).toBeGreaterThanOrEqual(10);
    }
  });

  it('afford and display checks', () => {
    const u = findGuildHallUpgrade('crest-frame.iron-rim')!;
    expect(canAfford(u, { gold: 6_000, ironOre: 60 })).toBe(true);
    expect(canAfford(u, { gold: 6_000, ironOre: 59 })).toBe(false);
    expect(hallDisplayProblem('crestFrame', u.id, new Set([u.id]))).toBeNull();
    expect(hallDisplayProblem('crestFrame', u.id, none)).toBe('not_owned');
    expect(hallDisplayProblem('backdrop', u.id, new Set([u.id]))).toBe('wrong_kind');
    expect(hallDisplayProblem('backdrop', 'backdrop.nope', none)).toBe('unknown');
    expect(hallDisplayProblem('backdrop', null, none)).toBeNull();
  });
});

describe('the hall permission matrix', () => {
  it('matches the table', () => {
    const table: Record<string, Record<string, string>> = {
      view: { leader: 'allowed', officer: 'allowed', member: 'allowed', none: 'not_in_guild' },
      contribute: {
        leader: 'allowed',
        officer: 'allowed',
        member: 'allowed',
        none: 'not_in_guild',
      },
      buy: {
        leader: 'allowed',
        officer: 'allowed',
        member: 'guild_forbidden',
        none: 'not_in_guild',
      },
      display: {
        leader: 'allowed',
        officer: 'allowed',
        member: 'guild_forbidden',
        none: 'not_in_guild',
      },
    };
    for (const a of GUILD_HALL_ACTIONS)
      for (const s of ['leader', 'officer', 'member', 'none'] as const) {
        const d = guildHallDecision(s, a);
        expect(d === 'allowed' ? d : d.code, `${s} ${a}`).toBe(table[a]![s]);
      }
  });
});
