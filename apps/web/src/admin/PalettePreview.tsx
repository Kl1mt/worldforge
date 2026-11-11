import { CLASS_IDS, cosmeticsOfKind, getClass } from '@worldforge/game-core';
import { PixelSprite } from '../components/PixelSprite';
import { classAttackSheet, classPortrait } from '../content/assets';
import { appearancePalette, hasPaletteArt } from '../content/appearance';

/**
 * Ticket 6.8: the gallery's "Palettes" section. Every hero appearance of the collection book on
 * every class, the portrait and the attack frame sheet, swapped in code from the art ticket's
 * palette data (A.13). An appearance without data shows the class's own colours and says so.
 */
export function PalettePreview({ scale }: { scale: number }) {
  const looks = cosmeticsOfKind('appearance');
  return (
    <section className="anim-gallery__group" aria-label="Palettes">
      <h2 className="rule-heading anim-gallery__title">
        Palettes{' '}
        <span className="anim-gallery__note">
          hero appearances from the collection book, swapped in code on the portrait and the frame
          sheet; cosmetic only
        </span>
      </h2>
      <table className="anim-gallery__variants anim-gallery__palettes">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Appearance</span>
            </th>
            {CLASS_IDS.map((c) => (
              <th key={c} scope="col" className="caps">
                {getClass(c).name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {looks.map((look) => {
            const art = look.source.kind === 'default' || hasPaletteArt(look.id);
            return (
              <tr key={look.id} data-palette-art={art ? 'yes' : 'missing'}>
                <th scope="row">
                  <span className="caps">{look.name}</span>
                  <code>{look.id}</code>
                  {art ? null : (
                    <span className="anim-gallery__tag">No palette yet: own colours</span>
                  )}
                </th>
                {CLASS_IDS.map((c) => {
                  const swap = appearancePalette(look.id, c);
                  const sheet = classAttackSheet(c);
                  return (
                    <td key={c}>
                      <PixelSprite
                        sprite={classPortrait(c)}
                        scale={1}
                        alt={`${getClass(c).name}, ${look.name}`}
                        palette={swap}
                      />
                      {sheet ? (
                        <PixelSprite
                          sprite={sheet}
                          scale={scale}
                          alt=""
                          palette={swap}
                          fallback={classPortrait(c)}
                        />
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
