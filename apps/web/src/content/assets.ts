import type { ClassId } from '@worldforge/game-core';

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
} as const satisfies Record<string, SpriteAsset>;

export type AssetId = keyof typeof ASSETS;
export type ItemAssetId = Extract<AssetId, `item.${string}`>;
export type EnemyAssetId = Extract<AssetId, `enemy.${string}`>;
export type MaterialAssetId = Extract<AssetId, `material.${string}`>;

export function asset(id: AssetId): SpriteAsset {
  return ASSETS[id];
}

/** A registered sprite by a content asset id, or `null` when the art does not exist (yet). */
export function findSprite(id: string): SpriteAsset | null {
  return Object.hasOwn(ASSETS, id) ? ASSETS[id as AssetId] : null;
}

/**
 * Ticket 5.3: prestige art by its fixed asset name (game-core `PRESTIGE_TIERS[].frameAsset`,
 * `SEASON_TITLES[].badgeAsset`: `season-frame-champion` … `season-frame-veteran`,
 * `title-badge-level` … `title-badge-pve-progress`). Ticket A.10 registers them here as
 * `prestige.<name>` (files under `/assets/prestige/`); until then this returns null and the UI
 * draws a CSS frame and a text badge instead.
 */
export function prestigeSprite(name: string): SpriteAsset | null {
  return findSprite(`prestige.${name}`);
}

/** The full-body portrait for a class (`character.<classId>`), used wherever a hero is drawn. */
export function classPortrait(classId: ClassId): SpriteAsset {
  return ASSETS[`character.${classId}`];
}
