import type { ClassId } from '../classes.js';

/**
 * One basic auto-skill per class (GDD §6.3). It replaces every `everyNthAttack`
 * basic attack within an encounter (the counter resets per encounter), deals
 * `damageMultiplier` × the class's primary damage and may add crit chance.
 * Resource costs and loadouts come in a later phase.
 */
export interface AutoSkillDefinition {
  id: string;
  name: string;
  classId: ClassId;
  everyNthAttack: number;
  damageMultiplier: number;
  bonusCritChance: number;
}

export const AUTO_SKILLS: Readonly<Record<ClassId, AutoSkillDefinition>> = {
  warrior: {
    id: 'heavyStrike',
    name: 'Heavy Strike',
    classId: 'warrior',
    everyNthAttack: 4,
    damageMultiplier: 2.0,
    bonusCritChance: 0,
  },
  mage: {
    id: 'firebolt',
    name: 'Firebolt',
    classId: 'mage',
    everyNthAttack: 3,
    damageMultiplier: 1.8,
    bonusCritChance: 0,
  },
  hunter: {
    id: 'aimedShot',
    name: 'Aimed Shot',
    classId: 'hunter',
    everyNthAttack: 4,
    damageMultiplier: 1.6,
    bonusCritChance: 0.25,
  },
  warlock: {
    id: 'shadowBolt',
    name: 'Shadow Bolt',
    classId: 'warlock',
    everyNthAttack: 3,
    damageMultiplier: 1.7,
    bonusCritChance: 0,
  },
};
