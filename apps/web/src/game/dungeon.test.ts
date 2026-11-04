import { describe, expect, it } from 'vitest';
import { dungeonRunProgress, simulateDungeonRun } from '@worldforge/game-core';
import { claimKey, cryptLogLine, describeDungeonFailure, dungeonApi } from './dungeon';

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
    const lines = dungeonRunProgress(run, run.durationMs, 10_000)
      .events.map((e) => cryptLogLine(e, run.totalRooms))
      .filter((l) => l !== null);
    expect(lines[0]!.text).toContain('chamber 1 of 4');
    expect(lines.at(-1)!.tone).toBe('fall');
  });

  it('explains dungeon errors', () => {
    expect(describeDungeonFailure({ code: 'dungeon_run_open' })).toMatch(/already/);
    expect(describeDungeonFailure({ code: 'weird' })).toMatch(/wrong/);
  });
});
