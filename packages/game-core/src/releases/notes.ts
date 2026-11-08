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
export const GAME_VERSION = '0.5.5';

export const PATCH_NOTES: readonly PatchNote[] = [
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
