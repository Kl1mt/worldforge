import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CLASS_IDS, COSMETICS, findCosmetic } from '@worldforge/game-core';
import { ART_TINTS, appearancePalette } from '../content/appearance';
import { HeroPortrait } from '../characters/HeroPortrait';
import { ShownTitle } from '../social/Prestige';
import { BannerStyle, CrestMark, CrestRim, HeroLook, titleColourClass } from './Cosmetics';
import { accountSlot, counts, filterEntries, isWorn } from './book';
import { BOOK_KINDS, KIND_LABELS, equipFailure, howToEarn, sourceLabel } from './text';
import type { Collection, CollectionEntry } from './api';

/** Ticket 6.8: the collection book on the web (docs/COSMETICS.md). */

describe('palettes (A.13) on every class', () => {
  it('every appearance has a swap for every class; the default and unknown ids have none', () => {
    for (const c of COSMETICS.filter((x) => x.kind === 'appearance')) {
      for (const classId of CLASS_IDS) {
        const swap = appearancePalette(c.id, classId);
        if (c.id === 'appearance.default') expect(swap).toBeNull();
        else {
          expect(swap?.size, `${c.id} ${classId}`).toBeGreaterThan(0);
          for (const [from, to] of swap!) {
            expect(from).toMatch(/^#[0-9a-f]{6}$/);
            expect(to).toMatch(/^#[0-9a-f]{6}$/);
          }
        }
      }
    }
    expect(appearancePalette('appearance.velvet', 'mage')).toBeNull();
    expect(appearancePalette(null, 'mage')).toBeNull();
    // Cached: the same object each time (the swap cache keys on it).
    expect(appearancePalette('appearance.ember', 'mage')).toBe(
      appearancePalette('appearance.ember', 'mage'),
    );
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

describe('banner and crest art (A.13), and the fallbacks without it', () => {
  it('draws the art of every banner and crest style', () => {
    // Ticket 6.11: the exchange's styles draw another style's art, tinted (`ART_TINTS`).
    const art = (id: string) => ART_TINTS[id] ?? id;
    for (const c of COSMETICS.filter((x) => x.kind === 'banner')) {
      const html = renderToStaticMarkup(<BannerStyle id={c.id} scale={2} />);
      expect(html, c.id).toContain(`/assets/banners/${art(c.id).slice('banner.'.length)}.png`);
      expect(html).not.toContain('cosm-banner--plain');
    }
    for (const c of COSMETICS.filter((x) => x.kind === 'crest')) {
      const html = renderToStaticMarkup(<CrestRim id={c.id}>x</CrestRim>);
      expect(html, c.id).toContain(`/assets/crests/crest-${art(c.id).slice('crest.'.length)}.png`);
      expect(html).toContain('width="96"'); // 48 px at ×2
    }
  });

  it('a plain banner, a plain crest rim, no row mark for no crest', () => {
    expect(renderToStaticMarkup(<BannerStyle id={null} />)).toContain('aria-label="Plain banner"');
    expect(renderToStaticMarkup(<BannerStyle id={null} />)).toContain('cosm-banner--plain');
    // A wrong kind or an unknown id is never drawn as a banner or crest.
    expect(renderToStaticMarkup(<BannerStyle id="crest.iron" />)).toContain('cosm-banner--plain');
    expect(renderToStaticMarkup(<BannerStyle id="banner.velvet" />)).toContain('Plain banner');
    const none = renderToStaticMarkup(<CrestRim id={null}>x</CrestRim>);
    expect(none).toContain('cosm-crest--plain');
    expect(none).not.toContain('<img');
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
    // Four crests earned in play, two from the exchange (6.11), one from the Procession (8.3).
    expect(filterEntries(book.entries, 'crest', 'locked')).toHaveLength(7);
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
      expect(sourceLabel(c.source)).toMatch(/^(Default|Event|Deed|Milestone|Season|Exchange)$/);
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
