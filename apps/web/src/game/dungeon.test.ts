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
        { t: 0, type: 'spawn', enemyId: 'gravewarden', enemyLevel: 14, enemyHealth: 900, health: 200, maxHealth: 200 },
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
