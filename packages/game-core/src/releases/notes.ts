/**
 * Ticket F.3: the patch notes, newest first. This list and `GAME_VERSION` are the one place the
 * game's version lives; the server's `GET /api/health` and the web's status bar and "What's new"
 * screen read it from here.
 *
 * Every PR that changes something a player can see adds an entry at the top and bumps
 * `GAME_VERSION` (`CLAUDE.md`, `docs/DEVELOPMENT.md`). Write for players: plain, in-world words,
 * no file names, no internal jargon, no security details. `tickets` is for us and is not shown
 * prominently.
 */
export interface PatchNote {
  /** `0.<phase>.<patch>`. */
  version: string;
  /** Release (merge) date, `YYYY-MM-DD` (UTC). */
  date: string;
  /** A short headline. */
  title: string;
  new?: readonly string[];
  changed?: readonly string[];
  fixed?: readonly string[];
  /** Roadmap ticket ids, for reference only. */
  tickets?: readonly string[];
}

/** The version of the game in this build. Must equal the newest entry of `PATCH_NOTES`. */
export const GAME_VERSION = '0.6.12';

export const PATCH_NOTES: readonly PatchNote[] = [
  {
    version: '0.6.12',
    date: '2026-11-13',
    title: 'Awakened items stay safe',
    changed: [
      'Awakening an item now also locks it, so it can’t be sold, salvaged or thrown away by mistake. You can unlock it in the Pack whenever you like. Items awakened before this change have been locked too.',
    ],
    tickets: ['6.5c'],
  },
  {
    version: '0.6.11',
    date: '2026-11-13',
    title: 'The Forgeward Outpost',
    new: [
      'Town works: a new project, Rebuild the Forgeward Outpost, opens once the Ashen Pass is clear. Three stages of gold, iron ore, soul shards, Abbey silver and, for the beacon, ten Tyrant’s Embers, given by the whole town a share a day, as before.',
      'When the outpost stands, the Forge works the Tyrant’s fire at its beacon: Tyrantforged Work costs 20 % less gold (2,400 instead of 3,000). Everyone who helped earns the mark “Keeper of the Forgeward”.',
      'Eras of Graumark: the town now shows which era it is in, from the works it has finished. The light over the town, its banners, the town crier’s calls and the talk in the Tavern change with each era. Graumark is in the Era of the Rekindling now; the outpost begins the Forgeward Age. Eras are only how the town looks and sounds.',
    ],
    changed: [
      'Nothing you can reach today is closed by the new project: the Ashfall Verge, the Cinder Depths and the Tyrant’s Forge stay open as they are.',
    ],
    fixed: ['The Forge now names Tyrantforged Work’s tier (Tier IV).'],
    tickets: ['6.7'],
  },
  {
    version: '0.6.10',
    date: '2026-11-12',
    title: 'The void stirs',
    changed: [
      'Void items now stir in your pack, gear and every other place they show: their pale outline slowly breathes and now and then flickers, and faint motes drift inward through the dark around them. It is only a look and changes nothing about the item.',
      'Prismatic items keep their slow shimmer. If your device asks for reduced motion, both stay still, as before.',
    ],
    tickets: ['A.12b'],
  },
  {
    version: '0.6.9',
    date: '2026-11-12',
    title: 'Awakening',
    new: [
      'Awakening at the Forge: a +10 Legendary, Mythic or set item of item level 23 or higher can be awakened once. A Legendary’s effect or a Mythic’s signature becomes a tenth stronger. A set piece counts toward its set instead: each set bonus grows a tenth stronger once as many worn pieces of the set are awakened as the bonus needs.',
      'An awakening costs 3 Tyrant’s Embers, 2 Gravewarden’s Seals from any crypt hoard, about 25,000 gold and 30 soul shards. The Forge shows the effect before and after, and warns you when it would change nothing for your hero right now. It is permanent.',
      'Awakened items carry an ember sigil ☼ and a smouldering glow on their frame, next to a Void or Prismatic mark.',
      'Awakened items are bound to your account for good and can never be traded. They can still move between your own heroes on the account shelf. Rerolls and improvements stay possible.',
      'Awakening counts in duels, and arena matchmaking now takes it into account when it pairs opponents.',
    ],
    tickets: ['6.5b'],
  },
  {
    version: '0.6.8',
    date: '2026-11-12',
    title: 'Harvest of Bones',
    new: [
      'Events: from time to time the town calls a short event, announced on a banner in Graumark and on the map, and described in the Tavern. Only one runs at a time, and each lasts a few days.',
      'The first is the Harvest of Bones. Join it in the Tavern: while it lasts, every 40 of the risen dead you put down in the Abandoned Fields or the Old Burial Grounds yield an extra Soul Shard, and four tasks from the Reeve earn bone tallies.',
      'Bone tallies from all your heroes fill one reward track with three keepsakes: the Sheaf-and-Bone banner, the Bone-white title colour and the title “Reaper of the Harvest”. Each is yours once, for good. The title can be shown beside your name now (on your profile, under Season honours); the banner and the colour will show once the collection book opens.',
      'Event rewards are for show only: they change no number in the game. Experience, gold and drops are as ever.',
      'When an event ends, unfinished tasks lapse. Everything you earned during it, shards and keepsakes alike, stays yours.',
    ],
    tickets: ['6.6'],
  },
  {
    version: '0.6.7',
    date: '2026-11-11',
    title: 'Prismatic',
    new: [
      'Prismatic items: a rare new kind of Legendary, Mythic or set piece, rarer than Void and never both at once. Light splits through them: their battle properties count a tenth more (not critical chance, and not gold, item, experience or resource find), while their base values and effect stay as they are. Void strengthens an item’s base and its effect instead, so which of the two suits a hero depends on the item’s properties and the build.',
      'Prismatic items are found only from the Ashen Pass onwards: the Pass and the Warden’s Watch, the Ashfall Verge, the Cinder Depths and the Tyrant’s Forge, and most often in the Heroic crypt.',
      'Gear Score counts a Prismatic item like a Void one. Forge work never adds or removes it, and a Prismatic set piece still counts as the same piece.',
      'The loot filter keeps Prismatic drops unless you tick the new Prismatic box.',
    ],
    tickets: ['6.4'],
  },
  {
    version: '0.6.6',
    date: '2026-11-11',
    title: 'The Heroic crypt',
    new: [
      'The Nameless Crypt has a Heroic depth for heroes of level 32 who have cleared Tier III: tougher chambers and a harder Gravewarden whose every fourth blow tolls like a bell. It holds no stronger gear than the Cinderwastes, but Legendaries, Mythics, set pieces and Void items turn up far more often.',
      'Every week the bosses change their ways. One of five weekly twists holds at every boss past the crypt’s first depth, up to the Forge Tyrant and the guild boss: Burning, Warded, Frenzied, Unyielding or Relentless. The first depth of the crypt stays the same every week. Each one also makes a boss’s hoard favour certain items. The Tavern keeper announces the week’s twist, and every boss door and the guild boss show it.',
      'A boss fight always keeps the twist of the week it began in, even if it ends after the week turns on Monday.',
      'PvE Progress has a new milestone: the Heroic crypt cleared. It joins the board between seasons, never during one.',
    ],
    tickets: ['6.3'],
  },
  {
    version: '0.6.5',
    date: '2026-11-10',
    title: 'The Tyrant’s Forge',
    new: [
      'The Cinder Depths, the second area of the Cinderwastes, for levels 34 to 40: forge-tempered revenants, slag mastiffs, ashflame wisps and slag colossi, with better Cinderwastes gear. They open at level 34 for heroes who slew the Ashen Warden.',
      'The Tyrant’s Forge at the bottom of the Depths, from level 36: the Forge Tyrant, the region’s lord. His slag armour softens your blows until it cracks, and every third swing of his hammer lands far harder. His hoard is yours alone and holds a Tyrant’s Ember.',
      'Tyrantforged Work at the Forge: spend a Tyrant’s Ember with ore and soul shards to make a Cinderwastes piece of your choice, Rare or better.',
      'PvE Progress has four new milestones: the Cinder Depths reached, its levels 37 and 40, and the Forge Tyrant defeated. They join the board between seasons, never during one.',
    ],
    tickets: ['6.2'],
  },
  {
    version: '0.6.4',
    date: '2026-11-10',
    title: 'No foe falls unstruck',
    fixed: [
      'A foe no longer fades away in battle without being struck first: every defeat now follows a visible blow.',
    ],
    tickets: ['A.14c'],
  },
  {
    version: '0.6.3',
    date: '2026-11-10',
    title: 'Claws and pitchforks',
    new: [
      'Most foes now strike with their own attack: farmhands jab their pitchforks, wolves lunge, crows peck, skeletons and knights swing their blades, and the creatures of the Ashen Pass and the Ashfall Verge lash out in their own way.',
    ],
    changed: [
      'The hunter’s shot is easier to follow: the bow comes up, the string draws back and the arrow flies.',
    ],
    fixed: [
      'Battle animations no longer fall out of step after a few foes: every blow, flinch, fall and return now plays every time.',
    ],
    tickets: ['A.14b'],
  },
  {
    version: '0.6.2',
    date: '2026-11-10',
    title: 'Forged in cinder',
    changed: [
      'The Cinderwastes’ gear has its own look: forge-blackened iron, obsidian and slag with ember inlays, instead of reddened copies of older gear.',
    ],
    tickets: ['A.15'],
  },
  {
    version: '0.6.1',
    date: '2026-11-09',
    title: 'Beyond the Warden’s tower',
    new: [
      'The Cinderwastes: past the Ashen Warden’s watchtower lies the Ashfall Verge, a new area for levels 28 to 34. Heroes of level 28 who have slain the Ashen Warden can farm it.',
      'Four new foes walk the ash: Cinder Revenants, Slag Hounds, Ember Wisps and the slow, enormous Ash Colossus.',
      'New gear: the Verge drops a new, stronger family of weapons, armour and jewelry from item level 29, and the finest pieces can roll a new, fifth tier of magic properties.',
      'The Ashfall Verge pays more experience and gold than the Ashen Pass. Your best Ashen Pass gear is enough to farm it, and it still salvages and upgrades at the Forge as before.',
    ],
    changed: [
      'Heroes keep levelling at a steady pace into their late thirties now; the climb slows sharply around level 42.',
      'Character Power adds two trials at levels 30 and 34, and PvE Progress adds three milestones in the Cinderwastes. Boards switch to them between seasons: a season already under way finishes as it began.',
      'Duels in the 30+ bracket are measured against the new gear, and the classes there are rebalanced against each other.',
    ],
    tickets: ['6.1'],
  },
  {
    version: '0.6.0',
    date: '2026-11-09',
    title: 'Steel in motion',
    new: [
      'Heroes and foes now move in battle: they breathe while they wait, your hero strikes, foes flinch, answer back and fall, and fresh ones come out of the fog.',
      'Each class has its own attack: the warrior’s sword cut, the mage’s staff, the hunter’s bow and the warlock’s curse.',
      'If your device asks for reduced motion, the battle scene stays still.',
    ],
    tickets: ['A.14'],
  },
  {
    version: '0.5.16',
    date: '2026-11-09',
    title: 'The season’s last watch',
    changed: ['You can change your account’s email address up to three times an hour.'],
    fixed: [
      'The duel book now shows an opponent as “a blocked player” only when you are the one who blocked them; anyone else who is out of reach shows as a former player.',
      'Logging in with many wrong passwords at once is now held back exactly like trying them one after another.',
    ],
    tickets: ['5.8'],
  },
  {
    version: '0.5.15',
    date: '2026-11-09',
    title: 'Every coin accounted for',
    fixed: [
      'When a warden undoes a trade, an item that goes back to its first owner now also leaves the other hero’s saved arena defence at once. The rest of that defence stays as it was saved; refresh it to fill the empty slot.',
    ],
    tickets: ['T.7'],
  },
  {
    version: '0.5.14',
    date: '2026-11-09',
    title: 'A word with the wardens',
    new: [
      'Every offer and trade on the Trading screen now has “Report this offer” (or “trade”), so you can ask the wardens to look at it, with a new reason for scams, stolen accounts and selling for real money. Trading between players is still closed until the wardens open it.',
      'Once trading opens, a warden can undo a trade within 14 days if something was wrong with it: everything goes back to the hero it came from, all at once or not at all, and both players see the warden’s reason in their trade history. Staff never ask for your items or gold.',
    ],
    tickets: ['T.6'],
  },
  {
    version: '0.5.13',
    date: '2026-11-09',
    title: 'The weighing table',
    new: [
      'A Trading screen, reached from the status bar. Trading between players is still closed: the screen says so until the wardens open it.',
      'Once it opens, you will be able to send a friend or guildmate a gift or a swap of items, materials and gold. Both sides are shown in full before anything is sent or accepted, and a swap happens all at once or not at all.',
      'Everything received in a trade is held for 72 hours: items can be worn but not sold, salvaged, discarded, forged, stored in the Warehouse or put on the shelf, and gold and materials can’t be spent until the hold ends. Held items say so in their description.',
    ],
    tickets: ['T.5'],
  },
  {
    version: '0.5.12',
    date: '2026-11-09',
    title: 'Where you stand for trading',
    new: [
      'Your account page shows where you would stand if trading between players is ever opened: an account at least two weeks old, a hero at level 15, a verified email address and good standing, each marked met or not. You can also check whether anything would stand between you and a friend. Trading itself is not open.',
    ],
    changed: [
      'The wardens can now restrict a player’s trading alone, without muting or suspending them; play, chat and the account shelf carry on as usual.',
    ],
    tickets: ['T.4'],
  },
  {
    version: '0.5.11',
    date: '2026-11-08',
    title: 'A shelf for the whole household',
    new: [
      'The Warehouse gains an account shelf for moving goods between your own heroes; the town opens it when ready. Once open, one hero can leave items, materials and gold there and any of your other heroes can take them, and anything left on it can always be taken out.',
    ],
    tickets: ['T.3'],
  },
  {
    version: '0.5.10',
    date: '2026-11-08',
    title: 'Bound to your name',
    new: [
      'Item details now say whether an item is bound to your account and why (worn, forged at the forge, a boss hoard’s loot, a reward, or simply too common to matter), or that wearing or forging it will bind it. Nothing about your items has changed: no item can leave your account.',
    ],
    tickets: ['T.1'],
  },
  {
    version: '0.5.9',
    date: '2026-11-08',
    title: 'Locks and keys',
    new: [
      'Your account screen can now log you out on every other device, for a lost phone or a shared computer, and change your email address (your current password is needed).',
      'Letters from the keeper: once the town’s post is set up, new accounts get a letter to confirm their email address, and "Forgot your password?" at the gate sends a link to choose a new one. Until then those screens say the post is not running yet; you play as usual either way, and nothing changes for existing accounts.',
    ],
    changed: [
      'After several wrong passwords in a row, an account now waits a little before the next try, a little longer each time.',
    ],
    tickets: ['5.7'],
  },
  {
    version: '0.5.8',
    date: '2026-11-08',
    title: 'Old rivals',
    changed: [
      'In a small town you can now keep duelling the same rivals: repeat bouts in a week still count for less (half, then a quarter), but never for nothing, and the arena keeps naming them.',
    ],
    tickets: ['B.4b'],
  },
  {
    version: '0.5.7',
    date: '2026-11-08',
    title: 'Fairer rolls and duels',
    changed: [
      'Season honours now grow with the town: Exalted goes to the top 2 % of a season roll (at least the top 3, at most the top 10) and Renowned to the top 10 % (at least the top 5, at most the top 100). In a small town the highest honours are now as rare as they were meant to be; everyone else on the roll at level 10 or above is still a Veteran.',
      'Gear Score: when two heroes have the same score, the one whose items rolled better magic properties now ranks higher. Your score itself does not change, and rerolling or improving a property at the Forge can now lift you past heroes with the same gear.',
      'Arena opponents: the arena now judges how strong your gear is with your class in mind, so warriors no longer meet better-armed opponents than other classes do, and warlocks no longer meet weaker ones.',
      'Arena opponents: players you have not fought this week are named first, so more of your rated duels count in full.',
    ],
    tickets: ['B.4'],
  },
  {
    version: '0.5.6',
    date: '2026-11-08',
    title: 'The Arena Ladder',
    new: [
      'Arena rating: every rated duel in a season now moves the rating of both heroes, the challenger’s and the defender’s. Each hero starts at 1,500 and is “provisional” until it has fought ten rated duels; the arena shows your rating, how sure it is, and your record.',
      'The Arena Ladder: a new board next to the Roll of Renown ranks the season’s heroes by rating, with the same filters by class and level bracket. Past seasons keep their final standings.',
      'Fairer opponents: the arena now names heroes whose gear is about as strong as yours and whose rating is close to yours, so very lopsided bouts are rare. Each opponent shows whether you are favoured, evenly matched or the underdog.',
      'Arena honours: at the end of a season the ladder’s best are honoured like the other boards, with the title Duellist (Champion, Exalted, Renowned or Veteran Duellist) and a profile frame. For glory only.',
    ],
    changed: [
      'Friends and guildmates no longer meet in rated duels; challenge them in a friendly duel instead, as before.',
      'Fighting the same player again and again in a week counts for less each time: half, then a quarter, then nothing, and the arena stops naming them for a while.',
      'A new season starts every hero’s rating halfway back toward 1,500.',
    ],
    tickets: ['5.6'],
  },
  {
    version: '0.5.5',
    date: '2026-11-08',
    title: 'The Proving Ring',
    new: [
      'The Proving Ring opens in Graumark: duel saved copies of other heroes. Nobody needs to be online, and the result is there at once with a blow-by-blow log.',
      'Save your defence: the copy of your hero that others fight. It shows when you saved it, and you can refresh it whenever your gear changes.',
      'Rated duels open at level 10: ten a day, against heroes of your level bracket that the arena names for you. Rating and rewards come later.',
      'Friendly challenges: duel your friends and guildmates at any level, even across brackets, from the arena, your friend list or your guild’s roster. No rating, no rewards, no daily limit.',
      'A duel book keeps every bout you fought and every bout fought against your defence. You can report a player from a bout.',
      'A loss never takes anything from you: no gold, items, experience or score.',
    ],
    tickets: ['5.5'],
  },
  {
    version: '0.5.4',
    date: '2026-11-07',
    title: 'Seasons of renown',
    new: [
      'Seasons: the Roll of Renown can now show one season at a time. A season lasts eight weeks and lists the heroes who rose on each board during it, ranked by where they stand when it ends.',
      'When a season ends, its rolls are sealed for good and every hero on them is honoured by place: Champion for first, Exalted for the top 10, Renowned for the top 100, and Veteran for the rest at level 10 or above.',
      'Honours are titles and profile frames. Choose which ones to show on your profile; they appear beside your name on the boards, your profile and your guild’s roster. They are for glory only and change nothing in a fight.',
    ],
    tickets: ['5.3'],
  },
  {
    version: '0.5.3',
    date: '2026-11-07',
    title: 'Word from the gate',
    new: [
      'When Graumark changes while you play, a quiet notice tells you the new version is out and offers to reload. Choose Later and it will not ask again for that version.',
    ],
    fixed: [
      'If part of the game fails to load after a change in Graumark, you now get a way to reload instead of an empty screen.',
    ],
    tickets: ['F.4'],
  },
  {
    version: '0.5.2',
    date: '2026-11-07',
    title: 'The Roll of Renown',
    new: [
      'The Roll of Renown: four boards rank every hero by Character Level, Character Power, Gear Score and PvE Progress.',
      'Filter a board by class and by level bracket, and find your own place on it at a glance.',
      'Each board explains in plain words how it is measured.',
      'A name on the roll opens that hero’s profile, unless they keep their profile hidden. You can report a name from the roll.',
    ],
    fixed: [
      'Some screens could borrow the look of another screen’s ledgers (the map, the character screen and guild chat). Each keeps its own now.',
    ],
    tickets: ['5.2'],
  },
  {
    version: '0.5.1',
    date: '2026-11-07',
    title: 'Measure of a hero',
    new: [
      'A Standing panel on the character screen shows four scores: Character Level, Gear Score, Character Power and PvE Progress.',
      'Open any score to see what counted toward it and why.',
    ],
    tickets: ['5.1'],
  },
  {
    version: '0.5.0',
    date: '2026-11-07',
    title: 'Contracts from the Pass',
    new: ['The Tavern now offers contracts in the Ashen Pass, once your hero can enter the Pass.'],
    tickets: ['F.1'],
  },
  {
    version: '0.4.0',
    date: '2026-11-07',
    title: 'Banners over Graumark',
    new: [
      'The world is online: heroes from all over share one Graumark. Joining is by invitation for now.',
      'Public profiles with deeds to earn and show off.',
      'Friends: send requests, see who is around, and block players you would rather not meet.',
      'Guilds: found or join one, raise a banner with a crest, and talk in guild chat.',
      'Town works: build community projects together; finished works open new places for every hero.',
      'The Warehouse: storage for each hero, once the town has restored it.',
      'The Ashen Pass, a new top-end region, and the Warden’s Watch at its end.',
      'A weekly guild boss for the whole guild to wear down together.',
      'Report a player and read your own account standing; wardens look after the town.',
      'Imprint and privacy pages, linked at the foot of every screen.',
    ],
    changed: ['Rewards and costs at the top end and in the guild economy were rebalanced.'],
    tickets: ['4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7', '4.8', '4.9', 'B.3', 'D.1', 'D.2'],
  },
  {
    version: '0.3.0',
    date: '2026-11-06',
    title: 'Deeper loot',
    new: [
      'Items roll more kinds of affixes, from boss damage to experience and item find, and better ones in harder places.',
      'Legendary items with effects that change how a fight goes, and the first Mythic items.',
      'Set items: wear pieces of the same set for set bonuses.',
      'The Forge upgrades items up to +10, rerolls an affix or improves one. A failed upgrade never breaks an item.',
      'Void items: rare, drained-looking versions of Legendary, Mythic and set items with a little extra strength.',
      'The Nameless Crypt has three tiers, each with its own loot focus, so you can hunt for the pieces your build needs.',
      'A loot filter that sells or salvages unwanted drops for you, item locks, and actions on many items at once in the Pack.',
    ],
    changed: ['Drop rates, forge costs and prices were rebalanced for the deeper loot.'],
    tickets: ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', 'B.2'],
  },
  {
    version: '0.2.0',
    date: '2026-11-05',
    title: 'The world opens',
    new: [
      'Graumark, the town, is your home, and the world map leads to five areas: the Abandoned Fields, Crowwood, the Old Burial Grounds, Blackwater and the Sunken Abbey.',
      'Gather materials while you farm and level your professions.',
      'The Tavern: a story to follow, and three fresh contracts every day.',
      'The Nameless Crypt and its guardian, the Gravewarden. Defeat it to open the Sunken Abbey.',
      'The Forge salvages and crafts; the Merchant buys your spoils and sells a daily stock.',
      'A first-steps guide for new heroes, notices when you level up or a road opens, and “New” markers on fresh drops and Tavern notes.',
    ],
    changed: [
      'Combat, experience, gold, materials and the crypt were rebalanced after the first playtests.',
    ],
    tickets: ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', 'B.1'],
  },
  {
    version: '0.1.0',
    date: '2026-11-04',
    title: 'The first road',
    new: [
      'Create an account and forge a hero: Warrior, Mage, Hunter or Warlock.',
      'Send your hero to farm the Abandoned Fields. The fight runs on its own and carries on while you are away, for up to three hours.',
      'Foes drop gear in six rarities, from Common to Mythic. Equip it from your Pack and compare before you wear it.',
      'The Chronicle tells the fight as it happens, and “While you were away” sums up what your hero did.',
    ],
    tickets: ['0.3', '0.4', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8'],
  },
];
