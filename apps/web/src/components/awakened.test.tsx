import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ItemDto } from '../game/api';
import { toItemView, type AwakenedView } from '../game/items';
import { AwakenPanel, awakenCandidates } from '../screens/economy/AwakenPanel';
import { ItemFrame } from './ItemFrame';
import { ItemTooltip } from './ItemTooltip';
import { AWAKENED_MARK, VARIANT_MARK, emberClass } from './itemVariant';

/** Ticket 6.5b: the awakened mark, tooltip line and the Forge's awaken panel. */

const AWAKE = { option: 'effect', effectStrength: 1.1 } as const;
const dto = (over: Partial<ItemDto>): ItemDto => ({
  id: 'i1',
  baseId: 'iron-ring',
  rarityId: 'legendary',
  itemLevel: 37,
  affixes: [],
  equippedSlot: null,
  source: 'farming',
  createdAt: '2026-11-04T12:00:00.000Z',
  upgradeLevel: 10,
  variant: null,
  effectId: 'tyrants-bane',
  effectRoll: 0.5,
  setId: null,
  mythicId: null,
  locked: false,
  binding: 'account',
  bindingReason: 'forged',
  tradeable: false,
  ...over,
});
const awakened: AwakenedView = { bonus: 0.1, kind: 'effect', at: null };
const frame = (over: { variant?: 'void' | 'prismatic'; awake?: boolean } = {}) =>
  renderToStaticMarkup(
    <ItemFrame
      item={{
        icon: 'item.cinderforged-blade',
        name: 'Cinderforged Blade',
        rarity: 'legendary',
        upgradeLevel: 10,
        variant: over.variant
          ? {
              id: over.variant,
              name: over.variant === 'void' ? 'Void' : 'Prismatic',
              implicitBonus: 0.1,
              effectBonus: 0,
              affixBonus: 0,
            }
          : null,
        awakened: over.awake === false ? null : awakened,
      }}
      scale={2}
      shimmer="still"
    />,
  );

describe('the awakened item frame', () => {
  it('draws the ember and the sigil ☼, a shape distinct from Void and Prismatic', () => {
    expect(AWAKENED_MARK).toBe('☼');
    expect(Object.values(VARIANT_MARK)).not.toContain(AWAKENED_MARK);
    const html = frame();
    expect(html).toContain('item-frame--awakened');
    expect(html).toContain('item-frame__ember');
    expect(html).toContain('☼');
    expect(html).toContain('aria-label="Cinderforged Blade +10, awakened legendary"');
    const plain = frame({ awake: false });
    expect(plain).not.toContain('item-frame--awakened');
    expect(plain).not.toContain('☼');
  });

  it('keeps a variant’s own treatment and mark beside it', () => {
    const v = frame({ variant: 'void' });
    expect(v).toContain('item-frame--void');
    expect(v).toContain('◇');
    expect(v).toContain('☼');
    const p = frame({ variant: 'prismatic' });
    expect(p).toContain('item-frame__prism--tint');
    expect(p).toContain('✧');
    expect(p).toContain('☼');
  });

  it('pulses only when motion is allowed (automation and the override keep it still)', () => {
    expect(emberClass('auto', { automated: false, override: null })).toBe('item-frame--ember');
    expect(emberClass('auto', { automated: true, override: null })).toBe('');
    expect(emberClass('auto', { automated: false, override: 'off' })).toBe('');
    expect(emberClass('still')).toBe('');
    expect(emberClass('forced', { automated: true, override: 'off' })).toBe(
      'item-frame--ember-forced',
    );
    const css = readFileSync(new URL('./item-frame.css', import.meta.url), 'utf8');
    // Under reduced motion nothing moves: the only unforced animation is inside no-preference.
    const outside = css.replace(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g,
      '',
    );
    expect(outside).not.toMatch(/\.item-frame--ember \.item-frame__ember\s*\{[^}]*animation/);
    expect(css).toMatch(/animation: item-ember-breathe [\d.]+s steps\(\d+\) infinite/);
  });
});

describe('the item view and tooltip', () => {
  it('reads the awakened numbers (× 1.1, and × 1.21 on Void)', () => {
    const plain = toItemView(dto({}));
    expect(plain.awakened).toBeNull();
    expect(plain.effect?.text).toBe('Deal 15 % more damage to bosses.');
    const awake = toItemView(dto({ awakening: AWAKE, awakenedAt: '2026-11-10T10:00:00.000Z' }));
    expect(awake.awakened).toEqual({ bonus: 0.1, kind: 'effect', at: '2026-11-10T10:00:00.000Z' });
    expect(awake.effect?.text).toBe('Deal 16.5 % more damage to bosses.');
    const voidAwake = toItemView(dto({ awakening: AWAKE, variant: 'void' }));
    expect(voidAwake.effect?.text).toBe('Deal 18.2 % more damage to bosses.');
    // A set piece's awakening counts toward its set.
    const piece = toItemView(
      dto({ baseId: 'vigil-helm', setId: 'drowned-vigil', effectId: null, awakening: AWAKE }),
    );
    expect(piece.awakened?.kind).toBe('set');
  });

  it('says it is awakened, permanent and never tradeable', () => {
    const view = toItemView(
      dto({ awakening: AWAKE, bindingReason: 'awakened', binding: 'account' }),
    );
    const html = renderToStaticMarkup(<ItemTooltip item={view} />);
    expect(html).toContain('data-awakened="true"');
    expect(html).toContain('☼ Awakened');
    expect(html).toContain('Its effect counts +10 %');
    expect(html).toContain('Permanent.');
    expect(html).toContain('Awakened items are bound for good and can never be traded.');
    const plain = renderToStaticMarkup(<ItemTooltip item={toItemView(dto({}))} />);
    expect(plain).not.toContain('Awakened');
  });
});

describe('the awaken panel', () => {
  it('lists only items the rule allows, and the awakened ones apart', () => {
    const ready = toItemView(dto({ id: 'ready' }));
    const done = toItemView(dto({ id: 'done', awakening: AWAKE }));
    const at9 = toItemView(dto({ id: 'at9', upgradeLevel: 9 }));
    const low = toItemView(dto({ id: 'low', itemLevel: 22 }));
    const epic = toItemView(dto({ id: 'epic', rarityId: 'epic', effectId: null }));
    const c = awakenCandidates([ready, done, at9, low, epic]);
    expect(c.ready.map((i) => i.id)).toEqual(['ready']);
    expect(c.done.map((i) => i.id)).toEqual(['done']);
  });

  it('explains the rite when nothing is ready (empty state)', () => {
    const html = renderToStaticMarkup(
      <AwakenPanel
        heroId="h"
        heroName="Hralda"
        classId="warrior"
        gold={0}
        equipped={[toItemView(dto({ id: 'e', upgradeLevel: 4, equippedSlot: 'ring1' }))]}
        pack={[]}
        materials={[]}
        onApplied={() => undefined}
        onNotice={() => undefined}
      />,
    );
    expect(html).toContain('No item is ready to awaken.');
    expect(html).toContain('+10 Legendary, Mythic or set item of item level 23 or higher');
    expect(html).toContain('3 Tyrant’s Embers, 2 Gravewarden’s Seals');
  });

  it('shows the loading state while it fetches the quote', () => {
    const html = renderToStaticMarkup(
      <AwakenPanel
        heroId="h"
        heroName="Hralda"
        classId="warrior"
        gold={0}
        equipped={[toItemView(dto({ id: 'e', equippedSlot: 'ring1' }))]}
        pack={[]}
        materials={[]}
        onApplied={() => undefined}
        onNotice={() => undefined}
      />,
    );
    expect(html).toContain('Ready to awaken');
    expect(html).toContain('Banking the coals…');
  });
});
