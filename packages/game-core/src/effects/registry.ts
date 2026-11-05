import type { EffectCaps, EffectDefinition } from './types.js';

/** Slot kinds of the class effects (same as the class-flavoured affixes, ticket 3.1). */
const CLASS_EFFECT_SLOTS = ['weapon', 'offhand', 'hands', 'neck'] as const;

/**
 * The effect registry (ticket 3.2). Text placeholders are `{component.param}`, e.g. `{0.bonus}`;
 * see `describeEffect`. Tuning a range changes stored Legendaries too (they keep their roll, the
 * position in the range), so no data migration is needed.
 */
export const EFFECTS: readonly EffectDefinition[] = [
  // — Legendary pool: one effect per Legendary, filtered by slot and class.
  {
    id: 'emberbrand',
    name: 'Emberbrand',
    kind: 'legendary',
    slots: ['weapon', 'hands', 'ring'],
    weight: 10,
    components: [{ type: 'critBurn', bonus: { min: 0.4, max: 0.8 } }],
    text: 'Critical hits sear for {0.bonus} of the hit as fire that ignores armor and resistance.',
  },
  {
    id: 'headsmans-due',
    name: 'Headsman’s Due',
    kind: 'legendary',
    slots: ['weapon', 'offhand', 'neck'],
    weight: 10,
    components: [{ type: 'execute', threshold: 0.3, bonus: { min: 0.4, max: 0.8 } }],
    text: 'Deal {0.bonus} more damage to enemies below {0.threshold} health.',
  },
  {
    id: 'tyrants-bane',
    name: 'Tyrant’s Bane',
    kind: 'legendary',
    slots: ['weapon', 'ring', 'neck'],
    weight: 10,
    components: [{ type: 'bossSlayer', bonus: { min: 0.1, max: 0.2 } }],
    text: 'Deal {0.bonus} more damage to bosses.',
  },
  {
    id: 'carrion-feast',
    name: 'Carrion Feast',
    kind: 'legendary',
    slots: ['chest', 'neck', 'ring'],
    weight: 10,
    components: [{ type: 'lifeOnKill', heal: { min: 0.06, max: 0.12 } }],
    text: 'Every kill restores {0.heal} of your health.',
  },
  {
    id: 'bloodrush',
    name: 'Bloodrush',
    kind: 'legendary',
    slots: ['hands', 'feet', 'ring'],
    weight: 10,
    components: [
      { type: 'bloodrush', perStack: { min: 0.02, max: 0.03 }, maxStacks: 5, decayMs: 10_000 },
    ],
    text: 'Each kill grants {0.perStack} attack speed, up to {0.maxStacks} times. Dying or failing a fight ends the streak; a stack fades every {0.decayMs} out of combat.',
  },
  {
    id: 'bramblemail',
    name: 'Bramblemail',
    kind: 'legendary',
    slots: ['head', 'chest', 'offhand'],
    weight: 10,
    components: [{ type: 'thorns', reflect: { min: 0.15, max: 0.35 } }],
    text: 'Enemies that strike you take {0.reflect} of the blow’s full force.',
  },
  {
    id: 'unbroken',
    name: 'Unbroken',
    kind: 'legendary',
    slots: ['head', 'chest', 'feet'],
    weight: 10,
    components: [{ type: 'fortitude', threshold: 0.8, bonus: { min: 0.1, max: 0.2 } }],
    text: 'Deal {0.bonus} more damage while above {0.threshold} health.',
  },
  // Class effects: only for their class, on bases that class can use.
  {
    id: 'rage-fuelled-strikes',
    name: 'Rage-Fuelled Strikes',
    kind: 'legendary',
    classId: 'warrior',
    slots: CLASS_EFFECT_SLOTS,
    weight: 10,
    components: [{ type: 'skillRage', perDecile: { min: 0.06, max: 0.1 } }],
    text: 'Heavy Strike deals {0.perDecile} more damage for every 10 % of health you are missing.',
  },
  {
    id: 'mana-surge',
    name: 'Mana Surge',
    kind: 'legendary',
    classId: 'mage',
    slots: CLASS_EFFECT_SLOTS,
    weight: 10,
    components: [{ type: 'skillSurge', power: { min: 1, max: 1.3 } }],
    text: 'A critical hit turns your next attack into a Firebolt at {0.power} power.',
  },
  {
    id: 'ambush',
    name: 'Ambush',
    kind: 'legendary',
    classId: 'hunter',
    slots: CLASS_EFFECT_SLOTS,
    weight: 10,
    components: [{ type: 'skillOpener', bonus: { min: 0.1, max: 0.25 } }],
    text: 'Every fight opens with an Aimed Shot that deals {0.bonus} more damage.',
  },
  {
    id: 'soul-rot',
    name: 'Soul Rot',
    kind: 'legendary',
    classId: 'warlock',
    slots: CLASS_EFFECT_SLOTS,
    weight: 10,
    components: [{ type: 'skillRot', fraction: { min: 0.015, max: 0.03 } }],
    text: 'Shadow Bolt also rots away {0.fraction} of the enemy’s remaining health (at most the bolt’s own damage).',
  },

  // — Mythic signatures (fixed; see `MYTHIC_ITEMS`).
  {
    id: 'hollow-majesty',
    name: 'Hollow Majesty',
    kind: 'mythic',
    components: [
      { type: 'fortitude', threshold: 0.8, bonus: 0.2 },
      { type: 'thorns', reflect: 0.35 },
    ],
    text: 'Deal {0.bonus} more damage while above {0.threshold} health. Enemies that strike you take {1.reflect} of the blow’s full force.',
  },
  {
    id: 'gravecallers-hunger',
    name: 'Gravecaller’s Hunger',
    kind: 'mythic',
    classId: 'warrior',
    components: [
      { type: 'skillRage', perDecile: 0.12 },
      { type: 'lifeOnKill', heal: 0.08 },
    ],
    text: 'Heavy Strike deals {0.perDecile} more damage for every 10 % of health you are missing. Every kill restores {1.heal} of your health.',
  },
  {
    id: 'starfall',
    name: 'Starfall',
    kind: 'mythic',
    classId: 'mage',
    components: [
      { type: 'skillSurge', power: 1.5 },
      { type: 'execute', threshold: 0.3, bonus: 0.4 },
    ],
    text: 'A critical hit turns your next attack into a Firebolt at {0.power} power. Deal {1.bonus} more damage to enemies below {1.threshold} health.',
  },
  {
    id: 'widows-kiss',
    name: 'Widow’s Kiss',
    kind: 'mythic',
    classId: 'hunter',
    components: [
      { type: 'critBurn', bonus: 0.5 },
      { type: 'execute', threshold: 0.3, bonus: 0.3 },
    ],
    text: 'Critical hits sear for {0.bonus} of the hit as fire that ignores armor. Deal {1.bonus} more damage to enemies below {1.threshold} health.',
  },
  {
    id: 'abyssal-rot',
    name: 'Abyssal Rot',
    kind: 'mythic',
    classId: 'warlock',
    components: [
      { type: 'skillRot', fraction: 0.035 },
      { type: 'bossSlayer', bonus: 0.1 },
    ],
    text: 'Shadow Bolt also rots away {0.fraction} of the enemy’s remaining health (at most the bolt’s own damage). Deal {1.bonus} more damage to bosses.',
  },
  {
    id: 'endless-hunger',
    name: 'Endless Hunger',
    kind: 'mythic',
    components: [
      { type: 'bloodrush', perStack: 0.03, maxStacks: 6, decayMs: 10_000 },
      { type: 'lifeOnKill', heal: 0.06 },
    ],
    text: 'Each kill grants {0.perStack} attack speed, up to {0.maxStacks} times, and restores {1.heal} of your health. Dying or failing a fight ends the streak; a stack fades every {0.decayMs} out of combat.',
  },
];

/**
 * Caps on the combined effects. Two sources of one mechanic add up, but never past these; the
 * balance test checks every effect at its cap.
 */
export const DEFAULT_EFFECT_CAPS: Readonly<EffectCaps> = {
  critBurn: 1.5,
  execute: { threshold: 0.35, bonus: 1.2 },
  bossSlayer: 0.3,
  lifeOnKill: 0.2,
  bloodrush: { perStack: 0.06, maxStacks: 8 },
  thorns: 0.8,
  fortitude: { minThreshold: 0.7, bonus: 0.45 },
  skillRage: 0.15,
  skillSurge: 2,
  skillOpener: 0.7,
  skillRot: 0.05,
};

const EFFECTS_BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));

export function findEffect(id: string): EffectDefinition | undefined {
  return EFFECTS_BY_ID.get(id);
}

export function getEffect(id: string): EffectDefinition {
  const effect = EFFECTS_BY_ID.get(id);
  if (!effect) throw new Error(`Unknown effect: ${id}`);
  return effect;
}

export function isEffectId(value: unknown): value is string {
  return typeof value === 'string' && EFFECTS_BY_ID.has(value);
}
