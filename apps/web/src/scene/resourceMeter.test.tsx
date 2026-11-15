import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RESOURCE_RULES, RESOURCES, CLASSES } from '@worldforge/game-core';
import { ResourceMeter } from './ResourceMeter';
import {
  changeSlice,
  clampResource,
  pipStates,
  RESOURCE_LOOK,
  resourceChange,
  resourceText,
} from './resourceMeter';

describe('resource meter model (A.18)', () => {
  it('has a look for every resource: pips for Soul Fragments, a bar for the rest', () => {
    for (const r of RESOURCES) expect(RESOURCE_LOOK[r.id], r.id).toBeDefined();
    expect(RESOURCE_LOOK.soulFragments).toBe('pips');
    expect(RESOURCE_LOOK.rage).toBe('bar');
  });

  it('reads a fill and a spend, and nothing when the value did not move', () => {
    expect(resourceChange(20, 35, 100)).toEqual({ kind: 'gain', from: 20, to: 35 });
    expect(resourceChange(80, 30, 100)).toEqual({ kind: 'spend', from: 80, to: 30 });
    expect(resourceChange(40, 40, 100)).toBeNull();
    // Out-of-range values are clamped, so an overfill past the cap shows no change.
    expect(resourceChange(100, 130, 100)).toBeNull();
    expect(resourceChange(10, -5, 100)).toEqual({ kind: 'spend', from: 10, to: 0 });
    expect(clampResource(Number.NaN, 100)).toBe(0);
  });

  it('flashes exactly the slice that moved', () => {
    expect(changeSlice({ kind: 'gain', from: 20, to: 35 }, 100)).toEqual({ left: 20, width: 15 });
    expect(changeSlice({ kind: 'spend', from: 80, to: 30 }, 100)).toEqual({ left: 30, width: 50 });
    expect(changeSlice({ kind: 'spend', from: 3, to: 1 }, 3)).toEqual({ left: 33.3, width: 66.7 });
  });

  it('lights the gained pips and puts out the spent ones', () => {
    const gained = pipStates(2, 3, { kind: 'gain', from: 1, to: 2 });
    expect(gained).toEqual([
      { filled: true, moved: null },
      { filled: true, moved: 'gained' },
      { filled: false, moved: null },
    ]);
    const spent = pipStates(0, 5, { kind: 'spend', from: 4, to: 0 });
    expect(spent.map((p) => p.moved)).toEqual(['spent', 'spent', 'spent', 'spent', null]);
    expect(spent.every((p) => !p.filled)).toBe(true);
  });

  it('writes the value as "Rage 62 / 100"', () => {
    expect(resourceText('Rage', 62, 100)).toBe('Rage 62 / 100');
    expect(resourceText('Soul Fragments', 2.6, 3)).toBe('Soul Fragments 2 / 3');
  });
});

describe('ResourceMeter (A.18)', () => {
  it("draws each class's resource with its name, value and an accessible meter", () => {
    for (const cls of CLASSES) {
      const max = RESOURCE_RULES[cls.id].max;
      const html = renderToStaticMarkup(
        <ResourceMeter resource={cls.resource} current={max} max={max} animate />,
      );
      const name = RESOURCES.find((r) => r.id === cls.resource)!.name;
      expect(html, cls.id).toContain(`aria-valuetext="${name} ${max} / ${max}"`);
      expect(html, cls.id).toContain(`resource-meter--${cls.resource}`);
      expect(html, cls.id).toContain('resource-meter--full');
    }
  });

  it('shows Rage as a bar filled to its share, and fragments as pips', () => {
    const rage = renderToStaticMarkup(
      <ResourceMeter resource="rage" current={62} max={100} animate={false} />,
    );
    expect(rage).toContain('--value:62%');
    expect(rage).not.toContain('resource-meter--anim');
    const soul = renderToStaticMarkup(
      <ResourceMeter resource="soulFragments" current={2} max={3} animate />,
    );
    expect(soul.match(/resource-meter__pip--on/g)).toHaveLength(2);
    expect(soul.match(/<span class="resource-meter__pip/g)).toHaveLength(3);
    // A first render has nothing to flash.
    expect(soul).not.toContain('resource-meter__pip--gained');
  });
});
