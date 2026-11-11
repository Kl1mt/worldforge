import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  DEFAULT_ECONOMY_CONFIG,
  createRng,
  generateItem,
  getLootTable,
  merchantStock,
  settleFarming,
  simulateDungeonRun,
  xpToNextLevel,
  type EquippedItem,
} from '../index.js';

/**
 * Ticket 8.1: the Hollow Reach changes nothing at or below level 40. These hashes were computed on
 * `main` before 8.1 (commit 8357578) and pin, for every class: an hour in the Cinder Depths at 34,
 * 37 and 40 with the Depths' own drops; a Forge Tyrant run and a Heroic crypt run; the Depths' and
 * the Tyrant hoard's item rolls at every item level they drop (41 included: tier 5 never drops
 * there); the Depths merchant's stock; and the XP curve to 40. 6.1's ≤ 28 and 6.2's ≤ 34 pins (the
 * no-effects hashes, `progression.test.ts`, `loot.test.ts`, `curve-pins-6-2.test.ts`) stay as they are.
 */
const hash = (v: unknown) => {
  const text = JSON.stringify(v);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
};

const depthsKit = (classId: (typeof CLASS_IDS)[number]): EquippedItem[] => {
  const rng = createRng(`pin81:${classId}`);
  const table = getLootTable('cinderDepths');
  return Array.from({ length: 10 }, () => ({
    ...generateItem({ seed: rng.int(0, 2 ** 31), itemLevel: 39, lootTable: table, classId })!,
    upgradeLevel: 5,
  }));
};

describe('curves at or below level 40 (ticket 8.1 pins)', () => {
  it('the Depths, the Tyrant, Heroic, their rolls, the merchant and the XP curve are as before 8.1', () => {
    const out: Record<string, string> = {};
    for (const classId of CLASS_IDS) {
      const kit = depthsKit(classId);
      for (const level of [34, 37, 40]) {
        out[`depths:${classId}:${level}`] = hash(
          settleFarming({
            character: { classId, level, xp: 0 },
            equipment: kit,
            areaId: 'cinderDepths',
            seed: `pin81:${classId}:${level}`,
            firstCycle: 0,
            durationMs: 3_600_000,
            inventoryCount: 0,
          }),
        );
      }
      out[`tyrant:${classId}`] = hash(
        simulateDungeonRun({
          dungeonId: 'tyrantsForge',
          character: { classId, level: 40, xp: 0 },
          equipment: kit,
          seed: `pin81:${classId}`,
          bossLootEligible: true,
          inventoryCount: 0,
        }),
      );
      out[`heroic:${classId}`] = hash(
        simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          tier: 4,
          character: { classId, level: 36, xp: 0 },
          equipment: kit,
          seed: `pin81:${classId}`,
          bossLootEligible: true,
          inventoryCount: 0,
        }),
      );
      out[`merchant:${classId}`] = hash(
        merchantStock(
          {
            characterId: `pin81-${classId}`,
            classId,
            day: '2026-11-11',
            areaIds: ['ashfallVerge', 'cinderDepths'],
          },
          DEFAULT_ECONOMY_CONFIG,
        ),
      );
    }
    const rng = createRng('pin81:rolls');
    const rolls = [];
    for (const tableId of ['cinderDepths', 'forgeTyrant'])
      for (let il = 35; il <= 41; il++)
        for (let i = 0; i < 20; i++)
          rolls.push(
            generateItem({
              seed: rng.int(0, 2 ** 31),
              itemLevel: il,
              lootTable: getLootTable(tableId),
              classId: CLASS_IDS[i % 4]!,
            }),
          );
    out.rolls = hash(rolls);
    out.xp = hash(Array.from({ length: 40 }, (_, i) => xpToNextLevel(i + 1)));
    expect(hash(out)).toBe('ea3f198cb9be4afb');
  });
});
