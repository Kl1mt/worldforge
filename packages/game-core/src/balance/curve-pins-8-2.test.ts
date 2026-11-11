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
 * Ticket 8.2: the Hollow Deep changes nothing at or below level 46. These hashes were computed on
 * `main` before 8.2 (commit 5f6e017) and pin, for every class: an hour in the Pale Marches at 40,
 * 43 and 46 with the Marches' own drops (and the Cinder Depths at 40); a Forge Tyrant run at 46
 * (with and without a weekly modifier) and a Heroic crypt run; the Marches' item rolls at every
 * item level they drop (41–47; tier 5 at 47 too, so a Deep drop at 47 is the same item); the
 * Marches merchant's stock; and the XP curve to 46. 8.1's ≤ 40 pins and every earlier pin
 * (`curve-pins-8-1.test.ts`, `curve-pins-6-2.test.ts`, the no-effects hashes) stay as they are.
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

const marchesKit = (classId: (typeof CLASS_IDS)[number]): EquippedItem[] => {
  const rng = createRng(`pin82:${classId}`);
  const table = getLootTable('paleMarches');
  return Array.from({ length: 10 }, () => ({
    ...generateItem({ seed: rng.int(0, 2 ** 31), itemLevel: 45, lootTable: table, classId })!,
    upgradeLevel: 5,
  }));
};

describe('curves at or below level 46 (ticket 8.2 pins)', () => {
  it('the Marches, the Tyrant, Heroic, their rolls, the merchant and the XP curve are as before 8.2', () => {
    const out: Record<string, string> = {};
    for (const classId of CLASS_IDS) {
      const kit = marchesKit(classId);
      out[`depths:${classId}`] = hash(
        settleFarming({
          character: { classId, level: 40, xp: 0 },
          equipment: kit,
          areaId: 'cinderDepths',
          seed: `pin82:${classId}:depths`,
          firstCycle: 0,
          durationMs: 3_600_000,
          inventoryCount: 0,
        }),
      );
      for (const level of [40, 43, 46]) {
        out[`marches:${classId}:${level}`] = hash(
          settleFarming({
            character: { classId, level, xp: 0 },
            equipment: kit,
            areaId: 'paleMarches',
            seed: `pin82:${classId}:${level}`,
            firstCycle: 0,
            durationMs: 3_600_000,
            inventoryCount: 0,
          }),
        );
      }
      for (const bossModifier of [null, 'warded', 'burning'] as const) {
        out[`tyrant:${classId}:${bossModifier}`] = hash(
          simulateDungeonRun({
            dungeonId: 'tyrantsForge',
            character: { classId, level: 46, xp: 0 },
            equipment: kit,
            seed: `pin82:${classId}`,
            bossLootEligible: true,
            inventoryCount: 0,
            bossModifier,
          }),
        );
      }
      out[`heroic:${classId}`] = hash(
        simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          tier: 4,
          character: { classId, level: 36, xp: 0 },
          equipment: kit,
          seed: `pin82:${classId}`,
          bossLootEligible: true,
          inventoryCount: 0,
        }),
      );
      out[`merchant:${classId}`] = hash(
        merchantStock(
          {
            characterId: `pin82-${classId}`,
            classId,
            day: '2026-11-11',
            areaIds: ['cinderDepths', 'paleMarches'],
          },
          DEFAULT_ECONOMY_CONFIG,
        ),
      );
    }
    const rng = createRng('pin82:rolls');
    const rolls = [];
    for (const tableId of ['paleMarches', 'forgeTyrant'])
      for (let il = 41; il <= 47; il++)
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
    out.xp = hash(Array.from({ length: 46 }, (_, i) => xpToNextLevel(i + 1)));
    expect(hash(out)).toBe('8a3b2dc3c352dbf0');
  });
});
