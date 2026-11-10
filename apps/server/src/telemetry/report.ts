import { and, gte, lte, sql, type SQL } from 'drizzle-orm';
import { RARITY_IDS } from '@worldforge/game-core';
import { queryRows } from '../db/query.js';
import { telemetryDaily, telemetryDailyTest } from '../db/schema.js';

/** Either rollup table (ticket D.4: the two have the same columns). */
type RollupTable = typeof telemetryDaily;
import type { Executor } from '../db/types.js';
import type { TelemetryMetric } from './record.js';

/**
 * The telemetry report (ticket 3.8, docs/TELEMETRY.md): rollups summed over a day window, a
 * snapshot of what is equipped now, and a reconciliation of the rollups with the audit log.
 * Output holds content ids and counts only: no account, character or item ids, names or emails.
 */

export interface TelemetryWindow {
  /** First day, `YYYY-MM-DD` (inclusive); null = from the first recorded day. */
  from: string | null;
  /** Last day (inclusive); null = up to the last recorded day. */
  to: string | null;
}

export interface RollupRow {
  metric: TelemetryMetric;
  dims: [string, string, string];
  events: number;
  amount: number;
}

export interface UsageRow {
  classId: string;
  kind: 'base' | 'effect' | 'set' | 'variant';
  id: string;
  equipped: number;
}

export interface BuildRow {
  classId: string;
  /** The build signature: top affixes, then effects and set bonuses (see docs/TELEMETRY.md). */
  signature: string;
  characters: number;
}

export interface ReconcileCheck {
  check: string;
  audit: number;
  rollup: number;
  ok: boolean;
}

export interface TelemetryReport {
  window: {
    from: string | null;
    to: string | null;
    firstDay: string | null;
    lastDay: string | null;
    days: number;
  };
  rollups: RollupRow[];
  snapshot: { equippedCharacters: number; usage: UsageRow[]; builds: BuildRow[] };
  reconcile?: ReconcileCheck[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDay(value: string, name: string): string {
  if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name} must be a date like 2026-11-06, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Rollups summed over the window, plus the window's recorded first and last day. */
export async function loadRollups(
  db: Executor,
  window: TelemetryWindow,
  /**
   * Ticket D.4: `players` (the balance report: test accounts left out) or `all` (the
   * reconciliation: both tables, so admin tools on test accounts still balance).
   */
  cohort: 'players' | 'all' = 'players',
): Promise<{ rows: RollupRow[]; firstDay: string | null; lastDay: string | null; days: number }> {
  if (cohort === 'all') {
    const [a, b] = [
      await loadRollupsFrom(db, telemetryDaily, window),
      await loadRollupsFrom(db, telemetryDailyTest as unknown as RollupTable, window),
    ];
    const merged = new Map<string, RollupRow>();
    for (const r of [...a.rows, ...b.rows]) {
      const key = [r.metric, ...r.dims].join('\u0000');
      const m = merged.get(key);
      if (m) {
        m.events += r.events;
        m.amount += r.amount;
      } else merged.set(key, { ...r, dims: [...r.dims] as RollupRow['dims'] });
    }
    const days = [a.firstDay, a.lastDay, b.firstDay, b.lastDay].filter(
      (d): d is string => d !== null,
    );
    return {
      rows: [...merged.values()],
      firstDay: days.length ? days.reduce((x, y) => (x < y ? x : y)) : null,
      lastDay: days.length ? days.reduce((x, y) => (x > y ? x : y)) : null,
      days: Math.max(a.days, b.days),
    };
  }
  return loadRollupsFrom(db, telemetryDaily, window);
}

async function loadRollupsFrom(
  db: Executor,
  /** Either table: the two have the same columns. */
  telemetryDaily: RollupTable,
  window: TelemetryWindow,
): Promise<{ rows: RollupRow[]; firstDay: string | null; lastDay: string | null; days: number }> {
  const where = and(
    window.from ? gte(telemetryDaily.day, window.from) : undefined,
    window.to ? lte(telemetryDaily.day, window.to) : undefined,
  );
  const rows = await db
    .select({
      metric: telemetryDaily.metric,
      dim1: telemetryDaily.dim1,
      dim2: telemetryDaily.dim2,
      dim3: telemetryDaily.dim3,
      events: sql<string>`sum(${telemetryDaily.events})`,
      amount: sql<string>`sum(${telemetryDaily.amount})`,
    })
    .from(telemetryDaily)
    .where(where)
    .groupBy(telemetryDaily.metric, telemetryDaily.dim1, telemetryDaily.dim2, telemetryDaily.dim3)
    .orderBy(telemetryDaily.metric, telemetryDaily.dim1, telemetryDaily.dim2, telemetryDaily.dim3);
  const [span] = await db
    .select({
      first: sql<string | null>`min(${telemetryDaily.day})::text`,
      last: sql<string | null>`max(${telemetryDaily.day})::text`,
      days: sql<string>`count(distinct ${telemetryDaily.day})`,
    })
    .from(telemetryDaily)
    .where(where);
  return {
    rows: rows.map((r) => ({
      metric: r.metric as TelemetryMetric,
      dims: [r.dim1, r.dim2, r.dim3],
      events: Number(r.events),
      amount: Number(r.amount),
    })),
    firstDay: span?.first ?? null,
    lastDay: span?.last ?? null,
    days: Number(span?.days ?? 0),
  };
}

interface EquippedRow extends Record<string, unknown> {
  character_id: string;
  class_id: string;
  base_id: string;
  effect_id: string | null;
  set_id: string | null;
  variant: string | null;
  affixes: { affixId: string }[];
}

/** Top affixes in a build signature. */
const SIGNATURE_AFFIXES = 3;
/** Set pieces worn for a set to count in a signature (the first bonus). */
const SET_PIECES = 2;

/**
 * What is equipped right now (state, not events; so it needs no rollup): usage by base, effect,
 * set and variant per class, and each character's build signature. Character ids are used only to
 * group rows in memory and are never returned.
 */
export async function loadSnapshot(db: Executor): Promise<TelemetryReport['snapshot']> {
  const rows = await queryRows<EquippedRow>(
    db,
    sql`select i.character_id, c.class_id, i.base_id, i.effect_id, i.set_id, i.variant, i.affixes
        from item_instances i join characters c on c.id = i.character_id
          join accounts a on a.id = c.account_id
        where i.equipped_slot is not null and c.deleted_at is null and not a.is_test`,
  );
  const usage = new Map<string, UsageRow>();
  const bump = (classId: string, kind: UsageRow['kind'], id: string) => {
    const key = `${classId}\u0000${kind}\u0000${id}`;
    const row = usage.get(key) ?? { classId, kind, id, equipped: 0 };
    row.equipped += 1;
    usage.set(key, row);
  };
  const perCharacter = new Map<string, EquippedRow[]>();
  for (const r of rows) {
    bump(r.class_id, 'base', r.base_id);
    if (r.effect_id) bump(r.class_id, 'effect', r.effect_id);
    if (r.set_id) bump(r.class_id, 'set', r.set_id);
    if (r.variant) bump(r.class_id, 'variant', r.variant);
    const list = perCharacter.get(r.character_id) ?? [];
    list.push(r);
    perCharacter.set(r.character_id, list);
  }
  const builds = new Map<string, BuildRow>();
  for (const items of perCharacter.values()) {
    const signature = buildSignature(items);
    const classId = items[0]!.class_id;
    const key = `${classId}\u0000${signature}`;
    const row = builds.get(key) ?? { classId, signature, characters: 0 };
    row.characters += 1;
    builds.set(key, row);
  }
  return {
    equippedCharacters: perCharacter.size,
    usage: [...usage.values()].sort(
      (a, b) =>
        a.classId.localeCompare(b.classId) ||
        a.kind.localeCompare(b.kind) ||
        b.equipped - a.equipped ||
        a.id.localeCompare(b.id),
    ),
    builds: [...builds.values()].sort(
      (a, b) =>
        a.classId.localeCompare(b.classId) ||
        b.characters - a.characters ||
        a.signature.localeCompare(b.signature),
    ),
  };
}

/**
 * A build signature: the three affixes on the most equipped items (ties by id), then every
 * equipped effect and every set worn with at least two pieces, e.g.
 * `crit_chance+attack_speed+health | effect:ember_wake | set:vigil`.
 */
export function buildSignature(
  items: readonly Pick<EquippedRow, 'effect_id' | 'set_id' | 'affixes'>[],
): string {
  const affixes = new Map<string, number>();
  const sets = new Map<string, number>();
  const effects = new Set<string>();
  for (const item of items) {
    for (const a of new Set((item.affixes ?? []).map((x) => x.affixId))) {
      affixes.set(a, (affixes.get(a) ?? 0) + 1);
    }
    if (item.effect_id) effects.add(item.effect_id);
    if (item.set_id) sets.set(item.set_id, (sets.get(item.set_id) ?? 0) + 1);
  }
  const top = [...affixes.entries()]
    .sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
    .slice(0, SIGNATURE_AFFIXES)
    .map(([id]) => id);
  const parts = [top.length > 0 ? top.join('+') : 'no affixes'];
  for (const e of [...effects].sort()) parts.push(`effect:${e}`);
  for (const [s, n] of [...sets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (n >= SET_PIECES) parts.push(`set:${s}`);
  }
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------------------------
// Reconciliation with the audit log

/** Sum of rollup rows matching a metric and dimension prefix. */
export function sumRollups(
  rows: readonly RollupRow[],
  metric: TelemetryMetric,
  match: (dims: RollupRow['dims']) => boolean = () => true,
  field: 'events' | 'amount' = 'events',
): number {
  return rows.filter((r) => r.metric === metric && match(r.dims)).reduce((s, r) => s + r[field], 0);
}

async function auditScalar(db: Executor, query: SQL): Promise<number> {
  const [row] = await queryRows<{ n: string | number | null }>(db, query);
  return Number(row?.n ?? 0);
}

const num = (path: SQL) => sql`coalesce(sum((${path})::bigint), 0)`;

/**
 * Recomputes every total the audit log records and compares it with the rollups (all time: audit
 * rows are stamped with the database clock, rollups with the game clock's day, so only the
 * all-time totals are comparable). Every check must hold exactly; the real-PostgreSQL tests run it
 * after racing settles, claims, sells and forge actions.
 */
export async function reconcileWithAudit(db: Executor): Promise<ReconcileCheck[]> {
  const { rows } = await loadRollups(db, { from: null, to: null }, 'all');
  const audit = (event: string, select: SQL, extra?: SQL) =>
    auditScalar(
      db,
      sql`select ${select} as n from audit_log where event = ${event} ${extra ? sql`and ${extra}` : sql``}`,
    );
  /** Sum of the values of a JSON object field (a material bundle) over an event's rows. */
  const bundle = (event: string, path: SQL) =>
    auditScalar(
      db,
      sql`select coalesce(sum(m.value::bigint), 0) as n
          from audit_log a, jsonb_each_text(coalesce(${path}, '{}'::jsonb)) m
          where a.event = ${event}`,
    );
  const src = (s: string) => (d: RollupRow['dims']) => d[0] === s;
  const crypt = (d: RollupRow['dims']) => d[0] === 'crypt' || d[0] === 'crypt_hoard';
  const fate = (source: (d: RollupRow['dims']) => boolean, f: string) => (d: RollupRow['dims']) =>
    source(d) && d[1] === f;
  const goldPrefix = (p: string) => (d: RollupRow['dims']) => d[0].startsWith(p);
  /** Material units both sides of every accepted trade moved (ticket T.5). */
  const tradeMaterials = (event = 'trade.accept') =>
    auditScalar(
      db,
      sql`select coalesce(sum(m.value::bigint), 0) as n
          from audit_log a,
          jsonb_each_text(coalesce(a.data->'give'->'materials', '{}'::jsonb)
                          || '{}'::jsonb) m
          where a.event = ${event}`,
    ).then(
      async (give) =>
        give +
        (await auditScalar(
          db,
          sql`select coalesce(sum(m.value::bigint), 0) as n
            from audit_log a, jsonb_each_text(coalesce(a.data->'ask'->'materials', '{}'::jsonb)) m
            where a.event = ${event}`,
        )),
    );

  const checks: [string, Promise<number>, number][] = [
    // Farming settlement
    [
      'farming: settlements',
      audit('activity.reward', sql`count(*)`),
      sumRollups(rows, 'farming.settle'),
    ],
    [
      'farming: gold',
      audit('activity.reward', num(sql`data->>'gold'`)),
      sumRollups(rows, 'gold.in', goldPrefix('farming_'), 'amount'),
    ],
    [
      'farming: overflow gold',
      audit('activity.reward', num(sql`data->>'goldSalvaged'`)),
      sumRollups(rows, 'gold.in', src('farming_overflow'), 'amount'),
    ],
    [
      'farming: items kept',
      audit('activity.reward', num(sql`data->>'items'`)),
      sumRollups(rows, 'item.fate', fate(src('farming'), 'kept')) +
        sumRollups(rows, 'item.fate', fate(src('farming'), 'kept_over_capacity')),
    ],
    [
      'farming: items kept over capacity',
      audit('activity.reward', num(sql`data->>'itemsOverCapacity'`)),
      sumRollups(rows, 'item.fate', fate(src('farming'), 'kept_over_capacity')),
    ],
    [
      'farming: over capacity (pack.over_capacity)',
      audit('activity.reward', num(sql`data->>'itemsOverCapacity'`)),
      sumRollups(rows, 'pack.over_capacity', src('farming'), 'amount'),
    ],
    [
      'farming: items overflowed',
      audit('activity.reward', num(sql`data->>'itemsSalvaged'`)),
      sumRollups(rows, 'item.fate', fate(src('farming'), 'overflow_salvaged')),
    ],
    [
      'farming: overflow (pack.overflow)',
      audit('activity.reward', num(sql`data->>'itemsSalvaged'`)),
      sumRollups(rows, 'pack.overflow', src('farming'), 'amount'),
    ],
    [
      'farming: filter sold',
      audit('activity.reward', num(sql`data->'filtered'->>'sold'`)),
      sumRollups(rows, 'item.fate', fate(src('farming'), 'filter_sold')),
    ],
    [
      'farming: filter salvaged',
      audit('activity.reward', num(sql`data->'filtered'->>'salvaged'`)),
      sumRollups(rows, 'item.fate', fate(src('farming'), 'filter_salvaged')),
    ],
    [
      'farming: filter gold',
      audit('activity.reward', num(sql`data->'filtered'->>'gold'`)),
      sumRollups(rows, 'gold.in', src('farming_filter'), 'amount'),
    ],
    [
      'farming: xp',
      audit('activity.reward', num(sql`data->>'xp'`)),
      sumRollups(rows, 'xp.in', src('farming'), 'amount'),
    ],
    [
      'farming: materials gathered',
      bundle('activity.reward', sql`a.data->'materials'`),
      sumRollups(rows, 'material.in', src('farming_gather'), 'amount'),
    ],
    [
      'farming: filter materials',
      bundle('activity.reward', sql`a.data->'filtered'->'materials'`),
      sumRollups(rows, 'material.in', src('farming_filter'), 'amount'),
    ],
    // Crypt
    ['crypt: runs started', audit('dungeon.start', sql`count(*)`), sumRollups(rows, 'crypt.start')],
    [
      'crypt: claims won',
      audit('dungeon.claim', sql`count(*)`, sql`data->>'outcome' = 'cleared'`),
      sumRollups(rows, 'crypt.claim', (d) => d[1] === 'won'),
    ],
    [
      'crypt: claims lost',
      audit('dungeon.claim', sql`count(*)`, sql`data->>'outcome' = 'failed'`),
      sumRollups(rows, 'crypt.claim', (d) => d[1] === 'lost'),
    ],
    // Ticket 6.3: per boss modifier (claims and attempts written since 6.3 carry the key).
    [
      'boss modifiers: runs claimed',
      audit('dungeon.claim', sql`count(*)`, sql`(data->'bossModifier') is not null`),
      sumRollups(rows, 'boss_modifier.run'),
    ],
    [
      'boss modifiers: guild boss attempts',
      audit('guild_boss.attempt', sql`count(*)`, sql`(data->'bossModifier') is not null`),
      sumRollups(rows, 'boss_modifier.guild_boss'),
    ],
    [
      'crypt: boss hoards',
      audit('dungeon.claim', sql`count(*)`, sql`(data->>'bossLoot')::boolean`),
      sumRollups(rows, 'crypt.claim', (d) => d[2] === 'hoard'),
    ],
    [
      'crypt: gold',
      audit('dungeon.claim', num(sql`data->>'gold'`)),
      sumRollups(rows, 'gold.in', goldPrefix('crypt_'), 'amount'),
    ],
    [
      'crypt: items kept',
      audit('dungeon.claim', num(sql`data->>'items'`)),
      sumRollups(rows, 'item.fate', fate(crypt, 'kept')) +
        sumRollups(rows, 'item.fate', fate(crypt, 'kept_over_capacity')),
    ],
    [
      'crypt: items kept over capacity',
      audit('dungeon.claim', num(sql`data->>'itemsOverCapacity'`)),
      sumRollups(rows, 'pack.over_capacity', src('crypt'), 'amount'),
    ],
    [
      'crypt: items overflowed',
      audit('dungeon.claim', num(sql`data->>'itemsSalvaged'`)),
      sumRollups(rows, 'pack.overflow', src('crypt'), 'amount'),
    ],
    [
      'crypt: filter sold',
      audit('dungeon.claim', num(sql`data->'filtered'->>'sold'`)),
      sumRollups(rows, 'item.fate', fate(crypt, 'filter_sold')),
    ],
    [
      'crypt: filter salvaged',
      audit('dungeon.claim', num(sql`data->'filtered'->>'salvaged'`)),
      sumRollups(rows, 'item.fate', fate(crypt, 'filter_salvaged')),
    ],
    [
      'crypt: filter gold',
      audit('dungeon.claim', num(sql`data->'filtered'->>'gold'`)),
      sumRollups(rows, 'gold.in', src('crypt_filter'), 'amount'),
    ],
    [
      'crypt: xp',
      audit('dungeon.claim', num(sql`data->>'xp'`)),
      sumRollups(rows, 'xp.in', src('crypt'), 'amount'),
    ],
    [
      'crypt: materials',
      bundle('dungeon.claim', sql`a.data->'materials'`),
      sumRollups(rows, 'material.in', src('crypt_loot'), 'amount'),
    ],
    [
      'crypt: filter materials',
      bundle('dungeon.claim', sql`a.data->'filtered'->'materials'`),
      sumRollups(rows, 'material.in', src('crypt_filter'), 'amount'),
    ],
    // Quests and contracts
    [
      'quests: story turn-ins',
      audit('quest.turn_in', sql`count(*)`, sql`data->>'kind' = 'story'`),
      sumRollups(rows, 'quest.reward', (d) => d[0] === 'story'),
    ],
    [
      'quests: contract turn-ins',
      audit('quest.turn_in', sql`count(*)`, sql`data->>'kind' = 'contract'`),
      sumRollups(rows, 'quest.reward', (d) => d[0] === 'contract'),
    ],
    [
      'quests: reward items',
      audit('quest.turn_in', sql`count(*)`, sql`jsonb_typeof(data->'item') = 'object'`),
      sumRollups(rows, 'item.drop', (d) => d[0] === 'quest' || d[0] === 'contract'),
    ],
    [
      'quests: gold',
      audit('quest.turn_in', num(sql`data->>'gold'`)),
      sumRollups(rows, 'gold.in', (d) => d[0] === 'quest' || d[0] === 'contract', 'amount'),
    ],
    [
      'quests: xp',
      audit('quest.turn_in', num(sql`data->>'xp'`)),
      sumRollups(rows, 'xp.in', (d) => d[0] === 'quest' || d[0] === 'contract', 'amount'),
    ],
    [
      'quests: materials',
      bundle('quest.turn_in', sql`a.data->'materials'`),
      sumRollups(rows, 'material.in', (d) => d[0] === 'quest' || d[0] === 'contract', 'amount'),
    ],
    // Merchant
    [
      'merchant: buys',
      audit('merchant.buy', sql`count(*)`),
      sumRollups(rows, 'item.drop', src('merchant')),
    ],
    [
      'merchant: buy gold',
      audit('merchant.buy', num(sql`data->>'price'`)),
      sumRollups(rows, 'gold.out', src('merchant_buy'), 'amount'),
    ],
    [
      'merchant: items sold',
      audit('merchant.sell', sql`coalesce(sum(jsonb_array_length(data->'items')), 0)`),
      sumRollups(rows, 'item.sold'),
    ],
    [
      'merchant: sell gold',
      audit('merchant.sell', num(sql`data->>'gold'`)),
      sumRollups(rows, 'gold.in', src('merchant_sell'), 'amount'),
    ],
    // Forge
    [
      'forge: items salvaged',
      audit('forge.salvage', sql`coalesce(sum(jsonb_array_length(data->'items')), 0)`),
      sumRollups(rows, 'item.salvaged'),
    ],
    [
      'forge: salvage gold',
      audit('forge.salvage', num(sql`data->>'gold'`)),
      sumRollups(rows, 'gold.in', src('forge_salvage'), 'amount'),
    ],
    [
      'forge: salvage materials',
      bundle('forge.salvage', sql`a.data->'materials'`),
      sumRollups(rows, 'material.in', src('forge_salvage'), 'amount'),
    ],
    ...(['craft', 'upgrade', 'reroll', 'improve'] as const).flatMap(
      (action): [string, Promise<number>, number][] => [
        [
          `forge: ${action}s`,
          audit(`forge.${action}`, sql`count(*)`),
          sumRollups(rows, 'forge', (d) => d[0] === action),
        ],
        [
          `forge: ${action} gold`,
          audit(`forge.${action}`, num(sql`data->>'gold'`)),
          sumRollups(rows, 'gold.out', src(`forge_${action}`), 'amount'),
        ],
        [
          `forge: ${action} materials`,
          bundle(`forge.${action}`, sql`a.data->'materials'`),
          sumRollups(rows, 'material.out', src(`forge_${action}`), 'amount'),
        ],
      ],
    ),
    [
      'forge: upgrade successes',
      audit('forge.upgrade', sql`count(*)`, sql`(data->>'success')::boolean`),
      sumRollups(rows, 'forge', (d) => d[0] === 'upgrade' && d[2] !== 'failure'),
    ],
    // Guilds (ticket 4.4): founding costs gold.
    [
      'guilds: founded',
      audit('guild.create', sql`count(*)`),
      sumRollups(rows, 'gold.out', src('guild_create')),
    ],
    [
      'guilds: founding gold',
      audit('guild.create', num(sql`data->>'gold'`)),
      sumRollups(rows, 'gold.out', src('guild_create'), 'amount'),
    ],
    // Guild boss (ticket 4.9): attempts, counted damage, stages, and the claimed rewards.
    [
      'guild boss: attempts',
      audit('guild_boss.attempt', sql`count(*)`),
      sumRollups(rows, 'guild_boss.attempt'),
    ],
    [
      'guild boss: counted damage',
      audit('guild_boss.attempt', num(sql`data->>'counted'`)),
      sumRollups(rows, 'guild_boss.attempt', () => true, 'amount'),
    ],
    [
      'guild boss: stages reached',
      audit('guild_boss.stage', sql`count(*)`),
      sumRollups(rows, 'guild_boss.stage'),
    ],
    [
      'guild boss: reward gold',
      audit('guild_boss.claim', num(sql`data->>'gold'`)),
      sumRollups(rows, 'gold.in', src('guild_boss'), 'amount'),
    ],
    [
      'guild boss: reward materials',
      bundle('guild_boss.claim', sql`a.data->'materials'`),
      sumRollups(rows, 'material.in', src('guild_boss'), 'amount'),
    ],
    // Community projects (ticket 4.6): contributions spend gold and materials.
    [
      'community: contributions',
      audit('community.contribute', sql`count(*)`),
      sumRollups(rows, 'community.contribute'),
    ],
    [
      'community: gold',
      audit('community.contribute', num(sql`data->>'gold'`)),
      sumRollups(rows, 'gold.out', src('community_project'), 'amount'),
    ],
    [
      'community: materials',
      bundle('community.contribute', sql`a.data->'materials'`),
      sumRollups(rows, 'material.out', src('community_project'), 'amount'),
    ],
    [
      'community: stages completed',
      audit('community.stage_complete', sql`count(*)`),
      sumRollups(rows, 'community.stage'),
    ],
    // Warehouse (ticket 4.7): moves are counted per item; upgrades spend gold.
    ...(['deposit', 'withdraw'] as const).map((direction): [string, Promise<number>, number] => [
      `warehouse: items ${direction === 'deposit' ? 'deposited' : 'withdrawn'}`,
      audit(`warehouse.${direction}`, num(sql`jsonb_array_length(data->'items')`)),
      sumRollups(rows, 'warehouse.move', src(direction), 'amount'),
    ]),
    [
      'warehouse: upgrades',
      audit('warehouse.upgrade', sql`count(*)`),
      sumRollups(rows, 'warehouse.upgrade'),
    ],
    [
      'warehouse: upgrade gold',
      audit('warehouse.upgrade', num(sql`data->>'gold'`)),
      sumRollups(rows, 'gold.out', src('warehouse_upgrade'), 'amount'),
    ],
    // Account shelf (ticket T.3): every move, by direction and kind (items, gold, units).
    ...(['deposit', 'withdraw'] as const).flatMap((direction) =>
      (['items', 'materials', 'gold'] as const).map((kind): [string, Promise<number>, number] => [
        `shelf: ${kind} ${direction === 'deposit' ? 'deposited' : 'withdrawn'}`,
        audit(`shelf.${direction}`, num(sql`data->>'amount'`), sql`data->>'kind' = ${kind}`),
        sumRollups(rows, 'shelf.move', (d) => d[0] === direction && d[1] === kind, 'amount'),
      ]),
    ),
    // Duels (ticket 5.5): every duel, by kind; a duel moves no value.
    ...(['rated', 'friendly'] as const).map((kind): [string, Promise<number>, number] => [
      `duels: ${kind}`,
      audit('duel.fight', sql`count(*)`, sql`data->>'kind' = ${kind}`),
      sumRollups(rows, 'duel.fight', (d) => d[0] === kind),
    ]),
    // Discards
    ['items discarded', audit('item.discard', sql`count(*)`), sumRollups(rows, 'item.discarded')],
    // Trades (ticket T.5): completed trades, traded items, and the gold and materials moved.
    ['trades: completed', audit('trade.accept', sql`count(*)`), sumRollups(rows, 'trade.complete')],
    [
      'trades: items (trade.items)',
      audit(
        'trade.accept',
        num(
          sql`jsonb_array_length(data->'give'->'items') + jsonb_array_length(data->'ask'->'items')`,
        ),
      ),
      sumRollups(rows, 'trade.items'),
    ],
    [
      'trades: items (item.fate traded)',
      audit(
        'trade.accept',
        num(
          sql`jsonb_array_length(data->'give'->'items') + jsonb_array_length(data->'ask'->'items')`,
        ),
      ),
      sumRollups(rows, 'item.fate', (d) => d[0] === 'trade' && d[1] === 'traded'),
    ],
    [
      'trades: gold in',
      audit(
        'trade.accept',
        num(sql`(data->'give'->>'gold')::bigint + (data->'ask'->>'gold')::bigint`),
      ),
      sumRollups(rows, 'gold.in', src('trade'), 'amount'),
    ],
    [
      'trades: gold out',
      audit(
        'trade.accept',
        num(sql`(data->'give'->>'gold')::bigint + (data->'ask'->>'gold')::bigint`),
      ),
      sumRollups(rows, 'gold.out', src('trade'), 'amount'),
    ],
    [
      'trades: material units in',
      tradeMaterials(),
      sumRollups(rows, 'material.in', src('trade'), 'amount'),
    ],
    [
      'trades: material units out',
      tradeMaterials(),
      sumRollups(rows, 'material.out', src('trade'), 'amount'),
    ],
    // Ticket T.6: reversals are mirrored trades: counted, items moved back, gold and material
    // units in = out (source `trade_reverse`), against the `trade.reverse` rows.
    ['trades: reversed', audit('trade.reverse', sql`count(*)`), sumRollups(rows, 'trade.reverse')],
    [
      'trades: items moved back',
      audit(
        'trade.reverse',
        num(
          sql`jsonb_array_length(data->'give'->'items') + jsonb_array_length(data->'ask'->'items')`,
        ),
      ),
      sumRollups(rows, 'trade.reverse', undefined, 'amount'),
    ],
    ...(['in', 'out'] as const).map((dir): [string, Promise<number>, number] => [
      `trades: reversed gold ${dir}`,
      audit(
        'trade.reverse',
        num(sql`(data->'give'->>'gold')::bigint + (data->'ask'->>'gold')::bigint`),
      ),
      sumRollups(rows, `gold.${dir}`, src('trade_reverse'), 'amount'),
    ]),
    ...(['in', 'out'] as const).map((dir): [string, Promise<number>, number] => [
      `trades: reversed material units ${dir}`,
      tradeMaterials('trade.reverse'),
      sumRollups(rows, `material.${dir}`, src('trade_reverse'), 'amount'),
    ]),
  ];
  const out: ReconcileCheck[] = [];
  // Ticket D.4: admin tools are their own sources (grants, refunds, removals, XP, items).
  const adminGold = (mode: string) =>
    audit('admin.gold', num(sql`data->>'amount'`), sql`data->>'mode' = ${mode}`);
  const adminMaterials = (mode: string) =>
    auditScalar(
      db,
      sql`select coalesce(sum(m.value::bigint), 0) as n
          from audit_log a, jsonb_each_text(coalesce(a.data->'materials', '{}'::jsonb)) m
          where a.event = 'admin.materials' and a.data->>'mode' = ${mode}`,
    );
  checks.push(
    [
      'admin: gold granted',
      adminGold('grant'),
      sumRollups(rows, 'gold.in', src('admin_grant'), 'amount'),
    ],
    [
      'admin: gold refunded',
      adminGold('refund'),
      sumRollups(rows, 'gold.in', src('admin_refund'), 'amount'),
    ],
    [
      'admin: gold removed',
      adminGold('remove'),
      sumRollups(rows, 'gold.out', src('admin_remove'), 'amount'),
    ],
    [
      'admin: materials granted',
      adminMaterials('grant'),
      sumRollups(rows, 'material.in', src('admin_grant'), 'amount'),
    ],
    [
      'admin: materials refunded',
      adminMaterials('refund'),
      sumRollups(rows, 'material.in', src('admin_refund'), 'amount'),
    ],
    [
      'admin: materials removed',
      adminMaterials('remove'),
      sumRollups(rows, 'material.out', src('admin_remove'), 'amount'),
    ],
    [
      'admin: XP granted',
      audit('admin.xp', num(sql`data->>'xp'`)),
      sumRollups(rows, 'xp.in', src('admin'), 'amount'),
    ],
    [
      'admin: items granted',
      audit('admin.item.grant', sql`count(*)`),
      sumRollups(rows, 'admin.item', src('grant'), 'amount'),
    ],
    [
      'admin: items removed',
      audit('admin.item.remove', sql`count(*)`),
      sumRollups(rows, 'admin.item', src('remove'), 'amount'),
    ],
  );
  // Ticket 6.6: events (joins, quests done and their tallies, the modifier's bonus, track tiers).
  checks.push(
    ['events: heroes joined', audit('event.join', sql`count(*)`), sumRollups(rows, 'event.join')],
    [
      'events: quests done',
      audit('event.progress', sql`coalesce(sum(jsonb_array_length(data->'completed')), 0)`),
      sumRollups(rows, 'event.quest'),
    ],
    [
      'events: tallies',
      audit('event.progress', num(sql`data->>'tallies'`)),
      sumRollups(rows, 'event.quest', () => true, 'amount'),
    ],
    [
      'events: bonus materials',
      bundle('event.progress', sql`a.data->'bonus'`),
      sumRollups(rows, 'material.in', src('event'), 'amount'),
    ],
    [
      'events: reward tiers granted',
      audit('event.reward', sql`count(*)`),
      sumRollups(rows, 'event.reward'),
    ],
  );
  for (const [check, auditValue, rollup] of checks) {
    const a = await auditValue;
    out.push({ check, audit: a, rollup, ok: a === rollup });
  }
  // Ticket T.3: the shelf conserves value. What every shelf holds now equals deposits minus
  // withdrawals in the audit log (here `rollup` is the stored holding, not a counter).
  const shelfNet = (kind: string) =>
    auditScalar(
      db,
      sql`select coalesce(sum(case when event = 'shelf.deposit' then 1 else -1 end
                 * (data->>'amount')::bigint), 0)
            - case when ${kind} = 'items' then (select count(*) from audit_log
                where event = 'admin.item.remove' and data->>'location' = 'shelf') else 0 end as n
          from audit_log where event in ('shelf.deposit', 'shelf.withdraw')
          and data->>'kind' = ${kind}`,
    );
  const holdings: [string, Promise<number>, Promise<number>][] = [
    // Ticket 6.6: the reward-track ledger holds exactly the audited grants, and the tracks hold
    // exactly the audited tallies.
    [
      'events: track grants held = rewards audited',
      audit('event.reward', sql`count(*)`),
      auditScalar(db, sql`select count(*) as n from event_track_grants`),
    ],
    [
      'events: tallies held = tallies audited',
      audit('event.progress', num(sql`data->>'tallies'`)),
      auditScalar(db, sql`select coalesce(sum(tallies), 0) as n from event_tracks`),
    ],
    [
      'shelf: items held = deposits − withdrawals',
      shelfNet('items'),
      auditScalar(db, sql`select count(*) as n from item_instances where on_shelf`),
    ],
    [
      'shelf: materials held = deposits − withdrawals',
      shelfNet('materials'),
      auditScalar(db, sql`select coalesce(sum(quantity), 0) as n from account_shelf_materials`),
    ],
    [
      'shelf: gold held = deposits − withdrawals',
      shelfNet('gold'),
      auditScalar(db, sql`select coalesce(sum(shelf_gold), 0) as n from accounts`),
    ],
  ];
  // Ticket T.5: escrow and holds conserve value. What open offers hold in escrow equals what
  // `trade.offer` put in minus what endings returned and accepts handed over; what is held now
  // (unreleased holds) equals what accepts gave minus what `trade.release` released.
  const escrowNet = (path: (side: string) => SQL) =>
    auditScalar(
      db,
      sql`select coalesce(sum(case
                 when event = 'trade.offer' then ${path('give')}
                 when event = 'trade.accept' then -${path('give')}
                 else -${path('returned')} end), 0) as n
          from audit_log
          where event in ('trade.offer', 'trade.accept', 'trade.cancel', 'trade.decline',
                          'trade.expire', 'trade.void')`,
    );
  holdings.push(
    [
      'trade escrow: items = offered − returned − handed over',
      escrowNet((side) => sql`jsonb_array_length(data->${side}->'items')`),
      auditScalar(
        db,
        sql`select count(*) as n from item_instances where escrow_offer_id is not null`,
      ),
    ],
    [
      'trade escrow: gold = offered − returned − handed over',
      escrowNet((side) => sql`(data->${side}->>'gold')::bigint`),
      auditScalar(
        db,
        sql`select coalesce(sum(l.amount), 0) as n from trade_offer_lines l
            join trade_offers o on o.id = l.offer_id
            where o.status = 'open' and l.side = 'give' and l.kind = 'gold'`,
      ),
    ],
    [
      'trade escrow: materials = offered − returned − handed over',
      escrowNet(
        (side) =>
          sql`(select coalesce(sum(m.value::bigint), 0) from jsonb_each_text(coalesce(data->${side}->'materials', '{}'::jsonb)) m)`,
      ),
      auditScalar(
        db,
        sql`select coalesce(sum(l.amount), 0) as n from trade_offer_lines l
            join trade_offers o on o.id = l.offer_id
            where o.status = 'open' and l.side = 'give' and l.kind = 'material'`,
      ),
    ],
    [
      'trade holds: gold held = received − released',
      auditScalar(
        db,
        sql`select coalesce(sum(case when event = 'trade.accept'
                 then (data->'give'->>'gold')::bigint + (data->'ask'->>'gold')::bigint
                 else -(data->>'gold')::bigint end), 0) as n
            from audit_log where event in ('trade.accept', 'trade.release')`,
      ),
      auditScalar(
        db,
        sql`select coalesce(sum(gold), 0) as n from trade_holds where released_at is null`,
      ),
    ],
    [
      'trade holds: released once each',
      auditScalar(db, sql`select count(*) as n from audit_log where event = 'trade.release'`),
      auditScalar(db, sql`select count(*) as n from trade_holds where released_at is not null`),
    ],
  );
  for (const [check, auditValue, held] of holdings) {
    const a = await auditValue;
    const h = await held;
    out.push({ check, audit: a, rollup: h, ok: a === h });
  }
  return out;
}

export async function buildTelemetryReport(
  db: Executor,
  window: TelemetryWindow,
  { reconcile = false }: { reconcile?: boolean } = {},
): Promise<TelemetryReport> {
  const { rows, firstDay, lastDay, days } = await loadRollups(db, window);
  const snapshot = await loadSnapshot(db);
  return {
    window: { from: window.from, to: window.to, firstDay, lastDay, days },
    rollups: rows,
    snapshot,
    ...(reconcile ? { reconcile: await reconcileWithAudit(db) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Text rendering

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (n: number, of: number) =>
  of === 0 ? '—' : `${((100 * n) / of).toFixed(of >= 1000 ? 2 : 1)}%`;

function table(headers: string[], body: (string | number)[][], indent = '  '): string[] {
  const numeric = (c: string | number) => typeof c === 'number' || /^(?:[+-]?[\d,.]+%?|—)$/.test(c);
  const cells = [headers, ...body.map((r) => r.map((c) => (typeof c === 'number' ? fmt(c) : c)))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => String(r[i] ?? '').length)));
  return cells.map(
    (r, row) =>
      indent +
      r
        .map((c, i) => {
          const s = String(c ?? '');
          // The label column and text cells go left; numbers (and their headers) go right.
          const right =
            i > 0 &&
            (row === 0 ? body.some((b) => numeric(b[i] ?? '')) : numeric(body[row - 1]![i] ?? ''));
          return right ? s.padStart(widths[i]!) : s.padEnd(widths[i]!);
        })
        .join('  ')
        .trimEnd(),
  );
}

function group<K extends string>(
  rows: readonly RollupRow[],
  metric: TelemetryMetric,
  key: (d: RollupRow['dims']) => K,
  field: 'events' | 'amount' = 'events',
): Map<K, number> {
  const out = new Map<K, number>();
  for (const r of rows) {
    if (r.metric !== metric) continue;
    const k = key(r.dims);
    out.set(k, (out.get(k) ?? 0) + r[field]);
  }
  return out;
}

const sortedDesc = <K>(m: Map<K, number>) => [...m.entries()].sort(([, a], [, b]) => b - a);

const SOURCE_ORDER = ['farming', 'crypt', 'crypt_hoard', 'quest', 'contract', 'merchant', 'craft'];

/** A table of the report: a header row and body rows (numbers unformatted). */
export interface TelemetryTable {
  headers: string[];
  rows: (string | number)[][];
}

/**
 * One section of the report over the rollups (ticket D.3 split it out of the text renderer, so the
 * CLI and the admin panel show the same numbers): a title, tables, then one-line notes.
 */
export interface TelemetrySection {
  title: string;
  tables: TelemetryTable[];
  notes: string[];
}

/** The rollup sections in report order; empty when nothing was recorded in the window. */
export function telemetrySections(report: TelemetryReport): TelemetrySection[] {
  const rows = report.rollups;
  const sections: TelemetrySection[] = [];
  if (rows.length === 0) return sections;
  const section = (title: string): TelemetrySection => {
    const s: TelemetrySection = { title, tables: [], notes: [] };
    sections.push(s);
    return s;
  };

  // Gold
  const goldIn = group(rows, 'gold.in', (d) => d[0], 'amount');
  const goldOut = group(rows, 'gold.out', (d) => d[0], 'amount');
  const totalIn = [...goldIn.values()].reduce((s, n) => s + n, 0);
  const totalOut = [...goldOut.values()].reduce((s, n) => s + n, 0);
  const gold = section(
    `Gold  in ${fmt(totalIn)}  ·  out ${fmt(totalOut)}  ·  net ${fmt(totalIn - totalOut)}`,
  );
  gold.tables.push({
    headers: ['source', 'gold', 'share'],
    rows: sortedDesc(goldIn).map(([k, n]) => [k, n, pct(n, totalIn)]),
  });
  if (goldOut.size > 0) {
    gold.tables.push({
      headers: ['sink', 'gold', 'share'],
      rows: sortedDesc(goldOut).map(([k, n]) => [k, n, pct(n, totalOut)]),
    });
  }

  // Drops by source × rarity
  const drops = rows.filter((r) => r.metric === 'item.drop');
  if (drops.length > 0) {
    const s = section('Drops by source and rarity (every rolled item, whatever became of it)');
    const sources = [...new Set(drops.map((r) => r.dims[0]))].sort(
      (a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b),
    );
    s.tables.push({
      headers: ['source', 'items', ...RARITY_IDS],
      rows: sources.map((src) => {
        const bySource = drops.filter((r) => r.dims[0] === src);
        const total = bySource.reduce((n, r) => n + r.events, 0);
        return [
          src,
          total,
          ...RARITY_IDS.map((rar) =>
            pct(
              bySource.filter((r) => r.dims[2] === rar).reduce((n, r) => n + r.events, 0),
              total,
            ),
          ),
        ];
      }),
    });
    const special = (metric: TelemetryMetric, label: string) => {
      const m = group(rows, metric, (d) => `${d[0]} · ${d[1]}`);
      if (m.size === 0) return;
      const list = sortedDesc(m);
      const shown = list.slice(0, 12).map(([k, n]) => `${k} ${fmt(n)}`);
      if (list.length > 12) shown.push(`+${list.length - 12} more (see --json)`);
      s.notes.push(`${label}: ${shown.join(', ')}`);
    };
    // Ticket 6.4: Void and Prismatic drops, by source and variant.
    special('item.variant', 'Variants (Void, Prismatic)');
    special('item.effect', 'Effects');
    special('item.set', 'Set pieces');

    // Drops by area / crypt tier
    const where = section('Drops by area or crypt tier');
    const contexts = group(
      drops.filter((r) => ['farming', 'crypt', 'crypt_hoard'].includes(r.dims[0])),
      'item.drop',
      (d) => `${d[0] === 'farming' ? 'area' : d[0]} ${d[1]}`,
    );
    const legendaryPlus = group(
      drops.filter(
        (r) =>
          ['farming', 'crypt', 'crypt_hoard'].includes(r.dims[0]) &&
          (r.dims[2] === 'legendary' || r.dims[2] === 'mythic'),
      ),
      'item.drop',
      (d) => `${d[0] === 'farming' ? 'area' : d[0]} ${d[1]}`,
    );
    const hours = group<string>(rows, 'farming.settle', (d) => `area ${d[0]}`, 'amount');
    where.tables.push({
      headers: ['where', 'items', 'legendary+', 'items/h'],
      rows: [...contexts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, n]) => {
          const h = (hours.get(k) ?? 0) / 3600;
          return [k, n, legendaryPlus.get(k) ?? 0, h > 0 ? (n / h).toFixed(1) : '—'];
        }),
    });
  }

  // Fates: filter vs overflow vs manual
  const fates = rows.filter((r) => r.metric === 'item.fate');
  if (fates.length > 0) {
    const s = section(
      'What became of drops (loot filter and full pack are automatic; sells/salvages are manual)',
    );
    const byFate = (f: string) =>
      fates
        .filter((r) => r.dims[1] === f)
        .reduce((a, r) => [a[0]! + r.events, a[1]! + r.amount], [0, 0]);
    const sold = rows.filter((r) => r.metric === 'item.sold');
    const salvaged = rows.filter((r) => r.metric === 'item.salvaged');
    const sum = (rs: RollupRow[]) =>
      rs.reduce((a, r) => [a[0]! + r.events, a[1]! + r.amount], [0, 0]);
    const overflowRuns = group(rows, 'pack.overflow', (d) => d[0]);
    const discarded = sumRollups(rows, 'item.discarded');
    s.tables.push({
      headers: ['fate', 'items', 'gold'],
      rows: [
        ['kept in the pack', byFate('kept')[0]!, '—'],
        ['pack full: valuable, kept over capacity', byFate('kept_over_capacity')[0]!, '—'],
        ['loot filter: sold', ...(byFate('filter_sold') as [number, number])],
        ['loot filter: salvaged', ...(byFate('filter_salvaged') as [number, number])],
        ['pack full: auto-salvaged', byFate('overflow_salvaged')[0]!, '(in gold.in *_overflow)'],
        ['manual: sold to merchant', ...(sum(sold) as [number, number])],
        ['manual: salvaged at forge', ...(sum(salvaged) as [number, number])],
        ['manual: discarded', discarded, '—'],
      ],
    });
    if (overflowRuns.size > 0) {
      s.notes.push(
        `Full-pack overflows: ${[...overflowRuns.entries()]
          .map(([src, n]) => `${src} ${fmt(n)} settlements/claims`)
          .join(', ')}`,
      );
    }
    const overRuns = group(rows, 'pack.over_capacity', (d) => d[0]);
    if (overRuns.size > 0) {
      s.notes.push(
        `Valuable drops kept over capacity: ${[...overRuns.entries()]
          .map(([src, n]) => `${src} ${fmt(n)} settlements/claims`)
          .join(', ')}`,
      );
    }
  }

  // Crypt
  const claims = rows.filter((r) => r.metric === 'crypt.claim');
  const starts = group(rows, 'crypt.start', (d) => d[0]);
  if (claims.length > 0 || starts.size > 0) {
    const tiers = [...new Set([...claims.map((r) => r.dims[0]), ...starts.keys()])].sort();
    section('Crypt tiers').tables.push({
      headers: ['tier', 'started', 'won', 'lost', 'win rate', 'hoards'],
      rows: tiers.map((t) => {
        const won = sumRollups(claims, 'crypt.claim', (d) => d[0] === t && d[1] === 'won');
        const lost = sumRollups(claims, 'crypt.claim', (d) => d[0] === t && d[1] === 'lost');
        const hoards = sumRollups(claims, 'crypt.claim', (d) => d[0] === t && d[2] === 'hoard');
        return [t, starts.get(t) ?? 0, won, lost, pct(won, won + lost), hoards];
      }),
    });
  }

  // Ticket 6.3: win rates and hoard loot per weekly boss modifier (`none`: runs from before 6.3).
  const modRuns = rows.filter((r) => r.metric === 'boss_modifier.run');
  const modGuild = rows.filter((r) => r.metric === 'boss_modifier.guild_boss');
  if (modRuns.length > 0 || modGuild.length > 0) {
    const s = section('Boss modifiers');
    const keys = [...new Set(modRuns.map((r) => `${r.dims[0]}|${r.dims[1]}`))].sort();
    if (keys.length > 0) {
      s.tables.push({
        headers: ['modifier', 'boss', 'won', 'lost', 'win rate', 'hoard items', 'Legendary+'],
        rows: keys.map((k) => {
          const [m, ctx] = k.split('|') as [string, string];
          const at = (o: string) =>
            sumRollups(
              modRuns,
              'boss_modifier.run',
              (d) => d[0] === m && d[1] === ctx && d[2] === o,
            );
          const hoard = (top: boolean) =>
            sumRollups(
              rows,
              'boss_modifier.hoard',
              (d) =>
                d[0] === m && d[1] === ctx && (!top || d[2] === 'legendary' || d[2] === 'mythic'),
              'amount',
            );
          const won = at('won');
          const lost = at('lost');
          return [m, ctx, won, lost, pct(won, won + lost), hoard(false), hoard(true)];
        }),
      });
    }
    const gb = [...new Set(modGuild.map((r) => r.dims[0]))].sort();
    if (gb.length > 0) {
      s.tables.push({
        headers: ['modifier', 'guild boss attempts', 'fell', 'counted damage', 'per attempt'],
        rows: gb.map((m) => {
          const n = sumRollups(modGuild, 'boss_modifier.guild_boss', (d) => d[0] === m);
          const fell = sumRollups(
            modGuild,
            'boss_modifier.guild_boss',
            (d) => d[0] === m && d[2] === 'fell',
          );
          const dmg = sumRollups(modGuild, 'boss_modifier.guild_boss', (d) => d[0] === m, 'amount');
          return [m, n, fell, dmg, n > 0 ? Math.round(dmg / n) : 0];
        }),
      });
    }
  }

  // Ticket 6.6: events: joins, quests done, tallies, bonus materials and reward tiers per event.
  const evRows = rows.filter((r) => r.metric.startsWith('event.'));
  if (evRows.length > 0) {
    const s = section('Events');
    const ids = [...new Set(evRows.map((r) => r.dims[0]))].sort();
    s.tables.push({
      headers: [
        'event',
        'heroes joined',
        'quests done',
        'tallies',
        'tiers granted',
        'bonus materials',
      ],
      rows: ids.map((id) => [
        id,
        sumRollups(evRows, 'event.join', (d) => d[0] === id),
        sumRollups(evRows, 'event.quest', (d) => d[0] === id),
        sumRollups(evRows, 'event.quest', (d) => d[0] === id, 'amount'),
        sumRollups(evRows, 'event.reward', (d) => d[0] === id),
        sumRollups(rows, 'material.in', (d) => d[0] === 'event' && d[2] === id, 'amount'),
      ]),
    });
    const quests = [
      ...new Set(
        evRows.filter((r) => r.metric === 'event.quest').map((r) => `${r.dims[0]}|${r.dims[1]}`),
      ),
    ].sort();
    if (quests.length > 0) {
      s.tables.push({
        headers: ['event · quest', 'done'],
        rows: quests.map((k) => {
          const [e, q] = k.split('|') as [string, string];
          return [
            `${e} · ${q}`,
            sumRollups(evRows, 'event.quest', (d) => d[0] === e && d[1] === q),
          ];
        }),
      });
    }
    const tiers = [
      ...new Set(
        evRows
          .filter((r) => r.metric === 'event.reward')
          .map((r) => `${r.dims[0]}|${r.dims[1]}|${r.dims[2]}`),
      ),
    ].sort();
    if (tiers.length > 0) {
      s.tables.push({
        headers: ['event · tier', 'cosmetic', 'granted'],
        rows: tiers.map((k) => {
          const [e, t, c] = k.split('|') as [string, string, string];
          return [
            `${e} · ${t}`,
            c,
            sumRollups(evRows, 'event.reward', (d) => d[0] === e && d[1] === t),
          ];
        }),
      });
    }
  }

  // Quests
  const quests = rows.filter((r) => r.metric === 'quest.reward');
  if (quests.length > 0) {
    const by = group(quests, 'quest.reward', (d) => `${d[0]} · ${d[2]} reward`);
    section('Quest and contract turn-ins').tables.push({
      headers: ['kind · item reward', 'turn-ins'],
      rows: sortedDesc(by).map(([k, n]) => [k, n]),
    });
  }

  // Forge
  const forge = rows.filter((r) => r.metric === 'forge');
  if (forge.length > 0) {
    const s = section('Forge');
    const actions = ['salvage', 'craft', 'upgrade', 'reroll', 'improve'];
    s.tables.push({
      headers: ['action', 'uses', 'gold', 'materials'],
      rows: actions
        .filter((a) => forge.some((r) => r.dims[0] === a))
        .map((a) => [
          a,
          sumRollups(forge, 'forge', (d) => d[0] === a),
          a === 'salvage'
            ? `+${fmt(sumRollups(rows, 'gold.in', (d) => d[0] === 'forge_salvage', 'amount'))}`
            : sumRollups(rows, 'gold.out', (d) => d[0] === `forge_${a}`, 'amount'),
          a === 'salvage'
            ? `+${fmt(sumRollups(rows, 'material.in', (d) => d[0] === 'forge_salvage', 'amount'))}`
            : sumRollups(rows, 'material.out', (d) => d[0] === `forge_${a}`, 'amount'),
        ]),
    });
    const upgrades = forge.filter((r) => r.dims[0] === 'upgrade');
    if (upgrades.length > 0) {
      const levels = [...new Set(upgrades.map((r) => r.dims[1]))].sort(
        (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
      );
      s.tables.push({
        headers: ['upgrade to', 'tries', 'success', 'guaranteed', 'failure', 'success rate'],
        rows: levels.map((l) => {
          const at = (o: string) => sumRollups(upgrades, 'forge', (d) => d[1] === l && d[2] === o);
          const tries = sumRollups(upgrades, 'forge', (d) => d[1] === l);
          return [
            l,
            tries,
            at('success'),
            at('guaranteed'),
            at('failure'),
            pct(at('success') + at('guaranteed'), tries),
          ];
        }),
      });
    }
  }

  // Materials
  const matIn = group(rows, 'material.in', (d) => d[1], 'amount');
  const matOut = group(rows, 'material.out', (d) => d[1], 'amount');
  if (matIn.size > 0 || matOut.size > 0) {
    const ids = [...new Set([...matIn.keys(), ...matOut.keys()])].sort();
    section('Materials').tables.push({
      headers: ['material', 'in', 'out', 'net'],
      rows: ids.map((id) => [
        id,
        matIn.get(id) ?? 0,
        matOut.get(id) ?? 0,
        (matIn.get(id) ?? 0) - (matOut.get(id) ?? 0),
      ]),
    });
  }

  // Farming
  const settles = rows.filter((r) => r.metric === 'farming.settle');
  if (settles.length > 0) {
    const xp = group(rows, 'xp.in', (d) => (d[0] === 'farming' ? d[1] : ''), 'amount');
    const goldByArea = group(
      rows,
      'gold.in',
      (d) => (d[0].startsWith('farming_') ? d[1] : ''),
      'amount',
    );
    section('Farming').tables.push({
      headers: ['area', 'settlements', 'hours', 'xp/h', 'gold/h'],
      rows: settles.map((r) => {
        const h = r.amount / 3600;
        const area = r.dims[0];
        return [
          area,
          r.events,
          h.toFixed(1),
          h > 0 ? Math.round((xp.get(area) ?? 0) / h) : 0,
          h > 0 ? Math.round((goldByArea.get(area) ?? 0) / h) : 0,
        ];
      }),
    });
  }
  return sections;
}

export function renderTelemetryReport(report: TelemetryReport): string {
  const { rollups: rows, window, snapshot } = report;
  const out: string[] = [];
  const range = `${window.from ?? 'first day'} … ${window.to ?? 'last day'}`;
  out.push('Worldforge telemetry — server-side aggregates (no player data)');
  out.push(
    window.days > 0
      ? `Window: ${range}  ·  recorded days: ${window.firstDay} … ${window.lastDay} (${window.days})`
      : `Window: ${range}`,
  );
  out.push('');

  if (rows.length === 0) {
    out.push('No telemetry recorded in this window.');
    out.push(
      '  Counters are written by farming settlements, crypt runs, quest turn-ins, the merchant and',
    );
    out.push(
      '  the forge (from ticket 3.8 on). Play a little (pnpm playtest) or widen the window.',
    );
    out.push('');
  } else {
    for (const section of telemetrySections(report)) {
      out.push(section.title);
      for (const t of section.tables) out.push(...table(t.headers, t.rows));
      for (const note of section.notes) out.push(`  ${note}`);
      out.push('');
    }
  }

  // Snapshot
  out.push(
    `Equipped now (snapshot, all characters with gear: ${fmt(snapshot.equippedCharacters)})`,
  );
  if (snapshot.equippedCharacters === 0) {
    out.push('  Nobody has anything equipped yet.');
  } else {
    const classes = [...new Set(snapshot.usage.map((u) => u.classId))].sort();
    for (const c of classes) {
      const top = (kind: UsageRow['kind'], n: number) =>
        snapshot.usage
          .filter((u) => u.classId === c && u.kind === kind)
          .slice(0, n)
          .map((u) => `${u.id} ${u.equipped}`)
          .join(', ') || '—';
      out.push(`  ${c}`);
      out.push(`    bases:   ${top('base', 6)}`);
      out.push(`    effects: ${top('effect', 6)}`);
      out.push(`    sets:    ${top('set', 6)}`);
      const builds = snapshot.builds.filter((b) => b.classId === c);
      const heroes = builds.reduce((s, b) => s + b.characters, 0);
      out.push(`    builds (${builds.length} distinct among ${heroes}):`);
      for (const b of builds.slice(0, 5)) {
        out.push(`      ${pct(b.characters, heroes).padStart(6)}  ${b.signature}`);
      }
    }
  }

  if (report.reconcile) {
    out.push('');
    const bad = report.reconcile.filter((c) => !c.ok);
    out.push(
      bad.length === 0
        ? `Audit log reconciliation: all ${report.reconcile.length} checks match (all time).`
        : `Audit log reconciliation: ${bad.length} of ${report.reconcile.length} checks DIFFER (all time):`,
    );
    for (const c of bad) out.push(`  ${c.check}: audit ${fmt(c.audit)} vs rollup ${fmt(c.rollup)}`);
  }
  return out.join('\n');
}
