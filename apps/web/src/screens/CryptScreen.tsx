import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getClass,
  getDungeon,
  getEnemy,
  type DungeonRunProgress,
  type EnemyId,
  type UnlockBlocker,
} from '@worldforge/game-core';
import { useActiveCharacter, useCharacters } from '../characters/CharactersProvider';
import { classPortrait } from '../content/assets';
import { findAsset } from '../content/world';
import { ItemFrame } from '../components/ItemFrame';
import { LabeledMeter } from '../components/Meter';
import { MaterialStack } from '../components/MaterialStack';
import { PixelSprite } from '../components/PixelSprite';
import { useElementWidth } from '../components/useElementWidth';
import { useMediaQuery } from '../components/useMediaQuery';
import { useGame } from '../game/GameProvider';
import {
  claimKey,
  cryptLogLine,
  describeDungeonFailure,
  dungeonApi,
  type DungeonResult,
  type DungeonState,
} from '../game/dungeon';
import { summaryItemView } from '../game/items';
import { materialCounts } from '../game/materials';
import { formatDuration, formatNumber } from '../lib/format';
import { PHONE_QUERY, pixelScale, sceneSpriteScale } from '../lib/pixel';
import { routeHref } from '../lib/route';
import './area.css';
import './crypt.css';

/** How often a running crypt is settled (the server reveals the fixed run as time passes). */
export const CRYPT_POLL_MS = 2_000;

const CRYPT = getDungeon('namelessCrypt');
const BACKDROP = findAsset(CRYPT.assetId);
const BACKDROP_SIZE = { width: 384, height: 216 };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

type Load =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: DungeonState };

function blockerText(b: UnlockBlocker): string {
  return b.kind === 'level' ? `Reach level ${b.required}` : 'Defeat the Gravewarden';
}

const hoardFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** When boss loot is back, e.g. `Thu 08:15` (local time). */
function hoardTime(iso: string): string {
  return `on ${hoardFormat.format(new Date(iso))}`;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The crypt stage: backdrop, hero on the left, the foe of the moment (or the warden, waiting). */
function CryptScene({ progress }: { progress: DungeonRunProgress | null }) {
  const hero = useActiveCharacter();
  const phone = useMediaQuery(PHONE_QUERY);
  const [ref, width] = useElementWidth<HTMLDivElement>(768);
  const size = BACKDROP ?? BACKDROP_SIZE;
  const scale = pixelScale(width, size.width, { step: 2, min: 2, max: 4 });
  const spriteScale = sceneSpriteScale(scale, phone);
  const stageWidth = Math.min(Math.floor(width), size.width * scale);
  const left = Math.round((stageWidth - size.width * scale) / 2);

  const foe = progress?.foe ?? null;
  // Idle: the warden waits at the far end of the crypt. Between fights: the next room is empty.
  const shownId: EnemyId | null = progress ? (foe?.enemyId ?? null) : CRYPT.bossId;
  const shown = shownId ? getEnemy(shownId) : null;
  const sprite = shown ? findAsset(shown.assetId) : null;
  const isBoss = shown?.rank === 'boss';
  // The 128 px warden at the hero's pixel scale: it towers over the 64 px hero, as it should.
  const foeScale = spriteScale;
  const fighting = progress !== null && !progress.finished;

  return (
    <div className={`scene crypt-scene${phone ? '' : ' scene--wide'}`} ref={ref}>
      <figure
        className={`scene__stage${progress ? '' : ' crypt-scene--waiting'}${progress?.enraged ? ' crypt-scene--enraged' : ''}`}
        style={{ width: stageWidth || undefined, height: size.height * scale }}
        aria-label={
          foe
            ? `${hero.name} fights ${getEnemy(foe.enemyId).name}`
            : progress
              ? `${hero.name} in the Nameless Crypt`
              : 'The Nameless Crypt. The Gravewarden waits in the dark.'
        }
      >
        {BACKDROP ? (
          <PixelSprite
            sprite={BACKDROP}
            scale={scale}
            alt=""
            className="scene__backdrop"
            style={{ left }}
          />
        ) : (
          <span className="scene__backdrop scene__backdrop--missing" aria-hidden="true" />
        )}
        <div className="scene__ground" style={{ ['--px' as string]: `${spriteScale}px` }}>
          <div className="scene__hero">
            {progress ? (
              <PixelSprite
                sprite={classPortrait(hero.classId)}
                scale={spriteScale}
                alt={`${hero.name}, ${getClass(hero.classId).name.toLowerCase()}`}
              />
            ) : null}
          </div>
          {shown ? (
            <div className={`crypt-foe${isBoss ? ' crypt-foe--boss' : ''}`}>
              {sprite ? (
                <PixelSprite
                  sprite={sprite}
                  scale={foeScale}
                  alt={shown.name}
                  mirror={sprite.facing === 'right'}
                />
              ) : (
                <span className="foe-missing">{shown.name}</span>
              )}
            </div>
          ) : null}
        </div>
        {progress ? (
          <figcaption className="scene__hud crypt-hud">
            <span className="scene__hud-name">{hero.name}</span>
            <LabeledMeter
              current={progress.health}
              max={progress.maxHealth}
              label="Health"
              value={`${formatNumber(progress.health)} / ${formatNumber(progress.maxHealth)}`}
            />
            {foe ? (
              <LabeledMeter
                current={foe.health}
                max={foe.maxHealth}
                label={getEnemy(foe.enemyId).name}
                value={`${formatNumber(foe.health)} / ${formatNumber(foe.maxHealth)}`}
                variant="rage"
                className="crypt-hud__foe"
              />
            ) : null}
            {progress.enraged && foe ? (
              <span className="crypt-hud__enraged caps" role="status">
                Enraged
              </span>
            ) : null}
            {fighting ? (
              <span className="crypt-hud__time caps">In the crypt {clock(progress.elapsedMs)}</span>
            ) : null}
          </figcaption>
        ) : null}
      </figure>
    </div>
  );
}

/** Chamber I … IV, then the warden: carved steps down the side of the screen. */
function Descent({ progress }: { progress: DungeonRunProgress | null }) {
  const steps = [
    ...CRYPT.rooms.map((r, i) => ({
      key: `r${i}`,
      label: `Chamber ${ROMAN[i]}`,
      note: `${r.enemies} foes`,
      stage: i as number | 'boss',
    })),
    {
      key: 'boss',
      label: 'The Gravewarden',
      note: `Lv ${CRYPT.bossLevel}`,
      stage: 'boss' as const,
    },
  ];
  const fell = progress?.finished && progress.outcome === 'failed';
  return (
    <ol className="descent" aria-label="The descent">
      {steps.map((s, i) => {
        let state: 'done' | 'here' | 'ahead' | 'fell' = 'ahead';
        if (progress) {
          const bossDone = progress.outcome === 'cleared';
          if (s.stage === 'boss') {
            if (bossDone) state = 'done';
            else if (progress.stage === 'boss') state = 'here';
          } else if (i < progress.roomsCleared) state = 'done';
          else if (progress.stage === s.stage) state = 'here';
          if (fell && state === 'here') state = 'fell';
          if (fell && progress.stage === 'done' && i === progress.roomsCleared) state = 'fell';
        }
        return (
          <li key={s.key} className={`descent__step descent__step--${state}`}>
            <span className="descent__mark" aria-hidden="true" />
            <span className="descent__label">{s.label}</span>
            <span className="descent__note">
              {state === 'done'
                ? 'Cleared'
                : state === 'here'
                  ? 'Here'
                  : state === 'fell'
                    ? 'Fallen here'
                    : s.note}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CryptLog({ progress }: { progress: DungeonRunProgress }) {
  const lines = progress.events
    .map((e) => cryptLogLine(e, progress.totalRooms))
    .filter((l) => l !== null)
    .reverse();
  return (
    <section className="log panel-ledger crypt-log" aria-labelledby="crypt-log-title">
      <header className="log__head">
        <h2 id="crypt-log-title" className="display">
          Echoes from below
        </h2>
        <span className="caps">Newest first</span>
      </header>
      {lines.length === 0 ? (
        <p className="log__empty">Torchlight on wet stone. The stair goes down.</p>
      ) : (
        <ol className="log__list" aria-live="polite" aria-relevant="additions">
          {lines.map((l, i) => (
            <li key={`${l.t}-${i}`} className={`log__row crypt-log__${l.tone}`}>
              <span className="log__time">{clock(l.t)}</span>
              <span>{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Reckoning({
  result,
  onAgain,
  busy,
}: {
  result: DungeonResult;
  onAgain: () => void;
  busy: boolean;
}) {
  const won = result.outcome === 'cleared';
  const items = result.items.map(summaryItemView);
  const mats = materialCounts(result.materials);
  return (
    <section
      className={`reckoning panel-iron${won ? ' reckoning--won' : ''}`}
      aria-labelledby="reckoning-title"
    >
      <p className="caps">The crypt’s reckoning · {formatDuration(result.durationMs)}</p>
      <h2 id="reckoning-title" className="display reckoning__title">
        {won ? 'The Gravewarden falls' : 'The crypt keeps its warden'}
      </h2>
      <p className="reckoning__line">
        {won
          ? result.bossLoot
            ? 'Its seal is yours, and its hoard with it.'
            : 'It falls, but its hoard is spent. Boss loot returns after the cooldown.'
          : `You cleared ${result.roomsCleared} of ${result.totalRooms} chambers. What you took on the way down is yours.`}
      </p>
      {result.firstBossKill ? (
        <p className="reckoning__unlock" role="status">
          The way to the <strong>Sunken Abbey</strong> lies open.
        </p>
      ) : null}
      <dl className="reckoning__tally">
        <div>
          <dt className="caps">Foes slain</dt>
          <dd>{formatNumber(result.kills)}</dd>
        </div>
        <div>
          <dt className="caps">Experience</dt>
          <dd>
            +{formatNumber(result.xpGained)}
            {result.levelsGained > 0 ? ` · +${result.levelsGained} lv` : ''}
          </dd>
        </div>
        <div>
          <dt className="caps">Gold</dt>
          <dd>+{formatNumber(result.goldGained)}</dd>
        </div>
      </dl>
      {items.length > 0 || mats.length > 0 ? (
        <ul className="reckoning__spoils" aria-label="Spoils">
          {mats.map((m) => (
            <li key={m.material.id}>
              <MaterialStack material={m.material} quantity={m.quantity} sign="+" />
            </li>
          ))}
          {items.map((it) => (
            <li key={it.id}>
              <ItemFrame item={it} context="Found" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="reckoning__line reckoning__line--dim">No items this time.</p>
      )}
      {result.itemsSalvaged > 0 ? (
        <p className="reckoning__line reckoning__line--dim">
          Your pack was full: {result.itemsSalvaged} item(s) salvaged for{' '}
          {formatNumber(result.goldSalvaged)} gold.
        </p>
      ) : null}
      <div className="reckoning__actions">
        <a className="btn" href={routeHref('map')}>
          Back to the map
        </a>
        <a className="btn" href={routeHref('inventory')}>
          Open the pack
        </a>
        <button type="button" className="btn btn--brass" onClick={onAgain} disabled={busy}>
          Descend again
        </button>
      </div>
    </section>
  );
}

export function CryptScreen() {
  const hero = useActiveCharacter();
  const { updateCharacter } = useCharacters();
  const game = useGame();
  const reloadGame = game.reload;
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [result, setResult] = useState<DungeonResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const res = await dungeonApi.state(hero.id);
    if (!alive.current) return;
    setState(
      res.ok
        ? { kind: 'ready', value: res.value }
        : { kind: 'error', message: describeDungeonFailure(res.error) },
    );
  }, [hero.id]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const run = state.kind === 'ready' ? state.value.run : null;
  const running = run !== null && !run.progress.finished;

  // Settle while the run is under way: the server reveals what has happened so far.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void dungeonApi.settle(hero.id).then((res) => {
        if (!alive.current) return;
        if (res.ok) {
          setState((s) =>
            s.kind === 'ready' ? { kind: 'ready', value: { ...s.value, run: res.value.run } } : s,
          );
        } else if (res.error.code === 'no_dungeon_run') void load();
      });
    }, CRYPT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, hero.id, load]);

  const enter = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await dungeonApi.enter(hero.id, CRYPT.id);
    setBusy(false);
    if (!res.ok) {
      setError(describeDungeonFailure(res.error));
      void load();
      return;
    }
    updateCharacter(res.value.character);
    // Farming was settled and stopped by the server.
    reloadGame();
    setState((s) =>
      s.kind === 'ready'
        ? {
            kind: 'ready',
            value: { ...s.value, run: res.value.run, character: res.value.character },
          }
        : s,
    );
  };

  const claim = async () => {
    if (!run) return;
    setBusy(true);
    setError(null);
    const res = await dungeonApi.claim(hero.id, claimKey(run.id));
    setBusy(false);
    if (!res.ok) {
      setError(describeDungeonFailure(res.error));
      void load();
      return;
    }
    updateCharacter(res.value.character);
    reloadGame();
    setResult(res.value.result);
    void load();
  };

  const head = (
    <header className="crypt__head">
      <p className="caps crypt__region">
        Graumark ·{' '}
        <a className="area__maplink" href={routeHref('map')}>
          World Map
        </a>
      </p>
      <h1 className="display crypt__title">{CRYPT.name}</h1>
      <p className="crypt__desc">{CRYPT.description}</p>
    </header>
  );

  if (state.kind === 'loading') {
    return (
      <div className="crypt">
        {head}
        <p className="area__wait" role="status">
          Lighting a torch at the crypt door…
        </p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="crypt">
        {head}
        <div className="area__alert" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const { dungeons, busyCharacterId } = state.value;
  const entry = dungeons.find((d) => d.id === CRYPT.id);
  const progress = run?.progress ?? null;

  let panel;
  if (result) {
    panel = <Reckoning result={result} busy={busy} onAgain={() => void enter()} />;
  } else if (run && progress) {
    panel = (
      <section className="crypt-door panel-iron" aria-labelledby="crypt-run-title">
        <h2 id="crypt-run-title" className="rule-heading">
          {progress.finished ? 'The fighting has stopped' : 'Delving'}
        </h2>
        {progress.finished ? (
          <>
            <p className="crypt-door__line">
              {progress.outcome === 'cleared'
                ? 'Silence below. The warden’s chamber stands open.'
                : 'Your hero has fallen back to the stair. Take what you carried out.'}
            </p>
            <button
              type="button"
              className="btn btn--brass"
              onClick={() => void claim()}
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? 'Counting the spoils…' : 'Claim the spoils'}
            </button>
          </>
        ) : (
          <p className="crypt-door__line">
            The fight below plays out on its own. Rewards are counted when you claim them at the
            end.
            {run.bossLootEligible
              ? ' The warden’s hoard is waiting.'
              : ' The warden’s hoard is spent for now: no boss loot this run.'}
          </p>
        )}
      </section>
    );
  } else if (entry && !entry.unlocked) {
    panel = (
      <section className="crypt-door panel-iron" aria-labelledby="crypt-door-title">
        <h2 id="crypt-door-title" className="rule-heading">
          The door is barred
        </h2>
        <ul className="ledger__why" aria-label="Needed to enter">
          {entry.blockers.map((b) => (
            <li key={b.kind}>{blockerText(b)}</li>
          ))}
        </ul>
        <a className="btn" href={routeHref('map')}>
          Back to the map
        </a>
      </section>
    );
  } else {
    const readyAt = entry?.bossLootReadyAt ?? null;
    panel = (
      <section className="crypt-door panel-iron" aria-labelledby="crypt-door-title">
        <h2 id="crypt-door-title" className="rule-heading">
          Before you descend
        </h2>
        <ul className="crypt-door__facts">
          <li>
            {CRYPT.rooms.length} chambers of{' '}
            {CRYPT.enemies.map((e) => getEnemy(e.enemyId).name).join(' and ')}, then the Gravewarden
            (Lv {CRYPT.bossLevel}).
          </li>
          <li>
            The warden <strong>enrages</strong> after {Math.round(CRYPT.bossEnrage.atMs / 1000)} s.
            Kill it before then.
          </li>
          <li>
            Your hero leaves the fields while in the crypt. A fall keeps what you took on the way
            down.
          </li>
          <li>
            {readyAt
              ? `The warden’s hoard returns ${hoardTime(readyAt)}. You can still fight it.`
              : 'The warden’s hoard: a Gravewarden Seal and two items of its own.'}
          </li>
        </ul>
        {busyCharacterId ? (
          <p className="area__alert area__alert--line" role="status">
            Another of your heroes is in the crypt. Switch to them to finish that run.
          </p>
        ) : (
          <button
            type="button"
            className="btn btn--brass"
            onClick={() => void enter()}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? 'Descending…' : 'Descend into the crypt'}
          </button>
        )}
      </section>
    );
  }

  return (
    <div className="crypt">
      {head}
      {error ? (
        <p className="area__alert area__alert--line" role="alert">
          {error}
        </p>
      ) : null}
      <div className="crypt__grid">
        <CryptScene progress={result ? null : progress} />
        <aside className="crypt__side">
          <Descent progress={result ? null : progress} />
          {panel}
        </aside>
        {progress && !result ? <CryptLog progress={progress} /> : null}
      </div>
    </div>
  );
}
