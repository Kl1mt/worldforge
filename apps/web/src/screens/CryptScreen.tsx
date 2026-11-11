import { appearancePalette } from '../content/appearance';
import { useHeroPalette } from '../cosmetics/store';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getClass,
  getDungeon,
  getDungeonTier,
  getEnemy,
  getWorldFlag,
  type DungeonDefinition,
  type DungeonId,
  type DungeonRunProgress,
  type DungeonTier,
  type EnemyId,
  type UnlockBlocker,
} from '@worldforge/game-core';
import { useActiveCharacter, useCharacters } from '../characters/CharactersProvider';
import { classAttackSheet, classPortrait, enemyAttackSheet, heroicSprite } from '../content/assets';
import { BossModifierNotice } from '../components/BossModifierNotice';
import { DUNGEON_WORDS } from '../content/dungeons';
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
  cryptLog,
  describeDungeonFailure,
  dungeonApi,
  type DungeonResult,
  type DungeonState,
  type DungeonTierEntry,
} from '../game/dungeon';
import { summaryItemView } from '../game/items';
import { materialCounts } from '../game/materials';
import { formatDuration, formatNumber } from '../lib/format';
import { PHONE_QUERY, pixelScale, sceneSpriteScale } from '../lib/pixel';
import { describeFiltered } from '../game/lootFilter';
import { routeHref } from '../lib/route';
import { SceneActor } from '../scene/SceneActor';
import { useSceneAnimation, useSceneMotion } from '../scene/useSceneAnimation';
import { Trail } from '../shell/Trail';
import './area.css';
import './crypt.css';

/** How often a running crypt is settled (the server reveals the fixed run as time passes). */
export const CRYPT_POLL_MS = 2_000;

const BACKDROP_SIZE = { width: 384, height: 216 };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

type Load =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: DungeonState };

function blockerText(b: UnlockBlocker): string {
  switch (b.kind) {
    case 'level':
      return `Reach level ${b.required}`;
    case 'cryptTier':
      return `Clear Tier ${ROMAN[b.tier - 1]}`;
    case 'worldFlag':
      return getWorldFlag(b.flag).lockedText;
    default:
      return 'Defeat the Gravewarden';
  }
}

/** Ticket 6.3: a tier as players read it: "Tier II", or "Heroic". */
function tierName(dungeonId: DungeonId, tier: DungeonTier): string {
  const def = getDungeonTier(dungeonId, tier);
  return def.heroic ? def.name : `Tier ${ROMAN[tier - 1]}`;
}

/** The enrage window of a tier in seconds, e.g. "30 and 70". */
function enrageWindow(dungeonId: DungeonId, tier: DungeonTier): string {
  const { min, max } = getDungeonTier(dungeonId, tier).bossEnrage.atMs;
  return `${Math.round(min / 1000)} and ${Math.round(max / 1000)}`;
}

/**
 * Ticket 3.6: the crypt's depths. One button per tier (a radiogroup like the Forge's slot choice);
 * a locked tier says what opens it, an open one what it is for.
 */
function TierChoice({
  tiers,
  selected,
  onSelect,
}: {
  tiers: DungeonTierEntry[];
  selected: DungeonTier;
  onSelect: (tier: DungeonTier) => void;
}) {
  return (
    <div className="crypt-tiers" role="radiogroup" aria-label="Depth">
      {tiers.map((t) => (
        <button
          key={t.tier}
          type="button"
          role="radio"
          aria-checked={t.tier === selected}
          className={`btn crypt-tier${t.unlocked ? '' : ' crypt-tier--locked'}${t.heroic ? ' crypt-tier--heroic' : ''}`}
          onClick={() => onSelect(t.tier)}
        >
          <span className="crypt-tier__name display">{t.name}</span>
          <span className="crypt-tier__levels">
            Lv {t.minLevel}–{t.maxLevel}
            {t.unlocked ? '' : ' · barred'}
          </span>
          <span className="crypt-tier__focus">
            {t.unlocked ? (t.lootFocus?.name ?? '') : t.blockers.map(blockerText).join(' · ')}
          </span>
        </button>
      ))}
    </div>
  );
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

/** The stage: backdrop, hero on the left, the foe of the moment (or the warden, waiting). */
function CryptScene({
  dungeon,
  progress,
  heroic = false,
}: {
  dungeon: DungeonDefinition;
  progress: DungeonRunProgress | null;
  /** Ticket 6.3: the Heroic crypt, drawn from the same art with the Heroic treatment. */
  heroic?: boolean;
}) {
  const plainBackdrop = findAsset(dungeon.assetId);
  const BACKDROP = plainBackdrop && heroic ? heroicSprite(plainBackdrop) : plainBackdrop;
  const words = DUNGEON_WORDS[dungeon.id];
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
  const shownId: EnemyId | null = progress ? (foe?.enemyId ?? null) : dungeon.bossId;
  const shown = shownId ? getEnemy(shownId) : null;
  const plainSprite = shown ? findAsset(shown.assetId) : null;
  const sprite = plainSprite && heroic ? heroicSprite(plainSprite) : plainSprite;
  // A.14b: attack frames when this foe has them (the crypt's bosses don't: code animation).
  const plainSheet = shown && sprite ? enemyAttackSheet(shown.assetId) : null;
  const foeSheet = plainSheet && heroic ? heroicSprite(plainSheet) : plainSheet;
  const isBoss = shown?.rank === 'boss';
  // The 128 px warden at the hero's pixel scale: it towers over the 64 px hero, as it should.
  const foeScale = spriteScale;
  const fighting = progress !== null && !progress.finished;
  // A.14: the same cosmetic loop as the areas, against the one foe in the room.
  const { inventory } = useGame();
  const motion = useSceneMotion();
  const sheet = classAttackSheet(hero.classId);
  // Ticket 6.8: the hero's appearance (a palette swap of its frames, own colours if none).
  const palette = appearancePalette(useHeroPalette(hero.id), hero.classId);
  const { heroRef, foeRef } = useSceneAnimation({
    active: fighting && foe !== null,
    motion,
    foes: 1,
    attackSpeed: inventory.kind === 'ready' ? inventory.value.stats.attackSpeed : null,
    framed: sheet !== null,
    framedFoes: [foeSheet !== null],
  });

  return (
    <div className={`scene crypt-scene${phone ? '' : ' scene--wide'}`} ref={ref}>
      <figure
        className={`scene__stage${progress ? '' : ' crypt-scene--waiting'}${progress?.enraged ? ' crypt-scene--enraged' : ''}${heroic ? ' crypt-scene--heroic' : ''}`}
        style={{ width: stageWidth || undefined, height: size.height * scale }}
        aria-label={
          foe
            ? `${hero.name} fights ${getEnemy(foe.enemyId).name}`
            : progress
              ? `${hero.name} in ${dungeon.name}`
              : words.waiting
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
        <div
          className={`scene__ground${motion === 'full' ? ' scene-anim' : ''}`}
          style={{ ['--px' as string]: `${spriteScale}px` }}
        >
          <div className="scene__hero">
            {progress ? (
              <SceneActor role="hero" framed={sheet !== null} actorRef={heroRef}>
                <PixelSprite
                  sprite={sheet ?? classPortrait(hero.classId)}
                  fallback={classPortrait(hero.classId)}
                  palette={palette}
                  scale={spriteScale}
                  alt={`${hero.name}, ${getClass(hero.classId).name.toLowerCase()}`}
                />
              </SceneActor>
            ) : null}
          </div>
          {shown ? (
            <div className={`crypt-foe${isBoss ? ' crypt-foe--boss' : ''}`}>
              <SceneActor role="foe" framed={foeSheet !== null} actorRef={foeRef(0)}>
                {sprite ? (
                  <PixelSprite
                    sprite={foeSheet ?? sprite}
                    fallback={sprite}
                    scale={foeScale}
                    alt={shown.name}
                    mirror={(foeSheet ?? sprite).facing === 'right'}
                  />
                ) : (
                  <span className="foe-missing">{shown.name}</span>
                )}
              </SceneActor>
            </div>
          ) : null}
        </div>
        {heroic ? (
          <span className="crypt-scene__heroic caps" aria-hidden="true">
            Heroic
          </span>
        ) : null}
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
              <span className="crypt-hud__time caps">
                {words.inside} {clock(progress.elapsedMs)}
              </span>
            ) : null}
          </figcaption>
        ) : null}
      </figure>
    </div>
  );
}

/** Chamber I … IV, then the warden: carved steps down the side of the screen. */
function Descent({
  dungeon,
  progress,
  bossLevel,
}: {
  dungeon: DungeonDefinition;
  progress: DungeonRunProgress | null;
  bossLevel: number;
}) {
  const steps = [
    ...dungeon.rooms.map((r, i) => ({
      key: `r${i}`,
      label: `Chamber ${ROMAN[i]}`,
      note: `${r.enemies} foes`,
      stage: i as number | 'boss',
    })),
    {
      key: 'boss',
      label: getEnemy(dungeon.bossId).name,
      note: `Lv ${bossLevel}`,
      stage: 'boss' as const,
    },
  ];
  const fell = progress?.finished && progress.outcome === 'failed';
  return (
    <ol className="descent" aria-label={dungeon.rooms.length > 0 ? 'The descent' : 'The climb'}>
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

function CryptLog({ dungeonId, progress }: { dungeonId: DungeonId; progress: DungeonRunProgress }) {
  const { classId } = useActiveCharacter();
  const words = DUNGEON_WORDS[dungeonId];
  const lines = cryptLog(progress.events, progress.totalRooms, classId, dungeonId).reverse();
  return (
    <section className="log panel-ledger crypt-log" aria-labelledby="crypt-log-title">
      <header className="log__head">
        <h2 id="crypt-log-title" className="display">
          {words.logTitle}
        </h2>
        <span className="caps">Newest first</span>
      </header>
      {lines.length === 0 ? (
        <p className="log__empty">{words.logEmpty}</p>
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
  dungeon,
  result,
  onAgain,
  busy,
}: {
  dungeon: DungeonDefinition;
  result: DungeonResult;
  onAgain: () => void;
  busy: boolean;
}) {
  const words = DUNGEON_WORDS[dungeon.id];
  const won = result.outcome === 'cleared';
  const items = result.items.map(summaryItemView);
  const mats = materialCounts(result.materials);
  return (
    <section
      className={`reckoning panel-iron${won ? ' reckoning--won' : ''}`}
      aria-labelledby="reckoning-title"
    >
      <p className="caps">
        {words.reckoning} ·{' '}
        {dungeon.tiers.length > 1 ? `${tierName(dungeon.id, result.tier ?? 1)} · ` : ''}
        {formatDuration(result.durationMs)}
      </p>
      <h2 id="reckoning-title" className="display reckoning__title">
        {won ? words.wonTitle : words.lostTitle}
      </h2>
      <p className="reckoning__line">
        {won
          ? result.bossLoot
            ? words.hoardWon
            : 'It falls, but its hoard is spent. Boss loot returns after the cooldown.'
          : result.totalRooms > 0
            ? `You cleared ${result.roomsCleared} of ${result.totalRooms} chambers. What you took on the way down is yours.`
            : words.bossStands}
      </p>
      {result.firstBossKill && dungeon.id === 'namelessCrypt' ? (
        <p className="reckoning__unlock" role="status">
          The way to the <strong>Sunken Abbey</strong> lies open.
        </p>
      ) : null}
      {result.firstTierClear && (result.tier ?? 1) < dungeon.tiers.length ? (
        <p className="reckoning__unlock" role="status">
          {(() => {
            const next = getDungeonTier(dungeon.id, ((result.tier ?? 1) + 1) as DungeonTier);
            return (
              <>
                {next.heroic ? 'The Heroic crypt opens: ' : 'A deeper stair opens: '}
                <strong>{next.heroic ? next.name : `Tier ${ROMAN[next.tier - 1]}`}</strong>, from
                level {next.unlock.level}.
              </>
            );
          })()}
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
      {result.filtered ? (
        <p className="reckoning__line reckoning__line--dim">
          Your loot filter {describeFiltered(result.filtered)}.
        </p>
      ) : null}
      {result.itemsSalvaged > 0 ? (
        <p className="reckoning__line reckoning__line--dim">
          Your pack was full: {result.itemsSalvaged}{' '}
          {result.itemsSalvaged === 1 ? 'drop found' : 'drops found'} no room and{' '}
          {result.itemsSalvaged === 1 ? 'was' : 'were'} salvaged for{' '}
          {formatNumber(result.goldSalvaged)} gold.
        </p>
      ) : null}
      {(result.itemsOverCapacity ?? 0) > 0 ? (
        <p className="reckoning__line reckoning__line--dim">
          Your pack was full, but {result.itemsOverCapacity} valuable{' '}
          {result.itemsOverCapacity === 1 ? 'drop was' : 'drops were'} kept beyond its capacity.
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
          {words.again}
        </button>
      </div>
    </section>
  );
}

/** The Nameless Crypt (`#/crypt`, ticket 2.5). */
export function CryptScreen() {
  return <DungeonScreen dungeonId="namelessCrypt" />;
}

/** Ticket 4.8: the Warden's Watch in the Ashen Pass (`#/watch`). */
export function WatchScreen() {
  return <DungeonScreen dungeonId="ashenWatch" />;
}

/** Ticket 6.2: the Tyrant's Forge below the Cinder Depths (`#/tyrant`). */
export function TyrantScreen() {
  return <DungeonScreen dungeonId="tyrantsForge" />;
}

/** A dungeon's door, run and reckoning (ticket 2.5; one screen for every dungeon since 4.8). */
function DungeonScreen({ dungeonId }: { dungeonId: DungeonId }) {
  const dungeon = getDungeon(dungeonId);
  const words = DUNGEON_WORDS[dungeonId];
  const hero = useActiveCharacter();
  const { updateCharacter } = useCharacters();
  const game = useGame();
  const reloadGame = game.reload;
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [result, setResult] = useState<DungeonResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The depth chosen at the door (ticket 3.6); null = the deepest open tier. */
  const [chosenTier, setChosenTier] = useState<DungeonTier | null>(null);
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

  const anyRun = state.kind === 'ready' ? state.value.run : null;
  // Ticket 4.8: the hero's open run may be in the other dungeon; this screen shows only its own.
  const run = anyRun && anyRun.dungeonId === dungeonId ? anyRun : null;
  const elsewhere = anyRun && anyRun.dungeonId !== dungeonId ? anyRun : null;
  const running = anyRun !== null && !anyRun.progress.finished;

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

  const enter = async (tier: DungeonTier) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setChosenTier(tier);
    const res = await dungeonApi.enter(hero.id, dungeon.id, tier);
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
      <Trail
        className="crypt__region"
        steps={[
          { label: 'Town', route: 'hub' },
          { label: 'World map', route: 'map' },
          { label: dungeon.name },
        ]}
      />
      <h1 className="display crypt__title">{dungeon.name}</h1>
      <p className="crypt__desc">{dungeon.description}</p>
    </header>
  );

  if (state.kind === 'loading') {
    return (
      <div className="crypt">
        {head}
        <p className="area__wait" role="status">
          {words.loading}
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
  const entry = dungeons.find((d) => d.id === dungeon.id);
  const progress = run?.progress ?? null;
  const tiers = entry?.tiers ?? [];
  const deepestOpen = tiers.filter((t) => t.unlocked).at(-1)?.tier ?? 1;
  const selectedTier: DungeonTier = run?.tier ?? chosenTier ?? deepestOpen;
  const selected = tiers.find((t) => t.tier === selectedTier);
  const selectedDef = getDungeonTier(dungeon.id, selectedTier);

  let panel;
  if (result) {
    panel = (
      <Reckoning
        dungeon={dungeon}
        result={result}
        busy={busy}
        onAgain={() => void enter(result.tier ?? 1)}
      />
    );
  } else if (elsewhere) {
    const other = getDungeon(elsewhere.dungeonId);
    panel = (
      <section className="crypt-door panel-iron" aria-labelledby="crypt-door-title">
        <h2 id="crypt-door-title" className="rule-heading">
          Your hero is in {other.name}
        </h2>
        <p className="crypt-door__line">
          Finish and claim that run before you set out here. One run at a time.
        </p>
        <a className="btn btn--brass" href={routeHref(DUNGEON_WORDS[other.id].route)}>
          Go to {other.name}
        </a>
      </section>
    );
  } else if (run && progress) {
    panel = (
      <section className="crypt-door panel-iron" aria-labelledby="crypt-run-title">
        <h2 id="crypt-run-title" className="rule-heading">
          {progress.finished ? 'The fighting has stopped' : words.runTitle}
          {dungeon.tiers.length > 1 ? ` · ${tierName(dungeon.id, run.tier)}` : ''}
        </h2>
        {run.bossModifier ? (
          <BossModifierNotice
            modifier={run.bossModifier}
            heading="This run’s boss is"
            showFocus={run.bossLootEligible}
            compact
          />
        ) : tiers.find((t) => t.tier === run.tier)?.takesModifier === false ? (
          <p className="crypt-door__line crypt-door__omen">No omen here: no twist this run.</p>
        ) : null}
        {progress.finished ? (
          <>
            <p className="crypt-door__line">
              {progress.outcome === 'cleared' ? words.clearedLine : words.fallenLine}
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
            {words.runNote} Rewards are counted when you claim them at the end.
            {run.bossLootEligible
              ? ` ${words.bossShort}’s hoard is waiting.`
              : ` ${words.bossShort}’s hoard is spent for now: no boss loot this run.`}
          </p>
        )}
      </section>
    );
  } else if (entry && !entry.unlocked) {
    panel = (
      <section className="crypt-door panel-iron" aria-labelledby="crypt-door-title">
        <h2 id="crypt-door-title" className="rule-heading">
          {words.barredTitle}
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
          {words.doorTitle}
        </h2>
        {tiers.length > 1 ? (
          <TierChoice tiers={tiers} selected={selectedTier} onSelect={setChosenTier} />
        ) : null}
        {selected && !selected.takesModifier ? (
          <p className="crypt-door__line crypt-door__omen">
            No omen here: this week’s twist ({state.value.bossModifier.modifier.name.toLowerCase()})
            does not reach {selected.name}. Its warden fights as it always has.
          </p>
        ) : (
          <BossModifierNotice
            modifier={state.value.bossModifier.modifier}
            week={state.value.bossModifier.week}
            heading="This week the boss is"
          />
        )}
        <ul className="crypt-door__facts">
          <li>
            {dungeon.rooms.length > 0 ? (
              <>
                {dungeon.rooms.length} chambers of{' '}
                {dungeon.enemies.map((e) => getEnemy(e.enemyId).name).join(' and ')} (Lv{' '}
                {selectedDef.minLevel}–{selectedDef.maxLevel}), then{' '}
              </>
            ) : (
              `No chambers: ${words.approach}, then `
            )}
            {getEnemy(dungeon.bossId).name.replace(/^The /, 'the ')} (Lv {selectedDef.bossLevel}
            {selectedTier > 1 ? ', stronger than its level' : ''}).
          </li>
          <li>
            {words.bossShort} <strong>enrages</strong> between{' '}
            {enrageWindow(dungeonId, selectedTier)} s into the fight. The faster you kill{' '}
            {dungeon.rooms.length > 0 ? 'it' : 'him'}, the safer.
          </li>
          {words.mechanics ? <li>{words.mechanics}</li> : null}
          {selectedDef.heroic ? (
            <li>
              <strong>Heroic:</strong> the chambers’ foes hit harder and last longer, and every
              fourth blow of the Gravewarden tolls three times as hard. Its spoils come at the item
              levels of the Cinderwastes, with far better odds of Legendaries, Mythics, set pieces
              and Void items.
            </li>
          ) : null}
          {selected?.lootFocus ? (
            <li>
              Loot focus: <em className="crypt-door__focus">{selected.lootFocus.name}</em>.{' '}
              {selected.lootFocus.description}
            </li>
          ) : null}
          <li>{words.leaving}</li>
          <li>{readyAt ? words.hoardBack.replace('{when}', hoardTime(readyAt)) : words.hoard}</li>
        </ul>
        {busyCharacterId ? (
          <p className="area__alert area__alert--line" role="status">
            {words.otherHero}
          </p>
        ) : selected && !selected.unlocked ? (
          <p className="crypt-door__line" role="status">
            {selected.name} is barred: {selected.blockers.map(blockerText).join(', ')}.
          </p>
        ) : (
          <button
            type="button"
            className="btn btn--brass"
            onClick={() => void enter(selectedTier)}
            disabled={busy}
            aria-busy={busy}
          >
            {busy
              ? words.entering
              : selectedTier === 1
                ? words.enter
                : selectedDef.heroic
                  ? 'Enter the Heroic crypt'
                  : `Descend to ${selectedDef.name}`}
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
        <CryptScene
          dungeon={dungeon}
          progress={result ? null : progress}
          heroic={selectedDef.heroic === true}
        />
        <aside className="crypt__side">
          <Descent
            dungeon={dungeon}
            progress={result ? null : progress}
            bossLevel={selectedDef.bossLevel}
          />
          {panel}
        </aside>
        {progress && !result ? <CryptLog dungeonId={dungeonId} progress={progress} /> : null}
      </div>
    </div>
  );
}
