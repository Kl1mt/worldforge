# WORLDFORGE — GAME DESIGN DOCUMENT
**Version 0.3 | November 4, 2026**  
**Browser-first • Desktop companion • Mobile-ready architecture**  
**Persistent dark-fantasy idle RPG with loot-driven progression and social competition**

## Document Purpose
This document defines the current product vision, core systems, visual direction, and phased development plan for **Worldforge**. It is intended to be the high-level source of truth for design discussions and context for an AI coding assistant such as Claude Code.

**Development must be split into explicit phases and small implementation tickets.** Claude Code must not attempt to implement the entire game in one pass. Each ticket needs a defined scope, acceptance criteria, tests, and a review checkpoint. Keep a working build at the end of every phase.

Status convention: established directions are stated as requirements; proposals and unresolved decisions are labelled as such. Example values are illustrative, not final balance values.

## 1. High-Level Vision

### 1.1 Game Concept
Worldforge is a persistent, browser-based dark-fantasy idle RPG with a Diablo-inspired loot hunt, fully automatic combat, meaningful character builds, and a world that develops through the combined activity of its players.

Players create characters, choose a class, select an area or activity, and let their characters fight automatically. They earn experience, gold, materials, and equipment. Active play provides additional efficiency and access to activities such as dungeons, bosses, events, group play, and social competition. Offline progress remains useful and never makes absence feel like punishment.

### 1.2 Design Pillars
- **Loot is the long-term hook.** Drops should create excitement. Rare items, affix combinations, unique effects, sets, and special variants provide long-term goals.
- **Build variety matters.** Different combinations should be viable. New items should create choices, not simply replace everything with larger numbers.
- **Idle without punishment.** Offline progress is meaningful. Active play is more efficient and offers additional activities, but absence does not erase progress.
- **A shared persistent world.** Community contributions unlock and improve locations, buildings, and global content.
- **Social competition is optional.** Leaderboards and small PvP modes let players compare builds without making PvP mandatory for progression.
- **Distinctive handcrafted presentation.** The UI and pixel-art direction must feel authored and cohesive, not like a generic AI-generated dashboard.

### 1.3 Target Player Experience
A short session should offer clear actions: collect results, inspect loot, improve a build, and choose another activity. A longer session should offer active goals such as dungeons, bosses, events, crafting, group play, and PvP. Returning after time away should feel rewarding through a clear offline report. Finding an exceptional item should be memorable and create a meaningful build decision.

## 2. Platforms and Product Strategy
| Platform | Priority | Approach |
|---|---|---|
| Web browser | Phase 1 / primary | First playable release; no installation required; account-based server saves. |
| Desktop | Later phase | Package the same web client using Tauri or Electron, subject to technical evaluation. |
| iOS and Android | Long-term | Later port using responsive layouts, touch-friendly interactions, and shared backend services. |

The first release is browser-first. The architecture should avoid locking gameplay logic to a desktop-only input model or fixed screen size. Mobile is not part of the initial delivery scope, but should remain feasible without rewriting the game.

### 2.1 Cross-Platform Requirements
- Separate gameplay rules from UI rendering and input handling.
- Use responsive layouts and scalable UI components from the beginning.
- Support mouse, keyboard navigation where useful, and touch-sized controls for future mobile use.
- Store authoritative account and character state on the server.
- Synchronize progress across devices through the same account.
- Do not rely on browser-local storage as the sole source of truth.

## 3. Art Direction and UI/UX

### 3.1 Visual Identity
Worldforge uses **2D pixel art** and a dark-fantasy visual language. The target mood is weathered, mysterious, atmospheric, and grounded. Diablo is a reference for mood and loot presentation, not a template to copy.

- Use deliberate pixel-art scale, limited palettes, readable silhouettes, and consistent lighting.
- Prefer authored illustrations and custom UI assets over generic stock-looking gradients and icon packs.
- Use static character and environment illustrations initially; elaborate character animation is not required for the core experience.
- Item icons may be small pixel-art assets. Special variants can reuse base item art with shader or overlay treatments.

### 3.2 Avoiding a Generic AI-Generated UI
The UI is a major quality requirement, not a final polish task. Avoid the familiar generic dashboard look: excessive rounded cards, arbitrary gradients, repeated glow effects, oversized empty panels, generic iconography, and identical layouts for every screen.

- Create a distinct visual language for inventory, character, forge, map, quests, and social screens.
- Use framed panels, restrained ornamentation, textured surfaces, and intentional hierarchy inspired by fantasy artifacts and game interfaces.
- Establish a compact design system: color tokens, typography, spacing, borders, panel treatments, buttons, tooltips, rarity colors, and responsive rules.
- Use decorative display typography sparingly; body text and numeric stats must remain highly readable.
- Reserve effects for meaningful events, such as a Mythic drop, rather than decorating every control.
- Avoid building every screen from the same generic card component. Reusable components should retain a coherent identity while allowing screen-specific layouts.

### 3.3 Suggested Palette
| Use | Direction |
|---|---|
| Main backgrounds | Charcoal, near-black, deep brown |
| Panels and frames | Weathered iron, dark wood, stone |
| Primary accent | Muted gold / aged brass |
| Secondary accent | Deep crimson |
| Magic accents | Violet and restrained blue |
| Nature accents | Dark, desaturated green |
| Item rarity | Consistent, clearly distinguishable rarity colors |

### 3.4 UI Quality Gate
Before expanding the UI across the game, create and review a polished visual slice containing the main navigation, character panel, inventory, item tooltip, and one area screen. Do not scale a weak visual direction across dozens of screens.

- Every screen must have a clear hierarchy and a reason for each panel.
- The UI must remain legible at common desktop widths and adapt to narrower screens.
- Pixel-art assets must use a consistent scale and visual treatment.
- Review screenshots at the end of each UI milestone.
- A screen is not done merely because it renders; it must meet the art-direction brief.

## 4. World, Setting, and Hub

### 4.1 World Premise
Worldforge takes place in a dark-fantasy world damaged by an unknown catastrophe. Regions are lost, settlements are weakened, and hostile forces occupy the land. Players begin in a frontier region and gradually help restore the world.

### 4.2 Central Hub
The hub is an illustrated, non-walkable town screen. Players select buildings from the interface rather than navigating a freely explorable environment.

| Building | Primary function |
|---|---|
| Forge | Upgrade equipment and, later, reroll or improve affixes. |
| Merchant | Buy and sell selected goods; economy functions to be balanced. |
| Tavern | Quests, contracts, and activity notices. |
| Guild Hall | Guilds: found one, join one, manage members and roles (ticket 4.4). |
| Warehouse | Storage per character (ticket 4.7, `docs/WAREHOUSE.md`), opened by the first community project; upgrades cost gold. Shared account storage is a possible later feature. |
| Summoning Shrine | Cosmetic-only draws, deferred until the core game works. |
| World Map | Choose regions, farming areas, dungeons, and other activities. |

### 4.3 Starting Region: Graumark
Graumark is an abandoned, gloomy borderland and the initial progression region.

| Area | Example enemies | Possible resources |
|---|---|---|
| Abandoned Fields | Undead farmers, wolves | Wood, herbs |
| Crowwood | Bandits, corrupted crows | Wood, leather |
| Old Burial Grounds | Skeletons, grave crawlers | Soul fragments |
| Blackwater | Cursed creatures | Herbs, ore |
| Sunken Abbey | Corrupted knights | Uncommon and rare materials |

First dungeon: **The Nameless Crypt**. First named boss: **The Gravewarden**. Names and content are working titles.

**Top end (ticket 4.8):** beyond Graumark's areas, **the Ashen Pass** (levels 24–28; ash wraiths, cinder hounds, pyre cultists, ember golems; iron ore and soul shards) is a global unlock (§12.2): closed for everyone until the community clears it. Its boss, **the Ashen Warden**, is fought alone at the top of the Warden's Watch. Details: `docs/WORLD.md`, `docs/DUNGEONS.md`.

## 5. Characters and Classes

### 5.1 Character Creation
Players create a character with a small set of cosmetic choices such as body presentation, face, hairstyle, and hair color. Character art is initially represented by complete static pixel-art images. Dynamic sprite layering and extensive animation are out of scope for the first version.

### 5.2 Starting Classes
| Class | Resource | Identity |
|---|---|---|
| Warrior | Rage | Physical melee damage and forceful attacks. |
| Mage | Mana | Elemental and arcane magic. |
| Hunter | Focus | Ranged attacks, speed, and critical-hit interactions. |
| Warlock | Soul Fragments | Shadow magic and damage-over-time effects. |

The class is selected permanently at character creation. Classes differ through weapon restrictions, resource mechanics, skills, passive effects, and build synergies. There are no mandatory tank/healer/DPS party roles; each class is designed around its own damage and progression identity.

### 5.3 Character and Account Progression
| Character-bound | Account-bound |
|---|---|
| Level and experience | Cosmetics |
| Class and skills | Character slot unlocks |
| Equipment and build | Achievements |
| Character attributes | Global world contribution / unlocks |
| Personal activity progress | Potential shared storage |

The initial account has **two character slots**. Additional slots may later be earned through achievements, gameplay, or community projects (ROADMAP 9.4), and may also be bought in the later shop (owner decision 2026-11-12, ROADMAP 8.8). **Ticket 9.4 (owner defaults, 2026-11-13):** a 3rd slot when any hero of the account reaches level 28, a 4th when a hero clears the Heroic crypt, a 5th from the town's next community project (a seam until that project exists). Account-bound, never removed; each grant records its source (`docs/ACCOUNTS.md`). Monetization, if ever introduced, must not create competitive pay-to-win advantages.

## 6. Combat and Activities

### 6.1 Automatic Combat
Combat is fully automatic. The player chooses an area or activity and the character fights according to stats, equipment, skills, enemy rules, and controlled randomness. The player does not manually trigger skills during each fight.

### 6.2 Core Stats
| Stat | Purpose |
|---|---|
| Health | How much damage the character can survive. |
| Physical Damage | Base physical damage output. |
| Magic Damage | Base magical damage output. |
| Attack Speed | Frequency of attacks. |
| Critical Chance / Damage | Chance and multiplier for critical hits. |
| Armor | Mitigation against applicable physical damage. |
| Resistances | Mitigation against elemental or other damage types. |

Additional modifiers may include boss damage, experience gain, gold find, item find, resource yield, and class-specific stats. These need caps or diminishing returns where necessary.

### 6.3 Skills and Builds
Each class has skills that execute automatically during combat and passive effects. Players choose a loadout outside combat. Skills may provide single-target damage, area damage, damage over time, defensive utility, or synergies with specific stats and item effects. New skills unlock through level progression and later content.

*Phase 9 defaults (owner-approved 2026-11-13; design and prototype in `docs/SKILLS.md`, ticket 9.1; built in 9.2 after the owner's decisions):* each class has six active skills and four passives unlocked from level 1 to 36, plus two taught by later bosses (the Forge Tyrant, the Hollow Sovereign); a loadout holds three actives (slot 1 the class skill on its cadence, slots 2–3 resource spenders) and one passive, with three presets per hero, switched outside combat (the activity settles first). The default loadout is today's class skill alone and fights exactly as before. Damage over time is the Warlock's identity, with one burn for the Mage and one bleed for the Hunter. Area damage has no target in one-on-one fights and is not used.

### 6.4 Activity Types
- **Area farming:** repeatable automatic combat and baseline progression.
- **Quests and contracts:** structured objectives with targeted rewards.
- **Dungeons:** multi-stage activities with special loot tables and bosses.
- **Boss encounters:** focused challenges with unique materials or item drops.
- **Events:** limited-time or community activities, introduced after the core loop is stable.

## 7. Loot and Equipment

### 7.1 Equipment Slots
**Decided (v0.3): 12 equipment slots** — head, shoulders, chest, hands, legs, feet, neck, two rings, weapon, off-hand, and relic. Weapon and off-hand eligibility is class-dependent. Most armor and jewelry should remain broadly usable to avoid unnecessary item proliferation.

### 7.2 Rarity
| Rarity | Color convention | Role |
|---|---|---|
| Common | Grey | Basic gear and early progression. |
| Uncommon | Green | A modest upgrade over basic equipment. |
| Rare | Blue | Useful combinations of stats and affixes. |
| Epic | Purple | Less frequent gear with stronger potential. |
| Legendary | Orange | Rare, build-defining unique effects. |
| Mythic | Red | Extremely rare long-term chase items. |

Legendary items should be rare but realistically obtainable through sustained play. Mythic items should remain exceptional. Drop rates are not fixed in this document.

### 7.3 Affixes
Affixes are randomized modifiers that make items differ from one another. Examples include physical damage, magic damage, attack speed, critical chance, critical damage, boss damage, health, armor, resistances, gold find, experience gain, and resource or item find. Affix pools should be controlled by item type, class compatibility, item level, and content tier. Avoid overwhelming players with too many stats at once.

### 7.4 Legendary and Set Effects
Legendary effects should change or reinforce play patterns rather than only increase a number. Examples include bonus fire damage on critical hits or increased damage against low-health enemies.

Set items are intended as a late-game progression layer. Equipping a required number of pieces activates set bonuses. A Void version of a set piece counts as the same piece for set activation; players do not need a full Void set.

**Decided (ticket 3.3):** three sets — the Drowned Vigil (martial, 6 pieces), the Ashen Choir (arcane, 6) and the Bloodmoon Hunt (hybrid, 4) — on armor and jewelry slots every class can wear, with bonuses at 2, 4 and 6 distinct pieces. A set piece is a Legendary-rarity named item without its own effect; half of the Legendary rolls in the Sunken Abbey, the Nameless Crypt and the Gravewarden's hoard become set pieces. Details: `docs/EFFECTS.md`.

### 7.5 Special Variants
Variants are modifiers layered on top of an item's rarity and identity, not separate rarity tiers. **Void is initially restricted to Legendary, Mythic, and Set items.** Prismatic and other variants may be introduced later.

- Variants may provide a small stat bonus and a distinctive visual treatment.
- Some exceptionally rare combinations may modify a Legendary effect, but this should be used sparingly and carefully balanced.
- The same base item art should be reusable with shader, palette, or overlay treatments where possible.
- Variant discovery chance may improve through long-term gameplay progression, with strict caps to preserve rarity.
- Direct paid boosts to competitive drop chances are not part of the design.

**Decided (ticket 3.5):** only Void, on Legendary and Mythic items (set pieces included), one variant per item. Bonus: +10 % base values and × 1.1 on the item's own effect magnitudes. It drops only in late-game sources (Sunken Abbey, Nameless Crypt, Gravewarden), 10 % of their Legendary/Mythic/set rolls, hard-capped at 15 % in config: about one Void item per 50 h of Abbey farming. Forge work never adds or removes it. Visual: a drained, voidlight-edged overlay on the existing icon. No discovery-progression hook yet. Details: `docs/EFFECTS.md`.

**Decided (ticket 6.4):** Prismatic, the second variant, on Legendary, Mythic and set items, rarer than Void and **never with it** (one variant per item; a Void-Prismatic item does not exist in this phase). A different stat shape, not more power: base values and the effect stay as on the plain item and the item's combat affixes count × 1.1 (not critical chance, never find affixes), so a piece with the affixes a build wants is better Prismatic and a base-heavy or effect piece is better Void; the best Prismatic build is within 5 % of the best Void build in farming and at bosses. It drops only in Ashen-tier and newer content (the Pass and the Watch, the Verge, the Depths and the Tyrant's Forge, the Heroic crypt): 5 % of the Legendary/Mythic/set rolls that did not become Void (7.5 % Heroic), hard-capped at 7.5 %, about 0.45 × Void's rate. Gear Score counts it like Void; tradeable only behind its own switch, off by default. Visual: A.12. Details: `docs/EFFECTS.md`.

Long-term combinations such as a Void-Prismatic Legendary weapon are possible aspirational drops, but stacking rules and probability need explicit balancing before implementation.

## 8. Item Improvement and Crafting

### 8.1 Moderate Upgrade Model
The intended starting direction is a moderate system, not a full crafting simulator. Three independent improvement paths are planned, introduced gradually:
- **Item upgrade:** a bounded enhancement track, provisionally +0 to +10, that increases base values such as damage or armor.
- **Affix reroll:** replace one selected affix while preserving the others, subject to material and gold costs. Exact targeting rules may expand in later progression.
- **Affix improvement:** incrementally improve an existing affix within a defined cap.

Upgrade failure must not destroy an item. Avoid punitive systems that erase long-term player investment.

**Decided (ticket 3.4, owner-confirmed defaults):** upgrades run +0 to +10 and raise base values only (+50 % at +10). The success chance falls with the level (100 % → 20 %). A failure consumes that attempt's gold and materials but never destroys or downgrades the item, and a pity counter guarantees success after a set number of failures per step. Rerolls replace one picked affix from the slot's pool and cost more with each reroll of the same item. Improvement raises one affix toward its tier's maximum, at most three times. Every random forge outcome is fixed server-side per item (no save-scumming). Numbers: `docs/ECONOMY.md`.

### 8.2 Late-Game Item Awakening (Optional)
Item Awakening is a candidate endgame feature, not an MVP requirement. It could allow exceptionally valuable items to unlock an additional affix slot or a special effect after a demanding resource investment. Its purpose is to create a rare long-term project, not to make every item mandatory to awaken.

### 8.3 Preserve Build Variety
Items should not scale indefinitely. Strong items may remain useful for a meaningful period, especially in the late game, but new drops must remain exciting through different affix combinations, unique effects, and content-specific strengths. Balance should allow situational alternatives rather than a single permanent best-in-slot answer.

## 9. Online and Offline Progression

### 9.1 Offline Progress
When a player is away, the selected character continues to make progress in the selected farming activity. On return, the player receives a summary of earned experience, gold, resources, and eligible loot.

Offline progress is calculated or validated server-side. **Decided (v0.3): the offline accumulation cap starts at 3 hours** and is a configurable server value. The cap is raised through player progression. **Ticket 9.4 (owner default, 2026-11-13):** four account deeds (a hero at level 10, the Gravewarden defeated, crypt tier III cleared, the Ashen Warden slain) raise it 3 → 4 → 5 → 6 → 8 hours; each step counts from the moment it is earned and never pays back time already lost. The offline cap is never sold (`docs/ACCOUNTS.md`). Offline progress should be useful and predictable, not a punishment for absence.

### 9.2 Active Play Advantages
- Active sessions can be more efficient than offline farming.
- Dungeons, bosses, events, group activities, and PvP require or reward active participation.
- Active play may provide additional choices and targeted rewards rather than simply multiplying every reward without limit.
- The game should communicate clearly what continues offline and what requires an active session.

### 9.3 Server Authority
The server is authoritative for character state, combat outcomes, loot generation, currencies, upgrades, offline calculations, leaderboards, and PvP results. The client displays state and sends validated player actions; it must not be trusted to award itself items or currency.

## 10. Online Features, Leaderboards, and PvP

### 10.1 Social Online Features
Online features are part of the long-term vision. The game should be designed as an online service from the beginning, but social systems should be introduced only after account persistence, server-authoritative gameplay, and basic progression are reliable.

Potential features include public player profiles, selected achievements, friends and presence indicators, guilds and guild communication, global community progress, group activities, and carefully controlled trading. Moderation and abuse-prevention tools must accompany social features. Phase 4 default (ticket 4.1, owner-confirmed): the owner is the first admin, roles are granted only by a CLI command, and moderators work in a minimal in-app queue (`docs/SOCIAL.md`). Presence default (ticket 4.3, owner-confirmed): coarse buckets only (online now / today / this week / longer) from the last authenticated request, shown to friends (guildmates from 4.4), hideable by the player; no exact time ever leaves the server. Ticket 4.2 default: profiles are visible to every logged-in player unless the owner chooses "friends and guild" or "only me"; achievements are account-bound and cosmetic, and nothing is shown until the player picks it (up to five, plus an optional showcase of one hero's equipped gear). Guild default (ticket 4.4, owner-confirmed): founding a guild costs 5,000 gold from one of the founder's heroes (a sink), up to 30 members, one guild per account; roles are leader, officer and member, and a leader must hand over or disband before leaving. Communication default (ticket 4.5, owner-confirmed): guild chat is the only player-to-player communication in Phase 4 (no global chat, no direct messages); the leader and officers can pin a guild notice, officers strike members' lines, moderators hide any line, and a block hides each player's lines from the other. Group activity default (ticket 4.9, owner-confirmed): an asynchronous weekly guild boss, not real-time co-op; each account fights it three times a week with any hero (a server simulation from the hero's snapshot), the damage adds up for the guild it was fought for, five stages pay each participant a small capped reward (gold, materials, achievements), and the week turns on Monday 00:00 UTC (`docs/GUILD_BOSS.md`).

### 10.2 Leaderboards
Leaderboards allow players to compare progress and provide aspirational goals. Initial leaderboard concepts:

| Leaderboard | Possible ranking basis | Considerations |
|---|---|---|
| Character Level | Character level; experience within the level as tie-breaker. | Simple, but may favor time played. |
| Character Power | Server-calculated overall power metric. | Must be transparent and resistant to stat-inflation exploits. |
| Gear Score | Equipment quality and item-level-based score. | Measures gear progression, not the full strength of a build. |
| PvE Progress | Highest boss, dungeon tier, or region milestone cleared. | Rewards achievement and capability rather than only farming time. |

Keep **Character Power** and **Gear Score** distinct. Character Power can summarize a broader character snapshot; Gear Score should focus on equipped items. Publish the formula or explain the factors so players understand what is measured.

- Provide filters by season or all-time, class, and possibly level bracket.
- Use server-side snapshots and validation; never accept a client-submitted score as authoritative.
- Prevent score manipulation through item duplication, invalid stats, or altered clients.
- Consider separate leaderboards for each class where class balance makes direct comparisons misleading.
- Do not make leaderboard rewards so powerful that non-competitive players fall permanently behind.
- Prefer cosmetic rewards, titles, profile frames, or modest prestige rewards.

### 10.3 Small-Scale PvP
Small PvP encounters are a planned later feature. They should let players test builds and compare character development without turning Worldforge into a full action PvP game.

Because combat is automatic, PvP is based on character builds, stats, selected skills, and deterministic or seeded combat simulation. The player prepares a build and enters a match; the combat engine resolves the encounter.

**First candidate: asynchronous 1v1 arena challenges.** A player fights a saved defensive snapshot of another player's character. This avoids requiring both players to be online simultaneously and fits the idle-RPG format.

#### PvP Design Guardrails
- PvP is optional and is not required for core PvE progression.
- Use matchmaking brackets or rating bands to reduce unfair power gaps.
- Consider normalization or capped stat contribution if gear gaps make matches meaningless.
- Use a rating system for competitive ranking, separate from raw Character Power or Gear Score.
- Limit daily rewards or use diminishing returns to reduce farming and win-trading.
- Never remove equipment, currency, or character progress permanently after a PvP defeat.
- Provide clear combat logs so players can understand match outcomes.
- Keep PvP balance separate enough that changes do not destabilize PvE builds.

| Mode | Description | Priority |
|---|---|---|
| Async Duel | Challenge a saved defensive character snapshot; results resolve automatically. | First PvP candidate |
| Arena Rating | Seasonal rating ladder with matchmaking by rating and power range. | Later extension |
| Friendly Challenge | Challenge a friend or guild member without major progression rewards. | Optional extension |

The exact PvP format, rewards, matchmaking, and stat rules remain open design decisions. The first implementation should be small and testable.

**Decided (ticket 5.4, `docs/PVP.md`):** duels are fought within the leaderboard's level brackets (1–9, 10–19, 20–29, 30+). Inside a bracket every hero fights as a hero of its reference level, and keeps a quarter of what their gear (stats, Legendary effects, set bonuses) adds beyond a standard kit; armour and resistance count together, every blow has a ±25 % luck roll, friendly challenges may cross brackets (both fight in the lower hero's bracket), PvE-only modifiers (gold/item/XP find, boss damage) do nothing, and a duel lasts at most 60 s with sudden death from 30 s. The rules are versioned and kept apart from every PvE number.

**Decided (ticket 5.6, `docs/PVP.md` "Rating, matchmaking and the ladder"):** the arena rating is Glicko-2, **per hero and per season** (start 1500, deviation 350, volatility 0.06, τ 0.5; every rated duel is its own rating period, idle days widen the deviation); both the challenger's and the defender's rating move, a defence loss counting like any loss. A hero is provisional until 10 rated duels; a new season starts it halfway back to 1500. Matchmaking offers defences whose Character Power at the bracket's reference level is within 5 % (widening to 10 % and 20 % only when fewer than five players are that close, never further), closest in rating first. **Ticket B.4:** that Power is compared relative to the class (realistic warriors were weaker and warlocks stronger in duels than their Power says), and players not yet met this week come first. Against win-trading: the same two accounts within 7 days count 1, ½, ¼, then nothing (**ticket B.4b, owner decision:** from the fourth duel still ¼, never 0, and repeat pairs are never left out of the lists); friends, guildmates and accounts sharing a mailbox never meet in rated duels (friendly challenges stay open); moderators have a pattern report. The Arena Ladder is a season board with the 5.3 honours (title noun Duellist).

**Decided (ticket 5.5, `docs/PVP.md` "The arena"):** a hero saves a defence (a checked snapshot of its gear); rated duels from level 10, 10 a day (UTC day), against a short list of defences in the bracket that the server offers (never blocked or sanctioned accounts); friendly challenges with friends and guildmates resolve at once against the friend's saved defence (no send/accept), at any level and across brackets; every duel is stored with its server seed and both snapshots, and no duel changes anything a player owns.

## 11. Quests, Dungeons, Bosses, and Professions

### 11.1 Quests
Quests provide structured goals such as defeating a number of enemies, collecting resources, or clearing a named boss. Rewards may include experience, gold, materials, equipment, and cosmetics.

### 11.2 Dungeons and Bosses
Dungeons are distinct activities with multiple encounters, a boss, and focused reward tables. Bosses may drop unique items, special materials, or region progression resources. These activities provide active-play goals beyond repeatable area farming.

### 11.3 Professions
| Profession | Resource |
|---|---|
| Mining | Ore |
| Woodcutting | Wood |
| Herbalism | Herbs |
| Skinning | Leather |

Resources support upgrades, crafting, community projects, and quests. Professions should complement combat rather than become a separate mandatory full-time game.

## 12. Persistent Community World

### 12.1 Community Projects
Players contribute resources or other activity to shared projects, such as restoring a forge, building an outpost, repairing city defenses, or restoring a World Tree. Completion changes the shared world for everyone.

### 12.2 Global Unlocks
- New regions and farming areas.
- New hub buildings or upgraded building services.
- New enemy families, dungeons, and bosses.
- New profession resources and recipes.
- Community milestones and event objectives.

Contribution systems should avoid allowing a tiny number of high-power players to monopolize all meaningful progress. Individual contribution rewards can coexist with global milestones.

**Phase 4 defaults (ticket 4.6, `docs/COMMUNITY.md`; the owner can override):** projects are global and staged; each stage needs gold and materials given from a hero's holdings. One player may give at most 20 % of each need of a stage per day (UTC), so a stage takes at least five player-days. Contributors earn a cosmetic achievement, never power. The first project, *Restore the Graumark Warehouse*, opens the Warehouse for everyone; the second, *Clear the Ashen Pass*, begins after it and opens the Ashen Pass.

**Phase 6 defaults (ticket 6.6, `docs/EVENTS.md`; the owner can override):** rotating events are scheduled by the owner (admin panel or CLI), one at a time, for 1 hour to 4 weeks. Each has a world modifier (a modest bonus of one material for heroes who joined), a quest line in the Tavern paying tallies, and a cosmetic reward track per account; unfinished tasks lapse at the end and nothing earned is lost. The first is the *Harvest of Bones*.

**Phase 8 defaults (ticket 8.3, `docs/EVENTS.md`; the owner can override):** a second, longer event, *the Lantern Procession* (four weeks; a quest line that opens a week at a time, with a deeper road for heroes of level 28 and up; seven cosmetic keepsakes; a modest Iron Ore bonus for gathering), and an **automatic event calendar**: the owner sets a rotation, each event's length and the gap between events; the scheduler then puts the next event on when the last one closes. It starts paused, can be paused, skipped or overridden by hand (manual always wins), never runs two events at once, and ignores season boundaries (event rewards are not season-bound).

**Phase 6 defaults (ticket 6.7, `docs/COMMUNITY.md`, `docs/WORLD.md`; the owner can override):** the third project, *Rebuild the Forgeward Outpost*, follows the Ashen Pass (three stages, 300,000 gold and ten Tyrant's Embers in all, B.3's caps; **owner decision B.5b:** a tenth per player on a stage's first day, so ten givers, growing like the others). It opens a town upgrade (Tyrantforged Work 20 % cheaper in gold) and a world flag for later content, and gates nothing players can already reach. The town moves through **eras** (the Long Dusk, the Ashen Siege, the Rekindling, the Forgeward Age), one per completed project, shown in the town's light, banners, crier and Tavern; eras are cosmetic. Test accounts don't contribute.

## 13. Cosmetics and Monetization

### 13.1 Cosmetic Content
Cosmetics are separate from character power. Potential content includes full character skins, weapon skins, companions, pets, and visual effects. The initial art pipeline uses complete character images rather than dynamically assembled sprite layers.

**Phase 6 (ticket 6.6):** cosmetics earned in play (event titles, banner styles, title colours) are stored per account (`cosmetic_unlocks`), without stats; titles can be shown now, the rest once the collection book (6.8) opens. **Ticket 6.8:** the collection book holds hero appearances (palette swaps of every class), banner styles, crest styles, title colours and titles, each earned from one source (events, deeds, season honours, milestones such as level 40, the Forge Tyrant, the Heroic crypt, or helping rebuild the Forgeward Outpost); account-bound, not tradeable, no stats (`docs/COSMETICS.md`).

### 13.2 Cosmetic Reward Shrine
A cosmetic-only draw system is a possible later feature. A daily free draw was proposed, with a non-expiring claim opportunity so missing a day does not destroy the reward. Additional attempts could be earned through gameplay. No gameplay power should be attached to cosmetic draws.

### 13.3 Monetization Principles
- Do not monetize core power progression in a pay-to-win manner.
- Do not sell direct competitive drop-rate advantages.
- Defer monetization until the core game is fun, stable, and has a clear content cadence.
- **Owner decision (2026-11-11):** a cosmetic shop where cosmetics can also be bought for real money is planned for later (ROADMAP 8.8). Cosmetics only: never stats, power, drop odds or competitive advantage.
- **Owner decision (2026-11-12):** the shop may later also sell extra character slots (beyond the earned ones) and Shrine draws, and everything stays earnable in play. Paid random draws need the legal review below first. Offline hours, power, stats and drop odds are never sold.
- If randomized paid cosmetics are ever considered, review applicable platform rules and regional consumer-protection requirements before implementation.

## 14. Core Gameplay Loop
1. Choose a region, area, or activity.
2. The character fights automatically according to its build.
3. Receive experience, gold, resources, and possible equipment drops.
4. Review new items and compare them with the current build.
5. Equip, sell, store, upgrade, or reroll items as appropriate.
6. Adjust skills and build synergies.
7. Unlock new regions, dungeons, bosses, and progression systems.
8. Contribute to shared world projects and optionally compete in online activities.
9. Repeat with new goals and increasingly interesting loot.

## 15. Phased Development Plan for Claude Code

**Development must be divided into phases and small implementation tickets.** Each phase has a defined goal, scope, and exit criteria. Do not start a later phase until the current phase is demonstrably stable. Keep a working build at the end of every phase.

### Phase 0 — Project Foundation and Visual Prototype
**Goal:** establish the technical foundation and prove the visual direction before building the full game.
- Choose and document the web stack, backend, database, hosting assumptions, and packaging approach.
- Create repository structure, environment configuration, linting, formatting, and automated test setup.
- Create a minimal navigation shell and responsive layout.
- Build a polished visual prototype: hub or area screen, character panel, inventory panel, item slot, and tooltip.
- Define design tokens, typography, spacing, panel styles, rarity colors, and asset guidelines.
- Document the data model and API conventions before adding gameplay complexity.

**Exit criteria:** the application runs locally; the visual prototype has been reviewed; the UI direction is coherent; basic tests and build checks pass.

### Phase 1 — Core Playable Vertical Slice
**Goal:** deliver the smallest complete version that feels like Worldforge.
- Real account registration and login (decided in v0.3; no temporary development identity).
- Create one character and choose a class; support all four class definitions in data even if balance is initially basic.
- One starter area: Abandoned Fields in Graumark.
- A small enemy roster and server-authoritative automatic combat simulation.
- Character health, damage, attack speed, experience, level, and basic attributes.
- Basic equipment slots, inventory, equip/unequip, and item comparison.
- Initial rarity tiers and a small set of affixes.
- Gold and simple item rewards.
- Server-side character saving and a basic offline progress calculation.
- Offline return summary showing earned rewards.
- Main screens: home/area, character, inventory, and combat log.

**Exit criteria:** a new player can create a character, farm the starter area, earn XP and loot, equip an item, leave the game, return later, and see valid offline progress. No critical data duplication or reward exploits remain.

### Phase 2 — World Structure and Early Progression
**Goal:** turn the vertical slice into a small RPG progression experience.
- Implement the hub with clickable building destinations.
- Implement the world map and multiple Graumark areas.
- Add quests and repeatable contracts.
- Add professions and resource gathering.
- Add the first dungeon and first boss.
- Add forge and merchant functionality.
- Expand enemies, item definitions, and area-specific loot tables.
- Improve onboarding, progression feedback, and UI navigation.

**Exit criteria:** players can progress through several connected areas, complete quests, gather resources, and clear the first dungeon and boss.

### Phase 3 — Loot Depth and Build Progression
**Goal:** make loot hunting and build optimization the central long-term loop.
- Expand affix pools and item generation rules.
- Add Legendary unique effects and Mythic item definitions.
- Add set items and set bonuses.
- Implement bounded item upgrades, affix reroll, and affix improvement.
- Add Void variants for eligible Legendary, Mythic, and Set items.
- Add Prismatic only if the variant pipeline and balance are stable.
- Introduce late-game activities and more targeted loot tables.
- Add telemetry for drop rates, item usage, and build distribution.

**Exit criteria:** different item combinations create meaningful build choices; crafting costs and drop rates are measurable; no single item or affix dominates all builds.

### Phase 4 — Online Social Layer and Community World
**Goal:** make the persistent world visibly shared and socially engaging.
- Add public player profiles and selected achievements.
- Add friends and basic social presence if required.
- Add guild creation and membership.
- Add guild communication and moderation tools.
- Add global community projects and world-state unlocks.
- Add group activities or coordinated boss events.
- Evaluate controlled trading only after the economy and item-binding rules are defined.

**Exit criteria:** players can participate in social systems safely; shared progress is consistent; permissions, moderation, and abuse reporting are in place.

### Phase 5 — Leaderboards and Competitive Systems
**Goal:** introduce fair, understandable ways to compare progression and builds.
- Implement server-calculated Character Level, Character Power, Gear Score, and PvE Progress metrics.
- Add leaderboard filters such as class, season, and all-time.
- Add anti-cheat validation, snapshotting, tie-breakers, and audit logging.
- Prototype asynchronous 1v1 PvP using saved character snapshots.
- Add rating-based matchmaking and power brackets if the prototype is healthy.
- Add modest prestige rewards such as titles, profile frames, or cosmetics.
- Keep PvP optional and separate its balance rules from PvE where necessary.

**Exit criteria:** leaderboard values are reproducible and server-authoritative; PvP matches are understandable, reasonably fair, and do not damage core PvE progression.

### Phase 6 — Endgame Expansion and Long-Term Systems
**Goal:** add long-term goals after the core systems have proven stable.
- Expand endgame zones, dungeon tiers, and boss variants.
- Evaluate Item Awakening as an optional system.
- Add additional rare item variants and carefully controlled combinations.
- Add seasonal or rotating events where appropriate.
- Expand community projects and long-term world progression.
- Introduce cosmetic collection systems if they support retention without power advantages.

**Exit criteria:** endgame systems add meaningful choices without making older content or most item drops irrelevant.

### Phase 7 — Desktop Release and Mobile Port
**Goal:** expand distribution after the browser experience is stable.
- Package the web client as a desktop application using the selected wrapper.
- Test installation, updates, window sizing, input, and account synchronization.
- Complete mobile UX review and implement touch-specific layouts.
- Test on a representative range of iOS and Android screen sizes and devices.
- Verify cross-platform account, character, and progress synchronization.

**Exit criteria:** desktop and mobile clients use the same authoritative backend and provide a consistent progression experience.

### 15.1 Required Claude Code Workflow
1. Read the GDD and technical design document before starting a task.
2. Work on one phase and one small ticket at a time; do not implement future-phase features speculatively.
3. Before coding, summarize the intended change, files/modules likely affected, and assumptions.
4. Implement the smallest complete vertical slice for the ticket.
5. Add or update automated tests for gameplay rules and data persistence.
6. Run formatting, linting, tests, and production build checks.
7. Report changed files, decisions, test results, and remaining risks.
8. Wait for review before moving to the next ticket or making broad architectural changes.

### 15.2 Definition of Done
- The feature matches its stated acceptance criteria.
- No unrelated feature scope has been added.
- Gameplay calculations are server-authoritative where relevant.
- Persistence and failure cases have been tested.
- UI follows the established visual system and responsive rules.
- Loading, empty, error, and success states are handled.
- Tests, linting, and build checks pass.
- Documentation is updated where architecture or behavior changed.

## 16. Technical Architecture Principles

### 16.1 Separation of Responsibilities
- **Client:** rendering, navigation, user input, and presenting server state.
- **Backend:** authentication, character state, combat outcomes, loot, offline progress, economy, leaderboards, and PvP resolution.
- **Database:** persistent accounts, characters, items, inventory, activities, world state, and audit records.
- **Content definitions:** data-driven classes, enemies, skills, items, affixes, regions, and loot tables.

### 16.2 Data-Driven Content
Content should be defined through structured data wherever practical. Adding a new enemy, item, affix, skill, or region should not require rewriting core combat or inventory logic.

### 16.3 Security and Integrity
- Never trust client-submitted currency, item rolls, combat results, power scores, or PvP outcomes.
- Validate all state-changing requests on the server.
- Use transaction-safe updates for currency and item operations.
- Maintain audit logs for valuable economy operations and competitive results.
- Design rate limits and abuse controls for login, trading, leaderboards, and PvP.

### 16.4 Observability and Balancing
Track aggregate metrics such as session frequency, offline return rates, area efficiency, drop rates, item usage, upgrade spending, leaderboard distribution, and PvP match outcomes. Use privacy-conscious telemetry and avoid collecting unnecessary personal data.

## 17. Open Design Decisions
| Topic | Current status / next decision |
|---|---|
| Exact equipment slot count | **Decided (v0.3):** 12 slots (head, shoulders, chest, hands, legs, feet, neck, ring ×2, weapon, off-hand, relic). |
| Authentication | **Decided (v0.3):** real account registration and login from Phase 1. |
| Final tech stack and hosting | Decide in Phase 0 after evaluating browser, desktop, and future mobile needs. |
| Offline accumulation cap | **Decided (v0.3):** 3 hours to start, server-configurable. **Ticket 9.4 (owner default, 2026-11-13):** upgradeable per account through four deeds, 3 → 4 → 5 → 6 → 8 hours, from the moment each is earned; never sold. See `docs/ACCOUNTS.md`. |
| Combat timing and formulas | Open; prototype and test in Phase 1. |
| Drop rates and affix ranges | Open; data-driven and tuned through telemetry. |
| Full-pack overflow | **Decided (owner, ticket B.2):** ordinary drops that find no room are salvaged to gold; Legendary, Mythic, set and Void drops are kept beyond the pack's capacity (the loot filter's opted-in categories still apply first). See `docs/FARMING.md`. |
| Stacking copies of an effect | **Decided (ticket B.2):** each Legendary effect counts once (its strongest copy); different effects add up to their caps. |
| Variant stacking rules | Open; define before implementing multiple variant combinations. **Ticket 3.5:** no stacking; one variant (Void) per item until Prismatic. |
| Item Awakening | Optional late-game feature; not an early commitment. **Ticket 6.5 (evaluated, owner decision pending):** `docs/AWAKENING.md` compares an extra affix slot with an awakened effect and recommends the awakened effect (× 1.1 on the item's effect or, piece by piece, its set's bonuses; Legendary, Mythic or set at +10, item level 23+; 3 Tyrant's Embers, 2 Gravewarden's Seals, gold and soul shards; account-bound; ignored by PvP duels). A game-core prototype exists, switched off; nothing ships before the owner's yes (6.5b). |
| Leaderboard formula | **Defined (ticket 5.1, the owner can override):** Character Level (level, then XP within it), Gear Score (equipped items: item level × rarity × upgrades × Void, two-handed weapons count for both hands; since ticket B.4, version 2, equal scores ordered by the items' magic quality), Character Power (the Proving Grounds: a deterministic ladder of 20 fixed trials, levels 4–80; 22 since version 2, ticket 6.1) and PvE Progress (10 ordered milestones, 13 since version 2 (ticket 6.1), 17 since version 3 (ticket 6.2), 18 since version 4 (ticket 6.3: the Heroic crypt cleared), ties by the furthest, then the guild boss stage). Published in `docs/LEADERBOARDS.md`; versioned per metric in game-core. |
| Seasons and prestige rewards | **Defined (ticket 5.3, the owner can override):** 8-week seasons in UTC beside the all-time boards; a season board lists heroes whose score rose in the season, ranked by their score at its end; final standings are archived, never reset away. Honours per board by place: Champion (1st), Exalted (top 10), Renowned (top 100), Veteran (any place, hero level ≥ 10): a title and a profile frame, cosmetic only. **Ticket B.4:** Exalted and Renowned scale with the board (top 2 %, at least 3 and at most 10 places; top 10 %, at least 5 and at most 100). See `docs/LEADERBOARDS.md`. |
| PvP format and normalization | Open; prototype asynchronous 1v1 first. |
| Trading and item binding | **Decided by the owner, 2026-11-07 (ticket 4.10), see `docs/TRADING.md`.** Not built; trading stays off until the trading phase (built at the end of Phase 5, see below). Small and social, behind admin switches that all start off: asynchronous two-sided offers with escrow between friends or guildmates of at least 7 days; items, materials and gold, each switchable; fresh (never worn or forged) Epic, Legendary, set, Mythic and Void items tradeable once, each category switchable (Mythic and Void off at first); boss-hoard and quest/contract rewards always bound; weekly caps per account; a 72-hour hold, moderator reversal within 14 days and a trade-restriction sanction; a shared account shelf for items, materials and gold between one's own heroes, each switchable. |
| Level cap above the top content | **Decided by the owner, 2026-11-07 (ticket F.1):** levels above 28 (the Ashen Pass's top) get more content later; there is no hard level cap. The XP penalty stays the soft cap around 35 (`docs/COMBAT.md`). **Ticket 6.1 (Phase 6 default):** the Cinderwastes beyond the Pass, first area the Ashfall Verge (levels 28–34, opened by level 28 and the Ashen Warden; the 6.7 community gate is a seam). The XP curve (700 · L²) and the penalty are unchanged; with the Verge's foes up to 35 the soft cap moves to about 41–42. Tier-4 item bases from item level 29 and tier-5 affixes from item level 31 (never below 30). **Ticket 6.2 (Phase 6 default):** the second area, the Cinder Depths (34–40, opened by level 34 and the Ashen Warden, the Verge's top; 6.7's gate is a seam), and the region boss, the Forge Tyrant, in the boss-only Tyrant's Forge (level 36; a slag shell and a heavy hammer on the existing engine; an always-bound hoard and the Tyrant's Ember, spent on the Tyrantforged Work recipe). No curve changed; with the Depths' foes up to 41 the soft cap moves to about 47–48. |
| Board formula changes | **Defined (ticket 6.1, the owner can override):** a new formula version takes over between seasons: if a season is under way when the server first runs it, the older version stays in force until that season ends (Power 2: 22 trials, PvE Progress 2: 13 milestones; ticket 6.2: PvE Progress 3, 17 milestones, no new Power version; ticket 6.3: PvE Progress 4, 18 milestones). See `docs/LEADERBOARDS.md`. |
| Crypt tier III difficulty | **Decided by the owner, 2026-11-07 (ticket F.1):** tier III stays "the Legendary tier" (Legendary/set kits win at 21; epic kits find it a wall) and is not made harder. A harder crypt mode (a tier IV or heroic crypt, tuned for upgraded Legendary kits) comes later as part of the content above level 28. **Ticket 6.3 (Phase 6 default, owner decisions):** crypt tier IV "Heroic" (level 32 and tier III cleared): harder chambers and a harder Gravewarden, better top-rarity odds at today's item levels, no new power curve; and a **weekly rotating boss modifier** (Burning, Warded, Frenzied, Unyielding, Relentless) on every boss incl. the guild boss except crypt tier I (owner decision: a stable first boss), each with a small hoard focus, seeded by the week, stored with each run and attempt, announced in the Tavern. See `docs/DUNGEONS.md`. |
| When trading is built | **Decided by the owner, 2026-11-07 (ticket F.1):** trading (`docs/TRADING.md`, T.1–T.7) is built at the end of the next phase (Phase 5). |
| Monetization | Deferred; must preserve fair progression. |

## 18. Product Success Criteria
- A first-time player understands how to start farming and how to equip a drop.
- The first useful loot upgrade is easy to recognize and satisfying.
- Returning after offline time produces a clear, trustworthy summary.
- Active play offers meaningful choices beyond waiting for timers.
- Different item combinations can support more than one viable build.
- The UI is visually distinctive, readable, and consistent across screens.
- The game remains usable at desktop browser sizes and adapts to narrower layouts.
- Online systems do not compromise save integrity or fairness.

## 19. Final Product Direction
Worldforge is a browser-first, cross-platform-ready dark-fantasy idle RPG built around automatic combat, meaningful loot, build variety, offline progression, and a persistent shared world. Its identity should come from the quality of its itemization, its atmospheric pixel-art presentation, and the way personal progression connects to community progress.

The immediate priority is not to build every planned system. It is to create a polished, stable vertical slice and expand it through explicit development phases. Leaderboards and small-scale PvP are part of the long-term online vision, but should arrive only after server-authoritative progression and the core combat model are reliable.
