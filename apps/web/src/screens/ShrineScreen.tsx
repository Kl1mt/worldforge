import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { findCosmetic, type ClassId } from '@worldforge/game-core';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { useMediaQuery } from '../components/useMediaQuery';
import { shrineSprite } from '../content/assets';
import {
  BannerStyle,
  Companion,
  CrestRim,
  HeroLook,
  titleColourClass,
} from '../cosmetics/Cosmetics';
import { loadCollection } from '../cosmetics/store';
import { KIND_LABELS } from '../cosmetics/text';
import { routeHref } from '../lib/route';
import { newShrineKey, shrineApi, type ShrineDrawResult, type ShrineView } from '../shrine/api';
import {
  RARITY_NAMES,
  bankLine,
  drawLine,
  drawsWord,
  percent,
  shrineFailure,
} from '../shrine/text';
import '../shrine/shrine.css';

/**
 * Ticket 9.5: the Summoning Shrine (`#/shrine`, docs/SHRINE.md). Cosmetic only: draws held (the
 * free daily bank and draws from play), a draw with a short reveal, the published odds one click
 * away, the marks shop and the latest draws with their seeds. No draw is sold here.
 */

type Load =
  { kind: 'loading' } | { kind: 'error'; code: string } | { kind: 'ready'; view: ShrineView };
type Reveal = { phase: 'rising' | 'shown'; draw: ShrineDrawResult } | null;

const REVEAL_MS = 900;

export function ShrineScreen() {
  const ids = useId();
  const hero = useActiveCharacter();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // A draw's key is kept until it is answered, so a retry after a dropped answer pays once.
  const drawKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await shrineApi.view();
    setLoad(res.ok ? { kind: 'ready', view: res.value } : { kind: 'error', code: res.error.code });
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    shrineApi.view(abort.signal).then(
      (res) => {
        if (abort.signal.aborted) return;
        setLoad(
          res.ok ? { kind: 'ready', view: res.value } : { kind: 'error', code: res.error.code },
        );
      },
      () => undefined, // aborted on unmount
    );
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (reveal?.phase !== 'rising') return;
    const t = setTimeout(() => setReveal({ phase: 'shown', draw: reveal.draw }), REVEAL_MS);
    return () => clearTimeout(t);
  }, [reveal]);

  if (load.kind === 'loading') {
    return (
      <section className="shrine" aria-busy="true" aria-labelledby={`${ids}-t`}>
        <ShrineHead id={`${ids}-t`} />
        <p className="shrine__state">The candles are being lit…</p>
      </section>
    );
  }
  if (load.kind === 'error') {
    return (
      <section className="shrine" aria-labelledby={`${ids}-t`}>
        <ShrineHead id={`${ids}-t`} />
        <p className="shrine__state gate__alert" role="alert">
          The Shrine would not open: {shrineFailure(load.code)}
        </p>
        <button type="button" className="btn" onClick={() => void refresh()}>
          Try again
        </button>
      </section>
    );
  }

  const view = load.view;

  const draw = async () => {
    setBusy('draw');
    setMessage(null);
    drawKey.current ??= newShrineKey();
    try {
      const res = await shrineApi.draw(drawKey.current);
      if (!res.ok) {
        if (res.error.code !== 'network') drawKey.current = null;
        setMessage({ ok: false, text: shrineFailure(res.error.code) });
        if (res.error.code === 'no_draws') void refresh();
        return;
      }
      drawKey.current = null;
      setLoad({ kind: 'ready', view: res.value.shrine });
      setReveal({ phase: reduced ? 'shown' : 'rising', draw: res.value.draw });
      void loadCollection();
    } finally {
      setBusy(null);
    }
  };

  const buy = async (cosmeticId: string) => {
    setBusy(cosmeticId);
    setMessage(null);
    try {
      const res = await shrineApi.buy(cosmeticId);
      if (!res.ok) {
        setMessage({ ok: false, text: shrineFailure(res.error.code) });
        return;
      }
      setLoad({ kind: 'ready', view: res.value.shrine });
      const name = findCosmetic(cosmeticId)?.name ?? 'The keepsake';
      setMessage({ ok: true, text: `${name} is yours for ${res.value.bought.price} marks.` });
      void loadCollection();
    } finally {
      setBusy(null);
    }
  };

  const offers = view.pool.filter((p) => !p.owned);
  const owned = view.pool.length - offers.length;

  return (
    <section className="shrine" aria-labelledby={`${ids}-t`}>
      <ShrineHead id={`${ids}-t`} />

      <div className="shrine__layout">
        <div className="shrine__altar panel-ledger">
          <Altar rising={reveal?.phase === 'rising'} />
          <dl className="shrine__held">
            <div>
              <dt className="caps">Draws held</dt>
              <dd className="display shrine__held-n">{view.draws}</dd>
            </div>
            <div>
              <dt className="caps">Free</dt>
              <dd>{view.unspent.daily}</dd>
            </div>
            <div>
              <dt className="caps">From play</dt>
              <dd>{view.unspent.play}</dd>
            </div>
            <div>
              <dt className="caps">Shrine marks</dt>
              <dd>{view.marks}</dd>
            </div>
          </dl>
          <p className="shrine__bank">
            {bankLine(view.unspent.daily, view.bankLimit, view.nextFreeAt, new Date())}
          </p>
          <button
            type="button"
            className="btn shrine__draw"
            disabled={busy !== null || view.draws === 0 || reveal?.phase === 'rising'}
            onClick={() => void draw()}
          >
            {busy === 'draw'
              ? 'Drawing…'
              : view.draws > 0
                ? `Draw (${drawsWord(view.draws)} held)`
                : 'No draws held'}
          </button>
          {view.draws === 0 ? (
            <p className="shrine__hint">
              A free draw comes every day. Event reward tiers, deeds and season honours give more.
            </p>
          ) : null}
          <div className="shrine__reveal" aria-live="polite">
            {reveal?.phase === 'shown' ? (
              <RevealCard draw={reveal.draw} classId={hero.classId} />
            ) : reveal?.phase === 'rising' ? (
              <p className="shrine__rising">The candles gutter…</p>
            ) : null}
          </div>
          {message ? (
            <p className={message.ok ? 'shrine__ok' : 'shrine__err gate__alert'} role="status">
              {message.text}
            </p>
          ) : null}
        </div>

        <div className="shrine__side">
          <details className="shrine__odds panel-ledger">
            <summary className="caps">The odds</summary>
            <p className="shrine__fine">
              A draw picks a rarity, then one keepsake of it, each equally likely. What you own does
              not change the odds; a keepsake you already have turns into marks.
            </p>
            <table className="shrine__table">
              <thead>
                <tr>
                  <th scope="col">Rarity</th>
                  <th scope="col">Chance</th>
                  <th scope="col">Duplicate</th>
                  <th scope="col">Price</th>
                </tr>
              </thead>
              <tbody>
                {view.rarities.map((r) => (
                  <tr key={r.rarity} className={`shrine-rarity--${r.rarity}`}>
                    <th scope="row">{RARITY_NAMES[r.rarity]}</th>
                    <td>{percent(r.chance)}</td>
                    <td>{r.duplicateMarks} marks</td>
                    <td>{r.price} marks</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="shrine__table shrine__table--each">
              <thead>
                <tr>
                  <th scope="col">Keepsake</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Chance</th>
                </tr>
              </thead>
              <tbody>
                {view.pool.map((p) => (
                  <tr key={p.cosmeticId} className={`shrine-rarity--${p.rarity}`}>
                    <th scope="row">{p.name}</th>
                    <td>{KIND_LABELS[p.kind as keyof typeof KIND_LABELS]?.one ?? p.kind}</td>
                    <td>{percent(p.chance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <section className="shrine__shop panel-ledger" aria-labelledby={`${ids}-shop`}>
            <h2 id={`${ids}-shop`} className="caps">
              The marks shop
            </h2>
            <p className="shrine__fine">
              Choose a keepsake and pay for it in Shrine marks. You hold {view.marks}; {owned} of{' '}
              {view.pool.length} of the Shrine’s keepsakes are yours.
            </p>
            {offers.length === 0 ? (
              <p className="shrine__state">Every keepsake of the Shrine is yours.</p>
            ) : (
              <ul className="shrine__offers">
                {offers.map((p) => (
                  <li key={p.cosmeticId} className={`shrine-offer shrine-rarity--${p.rarity}`}>
                    <span className="shrine-offer__swatch" aria-hidden="true">
                      <Swatch id={p.cosmeticId} classId={hero.classId} />
                    </span>
                    <span className="shrine-offer__words">
                      <span className="shrine-offer__name">{p.name}</span>
                      <span className="shrine-offer__meta">
                        {RARITY_NAMES[p.rarity]} ·{' '}
                        {KIND_LABELS[p.kind as keyof typeof KIND_LABELS]?.one ?? p.kind}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={busy !== null || view.marks < p.price}
                      onClick={() => void buy(p.cosmeticId)}
                      aria-label={`Buy ${p.name} for ${p.price} marks`}
                    >
                      {busy === p.cosmeticId ? 'Buying…' : `${p.price} marks`}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="shrine__recent panel-ledger" aria-labelledby={`${ids}-recent`}>
            <h2 id={`${ids}-recent`} className="caps">
              Your latest draws
            </h2>
            {view.recent.length === 0 ? (
              <p className="shrine__state">No draws yet. Your first is waiting.</p>
            ) : (
              <ol className="shrine__log">
                {view.recent.map((d) => (
                  <li key={d.id} className={`shrine-rarity--${d.rarity}`}>
                    <span className="shrine__log-name">
                      {findCosmetic(d.cosmeticId)?.name ?? d.cosmeticId}
                    </span>
                    <span className="shrine__log-meta">
                      {d.outcome === 'grant' ? 'new' : `+${d.marks} marks`} ·{' '}
                      {d.spentSource === 'daily' ? 'free draw' : 'from play'} ·{' '}
                      <span title="The draw’s seed: the game can replay this draw from it.">
                        seed {d.seed.slice(0, 8)}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="shrine__fine">
              Worn from the <a href={routeHref('collection')}>collection book</a>. Companions walk
              beside your hero in the fight.
            </p>
          </section>
        </div>
      </div>
    </section>
  );
}

function ShrineHead({ id }: { id: string }) {
  return (
    <header className="shrine__head">
      <p className="caps">Graumark · The square</p>
      <h1 id={id} className="display">
        The Summoning Shrine
      </h1>
      <p className="shrine__lede">
        Draw keepsakes for the collection book: looks and companions, never power. A free draw comes
        every day and waits for you (up to a week); play earns more. Nothing here is sold.
      </p>
    </header>
  );
}

/** A.19's lit shrine, or a plain altar of candles in code. */
function Altar({ rising }: { rising: boolean }) {
  const art = shrineSprite();
  const [failed, setFailed] = useState(false);
  return (
    <div className={`shrine-altar${rising ? ' shrine-altar--rising' : ''}`} aria-hidden="true">
      {art && !failed ? (
        <img
          className="pixel shrine-altar__art"
          src={art.path}
          alt=""
          width={art.width * 3}
          height={art.height * 3}
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="shrine-altar__plain">
          <span className="shrine-altar__candle" />
          <span className="shrine-altar__candle shrine-altar__candle--tall" />
          <span className="shrine-altar__candle" />
          <span className="shrine-altar__stone" />
        </span>
      )}
      <span className="shrine-altar__flare" />
    </div>
  );
}

function Swatch({ id, classId, scale = 1 }: { id: string; classId: ClassId; scale?: 1 | 2 }) {
  const c = findCosmetic(id);
  if (!c) return null;
  switch (c.kind) {
    case 'companion':
      return <Companion id={id} scale={scale * 2} />;
    case 'appearance':
      return <HeroLook classId={classId} palette={id} scale={scale} alt="" />;
    case 'banner':
      return <BannerStyle id={id} scale={scale} />;
    case 'crest':
      return <CrestRim id={id} scale={scale} />;
    case 'titleColour':
      return <span className={`book-swatch__words ${titleColourClass(id)}`}>Aa</span>;
    default:
      return <span className="book-swatch__words">❦</span>;
  }
}

export function RevealCard({ draw, classId }: { draw: ShrineDrawResult; classId: ClassId }) {
  const c = findCosmetic(draw.cosmeticId);
  const name = c?.name ?? draw.cosmeticId;
  return (
    <figure className={`shrine-card shrine-rarity--${draw.rarity}`}>
      <span className="shrine-card__swatch">
        <Swatch id={draw.cosmeticId} classId={classId} scale={2} />
      </span>
      <figcaption>
        <span className="caps shrine-card__rarity">{RARITY_NAMES[draw.rarity]}</span>
        <span className="display shrine-card__name">{name}</span>
        <span className="shrine-card__line">{drawLine(name, draw.outcome, draw.marks)}</span>
        {c ? <span className="shrine-card__desc">{c.description}</span> : null}
      </figcaption>
    </figure>
  );
}
