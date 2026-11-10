import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { COSMETICS, findCosmetic } from '@worldforge/game-core';
import { appearancePalette, readPaletteData } from '../content/appearance';
import { applySwap } from '../components/paletteSwap';
import { HeroPortrait } from '../characters/HeroPortrait';
import { ShownTitle } from '../social/Prestige';
import { BannerStyle, CrestMark, CrestRim, HeroLook, titleColourClass } from './Cosmetics';
import { accountSlot, counts, filterEntries, isWorn } from './book';
import { BOOK_KINDS, KIND_LABELS, equipFailure, howToEarn, sourceLabel } from './text';
import type { Collection, CollectionEntry } from './api';

/** Ticket 6.8: the collection book on the web (docs/COSMETICS.md). */

describe('palette data (A.13) and the swap', () => {
  it('reads every shape the art ticket may use, and ignores the rest', () => {
    const data = readPaletteData({
      './palettes.ts': {
        PALETTES: {
          'appearance.ember': {
            warrior: { '#112233': '#AA0000', bad: '#zzz' },
            mage: [['#445566', '#00bb00']],
            hunter: [{ from: '#778899', to: '#0000cc' }],
          },
          'appearance.midnight': { default: { '#010203': '#040506' } },
          'not-a-palette': { warrior: { '#000000': '#ffffff' } },
        },
        version: 2,
      },
    });
    expect([...data.keys()].sort()).toEqual(['appearance.ember', 'appearance.midnight']);
    expect([...appearancePalette('appearance.ember', 'warrior', data)!]).toEqual([
      ['#112233', '#aa0000'],
    ]);
    expect([...appearancePalette('appearance.ember', 'mage', data)!]).toEqual([
      ['#445566', '#00bb00'],
    ]);
    expect([...appearancePalette('appearance.ember', 'hunter', data)!]).toEqual([
      ['#778899', '#0000cc'],
    ]);
    // No entry for the class: own colours.
    expect(appearancePalette('appearance.ember', 'warlock', data)).toBeNull();
    // A palette for every class.
    expect(appearancePalette('appearance.midnight', 'warlock', data)).not.toBeNull();
  });

  it('falls back to own colours: the default, an unknown id, no data at all', () => {
    const empty = readPaletteData({});
    for (const c of COSMETICS.filter((x) => x.kind === 'appearance')) {
      expect(appearancePalette(c.id, 'warrior', empty)).toBeNull();
    }
    expect(appearancePalette(null, 'mage', empty)).toBeNull();
    expect(appearancePalette('appearance.default', 'mage')).toBeNull();
  });

  it('swaps exact colours of opaque pixels only, keeping alpha', () => {
    const px = new Uint8ClampedArray([
      0x11,
      0x22,
      0x33,
      255, // swapped
      0x11,
      0x22,
      0x33,
      0, // transparent: kept
      0x11,
      0x22,
      0x34,
      255, // a near colour: kept
      0x11,
      0x22,
      0x33,
      128, // half alpha: swapped, alpha kept
    ]);
    const changed = applySwap(px, new Map([['#112233', '#aabbcc']]));
    expect(changed).toBe(2);
    expect([...px]).toEqual([
      0xaa, 0xbb, 0xcc, 255, 0x11, 0x22, 0x33, 0, 0x11, 0x22, 0x34, 255, 0xaa, 0xbb, 0xcc, 128,
    ]);
  });

  it('a hero in an appearance without art is drawn exactly as in its own colours', () => {
    const own = renderToStaticMarkup(<HeroLook classId="mage" palette={null} scale={1} alt="x" />);
    for (const id of [
      'appearance.ashen',
      'appearance.ember',
      'appearance.grave-moss',
      'appearance.midnight',
    ]) {
      const look = renderToStaticMarkup(<HeroLook classId="mage" palette={id} scale={1} alt="x" />);
      // Same image; only the pending marker differs while the swap is (not) ready.
      expect(look.replace(/ data-palette="[a-z]+"/, '')).toBe(own);
    }
    const portrait = renderToStaticMarkup(
      <HeroPortrait classId="hunter" banner="ash" scale={1} alt="p" palette="appearance.ember" />,
    );
    expect(portrait).toContain('/assets/characters/hunter');
  });
});

describe('fallbacks while the banner and crest art is missing', () => {
  it('a plain banner, a plain crest rim, no row mark for a plain crest', () => {
    const banner = renderToStaticMarkup(<BannerStyle id="banner.forgeward" scale={2} />);
    expect(banner).toContain('cosm-banner--plain');
    expect(banner).toContain('aria-label="Forgeward banner"');
    expect(renderToStaticMarkup(<BannerStyle id={null} />)).toContain('aria-label="Plain banner"');
    // A wrong kind is never drawn as a banner.
    expect(renderToStaticMarkup(<BannerStyle id="crest.iron" />)).toContain('Plain banner');

    const crest = renderToStaticMarkup(<CrestRim id="crest.gilt">x</CrestRim>);
    expect(crest).toContain('cosm-crest--gilt');
    expect(crest).toContain('cosm-crest--plain');
    expect(renderToStaticMarkup(<CrestMark id={null} />)).toBe('');
    expect(renderToStaticMarkup(<CrestMark id="banner.forgeward" />)).toBe('');
    expect(renderToStaticMarkup(<CrestMark id="crest.bone" />)).toContain('Bone crest');
  });

  it('title colours colour the shown title, season or cosmetic, and nothing else', () => {
    expect(titleColourClass('title-colour.royal')).toBe('cosm-tint cosm-tint--royal');
    expect(titleColourClass('banner.forgeward')).toBe('');
    expect(titleColourClass(null)).toBe('');
    const season = renderToStaticMarkup(
      <ShownTitle
        shown={{
          title: { season: 1, metric: 'level', tier: 'veteran' },
          frame: null,
          titleColour: 'title-colour.ember',
        }}
      />,
    );
    expect(season).toContain('cosm-tint--ember');
    const cosmetic = renderToStaticMarkup(
      <ShownTitle
        shown={{
          title: null,
          frame: null,
          cosmeticTitle: 'title.reaper-of-the-harvest',
          titleColour: 'title-colour.bone-white',
        }}
      />,
    );
    expect(cosmetic).toContain('cosm-tint--bone-white');
    expect(cosmetic).toContain('Reaper of the Harvest');
    // 5.3's title without a colour is unchanged.
    const plain = renderToStaticMarkup(
      <ShownTitle
        shown={{ title: { season: 1, metric: 'level', tier: 'veteran' }, frame: null }}
      />,
    );
    expect(plain).not.toContain('cosm-tint');
    expect(
      renderToStaticMarkup(
        <ShownTitle shown={{ title: null, frame: null, titleColour: 'title-colour.royal' }} />,
      ),
    ).toBe('');
  });
});

const entry = (id: string, owned: boolean): CollectionEntry => {
  const c = findCosmetic(id)!;
  return { ...c, owned, grantedOn: owned ? '2026-11-10' : null };
};

describe('the book', () => {
  const book: Collection = {
    entries: COSMETICS.map((c) =>
      entry(c.id, c.id === 'appearance.default' || c.id === 'banner.harvest-sheaf'),
    ),
    equipped: {
      banner: 'banner.harvest-sheaf',
      crest: null,
      titleColour: null,
      cosmeticTitle: null,
    },
    heroes: [
      { id: 'h1', name: 'Hadwin', classId: 'warrior', banner: 'ash', palette: null },
      { id: 'h2', name: 'Ysolde', classId: 'mage', banner: 'moss', palette: 'appearance.ember' },
    ],
  };

  it('filters by kind and by earned or locked', () => {
    expect(filterEntries(book.entries, 'all', 'all')).toHaveLength(COSMETICS.length);
    expect(filterEntries(book.entries, 'banner', 'all').every((e) => e.kind === 'banner')).toBe(
      true,
    );
    expect(
      filterEntries(book.entries, 'all', 'owned')
        .map((e) => e.id)
        .sort(),
    ).toEqual(['appearance.default', 'banner.harvest-sheaf']);
    expect(filterEntries(book.entries, 'crest', 'locked')).toHaveLength(4);
    expect(counts(book.entries)).toEqual({ owned: 2, total: COSMETICS.length });
  });

  it('knows what each hero and the account wear', () => {
    const def = entry('appearance.default', true);
    const ember = entry('appearance.ember', false);
    expect(isWorn(def, book, 'h1')).toBe(true);
    expect(isWorn(ember, book, 'h1')).toBe(false);
    expect(isWorn(ember, book, 'h2')).toBe(true);
    expect(isWorn(entry('banner.harvest-sheaf', true), book, null)).toBe(true);
    expect(accountSlot('appearance')).toBeNull();
    expect(accountSlot('title')).toBeNull();
    expect(accountSlot('crest')).toBe('crest');
  });

  it('says how to earn every cosmetic, in plain words', () => {
    for (const c of COSMETICS) {
      const words = howToEarn(c.source);
      expect(words.length, c.id).toBeGreaterThan(10);
      expect(words).not.toMatch(/undefined|\[object/);
      expect(sourceLabel(c.source)).toMatch(/^(Default|Event|Deed|Milestone|Season)$/);
    }
    expect(howToEarn(findCosmetic('appearance.ashen')!.source)).toBe('Bring a hero to level 40.');
    expect(howToEarn(findCosmetic('appearance.midnight')!.source)).toContain('Heroic');
    expect(howToEarn(findCosmetic('banner.forgeward')!.source)).toContain(
      'Keeper of the Forgeward',
    );
    expect(howToEarn(findCosmetic('title-colour.royal')!.source)).toContain('Champion');
    expect(BOOK_KINDS.map((k) => KIND_LABELS[k].many)).toEqual([
      'Appearances',
      'Banners',
      'Crests',
      'Title colours',
      'Titles',
    ]);
    expect(equipFailure('not_owned')).toContain('not earned');
  });
});
