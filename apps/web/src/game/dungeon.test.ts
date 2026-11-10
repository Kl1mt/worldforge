import { describe, expect, it } from 'vitest';
import { dungeonRunProgress, simulateDungeonRun } from '@worldforge/game-core';
import { claimKey, cryptLog, describeDungeonFailure, dungeonApi } from './dungeon';

describe('crypt client', () => {
  it('sends the idempotency key with the claim', async () => {
    let seen: RequestInit | undefined;
    const f = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ result: {}, character: {} }), { status: 200 });
    }) as typeof fetch;
    await dungeonApi.claim('c1', claimKey('run-1'), f);
    expect(seen?.method).toBe('POST');
    expect((seen?.headers as Record<string, string>)['idempotency-key']).toBe('claim-run-1');
  });

  it('turns every event of a run into a readable line or skips it', () => {
    const run = simulateDungeonRun({
      dungeonId: 'namelessCrypt',
      character: { classId: 'mage', level: 12, xp: 0 },
      seed: 'web-test',
      bossLootEligible: true,
      inventoryCount: 0,
    });
    const lines = cryptLog(
      dungeonRunProgress(run, run.durationMs, 10_000).events,
      run.totalRooms,
      'mage',
    );
    expect(lines[0]!.text).toContain('chamber 1 of 4');
    expect(lines.at(-1)!.tone).toBe('fall');
    // Hit lines name the skill and the foe, never a bare "Skill for 156".
    const hits = lines.filter((l) => l.tone === 'hit');
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.text).toMatch(/^(Firebolt|Your strike) (hits|crits) the \S/);
    expect(lines.some((l) => /Skill for/.test(l.text))).toBe(false);
  });

  it('names the boss without a doubled article', () => {
    const lines = cryptLog(
      [
        {
          t: 0,
          type: 'spawn',
          enemyId: 'gravewarden',
          enemyLevel: 14,
          enemyHealth: 900,
          health: 200,
          maxHealth: 200,
        },
        { t: 1, type: 'attack', damage: 156, crit: false, skill: true, enemyHealth: 744 },
      ],
      4,
      'warrior',
    );
    expect(lines.at(-1)!.text).toBe('Heavy Strike hits the Gravewarden for 156.');
  });

  it('explains dungeon errors', () => {
    expect(describeDungeonFailure({ code: 'dungeon_run_open' })).toMatch(/already/);
    expect(describeDungeonFailure({ code: 'weird' })).toMatch(/wrong/);
  });
});

describe('the weekly boss modifier in the crypt log (ticket 6.3)', () => {
  const spawn = {
    t: 0,
    type: 'spawn' as const,
    enemyId: 'gravewarden' as const,
    enemyLevel: 36,
    enemyHealth: 1000,
    health: 500,
    maxHealth: 500,
  };

  it('logs the first burn only, and the ward and the frenzy once each', () => {
    const lines = cryptLog(
      [
        spawn,
        { t: 4_000, type: 'burn', damage: 30, health: 470 },
        { t: 8_000, type: 'burn', damage: 30, health: 440 },
        { t: 9_000, type: 'wardRaised' },
        { t: 12_000, type: 'burn', damage: 30, health: 410 },
        { t: 14_000, type: 'wardBroken' },
        { t: 15_000, type: 'frenzy' },
      ],
      4,
      'warrior',
    );
    const texts = lines.map((l) => l.text);
    expect(texts.filter((t) => t.startsWith('Burning'))).toEqual([
      'Burning: the flames catch you for 30, and keep burning.',
    ]);
    expect(texts).toContain('A ward rises around the Gravewarden: your blows soften.');
    expect(texts).toContain('The ward breaks. Your blows bite again.');
    expect(texts).toContain('The Gravewarden is frenzied and strikes faster!');
  });

  it('the Heroic Gravewarden’s heavy blow tolls the grave-bell', () => {
    const lines = cryptLog(
      [spawn, { t: 6_000, type: 'enemyAttack', damage: 300, health: 200, heavy: true }],
      4,
      'warrior',
    );
    expect(lines.at(-1)!.text).toBe('The grave-bell tolls: a crushing blow for 300.');
  });
});
