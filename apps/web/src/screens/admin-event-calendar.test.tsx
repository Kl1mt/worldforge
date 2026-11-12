import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AdminEvents } from '../admin/api';
import { ART_TINTS, appearancePalette, bannerStyleSprite } from '../content/appearance';
import { EventCalendarPanel, plannedTag } from './AdminEventCalendar';

/** Ticket 8.3: the automatic calendar in the admin panel and the Procession's keepsake art. */

const view = (over: Partial<AdminEvents['calendar']> = {}): AdminEvents => ({
  now: '2031-01-06T00:00:00.000Z',
  definitions: [
    { id: 'harvestOfBones', name: 'Harvest of Bones', tagline: '', defaultDays: 7, minDays: 0 },
    {
      id: 'lanternProcession',
      name: 'The Lantern Procession',
      tagline: '',
      defaultDays: 28,
      minDays: 28,
    },
  ],
  current: null,
  next: null,
  past: [],
  counts: [],
  calendar: {
    paused: true,
    saved: false,
    rotation: [
      { definitionId: 'lanternProcession', name: 'The Lantern Procession', days: 28 },
      { definitionId: 'harvestOfBones', name: 'Harvest of Bones', days: 7 },
    ],
    gapDays: 7,
    nextIndex: 0,
    createdCount: 0,
    skipToken: '0.0.0',
    updatedAt: null,
    planned: [
      {
        definitionId: 'lanternProcession',
        name: 'The Lantern Procession',
        startsAt: '2031-01-06T01:00:00.000Z',
        endsAt: '2031-02-03T01:00:00.000Z',
        kind: 'rotation',
        number: null,
        source: null,
      },
      {
        definitionId: 'harvestOfBones',
        name: 'Harvest of Bones',
        startsAt: '2031-02-10T01:00:00.000Z',
        endsAt: '2031-02-17T01:00:00.000Z',
        kind: 'rotation',
        number: null,
        source: null,
      },
    ],
    ...over,
  },
});

const render = (v: AdminEvents) =>
  renderToStaticMarkup(
    <EventCalendarPanel view={v} busy={false} onSet={() => undefined} onSkip={() => undefined} />,
  );

describe('the automatic calendar panel', () => {
  it('paused: says so, offers to turn it on, shows the next planned as held', () => {
    const html = render(view());
    expect(html).toContain('Paused');
    expect(html).toContain('Nothing is put on the calendar automatically');
    expect(html).toContain('Turn on…');
    expect(html).not.toContain('>Pause<');
    expect(html).toContain('evcal__plan--held');
    expect(html).toContain('From the rotation, once the calendar is on');
    expect(html).toContain('Mon, 6 Jan 2031, 01:00 → Mon, 3 Feb 2031, 01:00 UTC');
    // The rotation in order, the next entry marked, the gap.
    expect(html.indexOf('value="lanternProcession" selected')).toBeLessThan(
      html.indexOf('value="harvestOfBones" selected'),
    );
    expect(html).toContain('>Next<');
    expect(html).toContain('value="7"');
  });

  it('on: offers to pause; scheduled events say where they came from', () => {
    const html = render(
      view({
        paused: false,
        planned: [
          {
            definitionId: 'lanternProcession',
            name: 'The Lantern Procession',
            startsAt: '2031-01-06T01:00:00.000Z',
            endsAt: '2031-02-03T01:00:00.000Z',
            kind: 'scheduled',
            number: 4,
            source: 'calendar',
          },
        ],
      }),
    );
    expect(html).toContain('>On<');
    expect(html).toContain('>Pause<');
    expect(html).toContain('7 days after its end');
    expect(html).toContain('Event 4, put on the calendar automatically');
    expect(
      plannedTag(
        { ...view().calendar.planned[0]!, kind: 'scheduled', number: 2, source: 'manual' },
        false,
      ),
    ).toBe('Event 2, scheduled by hand');
    expect(plannedTag(view().calendar.planned[0]!, false)).toBe('From the rotation');
  });

  it('8.3b: says automatic events start on Mondays; a weekly event below its weeks is refused', () => {
    const html = render(view({ paused: false }));
    expect(html).toContain('first Monday (00:00 UTC) at least 7 days after its end');
    expect(html).toContain('min="28"');
    expect(html).not.toContain('role="alert"');
    // A saved rotation the server would now refuse (shown as the form starts from it).
    const short = render(
      view({
        rotation: [{ definitionId: 'lanternProcession', name: 'The Lantern Procession', days: 21 }],
      }),
    );
    expect(short).toContain(
      'The Lantern Procession runs over 4 weeks, so it must last at least 28 days.',
    );
  });

  it('an empty rotation plans nothing and cannot be turned on or skipped', () => {
    const html = render(view({ rotation: [], planned: [] }));
    expect(html).toContain('Nothing planned: the rotation is empty.');
    expect(html).toContain('No events in the rotation');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Turn on…/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Skip the next one…/);
  });

  it('scopes its classes', () => {
    const css = readFileSync(join(import.meta.dirname, 'admin-events.css'), 'utf8');
    const added = css.slice(css.indexOf('Ticket 8.3'));
    for (const m of added.matchAll(/^\.([a-z][\w-]*)/gm)) expect(m[1]).toMatch(/^evcal/);
  });
});

describe('the Lantern Procession keepsakes reuse existing art', () => {
  it('banners and the crest draw A.13 art (tinted in CSS); the look has a palette per class', () => {
    expect(ART_TINTS['banner.procession-lantern']).toBe('banner.warden-flame');
    expect(ART_TINTS['banner.hollow-procession']).toBe('banner.ember-standard');
    expect(ART_TINTS['crest.lantern-brass']).toBe('crest.iron');
    expect(bannerStyleSprite('banner.procession-lantern')).not.toBeNull();
    for (const c of ['warrior', 'mage', 'hunter', 'warlock'] as const)
      expect(appearancePalette('appearance.lantern-bearer', c)?.size ?? 0).toBeGreaterThan(0);
    const css = readFileSync(join(import.meta.dirname, '../cosmetics/cosmetics.css'), 'utf8');
    for (const cls of [
      '.cosm-tint--wick-amber',
      '.cosm-tint--deep-lantern',
      '.cosm-banner--procession-lantern',
      '.cosm-banner--hollow-procession',
      '.cosm-crest--lantern-brass',
    ])
      expect(css).toContain(cls);
  });
});
