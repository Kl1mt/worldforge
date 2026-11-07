import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRESTIGE_TIERS, SCORE_METRICS, SEASON_TITLES } from '@worldforge/game-core';
import { prestigeSprite } from '../content/assets';
import { FrameMark, PrestigeFrame, TitleBadge } from './Prestige';
import { daysLeft, seasonSpan } from './seasons';

/** Ticket 5.3: prestige marks and the art fallback (A.10 draws the art in parallel). */
describe('prestige marks', () => {
  it('until A.10 lands, the fixed asset names resolve to nothing and the UI falls back', () => {
    const names = [
      ...PRESTIGE_TIERS.map((t) => t.frameAsset),
      ...SCORE_METRICS.map((m) => SEASON_TITLES[m].badgeAsset),
    ];
    for (const n of names) {
      const sprite = prestigeSprite(n);
      // Either not drawn yet (null) or registered where A.10 puts it.
      if (sprite) expect(sprite.path).toBe(`/assets/prestige/${n}.png`);
    }
    const badge = renderToStaticMarkup(
      <TitleBadge badge={{ season: 2, metric: 'pveProgress', tier: 'exalted' }} />,
    );
    expect(badge).toContain('Exalted Pathfinder');
    expect(badge).toContain('Season 2');
    expect(badge).toContain('honour--exalted');
    if (!prestigeSprite('title-badge-pve-progress')) expect(badge).toContain('honour__lozenge');
    const frame = renderToStaticMarkup(
      <PrestigeFrame frame={{ season: 1, metric: 'level', tier: 'champion' }}>
        Ravenna
      </PrestigeFrame>,
    );
    expect(frame).toContain('honourframe--champion');
    expect(frame).toContain('Ravenna');
  });

  it('shows nothing for no title or frame', () => {
    expect(renderToStaticMarkup(<TitleBadge badge={null} />)).toBe('');
    expect(renderToStaticMarkup(<FrameMark frame={null} />)).toBe('');
    expect(renderToStaticMarkup(<PrestigeFrame frame={null}>Name</PrestigeFrame>)).toBe('Name');
  });

  it('season spans show UTC days, the end exclusive', () => {
    expect(
      seasonSpan({ startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2027-01-04T00:00:00.000Z' }),
    ).toBe('9 Nov 2026 – 3 Jan 2027');
    expect(daysLeft('2026-11-10T00:00:00.000Z', '2026-11-09T12:00:00.000Z')).toBe(1);
    expect(daysLeft('2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z')).toBe(0);
  });
});
