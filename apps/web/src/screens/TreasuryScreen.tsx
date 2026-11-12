import { useId, useRef, useState } from 'react';
import {
  GUILD_HALL_KINDS,
  findGuildHonourTier,
  type GuildHallKind,
  type MaterialId,
  type TreasuryResource,
} from '@worldforge/game-core';
import { useCharacters } from '../characters/CharactersProvider';
import { ActionKeys } from '../game/economy';
import { materialView } from '../game/materials';
import { formatNumber } from '../lib/format';
import { routeHref } from '../lib/route';
import { boardHref } from '../lib/route';
import { describeHallFailure, guildHallApi, useLoad, type TreasuryView } from '../social/guildHall';
import {
  HallBanner,
  HallCrest,
  HallStage,
  backdropClass,
  guildNameClass,
} from '../social/HallLook';
import './treasury.css';

/**
 * Ticket 8.4: the guild treasury and the hall's cosmetic upgrades (`#/treasury`, docs/GUILD_HALLS.md).
 * Members give gold and materials (after the no-refund notice, confirmed each time); the leader and
 * officers buy upgrades and hang them. The guild's place on the season's guild roll and its honours
 * sit beside it, with who counts (the churn rules) in plain words. Loading, error (Try again),
 * not-in-a-guild, stale and success states. Cosmetic only: nothing here changes a number in play.
 */

const KIND_TITLES: Record<GuildHallKind, string> = {
  hallBanner: 'Hall banners',
  crestFrame: 'Crest frames',
  backdrop: 'Hall light',
  titleColour: 'Name colours',
};

const resourceName = (r: TreasuryResource) =>
  r === 'gold' ? 'Gold' : materialView(r as MaterialId).name;

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function TreasuryScreen() {
  const { state, reload, set } = useLoad<TreasuryView>((s) => guildHallApi.hall(s), [], 120_000);
  return (
    <section className="treasury" aria-labelledby="treasury-title">
      <header className="treasury__head">
        <p className="caps treasury__eyebrow">Graumark · Guild Hall</p>
        <h1 id="treasury-title" className="display">
          The treasury &amp; the hall
        </h1>
        <p className="treasury__lede">
          What the guild gives together hangs on its walls. Looks only: nothing here makes a hero
          stronger or luckier.
        </p>
      </header>
      {state.kind === 'loading' ? (
        <p className="treasury__status" role="status">
          The steward opens the ledger…
        </p>
      ) : state.kind === 'error' ? (
        state.error.code === 'not_in_guild' ? (
          <div className="treasury__empty panel-iron">
            <p>You are not sworn to a guild, so there is no treasury to give to.</p>
            <a className="btn btn--brass" href={routeHref('guild')}>
              To the Guild Hall
            </a>
          </div>
        ) : (
          <div className="treasury__empty panel-iron" role="alert">
            <p>The ledger cannot be read right now: {describeHallFailure(state.error)}</p>
            <button type="button" className="btn" onClick={reload}>
              Try again
            </button>
          </div>
        )
      ) : (
        <TreasuryBody view={state.value} stale={state.stale} onView={set} />
      )}
    </section>
  );
}

function TreasuryBody({
  view,
  stale,
  onView,
}: {
  view: TreasuryView;
  stale: boolean;
  onView: (v: TreasuryView) => void;
}) {
  const keys = useRef(new ActionKeys());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const act = async (action: string, fn: (key: string) => Promise<TreasuryView | string>) => {
    setBusy(action);
    setMessage(null);
    const out = await fn(keys.current.keyFor(action));
    setBusy(null);
    if (typeof out === 'string') {
      setMessage({ kind: 'error', text: out });
    } else {
      onView(out);
    }
    return out;
  };
  const buy = (id: string, name: string) =>
    act(`buy:${id}`, async (key) => {
      const res = await guildHallApi.buy(id, key);
      keys.current.settle(`buy:${id}`, res.ok ? null : res.error);
      if (!res.ok) return describeHallFailure(res.error);
      setMessage({ kind: 'ok', text: `${name} is the guild’s now.` });
      return res.value;
    });
  const hang = (kind: GuildHallKind, id: string | null) =>
    act(`hang:${kind}:${id}`, async (key) => {
      const res = await guildHallApi.display({ [kind]: id }, key);
      keys.current.settle(`hang:${kind}:${id}`, res.ok ? null : res.error);
      return res.ok ? res.value : describeHallFailure(res.error);
    });

  return (
    <div className="treasury__body">
      <div className="treasury__main">
        <HallStage
          look={view.look}
          emblem={view.guild.emblem}
          name={view.guild.name}
          tag={view.guild.tag}
        >
          {stale ? (
            <p className="treasury__stale">Could not refresh: showing the last ledger.</p>
          ) : null}
        </HallStage>
        {message ? (
          <p
            className={`treasury__message treasury__message--${message.kind}`}
            role={message.kind === 'error' ? 'alert' : 'status'}
          >
            {message.text}
          </p>
        ) : null}
        <Holdings view={view} />
        {view.can.contribute ? <GiveForm view={view} onView={onView} /> : null}
        {GUILD_HALL_KINDS.map((kind) => (
          <section key={kind} className="treasury__shelf panel-iron" aria-label={KIND_TITLES[kind]}>
            <h2 className="caps treasury__shelf-title">{KIND_TITLES[kind]}</h2>
            <ul className="treasury__wares">
              {view.upgrades
                .filter((u) => u.kind === kind)
                .map((u) => {
                  const hung = view.look[kind] === u.id;
                  return (
                    <li
                      key={u.id}
                      className={`treasury__ware${u.owned ? ' treasury__ware--owned' : ''}`}
                    >
                      <div className="treasury__ware-look">
                        <WareLook kind={kind} id={u.id} emblem={view.guild.emblem} />
                      </div>
                      <div className="treasury__ware-text">
                        <h3 className="treasury__ware-name">{u.name}</h3>
                        <p className="treasury__ware-desc">{u.description}</p>
                        <p className="treasury__ware-price">
                          {u.owned
                            ? `Bought on ${u.boughtOn}`
                            : [
                                `${formatNumber(u.price.gold)} gold`,
                                ...Object.entries(u.price.materials).map(
                                  ([m, n]) =>
                                    `${formatNumber(n ?? 0)} ${resourceName(m as TreasuryResource)}`,
                                ),
                              ].join(' · ')}
                        </p>
                      </div>
                      <div className="treasury__ware-act">
                        {!u.owned && view.can.buy ? (
                          <button
                            type="button"
                            className="btn btn--brass btn--small"
                            disabled={!u.affordable || busy !== null}
                            onClick={() => void buy(u.id, u.name)}
                          >
                            {u.affordable ? 'Buy for the hall' : 'Not enough yet'}
                          </button>
                        ) : null}
                        {u.owned && view.can.display ? (
                          <button
                            type="button"
                            className="btn btn--small"
                            aria-pressed={hung}
                            disabled={busy !== null}
                            onClick={() => void hang(kind, hung ? null : u.id)}
                          >
                            {hung ? 'Take down' : 'Hang it'}
                          </button>
                        ) : null}
                        {u.owned && !view.can.display ? (
                          <span className="treasury__ware-note">
                            {hung ? 'Hung' : 'In the store'}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
        {!view.can.buy ? (
          <p className="treasury__fine">The leader and officers decide what the treasury buys.</p>
        ) : null}
      </div>
      <aside className="treasury__side">
        <SeasonSlip view={view} />
      </aside>
    </div>
  );
}

function WareLook({ kind, id, emblem }: { kind: GuildHallKind; id: string; emblem: string }) {
  if (kind === 'hallBanner') return <HallBanner id={id} scale={2} />;
  if (kind === 'crestFrame') return <HallCrest frame={id} emblem={emblem} scale={1} />;
  if (kind === 'backdrop')
    return <span className={`treasury__swatch ${backdropClass(id)}`} aria-hidden="true" />;
  return (
    <span className={`treasury__colour display ${guildNameClass(id)}`} aria-hidden="true">
      Aa
    </span>
  );
}

function Holdings({ view }: { view: TreasuryView }) {
  return (
    <section className="treasury__ledger panel-iron" aria-label="The treasury">
      <h2 className="caps treasury__shelf-title">In the treasury</h2>
      <table className="treasury__table">
        <thead>
          <tr>
            <th scope="col">Resource</th>
            <th scope="col">Held</th>
            <th scope="col">Your share today</th>
            <th scope="col">The hall still needs</th>
          </tr>
        </thead>
        <tbody>
          {view.resources.map((r) => (
            <tr key={r.resource}>
              <th scope="row">{resourceName(r.resource)}</th>
              <td>
                {formatNumber(
                  r.resource === 'gold'
                    ? view.treasury.gold
                    : (view.treasury.materials[r.resource] ?? 0),
                )}
              </td>
              <td>
                {formatNumber(r.givenToday)} / {formatNumber(r.cap)}
              </td>
              <td>{formatNumber(r.room)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="treasury__fine">
        No one may give more than a tenth of the whole hall&rsquo;s price in any one thing a day, so
        the hall is the guild&rsquo;s work, not one purse&rsquo;s. Your share resets at midnight
        (UTC), {day(view.window.resetsAt)}.
      </p>
    </section>
  );
}

function GiveForm({ view, onView }: { view: TreasuryView; onView: (v: TreasuryView) => void }) {
  const id = useId();
  const roster = useCharacters();
  const heroes = roster.state.kind === 'ready' ? roster.state.roster.characters : [];
  const [heroId, setHeroId] = useState(() => roster.active?.id ?? heroes[0]?.id ?? '');
  const hero = heroes.find((h) => h.id === heroId) ?? heroes[0];
  const [resource, setResource] = useState<TreasuryResource>('gold');
  const [amount, setAmount] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const keys = useRef(new ActionKeys());
  const n = Number(amount);
  const valid = Number.isInteger(n) && n > 0;

  const submit = async () => {
    if (!hero || !valid || !understood) return;
    const action = `give:${hero.id}:${resource}:${n}`;
    setBusy(true);
    setResult(null);
    const res = await guildHallApi.contribute(
      hero.id,
      [{ resource, amount: n }],
      keys.current.keyFor(action),
    );
    keys.current.settle(action, res.ok ? null : res.error);
    setBusy(false);
    if (!res.ok) {
      setResult({ kind: 'error', text: describeHallFailure(res.error) });
      return;
    }
    const took = res.value.accepted.map(
      (a) => `${formatNumber(a.amount)} ${resourceName(a.resource)}`,
    );
    const cut = Object.keys(res.value.limited).length > 0;
    setResult({
      kind: 'ok',
      text: `Given: ${took.join(', ')}.${cut ? ' The rest stays with your hero (today’s share, or all the hall still needs).' : ''}`,
    });
    setAmount('');
    setUnderstood(false);
    roster.reload();
    onView(res.value.hall);
  };

  return (
    <form
      className="treasury__give panel-iron"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="caps treasury__shelf-title">Give to the treasury</h2>
      <p className="treasury__notice" id={`${id}-notice`}>
        <strong>Never given back.</strong> {view.notice}
      </p>
      {heroes.length === 0 ? (
        <p className="treasury__fine">You have no hero to give from.</p>
      ) : (
        <div className="treasury__give-row">
          <label className="field">
            <span className="field__label caps">Hero</span>
            <select value={hero?.id ?? ''} onChange={(e) => setHeroId(e.target.value)}>
              {heroes.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} · {formatNumber(h.gold)} gold
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label caps">What</span>
            <select
              value={resource}
              onChange={(e) => setResource(e.target.value as TreasuryResource)}
            >
              {view.resources.map((r) => (
                <option key={r.resource} value={r.resource}>
                  {resourceName(r.resource)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label caps">How much</span>
            <input
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
              aria-describedby={`${id}-notice`}
            />
          </label>
        </div>
      )}
      <label className="treasury__ack">
        <input
          type="checkbox"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
        />{' '}
        I understand this gift is never given back, even if I leave or the guild is disbanded.
      </label>
      <button
        type="submit"
        className="btn btn--brass"
        disabled={!hero || !valid || !understood || busy}
      >
        {busy ? 'Giving…' : 'Give'}
      </button>
      {result ? (
        <p
          className={`treasury__message treasury__message--${result.kind}`}
          role={result.kind === 'error' ? 'alert' : 'status'}
        >
          {result.text}
        </p>
      ) : null}
    </form>
  );
}

function SeasonSlip({ view }: { view: TreasuryView }) {
  const { season, entry } = view.standing;
  const rules = view.rules;
  return (
    <div className="treasury__slip panel-iron">
      <h2 className="caps treasury__shelf-title">The guild roll</h2>
      {!season ? (
        <p>No season has begun yet. When one does, the guild is ranked here.</p>
      ) : (
        <>
          <p className="treasury__slip-season">
            Season {season.number} · ends {day(season.endsAt)}
          </p>
          {entry ? (
            <>
              <p className="treasury__slip-rank">
                {entry.rank ? `Place ${entry.rank}` : 'Not on the roll yet'} ·{' '}
                {formatNumber(entry.value)} points
              </p>
              <dl className="treasury__parts">
                <dt>Guild boss</dt>
                <dd>{formatNumber(entry.parts.boss)}</dd>
                <dt>Members&rsquo; PvE Progress</dt>
                <dd>{formatNumber(entry.parts.pve)}</dd>
                <dt>Town works</dt>
                <dd>{formatNumber(entry.parts.community)}</dd>
                <dt>Counted members</dt>
                <dd>{entry.members}</dd>
              </dl>
              {!entry.rank ? (
                <p className="treasury__fine">
                  A guild needs {rules.minMembers} counted members to be on the roll.
                </p>
              ) : null}
            </>
          ) : (
            <p>The guild has no points this season yet.</p>
          )}
          <p className="treasury__fine">
            You count from {day(view.me.countsFrom)} ({rules.countAfterDays} days after joining).
            {view.me.honourBy
              ? new Date(view.me.joinedAt) <= new Date(view.me.honourBy)
                ? ' You can share this season’s honours if you fight the guild boss or give to the town works.'
                : ` Honours need ${rules.honourAfterDays} days in the guild by the season’s end: not this season.`
              : ''}
          </p>
        </>
      )}
      <a className="treasury__link" href={boardHref('guilds')}>
        See the whole guild roll
      </a>
      {view.honours.length > 0 ? (
        <>
          <h3 className="caps treasury__shelf-title">Honours</h3>
          <ul className="treasury__honours">
            {view.honours.map((h) => (
              <li key={h.season} className={`treasury__honour treasury__honour--${h.tier}`}>
                Season {h.season}: {findGuildHonourTier(h.tier)?.name ?? h.tier} (place {h.rank})
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
