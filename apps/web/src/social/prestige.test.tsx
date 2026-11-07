import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRESTIGE_TIERS, SCORE_METRICS, SEASON_TITLES } from '@worldforge/game-core';
import { prestigeSprite } from '../content/assets';
import { FrameMark, FramedPlate, PrestigeFrame, TitleBadge } from './Prestige';
import { daysLeft, seasonSpan } from './seasons';

/** Ticket 5.3: prestige marks with A.10's art (and the CSS rim for rows). */
describe('prestige marks', () => {
  it("every fixed asset name resolves to A.10's art; marks draw it, frames at an integer scale", () => {
    for (const t of PRESTIGE_TIERS) {
      const sprite = prestigeSprite(t.frameAsset)!;
      expect(sprite.path).toBe(`/assets/frames/${t.frameAsset}.png`);
      expect([sprite.width, sprite.height]).toEqual([64, 64]);
    }
    for (const m of SCORE_METRICS) {
      expect(prestigeSprite(SEASON_TITLES[m].badgeAsset)!.path).toBe(
        `/assets/badges/${SEASON_TITLES[m].badgeAsset}.png`,
      );
    }
    expect(prestigeSprite('nothing-here')).toBeNull();
    const badge = renderToStaticMarkup(
      <TitleBadge badge={{ season: 2, metric: 'pveProgress', tier: 'exalted' }} />,
    );
    expect(badge).toContain('Exalted Pathfinder');
    expect(badge).toContain('Season 2');
    expect(badge).toContain('/assets/badges/title-badge-pve-progress.png');
    const row = renderToStaticMarkup(
      <TitleBadge badge={{ season: 2, metric: 'power', tier: 'veteran' }} compact />,
    );
    expect(row).toContain('width="24"');
    const plate = renderToStaticMarkup(
      <FramedPlate frame={{ season: 1, metric: 'level', tier: 'champion' }} scale={4}>
        <span>portrait</span>
      </FramedPlate>,
    );
    expect(plate).toContain('/assets/frames/season-frame-champion.png');
    expect(plate).toContain('width:256px');
    // The window: (14, 14) 36×36 native, ×4.
    expect(plate).toContain('left:56px;top:56px;width:144px;height:144px');
    const rim = renderToStaticMarkup(
      <PrestigeFrame frame={{ season: 1, metric: 'level', tier: 'champion' }}>
        Ravenna
      </PrestigeFrame>,
    );
    expect(rim).toContain('honourframe--champion');
    expect(rim).toContain('Ravenna');
  });

  it('shows nothing for no title or frame', () => {
    expect(renderToStaticMarkup(<TitleBadge badge={null} />)).toBe('');
    expect(renderToStaticMarkup(<FrameMark frame={null} />)).toBe('');
    expect(renderToStaticMarkup(<PrestigeFrame frame={null}>Name</PrestigeFrame>)).toBe('Name');
    expect(
      renderToStaticMarkup(
        <FramedPlate frame={null} scale={1}>
          x
        </FramedPlate>,
      ),
    ).toBe('');
  });

  it('season spans show UTC days, the end exclusive', () => {
    expect(
      seasonSpan({ startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2027-01-04T00:00:00.000Z' }),
    ).toBe('9 Nov 2026 – 3 Jan 2027');
    expect(daysLeft('2026-11-10T00:00:00.000Z', '2026-11-09T12:00:00.000Z')).toBe(1);
    expect(daysLeft('2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z')).toBe(0);
  });
});
