import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SkillsResponse } from '../game/skills';
import { SkillGlyph, SkillsPanel } from './SkillsPanel';
import { getActiveSkill } from '@worldforge/game-core';

/** Ticket 9.2: the Skills screen on the character page (static render, no fetch). */

const view = (over: Partial<SkillsResponse> = {}): SkillsResponse => ({
  characterId: 'hero-1',
  classId: 'warrior',
  level: 12,
  resource: { max: 100, start: 0 },
  activePreset: 1,
  inForce: { actives: ['heavyStrike', 'shieldSlam', null], passive: 'unyielding' },
  presets: [
    {
      preset: 1,
      actives: ['heavyStrike', 'shieldSlam', null],
      passive: 'unyielding',
      isDefault: false,
      problems: [],
    },
    {
      preset: 2,
      actives: ['heavyStrike', null, null],
      passive: null,
      isDefault: true,
      problems: [],
    },
    {
      preset: 3,
      actives: ['heavyStrike', null, null],
      passive: null,
      isDefault: true,
      problems: [],
    },
  ],
  unlocked: ['heavyStrike', 'shieldSlam', 'charge', 'unyielding'],
  soulFragments: 0,
  ...over,
});

describe('Skills panel', () => {
  it('shows a loading state before the first answer', () => {
    const html = renderToStaticMarkup(<SkillsPanel characterId="hero-1" level={12} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Opening the skill book');
  });

  it('shows the resource, the 3 + 1 slots, the presets and the whole book', () => {
    const html = renderToStaticMarkup(
      <SkillsPanel characterId="hero-1" level={12} initial={view()} />,
    );
    expect(html).toContain('Rage (up to 100) starts empty');
    expect(html).toContain('Class skill (slot 1)');
    expect(html).toContain('Spender (slot 2)');
    expect(html).toContain('Spender (slot 3)');
    expect(html).toContain('Passive');
    expect(html).toContain('your class skill (slot 1)');
    // Three presets, the first in force.
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('In force');
    expect(html).toContain('Your hero fights with this loadout.');
    // Locked skills are shown with their unlock, never hidden.
    expect(html).toContain('Earthsplitter');
    expect(html).toContain('Unlocks at level 36');
    expect(html).toContain('Taught by the Tyrant’s Lesson (Tavern) · level 36');
    expect(html).toContain('Taught by the Sovereign’s Lesson (Tavern) · level 46');
    expect(html.match(/skill skill--locked/g)?.length).toBe(12 - 4);
    expect(html).toContain('50 Rage · 160 % damage');
    // The snapshot note.
    expect(html).toContain('refresh your defence in the Arena');
  });

  it('warns about a stored preset that cannot be fielded now', () => {
    const v = view();
    v.presets[0] = { ...v.presets[0]!, problems: ['shieldSlam is locked'] };
    const html = renderToStaticMarkup(<SkillsPanel characterId="hero-1" level={12} initial={v} />);
    expect(html).toContain('cannot be fielded (Shield Slam is locked)');
  });

  it('draws the skill’s A.18 icon, and a framed empty slot without a skill', () => {
    const html = renderToStaticMarkup(<SkillGlyph skill={getActiveSkill('shieldSlam')!} />);
    expect(html).toContain('skill-glyph__art');
    expect(html).not.toContain('skill-glyph--spender');
    expect(renderToStaticMarkup(<SkillGlyph skill={null} />)).toContain('skill-glyph--empty');
  });
});
