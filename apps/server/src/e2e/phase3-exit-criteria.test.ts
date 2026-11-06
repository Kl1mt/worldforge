/**
 * Phase 3 exit criteria, end to end through the HTTP API with a simulated server clock (ticket 3.9,
 * GDD §15 Phase 3): different item combinations create meaningful build choices; crafting costs
 * and drop rates are measurable; no single item or affix dominates all builds (the last is B.2's
 * build-diversity test, `packages/game-core/src/balance/builds.test.ts`).
 *
 * The hero of the Phase 2 run (`./journey.ts`, no shortcuts) plays on past the Sunken Abbey the way
 * a Phase 3 player would: a loot filter sells commons and uncommons and is seen acting; the hero
 * finds a Legendary and a set piece and locks them (sell, salvage and discard refuse a locked
 * item); upgrades worn gear at the Forge (a failure and a pity-guaranteed success included), rerolls
 * and improves an affix; turns in a targeted Abbey contract for a ring; clears crypt tiers II and
 * III; and lets the pack fill until a valuable drop is kept beyond its capacity (B.2).
 *
 * Valid means: every gold piece, item and material held at the end matches the audit log, the
 * telemetry rollups reconcile with the audit log through the real `pnpm report:telemetry --
 * --reconcile` command (on this run's database), and that report measures the drops and forge
 * spending seen here. The browser version is `tools/e2e/phase3-exit.mjs`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import {
  attemptUpgrade,
  createRng,
  findItemBase,
  quoteUpgrade,
  type ClassId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { InventoryView, ItemView } from '../inventory/routes.js';
import type { ForgeActionResponse, ForgeItemResponse, ForgeOutcome } from '../forge/work.js';
import type { DungeonStateResponse } from '../dungeon/routes.js';
import { itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPgliteDatabase } from '../test/db.js';
import type { RollupRow, TelemetryReport } from '../telemetry/report.js';
import { HOUR, expectHoldingsMatchAudit, isValuable, startJourney } from './journey.js';

/** `E2E_CLASS=mage` etc. plays another class (the default is the CI run). */
const CLASS_ID = (process.env.E2E_CLASS ?? 'warrior') as ClassId;
const CAP = 3 * HOUR;
/** Safety nets: the Phase 2 part (≈ 32 h) and the whole run. */
const PHASE2_HOURS = 90;
const MAX_HOURS = 240;
const CAPACITY = DEFAULT_ACTIVITY_OPTIONS.rules.inventory.capacity;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let dataDir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-02T08:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };

beforeAll(async () => {
  // On disk, so the real report command can open this run's database afterwards.
  dataDir = mkdtempSync(join(tmpdir(), 'wf-phase3-e2e-'));
  database = await createPgliteDatabase(join(dataDir, 'db'));
  app = buildApp({
    database,
    // Sessions and the per-account rate limits run on the simulated clock, at their defaults.
    auth: { now: () => new Date(nowMs) },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: CAP, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await database?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

type UpgradeOutcome = Extract<ForgeOutcome, { action: 'upgrade' }>;
type AffixOutcome = Extract<ForgeOutcome, { action: 'reroll' | 'improve' }>;

const errorCode = (res: { json: <T>() => T }) => res.json<{ error: { code: string } }>().error.code;

describe('Phase 3 exit criteria', () => {
  it('loot filter → Legendary and set piece, locked → forge upgrades (failure, pity), reroll, improve → targeted contract → crypt tiers II and III → kept over capacity → audit and telemetry reconcile', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: CLASS_ID,
      email: 'seeker@graumark.test',
      displayName: 'Seeker',
      name: 'Ysolde',
      // Targeted Abbey contracts: the hero plans a ring.
      rewardSlot: (slots) => (slots.includes('ring') ? 'ring' : slots[0]),
    });
    const { api, keyed, base, state } = hero;
    expect(await hero.playPhase2(PHASE2_HOURS)).toBe(true);
    const phase2Hours = state.farmedHours;
    // From the Abbey on, the hero also works through its held contracts.
    state.followContracts = true;

    const seen = {
      filterSold: 0,
      legendary: null as ItemView | null,
      setPiece: null as ItemView | null,
      upgrades: 0,
      upgradeFailures: 0,
      pityGuarantees: 0,
      upgradeGold: 0,
      rerolled: false,
      improved: false,
      targeted: null as ItemView | null,
      overCapacity: 0,
      packAtOverCapacity: 0,
    };

    // 1. A loot filter: sell new drops below rare. The server stores it normalised.
    const rules = {
      action: 'sell',
      belowRarity: 'rare',
      wantedAffixes: [],
      wantedEffects: [],
      include: [],
    };
    const setFilter = await api('POST', `${base}/loot-filter`, { rules });
    expect(setFilter.statusCode, setFilter.body).toBe(200);
    expect(setFilter.json<{ active: boolean }>().active).toBe(true);
    expect((await api('GET', `${base}/loot-filter`)).json()).toEqual(setFilter.json());

    /** A Legendary or set piece is kept: locked, so no sale, salvage or discard can take it. */
    const lockValuable = async (item: ItemView) => {
      if (item.locked) return;
      const res = await api('POST', `${base}/items/${item.id}/lock`);
      expect(res.statusCode).toBe(200);
      if (item.equippedSlot !== null) return; // equipped items refuse sale anyway
      for (const r of [
        await keyed(`${base}/merchant/sell`, { itemIds: [item.id] }),
        await keyed(`${base}/forge/salvage`, { itemIds: [item.id] }),
        await api('DELETE', `${base}/items/${item.id}`),
      ]) {
        expect(r.statusCode).toBe(409);
        expect(errorCode(r)).toBe('item_locked');
      }
    };

    const forgeView = async (itemId: string) => {
      const res = await api('GET', `${base}/forge/items/${itemId}`);
      expect(res.statusCode).toBe(200);
      return res.json<ForgeItemResponse>().forge;
    };

    /** One paid upgrade attempt through the API, checked against the item's own stream. */
    const upgrade = async (itemId: string) => {
      const [row] = await database.db
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.id, itemId));
      // The test, not the player, reads the server-held secret: the outcome must be the one the
      // item's stream fixed before the request (no re-roll by retry, replay or timing).
      const predicted = attemptUpgrade(row!, createRng(`${row!.forgeSecret}:${row!.forgeCounter}`));
      const res = await keyed(`${base}/forge/upgrade`, { itemId });
      expect(res.statusCode, res.body).toBe(200);
      const { paid, ...body } = res.json<ForgeActionResponse>();
      const outcome = body.outcome as UpgradeOutcome;
      expect(outcome).toMatchObject({
        success: predicted.success,
        guaranteed: predicted.guaranteed,
        upgradeLevel: predicted.upgradeLevel,
        upgradePity: predicted.upgradePity,
      });
      seen.upgrades += 1;
      seen.upgradeGold += paid.gold;
      if (!outcome.success) seen.upgradeFailures += 1;
      // A pity success on a step that can fail (from +1 on; +0 → +1 is certain).
      if (outcome.success && outcome.guaranteed && outcome.fromLevel >= 1) {
        seen.pityGuarantees += 1;
      }
      return outcome;
    };

    /** The realistic player's sink: upgrade worn gear, lowest level first, while it can pay. */
    const upgradeWornGear = async (inv: InventoryView, maxAttempts = 12) => {
      for (let n = 0; n < maxAttempts; n++) {
        const worn = [...inv.equipped].sort((a, b) => a.upgradeLevel - b.upgradeLevel);
        let did = false;
        for (const item of worn) {
          const f = await forgeView(item.id);
          if (!f.upgrade || f.upgrade.blockers.length > 0) continue;
          await upgrade(item.id);
          did = true;
          break;
        }
        if (!did) return;
        inv = await hero.inventory();
      }
    };

    /**
     * If no pity success has come up naturally, plan one: for each worn item, replay its stream
     * (game-core, from the stored secret) until an attempt the pity makes certain, and take the
     * cheapest such path the hero can pay for. Returns false while none is affordable.
     */
    const forcePity = async (inv: InventoryView) => {
      const held = new Map<string, number>(
        (await api('GET', `${base}/materials`))
          .json<{ materials: { materialId: string; quantity: number }[] }>()
          .materials.map((m) => [m.materialId, m.quantity]),
      );
      const character = (await api('GET', `${base}/activity`)).json<{
        character: { gold: number };
      }>().character;
      let best: { itemId: string; attempts: number; gold: number } | null = null;
      for (const item of inv.equipped) {
        const [row] = await database.db
          .select()
          .from(itemInstances)
          .where(eq(itemInstances.id, item.id));
        let sim = { ...row! };
        let cost = 0;
        const mats = new Map<string, number>();
        for (let k = 0; k < 40; k++) {
          const quote = quoteUpgrade(sim);
          if (!quote.ok) break;
          cost += quote.value.cost.gold;
          for (const [m, q] of Object.entries(quote.value.cost.materials)) {
            mats.set(m, (mats.get(m) ?? 0) + (q ?? 0));
          }
          const out = attemptUpgrade(
            sim,
            createRng(`${row!.forgeSecret}:${row!.forgeCounter + k}`),
          );
          const pity = out.success && out.guaranteed && sim.upgradeLevel >= 1;
          sim = { ...sim, upgradeLevel: out.upgradeLevel, upgradePity: out.upgradePity };
          if (pity) {
            const affordable =
              cost <= character.gold && [...mats].every(([m, q]) => (held.get(m) ?? 0) >= q);
            if (affordable && (!best || cost < best.gold)) {
              best = { itemId: item.id, attempts: k + 1, gold: cost };
            }
            break;
          }
        }
      }
      if (!best) return false;
      for (let k = 0; k < best.attempts; k++) await upgrade(best.itemId);
      expect(seen.pityGuarantees).toBeGreaterThan(0);
      return true;
    };

    /** Reroll one affix and improve one, once each, on worn gear the hero can pay for. */
    const rerollAndImprove = async (inv: InventoryView) => {
      for (const item of inv.equipped) {
        if (seen.rerolled && seen.improved) return;
        const f = await forgeView(item.id);
        if (
          !seen.rerolled &&
          f.reroll &&
          f.reroll.blockers.length === 0 &&
          item.affixes.length > 1
        ) {
          const res = await keyed(`${base}/forge/reroll`, { itemId: item.id, affixIndex: 0 });
          expect(res.statusCode, res.body).toBe(200);
          const { item: after, ...body } = res.json<ForgeActionResponse>();
          const outcome = body.outcome as AffixOutcome;
          expect(outcome.affixIndex).toBe(0);
          expect(f.reroll.options[0]!.map((o) => o.affixId)).toContain(outcome.after.affixId);
          // Only the picked affix changed.
          expect(after.affixes.slice(1)).toEqual(item.affixes.slice(1));
          seen.rerolled = true;
          continue;
        }
        const open = f.improve.find((x) => x.refusal === null && x.blockers.length === 0);
        if (!seen.improved && open) {
          const res = await keyed(`${base}/forge/improve`, {
            itemId: item.id,
            affixIndex: open.index,
          });
          expect(res.statusCode, res.body).toBe(200);
          const outcome = res.json<ForgeActionResponse>().outcome as AffixOutcome;
          expect(outcome.after.value).toBeGreaterThanOrEqual(outcome.before.value);
          expect(outcome.after.value).toBeLessThanOrEqual(open.max);
          seen.improved = true;
        }
      }
    };

    const tierCleared = async () =>
      (await api('GET', `${base}/dungeon`)).json<DungeonStateResponse>().dungeons[0]!.tierCleared;

    // 2. Play on. Each visit: settle, equip, keep valuables, town, Tavern, Forge, crypt, move on.
    let lastTierRunLevel = { 2: 0, 3: 0 };
    let filling = false;
    while (state.farmedHours < MAX_HOURS) {
      const { summary } = await hero.settle();
      if (summary.filtered) {
        seen.filterSold += summary.filtered.sold;
        // The filter acted on this visit's drops: none it should sell was kept.
        expect(summary.items.every((i) => !['common', 'uncommon'].includes(i.rarityId))).toBe(true);
      }
      if ((summary.itemsOverCapacity ?? 0) > 0) {
        seen.overCapacity += summary.itemsOverCapacity!;
        // Right after the settle (before any equip moves worn items back into the pack): the
        // pack holds more than its capacity, and the surplus is valuable (B.2).
        const pack = (await hero.inventory()).inventory;
        expect(pack.length).toBeGreaterThan(CAPACITY);
        expect(pack.filter(isValuable).length).toBeGreaterThanOrEqual(pack.length - CAPACITY);
        seen.packAtOverCapacity = Math.max(pack.length, seen.packAtOverCapacity);
      }

      let inv = await hero.equipBetterDrops();
      for (const item of [...inv.equipped, ...inv.inventory]) {
        // A Legendary proper (with its effect); set pieces are Legendary-rarity too.
        if (!seen.legendary && item.rarityId === 'legendary' && item.setId === null) {
          seen.legendary = item;
        }
        if (!seen.setPiece && item.setId !== null) seen.setPiece = item;
      }
      for (const item of [seen.legendary, seen.setPiece]) {
        if (item && !item.locked) {
          await lockValuable(item);
          item.locked = true;
        }
      }
      await hero.sellJunk(await hero.inventory());
      await hero.visitTavern();
      seen.targeted ??=
        state.turnedIn.find((q) => q.kind === 'contract' && q.item !== null)?.item ?? null;

      // The Forge: reroll and improve once, then the upgrade sink (or a planned pity path).
      inv = await hero.inventory();
      await rerollAndImprove(inv);
      if (seen.pityGuarantees > 0 || state.level < 20) await upgradeWornGear(inv);
      else await forcePity(inv);

      // The deeper crypt: one attempt per level from each tier's entry level.
      const cleared = await tierCleared();
      const tier =
        cleared === 1 && state.level >= 18 ? 2 : cleared === 2 && state.level >= 21 ? 3 : 0;
      if (tier && state.level > lastTierRunLevel[tier as 2 | 3]) {
        lastTierRunLevel = { ...lastTierRunLevel, [tier]: state.level };
        const result = await hero.runCrypt(tier);
        expect(result.tier).toBe(tier);
        await hero.visitTavern();
        await hero.resumeFarming();
      }
      await hero.farmBestArea();

      const done =
        seen.filterSold > 0 &&
        seen.legendary &&
        seen.setPiece &&
        seen.pityGuarantees > 0 &&
        seen.rerolled &&
        seen.improved &&
        seen.targeted &&
        (await tierCleared()) >= 3;
      // 3. Last: stop tidying and drop the filter, so the pack fills and the next valuable drop
      // has no room: B.2 keeps it beyond the capacity instead of salvaging it.
      if (done && !filling) {
        filling = true;
        state.tidy = false;
        const off = await api('POST', `${base}/loot-filter`, { rules: null });
        expect(off.json<{ active: boolean }>().active).toBe(false);
      }
      if (filling && seen.overCapacity > 0) break;
    }
    expect(
      state.farmedHours,
      JSON.stringify({
        ...seen,
        legendary: !!seen.legendary,
        setPiece: !!seen.setPiece,
        level: state.level,
        crypt: state.crypt.filter((c) => c.tier > 1),
        quests: (await hero.board()).quests.map((q) => [q.questId, q.progress, q.objectives]),
      }),
    ).toBeLessThan(MAX_HOURS);

    // 4. What the run found and did.
    expect(seen.filterSold).toBeGreaterThan(0);
    expect(seen.legendary?.rarityId).toBe('legendary');
    expect(seen.legendary?.effectId).not.toBeNull();
    expect(seen.setPiece?.setId).not.toBeNull();
    expect(seen.upgradeFailures).toBeGreaterThan(0);
    expect(seen.pityGuarantees).toBeGreaterThan(0);
    expect(seen.targeted?.rarityId).toBe('epic');
    expect(findItemBase(seen.targeted!.baseId)?.slot).toBe('ring');
    const tiers = state.crypt.filter((c) => c.bossDefeated).map((c) => c.tier);
    expect(tiers).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(seen.overCapacity).toBeGreaterThan(0);
    expect(seen.packAtOverCapacity).toBeGreaterThan(CAPACITY);
    const full = await hero.inventory();
    // The locked finds survived every tidy-up.
    const all = [...full.equipped, ...full.inventory];
    for (const item of [seen.legendary!, seen.setPiece!]) {
      expect(all.find((i) => i.id === item.id)?.locked).toBe(true);
    }
    // Back under capacity: a tidy-up sells the junk (never the locked or valuable items).
    state.tidy = true;
    await hero.sellJunk(full);
    const tidy = await hero.inventory();
    for (const item of [seen.legendary!, seen.setPiece!]) {
      expect([...tidy.equipped, ...tidy.inventory].some((i) => i.id === item.id)).toBe(true);
    }

    // 5. Everything held is accounted for by exactly one audit entry.
    const { row, events } = await expectHoldingsMatchAudit(database, hero.characterId);
    expect(events['forge.upgrade']).toBe(seen.upgrades);
    expect(events['loot_filter.update']).toBe(2);
    const quests = await database.db
      .select()
      .from(itemInstances)
      .where(
        and(eq(itemInstances.characterId, hero.characterId), eq(itemInstances.source, 'quest')),
      );
    expect(quests.length).toBeGreaterThan(0);

    // 6. Telemetry: the real report command reconciles the rollups with the audit log on this
    // run's database, and measures what was seen here.
    await app.close();
    await database.close();
    const out = join(dataDir, 'report.json');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PLAYTEST_DATA_DIR: dataDir,
      INIT_CWD: REPO_ROOT,
    };
    delete env.DATABASE_URL;
    const text = execFileSync(
      'pnpm',
      ['--silent', 'report:telemetry', '--', '--reconcile', '--db', 'playtest', '--out', out],
      { cwd: REPO_ROOT, env, encoding: 'utf8' },
    );
    expect(text).toMatch(/Audit log reconciliation: all \d+ checks match/);
    const report = JSON.parse(readFileSync(out, 'utf8')) as TelemetryReport;
    expect(report.reconcile!.length).toBeGreaterThan(0);
    expect(report.reconcile!.filter((c) => !c.ok)).toEqual([]);
    const sum = (
      metric: string,
      match: (d: RollupRow['dims']) => boolean,
      field: 'events' | 'amount' = 'events',
    ) =>
      report.rollups
        .filter((r) => r.metric === metric && match(r.dims))
        .reduce((s, r) => s + r[field], 0);
    expect(sum('item.drop', (d) => d[2] === 'legendary')).toBeGreaterThan(0);
    expect(sum('item.set', () => true)).toBeGreaterThan(0);
    expect(sum('forge', (d) => d[0] === 'upgrade')).toBe(seen.upgrades);
    expect(sum('gold.out', (d) => d[0] === 'forge_upgrade', 'amount')).toBe(seen.upgradeGold);
    expect(sum('item.fate', (d) => d[1] === 'kept_over_capacity')).toBeGreaterThanOrEqual(
      seen.overCapacity,
    );

    // For the record (docs/ROADMAP.md, Phase 3 retrospective); `E2E_RECORD=file` appends it.
    const record = JSON.stringify({
      phase2Hours,
      farmedHours: state.farmedHours,
      level: row.level,
      deaths: state.deaths,
      crypt: state.crypt.filter((c) => c.tier > 1),
      upgrades: seen.upgrades,
      failures: seen.upgradeFailures,
      pity: seen.pityGuarantees,
      upgradeGold: seen.upgradeGold,
      filterSold: seen.filterSold,
      overCapacity: seen.overCapacity,
    });
    console.info(record);
    if (process.env.E2E_RECORD) appendFileSync(process.env.E2E_RECORD, `${CLASS_ID} ${record}\n`);
  }, 600_000);
});
