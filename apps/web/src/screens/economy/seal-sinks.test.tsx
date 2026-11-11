import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COSMETIC_EXCHANGE, ENGRAVINGS, findCosmetic } from '@worldforge/game-core';
import type { ItemDto } from '../../game/api';
import { engravingView, toItemView } from '../../game/items';
import { ItemTooltip } from '../../components/ItemTooltip';
import { ART_TINTS, bannerStyleSprite, crestStyleSprite } from '../../content/appearance';
import { BannerStyle, CrestRim, titleColourClass } from '../../cosmetics/Cosmetics';
import { howToEarn, sourceLabel } from '../../cosmetics/text';
import { EngravePanel } from './EngravePanel';
import { ExchangePanel } from './ExchangePanel';

/** Ticket 6.11: the engraver's words in the tooltip, the exchange's art and the two panels. */

const dto = (over: Partial<ItemDto> = {}): ItemDto => ({
  id: 'i1',
  baseId: 'longsword',
  rarityId: 'epic',
  itemLevel: 30,
  affixes: [],
  equippedSlot: null,
  source: 'farming',
  createdAt: '2026-11-04T12:00:00.000Z',
  upgradeLevel: 0,
  variant: null,
  effectId: null,
  effectRoll: null,
  setId: null,
  mythicId: null,
  locked: false,
  binding: 'equip',
  bindingReason: 'fresh',
  tradeable: true,
  ...over,
});

const css = (rel: string) => readFileSync(join(import.meta.dirname, rel), 'utf8');

describe('engravings in the tooltip', () => {
  it('reads the stored key into words and a finish; unknown keys show nothing', () => {
    expect(engravingView('seal:ashbound')).toEqual({ text: 'Ashbound', finish: 'seal' });
    expect(engravingView('silver:long-dusk')).toEqual({
      text: 'Of the Long Dusk',
      finish: 'silver',
    });
    expect(engravingView('seal:gone')).toBeNull();
    expect(engravingView(undefined)).toBeNull();
  });

  it('shows the words in the finish’s colour, and nothing for an unengraved item', () => {
    const sealed = renderToStaticMarkup(
      <ItemTooltip item={toItemView(dto({ engraving: 'seal:unbowed' }))} />,
    );
    expect(sealed).toContain('tooltip__engraving--seal');
    expect(sealed).toContain('Pressed in seal-wax');
    expect(sealed).toContain('“Unbowed”');
    const inlaid = renderToStaticMarkup(
      <ItemTooltip item={toItemView(dto({ engraving: 'silver:unbowed' }))} />,
    );
    expect(inlaid).toContain('Inlaid in silver');
    const plain = renderToStaticMarkup(<ItemTooltip item={toItemView(dto())} />);
    expect(plain).not.toContain('tooltip__engraving');
    // Cosmetic only: the item's numbers are the same either way.
    expect(toItemView(dto({ engraving: 'seal:unbowed' })).base).toEqual(toItemView(dto()).base);
    expect(css('../../components/item-tooltip.css')).toContain('.tooltip__engraving--silver');
  });
});

describe('the exchange’s art (no new art: A.13’s, tinted)', () => {
  it('draws every banner and crest offer with existing art and a tint, every colour in CSS', () => {
    const cosmetics = css('../../cosmetics/cosmetics.css');
    for (const o of COSMETIC_EXCHANGE) {
      const c = findCosmetic(o.cosmeticId)!;
      const name = c.id.slice(c.id.indexOf('.') + 1);
      if (c.kind === 'titleColour') {
        expect(titleColourClass(c.id)).toBe(`cosm-tint cosm-tint--${name}`);
        expect(cosmetics, c.id).toContain(`.cosm-tint--${name} {`);
        continue;
      }
      const art = c.kind === 'banner' ? bannerStyleSprite(c.id) : crestStyleSprite(c.id);
      expect(art, c.id).not.toBeNull();
      expect(ART_TINTS[c.id], c.id).toBeDefined();
      expect(cosmetics, c.id).toMatch(
        new RegExp(`\\.cosm-(banner|crest)--${name} \\.cosm-(banner__device|crest__frame)`),
      );
    }
    const banner = renderToStaticMarkup(<BannerStyle id="banner.silvered-seal" />);
    expect(banner).toContain('cosm-banner--silvered-seal');
    expect(banner).toContain('/assets/banners/crypt-seal.png');
    const crest = renderToStaticMarkup(<CrestRim id="crest.seal-wax" />);
    expect(crest).toContain('cosm-crest--seal-wax');
    expect(crest).toContain('crest-iron.png');
  });

  it('says in the book where an exchange entry comes from', () => {
    expect(sourceLabel({ kind: 'exchange' })).toBe('Exchange');
    expect(howToEarn({ kind: 'exchange' })).toContain('Forge’s exchange');
  });
});

describe('the panels', () => {
  it('the engraver: an empty state without gear, a loading state while it quotes', () => {
    const empty = renderToStaticMarkup(
      <EngravePanel
        heroId="h"
        equipped={[]}
        pack={[]}
        materials={[]}
        onApplied={() => undefined}
        onNotice={() => undefined}
      />,
    );
    expect(empty).toContain('Nothing to engrave.');
    const loading = renderToStaticMarkup(
      <EngravePanel
        heroId="h"
        equipped={[toItemView(dto({ equippedSlot: 'weapon' }))]}
        pack={[]}
        materials={[]}
        onApplied={() => undefined}
        onNotice={() => undefined}
      />,
    );
    expect(loading).toContain('Your gear');
    expect(loading).toContain('The engraver squints at it…');
    expect(ENGRAVINGS.length).toBeGreaterThanOrEqual(10);
  });

  it('the exchange: a loading state while it fetches the offers', () => {
    const html = renderToStaticMarkup(
      <ExchangePanel
        heroId="h"
        banner="ash"
        onBought={() => undefined}
        onNotice={() => undefined}
      />,
    );
    expect(html).toContain('Laying out the wares…');
  });
});
