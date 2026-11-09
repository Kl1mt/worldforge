import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  PLAYER_TEXT_RULES,
  RARITIES,
  SANCTION_DURATIONS,
  getClass,
  isClassId,
  validatePlayerText,
} from '@worldforge/game-core';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { MaterialStack } from '../components/MaterialStack';
import { ActionKeys } from '../game/economy';
import { toItemView } from '../game/items';
import { materialView } from '../game/materials';
import type { ApiFailure } from '../lib/api';
import { formatNumber } from '../lib/format';
import { moderationCaseHref, profileHref } from '../lib/route';
import { formatWhen } from '../social/api';
import {
  TRADE_STATUS_WORDS,
  describeTradeModFailure,
  tradeIdFromHash,
  tradeModApi,
  type ModTradeCase,
  type ModTradeSide,
  type ModTradeSummary,
  type ReturnMove,
  type ReversalRefusal,
  type ReversalSanction,
  type TradeListFilter,
  type TradeListStatus,
} from '../social/tradeMod';
import { Gold } from './economy/ShopHeader';
import { TradePatterns } from './TradePatterns';
import './trade-mod.css';

/**
 * Ticket T.6: the trade desk for moderators and admins (docs/TRADING.md "T.6 as built"): the
 * trade history (everything, one player's, or one pair's), one trade's case file (both sides in
 * full, the heroes, the holds, the audit trail, open reports) and its reversal: a full view of
 * exactly what moves back, a reason both players read, and an optional sanction. Below it the
 * pattern report, whose names open the history. Shown on the moderator docket and in the admin
 * panel's "Trades" tab.
 */

type Load<T> =
  { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; error: ApiFailure };

const keys = new ActionKeys();

const RARITY_WORDS: Record<string, string> = Object.fromEntries(
  RARITIES.map((r) => [r.id, r.name]),
);

const STATUS_CHOICES: { id: TradeListStatus; label: string }[] = [
  { id: 'all', label: 'Every offer' },
  { id: 'accepted', label: 'Completed' },
  { id: 'reversed', label: 'Reversed' },
  { id: 'open', label: 'Open' },
  { id: 'ended', label: 'Ended without a trade' },
];

const SANCTIONS: {
  id: ReversalSanction['action'];
  label: string;
  kind: 'mute' | 'suspend' | 'trade';
}[] = [
  { id: 'restrictTrade', label: 'Restrict trading', kind: 'trade' },
  { id: 'mute', label: 'Mute', kind: 'mute' },
  { id: 'suspend', label: 'Suspend', kind: 'suspend' },
];

function hoursLabel(h: number): string {
  if (h % (24 * 365) === 0) return `${h / (24 * 365)} year`;
  if (h % 24 === 0) return `${h / 24} day${h === 24 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

const heroLine = (h: ModTradeCase['senderHero']) =>
  h
    ? `${h.name}, ${isClassId(h.classId) ? getClass(h.classId).name : h.classId} level ${h.level}`
    : 'no hero';

function countLine(c: ModTradeSummary['give']): string {
  const parts: string[] = [];
  if (c.items) parts.push(`${c.items} item${c.items === 1 ? '' : 's'}`);
  if (c.gold) parts.push(`${formatNumber(c.gold)} gold`);
  if (c.materialUnits) parts.push(`${formatNumber(c.materialUnits)} materials`);
  return parts.length ? parts.join(', ') : 'nothing';
}

export function TradeDesk() {
  const [filter, setFilter] = useState<TradeListFilter>({ status: 'all' });
  const [openId, setOpenId] = useState<string | null>(() => tradeIdFromHash(window.location.hash));
  const deskRef = useRef<HTMLElement>(null);
  // `#/moderation?trade=<id>` (a report case's "Open the trade") opens that trade, once.
  useEffect(() => {
    const follow = () => {
      const wanted = tradeIdFromHash(window.location.hash);
      if (!wanted) return;
      setOpenId(wanted);
      window.history.replaceState(null, '', '#/moderation');
      deskRef.current?.scrollIntoView({ block: 'start' });
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  const lookUp = useCallback((handle: string, other?: string) => {
    setOpenId(null);
    setFilter({ status: 'all', handle, ...(other ? { with: other } : {}) });
    deskRef.current?.scrollIntoView({ block: 'start' });
  }, []);
  return (
    <>
      <section ref={deskRef} className="tdesk panel-ledger" aria-labelledby="tdesk-title">
        <header className="tdesk__head">
          <div>
            <p className="caps">Wardens · Trading</p>
            <h2 id="tdesk-title" className="display">
              The trade ledger
            </h2>
          </div>
        </header>
        {openId ? (
          <TradeCaseFile
            key={openId}
            id={openId}
            onBack={() => setOpenId(null)}
            onLookUp={lookUp}
          />
        ) : (
          <TradeHistory
            key={JSON.stringify(filter)}
            filter={filter}
            onFilter={setFilter}
            onOpen={setOpenId}
          />
        )}
      </section>
      <TradePatterns onLookUp={lookUp} />
    </>
  );
}

// ---- History ------------------------------------------------------------------------------

function TradeHistory({
  filter,
  onFilter,
  onOpen,
}: {
  filter: TradeListFilter;
  onFilter: (f: TradeListFilter) => void;
  onOpen: (id: string) => void;
}) {
  const ids = useId();
  const [state, setState] = useState<Load<{ trades: ModTradeSummary[]; next: string | null }>>({
    kind: 'loading',
  });
  const [draft, setDraft] = useState({ handle: filter.handle ?? '', with: filter.with ?? '' });

  const load = useCallback(
    (before?: string, prior: ModTradeSummary[] = []) => {
      void tradeModApi.list({ ...filter, ...(before ? { before } : {}) }).then((r) =>
        setState(
          r.ok
            ? {
                kind: 'ready',
                value: { trades: [...prior, ...r.value.trades], next: r.value.nextCursor },
              }
            : { kind: 'error', error: r.error },
        ),
      );
    },
    [filter],
  );
  useEffect(() => load(), [load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onFilter({
      status: filter.status ?? 'all',
      ...(draft.handle.trim() ? { handle: draft.handle.trim() } : {}),
      ...(draft.handle.trim() && draft.with.trim() ? { with: draft.with.trim() } : {}),
    });
  };

  return (
    <div className="tdesk__history">
      <form className="tdesk__filter" onSubmit={submit} aria-label="Find trades">
        <label className="tdesk__field" htmlFor={`${ids}-handle`}>
          <span className="caps">Player handle</span>
          <input
            id={`${ids}-handle`}
            value={draft.handle}
            onChange={(e) => setDraft({ ...draft, handle: e.target.value })}
            placeholder="everyone"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="tdesk__field" htmlFor={`${ids}-with`}>
          <span className="caps">Traded with (handle)</span>
          <input
            id={`${ids}-with`}
            value={draft.with}
            onChange={(e) => setDraft({ ...draft, with: e.target.value })}
            placeholder="anyone"
            autoComplete="off"
            spellCheck={false}
            disabled={!draft.handle.trim()}
          />
        </label>
        <label className="tdesk__field" htmlFor={`${ids}-status`}>
          <span className="caps">Show</span>
          <select
            id={`${ids}-status`}
            value={filter.status ?? 'all'}
            onChange={(e) => onFilter({ ...filter, status: e.target.value as TradeListStatus })}
          >
            {STATUS_CHOICES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn--small">
          Look up
        </button>
        {filter.handle ? (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => onFilter({ status: 'all' })}
          >
            Everyone
          </button>
        ) : null}
      </form>
      <p className="tdesk__lede">
        {filter.handle
          ? filter.with
            ? `Offers between ${filter.handle} and ${filter.with}, newest first.`
            : `Offers ${filter.handle} sent or received, newest first.`
          : 'Every offer between players you can act on, newest first. Your own trades are never listed.'}
      </p>
      {state.kind === 'loading' ? (
        <p className="tdesk__wait" role="status">
          Opening the ledger…
        </p>
      ) : state.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>The trade ledger could not be read. {describeTradeModFailure(state.error)}</p>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => {
              setState({ kind: 'loading' });
              load();
            }}
          >
            Try again
          </button>
        </div>
      ) : state.value.trades.length === 0 ? (
        <p className="tdesk__empty">
          {filter.handle
            ? 'No offers here. Check the handle (it is on the player’s profile), or show every offer.'
            : 'No trades yet. Trading may still be closed; offers appear here once players trade.'}
        </p>
      ) : (
        <>
          <ol className="tdesk__list">
            {state.value.trades.map((t) => (
              <li
                key={t.id}
                className={`tdesk__row tdesk__row--${t.reversedAt ? 'reversed' : t.status}`}
              >
                <div className="tdesk__row-main">
                  <p className="tdesk__row-who">
                    <strong>{t.sender.displayName}</strong>
                    <span className="tdesk__arrow" aria-hidden="true">
                      {' '}
                      ⇄{' '}
                    </span>
                    <span className="visually-hidden"> and </span>
                    <strong>{t.receiver.displayName}</strong>
                  </p>
                  <p className="tdesk__row-sum">
                    {t.kind === 'gift' ? 'Gift' : 'Swap'}: {countLine(t.give)}
                    {t.kind === 'swap' ? ` for ${countLine(t.ask)}` : ''}
                  </p>
                  <p className="tdesk__row-when">
                    <span
                      className={`caps tdesk__chip tdesk__chip--${t.reversedAt ? 'reversed' : t.status}`}
                    >
                      {t.reversedAt ? 'Reversed' : TRADE_STATUS_WORDS[t.status]}
                    </span>{' '}
                    {formatWhen(t.closedAt ?? t.createdAt)}
                  </p>
                </div>
                <button type="button" className="btn btn--small" onClick={() => onOpen(t.id)}>
                  Open the case
                </button>
              </li>
            ))}
          </ol>
          {state.value.next ? (
            <button
              type="button"
              className="btn btn--small"
              onClick={() => load(state.value.next!, state.value.trades)}
            >
              Older offers
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---- One trade ----------------------------------------------------------------------------

function SidePan({ title, side }: { title: string; side: ModTradeSide }) {
  const empty = side.items.length === 0 && side.gold === 0 && side.materials.length === 0;
  return (
    <section className="tdesk__pan" aria-label={title}>
      <h4 className="caps">{title}</h4>
      {empty ? <p className="tdesk__nothing">Nothing.</p> : null}
      {side.items.length > 0 ? (
        <ul className="tdesk__items">
          {side.items.map((dto) => {
            const item = toItemView(dto);
            return (
              <li key={dto.id} className="tdesk__item">
                <ItemFrame item={item} scale={2} />
                <ItemTooltip item={item} />
              </li>
            );
          })}
        </ul>
      ) : null}
      <Purse gold={side.gold} materials={side.materials} />
    </section>
  );
}

function Purse({ gold, materials }: { gold: number; materials: ModTradeSide['materials'] }) {
  if (gold === 0 && materials.length === 0) return null;
  return (
    <div className="tdesk__purse">
      {gold > 0 ? <Gold amount={gold} /> : null}
      {materials.map((m) => (
        <span key={m.materialId} className="tdesk__mat">
          <MaterialStack material={materialView(m.materialId)} quantity={m.quantity} scale={1} />
          {materialView(m.materialId).name}
        </span>
      ))}
    </div>
  );
}

function itemName(c: ModTradeCase, id: string | undefined): string {
  if (!id) return '';
  const dto = [...c.give.items, ...c.ask.items].find((i) => i.id === id);
  if (!dto) return 'an item';
  const v = toItemView(dto);
  return `${RARITY_WORDS[v.rarity] ?? ''} ${v.name}`.trim();
}

function refusalLine(c: ModTradeCase, r: ReversalRefusal): string {
  const whose =
    r.party === 'sender'
      ? c.sender.displayName
      : r.party === 'receiver'
        ? c.receiver.displayName
        : '';
  const bits: string[] = [];
  if (r.itemId) bits.push(itemName(c, r.itemId));
  if (r.materialId) bits.push(materialView(r.materialId).name);
  if (r.received !== undefined) {
    bits.push(`received ${formatNumber(r.received)}, holds ${formatNumber(r.available ?? 0)} now`);
  }
  const detail = [whose && `${whose}’s side`, ...bits].filter(Boolean).join(' · ');
  return detail ? `${r.text} (${detail})` : r.text;
}

function TradeCaseFile({
  id,
  onBack,
  onLookUp,
}: {
  id: string;
  onBack: () => void;
  onLookUp: (handle: string, other?: string) => void;
}) {
  const [state, setState] = useState<Load<ModTradeCase>>({ kind: 'loading' });
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const load = useCallback(() => {
    void tradeModApi
      .case(id)
      .then((r) =>
        setState(r.ok ? { kind: 'ready', value: r.value } : { kind: 'error', error: r.error }),
      );
  }, [id]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    if (state.kind === 'ready') headRef.current?.focus();
  }, [state.kind]);

  if (state.kind === 'loading') {
    return (
      <p className="tdesk__wait" role="status">
        Laying out the trade…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="gate__alert" role="alert">
        <p>{describeTradeModFailure(state.error)}</p>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => {
            setState({ kind: 'loading' });
            load();
          }}
        >
          Try again
        </button>{' '}
        <button type="button" className="btn btn--small" onClick={onBack}>
          Back to the ledger
        </button>
      </div>
    );
  }
  const c = state.value;
  const status = c.reversal ? 'Reversed' : TRADE_STATUS_WORDS[c.status];
  return (
    <article className="tdesk__case" aria-labelledby="tdesk-case-title">
      <button type="button" className="tdesk__back" onClick={onBack}>
        ← The ledger
      </button>
      <header className="tdesk__case-head">
        <p className="caps">
          {c.kind === 'gift' ? 'Gift' : 'Swap'} · {status} · sent {formatWhen(c.createdAt)}
          {c.closedAt ? ` · closed ${formatWhen(c.closedAt)}` : ''}
        </p>
        <h3 id="tdesk-case-title" ref={headRef} tabIndex={-1} className="display">
          {c.sender.displayName} to {c.receiver.displayName}
        </h3>
      </header>
      {notice ? (
        <p className="tdesk__notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="tdesk__parties">
        {(
          [
            ['Sender', c.sender, c.senderHero],
            ['Receiver', c.receiver, c.receiverHero],
          ] as const
        ).map(([label, p, h]) => (
          <div key={label} className="tdesk__party">
            <p className="caps">{label}</p>
            <p>
              <a href={profileHref(p.handle)}>{p.displayName}</a>
              {p.role !== 'player' ? (
                <span className="caps tdesk__role"> {p.role}</span>
              ) : null}{' '}
              <span className="tdesk__handle">{p.handle}</span>
            </p>
            <p className="tdesk__fine">{heroLine(h)}</p>
            <button type="button" className="tdesk__link" onClick={() => onLookUp(p.handle)}>
              All their trades
            </button>
          </div>
        ))}
        <button
          type="button"
          className="tdesk__link tdesk__pairlink"
          onClick={() => onLookUp(c.sender.handle, c.receiver.handle)}
        >
          Every trade between these two
        </button>
      </div>

      <div className="tdesk__scales">
        <SidePan title={`${c.sender.displayName} gave`} side={c.give} />
        <SidePan title={`${c.receiver.displayName} gave`} side={c.ask} />
      </div>

      {c.holds.length > 0 ? (
        <section className="tdesk__holds" aria-label="Holds">
          <h4 className="caps">Holds</h4>
          <ul>
            {c.holds.map((h, n) => (
              <li key={n}>
                {h.party === 'sender' ? c.sender.displayName : c.receiver.displayName}: {h.items}{' '}
                item{h.items === 1 ? '' : 's'}, {formatNumber(h.gold)} gold
                {h.materials.length
                  ? `, ${h.materials.reduce((s, m) => s + m.quantity, 0)} materials`
                  : ''}{' '}
                ·{' '}
                {h.releasedAt
                  ? `ended ${formatWhen(h.releasedAt)}`
                  : `held until ${formatWhen(h.heldUntil)}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Reversal
        c={c}
        confirming={confirming}
        onConfirm={() => setConfirming(true)}
        onCancel={() => setConfirming(false)}
        onDone={(next, message) => {
          setConfirming(false);
          setNotice(message);
          setState({ kind: 'ready', value: next });
        }}
      />

      <section className="tdesk__trail" aria-label="Audit trail">
        <h4 className="caps">Audit trail</h4>
        <ol>
          {c.trail.map((e, n) => (
            <li key={n}>
              <span className="tdesk__trail-when">{formatWhen(e.at)}</span> <span>{e.text}</span>
              {e.by ? <span className="tdesk__fine"> · {e.by.displayName}</span> : null}
            </li>
          ))}
        </ol>
      </section>

      {c.reports.open > 0 && c.reports.reportId ? (
        <p className="tdesk__reports">
          {c.reports.open} open report{c.reports.open === 1 ? '' : 's'} about this trade.{' '}
          <a href={moderationCaseHref(c.reports.reportId)}>Open the report case</a>
        </p>
      ) : null}
    </article>
  );
}

function MoveList({ title, move, c }: { title: string; move: ReturnMove; c: ModTradeCase }) {
  const empty = move.items.length === 0 && move.gold === 0 && move.materials.length === 0;
  return (
    <section className="tdesk__move" aria-label={title}>
      <h5 className="caps">{title}</h5>
      {empty ? <p className="tdesk__nothing">Nothing.</p> : null}
      {move.items.length > 0 ? (
        <ul className="tdesk__move-items">
          {move.items.map((i) => (
            <li key={i.id}>
              {itemName(c, i.id)}
              {i.worn ? ' — worn now: it is taken off' : ''}
              {i.locked ? ' — locked: it goes back unlocked' : ''}
            </li>
          ))}
        </ul>
      ) : null}
      <Purse gold={move.gold} materials={move.materials} />
    </section>
  );
}

function Reversal({
  c,
  confirming,
  onConfirm,
  onCancel,
  onDone,
}: {
  c: ModTradeCase;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDone: (next: ModTradeCase, message: string) => void;
}) {
  const ids = useId();
  const [reason, setReason] = useState('');
  const [sanction, setSanction] = useState<ReversalSanction['action'] | ''>('');
  const [subject, setSubject] = useState(c.receiver.handle);
  const [hours, setHours] = useState(24 * 7);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const kind = SANCTIONS.find((s) => s.id === sanction)?.kind;
  const presets = useMemo(() => (kind ? SANCTION_DURATIONS[kind].presets : []), [kind]);
  const duration = presets.includes(hours) ? hours : (presets[0] ?? 0);
  const reasonCheck = validatePlayerText('sanctionReason', reason);
  const max = PLAYER_TEXT_RULES.sanctionReason.max;

  if (c.reversal) {
    return (
      <section className="tdesk__verdict tdesk__verdict--done" aria-label="Reversal">
        <h4 className="caps">Reversed {formatWhen(c.reversal.at)}</h4>
        <p>
          {c.reversal.by ? `${c.reversal.by.displayName}: ` : ''}
          {c.reversal.reason}
        </p>
        <p className="tdesk__fine">Both players see this reason in their trade history.</p>
      </section>
    );
  }
  if (c.status !== 'accepted') {
    return (
      <section className="tdesk__verdict" aria-label="Reversal">
        <p className="tdesk__fine">
          Only a completed trade can be reversed; nothing changed hands here.
        </p>
      </section>
    );
  }
  if (!c.reversible.possible) {
    return (
      <section className="tdesk__verdict tdesk__verdict--no" aria-label="Reversal">
        <h4 className="caps">This trade can’t be reversed</h4>
        <p>
          A reversal moves everything back or nothing, and it never creates items, gold or
          materials.
        </p>
        <ul className="tdesk__refusals">
          {c.reversible.refusals.map((r, n) => (
            <li key={n}>{refusalLine(c, r)}</li>
          ))}
        </ul>
        <p className="tdesk__fine">
          If it can’t be undone, a sanction from a report case is the remedy.
        </p>
      </section>
    );
  }
  if (!c.reversible.canAct) {
    return (
      <section className="tdesk__verdict" aria-label="Reversal">
        <p>{c.reversible.cannotAct}</p>
      </section>
    );
  }
  if (!confirming) {
    return (
      <section className="tdesk__verdict" aria-label="Reversal">
        <p>
          Everything in this trade is still where it arrived, so it can be reversed
          {c.reversible.deadline ? ` until ${formatWhen(c.reversible.deadline)}` : ''}.
        </p>
        <button type="button" className="btn" onClick={onConfirm}>
          Reverse this trade…
        </button>
      </section>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reasonCheck.ok) return;
    const body = {
      reason: reason.trim(),
      ...(sanction
        ? { sanction: { handle: subject, action: sanction, durationHours: duration } }
        : {}),
    };
    const action = `reverse:${c.id}`;
    setBusy(true);
    setProblems([]);
    const r = await tradeModApi.reverse(c.id, body, keys.keyFor(action));
    keys.settle(action, r.ok ? null : r.error);
    setBusy(false);
    if (!r.ok) {
      const reasons = (r.error.details as { reasons?: ReversalRefusal[] } | undefined)?.reasons;
      setProblems(
        r.error.code === 'trade_not_reversible' && reasons?.length
          ? reasons.map((x) => refusalLine(c, x))
          : [describeTradeModFailure(r.error)],
      );
      return;
    }
    onDone(
      r.value.case,
      `Reversed. Everything went back to the hero it came from${r.value.sanction ? ', and the sanction is in force' : ''}.`,
    );
  };

  return (
    <form
      className="tdesk__confirm"
      onSubmit={(e) => void submit(e)}
      aria-labelledby={`${ids}-title`}
    >
      <h4 id={`${ids}-title`} className="display">
        Reverse the whole trade
      </h4>
      <p>
        Exactly this moves back, in one step. Nothing is created or destroyed; held value is
        released. The items become as they were traded (tradeable once again).
      </p>
      <div className="tdesk__moves">
        <MoveList
          title={`Back to ${c.sender.displayName} (${c.senderHero?.name ?? 'their hero'})`}
          move={c.moves.toSender}
          c={c}
        />
        <MoveList
          title={`Back to ${c.receiver.displayName} (${c.receiverHero?.name ?? 'their hero'})`}
          move={c.moves.toReceiver}
          c={c}
        />
      </div>
      <label className="tdesk__field tdesk__field--wide" htmlFor={`${ids}-reason`}>
        <span className="caps">Reason (both players read it)</span>
        <input
          id={`${ids}-reason`}
          value={reason}
          maxLength={max}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby={`${ids}-reason-hint`}
          required
        />
        <span id={`${ids}-reason-hint`} className="tdesk__fine">
          {reason.trim() === '' || reasonCheck.ok
            ? `3 to ${max} characters, one line.`
            : 'Use 3 to 300 characters on one line.'}
        </span>
      </label>
      <fieldset className="tdesk__sanction">
        <legend className="caps">And a sanction (optional)</legend>
        <label className="tdesk__field" htmlFor={`${ids}-sanction`}>
          <span className="caps">Sanction</span>
          <select
            id={`${ids}-sanction`}
            value={sanction}
            onChange={(e) => setSanction(e.target.value as ReversalSanction['action'] | '')}
          >
            <option value="">None</option>
            {SANCTIONS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {sanction ? (
          <>
            <label className="tdesk__field" htmlFor={`${ids}-subject`}>
              <span className="caps">On</span>
              <select
                id={`${ids}-subject`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                <option value={c.sender.handle}>{c.sender.displayName} (sender)</option>
                <option value={c.receiver.handle}>{c.receiver.displayName} (receiver)</option>
              </select>
            </label>
            <label className="tdesk__field" htmlFor={`${ids}-hours`}>
              <span className="caps">For</span>
              <select
                id={`${ids}-hours`}
                value={duration}
                onChange={(e) => setHours(Number(e.target.value))}
              >
                {presets.map((h) => (
                  <option key={h} value={h}>
                    {hoursLabel(h)}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
      </fieldset>
      {problems.length > 0 ? (
        <ul className="tdesk__refusals" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div className="tdesk__actions">
        <button type="submit" className="btn tdesk__danger" disabled={busy || !reasonCheck.ok}>
          {busy ? 'Reversing…' : 'Reverse everything'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Back
        </button>
      </div>
    </form>
  );
}
