import { GAME_VERSION, PATCH_NOTES, type PatchNote } from '@worldforge/game-core';
import { formatDate } from './format';
import { isNewRelease, versionLabel } from './unread';
import './notes.css';

const SECTIONS = [
  { key: 'new', label: 'New' },
  { key: 'changed', label: 'Changed' },
  { key: 'fixed', label: 'Fixed' },
] as const;

/**
 * "What's new" (ticket F.3): the patch notes as the town crier's proclamations, nailed up newest
 * first. The notes are bundled with the game (game-core), so there is no loading or network
 * error state; an empty list shows a quiet line. The newest proclamation and any the player had
 * not read before are open; older ones fold away but keep their version, date and title.
 */
export function NotesScreen({
  seenBefore,
  notes = PATCH_NOTES,
}: {
  seenBefore: string | null;
  notes?: readonly PatchNote[];
}) {
  return (
    <div className="proclaim">
      <header className="proclaim__head">
        <p className="caps proclaim__eyebrow">The town crier · What’s new</p>
        <h1 className="display proclaim__title">Proclamations of Graumark</h1>
        <p className="proclaim__lede">
          Every change to the world is cried in the square and nailed up here, newest first. You are
          playing <strong>{versionLabel(GAME_VERSION)}</strong>.
        </p>
      </header>
      <div className="proclaim__body">
        {notes.length === 0 ? (
          <p className="proclaim__empty">The crier has nothing to read out yet.</p>
        ) : (
          <ol className="proclaim__list" aria-label="Releases, newest first">
            {notes.map((note, i) => (
              <Proclamation
                key={note.version}
                note={note}
                fresh={isNewRelease(note.version, seenBefore)}
                open={i === 0 || isNewRelease(note.version, seenBefore)}
              />
            ))}
          </ol>
        )}
        <aside className="proclaim__aside" aria-labelledby="proclaim-numbers">
          <h2 id="proclaim-numbers" className="caps proclaim__aside-title">
            How the numbers run
          </h2>
          <p>
            A version reads like <strong>0.5.2</strong>: the middle number is the chapter of the
            world’s making, the last counts the proclamations within it.
          </p>
          <p>
            A new chapter starts again at <strong>.0</strong>. When something new reaches Graumark,
            a “New” tag waits on the version at the foot of the page until you have read it.
          </p>
        </aside>
      </div>
    </div>
  );
}

function Proclamation({ note, fresh, open }: { note: PatchNote; fresh: boolean; open: boolean }) {
  const head = (
    <>
      <span className="proclaim__seal" aria-hidden="true" />
      <span className="proclaim__meta caps">
        <span className="proclaim__version">{versionLabel(note.version)}</span>
        <span aria-hidden="true"> · </span>
        <time dateTime={note.date}>{formatDate(note.date)}</time>
        {fresh ? (
          <span className="new-tag proclaim__new">
            New<span className="visually-hidden"> to you</span>
          </span>
        ) : null}
      </span>
      <span className="proclaim__name display">{note.title}</span>
    </>
  );
  return (
    <li className={`proclaim__sheet${fresh ? ' proclaim__sheet--new' : ''}`}>
      <details className="proclaim__fold" open={open}>
        <summary className="proclaim__summary">{head}</summary>
        <div className="proclaim__text">
          {SECTIONS.map(({ key, label }) => {
            const entries = note[key];
            if (!entries || entries.length === 0) return null;
            return (
              <section key={key} className={`proclaim__group proclaim__group--${key}`}>
                <h3 className="caps proclaim__group-title">{label}</h3>
                <ul className="proclaim__entries">
                  {entries.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </details>
    </li>
  );
}
