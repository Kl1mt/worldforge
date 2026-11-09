import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MATERIAL_IDS, type MaterialId } from '@worldforge/game-core';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { MaterialStack } from '../components/MaterialStack';
import { ActionKeys } from '../game/economy';
import { toItemView } from '../game/items';
import { materialView } from '../game/materials';
import type { ItemDto } from '../game/api';
import type { ApiFailure } from '../lib/api';
import { formatNumber } from '../lib/format';
import { routeHref } from '../lib/route';
import { formatWhen } from '../social/api';
import { ReportDialog } from '../social/ReportDialog';
import {
  OFFER_STATUS_WORDS,
  describeOfferFailure,
  offersApi,
  type TradeHeroOption,
  type TradeInbox,
  type TradeOffer,
  type TradeOfferDetail,
  type TradePartner,
  type TradeSide,
  type TradeSideDraft,
} from '../social/trading';
import { Gold } from './economy/ShopHeader';
import './trading.css';

/**
 * Ticket T.5: the Trading screen (`#/trading`, docs/TRADING.md "T.5 as built"). The weighing
 * table: every offer is shown as two pans on a brass beam, what you give and what you get, with
 * every item in full and the 72-hour hold spelled out before anything is sent or accepted.
 * Tabs: offers to you, offers you sent, history, and a new offer (pick a friend or guildmate and a
 * hero, fill both pans, then confirm on the same full view). The inbox is polled (the server's
 * `pollMs`, 30 s) while the screen is open. While trading is closed (the default), the screen says
 * so plainly and links to where you stand.
 */

type Tab = 'inbox' | 'sent' | 'history' | 'compose';

type Load<T> =
  { kind: 'loading' } | { kind: 'error'; failure: ApiFailure } | { kind: 'ready'; value: T };

const EMPTY_SIDE: TradeSideDraft = { itemIds: [], gold: 0, materials: {} };
const HOLD_LINE =
  'Everything received in a trade is held for 72 hours: items can be worn, but not sold, salvaged, discarded, forged, stored in the Warehouse or put on the shelf, and gold and materials can’t be spent, sent on or shelved until the hold ends.';

const keys = new ActionKeys();

function who(o: { with: TradeOffer['with'] }): string {
  return o.with.displayName ?? 'A player';
}

export function TradingScreen() {
  const [tab, setTab] = useState<Tab>('inbox');
  const [inbox, setInbox] = useState<Load<TradeInbox>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const etagRef = useRef<TradeInbox | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      offersApi.inbox(controller.signal).then(
        (r) => {
          if (r.ok) {
            etagRef.current = r.value;
            setInbox({ kind: 'ready', value: r.value });
            timer = setTimeout(poll, r.value.pollMs);
          } else if (etagRef.current) {
            timer = setTimeout(poll, 30_000);
          } else {
            setInbox({ kind: 'error', failure: r.error });
          }
        },
        () => {
          /* aborted */
        },
      );
    };
    poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [attempt]);

  const view = inbox.kind === 'ready' ? inbox.value : null;
  const counts = view
    ? { inbox: view.received.length, sent: view.sent.length }
    : { inbox: 0, sent: 0 };

  return (
    <section className="trading" aria-labelledby="trading-title">
      <header className="trading__head">
        <p className="caps">Gifts and swaps between friends</p>
        <h1 id="trading-title" className="display">
          The weighing table
        </h1>
        <p className="trading__lede">
          Offers between friends and guildmates of at least a week. Staff never ask for your items
          or gold.
        </p>
      </header>

      {inbox.kind === 'loading' ? (
        <p className="trading__wait" role="status">
          Laying out the scales…
        </p>
      ) : inbox.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>{describeOfferFailure(inbox.failure)[0]}</p>
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {!view!.open ? <Closed hasOffers={view!.recent.length > 0} /> : null}
          <Holds holds={view!.holds} />
          <nav className="trading__tabs" aria-label="Trading">
            {(
              [
                ['inbox', `Offers to you${counts.inbox ? ` (${counts.inbox})` : ''}`],
                ['sent', `Sent${counts.sent ? ` (${counts.sent})` : ''}`],
                ['history', 'History'],
                ['compose', 'New offer'],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="trading__tab"
                aria-pressed={tab === id}
                disabled={id === 'compose' && !view!.open}
                onClick={() => {
                  setTab(id);
                  setOpenId(null);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          {openId ? (
            <OfferDetail
              id={openId}
              onBack={() => setOpenId(null)}
              onDone={() => {
                setOpenId(null);
                reload();
              }}
            />
          ) : tab === 'inbox' ? (
            <OfferList
              offers={view!.received}
              empty={
                view!.open
                  ? 'No offers waiting for you. When a friend sends one, it shows here.'
                  : 'No offers. Trading is closed.'
              }
              onOpen={setOpenId}
            />
          ) : tab === 'sent' ? (
            <OfferList
              offers={view!.sent}
              empty="You have no open offers. Start one under “New offer”."
              onOpen={setOpenId}
            />
          ) : tab === 'history' ? (
            <History onOpen={setOpenId} />
          ) : (
            <Compose
              onSent={(id) => {
                reload();
                setTab('sent');
                setOpenId(id);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function Closed({ hasOffers }: { hasOffers: boolean }) {
  return (
    <div className="trading__closed" role="note">
      <p className="display">Trading is closed</p>
      <p>
        Trading between players is not open. If the wardens open it, you will be able to send gifts
        and swaps to friends and guildmates here.
        {hasOffers ? ' Offers from before it closed were withdrawn; nothing was lost.' : ''}
      </p>
      <p>
        <a href={`${routeHref('account')}`}>See where you stand for trading</a>
      </p>
    </div>
  );
}

function Holds({ holds }: { holds: TradeInbox['holds'] }) {
  if (holds.length === 0) return null;
  return (
    <aside className="trading__holds" aria-labelledby="holds-title">
      <h2 id="holds-title" className="caps">
        Held after a trade
      </h2>
      <ul>
        {holds.map((h) => (
          <li key={`${h.characterId}-${h.heldUntil}`}>
            <strong>{h.heroName}</strong>:{' '}
            {[
              h.gold > 0 ? `${formatNumber(h.gold)} gold` : null,
              ...h.materials.map((m) => `${m.quantity} ${materialView(m.materialId).name}`),
              h.items > 0 ? `${h.items} item${h.items === 1 ? '' : 's'}` : null,
            ]
              .filter(Boolean)
              .join(', ')}{' '}
            held until {formatWhen(h.heldUntil)}.
          </li>
        ))}
      </ul>
      <p className="trading__fine">{HOLD_LINE}</p>
    </aside>
  );
}

function sideIsEmpty(s: TradeSide): boolean {
  return s.items.length === 0 && s.gold === 0 && s.materials.length === 0;
}

function sideSummary(s: TradeSide): string {
  const parts = [
    s.items.length ? `${s.items.length} item${s.items.length === 1 ? '' : 's'}` : null,
    s.gold ? `${formatNumber(s.gold)} gold` : null,
    s.materials.length ? `${s.materials.reduce((n, m) => n + m.quantity, 0)} materials` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing';
}

/** Your pans: what you give and what you get, whichever side of the offer you are on. */
function pans(o: TradeOffer): { give: TradeSide; get: TradeSide } {
  return o.role === 'sender' ? { give: o.give, get: o.ask } : { give: o.ask, get: o.give };
}

function OfferList({
  offers,
  empty,
  onOpen,
}: {
  offers: TradeOffer[];
  empty: string;
  onOpen: (id: string) => void;
}) {
  if (offers.length === 0) return <p className="trading__empty">{empty}</p>;
  return (
    <ul className="trading__list">
      {offers.map((o) => {
        const p = pans(o);
        return (
          <li key={o.id} className={`trading__row trading__row--${o.status}`}>
            <div>
              <p className="trading__who">
                {o.role === 'sender' ? 'To ' : 'From '}
                <strong>{who(o)}</strong>
                {o.theirHero ? ` (${o.theirHero.name})` : ''}
              </p>
              <p className="trading__sum">
                You give {sideSummary(p.give)} · you get {sideSummary(p.get)}
              </p>
              <p className="trading__when">
                {o.status === 'open'
                  ? `Expires ${formatWhen(o.expiresAt)}`
                  : o.reversal
                    ? `Reversed by a moderator ${formatWhen(o.reversal.at)}`
                    : `${OFFER_STATUS_WORDS[o.status]} ${o.closedAt ? formatWhen(o.closedAt) : ''}`}
              </p>
            </div>
            <button type="button" className="btn btn--small" onClick={() => onOpen(o.id)}>
              {o.status === 'open' && o.role === 'receiver' ? 'Look closely' : 'View'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function History({ onOpen }: { onOpen: (id: string) => void }) {
  const [state, setState] = useState<Load<{ offers: TradeOffer[]; next: string | null }>>({
    kind: 'loading',
  });
  const load = useCallback((before?: string, prior: TradeOffer[] = []) => {
    void offersApi.history(before).then((r) =>
      setState(
        r.ok
          ? {
              kind: 'ready',
              value: { offers: [...prior, ...r.value.offers], next: r.value.nextCursor },
            }
          : { kind: 'error', failure: r.error },
      ),
    );
  }, []);
  useEffect(() => load(), [load]);
  if (state.kind === 'loading') return <p className="trading__wait">Reading the ledger…</p>;
  if (state.kind === 'error') {
    return (
      <div className="gate__alert" role="alert">
        <p>{describeOfferFailure(state.failure)[0]}</p>
        <button type="button" className="btn btn--small" onClick={() => load()}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <>
      <OfferList offers={state.value.offers} empty="No finished offers yet." onOpen={onOpen} />
      {state.value.next ? (
        <button
          type="button"
          className="btn btn--small"
          onClick={() => load(state.value.next!, state.value.offers)}
        >
          Older offers
        </button>
      ) : null}
    </>
  );
}

/** One pan of the scales: every item in full, then gold and materials. */
function Pan({
  title,
  side,
  emptyText,
  held,
}: {
  title: string;
  side: TradeSide;
  emptyText: string;
  held?: boolean;
}) {
  const empty = sideIsEmpty(side);
  return (
    <section className={`trading__pan${held ? ' trading__pan--held' : ''}`} aria-label={title}>
      <h3 className="caps">{title}</h3>
      {empty ? <p className="trading__nothing">{emptyText}</p> : null}
      {side.items.length > 0 ? (
        <ul className="trading__items">
          {side.items.map((dto) => {
            const item = toItemView(dto);
            return (
              <li key={dto.id} className="trading__item">
                <ItemFrame item={item} scale={2} />
                <ItemTooltip item={item} />
              </li>
            );
          })}
        </ul>
      ) : null}
      {side.gold > 0 || side.materials.length > 0 ? (
        <div className="trading__purse">
          {side.gold > 0 ? <Gold amount={side.gold} /> : null}
          {side.materials.map((m) => (
            <span key={m.materialId} className="trading__mat">
              <MaterialStack
                material={materialView(m.materialId)}
                quantity={m.quantity}
                scale={1}
              />
              {materialView(m.materialId).name}
            </span>
          ))}
        </div>
      ) : null}
      {held && !empty ? <p className="trading__fine">Held for 72 hours once received.</p> : null}
    </section>
  );
}

/** The full view: both pans on the beam, the hold, and what you may do. */
function Scales({ give, get, gift }: { give: TradeSide; get: TradeSide; gift: boolean }) {
  return (
    <div className="trading__scales">
      <Pan title="You give" side={give} emptyText="You give nothing." />
      <div className="trading__beam" aria-hidden="true" />
      <Pan
        title="You get"
        side={get}
        emptyText={gift ? 'You get nothing back: this is a gift.' : 'You get nothing.'}
        held
      />
    </div>
  );
}

function OfferDetail({
  id,
  onBack,
  onDone,
}: {
  id: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [state, setState] = useState<Load<TradeOfferDetail>>({ kind: 'loading' });
  const [heroes, setHeroes] = useState<TradeHeroOption[]>([]);
  const [heroId, setHeroId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    offersApi.detail(id, controller.signal).then(
      (r) =>
        setState(r.ok ? { kind: 'ready', value: r.value } : { kind: 'error', failure: r.error }),
      () => undefined,
    );
    offersApi.heroes(controller.signal).then(
      (r) => {
        if (r.ok) {
          setHeroes(r.value.heroes);
          setHeroId((h) => h || r.value.heroes[0]?.id || '');
        }
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [id]);

  if (state.kind === 'loading') return <p className="trading__wait">Weighing the offer…</p>;
  if (state.kind === 'error') {
    return (
      <div className="gate__alert" role="alert">
        <p>{describeOfferFailure(state.failure)[0]}</p>
        <button type="button" className="btn btn--small" onClick={onBack}>
          Back
        </button>
      </div>
    );
  }
  const { offer, decision } = state.value;
  const p = pans(offer);
  const fixedHero = offer.role === 'receiver' ? offer.yourHero : null;

  const act = async (action: 'accept' | 'decline' | 'cancel') => {
    const actionKey = `${action}:${offer.id}`;
    setBusy(true);
    setProblems([]);
    const r = await offersApi.act(
      offer.id,
      action,
      keys.keyFor(actionKey),
      action === 'accept' && !fixedHero ? heroId : undefined,
    );
    keys.settle(actionKey, r.ok ? null : r.error);
    setBusy(false);
    if (!r.ok) {
      setProblems(describeOfferFailure(r.error));
      return;
    }
    setDone(
      action === 'accept'
        ? `Traded. What you received is held until ${formatWhen(r.value.heldUntil!)}.`
        : action === 'decline'
          ? 'Declined. Everything went back to the sender.'
          : 'Cancelled. Everything is back with your hero.',
    );
  };

  return (
    <article className="trading__detail" aria-labelledby="offer-title">
      <button type="button" className="trading__back" onClick={done ? onDone : onBack}>
        ‹ Back to the list
      </button>
      <h2 id="offer-title" className="display">
        {offer.role === 'sender' ? `Your offer to ${who(offer)}` : `An offer from ${who(offer)}`}
      </h2>
      <p className="trading__meta">
        {OFFER_STATUS_WORDS[offer.status]}
        {offer.status === 'open' ? ` · expires ${formatWhen(offer.expiresAt)}` : ''}
        {offer.yourHero ? ` · your hero: ${offer.yourHero.name}` : ''}
        {offer.theirHero ? ` · their hero: ${offer.theirHero.name}` : ''}
      </p>
      {offer.endText ? <p className="trading__ended">{offer.endText}</p> : null}
      {offer.reversal ? (
        <div className="trading__ended trading__reversed" role="note">
          <p>{offer.reversal.text}</p>
          <p>
            <span className="caps">The moderator’s reason</span> {offer.reversal.reason}
          </p>
        </div>
      ) : null}
      <Scales
        give={p.give}
        get={p.get}
        gift={offer.role === 'receiver' ? offer.gift : sideIsEmpty(offer.ask)}
      />
      {offer.status === 'accepted' && offer.heldUntil ? (
        <p className="trading__hold">
          What changed hands is held until {formatWhen(offer.heldUntil)}.
        </p>
      ) : null}
      {offer.status === 'open' ? <p className="trading__hold">{HOLD_LINE}</p> : null}

      {done ? (
        <p className="shop__notice shop__notice--ok" role="status">
          {done}
        </p>
      ) : offer.status === 'open' ? (
        <div className="trading__actions">
          {offer.role === 'receiver' ? (
            <>
              {decision && !decision.allowed ? (
                <ul className="trading__reasons" aria-label="Why it can’t be accepted now">
                  {[...new Set(decision.reasons.map((r) => r.text))].map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : null}
              {!fixedHero && heroes.length > 0 ? (
                <label className="trading__field">
                  <span className="caps">Hero who receives it</span>
                  <select value={heroId} onChange={(e) => setHeroId(e.target.value)}>
                    {heroes.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name} (level {h.level})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button
                type="button"
                className="btn btn--brass"
                disabled={busy || (decision ? !decision.allowed : false)}
                onClick={() => void act('accept')}
              >
                Accept the trade
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void act('decline')}
              >
                Decline
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void act('cancel')}
            >
              Cancel the offer
            </button>
          )}
        </div>
      ) : null}
      {problems.length > 0 ? (
        <ul className="trading__reasons" role="alert">
          {problems.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
      {/* Ticket T.6: either player can report an offer or a trade to the moderators. */}
      <footer className="trading__report">
        <p className="trading__fine">
          Something wrong with this {offer.status === 'accepted' ? 'trade' : 'offer'}? A moderator
          can look at it and, within 14 days of a trade, undo it. Staff never ask for your items or
          gold.
        </p>
        <button type="button" className="btn btn--small" onClick={() => setReporting(true)}>
          Report this {offer.status === 'accepted' ? 'trade' : 'offer'}
        </button>
      </footer>
      <ReportDialog
        open={reporting}
        onClose={() => setReporting(false)}
        target={{
          target: { kind: 'trade', id: offer.id },
          label: `this ${offer.status === 'accepted' ? 'trade' : 'offer'} with ${who(offer)}`,
        }}
      />
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------------------------

function ItemChooser({
  items,
  chosen,
  onToggle,
  emptyText,
  max,
}: {
  items: ItemDto[];
  chosen: string[];
  onToggle: (id: string) => void;
  emptyText: string;
  max: number;
}) {
  if (items.length === 0) return <p className="trading__nothing">{emptyText}</p>;
  return (
    <ul className="trading__choose">
      {items.map((dto) => {
        const item = toItemView(dto);
        const on = chosen.includes(dto.id);
        return (
          <li key={dto.id}>
            <ItemFrame
              item={item}
              scale={1}
              selected={on}
              disabled={!on && chosen.length >= max}
              context={on ? 'In the offer' : 'Not in the offer'}
              onSelect={() => onToggle(dto.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function AmountFields({
  side,
  onChange,
  gold,
  materials,
}: {
  side: TradeSideDraft;
  onChange: (s: TradeSideDraft) => void;
  /** The most gold this side may hold (spendable, capped per offer); null = unknown. */
  gold: number | null;
  materials: Partial<Record<MaterialId, number>> | null;
}) {
  const ids = materials
    ? MATERIAL_IDS.filter((id) => (materials[id] ?? 0) > 0 && id !== 'gravewardenSeal')
    : MATERIAL_IDS.filter((id) => id !== 'gravewardenSeal');
  return (
    <div className="trading__amounts">
      <label className="trading__field">
        <span className="caps">Gold{gold !== null ? ` (up to ${formatNumber(gold)})` : ''}</span>
        <input
          type="number"
          min={0}
          max={gold ?? 25_000}
          step={1}
          value={side.gold || ''}
          onChange={(e) =>
            onChange({ ...side, gold: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
          }
        />
      </label>
      {ids.map((id) => (
        <label key={id} className="trading__field">
          <span className="caps">
            {materialView(id).name}
            {materials ? ` (up to ${materials[id]})` : ''}
          </span>
          <input
            type="number"
            min={0}
            max={materials?.[id] ?? 1_000_000}
            value={side.materials[id] || ''}
            onChange={(e) =>
              onChange({
                ...side,
                materials: {
                  ...side.materials,
                  [id]: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                },
              })
            }
          />
        </label>
      ))}
    </div>
  );
}

function draftSide(draft: TradeSideDraft, items: ItemDto[]): TradeSide {
  return {
    items: items.filter((i) => draft.itemIds.includes(i.id)),
    gold: draft.gold,
    materials: (Object.entries(draft.materials) as [MaterialId, number][])
      .filter(([, q]) => q > 0)
      .map(([materialId, quantity]) => ({ materialId, quantity })),
  };
}

function Compose({ onSent }: { onSent: (id: string) => void }) {
  const [partners, setPartners] = useState<Load<TradePartner[]>>({ kind: 'loading' });
  const [heroes, setHeroes] = useState<TradeHeroOption[]>([]);
  const [handle, setHandle] = useState('');
  const [partner, setPartner] = useState<TradePartner | null>(null);
  const [heroId, setHeroId] = useState('');
  const [theirHeroId, setTheirHeroId] = useState('');
  const [give, setGive] = useState<TradeSideDraft>(EMPTY_SIDE);
  const [ask, setAsk] = useState<TradeSideDraft>(EMPTY_SIDE);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const composeKey = useRef(crypto.randomUUID());

  useEffect(() => {
    const controller = new AbortController();
    offersApi.partners(controller.signal).then(
      (r) =>
        setPartners(
          r.ok ? { kind: 'ready', value: r.value.partners } : { kind: 'error', failure: r.error },
        ),
      () => undefined,
    );
    offersApi.heroes(controller.signal).then(
      (r) => {
        if (r.ok) {
          setHeroes(r.value.heroes);
          setHeroId((h) => h || r.value.heroes[0]?.id || '');
        }
      },
      () => undefined,
    );
    return () => controller.abort();
  }, []);

  const chooseHandle = (h: string) => {
    setHandle(h);
    setPartner(null);
    setAsk(EMPTY_SIDE);
    setTheirHeroId('');
  };

  useEffect(() => {
    if (!handle) return;
    const controller = new AbortController();
    offersApi.partner(handle, controller.signal).then(
      (r) => {
        if (r.ok) {
          setPartner(r.value);
          setTheirHeroId(r.value.heroes?.[0]?.id ?? '');
        }
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [handle]);

  const hero = heroes.find((h) => h.id === heroId) ?? null;
  const theirHero = partner?.heroes?.find((h) => h.id === theirHeroId) ?? null;
  const spendable = useMemo(() => {
    if (!hero) return null;
    return {
      gold: Math.min(5_000, hero.gold - hero.heldGold),
      materials: Object.fromEntries(hero.materials.map((m) => [m.materialId, m.quantity - m.held])),
    };
  }, [hero]);
  const toggle = (set: typeof setGive, s: TradeSideDraft) => (id: string) =>
    set({
      ...s,
      itemIds: s.itemIds.includes(id) ? s.itemIds.filter((x) => x !== id) : [...s.itemIds, id],
    });
  const giveSide = draftSide(give, hero?.items ?? []);
  const askSide = draftSide(ask, theirHero?.items ?? []);
  const nothing = sideIsEmpty(giveSide) && sideIsEmpty(askSide);

  const send = async () => {
    setBusy(true);
    setProblems([]);
    const r = await offersApi.send(
      {
        to: handle,
        characterId: heroId,
        ...(ask.itemIds.length && theirHeroId ? { receiverCharacterId: theirHeroId } : {}),
        give,
        ask,
      },
      composeKey.current,
    );
    setBusy(false);
    if (!r.ok) {
      if (r.error.status === 0 || r.error.status >= 500) {
        setProblems(['The offer may not have been sent. Try again: it will not be sent twice.']);
      } else {
        composeKey.current = crypto.randomUUID();
        setProblems(describeOfferFailure(r.error));
        setConfirming(false);
      }
      return;
    }
    composeKey.current = crypto.randomUUID();
    onSent(r.value.id);
  };

  if (partners.kind === 'loading') return <p className="trading__wait">Finding your friends…</p>;
  if (partners.kind === 'error') {
    return (
      <div className="gate__alert" role="alert">
        <p>{describeOfferFailure(partners.failure)[0]}</p>
      </div>
    );
  }
  if (partners.value.length === 0) {
    return (
      <p className="trading__empty">
        You can trade with friends and guildmates. <a href={routeHref('friends')}>Find a friend</a>{' '}
        first.
      </p>
    );
  }

  if (confirming) {
    return (
      <article className="trading__detail" aria-labelledby="confirm-title">
        <h2 id="confirm-title" className="display">
          Check your offer to {partner?.displayName ?? 'your friend'}
        </h2>
        <p className="trading__meta">
          From {hero?.name}
          {theirHero && ask.itemIds.length ? ` · asking ${theirHero.name}` : ''} · it can’t be
          changed once sent; cancel it to send another. It expires after 48 hours.
        </p>
        <Scales give={giveSide} get={askSide} gift={sideIsEmpty(askSide)} />
        <p className="trading__hold">
          What you give goes into escrow now and comes back if the offer is declined, cancelled,
          expires or is withdrawn. {HOLD_LINE}
        </p>
        <div className="trading__actions">
          <button
            type="button"
            className="btn btn--brass"
            disabled={busy}
            onClick={() => void send()}
          >
            Send the offer
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setConfirming(false)}
          >
            Change it
          </button>
        </div>
        {problems.length > 0 ? (
          <ul className="trading__reasons" role="alert">
            {problems.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : null}
      </article>
    );
  }

  return (
    <form
      className="trading__compose"
      onSubmit={(e) => {
        e.preventDefault();
        setConfirming(true);
      }}
    >
      <div className="trading__pick">
        <label className="trading__field">
          <span className="caps">Trade with</span>
          <select value={handle} onChange={(e) => chooseHandle(e.target.value)}>
            <option value="">Choose a friend or guildmate</option>
            {partners.value.map((p) => (
              <option key={p.handle} value={p.handle}>
                {p.displayName ?? 'A player'} ({p.relation}
                {p.allowed ? '' : ', not now'})
              </option>
            ))}
          </select>
        </label>
        <label className="trading__field">
          <span className="caps">Your hero</span>
          <select value={heroId} onChange={(e) => setHeroId(e.target.value)}>
            {heroes.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} (level {h.level})
              </option>
            ))}
          </select>
        </label>
      </div>
      {partner && !partner.allowed ? (
        <ul className="trading__reasons" aria-label="Why you can’t trade with them now">
          {[...new Set(partner.reasons.map((r) => r.text))].map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
      {partner && partner.allowed && hero ? (
        <div className="trading__scales trading__scales--compose">
          <section className="trading__pan" aria-label="You give">
            <h3 className="caps">You give, from {hero.name}</h3>
            {hero.heldGold > 0 ? (
              <p className="trading__fine">
                {formatNumber(hero.heldGold)} of this hero’s gold is held after a trade.
              </p>
            ) : null}
            <ItemChooser
              items={hero.items}
              chosen={give.itemIds}
              onToggle={toggle(setGive, give)}
              emptyText="No tradeable items in this hero’s pack (fresh Epic, Legendary or set pieces)."
              max={6}
            />
            <AmountFields
              side={give}
              onChange={setGive}
              gold={spendable?.gold ?? null}
              materials={spendable?.materials ?? null}
            />
          </section>
          <div className="trading__beam" aria-hidden="true" />
          <section className="trading__pan" aria-label="You ask for">
            <h3 className="caps">You ask for</h3>
            {partner.heroes && partner.heroes.length > 1 ? (
              <label className="trading__field">
                <span className="caps">Their hero</span>
                <select
                  value={theirHeroId}
                  onChange={(e) => {
                    setTheirHeroId(e.target.value);
                    setAsk({ ...ask, itemIds: [] });
                  }}
                >
                  {partner.heroes.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} (level {h.level})
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <ItemChooser
              items={theirHero?.items ?? []}
              chosen={ask.itemIds}
              onToggle={toggle(setAsk, ask)}
              emptyText="They have no tradeable items to ask for. Leave this side empty for a gift."
              max={6}
            />
            <AmountFields side={ask} onChange={setAsk} gold={5_000} materials={null} />
          </section>
        </div>
      ) : null}
      {problems.length > 0 ? (
        <ul className="trading__reasons" role="alert">
          {problems.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
      <div className="trading__actions">
        <button
          type="submit"
          className="btn btn--brass"
          disabled={!partner?.allowed || !hero || nothing}
        >
          Review the offer
        </button>
      </div>
    </form>
  );
}
