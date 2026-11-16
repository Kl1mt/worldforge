import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_GROWTH_RULES,
  ACTIVE_SKILLS,
  AUTO_SKILLS,
  BASE_CHARACTER_SLOTS,
  CLASS_IDS,
  OFFLINE_BONUS_STEPS_MS,
  PASSIVE_SKILLS,
  RESOURCE_RULES,
  SHRINE_BANK_LIMIT,
  SHRINE_PLAY_DRAWS,
  defaultLoadout,
  isDefaultLoadout,
  shrineOdds,
  validateLoadout,
  type ClassId,
  type Loadout,
} from '../index.js';
import { B7_LEADERS } from './skills-balance.js';

/**
 * Ticket 9.6: the Phase 9 exit criterion in numbers (docs/ROADMAP.md Phase 9 exit; docs/BALANCE.md
 * "Phase 9 exit criterion"). The kill rates, boss times and duel shares are B.7's, measured by its
 * guards (`skills-balance.test.ts`, ~2 min; `skills-pvp-balance.test.ts`) and the default-loadout
 * replay (`combat/skills-live.test.ts`); this file pins the structure the criterion's other
 * clauses read, in game-core only, so a clause fails only when content changes:
 * - each class's resource drives its skills (six actives and four passives, plus a later-content
 *   active and passive taught by the skill quests; damage over time for the warlock, mage, hunter);
 * - the loadouts B.7 found leading are fieldable, and no class has one loadout that leads every job;
 * - the default loadout is today's class skill alone;
 * - accounts grow by playing (slots 2 → 5, offline 3 → 8 hours, the Shrine's free bank of 7 and its
 *   play draws), and no rule grants a slot, an hour or a draw from any other source.
 * The server half (the import scan, the invariance with loadouts, companions and shop rows) is
 * `apps/server/src/phase9-no-pay-to-win.test.ts`.
 */
const HOUR = 3_600_000;

const parse = (key: string): Loadout => {
  const [actives, passive] = key.split('/');
  const a = actives!.split(',').map((s) => (s === '' || s === '-' ? null : s));
  while (a.length < 3) a.push(null);
  return { actives: a, passive: passive && passive !== '-' ? passive : null };
};

describe('Phase 9 exit criterion (ticket 9.6)', () => {
  it('each class’s resource drives its own skills: 6 + 4, a later-content pair, damage over time', () => {
    const resources = new Set<string>();
    for (const c of CLASS_IDS) {
      const actives = ACTIVE_SKILLS.filter((s) => s.classId === c);
      const passives = PASSIVE_SKILLS.filter((s) => s.classId === c);
      const deed = (s: { unlock: { deed?: string } }) => s.unlock.deed !== undefined;
      expect(
        actives.filter((s) => !deed(s)),
        c,
      ).toHaveLength(6);
      expect(
        passives.filter((s) => !deed(s)),
        c,
      ).toHaveLength(4);
      // The skill quests teach one active and one passive (the Tyrant's and the Sovereign's).
      expect(actives.filter(deed).map((s) => s.unlock.deed)).toEqual(['forgeTyrantSkillLearned']);
      expect(passives.filter(deed).map((s) => s.unlock.deed)).toEqual([
        'hollowSovereignSkillLearned',
      ]);
      // Unlocked from level 1 to about 40.
      const levels = [...actives, ...passives].map((s) => s.unlock.level);
      expect(Math.min(...levels)).toBe(1);
      expect(Math.max(...levels)).toBeLessThanOrEqual(46);
      // The spenders pay in the class's resource (the warlock's are Soul Fragments).
      expect(
        actives.some((s) => s.kind === 'spender' && (s.cost ?? 0) > 0),
        c,
      ).toBe(true);
      resources.add(JSON.stringify(RESOURCE_RULES[c]));
    }
    expect(resources.size).toBe(CLASS_IDS.length);
    const dots = (c: ClassId) => ACTIVE_SKILLS.filter((s) => s.classId === c && s.dot).length;
    expect(dots('warlock')).toBeGreaterThanOrEqual(2);
    for (const c of ['mage', 'hunter'] as const) expect(dots(c)).toBeGreaterThanOrEqual(1);
  });

  it('the default loadout is today’s class skill alone, and every B.7 leader can be fielded', () => {
    for (const c of CLASS_IDS) {
      expect(defaultLoadout(c).actives[0]).toBe(AUTO_SKILLS[c].id);
      expect(isDefaultLoadout(c, defaultLoadout(c))).toBe(true);
    }
    for (const [job, byClass] of Object.entries(B7_LEADERS)) {
      const level = Number(/(\d+)$/.exec(job)?.[1] ?? 52);
      for (const c of CLASS_IDS) {
        const l = parse(byClass[c]);
        const problems = validateLoadout(c, l, {
          level,
          progress: { forgeTyrantSkillLearned: true, hollowSovereignSkillLearned: true },
        });
        expect(problems, `${job} ${c} ${byClass[c]}`).toEqual([]);
      }
    }
  });

  it('no loadout leads farming and the boss of the same tier for any class (B.7 1)', () => {
    const pairs = [
      ['depths', 'tyrant38'],
      ['deep', 'sovereign'],
    ] as const;
    for (const [farm, boss] of pairs) {
      const f = B7_LEADERS[farm]!;
      const b = B7_LEADERS[boss]!;
      for (const c of CLASS_IDS) expect(f[c], `${farm} × ${boss} ${c}`).not.toBe(b[c]);
    }
  });

  it('accounts grow by playing: slots 2 → 5, offline 3 → 8 hours, the Shrine’s bank and play draws', () => {
    expect(BASE_CHARACTER_SLOTS).toBe(2);
    const slots = ACCOUNT_GROWTH_RULES.filter((r) => r.kind === 'slot');
    expect(slots.map((r) => r.id)).toEqual(['level28', 'heroicCrypt', 'community']);
    const offline = ACCOUNT_GROWTH_RULES.filter((r) => r.kind === 'offline');
    expect(offline).toHaveLength(OFFLINE_BONUS_STEPS_MS.length - 1);
    expect(OFFLINE_BONUS_STEPS_MS.map((ms) => 3 + ms / HOUR)).toEqual([3, 4, 5, 6, 8]);
    // Every rule is a deed: none is bought (the shop source is reserved, ROADMAP 8.8).
    for (const r of ACCOUNT_GROWTH_RULES) expect(r.unlock.kind).not.toBe('shop');
    expect(SHRINE_BANK_LIMIT).toBe(7);
    expect(Object.keys(SHRINE_PLAY_DRAWS).sort()).toEqual(['deed', 'eventTier', 'season']);
    const total = shrineOdds().reduce((s, o) => s + o.chance, 0);
    expect(total).toBeCloseTo(1, 12);
  });
});
