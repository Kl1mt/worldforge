import { describe, expect, it } from 'vitest';
import { RESOURCE_RULES } from '@worldforge/game-core';
import { ResourceMotion } from './resourceMotion';

const strike = { kind: 'heroStrike', foe: 0 } as const;
const hit = { kind: 'heroHit' } as const;
const fall = { kind: 'foeFall', foe: 0 } as const;

describe('the scene’s resource bar (ticket 9.2)', () => {
  it('Rage builds with blows given and taken, and the fight’s end resets it', () => {
    const m = new ResourceMotion('warrior', null);
    expect(m.snapshot()).toMatchObject({ value: 0, max: 100 });
    m.beat(strike, 0);
    m.beat(hit, 300);
    expect(m.snapshot().value).toBe(
      RESOURCE_RULES.warrior.perAttack + RESOURCE_RULES.warrior.perBlowTaken,
    );
    m.beat(fall, 600);
    expect(m.snapshot().value).toBe(0);
  });

  it('a spender of the loadout in force spends its cost when it can', () => {
    const m = new ResourceMotion('warrior', {
      actives: ['heavyStrike', 'shieldSlam', null],
      passive: null,
    });
    let t = 0;
    let max = 0;
    for (let i = 0; i < 40; i++) {
      m.beat(strike, (t += 1000));
      m.beat(hit, (t += 10));
      max = Math.max(max, m.snapshot().value);
    }
    // Shield Slam costs 50: Rage never fills up, it is spent on the way.
    expect(max).toBeLessThan(100);
  });

  it('Mana starts full and comes back every second; Focus builds while unhit', () => {
    const mana = new ResourceMotion('mage', {
      actives: ['firebolt', 'pyroblast', null],
      passive: null,
    });
    expect(mana.snapshot().value).toBe(100);
    mana.beat(strike, 0);
    mana.beat(strike, 1000); // Pyroblast: −80
    const after = mana.snapshot().value;
    expect(after).toBeLessThan(100);
    mana.beat(hit, 4000); // three pulses later
    expect(mana.snapshot().value).toBe(Math.min(100, after + 3 * RESOURCE_RULES.mage.perPulse));

    const focus = new ResourceMotion('hunter', null);
    expect(focus.snapshot().value).toBe(20);
    focus.beat(strike, 0);
    focus.beat(strike, 2000);
    expect(focus.snapshot().value).toBe(20 + 2 * RESOURCE_RULES.hunter.perUnhitPulse);
  });

  it('damage over time ticks on the pulse; a warlock’s curse feeds fragments and a kill leaves some', () => {
    const m = new ResourceMotion(
      'warlock',
      {
        actives: ['shadowBolt', 'corruption', null],
        passive: null,
      },
      2,
    );
    expect(m.snapshot()).toMatchObject({ value: 2, max: 3, ticking: false });
    m.beat(strike, 0); // Corruption (no cost): the curse runs
    expect(m.snapshot().ticking).toBe(true);
    m.beat(strike, 1000);
    expect(m.snapshot().ticks).toBe(1);
    expect(m.snapshot().value).toBe(3);
    m.beat(fall, 1500);
    expect(m.snapshot()).toMatchObject({
      value: RESOURCE_RULES.warlock.carryOnKill,
      ticking: false,
    });
  });

  it('a warlock on the default loadout gathers no fragments (nothing uses them)', () => {
    const m = new ResourceMotion('warlock', null, 0);
    m.beat(strike, 0);
    m.beat(strike, 1500);
    m.beat(fall, 2000);
    expect(m.snapshot()).toMatchObject({ value: 0, ticks: 0 });
  });
});
