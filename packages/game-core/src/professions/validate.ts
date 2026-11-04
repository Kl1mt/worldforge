import { AREAS } from '../world/areas.js';
import { getEnemy } from '../world/enemies.js';
import { getMaterial } from '../world/materials.js';
import type { ProfessionConfig } from './config.js';

/**
 * Checks the gathering data against the content contract: every yield is a gathering material the
 * area lists, every undead drop is an `undeadDrop` material the area lists, every material an area
 * lists is obtainable there, and every chance is in (0, 1]. Returns the problems found.
 */
export function validateProfessionConfig(config: ProfessionConfig): string[] {
  const problems: string[] = [];
  for (const area of AREAS) {
    const g = config.areas[area.id] ?? { yields: [], undeadDrops: [] };
    const covered = new Set<string>();
    for (const y of g.yields) {
      const m = getMaterial(y.materialId);
      if (m.source !== 'gathering') problems.push(`${area.id}: ${m.id} is not gatherable`);
      if (!area.materials.includes(m.id))
        problems.push(`${area.id}: ${m.id} not listed by the area`);
      if (!(y.chance > 0 && y.chance <= 1)) problems.push(`${area.id}: ${m.id} chance ${y.chance}`);
      covered.add(m.id);
    }
    for (const d of g.undeadDrops) {
      const m = getMaterial(d.materialId);
      if (m.source !== 'undeadDrop') problems.push(`${area.id}: ${m.id} is not an undead drop`);
      if (!area.materials.includes(m.id))
        problems.push(`${area.id}: ${m.id} not listed by the area`);
      if (!(d.chance > 0 && d.chance <= 1)) problems.push(`${area.id}: ${m.id} chance ${d.chance}`);
      if (!area.enemies.some((e) => getEnemy(e.enemyId).undead)) {
        problems.push(`${area.id}: undead drop but no undead enemies`);
      }
      covered.add(m.id);
    }
    for (const id of area.materials) {
      if (!covered.has(id)) problems.push(`${area.id}: lists ${id} but yields none`);
    }
  }
  if (!Number.isInteger(config.maxLevel) || config.maxLevel < 2) problems.push('maxLevel');
  return problems;
}
