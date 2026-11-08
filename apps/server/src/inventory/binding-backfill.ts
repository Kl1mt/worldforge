import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { hoardSource, itemBindingState } from '@worldforge/game-core';
import {
  characters,
  dataBackfills,
  dungeonRuns,
  itemInstances,
  type ItemInstance,
} from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { queryRows } from '../db/query.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor } from '../db/types.js';
import { hoardDrops } from '../dungeon/routes.js';

/**
 * The item-binding backfill (ticket T.1, docs/TRADING.md "Items that exist before trading ships",
 * docs/DEPLOY.md "Data backfills"). Gives every item row written before T.1 (`binding is null`)
 * its binding, and marks the bind-on-equip ones whose creation isn't in the audit log.
 *
 * Per item, from what is known:
 * - **Boss hoards.** A crypt or Watch item listed in a claimed run's stored result is a hoard drop
 *   when the run's replay without the hoard lacks its seed (the 3.8 telemetry rule); its `source`
 *   becomes `hoard:<dungeon>`, which binds it. A run whose replay fails counts all its items as
 *   the hoard's (the safe side).
 * - **The binding** is game-core's `itemBindingState` of the row: worn (equipped now; its
 *   `first_equipped_at` becomes the backfill time) or forged (any upgrade attempt, reroll or
 *   improvement) binds; boss hoards, quests, contracts, merchant goods, commons to rares and
 *   unclassified sources are account-bound; the rest is bind on equip. Items worn earlier but not
 *   now count as fresh (the accepted risk in TRADING.md). Account-bound rows get `bound_account_id`.
 * - **Provenance**, only for bind-on-equip rows (nothing else can ever be offered): the item's id
 *   in its character's `activity.reward` / `dungeon.claim` `notableItems`, a `forge.craft`
 *   `itemId` or an earlier `item.provenance` row. A crypt item found only in its run's stored
 *   result (written in the claim's transaction, before claims listed items in the audit log) gets
 *   one `item.provenance` audit row per character listing those ids (`from: 'dungeon_runs'`).
 *   Anything else gets `unprovenanced = true`: T.4/T.5 refuse and flag it.
 *
 * Safe on live data: it runs in the server after start-up (it never holds up a deploy), one short
 * transaction per character, takes item rows with `for update skip locked` (a row a request holds
 * is left for the next pass, never waited for) and only ever writes rows whose `binding` is still
 * null, so equip and the Forge (which set the binding themselves) always win. Idempotent and
 * resumable: a crash or a second run only picks up rows still null; the `data_backfills` row
 * records the finished pass, after which start-ups skip it.
 */
export const ITEM_BINDING_BACKFILL_ID = 'item-binding:t1';

export interface ItemBindingBackfillCounts {
  characters: number;
  items: number;
  bound: number;
  bindOnEquip: number;
  hoard: number;
  recovered: number;
  unprovenanced: number;
}

export interface ItemBindingBackfillResult extends ItemBindingBackfillCounts {
  id: string;
  /** False when this backfill had already finished on this database. */
  ran: boolean;
  /** Rows still null after the pass (held by a request); the next start-up retries them. */
  skipped: number;
}

const zero = (): ItemBindingBackfillCounts => ({
  characters: 0,
  items: 0,
  bound: 0,
  bindOnEquip: 0,
  hoard: 0,
  recovered: 0,
  unprovenanced: 0,
});

/** The item ids whose creation is in the audit log, for one character's account. */
async function provenancedIds(
  executor: Executor,
  accountId: string,
  characterId: string,
): Promise<Set<string>> {
  const rows = await queryRows<{ id: string }>(
    executor,
    sql`select distinct r #>> '{}' as id
        from audit_log a,
        lateral jsonb_path_query(
          a.data,
          (case
            when a.event in ('activity.reward', 'dungeon.claim') then '$.notableItems[*].id'
            when a.event = 'forge.craft' then '$.itemId'
            else '$.itemIds[*]'
          end)::jsonpath
        ) r
        where a.account_id = ${accountId}
          and a.character_id = ${characterId}
          and a.event in ('activity.reward', 'dungeon.claim', 'forge.craft', 'item.provenance')`,
  );
  return new Set(rows.map((r) => r.id));
}

/** Crypt items by id: the run that recorded them and whether they were the boss hoard's. */
async function dungeonOrigins(
  executor: Executor,
  characterId: string,
  items: readonly ItemInstance[],
): Promise<Map<string, { dungeonId: string; hoard: boolean }>> {
  const out = new Map<string, { dungeonId: string; hoard: boolean }>();
  const wanted = new Map(items.map((i) => [i.id, i]));
  if (wanted.size === 0) return out;
  const runs = await executor
    .select()
    .from(dungeonRuns)
    .where(and(eq(dungeonRuns.characterId, characterId), isNotNull(dungeonRuns.claimedAt)))
    .orderBy(asc(dungeonRuns.startedAt));
  for (const run of runs) {
    const listed = ((run.result as { items?: { id?: unknown }[] } | null)?.items ?? [])
      .map((x) => (typeof x.id === 'string' ? wanted.get(x.id) : undefined))
      .filter((x): x is ItemInstance => x !== undefined);
    if (listed.length === 0) continue;
    let hoard: (seed: number) => boolean;
    try {
      hoard = hoardDrops(run, run.bossLootGranted === true);
    } catch {
      hoard = () => run.bossLootGranted === true;
    }
    for (const item of listed) {
      out.set(item.id, { dungeonId: run.dungeonId, hoard: hoard(item.seed) });
    }
  }
  return out;
}

/** Backfills one character's null-binding items; must run inside a transaction. */
export async function backfillCharacterItems(
  tx: Executor,
  characterId: string,
  now: Date,
): Promise<ItemBindingBackfillCounts> {
  const counts = zero();
  const [character] = await tx
    .select({ accountId: characters.accountId })
    .from(characters)
    .where(eq(characters.id, characterId));
  if (!character) return counts;
  const rows = await tx
    .select()
    .from(itemInstances)
    .where(and(eq(itemInstances.characterId, characterId), isNull(itemInstances.binding)))
    .orderBy(asc(itemInstances.id))
    .for('update', { skipLocked: true });
  if (rows.length === 0) return counts;
  counts.characters = 1;

  const origins = await dungeonOrigins(
    tx,
    characterId,
    rows.filter((r) => r.source.startsWith('dungeon:')),
  );
  let audited: Set<string> | null = null;
  const recovered: string[] = [];

  for (const row of rows) {
    const origin = origins.get(row.id);
    const source = origin?.hoard ? hoardSource(origin.dungeonId) : row.source;
    const { binding } = itemBindingState({ ...row, source });
    let unprovenanced = false;
    if (binding === 'equip') {
      audited ??= await provenancedIds(tx, character.accountId, characterId);
      if (!audited.has(row.id)) {
        if (origin) recovered.push(row.id);
        else unprovenanced = true;
      }
    }
    await tx
      .update(itemInstances)
      .set({
        binding,
        boundAccountId: binding === 'account' ? character.accountId : null,
        unprovenanced,
        ...(source !== row.source ? { source } : {}),
        ...(row.equippedSlot !== null ? { firstEquippedAt: now } : {}),
      })
      .where(and(eq(itemInstances.id, row.id), isNull(itemInstances.binding)));
    counts.items += 1;
    if (binding === 'account') counts.bound += 1;
    else counts.bindOnEquip += 1;
    if (source !== row.source) counts.hoard += 1;
    if (unprovenanced) counts.unprovenanced += 1;
  }
  if (recovered.length > 0) {
    await writeAudit(tx, {
      event: 'item.provenance',
      accountId: character.accountId,
      characterId,
      data: { from: 'dungeon_runs', itemIds: recovered },
    });
    counts.recovered = recovered.length;
  }
  return counts;
}

/** Runs the item-binding backfill once per database (see the module comment). */
export async function backfillItemBinding(
  db: Database,
  { now = () => new Date(), force = false, batch = 200 } = {},
): Promise<ItemBindingBackfillResult> {
  const id = ITEM_BINDING_BACKFILL_ID;
  if (!force) {
    const [done] = await db.select().from(dataBackfills).where(eq(dataBackfills.id, id));
    if (done) return { id, ran: false, skipped: 0, ...zero() };
  }
  const total = zero();
  let after: string | null = null;
  for (;;) {
    const page: { characterId: string }[] = await db
      .selectDistinct({ characterId: itemInstances.characterId })
      .from(itemInstances)
      .where(
        and(
          isNull(itemInstances.binding),
          after ? gt(itemInstances.characterId, after) : undefined,
        ),
      )
      .orderBy(asc(itemInstances.characterId))
      .limit(batch);
    if (page.length === 0) break;
    for (const { characterId } of page) {
      // One short transaction per character: a crash leaves finished characters done.
      const c = await withTransaction(db, (tx) => backfillCharacterItems(tx, characterId, now()));
      for (const k of Object.keys(total) as (keyof ItemBindingBackfillCounts)[]) total[k] += c[k];
    }
    after = page[page.length - 1]!.characterId;
  }
  const [left] = await queryRows<{ n: number }>(
    db,
    sql`select count(*)::int as n from item_instances where binding is null`,
  );
  const skipped = Number(left?.n ?? 0);
  // Rows a request held stay null; the next start-up picks them up (the row isn't written yet).
  if (skipped === 0) {
    await db
      .insert(dataBackfills)
      .values({ id, completedAt: now(), data: { ...total } })
      .onConflictDoUpdate({
        target: dataBackfills.id,
        set: { completedAt: now(), data: { ...total } },
      });
  }
  return { id, ran: true, skipped, ...total };
}
