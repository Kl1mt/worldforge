import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  createRng,
  generateItem,
  getLootTable,
  settleFarming,
  simulateDungeonRun,
  xpToNextLevel,
  type EquippedItem,
} from '../index.js';

/**
 * Ticket 6.2: the Cinder Depths and the Forge Tyrant change nothing at or below level 34. These
 * hashes were computed on `main` before 6.2 (commit c1282d2) and pin, for every class: an hour in
 * the Ashfall Verge at 28, 31 and 34 with the Verge's own drops; a Warden's Watch run; the Verge's
 * item rolls at every item level it drops; and the XP curve to 34. 6.1's ≤ 28 pins (the no-effects
 * hashes, `progression.test.ts`, `loot.test.ts`) stay as they are.
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

const vergeKit = (classId: (typeof CLASS_IDS)[number]): EquippedItem[] => {
  const rng = createRng(`pin62:${classId}`);
  const table = getLootTable('ashfallVerge');
  return Array.from({ length: 10 }, () => ({
    ...generateItem({ seed: rng.int(0, 2 ** 31), itemLevel: 33, lootTable: table, classId })!,
    upgradeLevel: 5,
  }));
};

describe('curves at or below level 34 (ticket 6.2 pins)', () => {
  it('the Verge, the Watch, the Verge’s rolls and the XP curve are as before 6.2', () => {
    const out: Record<string, string> = {};
    for (const classId of CLASS_IDS) {
      const kit = vergeKit(classId);
      for (const level of [28, 31, 34]) {
        out[`verge:${classId}:${level}`] = hash(
          settleFarming({
            character: { classId, level, xp: 0 },
            equipment: kit,
            areaId: 'ashfallVerge',
            seed: `pin62:${classId}:${level}`,
            firstCycle: 0,
            durationMs: 3_600_000,
            inventoryCount: 0,
          }),
        );
      }
      out[`watch:${classId}`] = hash(
        simulateDungeonRun({
          dungeonId: 'ashenWatch',
          character: { classId, level: 28, xp: 0 },
          equipment: kit,
          seed: `pin62:${classId}`,
          bossLootEligible: true,
          inventoryCount: 0,
        }),
      );
    }
    const rng = createRng('pin62:rolls');
    const rolls = [];
    for (let il = 29; il <= 35; il++)
      for (let i = 0; i < 20; i++)
        rolls.push(
          generateItem({
            seed: rng.int(0, 2 ** 31),
            itemLevel: il,
            lootTable: getLootTable('ashfallVerge'),
            classId: CLASS_IDS[i % 4]!,
          }),
        );
    out.rolls = hash(rolls);
    out.xp = hash(Array.from({ length: 34 }, (_, i) => xpToNextLevel(i + 1)));
    expect(hash(out)).toBe('1ce50d909503e0af');
  });
});
