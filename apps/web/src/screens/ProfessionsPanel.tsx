import { MATERIALS, type ProfessionId } from '@worldforge/game-core';
import { Meter } from '../components/Meter';
import { useGame } from '../game/GameProvider';
import { professionName } from '../game/materials';
import { formatNumber } from '../lib/format';

/** Materials each profession gathers (content data), e.g. "Timber". */
const GATHERS = new Map<ProfessionId, string>();
for (const m of MATERIALS) {
  if (!m.profession) continue;
  const prev = GATHERS.get(m.profession);
  GATHERS.set(m.profession, prev ? `${prev}, ${m.name}` : m.name);
}

/**
 * Gathering professions on the character screen (ticket 2.3, GDD §11.3). Levels rise by
 * gathering while farming; a higher level yields more per find. Server numbers only.
 */
export function ProfessionsPanel() {
  const { materials, reload } = useGame();
  return (
    <section className="ledger panel-iron profs" aria-labelledby="profs-title">
      <h2 id="profs-title" className="rule-heading">
        Professions
      </h2>
      {materials.kind === 'loading' ? (
        <p className="ledger__state" role="status">
          Recalling the trades…
        </p>
      ) : null}
      {materials.kind === 'error' ? (
        <div className="ledger__state" role="alert">
          <p>{materials.message}</p>
          <button type="button" className="btn" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}
      {materials.kind === 'ready' ? (
        <>
          <ul className="profs__list">
            {materials.value.professions.map((p) => {
              const capped = p.level >= p.maxLevel;
              const name = professionName(p.professionId);
              return (
                <li
                  key={p.professionId}
                  className={`profs__row${p.level === 1 && p.xp === 0 ? ' is-zero' : ''}`}
                >
                  <div className="profs__line">
                    <span className="profs__name">{name}</span>
                    <span className="profs__level">
                      {p.level}
                      <span className="profs__of"> / {p.maxLevel}</span>
                    </span>
                  </div>
                  <Meter
                    current={capped ? 1 : p.xp}
                    max={capped ? 1 : p.xpToNext}
                    label={`${name} experience`}
                    variant="xp"
                    className="profs__meter"
                  />
                  <p className="profs__meta">
                    <span>{GATHERS.get(p.professionId)}</span>
                    <span>
                      {capped
                        ? 'Mastered'
                        : `${formatNumber(p.xp)} / ${formatNumber(p.xpToNext)} XP`}
                    </span>
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="profs__note">
            Your hero gathers between fights. Higher levels bring more from every find.
          </p>
        </>
      ) : null}
    </section>
  );
}
