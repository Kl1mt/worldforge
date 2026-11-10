import type { ClassId, PrestigeMetric } from '@worldforge/game-core';

/**
 * Typed registry of the curated Phase 0 art. Mirrors apps/web/public/assets/manifest.json
 * (a test keeps the two in sync), so components get paths and native sizes without a fetch.
 */
export interface SpriteAsset {
  path: string;
  width: number;
  height: number;
  /** Source orientation; the scene mirrors `right`-facing enemies so they face the hero. */
  facing?: 'front' | 'left' | 'right';
  /** Drawn tinted: a stand-in for art still to be made (`ART_STAND_INS`, ticket 6.1). */
  tint?: 'cinder';
  /**
   * Ticket A.14: a frame sheet. The file is one row of `frames` frames, each `width` × `height`
   * (so the PNG is `frames × width` wide); `PixelSprite` shows one frame at a time.
   */
  frames?: number;
}

const item = (name: string): SpriteAsset => ({
  path: `/assets/items/${name}.png`,
  width: 32,
  height: 32,
});

const material = (name: string): SpriteAsset => ({
  path: `/assets/materials/${name}.png`,
  width: 32,
  height: 32,
});

const achievement = (name: string): SpriteAsset => ({
  path: `/assets/achievements/${name}.png`,
  width: 32,
  height: 32,
});

const guildEmblem = (name: string): SpriteAsset => ({
  path: `/assets/guild-emblems/${name}.png`,
  width: 32,
  height: 32,
});

const badge = (name: string): SpriteAsset => ({
  path: `/assets/badges/${name}.png`,
  width: 32,
  height: 32,
});

/**
 * The content box of every season frame (A.10), in native frame pixels: fill it with the portrait
 * or crest well and draw the frame on top. The bands cover its edges in every tier; the central
 * 32×32 (16, 16) is always visible.
 */
export const SEASON_FRAME_WINDOW = { x: 14, y: 14, width: 36, height: 36 } as const;

export interface SeasonFrameSprite extends SpriteAsset {
  window: typeof SEASON_FRAME_WINDOW;
}

const seasonFrame = (tier: string): SeasonFrameSprite => ({
  path: `/assets/frames/season-frame-${tier}.png`,
  width: 64,
  height: 64,
  window: SEASON_FRAME_WINDOW,
});

const enemy = (name: string, facing: 'front' | 'left' | 'right', size = 64): SpriteAsset => ({
  path: `/assets/enemies/${name}.png`,
  width: size,
  height: size,
  facing,
});

const character = (name: string): SpriteAsset => ({
  path: `/assets/characters/${name}.png`,
  width: 128,
  height: 128,
  facing: 'front',
});

/** A.14: a class's attack frames; frame 0 is the portrait itself (the rest pose). */
const attackSheet = (name: string): SpriteAsset => ({
  path: `/assets/characters/${name}-attack.png`,
  width: 128,
  height: 128,
  facing: 'front',
  frames: 8,
});

export const ASSETS = {
  'item.longsword': item('longsword'),
  'item.longsword-notched': item('longsword-notched'),
  'item.skull-staff': item('skull-staff'),
  'item.hunting-bow': item('hunting-bow'),
  'item.iron-helm': item('iron-helm'),
  'item.horned-helm': item('horned-helm'),
  'item.leather-gloves': item('leather-gloves'),
  'item.iron-gauntlets': item('iron-gauntlets'),
  'item.chainmail': item('chainmail'),
  'item.plate-cuirass': item('plate-cuirass'),
  'item.leather-jerkin': item('leather-jerkin'),
  'item.leather-boots': item('leather-boots'),
  'item.brass-ring': item('brass-ring'),
  'item.iron-ring': item('iron-ring'),
  'item.bone-amulet': item('bone-amulet'),
  'item.round-shield': item('round-shield'),
  'item.heater-shield': item('heater-shield'),
  'enemy.undead-farmer': {
    path: '/assets/enemies/undead-farmer.png',
    width: 64,
    height: 64,
    facing: 'front',
  },
  'enemy.wolf': { path: '/assets/enemies/wolf.png', width: 64, height: 64, facing: 'right' },
  'enemy.skeletal-scarecrow': {
    path: '/assets/enemies/skeletal-scarecrow.png',
    width: 64,
    height: 64,
    facing: 'front',
  },
  'enemy.bandit-cutthroat': enemy('bandit-cutthroat', 'front'),
  'enemy.corrupted-crow': enemy('corrupted-crow', 'left'),
  'enemy.risen-skeleton': enemy('risen-skeleton', 'front'),
  'enemy.grave-crawler': enemy('grave-crawler', 'left'),
  'enemy.drowned-thrall': enemy('drowned-thrall', 'left'),
  'enemy.bog-horror': enemy('bog-horror', 'front'),
  'enemy.fallen-knight': enemy('fallen-knight', 'front'),
  'enemy.abbey-wraith': enemy('abbey-wraith', 'front'),
  'enemy.crypt-ghoul': enemy('crypt-ghoul', 'left'),
  'enemy.bone-acolyte': enemy('bone-acolyte', 'front'),
  'enemy.gravewarden': enemy('gravewarden', 'front', 128),
  'character.warrior': character('warrior'),
  'character.mage': character('mage'),
  'character.hunter': character('hunter'),
  'character.warlock': character('warlock'),
  'character.warrior-attack': attackSheet('warrior'),
  'character.mage-attack': attackSheet('mage'),
  'character.hunter-attack': attackSheet('hunter'),
  'character.warlock-attack': attackSheet('warlock'),
  'area.abandoned-fields': { path: '/assets/areas/abandoned-fields.png', width: 384, height: 216 },
  'hub.graumark': { path: '/assets/hub/graumark.png', width: 384, height: 216 },
  'map.graumark': { path: '/assets/map/graumark.png', width: 384, height: 216 },
  'area.crowwood': { path: '/assets/areas/crowwood.png', width: 384, height: 216 },
  'area.old-burial-grounds': {
    path: '/assets/areas/old-burial-grounds.png',
    width: 384,
    height: 216,
  },
  'area.blackwater': { path: '/assets/areas/blackwater.png', width: 384, height: 216 },
  'area.sunken-abbey': { path: '/assets/areas/sunken-abbey.png', width: 384, height: 216 },
  'area.nameless-crypt': { path: '/assets/areas/nameless-crypt.png', width: 384, height: 216 },
  'item.bastard-sword': item('bastard-sword'),
  'item.bog-oak-staff': item('bog-oak-staff'),
  'item.crowwood-longbow': item('crowwood-longbow'),
  'item.kite-shield': item('kite-shield'),
  'item.barbute': item('barbute'),
  'item.brigandine': item('brigandine'),
  'item.ringmail-gloves': item('ringmail-gloves'),
  'item.iron-shod-boots': item('iron-shod-boots'),
  'item.raven-talisman': item('raven-talisman'),
  'item.grave-gold-ring': item('grave-gold-ring'),
  'item.knights-greatsword': item('knights-greatsword'),
  'item.drowned-crozier': item('drowned-crozier'),
  'item.horn-recurve': item('horn-recurve'),
  'item.tower-shield': item('tower-shield'),
  'item.great-helm': item('great-helm'),
  'item.knights-plate': item('knights-plate'),
  'item.plated-gauntlets': item('plated-gauntlets'),
  'item.plate-sabatons': item('plate-sabatons'),
  'item.abbey-pendant': item('abbey-pendant'),
  'item.abbey-signet': item('abbey-signet'),
  'item.gravewardens-cowl': item('gravewardens-cowl'),
  'item.seal-of-the-nameless': item('seal-of-the-nameless'),
  'item.wardens-bone-chain': item('wardens-bone-chain'),
  'item.crown-of-the-hollow-king': item('crown-of-the-hollow-king'),
  'item.gravecallers-edge': item('gravecallers-edge'),
  'item.starfall-sceptre': item('starfall-sceptre'),
  'item.widowmaker': item('widowmaker'),
  'item.heart-of-the-abyss': item('heart-of-the-abyss'),
  'item.ring-of-endless-hunger': item('ring-of-endless-hunger'),
  'item.vigil-helm': item('vigil-helm'),
  'item.vigil-hauberk': item('vigil-hauberk'),
  'item.vigil-gauntlets': item('vigil-gauntlets'),
  'item.vigil-sabatons': item('vigil-sabatons'),
  'item.vigil-oath-chain': item('vigil-oath-chain'),
  'item.vigil-seal': item('vigil-seal'),
  'item.choir-cowl': item('choir-cowl'),
  'item.choir-vestments': item('choir-vestments'),
  'item.choir-wraps': item('choir-wraps'),
  'item.choir-slippers': item('choir-slippers'),
  'item.choir-censer-chain': item('choir-censer-chain'),
  'item.choir-band': item('choir-band'),
  'item.bloodmoon-grips': item('bloodmoon-grips'),
  'item.bloodmoon-treads': item('bloodmoon-treads'),
  'item.bloodmoon-fang': item('bloodmoon-fang'),
  'item.bloodmoon-loop': item('bloodmoon-loop'),
  // Tier 4, the Cinderwastes (A.15): one icon per tier-4 base (game-core `ITEM_BASES[].icon`).
  'item.cinderforged-blade': item('cinderforged-blade'),
  'item.emberheart-scepter': item('emberheart-scepter'),
  'item.slagbone-bow': item('slagbone-bow'),
  'item.obsidian-bulwark': item('obsidian-bulwark'),
  'item.revenant-visage': item('revenant-visage'),
  'item.ashplate-hauberk': item('ashplate-hauberk'),
  'item.slagiron-gauntlets': item('slagiron-gauntlets'),
  'item.cinderstride-greaves': item('cinderstride-greaves'),
  'item.ember-reliquary': item('ember-reliquary'),
  'item.wispfire-band': item('wispfire-band'),
  'material.timber': material('timber'),
  'material.ashwort': material('ashwort'),
  'material.raw-hide': material('raw-hide'),
  'material.iron-ore': material('iron-ore'),
  'material.soul-shard': material('soul-shard'),
  'material.abbey-silver': material('abbey-silver'),
  'material.gravewarden-seal': material('gravewarden-seal'),
  // The Ashen Pass (A.7): art only. Ticket 4.8 adds the area `ashenPass` and its enemies to
  // game-core with these asset ids; until then nothing in gameplay references them.
  'area.ashen-pass': { path: '/assets/areas/ashen-pass.png', width: 384, height: 216 },
  'enemy.ash-wraith': enemy('ash-wraith', 'right'),
  'enemy.cinder-hound': enemy('cinder-hound', 'left'),
  'enemy.pyre-cultist': enemy('pyre-cultist', 'right'),
  'enemy.ember-golem': enemy('ember-golem', 'front'),
  'enemy.ashen-warden': enemy('ashen-warden', 'front', 128),
  // Deeds (A.8): one 32×32 icon per achievement (`assetId` in game-core's ACHIEVEMENTS).
  'achievement.first-epic': achievement('first-epic'),
  'achievement.first-legendary': achievement('first-legendary'),
  'achievement.first-mythic': achievement('first-mythic'),
  'achievement.full-set': achievement('full-set'),
  'achievement.forge-plus-5': achievement('forge-plus-5'),
  'achievement.forge-plus-10': achievement('forge-plus-10'),
  'achievement.level-10': achievement('level-10'),
  'achievement.level-20': achievement('level-20'),
  'achievement.gravewarden-slain': achievement('gravewarden-slain'),
  'achievement.crypt-tier-2': achievement('crypt-tier-2'),
  'achievement.crypt-tier-3': achievement('crypt-tier-3'),
  'achievement.story-graumark': achievement('story-graumark'),
  'achievement.contracts-10': achievement('contracts-10'),
  'achievement.contracts-50': achievement('contracts-50'),
  // Ticket 4.9: two unused variants of the A.8 icon batch (no new art).
  'achievement.guild-boss-first-stage': achievement('guild-boss-first-stage'),
  'achievement.guild-boss-laid-to-rest': achievement('guild-boss-laid-to-rest'),
  // Ticket A.9: the two community-project deeds (4.6).
  'achievement.warehouse-restorer': achievement('warehouse-restorer'),
  'achievement.ashen-pass-breaker': achievement('ashen-pass-breaker'),
  // Guild crests (A.8): the charge drawn on the dyed shield (`assetId` in GUILD_EMBLEMS).
  'guild-emblem.anvil': guildEmblem('anvil'),
  'guild-emblem.crow': guildEmblem('crow'),
  'guild-emblem.tower': guildEmblem('tower'),
  'guild-emblem.flame': guildEmblem('flame'),
  'guild-emblem.skull': guildEmblem('skull'),
  'guild-emblem.oak': guildEmblem('oak'),
  'guild-emblem.wolf': guildEmblem('wolf'),
  'guild-emblem.key': guildEmblem('key'),
  'guild-emblem.crown': guildEmblem('crown'),
  'guild-emblem.moon': guildEmblem('moon'),
  'guild-emblem.serpent': guildEmblem('serpent'),
  'guild-emblem.chalice': guildEmblem('chalice'),
  // Season prestige (A.10): profile frames by tier (best first), one title badge per board metric,
  // and the duel arena backdrop. Ticket 5.3 wires the frames and badges, 5.5 the arena.
  'frame.season-frame-champion': seasonFrame('champion'),
  'frame.season-frame-exalted': seasonFrame('exalted'),
  'frame.season-frame-renowned': seasonFrame('renowned'),
  'frame.season-frame-veteran': seasonFrame('veteran'),
  'badge.title-badge-level': badge('title-badge-level'),
  'badge.title-badge-gear-score': badge('title-badge-gear-score'),
  'badge.title-badge-power': badge('title-badge-power'),
  'badge.title-badge-pve-progress': badge('title-badge-pve-progress'),
  'area.arena': { path: '/assets/areas/arena.png', width: 384, height: 216 },
  // The Cinderwastes (A.11): art only. Ticket 6.1 adds the first area and its enemies to
  // game-core with these asset ids, 6.2 the deeper area and the region boss (128×128).
  'area.cinderwastes': { path: '/assets/areas/cinderwastes.png', width: 384, height: 216 },
  'area.cinder-depths': { path: '/assets/areas/cinder-depths.png', width: 384, height: 216 },
  'enemy.cinder-revenant': enemy('cinder-revenant', 'front'),
  'enemy.ash-colossus': enemy('ash-colossus', 'front'),
  'enemy.ember-wisp': enemy('ember-wisp', 'left'),
  'enemy.slag-hound': enemy('slag-hound', 'left'),
  'enemy.forge-tyrant': enemy('forge-tyrant', 'front', 128),
} as const satisfies Record<string, SpriteAsset>;

export type AssetId = keyof typeof ASSETS;
export type ItemAssetId = Extract<AssetId, `item.${string}`>;
export type EnemyAssetId = Extract<AssetId, `enemy.${string}`>;
export type MaterialAssetId = Extract<AssetId, `material.${string}`>;

export function asset(id: AssetId): SpriteAsset {
  return ASSETS[id];
}

/**
 * Content art still to be drawn, shown as the closest existing sprite with an ember tint. Ticket
 * 6.1 used it for the ten tier-4 item icons until A.15 drew them; it is empty now and stays as the
 * fallback for a Cinderwastes name whose art is missing. Registered art always wins; remove an
 * entry once its art lands.
 */
export const ART_STAND_INS: Readonly<Record<string, AssetId>> = {};

/**
 * A registered sprite by a content asset id; else its tinted stand-in (`ART_STAND_INS`); else
 * `null` when the art does not exist (yet).
 */
export function findSprite(id: string): SpriteAsset | null {
  if (Object.hasOwn(ASSETS, id)) return ASSETS[id as AssetId];
  const standIn = Object.hasOwn(ART_STAND_INS, id) ? ART_STAND_INS[id] : undefined;
  return standIn ? { ...ASSETS[standIn], tint: 'cinder' } : null;
}

/**
 * Ticket 5.3: prestige art by its fixed asset name (game-core `PRESTIGE_TIERS[].frameAsset`,
 * `SEASON_TITLES[].badgeAsset`): `season-frame-<tier>` is A.10's `frame.<name>` (64×64, fill
 * `SEASON_FRAME_WINDOW`), `title-badge-<metric>` its `badge.<name>` (32×32). Null for a name that
 * is not registered; the UI then draws a CSS rim and an enamelled lozenge instead.
 */
export function prestigeSprite(name: string): SpriteAsset | null {
  if (name.startsWith('season-frame-')) return findSprite(`frame.${name}`);
  if (name.startsWith('title-badge-')) return findSprite(`badge.${name}`);
  return null;
}

/** The full-body portrait for a class (`character.<classId>`), used wherever a hero is drawn. */
export function classPortrait(classId: ClassId): SpriteAsset {
  return ASSETS[`character.${classId}`];
}

/**
 * Ticket A.14: a class's attack frame sheet (8 frames, frame 0 = the portrait), or `null` when the
 * class has none; the scene then animates the plain portrait in code.
 */
export function classAttackSheet(classId: ClassId): SpriteAsset | null {
  return findSprite(`character.${classId}-attack`);
}

/** Season frame tiers, best to least (A.10). Ticket 5.3 maps its prestige ranks onto these. */
export const SEASON_FRAME_TIERS = ['champion', 'exalted', 'renowned', 'veteran'] as const;
export type SeasonFrameTier = (typeof SEASON_FRAME_TIERS)[number];

/**
 * The 64×64 profile frame for a season tier. Draw it at an integer scale ×N over content that
 * fills `window` × N (×1 around a 32 px charge, ×4 around a 128 px portrait).
 */
export function seasonFrameAsset(tier: SeasonFrameTier): SeasonFrameSprite {
  return ASSETS[`frame.season-frame-${tier}`];
}

const TITLE_BADGE_NAMES = {
  level: 'level',
  gearScore: 'gear-score',
  power: 'power',
  pveProgress: 'pve-progress',
  // Ticket 5.6: the arena ladder reuses Character Power's crossed blades (no new art).
  arena: 'power',
} as const satisfies Record<PrestigeMetric, string>;

/**
 * The 32×32 title badge for a leaderboard metric (A.10). Draw it at ×1 where there is room; in
 * a 16–24 px slot (a board row, a name line) it may be shrunk with smooth filtering, the one
 * exception to integer scaling (docs/ASSET_GUIDELINES.md).
 */
export function titleBadgeAsset(metric: PrestigeMetric): SpriteAsset {
  return ASSETS[`badge.title-badge-${TITLE_BADGE_NAMES[metric]}`];
}

/** The duel arena backdrop (A.10), 384×216 like the area backdrops. Ticket 5.5 draws it. */
export function arenaBackdrop(): SpriteAsset {
  return ASSETS['area.arena'];
}
