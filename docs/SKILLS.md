# Skills, resources and loadouts (ticket 9.1: design and prototype)

**Status: design and game-core prototype, behind a switch that is off.** Nothing here reaches players until the owner says yes (9.2 builds it). With the switch off, no encounter carries a loadout and every game number is exactly today's (no patch note, no server change, no migration in 9.1).

GDD §5.2 (each class's resource drives its skills), §6.3 (skills run automatically, a loadout is picked outside combat, new skills unlock with levels and later content). Owner defaults approved 2026-11-13 (`docs/ROADMAP.md` Phase 9): a loadout of three actives and one passive, six actives and four passives per class unlocked from level 1 to about 40, three presets, damage over time for the Warlock (and one each for the Mage and the Hunter), two later-content skills per class, and the default loadout is today's.

Code: content `packages/game-core/src/combat/skills.ts` (`RESOURCE_RULES`, `ACTIVE_SKILLS`, `PASSIVE_SKILLS`), rules `combat/kit.ts`, read by `buildEncounter`, both farming simulations (`combat/farming.ts`, `combat/fightDistribution.ts`), dungeon and boss fights (`dungeon/run.ts`, also the guild boss and the Proving Grounds), and duels (`pvp/duel.ts`). Measurements: `tools/balance/loadouts.ts`; guards `combat/kit.test.ts`, `balance/loadouts.test.ts`.

## For players (draft for 9.2's Skills screen)
Your hero fights on their own, and now you choose how. Each class has a resource that fills and empties as the fight goes: a Warrior's **Rage** grows with every blow given and taken, a Mage's **Mana** starts full and slowly comes back, a Hunter's **Focus** builds while nothing hits them and crits give some back, and a Warlock gathers **Soul Fragments** from fallen foes and from their curses.

Pick three skills and one passive outside combat. The first slot holds your class skill, the blow that lands every few attacks as it always has; the other two spend your resource when it is ready. New skills unlock as you level and when you fell the Forge Tyrant and the Hollow Sovereign. Some loadouts clear fields fastest, others bring bosses down sooner; none is best at everything. Save up to three loadouts and switch between them when you're not in a fight. If you never open the Skills screen, your hero fights exactly as before.

## Resources (`RESOURCE_RULES`)
All deterministic: gains come from attacks landed, blows taken and the fight's pulse (once a second); the only random input is a crit, as today. A resource never heals or shields (see "The two simulations").

| Class | Resource | Range, start of a fight | Gains | Spent by |
|---|---|---|---|---|
| Warrior | Rage | 0–100, starts at 0 | +4 per attack, +4 per blow taken | heavy skills (Shield Slam, Execute, Earthsplitter, Forgebreaker) |
| Mage | Mana | 0–100, **starts full** (the search between fights refills it) | +3 a second | every Mana skill |
| Hunter | Focus | 0–100, starts at 20 | +15 on a pulse with no blow taken since the last one, +5 per crit | Focus shots |
| Warlock | Soul Fragments | 0–3, starts with what the **last kill left** (2; 0 after a death or a timeout) | +1 on a pulse in which a curse ticks | shadow skills (Soul Burn, Drain Soul, Soul Harvest) |

Passives add to these rules (Deep Reserves: 40 more Mana; Dark Pact: a kill leaves 3 fragments; Soul Siphon: hold 5, two per curse pulse). The Warlock's fragments are the only resource carried between fights (like bloodrush stacks, `momentum`): `FarmingCharacter.soulFragments` in, `FarmingResult.soulFragments` out, and a crypt run starts at 0 and carries them room to room. 9.2 stores them with the activity (additive columns, default 0).

## The skills
Six actives by level (1, 5, 12, 20, 28, 36) and one taught by the **Forge Tyrant's fall** (Phase 6 content: older bosses gain a use); four passives by level (8, 16, 24, 32) and one taught by the **Hollow Sovereign's fall** (Phase 8). Today's skill is each class's first active, with today's numbers (read from `AUTO_SKILLS`). Multipliers are of the class's primary damage, like today's skill.

Two kinds of active:
- **Core** (slot 1): fires on every n-th attack, exactly like today's class skill. Each class has two: today's and one with damage over time (unlocked at 20) that hits softer up front and more over time.
- **Spender** (slots 2 and 3): replaces a basic attack when it is ready: affordable, off cooldown, its condition holds (opener: only the fight's first attack; execute: only while the foe is low; a curse: only while its own one has run out). Slot 2 is asked first.

**Warrior (Rage)**

| Level | Skill | Kind | Does |
|---|---|---|---|
| 1 | Heavy Strike | core | every 4th attack, 200 % (today) |
| 5 | Shield Slam | spender | 50 Rage: 160 % |
| 12 | Charge | spender, opener | the fight's first attack: 150 %, +15 Rage |
| 20 | Rend | core | every 4th attack: 120 %, bleeds 25 % a second for 4 s |
| 28 | Execute | spender | foe at 30 % or less: 180 % (30 Rage) |
| 36 | Earthsplitter | spender | ready 8 s into a fight, then every 15 s: 260 % (40 Rage) |
| Tyrant | Forgebreaker | spender | all Rage (at least 60): 100 % + 1.2 % per point |
| 8 | Unyielding | passive | blows −8 %, +2 Rage per blow |
| 16 | Berserker | passive | +6 % damage to foes that are not bosses, blows +10 % |
| 24 | Battle Rhythm | passive | +2 Rage per attack |
| 32 | Juggernaut | passive | +4 Rage per blow, +4 % damage to bosses |
| Sovereign | Hollow Wrath | passive | Rage skills +10 % |

**Mage (Mana)**

| Level | Skill | Kind | Does |
|---|---|---|---|
| 1 | Firebolt | core | every 3rd attack, 180 % (today) |
| 5 | Arcane Bolt | spender | 30 Mana: 135 % |
| 12 | Pyroblast | spender | 80 Mana: 190 % |
| 20 | Scorch | core | every 3rd attack: 120 %, burns 20 % a second for 4 s |
| 28 | Shatter | spender | foe at 35 % or less: 150 % (25 Mana) |
| 36 | Meteor | spender | ready 6 s in, then every 15 s: 220 % (40 Mana) |
| Tyrant | Emberstorm | spender | 10 s in, then every 15 s: 180 %, no cost |
| 8 | Mana Well | passive | +2 Mana a second |
| 16 | Arcane Power | passive | +6 % damage to foes that are not bosses, blows +10 % |
| 24 | Mana Shield | passive | blows −6 %, −1 Mana a second |
| 32 | Deep Reserves | passive | +40 Mana, every fight starts full |
| Sovereign | Kindling | passive | burns +40 %, Mana skills +5 % |

**Hunter (Focus)**

| Level | Skill | Kind | Does |
|---|---|---|---|
| 1 | Aimed Shot | core | every 4th attack, 160 %, +25 % crit chance (today) |
| 5 | Quick Shot | spender | 25 Focus: 140 % |
| 12 | First Blood | spender, opener | the fight's first attack: 140 %, +30 % crit chance |
| 20 | Serrated Arrow | core | every 4th attack: 110 %, +25 % crit chance, bleeds 15 % a second for 4 s |
| 28 | Kill Shot | spender | foe at 30 % or less: 180 % (30 Focus) |
| 36 | Volley | spender | ready 5 s in, then every 10 s: 220 %, +20 % crit chance (40 Focus) |
| Tyrant | True Shot | spender | 50 Focus: 160 %, +40 % crit chance |
| 8 | Steady Aim | passive | +8 Focus on an unhit pulse |
| 16 | Predator | passive | crits refund 7 more Focus |
| 24 | Skirmisher | passive | +6 % damage to foes that are not bosses, blows +8 % |
| 32 | Eagle Eye | passive | +5 % damage to bosses |
| Sovereign | Hollow Mark | passive | bleeds +40 %, Focus skills +5 % |

**Warlock (Soul Fragments)**

| Level | Skill | Kind | Does |
|---|---|---|---|
| 1 | Shadow Bolt | core | every 3rd attack, 170 % (today) |
| 5 | Corruption | spender, curse | 60 %, then 8 % a second for 12 s (recast when it ends) |
| 12 | Soul Burn | spender | every fragment (at least 2): 100 % + 25 % each; every 12 s at most |
| 20 | Agony | core | every 3rd attack: 110 %, then 20 % a second for 4 s |
| 28 | Drain Soul | spender | foe at 25 % or less: 150 % (1 fragment) |
| 36 | Doom | spender, curse | ready 6 s in, then every 16 s: 60 %, then 25 % a second for 10 s |
| Tyrant | Soul Harvest | spender | every fragment (at least 4): 100 % + 15 % each; every 6 s at most |
| 8 | Dark Pact | passive | a kill leaves 3 fragments; +4 % damage to foes that are not bosses |
| 16 | Malice | passive | curses +40 % |
| 24 | Demon Skin | passive | blows −10 %, −2 % damage |
| 32 | Soul Siphon | passive | hold 5 fragments, two per curse pulse |
| Sovereign | Hollow Covenant | passive | shadow skills +10 %, curses +10 % |

**Design shape.** Every class has the same levers, so no class lacks a tool: an opener or a start-full resource and a damage-to-normal-foes passive for farming (short fights), ramp-up skills, timed nukes, curses and a boss passive for bosses (long fights), an execute that serves both, and a defensive passive. Boss rank is read from the foe (`enemy.rank`), so "not bosses" covers the field, the crypt's rooms and duels' targets (duels turn those bonuses off: "PvP").

## Loadouts (`Loadout`, `validateLoadout`)
- **3 + 1:** slot 1 a core skill, slots 2 and 3 a spender or empty, one passive or none. No skill twice, only the hero's class, only unlocked skills (level, and the deed for the boss skills). `validateLoadout(classId, loadout, hero)` lists the problems; `resolveLoadout` refuses an invalid one.
- **The default loadout** is today's class skill alone (`defaultLoadout`): a hero who never opens the screen fights exactly as today ("The replay").
- **Presets:** three per hero (`LOADOUT_PRESETS`), stored by 9.2.
- **Switching settles first,** like the loot filter (3.7): the server settles the running activity under the character lock, then stores the new loadout, so a window never mixes two loadouts and nobody can switch mid-fight. Idempotent, audited (9.2). A duel defence snapshot carries the loadout saved with it.
- **Server authority:** the loadout is server state, validated on save and again before each settlement (a skill whose unlock was lost, which can't happen today, would fall back to the default loadout, not throw).

## The fight's timeline
- **Three clocks, all fixed:** the hero attacks at `j · interval`, the enemy at `k · interval` (as today), and the fight's **pulse** every 1,000 ms from the fight's start (`PULSE_MS`). The pulse exists only when a loadout needs it (a curse, a timed or regenerating resource, a cooldown); the default loadout has none.
- **Order on equal times:** the hero's attack, then the pulse, then the enemy (today's rule "the hero acts first" stays).
- **An attack:** the core fires exactly as today's class skill (`attackHit`: its cadence, a Legendary opener, a surge after a crit); otherwise the first ready spender replaces the basic attack. The resource moves after the roll (cost, gain, +per attack, +per crit), cooldowns start at the cast.
- **Damage over time:** a cast sets its ticks (no stacking: recasting the core's refreshes it; a spender's curse waits until its own one ends). Each pulse, every running damage over time deals its tick: an integer fixed when the encounter is built, `perTick ×` the 1× hit after mitigation (boss and passive bonuses included, no crit, no Legendary effect). A tick can make the kill. Against a boss's shell or ward a tick is softened like a blow.
- **A blow taken** builds Rage, and a pulse after one gives the Hunter no Focus.
- **Between fights:** every resource resets (Mana full, Rage 0, Focus 20), except the Warlock's fragments (above).

## Legendary and set effects that name "the class skill"
**They read slot 1** (recommended in the ticket, built so in the prototype). Rage-Fuelled Strikes, Mana Surge, Ambush, Soul Rot, Gravecaller's Hunger, Starfall, Abyssal Rot, the Hymn of Cinders, Last Rite, The Long Hunt and the class-skill affix ("+x % Heavy Strike") act on the core skill in slot 1: its cadence, its multiplier, its opener and surge. A spender is never "the class skill": it gets the effects every hit gets (crit burn, execute, fortitude, boss bonuses) and none of the skill-only ones. So today's items keep their meaning, and with today's skill in slot 1 they mean exactly what they say. With the other core skill (Rend, Scorch, Serrated Arrow, Agony) in slot 1 they boost that one instead; 9.2's tooltips say "your class skill (slot 1)". Fight traits that guard "the class skill" (8.1's choir, 8.2's sentinel) guard slot 1 the same way.

## The two simulations stay exact
`simulateFarmingAggregate` needs the exact distribution of how a fight ends. The ticket's three options:
1. **A state-machine dynamic program per encounter setup (chosen).** `killDistribution` already walks the timeline over states (damage dealt, previous attack crit). Under a kit the state adds the kit's state (resource, each cooldown's ready time, each damage over time's ticks left, "unhit since the last pulse"). Every transition is deterministic except the crit roll, so equal states still merge; the timeline merges attacks, pulses and blows in the fixed order. Kills on a pulse are events like thorns kills. Sampling is unchanged: one RNG draw per fight (`sampleFight`), so the per-cycle streams, split-invariance and the server's storage are unchanged.
2. *A short exact replay per fight with the same single draw:* not exact (a replay needs one draw per crit), so it would change the RNG streams; rejected.
3. *A precomputed distribution per loadout:* the distribution depends on the encounter (foe, level, gear, health), so it cannot be precomputed per loadout alone; the DP's cache per setup already is the precomputation.

**The one design constraint that keeps it exact:** no skill or passive heals or shields, and nothing moves the hero's health on a random schedule. Then the hero's health at every moment is still closed-form (enemy blows are fixed until the hero dies), so death and timing are derived as today. Defensive utility comes from constant passives (blows −6 to −10 %) instead. A healing or shielding skill would need the hero's health in the state and a death distribution next to the kill distribution: possible, measured as not needed for the exit criterion, left as an owner question.

**Agreement** (`combat/kit.test.ts`): per fight, 12,000 trials of the detailed fight against the sampled one for a boss and a farming loadout of every class against a Hollow Deep foe and the Hollow Sovereign (kill/death/timeout within 1.5 points, fight time within 3 %); per window, 150 seeds × 15 minutes per class (kills, deaths, XP, encounters within 4 standard errors); settling a 40-minute window in eight parts gives the same kills, level and XP as one settlement, with the fragments carried.

**Cost of the offline settlement** (`tools/balance/loadouts.ts cost`; Hollow Deep 49, Legendaries 47 +10, median of 9 runs, laptop; the settlement includes loot):

| Window · class | Settlement: today / default kit / loadout (ms) | Combat only: today / default kit / loadout (ms) |
|---|---|---|
| 3 h · warrior (Rend, Execute, Earthsplitter / Juggernaut) | 16.6 / 18.8 / 22.5 | 9.8 / 12.9 / 14.6 |
| 3 h · mage (Scorch, Pyroblast, Meteor / Deep Reserves) | 16.0 / 16.0 / 20.4 | 8.8 / 11.0 / 15.2 |
| 3 h · hunter (Serrated Arrow, Volley, Kill Shot / Predator) | 18.3 / 20.4 / 25.4 | 11.7 / 15.3 / 18.7 |
| 3 h · warlock (Agony, Corruption, Soul Burn / Soul Siphon) | 14.5 / 17.1 / 26.2 | 10.3 / 12.3 / 19.2 |
| 8 h · warrior | 35.7 / 40.6 / 48.0 | 24.2 / 28.5 / 36.2 |
| 8 h · mage | 46.2 / 40.1 / 54.9 | 21.8 / 30.1 / 37.9 |
| 8 h · hunter | 47.2 / 55.8 / 66.9 | 30.6 / 40.8 / 52.0 |
| 8 h · warlock | 38.9 / 48.4 / 62.2 | 25.9 / 32.0 / 45.6 |

A loadout costs about 1.3–1.8 × today's settlement; an 8-hour window (9.4's longest offline cap) stays under 70 ms. The "default kit" column is the kit path with today's loadout (string state keys): 9.2 keeps today's path for the default loadout, so heroes who never choose pay nothing.

## The prototype and the switch
`setSkillsPrototype(mode)` (`combat/kit.ts`), `DEFAULT_SKILLS_PROTOTYPE_MODE = 'off'`; only tests and tools call it, the server never does.
- `off` (in play): no encounter carries a kit; `loadout` inputs (`FarmingInput`, `SettleFarmingInput`, `DungeonRunInput`, `PvpFighterInput`, `PowerInput`) are never read.
- `on`: every encounter carries a kit (`EncounterSetup.kit`), the given loadout or the default one.
- `shadow`: as `on`, and every fight whose loadout is the default one is also resolved with today's rules: `buildEncounter` (every number but the kit), `resolveFightDetailed` and `resolveDungeonFight` (outcome, RNG state after, log), `killDistribution` (the exact distribution, float for float) and `simulateDuel` (the whole result). Any difference throws `SkillsReplayMismatch`.

### The replay (the default loadout is today, bit for bit)
`WF_SKILLS_PROTOTYPE=shadow pnpm --filter @worldforge/game-core test` runs **every** game-core suite (91 files, 1,422 tests before 9.1: every balance suite, the pinned no-effects hashes, the curve pins of 6.2/8.1/8.2, the duel hashes, Power's pins) with each fight resolved both ways: all pass, no mismatch (`tools/vitest/skills-prototype.mjs`; CI runs it as "tests (game-core skills replay)"). `kit.test.ts` also compares whole farming windows (both simulations, every class, three areas), crypt and boss runs and duels with the switch off and in shadow mode, and checks that the replay does catch a kit that fights differently. On the measurement jobs below, the default loadout gives today's numbers exactly (`loadouts.ts jobs`: every value equal).

## Measurements: every loadout, today's jobs (`tools/balance/loadouts.ts search`)
**Jobs** (`balance/loadouts.ts`), today's reference kits at levels where the job's skills are unlocked; farming = kills a minute over 2 × 30 min, bosses = mean boss fight time over 48 runs, a loss counting as the 150 s limit (B.2's convention). Every loadout the hero can field there (each core, slots 2–3 empty, one spender or an ordered pair, no passive or one): 30–312 per class and job. Boss skills (Tyrant, Sovereign) count where the hero has felled them (the Hollow Deep and the Sovereign).

**Before → after: today (the default loadout) → the best loadout**, its factor, and how many distinct loadouts (skills and passive, slot order ignored) are viable (within 7 % of the best):

| Job | Warrior | Mage | Hunter | Warlock |
|---|---|---|---|---|
| Ashen Pass 26 (k/min) | 10.6 → 11.6 (× 1.10) · 16 | 12.0 → 13.5 (× 1.13) · 21 | 18.3 → 19.3 (× 1.06) · 16 | 11.9 → 13.2 (× 1.11) · 10 |
| Cinder Depths 37 (k/min) | 8.1 → 9.1 (× 1.13) · 28 | 6.7 → 7.8 (× 1.15) · 35 | 11.8 → 12.7 (× 1.07) · 55 | 7.5 → 8.4 (× 1.11) · 41 |
| Hollow Deep 49 (k/min) | 7.1 → 8.0 (× 1.13) · 34 | 6.6 → 7.4 (× 1.12) · 95 | 9.4 → 10.0 (× 1.07) · 97 | 7.3 → 7.8 (× 1.06) · 109 |
| Gravewarden III 23 (s) | 26.4 → 25.0 (× 1.06) · 16 | 38.3 → 36.0 (× 1.06) · 11 | 25.0 → 22.8 (× 1.10) · 6 | 28.5 → 26.2 (× 1.09) · 7 |
| Heroic 34 (s) | 39.4 → 34.3 (× 1.15) · 21 | 78.5 → 54.7 (× 1.44) · 16 | 33.1 → 28.8 (× 1.15) · 17 | 38.2 → 35.2 (× 1.09) · 35 |
| Forge Tyrant 38 (s) | 36.5 → 31.6 (× 1.16) · 22 | 74.5 → 48.2 (× 1.55) · 18 | 30.5 → 25.6 (× 1.19) · 21 | 36.7 → 31.8 (× 1.15) · 27 |
| Hollow Sovereign 50 (s) | 42.6 → 37.0 (× 1.15) · 31 | 54.0 → 41.6 (× 1.30) · 13 | 35.0 → 29.4 (× 1.19) · 33 | 33.8 → 30.3 (× 1.11) · 51 |

The mage's boss times include losses: the default mage wins 71 % (Heroic), 73 % (Tyrant) and 90 % (Sovereign) of these runs in this one kit (B.5: the weakest boss class; over B.5's eight kits it is at its ≥ 90 % band at +10), and the best loadouts win 92 %, 96 % and 98 %; over won fights alone the mage's gain is like the others'. Every other win rate is 100 % before and after.

**The leading loadouts** (the best of each job):

| Class | Farming (Deep 49 · Depths 37) | Bosses (Sovereign 50 · Tyrant 38) |
|---|---|---|
| Warrior | Heavy Strike, Charge, Execute / Berserker | Heavy Strike, Execute, Earthsplitter / Juggernaut |
| Mage | Firebolt, Pyroblast, Shatter / Arcane Power | Firebolt, Meteor, Emberstorm / Kindling · Firebolt, Meteor, Shatter / Mana Shield |
| Hunter | Aimed Shot, Volley, Kill Shot / Skirmisher · Aimed Shot, Kill Shot, Quick Shot / Skirmisher | Aimed Shot, Volley, True Shot / Eagle Eye · Aimed Shot, Volley, Kill Shot / Eagle Eye |
| Warlock | Shadow Bolt, Corruption, Soul Burn / Dark Pact · Shadow Bolt, Soul Burn, Drain Soul / Dark Pact | Shadow Bolt, Doom, Drain Soul / Malice · Agony, Soul Burn, Doom / Malice |

**No loadout dominates both.** Per tier, a farming job and the boss jobs near its level, over the loadouts both can field: a loadout "leads" a job within 2 % of its best (boss times move ~2 % between seed sets, B.2). Where the whole kit is unlocked (Depths 37 × Tyrant 38, Deep 49 × Sovereign 50) **no loadout leads both, for any class**, and each job's leader trails the other job's best by 4.5–30 %:

| Class | Depths 37 × Tyrant 38: farm leader at the boss · boss leader farming | Deep 49 × Sovereign 50 |
|---|---|---|
| Warrior | 7.9 % behind · 7.9 % behind | 7.8 % · 9.6 % |
| Mage | 29.7 % · 10.2 % | 20.8 % · 9.6 % |
| Hunter | 7.8 % · 5.0 % | 6.1 % · 5.2 % |
| Warlock | 13.4 % · 8.9 % | 5.1 % · 4.5 % |

Below level 36 a hero has two or three spenders and fewer real choices: at Pass 26 × Gravewarden III 23 the warrior's, the mage's and the hunter's farming leaders also lead the boss (one to nine slot orders and passives of the same two spenders), and at Depths 37 × Heroic 34 (no level-36 skill yet) the warlock's Corruption + Soul Burn leads both. Choice opens up with levels, as the GDD asks; measured, not asserted.

**Inside today's bands, sidegrades.** The best loadouts gain 6–16 % (the mage's boss times aside), never a new power curve: asserted < × 1.18 farming and < × 1.22 at bosses (mage < × 1.6), > × 1.03 (a choice is worth making). The five best farming loadouts of every class keep the Hollow Deep's bands (no deaths in an hour, 6–13 kills a minute). Older gear keeps its value: loadouts multiply what the gear does, they add no item and change no drop.

**Asserted** (`balance/loadouts.test.ts`, about 30 s): per class and job at least three distinct viable loadouts; the sidegrade bounds; at the two full tiers no loadout within 2 % of both bests and each leader more than 3 % behind on the other job; the farming bands.

## PvP: a proposed `PVP_RULES_VERSION` 3
**Measured** (`loadouts.ts pvp`; 200 duels per pair, sides alternated; level 25 in Legendaries 24 +5 and level 32 in Legendaries 29 +5; every complete loadout against the same class's default). With skills kept whole (passives' damage bonuses already off), the best loadout beats the default 77–94 % of the time in 30+ and the median one 63–90 %: duels normalise gear (`keep` 0.25) and effects (`effectKeep` 0.25), but not skills, so a loadout would matter more than a whole gear upgrade.

**Proposal for version 3** (built in the prototype, `PVP_V3_SKILL_KEEP`):
- a duel keeps **half** of a skill's extra damage: a spender's multiplier `1 + (m − 1) × 0.5`, a damage over time's ticks × 0.5, consume-all bonuses × 0.5 (`skillKeep`; mechanics, costs and cooldowns stay);
- a passive's damage bonuses (to foes that are not bosses, to bosses) are PvE only; its damage-taken change counts × `effectKeep` (0.25), like items' defensive effects;
- the defence snapshot carries the loadout saved with it, so a defender can't be read against a different one.

| Against the same class's default | Keep all (as PvE) | **Keep half (proposed)** | Keep a quarter |
|---|---|---|---|
| 20–29: best · median loadout | 0.58–0.85 · 0.43–0.74 | **0.56–0.69 · 0.31–0.59** | 0.55–0.61 · 0.23–0.39 |
| 30+: best · median loadout | 0.77–0.94 · 0.63–0.90 | **0.69–0.82 · 0.47–0.59** | 0.63–0.71 · 0.29–0.39 |

At half, the default is about the median loadout, and the best loadouts win 69–82 % against it: less than a gear tier (B.4: the biggest gear steps reach 96–97 %). At a quarter most loadouts lose to the default (their spenders' costs outweigh what's left). The largest class favourite in these kits moves 0.95 → 0.95 (20–29) and 0.89 → 0.91 (30+) with every class on its best duel loadout; these are not B.4's fairness fixtures, so 9.2 re-runs `pvp-balance.test.ts` and `arena-fairness.test.ts` with loadouts and tunes the class factors there if a band moves.

**Duel Power and matchmaking.** Bracket Power 3's expected-value duel (`expectedDuelTimes`) reads `attackHit` and ignores a kit; the default loadout's duel Power is unchanged. 9.2: bracket Power 4 prices the defence loadout's spenders in the expected-value duel (expected casts from a crit-free replay of the kit's resource, cooldown and condition rules), stored with the defence, recomputed when the loadout changes; no board reads it, so it can switch at once (like 6.5b's and B.5's versions). Version 3 duels need the `PVP_RULES_VERSION` bump with the pinned duel hashes, and ship between seasons (6.1's rule).

## Boards: a proposed Power version 4
The Proving Grounds read **the hero's saved defence loadout** (the ticket's recommendation): one loadout per hero, chosen for duels, so a hero cannot swap in a per-trial best for the board. A hero without one fights with the default loadout. Built in the prototype (`PowerInput.loadout`); Power's trials, seeds and points are unchanged.

| Level, kit | Default loadout = today (Power 3) | Best complete loadout | Median |
|---|---|---|---|
| 34, Legendaries 33 +10 | warrior 4,315 · mage 4,143 · hunter 4,432 · warlock 4,251 | 4,364 · 4,213 · 4,459 · 4,271 (× 1.00–1.02) | 4,342 · 4,179 · 4,428 · 4,252 |
| 50, Legendaries 47 +10 | 4,405 · 4,353 · 4,520 · 4,417 | 4,454 · 4,411 · 4,534 · 4,422 (× 1.00–1.01) | 4,420 · 4,384 · 4,515 · 4,411 |

A loadout moves Power by at most 2 % (it clears trials faster; nobody newly fails one), so ranks move only among close heroes. **Power 4** is a version bump all the same (a new input can change the value): planned by the server the first time it sees it and in force at the end of the season under way (6.1's schedule); a hero with the default loadout keeps exactly their Power 3 value, so the 5.2 sweep only recomputes heroes who saved a loadout. Gear Score, Level and PvE Progress don't read loadouts. Matchmaking's bracket Power 4 (above) is separate.

## What 9.2 builds (after the owner's yes)
- **game-core:** the switch on in play; the default loadout keeps today's code path (no kit), so its cost and its numbers are today's; telemetry fields by loadout.
- **Server:** `character_loadouts` (hero, preset 1–3, active preset, actives, passive; additive, a hero without one reads the default), `activities.soul_fragments` / `farm_state.soul_fragments` (default 0), the loadout and preset calls (settle first, idempotent, audited), the defence snapshot's loadout, Power 4 and `PVP_RULES_VERSION` 3 between seasons, telemetry by loadout (kills/min and boss times per class and loadout, for B.7).
- **Web:** the Skills screen (locked skills shown with their unlock, plain descriptions with game-core's numbers), the moving resource bar, ticks in the log and the scene (the prototype logs no tick events: `DungeonEvent`/`CombatEvent` stay as they are).

## Risks and limits
- **The mage at bosses:** a few percent of damage turns its lost Heroic and Tyrant fights into wins (71 → 92 %, 73 → 96 % in this kit). Fairer between classes (B.5's spread shrinks), but a real move at those bosses; owner question 3.
- **Low levels:** before 36 the farming and boss leaders can coincide (fewer spenders unlocked); choice grows with levels.
- **Small farming spreads at the Hollow Deep** for the warlock and the hunter (best × 1.06–1.07): long fights favour no single tool; the boss side carries their choice.
- **Measurements on single reference kits** (B.2-style); B.7 re-measures on telemetry by loadout after 9.2.
- **PvP numbers** come from Legendary kits, not B.4's fairness fixtures; 9.2 re-runs the arena bands.
- **Power and fragments:** the Proving Grounds start every fight without fragments (no carry between their four fights); 9.2 carries them like a crypt run if the owner wants the warlock's farming tool to count there.
- **Cost:** up to 1.8 × today's settlement for a loadout (8 h ≤ 70 ms); fine today, watched in 9.2's telemetry.

## Owner questions (recommendations first)
1. **Effects that name "the class skill" read slot 1.** *Recommended: yes* (built so): today's items keep their meaning; with the alternative core skill in slot 1 they boost that one, and tooltips say "your class skill (slot 1)". Alternative: only today's skill counts (the alternative core loses every class-skill effect: it would never be picked with them).
2. **Slot 1 must hold a core skill (the cadence), slots 2–3 spenders.** *Recommended: yes*: it keeps the default exactly today's and the effects' meaning; a spender in slot 1 would need its own cadence rules.
3. **The mage's boss gain from loadouts** (win rates at the Heroic and the Tyrant up 20+ points in one kit). *Recommended: accept* (it closes B.5's class gap); alternative: Mana Shield −6 % → −4 % and Meteor 220 % → 200 % (re-measure in 9.2).
4. **Sidegrade size:** the best loadout gains 6–16 % on its job. *Recommended: keep* (a choice worth making, inside every band); alternative: scale every spender's extra damage by 0.75 (≈ 4–12 %).
5. **No healing or shielding skills** (keeps the offline settlement exact and cheap). *Recommended: yes*; defensive utility stays in passives. Alternative: a death distribution in the DP (a later ticket; cost about ×2).
6. **PvP version 3: keep half of a skill's extra damage, passives' damage bonuses PvE only.** *Recommended: yes* (the default is the median loadout; the best win 69–82 % against it).
7. **Power 4 reads the saved defence loadout** (one loadout per hero, can't be gamed per trial), switched at the end of the season under way. *Recommended: yes.*
8. **Soul Fragments carry between fights** (a kill leaves 2, a death or a timeout none; stored with the activity). *Recommended: yes* (the warlock's farming identity); alternative: fragments only from curses (no new stored state, but the warlock loses its farming lever).
9. **The two later-content skills: an active from the Forge Tyrant, a passive from the Hollow Sovereign.** *Recommended: yes* (as built); 9.2 can wire them to a short quest at each boss instead of the kill flag.
10. **Unlock levels 1–36 for actives and 8–32 for passives** (all by the Cinder Depths). *Recommended: yes*; the owner default said "about 40".
