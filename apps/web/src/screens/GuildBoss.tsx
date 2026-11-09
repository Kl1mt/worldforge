import { useId, useRef, useState } from 'react';
import type { MaterialId } from '@worldforge/game-core';
import { useCharacters } from '../characters/CharactersProvider';
import { MaterialStack } from '../components/MaterialStack';
import { PixelSprite } from '../components/PixelSprite';
import { SceneActor } from '../scene/SceneActor';
import { useSceneMotion } from '../scene/useSceneAnimation';
import { findSprite } from '../content/assets';
import { ActionKeys } from '../game/economy';
import { materialView } from '../game/materials';
import { formatNumber } from '../lib/format';
import {
  describeGuildBossFailure,
  guildBossApi,
  trackProgress,
  untilText,
  useGuildBoss,
  type GuildBossAttempt,
  type GuildBossReward,
  type GuildBossState,
} from '../social/guildBoss';
import { Gold } from './economy/ShopHeader';
import './guild-boss.css';

/**
 * The weekly guild boss (ticket 4.9) in the Guild Hall: a siege plate. The boss stands in a dark
 * niche beside its name and the week's turn; the guild's damage climbs a chain of stage seals;
 * the player sends a hero for one of the week's attempts and reads the blow-by-blow; the
 * guild-only damage board is a ledger; earned spoils wait on a slip until claimed to a hero.
 * Everything comes from the server: the client never computes a fight or a reward.
 */
type Notice = { kind: 'ok' | 'error'; text: string } | null;

const weekLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

export function GuildBoss() {
  const { state, reload, show } = useGuildBoss();
  if (state.kind === 'loading') {
    return (
      <section className="siege panel-iron" aria-busy="true" aria-label="Weekly guild boss">
        <p className="siege__empty">Reading the siege board…</p>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section className="siege panel-iron" aria-label="Weekly guild boss">
        <p className="siege__empty" role="alert">
          {describeGuildBossFailure(state.error)}{' '}
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </p>
      </section>
    );
  }
  return <Siege view={state.view} stale={state.stale} reload={reload} show={show} />;
}

/** Spoils earned with a guild the player has left (shown in the hall without a guild). */
export function GuildBossSpoilsOnly() {
  const { state, reload } = useGuildBoss(0);
  if (state.kind !== 'ready' || state.view.me.rewards.length === 0) return null;
  return (
    <section className="siege siege--spoils-only panel-iron" aria-label="Guild boss spoils">
      <Spoils rewards={state.view.me.rewards} reload={reload} />
    </section>
  );
}

function Siege({
  view,
  stale,
  reload,
  show,
}: {
  view: GuildBossState;
  stale: boolean;
  reload: () => void;
  show: (v: GuildBossState) => void;
}) {
  const sprite = findSprite(view.boss.assetId);
  const motion = useSceneMotion();
  const [last, setLast] = useState<GuildBossAttempt | null>(null);
  const guild = view.guild;
  const nowMs = Date.parse(view.now);
  return (
    <section className="siege panel-iron" aria-labelledby="siege-title">
      <header className="siege__head">
        <div className="siege__niche">
          {sprite ? (
            // A.14: the boss breathes in its niche (idle only; the fight itself is a report).
            <span
              className={motion === 'full' ? 'scene-anim' : undefined}
              style={{ ['--px' as string]: '1px' }}
            >
              <SceneActor role="foe">
                <PixelSprite sprite={sprite} scale={1} alt={view.boss.name} />
              </SceneActor>
            </span>
          ) : (
            <span className="siege__missing">{view.boss.name}</span>
          )}
        </div>
        <div className="siege__intro">
          <p className="caps siege__where">
            Weekly guild boss · week of {weekLabel(view.week.startsAt)}
          </p>
          <h2 id="siege-title" className="display siege__title">
            {view.boss.name}
          </h2>
          <p className="siege__text">{view.boss.description}</p>
          <p className="siege__fine">
            It rises again on Monday at 00:00 UTC, in {untilText(view.week.endsAt, nowMs)}.
            {stale ? ' Could not refresh; showing the last board.' : ''}
          </p>
        </div>
      </header>
      {guild ? <StageTrack view={view} /> : null}
      <div className="siege__body">
        <div className="siege__left">
          <FightPlate view={view} reload={reload} show={show} onFought={setLast} />
          {last ? <Blow attempt={last} view={view} /> : null}
        </div>
        {guild ? <Board view={view} /> : null}
      </div>
      {view.me.pendingStages.length > 0 ? (
        <p className="siege__strip siege__strip--brass" role="status">
          Your guild broke {view.me.pendingStages.map((s) => stageName(view, s)).join(', ')} while
          you were sworn in. Fight once this week to earn its spoils.
        </p>
      ) : null}
      {view.me.rewards.length > 0 ? <Spoils rewards={view.me.rewards} reload={reload} /> : null}
    </section>
  );
}

const stageName = (view: GuildBossState, stage: number) =>
  view.boss.stages.find((s) => s.stage === stage)?.name ?? `stage ${stage}`;

function StageTrack({ view }: { view: GuildBossState }) {
  const guild = view.guild!;
  const thresholds = view.boss.stages.map((s) => s.threshold);
  const pct = Math.round(trackProgress(guild.total, thresholds) * 1000) / 10;
  const next = view.boss.stages.find((s) => s.stage === guild.stage + 1);
  return (
    <div className="siege__track">
      <p className="siege__tally">
        <span className="display siege__total">{formatNumber(guild.total)}</span> damage from{' '}
        {formatNumber(guild.attempts)} {guild.attempts === 1 ? 'attempt' : 'attempts'} ·{' '}
        {guild.stage === 0
          ? 'no stage broken yet'
          : `${guild.stage} of ${view.boss.stages.length} stages broken`}
        {next
          ? ` · ${formatNumber(next.threshold - guild.total)} to ${next.name}`
          : ' · laid to rest'}
      </p>
      <div
        className="siege-chain"
        role="meter"
        aria-label="Guild damage this week"
        aria-valuemin={0}
        aria-valuemax={view.boss.stages.at(-1)!.threshold}
        aria-valuenow={guild.total}
        aria-valuetext={`${formatNumber(guild.total)} damage, ${guild.stage} of ${view.boss.stages.length} stages`}
      >
        <span className="siege-chain__fill" style={{ width: `${pct}%` }} />
      </div>
      <ol className="siege-seals">
        {view.boss.stages.map((s) => {
          const broken = guild.stage >= s.stage;
          return (
            <li
              key={s.stage}
              className={`siege-seals__seal${broken ? ' siege-seals__seal--broken' : ''}`}
            >
              <span className="siege-seals__mark" aria-hidden="true" />
              <span className="siege-seals__name">{s.name}</span>
              <span className="siege-seals__need">{formatNumber(s.threshold)}</span>
              <span className="siege-seals__reward">
                <Gold amount={s.reward.gold} />
              </span>
              <span className="visually-hidden">{broken ? 'Broken' : 'Standing'}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FightPlate({
  view,
  reload,
  show,
  onFought,
}: {
  view: GuildBossState;
  reload: () => void;
  show: (v: GuildBossState) => void;
  onFought: (a: GuildBossAttempt) => void;
}) {
  const id = useId();
  const roster = useCharacters();
  const heroes = roster.state.kind === 'ready' ? roster.state.roster.characters : [];
  const ready = heroes.filter((h) => h.level >= view.boss.minLevel);
  const [heroId, setHeroId] = useState(() =>
    roster.active && roster.active.level >= view.boss.minLevel
      ? roster.active.id
      : (ready[0]?.id ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const keys = useRef(new ActionKeys());
  const hero = ready.find((h) => h.id === heroId) ?? ready[0];
  const left = view.me.attemptsLeft;
  const inGuild = view.guild !== null;

  const fight = async () => {
    if (!hero) return;
    const action = `attempt:${view.week.key}:${view.me.attemptsUsed + 1}`;
    setBusy(true);
    setNotice(null);
    const res = await guildBossApi.attempt(hero.id, keys.current.keyFor(action));
    keys.current.settle(action, res.ok ? null : res.error);
    setBusy(false);
    if (res.ok) {
      show(res.value.state);
      onFought(res.value.attempt);
    } else {
      setNotice({ kind: 'error', text: describeGuildBossFailure(res.error) });
      reload();
    }
  };

  return (
    <div className="siege__fight">
      <h3 className="rule-heading">Your attempts</h3>
      <p
        className="siege-pips"
        aria-label={`${left} of ${view.attemptsPerWeek} attempts left this week`}
      >
        {Array.from({ length: view.attemptsPerWeek }, (_, i) => (
          <span
            key={i}
            className={`siege-pips__pip${i < view.me.attemptsUsed ? ' siege-pips__pip--spent' : ''}`}
            aria-hidden="true"
          />
        ))}
        <span className="siege-pips__text" aria-hidden="true">
          {left} of {view.attemptsPerWeek} left this week
        </span>
      </p>
      {view.me.attempts.length > 0 ? (
        <ul className="siege__mine">
          {view.me.attempts.map((a) => (
            <li key={a.attemptNo}>
              {a.heroName ?? 'A hero'}: {formatNumber(a.counted)}
              {a.counted < a.damage ? ` (of ${formatNumber(a.damage)})` : ''}
              {a.forThisGuild ? '' : ' · for another guild'}
            </li>
          ))}
        </ul>
      ) : null}
      {!inGuild ? (
        <p className="siege__empty">Only a guild can face it. Swear yourself to one first.</p>
      ) : left === 0 ? (
        <p className="siege__empty">
          Your attempts are spent. They come back on Monday, in whatever guild you are.
        </p>
      ) : ready.length === 0 ? (
        <p className="siege__empty">
          No hero of yours is ready: the boss takes heroes from level {view.boss.minLevel}.
        </p>
      ) : (
        <div className="siege__send">
          <div className="field">
            <label className="field__label caps" htmlFor={`${id}-hero`}>
              Send
            </label>
            <div className="field__well">
              <select
                id={`${id}-hero`}
                className="field__input"
                value={hero?.id ?? ''}
                onChange={(e) => setHeroId(e.target.value)}
              >
                {ready.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} — level {h.level}
                  </option>
                ))}
              </select>
            </div>
            <p className="field__hint">
              One minute against a foe two levels above the hero. It does not stop farming. At most{' '}
              {formatNumber(view.boss.attemptDamageCap)} of an attempt counts for the guild.
            </p>
          </div>
          <button type="button" className="btn btn--brass" disabled={busy} onClick={fight}>
            {busy ? 'Fighting…' : 'Face the boss'}
          </button>
        </div>
      )}
      {notice ? (
        <p
          className={`siege__strip siege__strip--${notice.kind === 'error' ? 'crimson' : 'moss'}`}
          role="alert"
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

/** The last attempt, blow by blow (from the server's log). */
function Blow({ attempt, view }: { attempt: GuildBossAttempt; view: GuildBossState }) {
  const crits = attempt.events.filter((e) => e.type === 'attack' && e.crit).length;
  const hits = attempt.events.filter((e) => e.type === 'attack').length;
  const raged = attempt.events.some((e) => e.type === 'enrage');
  return (
    <div className="siege-blow" role="status">
      <p className="caps siege-blow__where">
        Attempt {attempt.attemptNo} · {attempt.heroName}, level {attempt.level}
      </p>
      <p className="siege-blow__line">
        <span className="display siege-blow__damage">{formatNumber(attempt.counted)}</span> damage
        for the guild
        {attempt.counted < attempt.damage
          ? ` (of ${formatNumber(attempt.damage)} dealt: one attempt counts at most ${formatNumber(view.boss.attemptDamageCap)})`
          : ''}
        .
      </p>
      <ul className="siege-blow__facts">
        <li>
          {hits} blows, {crits} critical
        </li>
        <li>{raged ? `It raged at ${seconds(attempt.enrageAtMs)}` : 'It never raged'}</li>
        <li>
          {attempt.end === 'fell'
            ? `${attempt.heroName} fell after ${seconds(attempt.durationMs)}`
            : `${attempt.heroName} held the full ${seconds(attempt.durationMs)}`}
        </li>
      </ul>
      {attempt.newStages.length > 0 ? (
        <p className="siege-blow__stage">
          {attempt.newStages.map((s) => stageName(view, s)).join(' and ')}! The guild broke a stage
          {attempt.earnedStages.length ? '; its spoils wait for you below.' : '.'}
        </p>
      ) : attempt.earnedStages.length > 0 ? (
        <p className="siege-blow__stage">
          You earned the spoils of {attempt.earnedStages.map((s) => stageName(view, s)).join(', ')}.
        </p>
      ) : null}
    </div>
  );
}

function Board({ view }: { view: GuildBossState }) {
  const rows = view.guild!.board;
  return (
    <div className="siege__board panel-ledger">
      <h3 className="rule-heading">Damage this week</h3>
      {rows.length === 0 ? (
        <p className="siege__empty">No one has faced it this week. Be the first.</p>
      ) : (
        <ol className="siege-board">
          {rows.map((r) => (
            <li
              key={`${r.rank}`}
              className={`siege-board__row${r.you ? ' siege-board__row--you' : ''}`}
            >
              <span className="siege-board__rank">{r.rank}</span>
              <span className="siege-board__name">
                {r.you
                  ? 'You'
                  : r.former
                    ? 'A former member'
                    : r.blocked
                      ? 'A blocked player'
                      : (r.player?.displayName ?? 'A player whose name is hidden')}
              </span>
              <span className="siege-board__damage">{formatNumber(r.damage)}</span>
              <span className="siege-board__tries" aria-label={`${r.attempts} attempts`}>
                {'◆'.repeat(r.attempts)}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="siege__fine">Only your guild sees this board.</p>
    </div>
  );
}

function Spoils({ rewards, reload }: { rewards: GuildBossReward[]; reload: () => void }) {
  const id = useId();
  const roster = useCharacters();
  const heroes = roster.state.kind === 'ready' ? roster.state.roster.characters : [];
  const [heroId, setHeroId] = useState(() => roster.active?.id ?? heroes[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const keys = useRef(new ActionKeys());
  const hero = heroes.find((h) => h.id === heroId) ?? heroes[0];
  const gold = rewards.reduce((s, r) => s + r.gold, 0);
  const materials: Partial<Record<MaterialId, number>> = {};
  for (const r of rewards)
    for (const [m, n] of Object.entries(r.materials) as [MaterialId, number][])
      materials[m] = (materials[m] ?? 0) + n;

  const claim = async () => {
    if (!hero) return;
    const action = `claim:${rewards.map((r) => `${r.week}:${r.stage}`).join(',')}`;
    setBusy(true);
    setNotice(null);
    const res = await guildBossApi.claim(hero.id, keys.current.keyFor(action));
    keys.current.settle(action, res.ok ? null : res.error);
    setBusy(false);
    if (res.ok) {
      roster.updateCharacter(res.value.character);
      setNotice({ kind: 'ok', text: `${hero.name} takes the spoils.` });
    } else {
      setNotice({ kind: 'error', text: describeGuildBossFailure(res.error) });
    }
    reload();
  };

  return (
    <div className="siege-spoils">
      <h3 className="rule-heading">Spoils waiting</h3>
      <ul className="siege-spoils__list">
        {rewards.map((r) => (
          <li key={`${r.week}:${r.stage}`} className="siege-spoils__row">
            <span className="siege-spoils__what">
              {r.stageName} · week of {weekLabel(`${r.week}T00:00:00Z`)}
            </span>
            <span className="siege-spoils__guild">
              with {r.guildName} [{r.guildTag}]
            </span>
          </li>
        ))}
      </ul>
      <div className="siege-spoils__sum">
        <Gold amount={gold} />
        {(Object.entries(materials) as [MaterialId, number][]).map(([m, n]) => (
          <MaterialStack key={m} material={materialView(m)} quantity={n} scale={1} />
        ))}
      </div>
      <div className="siege-spoils__claim">
        <div className="field">
          <label className="field__label caps" htmlFor={`${id}-to`}>
            Claim to
          </label>
          <div className="field__well">
            <select
              id={`${id}-to`}
              className="field__input"
              value={hero?.id ?? ''}
              onChange={(e) => setHeroId(e.target.value)}
            >
              {heroes.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button type="button" className="btn btn--brass" disabled={busy || !hero} onClick={claim}>
          {busy ? 'Claiming…' : 'Claim'}
        </button>
      </div>
      <p className="siege__fine">Spoils stay yours, even if you leave the guild.</p>
      {notice ? (
        <p
          className={`siege__strip siege__strip--${notice.kind === 'error' ? 'crimson' : 'moss'}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
