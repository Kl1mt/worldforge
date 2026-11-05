import { describe, expect, it } from 'vitest';
import { EMPTY_GUIDE, nextGuideStep, normalizeGuide, withGuideStep } from './index.js';

describe('first-session guide', () => {
  it('adds steps once and keeps guide order', () => {
    let g = withGuideStep(EMPTY_GUIDE, 'equip');
    g = withGuideStep(g, 'character');
    g = withGuideStep(g, 'equip');
    expect(g.steps).toEqual(['character', 'equip']);
    expect(EMPTY_GUIDE.steps).toEqual([]);
  });

  it('names the next step, or null when done', () => {
    expect(nextGuideStep([])).toBe('character');
    expect(nextGuideStep(['character', 'farm'])).toBe('drop');
    expect(nextGuideStep(['character', 'farm', 'drop', 'equip', 'tavern'])).toBeNull();
  });

  it('reads stored values defensively', () => {
    expect(normalizeGuide(null)).toEqual({ steps: [], dismissed: false });
    expect(normalizeGuide({ steps: ['tavern', 'bogus', 'farm'], dismissed: true })).toEqual({
      steps: ['farm', 'tavern'],
      dismissed: true,
    });
  });
});
