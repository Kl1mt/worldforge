import { describe, expect, it } from 'vitest';
import { ACTIVE_SKILLS, CLASSES, PASSIVE_SKILLS, getActiveSkill } from '@worldforge/game-core';
import {
  activeFacts,
  classSkills,
  defaultDraft,
  describeProblem,
  describeResource,
  describeSkillsFailure,
  fitsSlot,
  heroFactsOf,
  loadoutProblems,
  nextDrafts,
  passiveFacts,
  percent,
  placeSkill,
  resourceName,
  skillById,
  skillFacts,
  unlockText,
  type LoadoutDraft,
  type SkillsPresetView,
} from './skills';

const active = (id: string) => getActiveSkill(id)!;
const passive = (id: string) => PASSIVE_SKILLS.find((p) => p.id === id)!;

describe('skills wording (ticket 9.2)', () => {
  it('names each class resource', () => {
    expect(resourceName('warrior')).toBe('Rage');
    expect(resourceName('mage')).toBe('Mana');
    expect(resourceName('hunter')).toBe('Focus');
    expect(resourceName('warlock')).toBe('Soul Fragments');
  });

  it('states each resource rule in one line, from game-core numbers', () => {
    expect(describeResource('warrior')).toBe(
      'Rage (up to 100) starts empty and builds 4 with every attack and 4 with every blow taken.',
    );
    expect(describeResource('mage')).toBe(
      'Mana (up to 100) starts full and comes back 3 a second.',
    );
    expect(describeResource('hunter')).toBe(
      'Focus (up to 100) starts at 20 and builds 15 each second you are not hit; every crit gives 5 back.',
    );
    expect(describeResource('warlock')).toBe(
      'Soul Fragments (up to 3) start empty and build 1 each second a curse ticks; a kill leaves 2 for the next fight.',
    );
  });

  it('formats percentages with one decimal at most', () => {
    expect(percent(1.6)).toBe('160 %');
    expect(percent(1.35)).toBe('135 %');
    expect(percent(0.012)).toBe('1.2 %');
    expect(percent(0.25)).toBe('25 %');
  });

  it('describes actives with their real numbers', () => {
    expect(skillFacts(active('heavyStrike'))).toBe('every 4th attack · 200 % damage');
    expect(skillFacts(active('shieldSlam'))).toBe('50 Rage · 160 % damage');
    expect(skillFacts(active('charge'))).toBe(
      'no cost · 150 % damage · builds 15 Rage · opens every fight',
    );
    expect(skillFacts(active('rend'))).toBe(
      'every 4th attack · 120 % damage · bleeds 25 % a second for 4 s',
    );
    expect(skillFacts(active('execute'))).toBe('30 Rage · 180 % damage · foe below 30 % health');
    expect(skillFacts(active('earthsplitter'))).toBe(
      '40 Rage · 260 % damage · ready 8 s into a fight, then every 15 s',
    );
    expect(skillFacts(active('forgebreaker'))).toBe(
      'all Rage (at least 60) · 100 % damage +1.2 % per point',
    );
    expect(skillFacts(active('aimedShot'))).toBe(
      'every 4th attack · 160 % damage · +25 % crit chance',
    );
    expect(skillFacts(active('soulBurn'))).toBe(
      'all Soul Fragments (at least 2) · 100 % damage +25 % per fragment · every 12 s at most',
    );
    expect(activeFacts(active('corruption'))).toEqual([
      'no cost',
      '60 % damage',
      'withers 8 % a second for 12 s',
      'recast when it ends',
    ]);
  });

  it('describes passives with signed numbers', () => {
    expect(passiveFacts(passive('unyielding'))).toEqual([
      '−8 % damage taken',
      '+2 Rage per blow taken',
    ]);
    expect(passiveFacts(passive('manaShield'))).toEqual(['−6 % damage taken', '−1 Mana a second']);
    expect(skillFacts(passive('deepReserves'))).toBe('+40 Mana at most');
    expect(skillFacts(passive('darkPact'))).toBe(
      '+4 % damage to foes that are not bosses · +1 Soul Fragments kept from a kill',
    );
  });

  it('gives every skill of every class a facts line and an unlock', () => {
    for (const s of [...ACTIVE_SKILLS, ...PASSIVE_SKILLS]) {
      expect(skillFacts(s), s.id).not.toBe('');
      expect(skillFacts(s), s.id).not.toMatch(/undefined|NaN/);
      expect(unlockText(s), s.id).toMatch(/level \d+/);
    }
  });

  it('says how a skill unlocks', () => {
    expect(unlockText(active('charge'))).toBe('Unlocks at level 12');
    expect(unlockText(active('forgebreaker'))).toBe(
      'Taught by the Tyrant’s Lesson (Tavern) · level 36',
    );
    expect(unlockText(passive('hollowWrath'))).toBe(
      'Taught by the Sovereign’s Lesson (Tavern) · level 46',
    );
  });

  it('turns game-core problems into names', () => {
    expect(describeProblem('rend is locked')).toBe('Rend is locked');
    expect(describeProblem('slot 1 holds a core skill, not shieldSlam')).toBe(
      'Slot 1 holds a core skill, not Shield Slam',
    );
    expect(
      describeSkillsFailure({
        code: 'invalid_loadout',
        details: { problems: ['execute is locked'] },
      }),
    ).toBe('That loadout cannot be fielded: Execute is locked.');
    expect(describeSkillsFailure({ code: 'network' })).toMatch(/cannot be reached/);
  });
});

describe('skills loadouts (ticket 9.2)', () => {
  it('groups each class book: two class skills, five spenders, five passives', () => {
    for (const cls of CLASSES) {
      const b = classSkills(cls.id);
      expect(b.core.length, cls.id).toBe(2);
      expect(b.spenders.length, cls.id).toBe(5);
      expect(b.passives.length, cls.id).toBe(5);
      expect(b.core.every((s) => fitsSlot(s, 0) && !fitsSlot(s, 1))).toBe(true);
      expect(b.spenders.every((s) => fitsSlot(s, 1) && fitsSlot(s, 2) && !fitsSlot(s, 0))).toBe(
        true,
      );
      expect(b.passives.every((s) => fitsSlot(s, 3) && !fitsSlot(s, 0))).toBe(true);
    }
  });

  it('places skills, swapping a spender between its two slots', () => {
    const d = defaultDraft('warrior');
    expect(d).toEqual({ actives: ['heavyStrike', null, null], passive: null });
    const a = placeSkill(d, 1, 'shieldSlam');
    const b = placeSkill(a, 2, 'execute');
    expect(b.actives).toEqual(['heavyStrike', 'shieldSlam', 'execute']);
    // Shield Slam into slot 3: Execute moves to slot 2.
    expect(placeSkill(b, 2, 'shieldSlam').actives).toEqual([
      'heavyStrike',
      'execute',
      'shieldSlam',
    ]);
    expect(placeSkill(b, 1, null).actives).toEqual(['heavyStrike', null, 'execute']);
    // Slot 1 is never emptied.
    expect(placeSkill(b, 0, null)).toBe(b);
    expect(placeSkill(b, 3, 'unyielding').passive).toBe('unyielding');
    expect(d.actives).toEqual(['heavyStrike', null, null]);
  });

  it('checks a draft like the server, with the deeds read from the unlocked list', () => {
    const view = {
      classId: 'warrior' as const,
      level: 12,
      unlocked: ['heavyStrike', 'shieldSlam', 'charge', 'unyielding'],
    };
    const ok: LoadoutDraft = { actives: ['heavyStrike', 'shieldSlam', 'charge'], passive: null };
    expect(loadoutProblems(view, ok)).toEqual([]);
    expect(loadoutProblems(view, { ...ok, actives: ['rend', null, null] })).toEqual([
      'Rend is locked',
    ]);
    expect(heroFactsOf({ level: 40, unlocked: ['forgebreaker'] }).progress).toEqual({
      forgeTyrantSkillLearned: true,
    });
    const late = { classId: 'warrior' as const, level: 40, unlocked: ['heavyStrike'] };
    const fb: LoadoutDraft = { actives: ['heavyStrike', 'forgebreaker', null], passive: null };
    expect(loadoutProblems(late, fb)).toEqual(['Forgebreaker is locked']);
    expect(loadoutProblems({ ...late, unlocked: ['heavyStrike', 'forgebreaker'] }, fb)).toEqual([]);
    expect(skillById(null)).toBeUndefined();
  });

  it('keeps unsaved edits of other presets when the server answers', () => {
    const preset = (n: number, actives: (string | null)[]): SkillsPresetView => ({
      preset: n,
      actives,
      passive: null,
      isDefault: false,
      problems: [],
    });
    const before = {
      presets: [preset(1, ['heavyStrike', null, null]), preset(2, ['heavyStrike', null, null])],
    };
    const edited: LoadoutDraft = { actives: ['heavyStrike', 'shieldSlam', null], passive: null };
    const drafts = { 1: edited, 2: edited };
    const next = {
      presets: [
        preset(1, ['heavyStrike', 'shieldSlam', null]),
        preset(2, ['heavyStrike', null, null]),
      ],
    };
    const out = nextDrafts(drafts, before, next, 1);
    expect(out[1]).toEqual(edited);
    expect(out[2]).toBe(edited);
    // A first answer takes the server's loadouts.
    expect(nextDrafts({}, null, next)[2]).toEqual({
      actives: ['heavyStrike', null, null],
      passive: null,
    });
  });
});
