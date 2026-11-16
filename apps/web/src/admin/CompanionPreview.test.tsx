import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COMPANION_IDS } from '../content/assets';
import { CompanionPreview } from './CompanionPreview';

describe('the gallery’s Companions section (A.19)', () => {
  it('plays every companion’s idle and shows the lit shrine over the cold one', () => {
    const html = renderToStaticMarkup(<CompanionPreview scale={2} />);
    for (const id of COMPANION_IDS) expect(html, id).toContain(id);
    // One played idle (a two-frame sheet in a one-frame window) per companion, at the scale.
    expect(html.match(/anim-gallery__companion-idle/g)).toHaveLength(COMPANION_IDS.length);
    expect(html.match(/pixel-sheet__strip/g)).toHaveLength(COMPANION_IDS.length);
    expect(html).toContain('width="128" height="64"'); // the 64 × 32 strip at ×2
    expect(html).toContain('/assets/hub/shrine-lit.png');
    expect(html).toContain('/assets/hub/graumark.png');
    expect(html).not.toContain('No art');
  });
});
