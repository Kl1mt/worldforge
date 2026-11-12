import { describe, expect, it } from 'vitest';
import { WORLD_ERAS, getArea } from '@worldforge/game-core';
import { parseRoute } from '../lib/route';
import type { InboxEntry, InboxKind } from './api';
import { dropName, inboxText } from './text';
import { groupByDay } from './InboxScreen';

const entry = (kind: InboxKind, data: Record<string, unknown>) => ({ kind, data });

describe('inbox entries in plain words (ticket 8.5)', () => {
  it('names drops worth seeing with their variant, set and place', () => {
    expect(dropName({ baseId: 'iron-ring', rarityId: 'legendary', variant: 'void' })).toBe(
      'Void Legendary Iron Ring',
    );
    expect(dropName({ baseId: 'vigil-helm', rarityId: 'legendary', setId: 'drowned-vigil' })).toBe(
      'Helm of the Drowned Vigil (set piece)',
    );
    const one = inboxText(
      entry('drop', {
        source: 'farming',
        placeId: 'sunkenAbbey',
        count: 1,
        items: [{ baseId: 'iron-ring', rarityId: 'legendary', variant: 'prismatic' }],
      }),
    );
    expect(one).toMatchObject({ title: 'A Prismatic find', href: '#/inventory' });
    expect(one.text).toBe(`Prismatic Legendary Iron Ring, in ${getArea('sunkenAbbey').name}.`);
    const many = inboxText(
      entry('drop', {
        source: 'crypt',
        placeId: 'nowhere',
        count: 7,
        items: [{ baseId: 'iron-ring', rarityId: 'legendary' }],
      }),
    );
    expect(many.title).toBe('7 finds worth keeping');
    expect(many.text).toBe('Legendary Iron Ring and 6 more, from the field.');
  });

  it('links every kind to its screen', () => {
    const cases: [InboxKind, Record<string, unknown>, string][] = [
      ['trade.received', { offerId: 'o' }, '#/trading'],
      ['trade.accepted', { offerId: 'o' }, '#/trading'],
      ['trade.voided', { offerId: 'o', reason: 'block', side: 'sent' }, '#/trading'],
      ['trade.released', { offerId: 'o', items: 2, gold: 1500 }, '#/trading'],
      [
        'duel.defence',
        { duelId: 'd1', kind: 'rated', outcome: 'held', rating: 12 },
        '#/arena/duel/d1',
      ],
      [
        'event.reward',
        { eventId: 'harvestOfBones', tier: 1, cosmeticId: 'banner.harvest-sheaf' },
        '#/collection',
      ],
      ['season.honours', { season: 2, tiers: ['champion'] }, '#/account'],
      ['guild.honours', { season: 2, tier: 'champion' }, '#/guild'],
      ['world.stage', { projectId: 'restoreWarehouse', stageId: 'clearRubble' }, '#/works'],
      ['world.era', { from: WORLD_ERAS[0]!.id, to: WORLD_ERAS[1]!.id }, '#/hub'],
      ['release', { version: '0.8.4' }, '#/notes'],
    ];
    for (const [kind, data, href] of cases) {
      const t = inboxText(entry(kind, data));
      expect(t.href, kind).toBe(href);
      expect(t.title.length, kind).toBeGreaterThan(0);
      expect(t.text, kind).not.toMatch(/undefined|NaN|\[object/);
    }
    expect(inboxText(entry('trade.released', { items: 2, gold: 1500 })).text).toContain(
      '2 items and 1,500 gold',
    );
    expect(inboxText(entry('trade.voided', { reason: 'block', side: 'sent' })).title).toBe(
      'Your offer was called off',
    );
    expect(
      inboxText(entry('duel.defence', { outcome: 'fell', kind: 'rated', rating: -8 })).text,
    ).toBe('A rated duel was fought against your defence. Rating −8.');
    expect(inboxText(entry('world.era', { to: WORLD_ERAS[1]!.id })).title).toBe(
      `A new era: ${WORLD_ERAS[1]!.name}`,
    );
    expect(inboxText(entry('release', { version: '0.8.4' })).title).toBe('v0.8.4 is out');
  });

  it('never breaks on unexpected data', () => {
    for (const kind of [
      'drop',
      'trade.voided',
      'duel.defence',
      'event.reward',
      'season.honours',
      'guild.honours',
      'world.stage',
      'world.era',
      'release',
      'something.new',
    ] as InboxKind[]) {
      const t = inboxText(entry(kind, { items: 'x', tiers: 5, count: 'many', version: 3 }));
      expect(t.text, kind).not.toMatch(/undefined|NaN|\[object/);
      expect(t.href.startsWith('#/'), kind).toBe(true);
    }
  });

  it('groups by day, keeping the order, and has its own route', () => {
    const at = (iso: string, id: string): InboxEntry => ({
      id,
      kind: 'release',
      data: {},
      createdAt: iso,
      read: false,
    });
    const now = Date.now();
    const groups = groupByDay([
      at(new Date(now).toISOString(), 'a'),
      at(new Date(now - 1000).toISOString(), 'b'),
      at(new Date(now - 3 * 86_400_000).toISOString(), 'c'),
    ]);
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual(
      groups.length === 2 ? [['a', 'b'], ['c']] : [['a'], ['b'], ['c']],
    );
    expect(parseRoute('#/inbox')).toBe('inbox');
  });
});
