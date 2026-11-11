# Item Awakening: evaluation (ticket 6.5) and build (ticket 6.5b)

GDD §8.2 ("a rare long-term project, not to make every item mandatory to awaken"), §15 Phase 6 exit ("endgame systems add meaningful choices without making older content or most item drops irrelevant"). **Status: built (ticket 6.5b, version 0.6.9).** The owner said yes to option (b) at × 1.1 on 2026-11-10, with one change to the recommendation: **awakening counts in duels and in matchmaking**. See "As built (ticket 6.5b)" at the end. Sections 1–10 are the 6.5 evaluation as it was written; where it says "duels ignore awakening", the owner overruled it.

## The short version

- **Recommendation: ship option (b), the Awakened effect, at × 1.1.** An awakened Legendary's effect, a Mythic's signature or (piece by piece) a set's bonuses get 10 % stronger. It costs 3 Tyrant's Embers, 2 Gravewarden's Seals, gold and soul shards, which is 3 days of boss hoards per item for a dedicated player and about a season for a whole kit. PvP duels ignore it. Gear Score and Power need no new version.
- **What it does:** a whole awakened kit kills the late bosses 3–10 % faster than the best +10 Void/Prismatic kit and farms 0–2 % faster. One awakened piece adds about 0.1–0.8 % (at most 2.7 %). That is about the size of Void, which is a chase item and not a new tier.
- **Why it passes the exit criterion:** an awakened kit of Ashfall Verge drops (item level 33) is no better than the same build from the Cinder Depths (item level 39) without awakening (−3.8 to +0.6 %). One awakened older piece always loses its slot to a newer plain drop (−0.5 to −6.6 %). So new drops stay worth wearing. Nothing below item level 23 can awaken, and a level-28 hero can't awaken anything (the Embers come from a level-36 boss).
- **Runner-up: option (a), an extra affix slot, at half an affix.** It has similar numbers on top builds, but it is a bigger step for ordinary kits (+7–13 % Depths farming), it changes the item model in five places, and it tilts the Void/Prismatic balance toward Prismatic.
- **At the strengths first sketched (× 1.25, a full affix) neither option passes:** an awakened Verge kit beats plain Depths gear by up to 10 % at the Tyrant, and a whole kit is a 12–22 % boss step.

## 1. Options

### (a) An extra affix slot
**How it works.** An awakened item gets one more affix than its rarity rolls: a Legendary or set piece goes from 4 to 5, a Mythic from 5 to 6. The player picks the affix from the slot's pool (any affix the item doesn't already carry, the same pool a reroll draws from). It rolls in the highest tier the item level unlocks. The prototype also has a size knob: the share of a full affix the slot rolls (`affixValueShare`; tuned to 0.5).

**What it does to builds.** It makes the item more of what the build already wants (more crit, speed or health). It is a stronger version of what the Forge's reroll already does, so it adds power more than it adds choice. Every eligible piece benefits about the same, so it rewards awakening everything. Prismatic reads the extra affix × 1.1 like its others, which moves the Void/Prismatic sidegrade up to 3–4 % toward Prismatic.

### (b) An awakened effect (recommended)
**How it works.** An awakened item's own effect counts × `effectStrength` (tuned to 1.1). This works the way Void's strength does: magnitudes only, never thresholds, stack counts or decay, still under the registry's caps (`DEFAULT_EFFECT_CAPS`), and an effect still counts once. On a Void item it multiplies with Void's × 1.1. **Set pieces** have no effect of their own, so awakening one counts toward its set: a bonus that needs n pieces is awakened once n of the distinct worn pieces of that set are awakened. Two copies of one piece count once, as for the bonus itself.

**What it does to builds.** It strengthens the choice the player has already made, which effect or set to build around, and the choice of which pieces to awaken matters. A set build has to awaken 2, 4 or 6 pieces before its bonus moves, so it is a long project by design. A piece whose effect does nothing for the build gains nothing. An effect at its cap gains nothing either, and 6.5b's tooltip must say so before the player pays. It never touches base values, affixes, find or economy stats.

### (c) Cosmetic plus minor (not prototyped)
**How it works.** An awakened item gets a visual mark (an ember glow on the icon, a name prefix, an entry in 6.8's collection book) and a token bonus (e.g. +2 % base values).

**What it does to builds.** Nothing a build notices. It's a good fit for GDD §13 (cosmetics never grant power), but it is a weak sink for a 3-day cost, and the owner's §8.2 asks for "an additional affix slot or a special effect". It works best as an add-on to (b): the awakened mark is the visual for (b) in 6.5b, with no extra power.

## 2. Eligibility

| Rule | Recommendation | Why |
|---|---|---|
| Rarity | Legendary (with an effect), Mythic, set piece | (b) needs something to awaken. A Legendary without an effect (from before 3.2) is refused (`nothing_to_awaken`). |
| Upgrade | **+10 only** | It comes after the upgrade track and doesn't compete with it. |
| Item level | **23 or higher** (the Ashen tier, where Prismatic starts) | Abbey and crypt I–III drops (≤ 22) stay as they are. Pass, Warden, Verge, Depths, Tyrant and Heroic drops can awaken. |
| Once per item | Yes (`already_awakened`) | A long project, not a second upgrade track. |
| Void and Prismatic | Both can awaken; the variant is untouched | (b) multiplies with Void's effect strength (× 1.1 × 1.1 = × 1.21 on the effect). Prismatic leaves the effect as on a plain item, so (b) is the same × 1.1 there. The sidegrade holds: best Prismatic ÷ best Void stays within −0.9 to +2.6 % with every piece awakened (6.4's band is 5 %). |
| Rerolls and improvements afterwards | **Allowed** at the usual prices | (b) doesn't touch affixes, so the Forge keeps working as before. Under (a) the awakened affix could be rerolled and improved like the others. |
| Undo or move | **No.** Permanent, never transferred to another item | Simple and auditable. The cost is the commitment. |

## 3. Costs and sinks

**Per awakening (prototype numbers, `DEFAULT_AWAKENING_SETTINGS.cost`):** 3 Tyrant's Embers, 2 Gravewarden's Seals, 15,000 gold at item level 20, scaled like every Forge cost by `(itemLevel + 5) / 25` (25,200 at item level 37), and 30 soul shards.

- **Tyrant's Ember** (6.2): one per Forge Tyrant hoard, 20-hour cooldown, never tradeable. This is the gate, so time and not money paces awakening. It is the Ember's second sink next to the Tyrantforged Work recipe (1 Ember per craft). Each awakening is 3 crafts not made, which is a real choice.
- **Gravewarden's Seal:** one per crypt hoard (any tier, Heroic included, shared 20-hour cooldown). This is the "Heroic material": no new material or icon is needed, and it gives tiers III and IV a lasting reason to be run. An owner question below asks whether it should be Heroic-only. **Ticket 6.11:** Seals beyond a kit's needs go to the Forge's engraver (2 a seal-wax engraving) and exchange (cosmetics); the Forge warns before seal-wax would dip into the Seals the hero's ready items need, and the kit's pace is unchanged (`docs/BALANCE.md` "6.11").
- **Gold and soul shards:** a secondary sink. 25,200 gold is 4–9 hours of Depths income for a realistic kit (2,700–5,900 gold an hour), and 30 shards are 5–8 hours. Neither one sets the pace.

**Hours of play** (`tools/balance/awakening.ts time`). This uses the realistic player's cadence from B.2/B.3: five visits a day, about 15 credited hours of farming, a boss hoard once a day (its 20-hour cooldown with visits about 5 hours apart), and a failed boss run retried at the next visit. Income, Tyrant and crypt win rates come from game-core for a +10 kit of Verge Legendaries at level 38 farming the Depths. Casual and regular players play a quarter and a half of that (B.4's population).

| | Dedicated | Regular | Casual |
|---|---|---|---|
| One awakening (Ember-bound; gold alone 4–9 h) | 3 days (≈ 45 h of play) | 6 days | 12 days |
| Full kit (8 pieces; the warrior 9 with the shield) | 24–27 days | 48–54 days | 96–108 days |
| A 6-piece set's bonuses all awakened | 18 days | 36 days | 72 days |

Tyrant win rates with that kit: warrior, hunter and warlock 100 %, mage 73 % (5 tries a day still make one hoard a day). **First awakening:** about three days after a hero first beats the Tyrant (level 36) with a +10 eligible item. B.3 measured a whole +10 kit at about 140 hours of Pass income, so most heroes reach the Tyrant with some +10 pieces already. A full kit is about one 8-week season for a dedicated player and two or more for everyone else. That matches "a rare long-term project".

## 4. Binding, the shelf, holds and reversals

- **Awakened items are account-bound and never tradeable**, whatever the trading switches say. A +10 item is already account-bound (T.1: any Forge work binds), so this changes nothing today. 6.5b still adds an explicit "awakened" refusal to the trade rules so that a future switch can't open it.
- **The shelf (T.3):** an awakened item may go on the account's shelf like any account-bound item. One of the account's heroes can awaken an item for another, but each hero earns its own Embers (they never leave the hero). See the owner question.
- **Holds (T.5):** 6.5b treats awakening as Forge work, so it is refused on held items for the 72-hour hold. A received item can't be awakened before the hold ends, and a reversal always finds it untouched.
- **Reversals (T.6):** an awakened item that came from a trade can no longer be reversed (it isn't "untouched"), the same as any item forged after its hold. The moderator sanctions instead, as today.
- **Server rules for 6.5b:** an `item_awakening` column (option and strength, or a version id), `validateItem` accepting it only on eligible items, and a `forge.awaken` audit event with costs, under the Forge's locks and idempotency. There is no random draw under (b). Under (a) the roll would come from the forge stream.

## 5. Boards and PvP

| | Option (b) × 1.1 | Option (a) half an affix |
|---|---|---|
| **Gear Score** | Unchanged. It reads item level, rarity, upgrades and variant, and magic quality reads affixes. No new version. | The fifth affix raises magic quality, which breaks Gear Score 2's tie-break: version 3 would be needed (count only rolled affixes, or add a factor). |
| **Character Power** | Counts automatically (it fights with the items): +0.1 % at level 38 (4,149–4,165 → +4 to +5). No new version: no stored input can carry an awakening before 6.5b (6.4's argument). | +0.1–0.2 %, the same reasoning. |
| **PvE Progress** | Unchanged (it is about content, not gear). | Unchanged. |
| **PvP, if duels counted it** (30+, same B.2-shaped build awakened vs not, `pvp`) | 58 % for the awakened side (54–59 % by class) | 60 % (58–63 %) |
| **PvP, recommended** | **Duels ignore awakening** (`normaliseFighter` reads each item without it). Exactly 50 %, `PVP_RULES_VERSION` unchanged. | The same. |

**Does it widen the 30+ gap that B.5 must fix? Only if duels counted it.** Character Power barely sees awakening (+0.1 %), so matchmaking would pair an awakened kit with a plain one as equals, and the awakened side would win 58–60 % (63–65 % at × 1.25 or a full affix). Class pairs would move up to 7 points (warrior–warlock 0.79 → 0.72 under (a), mage–hunter 0.45 → 0.40). That would add to B.5's 95 %+ favourites rather than help. With duels ignoring it, the 30+ population is exactly as it is. "PvP stays separate" (Phase 6 ground rules): PvE numbers never change for PvP, and PvP doesn't take on a PvE grind.

## 6. Risks

- **Power creep.** It is limited to a whole kit's +3–10 % at bosses and 0–2 % farming, about Void's size (Void over plain: 1–7 %). The effect caps bound (b), and a 2× strength ceiling is enforced by the reader. The tuning tables below show how quickly larger numbers break the exit criterion.
- **Older drops made irrelevant (the Phase 6 exit criterion).** At × 1.1, an awakened Verge kit is level with plain Depths gear, and a single awakened older piece always loses its slot to a newer drop. When later content adds item levels above 41, an awakened Depths piece will lose to them the same way, and that is intended: awakening is not a reason to stop looting. Older content gains uses: crypt hoards give the Seals, and Pass/Warden/Heroic set pieces become awakening targets.
- **Whales and casuals.** Embers and Seals are untradeable and bound to the hero's hoard cooldowns, so gold can't buy speed. Gold is not the gate (4–9 hours of income). The gap is play time only: dedicated players get a full kit 4× sooner than casual ones, and it is worth 3–10 % at bosses. A casual hero's first awakening (12 days) already gives the best single piece. **(b) rewards optimised builds more than ordinary ones**: top B.2 builds gain 3–10 % at bosses, while a realistic kit of random-effect Verge Legendaries gains 1–3 % farming (Tyrant win rates unchanged at 100 %, mage 73 → 83 % at 38). Option (a) is the reverse (+7–13 % for realistic kits), which is why it creeps more for the median player.
- **Class spread** (B.5 already has the mage's Tyrant and the Heroic issues). Full-kit gains at the Tyrant are warrior 6.7, mage 9.5, hunter 4.8 and warlock 5.6 % (option a: 4.8 / 8.2 / 3.5 / 7.1). The spread is under 5 points either way (asserted under 8). The mage, the class with the weakest Tyrant win rate, gains the most. The hunter, already the strongest farmer, gains the least. Neither widens B.5's issues. B.5 should still re-measure with awakening on if 6.5b ships first.
- **Wasted resources.** An effect at its cap, or one that does nothing for the build (a Bramblemail chest on a glass-cannon build), gains nothing from (b). 6.5b's quote must show the before/after numbers before payment.
- **Lock-in feeling.** A permanent 3-day investment may make players reluctant to replace the item. The per-slot numbers show that replacing it is still right, and the tooltip should say so.

## 7. Measurements

The tool is `tools/balance/awakening.ts` (modes `builds`, `items`, `older`, `power`, `pvp`, `time`, `realistic`; env `STRENGTH`, `SHARE`). Guards are in `packages/game-core/src/balance/awakening-balance.test.ts`. All measurements are game-core on pinned seeds; nothing touches the server. **Baseline:** B.2's build search per class and job, with every piece at +10 Void and again with every piece at +10 Prismatic. The better of the two is "the best Void/Prismatic +10 kit". **Awakened:** the same searches with every piece awakened (each search picks the build that suits the awakening). The jobs are farming the Ashen Pass at 26 (item level 25) and the Cinder Depths at 37 (36), and the Ashen Warden at 28 (27), the Forge Tyrant at 38 (37) and the Heroic crypt at 34 (33) as boss time over 12 runs. Note that B.2's top builds kill these bosses in 8–11 s, so the boss percentages are about the very top of the game.

### Before and after: best kit vs a whole awakened kit (recommended tuning)

Gain over the best +10 Void/Prismatic kit (kills per minute; boss: faster kill). In brackets: best Prismatic ÷ best Void, both awakened.

| Job (baseline) | Warrior | Mage | Hunter | Warlock |
|---|---|---|---|---|
| Pass farming (22.4 · 20.3 · 22.6 · 20.3 /min) | (b) +1.7 % (+0.6) · (a) 0.0 % | +0.2 % (+0.7) · 0.0 % | +1.6 % (−0.7) · +1.1 % | +1.5 % (+0.7) · +0.9 % |
| Depths farming (17.1 · 16.3 · 19.0 · 16.3 /min) | +2.0 % (0.0) · +2.8 % | +1.2 % (+0.6) · +1.5 % | +1.2 % (0.0) · +1.2 % | +1.5 % (+0.3) · +2.0 % |
| Ashen Warden (9.7 · 8.7 · 8.5 · 10.6 s) | +8.4 % (+1.2) · +8.9 % | +5.1 % (+1.2) · +4.5 % | +4.4 % (+1.7) · +3.5 % | +6.3 % (+1.5) · +7.8 % |
| Forge Tyrant (9.8 · 9.3 · 8.4 · 11.2 s) | +6.7 % (+2.5) · +4.8 % | +9.5 % (+1.2) · +8.2 % | +4.8 % (+2.6) · +3.5 % | +5.6 % (+2.2) · +7.1 % |
| Heroic crypt (10.9 · 9.2 · 9.6 · 11.4 s) | +7.7 % (+2.6) · +8.3 % | +6.9 % (−0.9) · +4.5 % | +7.5 % (+2.6) · +5.8 % | +3.2 % (+0.6) · +7.9 % |

The Pass is near its farming breakpoint for these builds, so neither option moves it much.

### One piece at a time (recommended tuning, the best kit's build)

| Job | Mean gain per piece, (b) · (a) | Best single piece, (b) · (a) |
|---|---|---|
| Depths farming | +0.1–0.2 % · 0.0–0.3 % | +0.4–0.6 % · up to +1.5 % (weapon) |
| Ashen Warden | +0.1–0.8 % · +0.3–1.2 % | +0.4–2.7 % · +1.3–4.9 % |
| Forge Tyrant | +0.1–0.7 % · +0.6–1.1 % | +0.5–2.7 % · +2.3–4.5 % |
| Heroic crypt | 0.0–0.6 % · +0.1–0.7 % | 0.0–1.6 % · +0.5–2.7 % |

(b)'s best piece is the one carrying the build's key effect (a weapon's Mana Surge or Emberbrand) or a ring; (a)'s is the weapon, through raw damage.

### Older gear stays behind newer gear

The best item-level-33 build (Verge drops) against the same build at item level 39 (Depths drops), both +10 Void. Negative means newer plain gear is still better.

| Class | Plain il 33 | il 33 awakened (b) · (a) | One awakened il-33 weapon in an il-39 kit, (b) · (a) |
|---|---|---|---|
| Depths farming at 39: warrior | −1.8 % | −0.6 % · −0.1 % | −1.5 % · −1.5 % |
| mage | −2.2 % | +0.3 % · −0.5 % | −1.9 % · −0.8 % |
| hunter | −2.1 % | +0.1 % · 0.0 % | −1.7 % · −0.5 % |
| warlock | −3.6 % | −1.7 % · 0.0 % | −3.1 % · −1.7 % |
| Forge Tyrant at 38: warrior | −8.1 % | +0.6 % · 0.0 % | −6.6 % · −3.4 % |
| mage | −8.6 % | 0.0 % · −0.7 % | −6.1 % · −6.1 % |
| hunter | −9.0 % | 0.0 % · 0.0 % | −5.0 % · −3.4 % |
| warlock | −5.3 % | −3.8 % · −2.2 % | −4.8 % · −4.3 % |

**Level 28 and 34 content:** a level-28 hero in good Ashen Pass gear can't get Embers (the Tyrant is level 36), so nothing changes for it. Its Pass farming would gain at most 1.7 % if it could. A level-34 hero in Verge gear farms the Depths as before (6.2's checks are unchanged), and awakening it later adds 1–2 %. **Phase 1–5 drops:** below item level 23 nothing is eligible and nothing changes. Their uses stay (salvage, sets, Forge inputs), and crypt hoards gain one (the Seal).

### Realistic kit (not optimised)

A +10 kit of Verge Legendaries with random effects and affixes (item level 33, `realistic`). (b) at × 1.1, (a) at half an affix:

| Class | Depths kills/min: plain · (b) · (a) | Tyrant at 38: plain · (b) · (a) | Heroic at 32 |
|---|---|---|---|
| Warrior | 7.88 · 8.07 (+2.4 %) · 8.93 (+13 %) | 100 % all | 100 % all |
| Mage | 6.63 · 6.72 (+1.4 %) · 7.15 (+8 %) | 73 % · 83 % · 94 % | 79 % · 79 % · 96 % |
| Hunter | 11.65 · 11.97 (+2.7 %) · 12.57 (+8 %) | 100 % all | 100 % all |
| Warlock | 7.40 · 7.55 (+2.0 %) · 8.15 (+10 %) | 100 % all | 100 % all |

### Tuning: why × 1.1 and half an affix

| Setting | Whole awakened kit at the Tyrant | Depths farming | Awakened il 33 vs plain il 39 at the Tyrant | PvP if counted |
|---|---|---|---|---|
| (b) × 1.25 | +11.4–22.2 % | +3.1–5.3 % | **+4.2–10.3 % (fails)** | 63 % |
| (b) × 1.15 | +6.0–13.6 % | +1.7–3.1 % | **+1.1–4.3 % (fails)** | – |
| **(b) × 1.1** | **+4.8–9.5 %** | **+1.2–2.0 %** | **−3.8 … +0.6 %** | 58 % |
| (a) a full affix | +6.0–16.1 % | +2.6–4.5 % | **+1.8–6.5 % (fails)** | 65 % |
| (a) ¾ of an affix | +4.8–13.3 % | +2.0–3.5 % | **+0.7–1.2 % (fails)** | – |
| **(a) half an affix** | **+3.5–8.2 %** | **+1.2–2.8 %** | **−2.2 … 0 %** | 60 % |

## 8. Recommendation

**Ship option (b), the Awakened effect, at × 1.1, as specified above. Build it in 6.5b only after the owner's yes.**

- It meets the exit criterion: an awakened kit is no better than the next area's plain drops (−3.8 to +0.6 %), a single awakened older piece always loses its slot (−0.5 to −6.6 %), and Phase 1–5 drops are untouched or gain a use.
- It adds a choice: which effect or set to commit to, which pieces first, and Embers spent on awakening or on Tyrantforged Work. It does this without becoming mandatory (one piece is +0.1–0.8 %, a whole kit +3–10 % at bosses).
- It is the smallest change to the rules: one existing mechanism (effect strength, as Void uses it), with no change to the affix model, validation of affixes, Gear Score, Power or PvP rules.
- Its cost is time-gated (3 Embers, one hoard a day), so it can't be bought and it gives the Tyrant and the crypt hoards a lasting use.

**Not option (a)** (runner-up), because it is a bigger step for ordinary kits (+8–13 % farming), it duplicates the Forge's reroll, it shifts Void vs Prismatic, and it needs a Gear Score version and changes to `validateItem`, the Forge and the loot filter.

**If the owner prefers not to add power at all:** ship (c) alone (the mark, no stats), or don't ship. Both are consistent with the GDD, which calls awakening optional.

### Scope for 6.5b (only after the owner's yes)
- Server: an item column (migration), `validateItem` and the Forge's `POST …/forge/awaken` (Idempotency-Key, character → item locks, refusals before payment, the hold, `forge.awaken` audit), trade-rule refusal, and telemetry (`forge.awaken`, Embers and Seals spent per source).
- game-core: turn the prototype into the rule (the stored awakening → `effectStrength`), with PvP normalisation ignoring awakening and a pinned duel unchanged.
- Web: the Forge's awaken panel with a before/after quote (caps, set progress "2 of 4 awakened"), the tooltip line and mark (an art/code treatment like A.12, no new sprites needed), and the loot filter protecting awakened items.
- Tests: refusals, idempotency and races (awaken vs sell, awaken vs trade), the no-effects hashes, the balance guards here re-run on the built rule, and a journey step. Patch notes for the next 0.6.x.

## 9. Owner questions

1. **Ship it?** Option (b), "the item's effect gets 10 % stronger, permanently, for 3 Tyrant's Embers, 2 Gravewarden's Seals, about 25,000 gold and 30 soul shards", or option (a), the cosmetic-only version (c), or not at all?
2. **The size:** is × 1.1 enough to feel worth 3 days of Tyrant runs? Anything stronger (× 1.15 and up) lets an awakened older kit beat newer drops.
3. **The price:** 3 Embers per item means a whole kit takes about one season for a dedicated player and two to four for others. Faster (2 Embers), or slower?
4. **The Seal:** should the second material be the Gravewarden's Seal from any crypt tier (as proposed), or only from the Heroic crypt (a new "Heroic Seal", which needs an icon)?
5. **PvP:** confirm that duels ignore awakening (recommended; otherwise an awakened kit wins about 58 % against an equal one and the 30+ matchmaking can't see it).
6. **The shelf:** may an awakened item move between the account's own heroes via the shelf (proposed: yes, it is account-bound), or should it stay with the hero that awakened it?

## 10. Prototype (game-core, switched off)

- `items/awakening.ts`: `AwakeningSettings` (the typed switch `enabled`, default **false**, frozen; `option`, rarities, +10, item level 23, `effectStrength` 1.1, `affixValueShare` 0.5, the cost), `awakeningRefusal`, `awakeningCost`, `awakenedAffix`, `awakenItem` (pure; refuses everything with `disabled` while off) and `evaluationSettings` (switch on, for tests and `tools/balance/` only). It is not exported from the package index, and no server, web or settings code imports it.
- `items/awakening-state.ts`: the `ItemAwakening` shape and the reader `awakenedEffectStrength`, read in two places: `itemEffectInstances` (an item's effect strength = variant strength × awakening) and `setBonusInstances` (a bonus of n pieces gets the strength once n distinct worn pieces are awakened). Without an awakening, both return exactly the pre-6.5 instance (no `strength` field), so every existing number is unchanged. No column, row, snapshot or route carries the field.
- **Invariance:** `effects/noEffects.test.ts` reruns the pinned pre-3.2 hashes with `awakening: null`, with every item offered to the switched-off prototype, and with neutral awakenings. A late-game kit (+10 Void Legendaries and four Drowned Vigil pieces, item level 37) gives the same Depths settlement, Forge Tyrant run and Power when offered to the switched-off prototype, and different ones with the switch on (the check can fail). Every existing balance suite and curve pin is unchanged.
- **Tests:** `items/awakening.test.ts` (the switch, eligibility, costs, both options' math, sets, readers ignoring invalid strengths) and `balance/awakening-balance.test.ts` (the guards above, about 4 s).

## As built (ticket 6.5b)

### The owner's answers (2026-11-10)
1. **Ship (b) at × 1.1.** A +10 Legendary, Mythic or set item at item level ≥ 23 can be awakened once; its effect or signature counts × 1.1, set bonuses as in "Options (b)". Permanent.
2. **The price as proposed:** 3 Tyrant's Embers, 2 Gravewarden's Seals (any crypt tier), 15,000 gold at item level 20 scaled by `(itemLevel + 5) / 25` (25,200 at 37) and 30 soul shards (`DEFAULT_AWAKENING_SETTINGS.cost`, data).
3. **Awakening counts in PvP and in matchmaking** (overrides question 5): duels read the awakened effect through the normal normalisation, and matchmaking's bracket Power sees it (below).
4. **Account-bound, never tradeable;** not while held after a trade; **may move between the account's own heroes via the shelf.**
5. **Boards:** Gear Score unchanged; Power only through combat; no new version.

### game-core
- **The switch is gone** (decision: an admin kill switch adds a settings surface for a rule with no live risk the trading switches don't already cover; removing a shipped awakening would also strand paid items). `DEFAULT_AWAKENING_SETTINGS` (frozen) holds the numbers: option `effect`, rarities Legendary/Mythic, +10, item level 23, `effectStrength` 1.1, the cost. `awakenItem` / `awakeningRefusal` are the rule (`rarity`, `upgrade_level`, `item_level`, `already_awakened`, `nothing_to_awaken`, `unknown_base`); `shippedAwakening()` is what is stored: `{ option: 'effect', effectStrength: 1.1 }`. Option (a) stays in the module for `tools/balance/awakening.ts` only.
- **Validation:** `GeneratedItem.awakening` (never rolled). `validateItem` accepts only the shipped awakening on an eligible item (`awakeningErrors`: exact shape and strength, rarity, item level, an effect or a set); scoring's `checkEquipment` also rejects one below +10 (`invalid_item`, counts 0), so a forged row or snapshot never fights awakened.
- **Readers** (6.5's, unchanged): `itemEffectInstances` (variant × awakening: Void × 1.21, Prismatic × 1.1) and `setBonusInstances` (a bonus of n pieces is awakened once n distinct worn pieces are). Caps, thresholds and stack counts as before.
- **Quote:** `awakeningPreview(item, rest of the kit, class)`: the effect text before and after, a set's progress (worn, awakened before and after, each bonus), and the capped combat numbers that move (empty: an effect at its cap, another class's effect, or a set bonus still short of awakened pieces).
- **Binding and trading:** `itemBindingState` returns `account` / `awakened` first; the trade rules add the check `item_awakened` ("Awakened items can never be traded.") next to `item_bound`, so no future switch can open it.
- **Forge interactions:** rerolls and improvements stay allowed (they never touch the effect); upgrades stop at +10 as before; the awakening survives every Forge action. Void and Prismatic are untouched.

### Server
- **Migration `0040_item_awakening`** (additive): `item_instances.awakening` (jsonb, null) and `awakened_at` (timestamptz), check: both null or both set.
- **`POST /api/characters/:id/forge/awaken`** `{ itemId }`, `Idempotency-Key`, the Forge's lock order (key → hero, settling first → item). Refused before paying: another hero's item `404`; Warehouse `item_in_warehouse`, shelf `item_on_shelf`, escrow `item_in_offer`, held after a trade `409 item_held`; the rule's refusals `422 not_awakenable` / `already_awakened` with a plain message; the price with what is missing (`insufficient_materials` / `insufficient_gold`, **gold and materials on hold after a trade excluded**, `heldValueOf`). Pays, writes the awakening and the time, advances the forge counter (no draw; the counter guards the write and marks the item "touched" for a reversal), binds to the account, audits `forge.awaken` (gold, materials, the awakening, effect/set, variant, upgrade) and records telemetry (`forge` `awaken`, `gold.out` / `material.out` source `forge_awaken`). `reconcileWithAudit` checks count, gold and materials.
- The Forge item view has `awaken: { refusal, cost, blockers, effectStrength } | null`; item views (pack, profile showcase) carry `awakening` and `awakenedAt` when set; every combat read (farming, crypt and Tyrant snapshots, guild boss, scores, arena) carries the column.
- **Admin (D.4):** the grant tool's `awakened: true` (test accounts) creates an item the Forge could awaken, refused in the Forge's words otherwise.

### Web
- The Forge's **"The Banked Fire"** panel: items ready to awaken and those awakened, the price from the server, the before/after quote and set progress from `awakeningPreview`, a warning when nothing would change, a full confirm (permanent, the price, bound for good, shelf allowed, Forge afterwards). Loading, empty, error and success states; desktop and mobile.
- **The awakened mark** (a code treatment like A.12): an ember sigil ☼ in the lower left corner (beside Void's ◇ or Prismatic's ✧), a coal line with ember pixels along the socket's base and a low ember glow behind the art (tokens `--ember-core/glow/coal`, not the Legendary orange). The glow breathes in four steps over 4.8 s; still under reduced motion and automation, forced in the admin gallery after Play. The tooltip says "☼ Awakened … Permanent." and the binding line; its header rule smoulders. The admin gallery's Variants table has awakened rows.

### PvP and matchmaking (owner decision 3)
- **Duels:** no duel rule changed. `normaliseFighter` reads `equipmentModifiers` and `setBonusInstances`, which read the awakening, and pulls the effects toward the reference with `effectKeep` like any gear. `PVP_RULES_VERSION` stays 2 (the same input fights the same; the pinned duel hashes pass).
- **Matchmaking:** Character Power barely sees awakening (it is a PvE measure), so **bracket Power 2** (`BRACKET_POWER_VERSION` 1 → 2) = Power 1 × (1 + 0.002 × the awakened effects a duel reads). Equal to version 1 on every kit without an awakening, so every stored defence keeps its value (a stored version-1 value is reused when its snapshot has no awakening). `MATCHMAKING_VERSION` stays 3. Details and measurements: docs/PVP.md "6.5b".
- **Ticket B.5:** in 30+ bracket Power 3 is duel Power, which reads the awakening through the duel's own normalisation (no factor on top); 30+'s 90 %+ favourites with every +10 Void kit awakened 14.5 % → 2.5 %. The awakening economy re-measured (Embers bind: 3 days an item, 24–27 days a kit for a dedicated player, about a season from its start): no change (`docs/BALANCE.md` "B.5", items 1 and 8).

### Tests and tools
`items/awakening-rule.test.ts`, `balance/awakening-pvp.test.ts` (duels, bracket Power, the bands with an awakened population), `forge/awaken.test.ts`, `forge/awaken.pg.test.ts` (awaken vs a shelf deposit, vs a trade offer, double submit; looped 20×), `e2e/awakening-journey.test.ts`, the admin grant, the web's `components/awakened.test.tsx`. Tools: `tools/balance/awakening.ts match`, `tools/balance/arena.ts` with `AWAKENED=1 POWER=1|2`, screenshots `tools/screenshots/awakening.mjs`.

## 6.5c: awakening locks the item (owner decision, 2026-11-10)
The owner's answer to 6.5b's question 2: an awakening **locks its item** (the 3.7 item lock), in the awaken transaction, audited as `item.lock` with `via: 'awaken'` (no row when it was already locked; manual locks stay unaudited). A locked item can't be sold, salvaged or discarded (`409 item_locked`); the loot filter only ever sees new drops, so it never reaches one. The player can unlock it in the Pack like any lock; the awakening stays. Items awakened under 0.6.9 are locked once by the `awaken-lock:6.5c` data step in the server after start-up (idempotent; `docs/DEPLOY.md` "Data backfills"). The Banked Fire's confirm says: "The item will be locked; unlock it in the Pack if you ever want to sell it."
