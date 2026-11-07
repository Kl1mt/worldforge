import { guildEmblem } from '@worldforge/game-core';
import './crest.css';

/** A guild's crest (ticket 4.4): a shield in the emblem's colours with a placeholder glyph. */
export function Crest({ emblem, size = 'md' }: { emblem: string; size?: 'sm' | 'md' | 'lg' }) {
  const e = guildEmblem(emblem);
  return (
    <span
      className={`crest crest--${e.id} crest--${size}`}
      role="img"
      aria-label={`${e.label} crest`}
    >
      <span className="crest__glyph" aria-hidden="true">
        {e.glyph}
      </span>
    </span>
  );
}
