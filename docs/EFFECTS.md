# Unique effects: Legendaries, Mythics (ticket 3.2), set bonuses (ticket 3.3), Void (ticket 3.5), Prismatic (ticket 6.4)

One data-driven effect system in `packages/game-core/src/effects/`. Legendary effects and Mythic signatures (3.2), set bonuses (3.3) and the rare Void modification of a Legendary (3.5) all go through it. Both combat simulations read the same combined numbers, so the detailed/aggregate equivalence and split-invariance hold with effects.

## Registry
- **Components** (`effects/types.ts`) are the mechanics combat understands: `critBurn`, `execute`, `bossSlayer`, `lifeOnKill`, `bloodrush`, `thorns`, `fortitude`, and four class-skill mechanics: `skillRage`, `skillSurge`, `skillOpener` and `skillRot`.
- **Definitions** (`effects/registry.ts`, `EFFECTS`) are data. Each has an id, name, `kind` (`legendary` | `mythic` | `set`), its components with parameters that are fixed or a `{min, max}` range, and tooltip text with `{component.param}` placeholders. Legendary entries also list `slots`, a `weight` and, for class effects, a `classId`.
- **Instances** (`EffectInstance`): `{ effectId, roll, strength? }`. An item gives one instance (`effect_id`, `effect_roll`). A set bonus (3.3) is an instance with a fixed roll, passed as `equipmentModifiers(…, { extraEffects })`. Void (3.5) passes `strength` > 1, which scales magnitudes but not thresholds, stack counts or decay.
- **API:** `resolveEffectComponents(instance)`, `combineEffects(instances, classId, caps)` → `CombatEffects`, `describeEffect(instance)` (tooltip text with the rolled values), `legendaryEffectPool(base, classId)`, `itemEffectInstances(item)`. `equipmentModifiers(items, caps, loot, { classId, extraEffects })` returns `effects` next to the secondary modifiers.
- **Combining:** each effect id counts **once** (ticket B.2, `distinctEffects`): of several instances of one effect (two Legendaries with Unbroken, a plain and a Void copy) only the strongest counts (the larger magnitudes after roll and Void strength; on a tie the first). Different effects still add up, also with the same mechanic (Tyrant's Bane next to Abyssal Rot's or Last Rite's boss bonus). Then magnitudes add up to `DEFAULT_EFFECT_CAPS`; execute takes the highest threshold, fortitude the lowest (floor 70 %), bloodrush the most stacks and the slowest decay. Class effects only count for their class. Unknown ids are ignored.

## Legendary pool (one per Legendary, at roll 0 → 1)
| Effect | Slots | Does |
|---|---|---|
| Emberbrand | weapon, hands, ring | crits add 40–80 % of the hit as fire that ignores armor/resistance |
| Headsman’s Due | weapon, offhand, neck, ring (ring since B.2) | +40–80 % damage to enemies below 30 % health |
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
Six named items, each on its own `unique` tier-3 base with stronger implicit stats, the Mythic rarity’s five affixes and a fixed signature (no roll). They drop only where a loot table sets `mythics: true`: the **Sunken Abbey** and the **Gravewarden’s hoard** (ticket 4.8: also the **Ashen Pass** and the **Ashen Warden’s hoard**, with the Abbey's odds). There, a Mythic rarity roll picks among the Mythics the character’s class can use. Anywhere else a Mythic roll becomes a Legendary. Rate in the Abbey: about 0.05 % of item drops (≈ one per 50 h of Abbey farming); from the Gravewarden, 0.23 % per item, 2 items per kill.

| Mythic | Slot / class | Signature | Placeholder icon (A.6 draws the real one) |
|---|---|---|---|
| Crown of the Hollow King | head, all | Hollow Majesty: fortitude +20 % (≥ 80 %) and thorns 35 % | `item.horned-helm` |
| Gravecaller’s Edge | weapon, warrior | Gravecaller’s Hunger: Heavy Strike +12 %/10 % missing; kills heal 8 % | `item.bastard-sword` |
| Starfall Sceptre | weapon, mage | Starfall: crit → Firebolt at 150 %; +40 % below 30 % health | `item.bog-oak-staff` |
| Widowmaker | weapon, hunter | Widow’s Kiss: crit burn 50 %; +30 % below 30 % health | `item.crowwood-longbow` |
| Heart of the Abyss | weapon, warlock | Abyssal Rot: rot 3.5 %; +10 % to bosses | `item.skull-staff` |
| Ring of Endless Hunger | ring, all | Endless Hunger: bloodrush 3 % × 6; kills heal 6 % | `item.iron-ring` |

## Sets (`items/sets.ts`, ticket 3.3)
Three sets of named pieces, each on its own `unique` base (stats like the tier-3 base of its slot, tilted to the set's theme), all wearable by every class, on the slots that have art. A piece is a **Legendary-rarity** item (four Legendary affixes) with `setId` and **no effect of its own**: its power is the set bonus. Bonuses are `kind: 'set'` registry entries with fixed values, active at 2, 4 and 6 **distinct** pieces worn.

| Set | Pieces (slot · placeholder icon; A.6 draws the real ones) | Bonuses |
|---|---|---|
| **The Drowned Vigil** (martial) | Helm (head · `item.barbute`), Hauberk (chest · `item.chainmail`), Gauntlets (hands · `item.plated-gauntlets`), Sabatons (feet · `item.plate-sabatons`), Oath-Chain (neck · `item.abbey-pendant`), Seal (ring · `item.abbey-signet`) | (2) Tidebound: thorns 25 % · (4) Hold the Line: +30 % damage at or above 70 % health · (6) Undertow: +80 % below 35 % enemy health, kills heal 8 % (B.2; were 25 % and 60 %) |
| **The Ashen Choir** (arcane) | Cowl (head · `item.iron-helm`), Vestments (chest · `item.leather-jerkin`), Wraps (hands · `item.leather-gloves`), Slippers (feet · `item.leather-boots`), Censer-Chain (neck · `item.raven-talisman`), Band (ring · `item.brass-ring`) | (2) Kindled: crit burn 30 % · (4) Hymn of Cinders: a crit turns the next attack into the class skill at 90 % · (6) Last Rite: +10 % to bosses, the class skill rots 1 % of remaining health (B.2; were 15 % and 2 %) |
| **The Bloodmoon Hunt** (hybrid) | Grips (hands · `item.ringmail-gloves`), Treads (feet · `item.iron-shod-boots`), Fang (neck · `item.bone-amulet`), Loop (ring · `item.grave-gold-ring`) | (2) Scent of Blood: bloodrush 2 % × 5 · (4) The Long Hunt: every fight opens with the class skill +10 %, kills heal 5 % |

Every piece is named "<Piece> of <Set>", e.g. "Helm of the Drowned Vigil". The sets share slots on purpose: a full Vigil or Choir leaves the second ring, weapon and off-hand for Legendaries and Mythics; 4 + 2 mixes trade a bonus for two Legendary effects.

- **Counting** (`wornSets`, `setBonusInstances`): an equipped item counts when its `setId` names a set **and** its base is one of that set's pieces; each piece once (two copies of one ring are one piece). The variant is never read, so a Void piece (3.5) is the same piece (tested with a synthetic Void item). Settlement and the crypt run pass the active bonuses as `equipmentModifiers(…, { extraEffects: setBonusInstances(equipment) })`; combining and caps are the registry's. One piece gives no bonus.
- **Drops:** in tables with `setShare` (Sunken Abbey, Nameless Crypt, Gravewarden's hoard; ticket 4.8: the Ashen Pass and the Ashen Warden's hoard too), a share of the Legendary rolls at item level 14+ becomes a random set piece (the extra draw happens only then, so nothing else changes). Ticket 3.3 used half, which halved plain Legendaries in the late game (Abbey ≈ 0.17/h → ≈ 0.085/h, below Blackwater's 0.215/h). **Ticket B.2:** these tables roll Legendary rarity × 1.5 (`legendaryWeight`, `LEGENDARY_WEIGHT`) and a third of those rolls (`SET_SHARE` = 1/3) become set pieces, so set pieces drop as before and plain Legendaries as before 3.3. Measured (geared level-20 hero, rare kit, 1,200 h): the Abbey drops ≈ 40.6 items/h, **≈ 0.10 set pieces/h (one per ~10 h; a given piece ≈ 160 h)** and ≈ 0.164 plain Legendaries/h (was 0.085). Rates per crypt run: `docs/DUNGEONS.md`. Elsewhere no set pieces drop.
- **No set pieces equipped:** every number is identical. `noEffects.test.ts` runs the pinned pre-3.2 hashes again with every kit item carrying a set id it is not a piece of; set pieces are Legendary drops, already outside the settlement hash.
- **Equivalence:** per fight with each full set on every class, and per 15-minute window with a full set next to an item effect (warrior Vigil, mage Choir, hunter Bloodmoon).

### Set balance (asserted in `balance.test.ts`)
- **Bands:** every set at 2, 4 and 6 pieces (generated pieces replacing a rare kit, Abbey 19 and 22): deaths ≤ 2/h, damage share < 21 %, each threshold ≥ 0.97 × the previous, kills < × 1.5 of the kit (the 4-piece Bloodmoon on a warrior is the highest, ≈ × 1.42–1.47).
- **Compete, not replace** (Abbey 19, rare kit; boss at 15 on a common kit). Legendary build = six Legendaries on the set slots at the **median** roll, each with the effect that farms fastest (a lucky, perfect build):

| Class | Vigil 6 kills · boss | Choir 6 | Bloodmoon 4 | Legendary 6 | Bloodmoon 4 + Legendary 2 | Vigil 4 + Legendary 2 |
|---|---|---|---|---|---|---|
| Warrior | × 1.26 · 29 s | × 1.15 · 32 s | × 1.42 · 37 s | × 1.56 · **19 s** | **× 1.82** · 25 s | × 1.35 · 27 s |
| Mage | × 1.19 · **25 s** | × 1.19 · 26 s | × 1.21 · 39 s | × 1.33 · 27 s | **× 1.46** · 27 s | × 1.24 · 26 s |
| Hunter | × 1.22 · 25 s | × 1.13 · 23 s | × 1.29 · 32 s | **× 1.95 · 16 s** | × 1.55 · 21 s | × 1.53 · 24 s |
| Warlock | × 1.21 · **24 s** | × 1.21 · 27 s | × 1.22 · 41 s | × 1.34 · 25 s | **× 1.42** · 28 s | × 1.25 · 25 s |

  Asserted: a Legendary build out-farms every pure set; the fastest farming build always carries Legendaries; the best build with a set is within × 0.75 of the fastest; set + Legendary mixes beat every pure set; the best set build's boss time is within × 1.35 of the Legendary build's (casters: a pure set is the fastest boss build). For every class the best set for farming speed, safety and the boss is not the same set (bonus only, Blackwater 15). With all of a set's bonuses a naked level-16 hero never beats the Gravewarden; a geared level-15 hero always does, and the boss still takes > 45 % of the pre-enrage window.

**Crypt entry (the cliff as it was before ticket 3.6, with the enrage fixed at 45 s).** Bonuses only (on effect rings, like the 3.2 table): win rate of a level-12 hero in item-level-11 commons (16 seeds), and the kill-rate factor in Blackwater at 15:

| Set (pieces) | Warrior | Mage | Hunter | Warlock |
|---|---|---|---|---|
| none | 0 % | 0 % | 0 % | 0 % |
| Drowned Vigil (2) | 0 % · ×1.09 | 0 % · ×1.03 | 6 % · ×1.05 | 0 % · ×1.06 |
| Drowned Vigil (4) | 100 % · ×1.13 | 0 % · ×1.22 | 100 % · ×1.16 | 0 % · ×1.22 |
| Drowned Vigil (6) | 100 % · ×1.14 | 100 % · ×1.22 | 100 % · ×1.17 | 100 % · ×1.22 |
| Ashen Choir (2) | 0 % · ×1.00 | 0 % · ×1.01 | 19 % · ×1.03 | 0 % · ×1.01 |
| Ashen Choir (4) | 6 % · ×1.01 | 0 % · ×1.01 | 88 % · ×1.04 | 0 % · ×1.02 |
| Ashen Choir (6) | 100 % · ×1.02 | 100 % · ×1.01 | 100 % · ×1.04 | 100 % · ×1.02 |
| Bloodmoon Hunt (2) | 0 % · ×1.07 | 0 % · ×1.07 | 0 % · ×1.07 | 0 % · ×1.07 |
| Bloodmoon Hunt (4) | 0 % · ×1.21 | 0 % · ×1.27 | 0 % · ×1.17 | 0 % · ×1.20 |

Sets move the cliff more than single effects: a full Vigil or Choir turns the level-12 entry into a certain win for every class, the 4-piece Vigil does so for warrior and hunter (fortitude at 70 % on top of thorns), and the hunter again sits closest (Choir 4: 88 %). The farming set (Bloodmoon) doesn't move it. In practice the pieces need item level 14 and drop only in late-game sources, so a hero holding four or six of them is past the entry anyway. Ticket 3.6 resolved the cliff (a per-run enrage window; `docs/DUNGEONS.md`, "Tiers and balance"): a full Vigil or Legendary kit still makes the level-12 entry certain, and since 3.6 the balance test checks every set against the boss thresholds as a share of the earliest enrage (2/3 of 30 s = the old 20 s).

**Known limits.** The Ashen Choir is a crit and boss set: on low-crit kits its 2- and 4-piece bonuses barely register while farming (with a crit kit it is a top boss set; `docs/COMBAT.md` "Build diversity"). Ticket B.2 took this up: stacked copies of one effect no longer count (the old perfect hunter build stacked Unbroken), and the late-game build search shows several builds per class within 7 % of the best at the tier III Gravewarden, sets among them. Two limits stay and are recorded in `balance.test.ts`: on the tier I boss with a common kit the hunter's six-Legendary build is still × 1.46 faster than its best set build (B.2's deep-boss search does not have it among the hunter's top builds), and on a bonus-only common kit at level 15 the warlock's Vigil leads farming, safety and the boss.

## Void variants (`items/variants.ts`, ticket 3.5)
GDD §7.5. A variant is layered on an item's rarity and identity; it is not a rarity tier. Void (3.5) and, since ticket 6.4, **Prismatic** (below); an item has at most one variant (no stacking; the `variant` column holds one value).

- **Where:** only on Legendary and Mythic items, set pieces included (they are Legendary-rarity). Data: `ITEM_VARIANTS` (`rarities`, `implicitBonus`, `effectStrength`). `activeVariant(item)` is the one rule every reader uses: a Void flag on any other rarity (never generated; `validateItem` rejects it) does nothing.
- **Bonus (small):** + **10 %** implicit (base) stats, added to the upgrade bonus (`getImplicitStats`: a +10 Void item has +60 % base values), and **× 1.1** on the magnitudes of the item's own effect (a Legendary effect or a Mythic signature), passed as `EffectInstance.strength` by `itemEffectInstances`. The registry's rule holds: strength never scales thresholds, stack counts or decay, and combined effects stay under `DEFAULT_EFFECT_CAPS`. Affixes are untouched. Without an active variant the instance carries no `strength` field, so every number is the pre-3.5 one.
- **Set pieces:** a Void piece counts as the same piece (`wornSets` never reads the variant; tested with generated Void pieces too). Set pieces have no effect of their own, so Void gives them the stat bonus only; the set bonus is the set's and does not change.
- **Drops:** the Void roll is the **last draw** of `generateItem`, made only for a Legendary or Mythic (set piece included) rolled from a table with `voidChance`, so everything else about every item rolls as before (tested item by item). Tables: the Sunken Abbey, the Nameless Crypt's chambers and the Gravewarden's hoard, `VOID_CHANCE` = **10 %**, clamped to `DEFAULT_LOOT_CONFIG.maxVoidChance` = **15 %** (the hard cap for any table, and for a discovery-progression hook if one is ever added). Requested bases (Forge crafts, quest rewards, the merchant) are never Void. No account-bound discovery hook was built (optional in the ticket); it would raise the chance within the cap.
- **Expected rates** (measured, `settleFarming` and `simulateDungeonRun` over many seeds; the same setup as the set rates above): a geared level-20 hero in the **Sunken Abbey** finds ≈ 0.29 Legendary/Mythic/set items an hour since B.2 (0.164 Legendary, 0.103 set pieces, 0.019 Mythics; was 0.20), so **≈ 0.032 Void items an hour — one per ~30 h** (was 0.019, one per ~50 h; Void Mythics stay ≈ 0.002/h, one per ~500 h). A **crypt run** at 15 with boss loot yields ≈ 0.0073 Void items (one per ~140 such runs; boss loot comes at most once per 20 h per character, so this is a slow trickle on top of farming); the chambers alone give ≈ 0.001 per run. Nowhere else drops Void.
- **Forge (3.4):** forge work never adds or removes a variant. Upgrades, rerolls and improvements patch their own columns only (tested: a Void and a plain Legendary each upgraded, rerolled and improved keep their variant). Void and upgrades stack additively on base values. Sell and salvage prices ignore the variant (like the upgrade level). `docs/ECONOMY.md`.
- **No Void items:** every number is identical. `noEffects.test.ts` runs the pinned pre-3.2 hashes again with an explicit `variant: null` on every kit item and with a stray `variant: 'void'` on the epic and rare kits; a second test shows the check can fail (the same Legendary kit as Void changes the settlement). Void drops are Legendary/Mythic drops, already outside the settlement hash.

### Void balance (asserted in `balance.test.ts`)
Abbey 19 and 22, every class, against the same kit without Void: deaths ≤ 2/h, damage share < 21 % and never higher, kills × 0.99–1.1, and even Void Legendaries at +10 stay under × 2 a rare kit. A Void Mythic in its slot stays in the Mythic band (× < 1.3 a rare kit). The Gravewarden (geared at 15) is never more than 10 % faster per fight with a full Void Legendary kit than without; a naked hero still never wins. Measured kill-rate factors of Void over the same kit:

| Kit | Warrior | Mage | Hunter | Warlock |
|---|---|---|---|---|
| Legendaries in every slot (19 · 22) | × 1.009 · 1.005 | × 1.034 · 1.019 | × 1.034 · 1.011 | × 1.066 · 1.040 |
| Drowned Vigil 6 + Legendaries | × 1.017 · 1.007 | × 1.027 · 1.041 | × 1.042 · 1.002 | × 1.021 · 1.024 |
| Legendaries at +10 | × 1.035 · 1.067 | × 1.046 · 1.005 | × 1.000 · 1.005 | × 1.008 · 1.005 |

Void is a chase for completionists, not a new power tier: a few percent, mostly safety (base armor and health) and slightly stronger effects.

## Prismatic variants (`items/variants.ts`, ticket 6.4)
GDD §7.5. The second variant, after Void and **never stacked with it** (owner decision): one variant per item, so a Void-Prismatic item cannot exist (the column holds one value, and the Prismatic roll is only made when the Void roll failed). Rarer than Void, on Legendary, Mythic and set items only (`rarities: legendary, mythic`; set pieces are Legendary-rarity), from Ashen-tier content on. A **different stat shape, not more power**: the best Prismatic build is a sidegrade to the best Void build.

- **Shape:** Void puts its bonus into the item's **base values** (+10 %) and its **effect** (× 1.1). Prismatic leaves both exactly as on the plain item (`implicitBonus` 0, `effectStrength` 1) and raises the item's **combat affixes** × **1.1** (`affixBonus`, `PRISMATIC_AFFIX_BONUS`) when stats are read (`itemStatContribution`, `itemSecondaryModifiers` via `variantAffixValue`; flat stats round to whole points per affix, fractions to 4 decimals). Combat affixes are `AFFIX_BONUS_STATS`: health, physical and magic damage, attack speed, critical damage, armor, resistance, boss damage and skill damage. **Critical chance is left out** (it multiplies with critical damage and the crit-scaling effects Mana Surge, Emberbrand and Starfall: with it, the best Prismatic crit builds beat the best Void builds at the Warden by up to 10 %). **Find affixes** (gold, item, XP, resource find) are never raised, so the economy is unchanged. Stored affix values never change: `validateItem`, the Forge's tier caps, Gear Score's magic quality and the loot filter read the rolled numbers.
- **The choice it creates:** a Prismatic item is as good as its affixes. A crit- or speed-light, base-heavy piece (a chest's armor and health, a weapon's damage) or one with a strong effect is better Void; a piece with three or four combat affixes the build wants is better Prismatic, and the Forge's rerolls and improvements on it count 10 % more. Which variant leads changes by class and job (table below).
- **Why not a seed-fixed "facet" (another stat or element per item)?** The ticket's example. Every stored snapshot (farm state, crypt runs, duels, the guild boss, board inputs) holds an item's base, rarity, affixes and variant but not its seed, so a facet would have needed a new column and a field in every snapshot; amplifying what the item already rolled needs neither and makes the item's own affixes the choice.
- **Drops** (`PRISMATIC_CHANCE`, `HEROIC_PRISMATIC_CHANCE`, `PRISMATIC_TABLE_IDS` in `loot/tables.ts`; `prismaticChance` on a table, clamped to `DEFAULT_LOOT_CONFIG.maxPrismaticChance` = **7.5 %**): one more draw after a failed Void roll, made only for a Legendary or Mythic (set piece included) rolled from a table with a Prismatic chance; everything else about every item, and every Void roll, rolls as before (tested item by item per source). **5 %** of the non-Void rolls (4.5 % of all such rolls, against Void's 10 %) in the Ashen Pass and the Ashen Warden's hoard, the Ashfall Verge, the Cinder Depths and the Forge Tyrant's hoard; **7.5 %** (6.4 %, against 15 %) in the Heroic crypt's chambers and hoard. Nowhere older (the Abbey, crypt tiers I–III, the earlier areas). Requested bases (Forge crafts, quest rewards, the merchant) are never Prismatic, like Void.
- **Expected rates** (`tools/balance/prismatic.ts rates`: a warrior in its top Pass build +10 at each source's item level; 3,000 farming hours per area, 20,000 runs per dungeon, boss loot eligible):

| Source | Legendary/Mythic/set | Void | Prismatic |
|---|---|---|---|
| Ashen Pass at 28 (per hour) | 0.50 | 0.043 (~1 per 23 h) | 0.023 (~1 per 43 h) |
| Ashfall Verge at 33 (per hour) | 0.43 | 0.051 (~1 per 20 h) | 0.015 (~1 per 67 h) |
| Cinder Depths at 39 (per hour) | 0.39 | 0.031 (~1 per 32 h) | 0.020 (~1 per 51 h) |
| Warden's Watch at 28 (per run) | 0.28 | 0.029 (~1 per 35) | 0.012 (~1 per 85) |
| Tyrant's Forge at 38 (per run) | 0.27 | 0.029 (~1 per 34) | 0.013 (~1 per 79) |
| Heroic crypt at 34 (per run) | 0.66 | 0.098 (~1 per 10) | 0.044 (~1 per 23) |
| Crypt tier III at 23 (per run) | 0.20 | 0.021 | 0 |

  Expected Prismatic ÷ Void is 0.45 everywhere (0.43 Heroic); the farming rows are a few dozen finds each, so they scatter around it. Boss hoards come at most once per 20 h per character.
- **Sets, effects, upgrades, the Forge:** a Prismatic set piece is the same piece (`wornSets` never reads the variant; the set bonus is unchanged). The item's Legendary effect or Mythic signature is unchanged (no `strength`). Upgrades raise base values as on any item (+50 % at +10) and never touch affixes, so a +10 Prismatic item has the upgrade's base values and affixes × 1.1. Forge work never adds, removes or swaps a variant; a reroll's new affix and an improvement's higher value are read × 1.1 like the others (tested in game-core and `forge/work.test.ts`). Sell and salvage prices ignore it, like Void.
- **No Prismatic items:** every number is identical. `noEffects.test.ts` runs the pinned pre-3.2 hashes with a stray `variant: 'prismatic'` on the epic and rare kits; a second test shows the check can fail (the same Legendary kit as Prismatic changes the settlement, and differently from Void). The balance suites, the curve pins and every earlier no-effects hash are unchanged.

### Prismatic balance (asserted in `balance/prismatic-balance.test.ts`)
The B.2 build search, run with every piece Void and with every piece Prismatic (each variant gets the effects and affix package that suit it), for farming the Ashen Pass at 26 (`PASS_FARM_JOB`) and the Ashen Warden at 28 (`WARDEN_JOB`), at +0 and +10: the best Prismatic build stays within **5 %** of the best Void build (asserted), and a full Prismatic kit over the same plain kit is × 0.99–1.1 kills with no more deaths. Measured, Prismatic ÷ Void (kills per minute; boss time, below 1 = Prismatic faster), with the Verge at 32 (item level 31) from the dev tool:

| Job | Warrior | Mage | Hunter | Warlock |
|---|---|---|---|---|
| Pass farming +0 · +10 | 1.006 · 1.006 | 1.009 · 1.007 | 1.003 · 0.997 | 0.997 · 0.998 |
| Verge farming +0 · +10 | 1.008 · 1.019 | 1.009 · 1.008 | 1.005 · 1.000 | 1.003 · 0.999 |
| Ashen Warden +0 · +10 (time) | 0.975 · 0.993 | 1.041 · 0.988 | 0.979 · 0.974 | 0.987 · 0.985 |

Tuning (the same searches): × 1.2 on every combat affix made the best Prismatic farm 3–5 % faster than the best Void; × 1.1 with critical chance still in made it 2–10 % faster at the Warden (warrior 0.900); × 1.1 without critical chance is the table above. Prismatic is a chase for a build that wants its item's affixes, not a new tier.

## Item Awakening (evaluated in ticket 6.5, built in 6.5b)
`docs/AWAKENING.md`. An awakened item's own effect (a Legendary effect or a Mythic signature) counts × 1.1, like Void's strength: magnitudes only, never thresholds, stack counts or decay, still under `DEFAULT_EFFECT_CAPS`, and an effect id still counts once. It multiplies with the variant (Void × 1.1 × 1.1 = × 1.21; Prismatic leaves the effect as on a plain item, so × 1.1). A set piece has no effect of its own: a set bonus of n pieces counts × 1.1 once n distinct worn pieces of the set are awakened (two copies of one piece count once). `itemEffectInstances` and `setBonusInstances` read the stored `item_instances.awakening` (validated by `validateItem`); an item without one reads exactly as before (the no-effects hashes and every balance suite are unchanged). Duels read it through `normaliseFighter` like any effect (`effectKeep`).

## Combat rules
- **One pricing function.** `attackHit(setup, attack, prevCrit, heroHealth, enemyHealth)` prices every hero attack in both simulations. Without effects the setup carries no `effects` field and it returns the old `auto`/`skill` profiles unchanged.
- **Aggregate stays exact.** `killDistribution(setup, health)` is the dynamic program over damage dealt, extended with a previous-crit flag (Mana Surge) and with deterministic thorns damage at each enemy hit (a thorns kill is an event at that hit). The hero's health at each attack is known in closed form, because enemy hits are fixed until the hero dies. The distribution cache key adds the start health only when a health-dependent effect (fortitude, rage) is active.
- **Skill surges don't chain** (ticket B.2): Mana Surge, Starfall and Hymn of Cinders turn the attack after a crit into the class skill; that surged attack's own crit does not surge the next one. Before B.2 a surged Aimed Shot (+25 % crit chance) chained into the next, which made the Ashen Choir the hunter's answer to everything. Both simulations carry `crit && !surged` as the next attack's previous-crit flag (`AttackHit.surged`), so the exact distribution and the detailed simulation stay equivalent.
- **Thorns** apply after the enemy's hit lands. If that hit kills the hero, the fight is a death.
- **Life on kill** and **bloodrush** live in the shared cycle loop (`runFarming`) and in the crypt run. Bloodrush stacks are state carried across cycles like health: `FarmingCharacter.momentum` in, `momentum` out. The server stores it (`activities.momentum`, `farm_state.momentum`), so settling more or less often gives the same result (tested). In the crypt a streak starts at 0; the 20 s walk between rooms fades two stacks.
- **No effect equipped:** every number is identical to before. `effects/noEffects.test.ts` pins hashes, computed on `main` before 3.2, of 12 one-hour settlements with epic kits, 12 detailed simulations and 4 crypt runs.

## Balance (asserted in `balance.test.ts`)
Each effect is tested at its strongest roll on a common kit, at the middle of Crowwood, Blackwater and the Sunken Abbey: deaths ≤ 2/h, damage share < 21 %, and kills × 0.99–1.2 of the same kit without it. A Mythic worn in its slot over a rare kit (Abbey 19 and 22) stays inside the bands at × 1–1.3 kills. For every class, the best effect for farming speed, safety and the boss is not the same effect. With any effect, a naked level-16 hero never beats the Gravewarden; a geared level-15 hero always does, and the boss still takes > 60 % of the pre-enrage window. Equivalence: per-fight (12,000 trials, every effect on every class it applies to, two fights) and per 15-minute window (150 seeds, six effect pairs).

**Crypt entry (the 3.1 cliff as it was before ticket 3.6).** Win rate of a level-12 hero in item-level-11 commons with one effect at its best roll (16 seeds), and the effect's kill-rate factor in Blackwater at 15:

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

Boss-focused effects (Tyrant's Bane, Soul Rot, Abyssal Rot) turn the level-12 entry from a certain loss into a certain win for some classes. So does Headsman's Due for the hunter, who already sits closest to the cliff. That is the play pattern they exist for, a crypt gear swap. But it confirmed that the entry was a cliff: any boss bonus moved it. Farming-focused effects (Bloodrush, Unbroken, Bramblemail, Carrion Feast) don't move it. Since ticket 3.6 (the enrage moment is drawn per run from 30–70 s) Tyrant's Bane on level-12 commons wins 61 / 53 / 64 / 52 % instead of 100 / 13 / 100 / 19 %: a real step, not a switch (`docs/DUNGEONS.md`). The per-effect boss check now reads "a geared level-15 hero wins at least 14 of 16 runs, and the boss takes 90 % of the earliest enrage (27 s, as before)".

**Known limits.** Mana Surge, Emberbrand and Starfall scale with crit chance. On a common kit (≈ 5 % crit) they barely register; they are crit-build effects. Carrion Feast does nothing for a geared hero, who regenerates fully between fights anyway; it pays off with lagging gear and in the crypt. Ambush is the strongest Legendary for farming (+14–18 % kills): the hunter's short fights make the opener count.
