// Ticket B.3: end state of a `telemetry:simulate` run (gold left, kits at +10, warehouse use, area).
//   pnpm --filter @worldforge/server exec tsx --conditions=source ../../tools/balance/sim-state.ts ../../.telemetry-sample
import { join, resolve } from 'node:path';
import { createPgliteDatabase } from '../../apps/server/src/test/db.ts';
import { characterMaterials, characters, itemInstances } from '../../apps/server/src/db/schema.ts';

const dir = resolve(process.argv[2] ?? '.telemetry-sample');
const database = await createPgliteDatabase(join(dir, 'db'));
const heroes = await database.db.select().from(characters);
const items = await database.db.select().from(itemInstances);
const mats = await database.db.select().from(characterMaterials);
const rows = heroes
  .map((h) => {
    const worn = items.filter((i) => i.characterId === h.id && i.equippedSlot);
    const stored = items.filter((i) => i.characterId === h.id && i.inWarehouse).length;
    const ups = worn.map((i) => i.upgradeLevel);
    return {
      cls: h.classId,
      level: h.level,
      gold: h.gold,
      at10: ups.filter((u) => u >= 10).length,
      slots: worn.length,
      minUp: Math.min(...ups),
      wh: h.warehouseLevel,
      stored,
      tiers: [...new Set(worn.map((i) => i.baseId))].length,
      shards:
        mats.find((m) => m.characterId === h.id && m.materialId === 'soulShard')?.quantity ?? 0,
      ore: mats.find((m) => m.characterId === h.id && m.materialId === 'ironOre')?.quantity ?? 0,
      hide: mats.find((m) => m.characterId === h.id && m.materialId === 'rawHide')?.quantity ?? 0,
    };
  })
  .sort((a, b) => a.level - b.level);
for (const r of rows) {
  console.log(
    `${r.cls.padEnd(8)} L${String(r.level).padStart(2)} gold ${String(r.gold).padStart(8)}  +10 ${r.at10}/${r.slots} (min +${r.minUp})  warehouse L${r.wh} stored ${r.stored}  shards ${r.shards} ore ${r.ore} hide ${r.hide}`,
  );
}
const golds = rows.map((r) => r.gold).sort((a, b) => a - b);
console.log(
  `median gold ${golds[Math.floor(golds.length / 2)]}; whole kit +10: ${rows.filter((r) => r.at10 === r.slots && r.slots > 0).length}/${rows.length}`,
);
await database.close();
