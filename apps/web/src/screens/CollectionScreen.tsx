import { useEffect, useId, useState } from 'react';
import { findCosmetic, type ClassId } from '@worldforge/game-core';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { BannerStyle, CrestRim, HeroLook, titleColourClass } from '../cosmetics/Cosmetics';
import { cosmeticsApi, type Collection, type CollectionEntry } from '../cosmetics/api';
import {
  accountSlot,
  counts,
  filterEntries,
  isWorn,
  type KindFilter,
  type OwnFilter,
} from '../cosmetics/book';
import { loadCollection, setCollection, useCollection } from '../cosmetics/store';
import { BOOK_KINDS, KIND_LABELS, equipFailure, howToEarn, sourceLabel } from '../cosmetics/text';
import { seasonsApi } from '../social/seasons';
import { ShownTitle } from '../social/Prestige';
import { routeHref } from '../lib/route';
import '../cosmetics/collection.css';

/**
 * Ticket 6.8: the collection book (`#/collection`, docs/COSMETICS.md). Every cosmetic, earned or
 * locked with how to earn it; filters by kind and by earned/locked; a preview (the hero in each
 * palette, the banner, the crest, the title in its colour) and equip. Cosmetics are earned in play,
 * never bought, and change no number in the game.
 */

type Busy = { id: string } | null;

const SAMPLE_TITLE = 'Warden of Graumark';

export function CollectionScreen() {
  const load = useCollection();
  const active = useActiveCharacter();
  const [kind, setKind] = useState<KindFilter>('all');
  const [own, setOwn] = useState<OwnFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [heroId, setHeroId] = useState<string>(active.id);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = useId();

  // Refresh on opening: keepsakes may have arrived since the scene last asked.
  useEffect(() => {
    void loadCollection();
  }, []);

  if (load.kind === 'loading') {
    return (
      <section className="book" aria-busy="true" aria-labelledby={`${ids}-t`}>
        <BookHead id={`${ids}-t`} />
        <p className="book__state">Opening the book…</p>
      </section>
    );
  }
  if (load.kind === 'error') {
    return (
      <section className="book" aria-labelledby={`${ids}-t`}>
        <BookHead id={`${ids}-t`} />
        <p className="book__state gate__alert" role="alert">
          The book would not open: {equipFailure(load.error.code)}
        </p>
        <button type="button" className="btn" onClick={() => void loadCollection()}>
          Try again
        </button>
      </section>
    );
  }

  const book = load.value;
  const shown = filterEntries(book.entries, kind, own);
  const entry = book.entries.find((e) => e.id === selected) ?? shown[0] ?? book.entries[0] ?? null;
  const hero = book.heroes.find((h) => h.id === heroId) ?? book.heroes[0] ?? null;
  const total = counts(book.entries);

  const done = (res: Awaited<ReturnType<typeof cosmeticsApi.equip>>, ok: string) => {
    if (res.ok) {
      setCollection(res.value);
      setMessage({ ok: true, text: ok });
    } else setMessage({ ok: false, text: equipFailure(res.error.code) });
  };

  const wear = async (e: CollectionEntry, remove: boolean) => {
    setBusy({ id: e.id });
    setMessage(null);
    try {
      if (e.kind === 'appearance') {
        if (!hero) return;
        const res = await cosmeticsApi.wear(hero.id, remove ? null : e.id);
        done(
          res,
          remove
            ? `${hero.name} wears their own colours again.`
            : `${hero.name} now wears ${e.name}.`,
        );
      } else if (e.kind === 'title') {
        // Titles share Season honours' one title slot (5.3 / 6.6).
        const settings = await seasonsApi.prestige();
        if (!settings.ok) return setMessage({ ok: false, text: equipFailure(settings.error.code) });
        const f = settings.value.shown.frame;
        const saved = await seasonsApi.savePrestige({
          title: null,
          frame: f ? { season: f.season, metric: f.metric } : null,
          cosmeticTitle: remove ? null : e.id,
        });
        if (!saved.ok) return setMessage({ ok: false, text: equipFailure(saved.error.code) });
        await loadCollection();
        setMessage({
          ok: true,
          text: remove ? 'Your title is put away.' : `You now bear “${e.name}”.`,
        });
      } else {
        const slot = accountSlot(e.kind)!;
        const res = await cosmeticsApi.equip({ [slot]: remove ? null : e.id });
        done(res, remove ? `${e.name} is put away.` : `${e.name} is now shown.`);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="book" aria-labelledby={`${ids}-t`}>
      <BookHead id={`${ids}-t`} owned={total.owned} total={total.total} />

      <div className="book__filters">
        <div className="book__tabs" role="group" aria-label="Kind">
          {(['all', ...BOOK_KINDS] as const).map((k) => (
            <button
              key={k}
              type="button"
              className="btn btn--small"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
            >
              {k === 'all' ? 'All' : KIND_LABELS[k].many}
            </button>
          ))}
        </div>
        <div className="book__tabs" role="group" aria-label="Show">
          {(
            [
              ['all', 'Everything'],
              ['owned', 'Earned'],
              ['locked', 'Still to earn'],
            ] as const
          ).map(([o, label]) => (
            <button
              key={o}
              type="button"
              className="btn btn--small"
              aria-pressed={own === o}
              onClick={() => setOwn(o)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="book__spread">
        <div className="book__page">
          {shown.length === 0 ? (
            <p className="book__state">
              {own === 'owned'
                ? 'Nothing of this kind earned yet. Every page says how to earn it.'
                : 'Every keepsake of this kind is yours.'}
            </p>
          ) : (
            <ul className="book__grid" aria-label="Keepsakes">
              {shown.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    className={`book-card${e.owned ? '' : ' book-card--locked'}${
                      entry?.id === e.id ? ' book-card--open' : ''
                    }`}
                    aria-pressed={entry?.id === e.id}
                    onClick={() => setSelected(e.id)}
                  >
                    <span className="book-card__swatch" aria-hidden="true">
                      <Swatch
                        entry={e}
                        classId={hero?.classId ?? active.classId}
                        banner={hero?.banner ?? 'ash'}
                      />
                    </span>
                    <span className="book-card__name display">{e.name}</span>
                    <span className="book-card__meta caps">
                      {KIND_LABELS[e.kind].one} · {sourceLabel(e.source)}
                    </span>
                    <span className="book-card__state">
                      {isWorn(e, book, hero?.id ?? null) ? 'Worn' : e.owned ? 'Earned' : 'Locked'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {entry ? (
          <aside className="book__mirror" aria-labelledby={`${ids}-m`}>
            <p className="caps">{KIND_LABELS[entry.kind].one}</p>
            <h2 id={`${ids}-m`} className="display book__mirror-name">
              {entry.name}
            </h2>
            {entry.kind === 'appearance' && book.heroes.length > 1 ? (
              <label className="field book__hero">
                <span className="field__label">Try it on</span>
                <select value={hero?.id ?? ''} onChange={(ev) => setHeroId(ev.target.value)}>
                  {book.heroes.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Preview entry={entry} book={book} heroId={hero?.id ?? null} />
            <p className="book__desc">{entry.description}</p>
            <p className="book__earn">
              <span className="caps">{entry.owned ? 'Earned' : 'How to earn it'}</span>{' '}
              {entry.owned && entry.grantedOn ? `on ${entry.grantedOn}. ` : null}
              {howToEarn(entry.source)}
            </p>
            {entry.owned ? (
              isWorn(entry, book, hero?.id ?? null) ? (
                entry.source.kind === 'default' ? (
                  <p className="book__worn">Worn.</p>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy !== null}
                    aria-busy={busy?.id === entry.id}
                    onClick={() => void wear(entry, true)}
                  >
                    Put it away
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="btn btn--brass"
                  disabled={busy !== null || (entry.kind === 'appearance' && !hero)}
                  aria-busy={busy?.id === entry.id}
                  onClick={() => void wear(entry, false)}
                >
                  {entry.kind === 'appearance' ? `Dress ${hero?.name ?? 'the hero'}` : 'Show it'}
                </button>
              )
            ) : (
              <p className="book__locked">Locked. Keepsakes are earned in play, never bought.</p>
            )}
            {message ? (
              <p
                className={message.ok ? 'herald__saved' : 'gate__alert'}
                role={message.ok ? 'status' : 'alert'}
              >
                {message.text}
              </p>
            ) : null}
            {entry.kind === 'title' || entry.kind === 'titleColour' ? (
              <p className="field__hint">
                One title at a time: also chosen under{' '}
                <a href={routeHref('profile')}>your profile → Season honours</a>.
              </p>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function BookHead({ id, owned, total }: { id: string; owned?: number; total?: number }) {
  return (
    <header className="book__head">
      <p className="caps">Graumark · The Herald’s Hall</p>
      <h1 id={id} className="display">
        The Collection Book
      </h1>
      <p className="book__lede">
        Looks, banners, crests and colours earned in Graumark. They change how you are seen, never
        how you fight.
        {owned !== undefined && total !== undefined ? (
          <span className="book__count">
            {' '}
            {owned} of {total} earned.
          </span>
        ) : null}
      </p>
    </header>
  );
}

/** A small preview of an entry for its card. */
function Swatch({
  entry,
  classId,
  banner,
}: {
  entry: CollectionEntry;
  classId: ClassId;
  banner: string;
}) {
  switch (entry.kind) {
    case 'appearance':
      return <HeroLook classId={classId} palette={entry.id} scale={1} alt="" />;
    case 'banner':
      return <BannerStyle id={entry.id} scale={1} colour={banner} />;
    case 'crest':
      return <CrestRim id={entry.id} scale={1} />;
    case 'titleColour':
      return <span className={`book-swatch__words ${titleColourClass(entry.id)}`}>Aa</span>;
    case 'title':
      return <span className="book-swatch__words">❦</span>;
  }
}

/** The mirror: the selected entry on the hero, as others will see it. */
function Preview({
  entry,
  book,
  heroId,
}: {
  entry: CollectionEntry;
  book: Collection;
  heroId: string | null;
}) {
  const hero = book.heroes.find((h) => h.id === heroId) ?? book.heroes[0];
  if (!hero) return <p className="book__state">Create a hero to try keepsakes on.</p>;
  const palette = entry.kind === 'appearance' ? entry.id : hero.palette;
  const banner = entry.kind === 'banner' ? entry.id : book.equipped.banner;
  const crest = entry.kind === 'crest' ? entry.id : book.equipped.crest;
  const colour = entry.kind === 'titleColour' ? entry.id : book.equipped.titleColour;
  const title = entry.kind === 'title' ? entry.id : book.equipped.cosmeticTitle;
  return (
    <figure className="book-preview" aria-label={`Preview: ${hero.name} with ${entry.name}`}>
      <div className="book-preview__stand">
        <BannerStyle id={banner} scale={3} colour={hero.banner} />
        <CrestRim id={crest} scale={4}>
          <HeroLook
            classId={hero.classId}
            palette={palette}
            scale={1}
            alt={`${hero.name} in ${findCosmetic(palette ?? '')?.name ?? 'their own colours'}`}
          />
        </CrestRim>
      </div>
      <figcaption className="book-preview__caption">
        <span className="display">{hero.name}</span>
        {title ? (
          <ShownTitle
            shown={{ title: null, frame: null, cosmeticTitle: title, titleColour: colour }}
          />
        ) : (
          <span className={`honour honour--cosmetic ${titleColourClass(colour)}`}>
            <span className="honour__lozenge" aria-hidden="true" />
            <span className="honour__words">{SAMPLE_TITLE}</span>
            <span className="honour__season">Sample title</span>
          </span>
        )}
      </figcaption>
    </figure>
  );
}
