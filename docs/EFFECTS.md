# Unique effects: Legendaries, Mythics (ticket 3.2)

One data-driven effect system in `packages/game-core/src/effects/`. Legendary effects and Mythic signatures (3.2), set bonuses (3.3) and the rare Void modification of a Legendary (3.5) all go through it. Both combat simulations read the same combined numbers, so the detailed/aggregate equivalence and split-invariance hold with effects.

## Registry
- **Components** (`effects/types.ts`) are the mechanics combat understands: `critBurn`, `execute`, `bossSlayer`, `lifeOnKill`, `bloodrush`, `thorns`, `fortitude`, and four class-skill mechanics: `skillRage`, `skillSurge`, `skillOpener` and `skillRot`.
- **Definitions** (`effects/registry.ts`, `EFFECTS`) are data. Each has an id, name, `kind` (`legendary` | `mythic` | `set`), its components with parameters that are fixed or a `{min, max}` range, and tooltip text with `{component.param}` placeholders. Legendary entries also list `slots`, a `weight` and, for class effects, a `classId`.
- **Instances** (`EffectInstance`): `{ effectId, roll, strength? }`. An item gives one instance (`effect_id`, `effect_roll`). A set bonus (3.3) is an instance with a fixed roll, passed as `equipmentModifiers(…, { extraEffects })`. Void (3.5) passes `strength` > 1, which scales magnitudes but not thresholds, stack counts or decay.
- **API:** `resolveEffectComponents(instance)`, `combineEffects(instances, classId, caps)` → `CombatEffects`, `describeEffect(instance)` (tooltip text with the rolled values), `legendaryEffectPool(base, classId)`, `itemEffectInstances(item)`. `equipmentModifiers(items, caps, loot, { classId, extraEffects })` returns `effects` next to the secondary modifiers.
- **Combining:** magnitudes add up to `DEFAULT_EFFECT_CAPS`; execute takes the highest threshold, fortitude the lowest (floor 70 %), bloodrush the most stacks and the slowest decay. Class effects only count for their class. Unknown ids are ignored.

## Legendary pool (one per Legendary, at roll 0 → 1)
| Effect | Slots | Does |
|---|---|---|
| Emberbrand | weapon, hands, ring | crits add 40–80 % of the hit as fire that ignores armor/resistance |
| Headsman’s Due | weapon, offhand, neck | +40–80 % damage to enemies below 30 % health |
| Tyrant’s Bane | weapon, ring, neck | +10–20 % damage to bosses (adds to the boss-damage affix) |
| Carrion Feast | chest, neck, ring | a kill heals 6–12 % max health |
| Bloodrush | hands, feet, ring | each kill +2–3 % attack speed, up to 5 stacks; death or timeout ends the streak; a stack fades per 10 s out of combat |
| Bramblemail | head, chest, offhand | an enemy that hits you takes 15–35 % of its pre-mitigation damage |
| Unbroken | head, chest, feet | +10–20 % damage while at or above 80 % health |
| Rage-Fuelled Strikes (warrior) | weapon, offhand, hands, neck | Heavy Strike +6–10 % per 10 % missing health |
| Mana Surge (mage) | same | a crit turns the next attack into a Firebolt at 100–130 % power |
| Ambush (hunter) | same | every fight opens with an Aimed Shot, +10–25 % damage |
| Soul Rot (warlock) | same | Shadow Bolt adds 1.5–3 % of the enemy’s remaining health (at most the bolt’s own damage) |

Generation: a Legendary (rolled or requested) draws its effect **after** its affixes, so everything else about the item rolls as before. The draw is weighted from the pool for its slot and class; class effects only roll for that class, on bases it can use. The roll uses a 0.05 grid (`effect_roll`). Legendaries from before 3.2 have no effect and stay valid.

## Mythics (`items/mythics.ts`)
Six named items, each on its own `unique` tier-3 base with stronger implicit stats, the Mythic rarity’s five affixes and a fixed signature (no roll). They drop only where a loot table sets `mythics: true`: the **Sunken Abbey** and the **Gravewarden’s hoard**. There, a Mythic rarity roll picks among the Mythics the character’s class can use. Anywhere else a Mythic roll becomes a Legendary. Rate in the Abbey: about 0.05 % of item drops (≈ one per 50 h of Abbey farming); from the Gravewarden, 0.23 % per item, 2 items per kill.

| Mythic | Slot / class | Signature | Placeholder icon (A.6 draws the real one) |
|---|---|---|---|
| Crown of the Hollow King | head, all | Hollow Majesty: fortitude +20 % (≥ 80 %) and thorns 35 % | `item.horned-helm` |
| Gravecaller’s Edge | weapon, warrior | Gravecaller’s Hunger: Heavy Strike +12 %/10 % missing; kills heal 8 % | `item.bastard-sword` |
| Starfall Sceptre | weapon, mage | Starfall: crit → Firebolt at 150 %; +40 % below 30 % health | `item.bog-oak-staff` |
| Widowmaker | weapon, hunter | Widow’s Kiss: crit burn 50 %; +30 % below 30 % health | `item.crowwood-longbow` |
| Heart of the Abyss | weapon, warlock | Abyssal Rot: rot 3.5 %; +10 % to bosses | `item.skull-staff` |
| Ring of Endless Hunger | ring, all | Endless Hunger: bloodrush 3 % × 6; kills heal 6 % | `item.iron-ring` |

## Combat rules
- **One pricing function.** `attackHit(setup, attack, prevCrit, heroHealth, enemyHealth)` prices every hero attack in both simulations. Without effects the setup carries no `effects` field and it returns the old `auto`/`skill` profiles unchanged.
- **Aggregate stays exact.** `killDistribution(setup, health)` is the dynamic program over damage dealt, extended with a previous-crit flag (Mana Surge) and with deterministic thorns damage at each enemy hit (a thorns kill is an event at that hit). The hero's health at each attack is known in closed form, because enemy hits are fixed until the hero dies. The distribution cache key adds the start health only when a health-dependent effect (fortitude, rage) is active.
- **Thorns** apply after the enemy's hit lands. If that hit kills the hero, the fight is a death.
- **Life on kill** and **bloodrush** live in the shared cycle loop (`runFarming`) and in the crypt run. Bloodrush stacks are state carried across cycles like health: `FarmingCharacter.momentum` in, `momentum` out. The server stores it (`activities.momentum`, `farm_state.momentum`), so settling more or less often gives the same result (tested). In the crypt a streak starts at 0; the 20 s walk between rooms fades two stacks.
- **No effect equipped:** every number is identical to before. `effects/noEffects.test.ts` pins hashes, computed on `main` before 3.2, of 12 one-hour settlements with epic kits, 12 detailed simulations and 4 crypt runs.

## Balance (asserted in `balance.test.ts`)
Each effect is tested at its strongest roll on a common kit, at the middle of Crowwood, Blackwater and the Sunken Abbey: deaths ≤ 2/h, damage share < 21 %, and kills × 0.99–1.2 of the same kit without it. A Mythic worn in its slot over a rare kit (Abbey 19 and 22) stays inside the bands at × 1–1.3 kills. For every class, the best effect for farming speed, safety and the boss is not the same effect. With any effect, a naked level-16 hero never beats the Gravewarden; a geared level-15 hero always does, and the boss still takes > 60 % of the pre-enrage window. Equivalence: per-fight (12,000 trials, every effect on every class it applies to, two fights) and per 15-minute window (150 seeds, six effect pairs).

**Crypt entry (the 3.1 cliff, not retuned).** Win rate of a level-12 hero in item-level-11 commons with one effect at its best roll (16 seeds), and the effect's kill-rate factor in Blackwater at 15:

| Effect | Warrior | Mage | Hunter | Warlock |
|---|---|---|---|---|
| none | 0 % | 0 % | 0 % | 0 % |
| Emberbrand | 6 % · ×1.01 | 6 % · ×1.02 | 94 % · ×1.05 | 0 % · ×1.02 |
| Headsman’s Due | 31 % · ×1.01 | 0 % · ×1.04 | 100 % · ×1.03 | 0 % · ×1.05 |
| Tyrant’s Bane | 100 % · ×1.00 | 13 % · ×1.00 | 100 % · ×1.00 | 19 % · ×1.00 |
| Carrion Feast | 0 % · ×1.00 | 0 % · ×1.00 | 0 % · ×1.00 | 0 % · ×1.00 |
| Bloodrush | 0 % · ×1.10 | 0 % · ×1.10 | 0 % · ×1.10 | 0 % · ×1.10 |
| Bramblemail | 0 % · ×1.11 | 0 % · ×1.08 | 6 % · ×1.07 | 0 % · ×1.08 |
| Unbroken | 0 % · ×1.11 | 0 % · ×1.13 | 0 % · ×1.11 | 0 % · ×1.12 |
| class effect | 13 % · ×1.04 | 0 % · ×1.01 | 0 % · ×1.14 | 100 % · ×1.00 |
| Hollow Majesty | 25 % · ×1.13 | 0 % · ×1.23 | 81 % · ×1.16 | 0 % · ×1.22 |
| class Mythic | 75 % · ×1.04 | 13 % · ×1.03 | 100 % · ×1.06 | 100 % · ×1.00 |
| Endless Hunger | 0 % · ×1.12 | 0 % · ×1.12 | 0 % · ×1.11 | 0 % · ×1.12 |

Boss-focused effects (Tyrant's Bane, Soul Rot, Abyssal Rot) turn the level-12 entry from a certain loss into a certain win for some classes. So does Headsman's Due for the hunter, who already sits closest to the cliff. That is the play pattern they exist for, a crypt gear swap. But it confirms that the entry is a cliff: any boss bonus moves it. Farming-focused effects (Bloodrush, Unbroken, Bramblemail, Carrion Feast) don't move it.

**Known limits.** Mana Surge, Emberbrand and Starfall scale with crit chance. On a common kit (≈ 5 % crit) they barely register; they are crit-build effects. Carrion Feast does nothing for a geared hero, who regenerates fully between fights anyway; it pays off with lagging gear and in the crypt. Ambush is the strongest Legendary for farming (+14–18 % kills): the hunter's short fights make the opener count.
