import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLASS_IDS, ENEMIES } from '@worldforge/game-core';
import { ASSETS, classAttackSheet, enemyAttackSheet } from '../content/assets';
import { adminLocation, routeHiddenFor } from '../lib/route';
import { filterCatalogue, galleryCatalogue, galleryImages, nameFromAssetId } from './gallery';

const catalogue = galleryCatalogue();
const shownEnemyAssets = new Set(catalogue.groups.flatMap((g) => g.enemies.map((e) => e.assetId)));
const shownBackdrops = new Set(catalogue.groups.flatMap((g) => g.backdrops.map((b) => b.assetId)));

describe('animation gallery catalogue (A.14c)', () => {
  it('shows every hero class with its portrait and, when it has one, its attack frames', () => {
    expect(catalogue.heroes.map((h) => h.classId)).toEqual([...CLASS_IDS]);
    for (const h of catalogue.heroes) {
      expect(h.still.path).toBe(`/assets/characters/${h.classId}.png`);
      expect(h.sheet).toBe(classAttackSheet(h.classId));
      expect(h.attackSpeed).toBeGreaterThan(0);
    }
  });

  it('shows every enemy of the game: a new enemy that is not shown fails this test', () => {
    for (const enemy of ENEMIES) {
      expect(shownEnemyAssets, `${enemy.id} (${enemy.assetId})`).toContain(enemy.assetId);
    }
  });

  it('shows every registered enemy sprite, including art not placed in the game yet', () => {
    const registered = Object.keys(ASSETS).filter(
      (id) => id.startsWith('enemy.') && !id.endsWith('-attack'),
    );
    expect(registered.length).toBeGreaterThan(20);
    for (const id of registered) expect(shownEnemyAssets, id).toContain(id);
    // Ticket 6.2: the Forge Tyrant is placed now (the Tyrant's Forge), a boss on the code loop.
    const unplaced = catalogue.groups.find((g) => g.id === 'unplaced');
    expect(unplaced?.enemies.map((e) => e.assetId) ?? []).not.toContain('enemy.forge-tyrant');
    const forge = catalogue.groups.find((g) => g.id === 'dungeon:tyrantsForge');
    expect(forge?.enemies.find((e) => e.assetId === 'enemy.forge-tyrant')).toMatchObject({
      name: 'The Forge Tyrant',
      boss: true,
      sheet: null,
    });
    expect(forge?.backdrops.map((b) => b.assetId)).toEqual(['area.cinder-depths']);
  });

  it('shows every area backdrop', () => {
    const backdrops = Object.keys(ASSETS).filter(
      (id) => id.startsWith('area.') && !id.endsWith('-attack'),
    );
    for (const id of backdrops) expect(shownBackdrops, id).toContain(id);
  });

  it('labels frames from the registry: a sheet when the enemy has one, code only otherwise', () => {
    for (const g of catalogue.groups) {
      for (const e of g.enemies) expect(e.sheet, e.assetId).toBe(enemyAttackSheet(e.assetId));
    }
    const all = catalogue.groups.flatMap((g) => g.enemies);
    expect(all.some((e) => e.sheet)).toBe(true);
    expect(all.some((e) => !e.sheet)).toBe(true); // bosses keep the code animation
    for (const e of all.filter((x) => x.boss)) expect(e.sheet, e.assetId).toBeNull();
  });

  it('groups by area, dungeon and the guild boss, each with its backdrop', () => {
    const ids = catalogue.groups.map((g) => g.id);
    expect(ids).toContain('area:abandonedFields');
    expect(ids).toContain('area:ashenPass');
    expect(ids).toContain('area:ashfallVerge');
    expect(ids).toContain('dungeon:namelessCrypt');
    expect(ids).toContain('dungeon:ashenWatch');
    expect(ids).toContain('guild-boss');
    const crypt = catalogue.groups.find((g) => g.id === 'dungeon:namelessCrypt')!;
    expect(crypt.backdrops.map((b) => b.assetId)).toEqual(['area.nameless-crypt']);
    expect(crypt.enemies.at(-1)).toMatchObject({ assetId: 'enemy.gravewarden', boss: true });
  });

  it('lists each image once for the loading state, every one a registered path', () => {
    const images = galleryImages(catalogue);
    expect(new Set(images).size).toBe(images.length);
    const paths = new Set(Object.values(ASSETS).map((a) => a.path));
    for (const p of images) expect(paths, p).toContain(p);
  });

  it('filters by name, place or asset id, and is empty for a miss (the empty state)', () => {
    const wolves = filterCatalogue(catalogue, 'wolf');
    expect(wolves.heroes).toEqual([]);
    expect(wolves.groups.flatMap((g) => g.enemies.map((e) => e.name))).toContain('Carrion Wolf');
    expect(filterCatalogue(catalogue, 'warrior').heroes.map((h) => h.classId)).toEqual(['warrior']);
    const verge = filterCatalogue(catalogue, 'ashfall verge');
    expect(verge.groups.map((g) => g.id)).toEqual(['area:ashfallVerge']);
    const none = filterCatalogue(catalogue, 'zzz-nothing');
    expect(none.heroes.length + none.groups.length).toBe(0);
    expect(filterCatalogue(catalogue, '  ')).toBe(catalogue);
  });

  it('names unplaced art from its id', () => {
    expect(nameFromAssetId('enemy.forge-tyrant')).toBe('Forge Tyrant');
  });
});

describe('animation gallery access (A.14c)', () => {
  it('lives in the admin panel, which is an unknown address for everyone but admins', () => {
    expect(adminLocation('#/admin/animations')).toEqual({ section: 'animations', arg: null });
    for (const role of [null, 'player', 'moderator'] as const) {
      expect(routeHiddenFor('admin', role), String(role)).toBe(true);
    }
    expect(routeHiddenFor('admin', 'admin')).toBe(false);
    // The moderator queue keeps its own rule.
    expect(routeHiddenFor('moderation', 'player')).toBe(true);
    expect(routeHiddenFor('moderation', 'moderator')).toBe(false);
    expect(routeHiddenFor('area', null)).toBe(false);
  });

  it('is mounted only by the admin panel, and reaches no server', () => {
    const src = new URL('../', import.meta.url);
    const users: string[] = [];
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) walk(url);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          const text = readFileSync(url, 'utf8');
          if (/from '[./]*admin\/AnimationGallery'|from '\.\/AnimationGallery'/.test(text)) {
            users.push(entry.name);
          }
        }
      }
    };
    walk(src);
    expect(users).toEqual(['AdminScreen.tsx']);
    for (const file of ['AnimationGallery.tsx', 'gallery.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text, file).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
      expect(text, file).not.toMatch(
        /from '\.\.\/game\/|from '\.\/api'|useGame|useActiveCharacter/,
      );
    }
  });
});
