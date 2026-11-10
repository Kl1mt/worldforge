import type { BossModifierInfo, BossModifierWeek } from '../game/bossModifier';
import { modifierUntil } from '../game/bossModifier';
import './boss-modifier.css';

/**
 * Ticket 6.3: the week's boss modifier as a nailed notice: its name, what it does in plain words
 * and the hoard's small focus. One component for the Tavern, every boss door and the guild boss.
 * `variant="run"` names the modifier a run fights (which may be last week's).
 */
export function BossModifierNotice({
  modifier,
  week,
  heading,
  showFocus = true,
  compact = false,
}: {
  modifier: BossModifierInfo;
  week?: BossModifierWeek['week'];
  /** e.g. "This week at every boss". */
  heading: string;
  showFocus?: boolean;
  compact?: boolean;
}) {
  return (
    <aside
      className={`boss-mod boss-mod--${modifier.id}${compact ? ' boss-mod--compact' : ''}`}
      aria-label={`${heading}: ${modifier.name}`}
    >
      <span className="boss-mod__sigil" aria-hidden="true" />
      <div className="boss-mod__body">
        <p className="caps boss-mod__head">
          {heading}
          {week ? <span className="boss-mod__until"> · {modifierUntil(week)}</span> : null}
        </p>
        <p className="boss-mod__line">
          <strong className="display boss-mod__name">{modifier.name}.</strong> {modifier.effect}
        </p>
        {showFocus ? (
          <p className="boss-mod__focus">
            Hoard focus: <em>{modifier.lootFocus.name}</em>. {modifier.lootFocus.description}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
