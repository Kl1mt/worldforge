import type { SetTrackerView } from '../game/items';
import { slotName } from '../game/items';
import './set-tracker.css';

interface SetTrackerProps {
  set: SetTrackerView;
  /** The piece the tooltip is about, marked in the list. */
  current?: string;
  /** Compact form inside the item tooltip; the full form shows the set's theme. */
  compact?: boolean;
  /** Heading level of the set name (the tooltip nests it lower than the character screen). */
  headingLevel?: 3 | 4;
}

const PIECE_STATE = {
  equipped: 'Worn',
  inPack: 'In the pack',
  missing: 'Not found yet',
} as const;

/**
 * A set's progress (ticket 3.3): one pip per piece (worn, in the pack, not found yet) and its
 * bonuses at 2, 4 and 6 pieces, lit when active. Worn pieces are counted the server's way.
 */
export function SetTracker({ set, current, compact = false, headingLevel = 3 }: SetTrackerProps) {
  const Heading = `h${headingLevel}` as const;
  const total = set.pieces.length;
  return (
    <section className={`set${compact ? ' set--compact' : ''}`} aria-label={`${set.name} set`}>
      <header className="set__head">
        <Heading className="set__name">{set.name}</Heading>
        <p className="set__count">
          <span className="visually-hidden">Pieces worn: </span>
          {set.worn} / {total}
          <span aria-hidden="true" className="set__pips">
            {set.pieces.map((p) => (
              <span
                key={p.baseId}
                className={`set__pip${p.equipped ? ' is-worn' : p.inPack ? ' is-owned' : ''}`}
              />
            ))}
          </span>
        </p>
      </header>
      {compact ? null : <p className="set__theme">{set.theme}</p>}
      <ul className="set__pieces" aria-label="Pieces">
        {set.pieces.map((p) => {
          const state = p.equipped ? 'equipped' : p.inPack ? 'inPack' : 'missing';
          return (
            <li
              key={p.baseId}
              className={`set__piece is-${state}${p.baseId === current ? ' is-current' : ''}`}
            >
              <span className="set__piece-name">{p.name}</span>
              <span className="set__piece-state">
                {compact ? null : <span className="set__piece-slot">{slotName(p.slot)} · </span>}
                {PIECE_STATE[state]}
              </span>
            </li>
          );
        })}
      </ul>
      <ul className="set__bonuses" aria-label="Set bonuses">
        {set.bonuses.map((b) => (
          <li key={b.pieces} className={`set__bonus${b.active ? ' is-active' : ''}`}>
            <span className="set__bonus-count">
              ({b.pieces})<span className="visually-hidden"> pieces, </span>
              <span className="visually-hidden">{b.active ? 'active' : 'inactive'}</span>
            </span>
            <span className="set__bonus-body">
              <span className="set__bonus-name">{b.name}</span> {b.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
