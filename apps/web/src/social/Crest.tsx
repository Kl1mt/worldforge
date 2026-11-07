import { useState } from 'react';
import { guildEmblem } from '@worldforge/game-core';
import { findSprite } from '../content/assets';
import './crest.css';

/**
 * A guild's crest: a brass-rimmed shield in the emblem's dye with its 32×32 charge (art ticket
 * A.8) at an integer scale. If the charge is not registered or fails to load, the shield shows the
 * emblem's letter instead (the 4.4 placeholder).
 */
export function Crest({ emblem, size = 'md' }: { emblem: string; size?: 'sm' | 'md' | 'lg' }) {
  const e = guildEmblem(emblem);
  const sprite = findSprite(e.assetId);
  const [failed, setFailed] = useState<string | null>(null);
  const showArt = sprite !== null && failed !== sprite.path;
  return (
    <span
      className={`crest crest--${e.id} crest--${size}`}
      role="img"
      aria-label={`${e.label} crest`}
    >
      {showArt ? (
        <img
          className="crest__charge pixel"
          src={sprite.path}
          alt=""
          width={sprite.width}
          height={sprite.height}
          draggable={false}
          onError={() => setFailed(sprite.path)}
        />
      ) : (
        <span className="crest__glyph" aria-hidden="true">
          {e.glyph}
        </span>
      )}
    </span>
  );
}
