import { useId, useState } from 'react';
import {
  CLASSES,
  DEFAULT_PROFESSION_CONFIG,
  DUNGEON_TIERS,
  MATERIALS,
  MAX_LEVEL,
  PROFESSIONS,
  STORY_QUESTS,
  findContractTemplate,
  getArea,
  getEnemy,
  isAreaId,
  objectiveTarget,
  type EnemyId,
  type QuestObjective,
  type WorldProgress,
} from '@worldforge/game-core';
import {
  toolsApi,
  type AccountFile,
  type CurrencyMode,
  type DailyLimit,
  type HeroFile,
} from '../admin/tools-api';
import {
  goldAfter,
  materialName,
  materialsAfter,
  nf,
  parseWhole,
  unlockSummary,
  type CheatAccess,
} from '../admin/tools-view';
import { formatWhen } from '../social/api';
import { answered, boardsNote, SmallField, Tool, useWrit, type WritSpec } from './AdminToolKit';

/**
 * Ticket D.4: the tool bench for one hero. Support tools (refund, remove, rename, delete) work on
 * any account; testing tools (grants, XP, level, progress, professions, daily resets, quests,
 * fast-forward) only on test accounts and the admin's own. Every tool opens the action writ.
 */

export interface HeroCtx {
  account: AccountFile;
  hero: HeroFile;
  cheat: CheatAccess;
}

export const className = (id: string) => CLASSES.find((c) => c.id === id)?.name ?? id;
export const areaName = (id: string) => (isAreaId(id) ? getArea(id).name : id);

const ownWarning = (cheat: CheatAccess) =>
  cheat === 'own'
    ? 'This is your own account, not a test account: the change shows on public boards.'
    : undefined;

function testing(ctx: HeroCtx, spec: Omit<WritSpec, 'caps' | 'warning'>): WritSpec {
  return { ...spec, caps: `Testing · ${ctx.hero.name}`, warning: ownWarning(ctx.cheat) };
}

// ---- Gold and materials --------------------------------------------------------------------

const MODES: { id: CurrencyMode; label: string; hint: string }[] = [
  { id: 'grant', label: 'Grant', hint: 'Testing: new gold from nowhere.' },
  { id: 'refund', label: 'Refund', hint: 'Support: give back what a player lost.' },
  { id: 'remove', label: 'Remove', hint: 'Support: take away (typed confirmation).' },
];

function ModePicker({
  mode,
  setMode,
  cheat,
}: {
  mode: CurrencyMode;
  setMode: (m: CurrencyMode) => void;
  cheat: CheatAccess;
}) {
  return (
    <div className="adt-modes" role="group" aria-label="Mode">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className="btn btn--small"
          aria-pressed={mode === m.id}
          disabled={m.id === 'grant' && cheat === 'blocked'}
          title={m.hint}
          onClick={() => setMode(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

const modeNote = (mode: CurrencyMode, cheat: CheatAccess) =>
  MODES.find((m) => m.id === mode)!.hint +
  (mode === 'grant' && cheat === 'blocked' ? ' Test accounts and your own account only.' : '');

export function GoldTool(ctx: HeroCtx) {
  const { account, hero, cheat } = ctx;
  const ids = useId();
  const openWrit = useWrit();
  const [mode, setMode] = useState<CurrencyMode>(cheat === 'blocked' ? 'refund' : 'grant');
  const [amount, setAmount] = useState('');
  const n = parseWhole(amount);
  const after = n === null ? null : goldAfter(mode, hero.gold, n);
  const verb = mode === 'remove' ? 'Remove' : mode === 'refund' ? 'Refund' : 'Grant';
  const review = () => {
    if (n === null || after === null) return;
    const base = {
      title: `${verb} ${nf(n)} gold`,
      changes: [
        `${hero.name}’s gold: ${nf(hero.gold)} → ${nf(after)}.`,
        mode === 'remove'
          ? 'Gold held after a trade can’t be removed; the server refuses if it would dip into it.'
          : mode === 'refund'
            ? 'Counted as a support refund in the economy report.'
            : 'Counted as an admin grant in the economy report.',
      ],
      action: `${verb} gold`,
      busy: 'Sending…',
      run: (key: string, reason: string, confirm: string) =>
        answered(
          toolsApi.gold(account.handle, hero.id, key, {
            mode,
            amount: n,
            reason,
            ...(mode === 'remove' ? { confirm } : {}),
          }),
          (a) => `${hero.name}’s gold: ${nf(a.gold.before)} → ${nf(a.gold.after)}.${boardsNote(a)}`,
        ),
    };
    openWrit(
      mode === 'grant'
        ? testing(ctx, base)
        : {
            ...base,
            caps: `Support · ${hero.name}`,
            ...(mode === 'remove'
              ? { destructive: true, confirm: { expected: hero.name, what: 'the hero’s name' } }
              : {}),
          },
    );
  };
  return (
    <Tool title="Gold" kind="support" cheat={cheat} onSubmit={review}>
      <ModePicker mode={mode} setMode={setMode} cheat={cheat} />
      <p className="adt-dim">{modeNote(mode, cheat)}</p>
      <SmallField
        label="Amount"
        htmlFor={`${ids}-amount`}
        invalid={amount !== '' && after === null}
        hint={
          after !== null
            ? `${nf(hero.gold)} → ${nf(after)}`
            : n !== null && mode === 'remove'
              ? `The hero has only ${nf(hero.gold)}.`
              : `Now ${nf(hero.gold)}`
        }
      >
        <input
          id={`${ids}-amount`}
          className="field__input"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </SmallField>
      <div className="adt-tool__row">
        <button
          type="submit"
          className="btn btn--small"
          disabled={after === null || (mode === 'grant' && cheat === 'blocked')}
        >
          Review…
        </button>
      </div>
    </Tool>
  );
}

export function MaterialsTool(ctx: HeroCtx) {
  const { account, hero, cheat } = ctx;
  const ids = useId();
  const openWrit = useWrit();
  const [mode, setMode] = useState<CurrencyMode>(cheat === 'blocked' ? 'refund' : 'grant');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const change: Record<string, number> = {};
  let bad = false;
  for (const [id, text] of Object.entries(counts)) {
    if (text.trim() === '') continue;
    const n = parseWhole(text);
    if (n === null || n < 1) bad = true;
    else change[id] = n;
  }
  const after = bad ? null : materialsAfter(mode, hero.materials, change);
  const empty = Object.keys(change).length === 0;
  const verb = mode === 'remove' ? 'Remove' : mode === 'refund' ? 'Refund' : 'Grant';
  const review = () => {
    if (!after || empty) return;
    const lines = Object.entries(change).map(
      ([id]) => `${materialName(id)}: ${nf(hero.materials[id] ?? 0)} → ${nf(after[id] ?? 0)}`,
    );
    const base = {
      title: `${verb} materials`,
      changes: [
        ...lines,
        mode === 'remove'
          ? 'Materials held after a trade can’t be removed.'
          : `Counted as ${mode === 'refund' ? 'a support refund' : 'an admin grant'}.`,
      ],
      action: `${verb} materials`,
      busy: 'Sending…',
      run: (key: string, reason: string, confirm: string) =>
        answered(
          toolsApi.materials(account.handle, hero.id, key, {
            mode,
            materials: change,
            reason,
            ...(mode === 'remove' ? { confirm } : {}),
          }),
          (a) => `${hero.name}’s materials were updated.${boardsNote(a)}`,
        ),
    };
    openWrit(
      mode === 'grant'
        ? testing(ctx, base)
        : {
            ...base,
            caps: `Support · ${hero.name}`,
            ...(mode === 'remove'
              ? { destructive: true, confirm: { expected: hero.name, what: 'the hero’s name' } }
              : {}),
          },
    );
  };
  return (
    <Tool title="Materials" kind="support" cheat={cheat} onSubmit={review}>
      <ModePicker mode={mode} setMode={setMode} cheat={cheat} />
      <p className="adt-dim">{modeNote(mode, cheat)}</p>
      <div className="adt-matgrid">
        {MATERIALS.map((m) => {
          const have = hero.materials[m.id] ?? 0;
          const next = after?.[m.id];
          return (
            <SmallField
              key={m.id}
              label={m.name}
              htmlFor={`${ids}-${m.id}`}
              hint={
                change[m.id] && next !== undefined ? `${nf(have)} → ${nf(next)}` : `Has ${nf(have)}`
              }
            >
              <input
                id={`${ids}-${m.id}`}
                className="field__input"
                inputMode="numeric"
                value={counts[m.id] ?? ''}
                onChange={(e) => setCounts({ ...counts, [m.id]: e.target.value })}
              />
            </SmallField>
          );
        })}
      </div>
      {after === null ? (
        <p className="field__error">
          {bad ? 'Whole numbers only.' : 'The hero doesn’t have that many.'}
        </p>
      ) : null}
      <div className="adt-tool__row">
        <button
          type="submit"
          className="btn btn--small"
          disabled={after === null || empty || (mode === 'grant' && cheat === 'blocked')}
        >
          Review…
        </button>
      </div>
    </Tool>
  );
}

// ---- XP and level --------------------------------------------------------------------------

export function XpLevelTool(ctx: HeroCtx) {
  const { account, hero, cheat } = ctx;
  const ids = useId();
  const openWrit = useWrit();
  const [xp, setXp] = useState('');
  const [level, setLevel] = useState(String(hero.level));
  const xpN = parseWhole(xp);
  const levelN = parseWhole(level);
  const levelOk = levelN !== null && levelN >= 1 && levelN <= MAX_LEVEL;
  const grantXp = () => {
    if (xpN === null || xpN < 1) return;
    openWrit(
      testing(ctx, {
        title: `Grant ${nf(xpN)} XP`,
        changes: [
          `${hero.name} gains ${nf(xpN)} experience (now level ${hero.level}, ${nf(hero.experience)} XP).`,
          'Level-ups happen as in play, up to the level cap.',
        ],
        action: 'Grant XP',
        busy: 'Granting…',
        run: (key, reason) =>
          answered(
            toolsApi.xp(account.handle, hero.id, key, { xp: xpN, reason }),
            (a) =>
              `Level ${a.before.level} → ${a.after.level}, ${nf(a.after.experience)} XP.${boardsNote(a)}`,
          ),
      }),
    );
  };
  const setLvl = () => {
    if (!levelOk || levelN === null) return;
    openWrit(
      testing(ctx, {
        title: `Set level ${levelN}`,
        changes: [
          `${hero.name}: level ${hero.level} → ${levelN}, experience into the level reset to 0.`,
        ],
        action: 'Set the level',
        busy: 'Setting…',
        run: (key, reason) =>
          answered(
            toolsApi.level(account.handle, hero.id, key, { level: levelN, reason }),
            (a) => `Level ${a.before.level} → ${a.after.level}.${boardsNote(a)}`,
          ),
      }),
    );
  };
  return (
    <Tool title="Experience & level" kind="testing" cheat={cheat} onSubmit={grantXp}>
      <SmallField label="XP to grant" htmlFor={`${ids}-xp`} hint={`Now ${nf(hero.experience)} XP`}>
        <input
          id={`${ids}-xp`}
          className="field__input"
          inputMode="numeric"
          value={xp}
          onChange={(e) => setXp(e.target.value)}
        />
      </SmallField>
      <div className="adt-tool__row">
        <button type="submit" className="btn btn--small" disabled={xpN === null || xpN < 1}>
          Grant XP…
        </button>
      </div>
      <SmallField
        label="Set level"
        htmlFor={`${ids}-lvl`}
        invalid={!levelOk}
        hint={`1–${MAX_LEVEL}, now ${hero.level}`}
      >
        <input
          id={`${ids}-lvl`}
          className="field__input"
          inputMode="numeric"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          aria-invalid={!levelOk}
        />
      </SmallField>
      <div className="adt-tool__row">
        <button
          type="button"
          className="btn btn--small"
          disabled={!levelOk || levelN === hero.level}
          onClick={setLvl}
        >
          Set level…
        </button>
      </div>
    </Tool>
  );
}

// ---- Progress and professions --------------------------------------------------------------

const TIER_NAMES = ['none', 'I', 'II', 'III', 'IV (Heroic)'];

function opens(level: number, progress: WorldProgress): string[] {
  return unlockSummary(level, progress)
    .filter((p) => p.missing.length === 0)
    .map((p) => (p.flags.length > 0 ? `${p.name} (also ${p.flags.join(', ')})` : p.name));
}

export function ProgressTool(ctx: HeroCtx) {
  const { account, hero, cheat } = ctx;
  const ids = useId();
  const openWrit = useWrit();
  const [grave, setGrave] = useState(hero.progress.gravewardenDefeated);
  const [tier, setTier] = useState(hero.progress.cryptTierCleared ?? 0);
  const [ashen, setAshen] = useState(hero.progress.ashenWardenDefeated ?? false);
  const [tyrant, setTyrant] = useState(hero.progress.forgeTyrantDefeated ?? false);
  // Ticket 8.2: the Hollow Sovereign (opens nothing; PvE Progress and a title colour read it).
  const [sovereign, setSovereign] = useState(hero.progress.hollowSovereignDefeated ?? false);
  const next: WorldProgress = {
    gravewardenDefeated: grave,
    cryptTierCleared: tier,
    ashenWardenDefeated: ashen,
    forgeTyrantDefeated: tyrant,
    hollowSovereignDefeated: sovereign,
  };
  const before = opens(hero.level, hero.progress);
  const after = opens(hero.level, next);
  const gained = after.filter((p) => !before.includes(p));
  const lost = before.filter((p) => !after.includes(p));
  const same =
    grave === hero.progress.gravewardenDefeated &&
    tier === (hero.progress.cryptTierCleared ?? 0) &&
    ashen === (hero.progress.ashenWardenDefeated ?? false) &&
    tyrant === (hero.progress.forgeTyrantDefeated ?? false) &&
    sovereign === (hero.progress.hollowSovereignDefeated ?? false);
  const yes = (b: boolean) => (b ? 'yes' : 'no');
  const review = () =>
    openWrit(
      testing(ctx, {
        title: 'Set world progress',
        changes: [
          `Gravewarden defeated: ${yes(hero.progress.gravewardenDefeated)} → ${yes(grave)}`,
          `Crypt tier cleared: ${TIER_NAMES[hero.progress.cryptTierCleared ?? 0]} → ${TIER_NAMES[tier]}`,
          `Ashen Warden defeated: ${yes(hero.progress.ashenWardenDefeated ?? false)} → ${yes(ashen)}`,
          `Forge Tyrant defeated: ${yes(hero.progress.forgeTyrantDefeated ?? false)} → ${yes(tyrant)}`,
          `Hollow Sovereign defeated: ${yes(hero.progress.hollowSovereignDefeated ?? false)} → ${yes(sovereign)}`,
          gained.length > 0 ? `Opens: ${gained.join('; ')}.` : 'Opens nothing new at this level.',
          ...(lost.length > 0 ? [`Closes: ${lost.join('; ')}.`] : []),
        ],
        action: 'Set progress',
        busy: 'Setting…',
        run: (key, reason) =>
          answered(
            toolsApi.progress(account.handle, hero.id, key, {
              gravewardenDefeated: grave,
              cryptTierCleared: tier,
              ashenWardenDefeated: ashen,
              forgeTyrantDefeated: tyrant,
              hollowSovereignDefeated: sovereign,
              reason,
            }),
            (a) => `World progress set.${boardsNote(a)}`,
          ),
      }),
    );
  return (
    <Tool title="World progress" kind="testing" cheat={cheat} onSubmit={review}>
      <label className="adt-check">
        <input type="checkbox" checked={grave} onChange={(e) => setGrave(e.target.checked)} />
        Gravewarden defeated
      </label>
      <SmallField label="Crypt tier cleared" htmlFor={`${ids}-tier`}>
        <select
          id={`${ids}-tier`}
          className="field__input"
          value={tier}
          onChange={(e) => setTier(Number(e.target.value))}
        >
          {[0, ...DUNGEON_TIERS].map((t) => (
            <option key={t} value={t}>
              {t === 0 ? 'None' : `Tier ${TIER_NAMES[t]}`}
            </option>
          ))}
        </select>
      </SmallField>
      <label className="adt-check">
        <input type="checkbox" checked={ashen} onChange={(e) => setAshen(e.target.checked)} />
        Ashen Warden defeated
      </label>
      <label className="adt-check">
        <input type="checkbox" checked={tyrant} onChange={(e) => setTyrant(e.target.checked)} />
        Forge Tyrant defeated
      </label>
      <label className="adt-check">
        <input
          type="checkbox"
          checked={sovereign}
          onChange={(e) => setSovereign(e.target.checked)}
        />
        Hollow Sovereign defeated
      </label>
      <p className="adt-dim">
        At level {hero.level} this opens: {after.length > 0 ? after.join('; ') : 'nothing'}.
        {gained.length > 0 ? ` New: ${gained.join('; ')}.` : ''}
        {lost.length > 0 ? ` Closes: ${lost.join('; ')}.` : ''} World flags are shown as named
        conditions; see the World tab for which are set.
      </p>
      <div className="adt-tool__row">
        <button type="submit" className="btn btn--small" disabled={same}>
          Review…
        </button>
      </div>
    </Tool>
  );
}

const PROF_MAX = DEFAULT_PROFESSION_CONFIG.maxLevel;

export function ProfessionsTool(ctx: HeroCtx) {
  const { account, hero, cheat } = ctx;
  const ids = useId();
  const openWrit = useWrit();
  const current = (id: string) => hero.professions.find((p) => p.professionId === id)?.level ?? 1;
  const [levels, setLevels] = useState<Record<string, string>>(() =>
    Object.fromEntries(PROFESSIONS.map((p) => [p.id, String(current(p.id))])),
  );
  const change: Record<string, number> = {};
  let bad = false;
  for (const p of PROFESSIONS) {
    const n = parseWhole(levels[p.id] ?? '');
    if (n === null || n < 1 || n > PROF_MAX) bad = true;
    else if (n !== current(p.id)) change[p.id] = n;
  }
  const empty = Object.keys(change).length === 0;
  const review = () =>
    openWrit(
      testing(ctx, {
        title: 'Set profession levels',
        changes: Object.entries(change).map(
          ([id, n]) =>
            `${PROFESSIONS.find((p) => p.id === id)?.name ?? id}: level ${current(id)} → ${n}`,
        ),
        action: 'Set professions',
        busy: 'Setting…',
        run: (key, reason) =>
          answered(
            toolsApi.professions(account.handle, hero.id, key, { professions: change, reason }),
            (a) => `Professions set.${boardsNote(a)}`,
          ),
      }),
    );
  return (
    <Tool title="Professions" kind="testing" cheat={cheat} onSubmit={review}>
      <div className="adt-matgrid">
        {PROFESSIONS.map((p) => (
          <SmallField
            key={p.id}
            label={p.name}
            htmlFor={`${ids}-${p.id}`}
            hint={`Now ${current(p.id)} (1–${PROF_MAX})`}
          >
            <input
              id={`${ids}-${p.id}`}
              className="field__input"
              inputMode="numeric"
              value={levels[p.id] ?? ''}
              onChange={(e) => setLevels({ ...levels, [p.id]: e.target.value })}
            />
          </SmallField>
        ))}
      </div>
      {bad ? <p className="field__error">Levels from 1 to {PROF_MAX}.</p> : null}
      <div className="adt-tool__row">
        <button type="submit" className="btn btn--small" disabled={bad || empty}>
          Review…
        </button>
      </div>
    </Tool>
  );
}

// ---- Daily counters, quests, fast-forward --------------------------------------------------

export function DailyResetTool(ctx: HeroCtx) {
  const { account, hero, cheat } = ctx;
  const openWrit = useWrit();
  const [picked, setPicked] = useState<DailyLimit[]>([]);
  const d = hero.daily;
  const rows: { id: DailyLimit; label: string; now: string }[] = [
    { id: 'ratedDuels', label: 'Rated duels', now: `${d.ratedDuels} fought today` },
    {
      id: 'contracts',
      label: 'Contracts',
      now: `${d.contracts} of ${d.contractsPerDay} taken today`,
    },
    { id: 'merchant', label: 'Merchant', now: `${d.merchantBought} bought today` },
  ];
  const toggle = (id: DailyLimit, on: boolean) =>
    setPicked(on ? [...picked, id] : picked.filter((x) => x !== id));
  const review = () =>
    openWrit(
      testing(ctx, {
        title: 'Reset daily limits',
        changes: rows
          .filter((r) => picked.includes(r.id))
          .map((r) => `${r.label}: ${r.now} → back to none used.`),
        action: 'Reset',
        busy: 'Resetting…',
        run: (key, reason) =>
          answered(
            toolsApi.dailyReset(account.handle, hero.id, key, { limits: picked, reason }),
            (a) => `Daily limits reset.${boardsNote(a)}`,
          ),
      }),
    );
  return (
    <Tool title="Daily limits" kind="testing" cheat={cheat} onSubmit={review}>
      {rows.map((r) => (
        <label key={r.id} className="adt-check">
          <input
            type="checkbox"
            checked={picked.includes(r.id)}
            onChange={(e) => toggle(r.id, e.target.checked)}
          />
          {r.label} <span className="adt-dim">({r.now})</span>
        </label>
      ))}
      <div className="adt-tool__row">
        <button type="submit" className="btn btn--small" disabled={picked.length === 0}>
          Review…
        </button>
      </div>
    </Tool>
  );
}

function isObjective(o: unknown): o is QuestObjective {
  return typeof o === 'object' && o !== null && typeof (o as { kind?: unknown }).kind === 'string';
}

function enemyName(id: string): string {
  try {
    return getEnemy(id as EnemyId).name;
  } catch {
    return id;
  }
}

export function questName(q: HeroFile['quests'][number]): string {
  if (q.kind === 'story') return STORY_QUESTS.find((s) => s.id === q.questId)?.name ?? q.questId;
  const t = findContractTemplate(q.questId);
  if (!t) return `Contract ${q.questId}`;
  const o = t.objective;
  if (o.kind === 'kill') return `Contract: slay ${o.count} ${enemyName(o.enemyId)}`;
  if (o.kind === 'gather') return `Contract: gather ${o.count} ${materialName(o.materialId)}`;
  return `Contract ${q.questId}`;
}

function questProgress(q: HeroFile['quests'][number]): string {
  const parts = q.objectives.map((o, i) =>
    isObjective(o) ? `${q.progress[i] ?? 0}/${objectiveTarget(o)}` : `${q.progress[i] ?? 0}`,
  );
  return parts.length > 0 ? parts.join(' · ') : '–';
}

export function QuestsTool(ctx: HeroCtx) {
  const { account, hero, cheat } = ctx;
  const openWrit = useWrit();
  const act = (q: HeroFile['quests'][number], action: 'complete' | 'reset') =>
    openWrit(
      testing(ctx, {
        title: `${action === 'complete' ? 'Complete' : 'Reset'} “${questName(q)}”`,
        changes:
          action === 'complete'
            ? ['All objectives are filled in; the hero still turns it in at the Tavern as in play.']
            : [
                'The quest row is removed: the hero can take it again (a story quest from its giver, a contract only while today’s board still offers it).',
              ],
        action: action === 'complete' ? 'Complete the quest' : 'Reset the quest',
        busy: 'Sending…',
        run: (key, reason) =>
          answered(
            toolsApi.quest(account.handle, hero.id, q.id, action, key, { reason }),
            (a) => `Quest ${action === 'complete' ? 'completed' : 'reset'}.${boardsNote(a)}`,
          ),
      }),
    );
  const blocked = cheat === 'blocked';
  return (
    <section className="adt-tool adt-tool--testing adt-tool--wide" aria-label="Quests">
      <p className="caps adt-tool__kind">Testing</p>
      <h4 className="adt-tool__title">Quests</h4>
      {hero.quests.length === 0 ? <p className="adt-none">No quests taken.</p> : null}
      {hero.quests.length > 0 ? (
        <ul className="adt-rows">
          {hero.quests.map((q) => (
            <li key={q.id} className="adt-row">
              <span>
                <strong>{questName(q)}</strong>{' '}
                <span className="adt-dim">
                  · {q.kind === 'story' ? 'story' : `contract ${q.contractDay ?? ''}`} ·{' '}
                  {q.status === 'active' ? 'active' : 'turned in'} · {questProgress(q)}
                </span>
              </span>
              <span className="adt-row__act">
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={blocked || q.status !== 'active'}
                  onClick={() => act(q, 'complete')}
                >
                  Complete…
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={blocked}
                  onClick={() => act(q, 'reset')}
                >
                  Reset…
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {blocked ? (
        <p className="adt-tool__blocked">Test accounts and your own account only.</p>
      ) : null}
    </section>
  );
}

export function FastForwardTool(ctx: HeroCtx) {
  const { account, hero, cheat } = ctx;
  const ids = useId();
  const openWrit = useWrit();
  const [minutes, setMinutes] = useState('30');
  const n = parseWhole(minutes);
  const ok = n !== null && n >= 1 && n <= 180;
  const review = () => {
    if (!ok || n === null || !hero.activity) return;
    openWrit(
      testing(ctx, {
        title: `Fast-forward ${n} min`,
        changes: [
          `${hero.name} is credited ${n} minutes of farming in ${areaName(hero.activity.areaId)}.`,
          'Through the normal settlement: kills, XP, gold, drops, deaths and the offline cap as in play.',
        ],
        action: 'Fast-forward',
        busy: 'Settling…',
        run: (key, reason) =>
          answered(
            toolsApi.fastForward(account.handle, hero.id, key, { minutes: n, reason }),
            (a) =>
              `Credited ${Math.round(a.creditedMs / 60_000)} min: level ${a.before.level} → ${a.after.level}, gold ${nf(a.before.gold)} → ${nf(a.after.gold)}.${boardsNote(a)}`,
          ),
      }),
    );
  };
  return (
    <Tool
      title="Fast-forward farming"
      kind="testing"
      cheat={cheat}
      onSubmit={review}
      lede={
        hero.activity
          ? `Farming ${areaName(hero.activity.areaId)}, last settled ${formatWhen(hero.activity.settledAt)}.`
          : 'Not farming: start an activity first.'
      }
    >
      <SmallField label="Minutes" htmlFor={`${ids}-min`} invalid={!ok} hint="1–180">
        <input
          id={`${ids}-min`}
          className="field__input"
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          aria-invalid={!ok}
        />
      </SmallField>
      <div className="adt-tool__row">
        <button type="submit" className="btn btn--small" disabled={!ok || !hero.activity}>
          Review…
        </button>
      </div>
    </Tool>
  );
}

// ---- Rename, delete, restore ---------------------------------------------------------------

export function RenameTool(ctx: HeroCtx) {
  const { account, hero, cheat } = ctx;
  const ids = useId();
  const openWrit = useWrit();
  const [name, setName] = useState('');
  const t = name.trim();
  const ok = t.length >= 1 && t.length <= 32 && t !== hero.name;
  const review = () =>
    openWrit({
      caps: `Moderation · ${hero.name}`,
      title: `Rename ${hero.name}`,
      changes: [
        `${hero.name} → ${t}.`,
        'The new name shows everywhere at once: boards, guild roll, profile.',
        'Refused if another hero has the name.',
      ],
      action: 'Rename',
      busy: 'Renaming…',
      run: (key, reason) =>
        answered(
          toolsApi.renameHero(account.handle, hero.id, key, { name: t, reason }),
          (a) => `${a.renamed.from} is now ${a.renamed.to}.`,
        ),
    });
  return (
    <Tool title="Rename (moderation)" kind="support" cheat={cheat} onSubmit={review}>
      <SmallField label="New name" htmlFor={`${ids}-name`}>
        <input
          id={`${ids}-name`}
          className="field__input"
          value={name}
          maxLength={32}
          onChange={(e) => setName(e.target.value)}
        />
      </SmallField>
      <div className="adt-tool__row">
        <button type="submit" className="btn btn--small" disabled={!ok}>
          Review…
        </button>
      </div>
    </Tool>
  );
}

/** The delete writ: everything that happens, then the typed hero name. */
export function deleteWrit(ctx: HeroCtx, otherHeroes: number): WritSpec {
  const { account, hero } = ctx;
  return {
    caps: `Support · ${hero.name}`,
    title: `Delete ${hero.name}`,
    destructive: true,
    warning:
      otherHeroes === 0
        ? 'This is the account’s only hero. If shelf items are waiting with no other hero to hand them to, the server refuses.'
        : undefined,
    changes: [
      `${hero.name} is hidden from the player and every board, and frozen: nothing can change it.`,
      'Its activity ends (the last fight is settled first).',
      'Its open trade offers are voided; anything in escrow goes back to its owner.',
      'Items it placed on the account shelf are handed to another hero of the account (refused if there is none).',
      'Its arena defence is withdrawn and its leaderboard rows are removed.',
      'Guild membership is untouched: guilds belong to the account, not the hero.',
      'It can be restored for 14 days. After that, only the server CLI purge (deploy/admin.sh purge) removes it for good.',
    ],
    confirm: { expected: hero.name, what: 'the hero’s name' },
    action: 'Delete the hero',
    busy: 'Deleting…',
    run: (key, reason, confirm) =>
      answered(
        toolsApi.deleteHero(account.handle, hero.id, key, { confirm, reason }),
        (a) =>
          `${a.deleted.name} is deleted (restorable until ${formatWhen(a.deleted.restoreUntil)}). ${a.deleted.offersVoided} offers voided, ${a.deleted.shelfItemsRehomed} shelf items handed on, ${a.deleted.leaderboardRowsRemoved} board rows removed${a.deleted.defence ? ', arena defence withdrawn' : ''}.`,
      ),
  };
}

export function restoreWrit(account: AccountFile, hero: HeroFile): WritSpec {
  return {
    caps: `Support · ${hero.name}`,
    title: `Restore ${hero.name}`,
    changes: [
      `${hero.name} comes back to the account’s hero list and the boards.`,
      'Its arena defence and showcase come back if they can.',
      'Not undone: voided offers, shelf items already handed to another hero, and the ended activity.',
      'Refused if every hero slot is taken.',
    ],
    action: 'Restore the hero',
    busy: 'Restoring…',
    run: (key, reason) =>
      answered(toolsApi.restoreHero(account.handle, hero.id, key, { reason }), (a) => {
        const r = a.restored;
        return `${r.name} is back.${r.defenceRestored ? ' Arena defence restored.' : ''}${r.notRestored.activityAreaId ? ` Its activity in ${areaName(r.notRestored.activityAreaId)} was not restarted.` : ''}`;
      }),
  };
}
