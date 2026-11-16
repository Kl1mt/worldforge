import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COSMETICS, SHRINE_POOL, findCosmetic } from '@worldforge/game-core';
import { companionSprite, shrineSprite } from '../content/assets';
import { Companion, titleColourClass } from '../cosmetics/Cosmetics';
import { isWorn, accountSlot } from '../cosmetics/book';
import { BOOK_KINDS, howToEarn, sourceLabel } from '../cosmetics/text';
import { RevealCard } from '../screens/ShrineScreen';
import { bankLine, drawLine, drawsWord, percent, shrineFailure } from './text';

/** Ticket 9.5: the Shrine's words, the companion display and its fallbacks, the reveal card. */

const css = (rel: string) => readFileSync(join(import.meta.dirname, rel), 'utf8');

describe('the Shrine’s words', () => {
  it('prints the odds as published', () => {
    expect(percent(0.7)).toBe('70 %');
    expect(percent(0.7 / 6)).toBe('11.667 %');
    expect(percent(0.05 / 3)).toBe('1.667 %');
    expect(percent(0.25 / 6)).toBe('4.167 %');
  });

  it('counts draws and the bank in plain words', () => {
    expect(drawsWord(1)).toBe('1 draw');
    expect(drawsWord(3)).toBe('3 draws');
    const now = new Date('2026-11-16T21:30:00Z');
    expect(bankLine(3, 7, '2026-11-17T00:00:00.000Z', now)).toBe(
      '3 of 7 free draws kept. The next comes in 2 h 30 min (midnight UTC).',
    );
    expect(bankLine(7, 7, null, now)).toMatch(/full \(7 of 7\)/);
    expect(drawLine('Bone rat', 'grant', 0)).toMatch(/is yours/);
    expect(drawLine('Bone rat', 'marks', 2)).toMatch(/2 Shrine marks/);
    expect(shrineFailure('no_draws')).toMatch(/free one comes every day/);
    expect(shrineFailure('something')).toMatch(/Try again/);
  });

  it('says where every Shrine keepsake comes from, and names no price in money', () => {
    for (const e of SHRINE_POOL) {
      const c = findCosmetic(e.cosmeticId)!;
      expect(howToEarn(c.source)).toMatch(/Summoning Shrine/);
      expect(sourceLabel(c.source)).toBe('Shrine');
      expect(howToEarn(c.source)).not.toMatch(/€|\$|buy draws/i);
    }
  });
});

describe('companions in the book', () => {
  it('have their own tab and are worn on the account', () => {
    expect(BOOK_KINDS).toContain('companion');
    expect(accountSlot('companion')).toBe('companion');
    const id = SHRINE_POOL.find((e) => e.kind === 'companion')!.cosmeticId;
    const entry = {
      id,
      kind: 'companion' as const,
      name: 'x',
      description: 'x',
      source: findCosmetic(id)!.source,
      owned: true,
      grantedOn: null,
    };
    const book = {
      entries: [entry],
      equipped: {
        banner: null,
        crest: null,
        titleColour: null,
        cosmeticTitle: null,
        companion: id,
      },
      heroes: [],
    };
    expect(isWorn(entry, book, null)).toBe(true);
    expect(isWorn(entry, { ...book, equipped: { ...book.equipped, companion: null } }, null)).toBe(
      false,
    );
  });
});

describe('companion art and its fallback', () => {
  it('reads a companion’s art from the manifest by its own id, or draws a plain wisp', () => {
    for (const c of COSMETICS.filter((c) => c.kind === 'companion')) {
      const sprite = companionSprite(c.id);
      const html = renderToStaticMarkup(<Companion id={c.id} scale={2} />);
      expect(html, c.id).toContain(`data-cosmetic="${c.id}"`);
      expect(html, c.id).toContain(`aria-label="${c.name}"`);
      if (sprite) {
        expect(html).toContain(sprite.path);
        expect(html).not.toContain('cosm-companion--plain');
      } else {
        expect(html).toContain('cosm-companion--plain');
        expect(html).toContain('cosm-companion__wisp');
      }
    }
    expect(companionSprite('banner.forgeward')).toBeNull();
  });

  it('draws nothing for no companion or another kind', () => {
    expect(renderToStaticMarkup(<Companion id={null} scale={2} />)).toBe('');
    expect(renderToStaticMarkup(<Companion id="banner.forgeward" scale={2} />)).toBe('');
  });

  it('plays a two-frame idle in CSS, stilled for reduced motion', () => {
    const style = css('../cosmetics/cosmetics.css');
    expect(style).toMatch(/\.cosm-companion__strip \{[^}]*steps\(var\(--frames, 2\)/);
    expect(style).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.cosm-companion__strip/);
  });

  it('has the Shrine’s title colours in CSS and a metal for its crest', () => {
    const style = css('../cosmetics/cosmetics.css');
    for (const id of ['title-colour.votive-gold', 'title-colour.shrine-ember']) {
      expect(titleColourClass(id)).toContain(`cosm-tint--${id.split('.')[1]}`);
      expect(style).toContain(`.cosm-tint--${id.split('.')[1]} {`);
    }
    expect(style).toContain('.cosm-crest--votive-ash {');
  });

  it('the hub keeps its square without the lit shrine (a glow in code)', () => {
    const hub = css('../screens/hub.css');
    expect(hub).toContain('.hub__shrine-glow');
    expect(shrineSprite() === null || shrineSprite()!.path.startsWith('/assets/')).toBe(true);
  });
});

describe('the reveal', () => {
  it('names the keepsake, its rarity and what it paid', () => {
    const id = SHRINE_POOL.find((e) => e.rarity === 'hallowed')!.cosmeticId;
    const name = findCosmetic(id)!.name;
    const grant = renderToStaticMarkup(
      <RevealCard
        draw={{
          drawId: 'd',
          seed: 's',
          spentSource: 'daily',
          cosmeticId: id,
          rarity: 'hallowed',
          outcome: 'grant',
          marks: 0,
        }}
        classId="warrior"
      />,
    );
    expect(grant).toContain('Hallowed');
    expect(grant).toContain(`${name} is yours`);
    const dup = renderToStaticMarkup(
      <RevealCard
        draw={{
          drawId: 'd',
          seed: 's',
          spentSource: 'play',
          cosmeticId: id,
          rarity: 'hallowed',
          outcome: 'marks',
          marks: 15,
        }}
        classId="warrior"
      />,
    );
    expect(dup).toContain('15 Shrine marks');
  });
});
