import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { enemyAttackSheet, findSprite } from '../content/assets';
import { PixelSprite } from './PixelSprite';

/** Ticket 8.2: a tinted variant keeps its tint as a frame sheet (the scene) as well as a still. */
describe('PixelSprite tints', () => {
  it('tints the Deep’s and the Depths’ kin in their attack sheets and their stills', () => {
    for (const [id, tint] of [
      ['enemy.dirge-choir', 'deep'],
      ['enemy.forge-revenant', 'ember'],
    ] as const) {
      const sheet = enemyAttackSheet(id)!;
      expect(sheet.frames).toBeGreaterThan(1);
      expect(renderToStaticMarkup(<PixelSprite sprite={sheet} scale={1} alt="" />)).toContain(
        `pixel--tint-${tint}`,
      );
      expect(
        renderToStaticMarkup(<PixelSprite sprite={findSprite(id)!} scale={1} alt="" />),
      ).toContain(`pixel--tint-${tint}`);
    }
    // Untinted art stays untinted.
    const plain = enemyAttackSheet('enemy.hollow-knight')!;
    expect(renderToStaticMarkup(<PixelSprite sprite={plain} scale={1} alt="" />)).not.toContain(
      'pixel--tint',
    );
  });
});
