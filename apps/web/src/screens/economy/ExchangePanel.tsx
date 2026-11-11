import { useCallback, useEffect, useRef, useState } from 'react';
import { MaterialStack } from '../../components/MaterialStack';
import { BannerStyle, CrestRim, titleColourClass } from '../../cosmetics/Cosmetics';
import {
  describeGameFailure,
  exchangeApi,
  type ExchangeBuyResult,
  type ExchangeOfferDto,
  type ExchangeState,
} from '../../game/api';
import { ActionKeys, isUncertain } from '../../game/economy';
import { materialView } from '../../game/materials';
import { routeHref } from '../../lib/route';
import type { Notice } from './ShopHeader';
import './seal-sinks.css';

/**
 * Ticket 6.11: the Forge's exchange (docs/COSMETICS.md "The exchange and engravings"). Gravewarden's
 * Seals and Abbey silver for collection-book cosmetics (title colours, a banner and two crests that
 * reuse A.13's art, tinted). Each is bought once per account and then worn from the collection
 * book; no stats, never money. The server quotes the price and what is missing (value on hold
 * after a trade excluded) and grants exactly once.
 */

const KIND_NAME: Record<string, string> = {
  banner: 'Banner style',
  crest: 'Crest style',
  titleColour: 'Title colour',
};

function OfferSwatch({ offer, banner }: { offer: ExchangeOfferDto; banner: string }) {
  switch (offer.kind) {
    case 'banner':
      return <BannerStyle id={offer.cosmeticId} scale={1} colour={banner} />;
    case 'crest':
      return <CrestRim id={offer.cosmeticId} scale={1} />;
    default:
      return <span className={`xoffer__words ${titleColourClass(offer.cosmeticId)}`}>Aa</span>;
  }
}

export function ExchangePanel({
  heroId,
  banner,
  onBought,
  onNotice,
}: {
  heroId: string;
  /** The hero's banner dye, for the banner preview. */
  banner: string;
  onBought: (result: ExchangeBuyResult) => void;
  onNotice: (notice: Notice | null) => void;
}) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef(new ActionKeys()).current;

  useEffect(() => {
    const controller = new AbortController();
    exchangeApi.get(heroId, { signal: controller.signal }).then(
      (res) =>
        setState((prev) =>
          res.ok
            ? { kind: 'ready', value: res.value }
            : prev.kind === 'ready'
              ? prev
              : { kind: 'error', message: describeGameFailure(res.error) },
        ),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [heroId, attempt]);

  const buy = useCallback(
    async (offer: ExchangeOfferDto) => {
      const action = `exchange:${offer.cosmeticId}`;
      setBusy(offer.cosmeticId);
      onNotice(null);
      const res = await exchangeApi.buy(heroId, offer.cosmeticId, keys.keyFor(action));
      keys.settle(action, res.ok ? null : res.error);
      setBusy(null);
      if (res.ok) {
        setState({ kind: 'ready', value: res.value });
        onBought(res.value);
        onNotice({
          kind: 'ok',
          text: `${offer.name} is in your collection book. Wear it from the book.`,
        });
      } else {
        onNotice({
          kind: 'error',
          text: isUncertain(res.error)
            ? `${describeGameFailure(res.error)} Trying again is safe: nothing is paid twice.`
            : describeGameFailure(res.error),
        });
        setAttempt((n) => n + 1);
      }
    },
    [heroId, keys, onBought, onNotice],
  );

  if (state.kind === 'loading') {
    return (
      <div className="shop__empty" role="status">
        <p className="display">Laying out the wares…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="shop__empty" role="alert">
        <p className="display">The counter is shuttered.</p>
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  const offers = state.value.offers;
  const held = new Map(state.value.materials.map((m) => [m.materialId as string, m.quantity]));
  const open = offers.filter((o) => !o.owned);
  return (
    <div className="xcounter">
      {offers.length === 0 ? (
        <div className="shop__empty" role="status">
          <p className="display">Nothing on the counter today.</p>
        </div>
      ) : open.length === 0 ? (
        <p className="xcounter__done" role="status">
          Your collection book holds every piece the counter trades.{' '}
          <a href={routeHref('collection')}>Open the collection book</a>. The engraver still works
          for Seals and silver.
        </p>
      ) : null}
      <ul className="xcounter__list" aria-label="Exchange offers">
        {offers.map((o) => {
          const short = o.blockers.length > 0;
          return (
            <li key={o.cosmeticId} className={`xoffer${o.owned ? ' xoffer--owned' : ''}`}>
              <div className="xoffer__swatch" aria-hidden="true">
                <OfferSwatch offer={o} banner={banner} />
              </div>
              <div className="xoffer__body">
                <p className="caps xoffer__kind">{KIND_NAME[o.kind] ?? o.kind}</p>
                <h3 className="display xoffer__name">{o.name}</h3>
                <p className="xoffer__desc">{o.description}</p>
                <ul className="recipe__cost xoffer__price" aria-label="Price">
                  {o.price.map((m) => {
                    const lacking = o.blockers.some(
                      (b) => b.kind === 'material' && b.materialId === m.materialId,
                    );
                    return (
                      <li key={m.materialId} className={lacking ? 'recipe__short' : ''}>
                        <MaterialStack
                          material={materialView(m.materialId)}
                          quantity={m.quantity}
                        />
                        {o.owned ? null : (
                          <span className="recipe__have">
                            {held.get(m.materialId) ?? 0}/{m.quantity}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
              {o.owned ? (
                <p className="caps xoffer__owned">In your book</p>
              ) : (
                <button
                  type="button"
                  className="btn btn--brass xoffer__buy"
                  disabled={short || busy !== null}
                  aria-busy={busy === o.cosmeticId}
                  onClick={() => void buy(o)}
                >
                  {busy === o.cosmeticId ? 'Trading…' : short ? 'Not enough' : 'Trade for it'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; value: ExchangeState };
