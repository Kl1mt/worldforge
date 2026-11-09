import { sql } from 'drizzle-orm';
import {
  TRADE_CAPS,
  TRADE_PATTERN_RULES,
  actionableRoles,
  mailboxKey,
  tradeAccountFlags,
  tradePairFlags,
  type AccountRole,
  type TradeAccountFlag,
  type TradeCapMetric,
  type TradeFlow,
  type TradePairFlag,
} from '@worldforge/game-core';
import type { Executor } from '../db/types.js';
import { queryRows } from '../db/query.js';
import { loadTradingSettings } from '../settings/store.js';

/**
 * The trade pattern report (ticket T.6, docs/TRADING.md "7. What can't be prevented, only
 * detected" and "T.6 as built"), for the moderators' panel (`GET /api/mod/trading/patterns`) and
 * `pnpm admin:trading patterns`. Read-only and aggregate: completed trades in a window, grouped by
 * pair and by account, with game-core's flags (`TRADE_PATTERN_RULES`):
 * - pairs: one-way flows, pairs that only trade with each other, the same invite, the same
 *   sign-up mailbox (5.6's `mailboxKey` of the stored email, compared here and never output);
 * - accounts: new accounts receiving a lot, weekly caps reached in several weeks (T.4's
 *   counters), unprovenanced items offered (`trade.flag`), repeated reversals;
 * - invite clusters: accounts from one invite that traded with each other.
 * Only data the server already has; players appear by handle and display name. A viewer sees only
 * rows they may act on (below their role, never their own); the command (no viewer) sees all.
 */

export interface PatternWho {
  handle: string;
  displayName: string;
  role: AccountRole;
}

export interface TradePatternPair {
  a: PatternWho;
  b: PatternWho;
  trades: number;
  aToB: TradeFlow;
  bToA: TradeFlow;
  reversed: number;
  firstOn: string;
  lastOn: string;
  flags: TradePairFlag[];
}

export interface TradePatternAccount {
  who: PatternWho;
  trades: number;
  partners: number;
  given: TradeFlow;
  received: TradeFlow;
  receivedWhileNew: TradeFlow;
  accountAgeDays: number;
  weeksAtCap: number;
  capsReached: TradeCapMetric[];
  flaggedItems: number;
  reversals: number;
  flags: TradeAccountFlag[];
}

export interface TradeInviteCluster {
  members: PatternWho[];
  trades: number;
}

export interface TradePatternReport {
  windowDays: number;
  rules: typeof TRADE_PATTERN_RULES;
  totals: { trades: number; reversed: number; flaggedItems: number };
  pairs: TradePatternPair[];
  accounts: TradePatternAccount[];
  inviteClusters: TradeInviteCluster[];
}

interface TradeRow extends Record<string, unknown> {
  s: string;
  r: string;
  closed_at: string | Date;
  reversed: boolean;
  gi: number;
  gg: number | string;
  gm: number | string;
  ai: number;
  ag: number | string;
  am: number | string;
}

const DAY_MS = 86_400_000;
const zero = (): TradeFlow => ({ items: 0, gold: 0, materialUnits: 0 });
const add = (f: TradeFlow, items: number, gold: number, m: number) => {
  f.items += items;
  f.gold += gold;
  f.materialUnits += m;
};
const day = (d: string | Date) => new Date(d).toISOString().slice(0, 10);

export async function tradePatterns(
  db: Executor,
  viewer: { id: string; role: AccountRole } | null,
  now: Date,
  days: number = TRADE_PATTERN_RULES.windowDays,
  limit = 50,
): Promise<TradePatternReport> {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const trades = (
    await queryRows<TradeRow>(
      db,
      sql`select o.sender_account_id as s, o.receiver_account_id as r, o.closed_at,
          (o.reversed_at is not null) as reversed,
          count(*) filter (where l.side = 'give' and l.kind = 'item')::int as gi,
          coalesce(sum(l.amount) filter (where l.side = 'give' and l.kind = 'gold'), 0) as gg,
          coalesce(sum(l.amount) filter (where l.side = 'give' and l.kind = 'material'), 0) as gm,
          count(*) filter (where l.side = 'ask' and l.kind = 'item')::int as ai,
          coalesce(sum(l.amount) filter (where l.side = 'ask' and l.kind = 'gold'), 0) as ag,
          coalesce(sum(l.amount) filter (where l.side = 'ask' and l.kind = 'material'), 0) as am
        from trade_offers o
        left join trade_offer_lines l on l.offer_id = o.id
        where o.status = 'accepted' and o.closed_at > ${since}::timestamptz
        group by o.id`,
    )
  ).map((t) => ({
    ...t,
    gg: Number(t.gg),
    gm: Number(t.gm),
    ag: Number(t.ag),
    am: Number(t.am),
    gi: Number(t.gi),
    ai: Number(t.ai),
  }));
  const reversals = await queryRows<{ s: string; r: string }>(
    db,
    sql`select sender_account_id as s, receiver_account_id as r from trade_offers
        where reversed_at > ${since}::timestamptz`,
  );
  const flags = await queryRows<{ account_id: string; n: number }>(
    db,
    sql`select account_id, count(*)::int as n from audit_log
        where event = 'trade.flag' and created_at > ${since}::timestamptz and account_id is not null
        group by account_id`,
  );
  const counters = await queryRows<{
    account_id: string;
    window_start: string | Date;
    metric: TradeCapMetric;
    amount: number | string;
  }>(
    db,
    sql`select account_id, window_start, metric, amount from trade_counters
        where period = 'week' and window_start > ${new Date(now.getTime() - (days + 7) * DAY_MS).toISOString()}::timestamptz`,
  );
  const limits = (await loadTradingSettings(db)).limits;

  const ids = new Set<string>();
  for (const t of trades) ids.add(t.s).add(t.r);
  for (const r of reversals) ids.add(r.s).add(r.r);
  for (const f of flags) ids.add(f.account_id);
  for (const c of counters) ids.add(c.account_id);
  const people =
    ids.size === 0
      ? []
      : await queryRows<{
          id: string;
          handle: string;
          display_name: string;
          role: AccountRole;
          email: string;
          created_at: string | Date;
          invite_id: string | null;
        }>(
          db,
          sql`select a.id, a.handle, a.display_name, a.role, a.email, a.created_at,
              (select l.data->>'inviteId' from audit_log l
                where l.account_id = a.id and l.event = 'account.register' limit 1) as invite_id
            from accounts a where a.id in (${sql.join(
              [...ids].map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`,
        );
  const byId = new Map(people.map((p) => [p.id, p]));
  // Server-side only: the mailbox key and the invite id are compared here, never returned.
  const mailbox = new Map(people.map((p) => [p.id, mailboxKey(p.email)]));
  const whoOf = (id: string): PatternWho => {
    const p = byId.get(id);
    return {
      handle: p?.handle ?? '',
      displayName: p?.display_name ?? '',
      role: p?.role ?? 'player',
    };
  };

  // Per pair and per account.
  interface PairAcc {
    a: string;
    b: string;
    trades: number;
    aToB: TradeFlow;
    bToA: TradeFlow;
    reversed: number;
    first: number;
    last: number;
  }
  const pairs = new Map<string, PairAcc>();
  interface AccountAcc {
    trades: number;
    partners: Set<string>;
    given: TradeFlow;
    received: TradeFlow;
    receivedWhileNew: TradeFlow;
  }
  const acc = new Map<string, AccountAcc>();
  const accOf = (id: string) => {
    let x = acc.get(id);
    if (!x) {
      x = {
        trades: 0,
        partners: new Set(),
        given: zero(),
        received: zero(),
        receivedWhileNew: zero(),
      };
      acc.set(id, x);
    }
    return x;
  };
  const isNew = (id: string, at: number) => {
    const created = byId.get(id)?.created_at;
    return (
      created !== undefined &&
      at - new Date(created).getTime() < TRADE_PATTERN_RULES.newAccountDays * DAY_MS
    );
  };
  for (const t of trades) {
    const [a, b] = t.s < t.r ? [t.s, t.r] : [t.r, t.s];
    const key = `${a}:${b}`;
    const at = new Date(t.closed_at).getTime();
    let p = pairs.get(key);
    if (!p) {
      p = { a, b, trades: 0, aToB: zero(), bToA: zero(), reversed: 0, first: at, last: at };
      pairs.set(key, p);
    }
    p.trades += 1;
    if (t.reversed) p.reversed += 1;
    p.first = Math.min(p.first, at);
    p.last = Math.max(p.last, at);
    // The sender's give side flows sender → receiver; the ask side the other way.
    const sToR = t.s === a ? p.aToB : p.bToA;
    const rToS = t.s === a ? p.bToA : p.aToB;
    add(sToR, t.gi, t.gg, t.gm);
    add(rToS, t.ai, t.ag, t.am);
    const s = accOf(t.s);
    const r = accOf(t.r);
    s.trades += 1;
    r.trades += 1;
    s.partners.add(t.r);
    r.partners.add(t.s);
    add(s.given, t.gi, t.gg, t.gm);
    add(r.received, t.gi, t.gg, t.gm);
    add(r.given, t.ai, t.ag, t.am);
    add(s.received, t.ai, t.ag, t.am);
    if (isNew(t.r, at)) add(r.receivedWhileNew, t.gi, t.gg, t.gm);
    if (isNew(t.s, at)) add(s.receivedWhileNew, t.ai, t.ag, t.am);
  }
  const reversalsOf = new Map<string, number>();
  for (const r of reversals) {
    for (const id of [r.s, r.r]) reversalsOf.set(id, (reversalsOf.get(id) ?? 0) + 1);
  }
  const flaggedOf = new Map(flags.map((f) => [f.account_id, Number(f.n)]));
  const capWeeks = new Map<string, Set<string>>();
  const capMetrics = new Map<string, Set<TradeCapMetric>>();
  for (const c of counters) {
    const info = TRADE_CAPS[c.metric];
    if (!info || info.period !== 'week') continue;
    const max = limits[info.limit];
    if (!(max > 0) || Number(c.amount) < max) continue;
    let w = capWeeks.get(c.account_id);
    if (!w) capWeeks.set(c.account_id, (w = new Set()));
    w.add(day(c.window_start));
    let m = capMetrics.get(c.account_id);
    if (!m) capMetrics.set(c.account_id, (m = new Set()));
    m.add(c.metric);
  }

  const actionable = viewer ? new Set<AccountRole>(actionableRoles(viewer.role)) : null;
  const visible = (id: string) =>
    !viewer || (id !== viewer.id && actionable!.has(byId.get(id)?.role ?? 'admin'));
  const notViewer = (id: string) => !viewer || id !== viewer.id;

  const pairViews: TradePatternPair[] = [];
  for (const p of pairs.values()) {
    if (!notViewer(p.a) || !notViewer(p.b) || (!visible(p.a) && !visible(p.b))) continue;
    const pa = byId.get(p.a);
    const pb = byId.get(p.b);
    const f = tradePairFlags({
      trades: p.trades,
      aToB: p.aToB,
      bToA: p.bToA,
      partnersA: acc.get(p.a)?.partners.size ?? 0,
      partnersB: acc.get(p.b)?.partners.size ?? 0,
      sameInvite: !!pa?.invite_id && pa.invite_id === pb?.invite_id,
      sameMailbox: !!pa && !!pb && mailbox.get(p.a) === mailbox.get(p.b),
    });
    if (f.length === 0 && p.trades < TRADE_PATTERN_RULES.minPairTrades) continue;
    pairViews.push({
      a: whoOf(p.a),
      b: whoOf(p.b),
      trades: p.trades,
      aToB: p.aToB,
      bToA: p.bToA,
      reversed: p.reversed,
      firstOn: day(new Date(p.first)),
      lastOn: day(new Date(p.last)),
      flags: f,
    });
  }
  pairViews.sort(
    (x, y) =>
      y.flags.length - x.flags.length ||
      y.trades - x.trades ||
      x.a.handle.localeCompare(y.a.handle) ||
      x.b.handle.localeCompare(y.b.handle),
  );

  const accountViews: TradePatternAccount[] = [];
  for (const id of ids) {
    if (!visible(id)) continue;
    const a = acc.get(id);
    const facts = {
      receivedWhileNew: a?.receivedWhileNew ?? zero(),
      weeksAtCap: capWeeks.get(id)?.size ?? 0,
      flaggedItems: flaggedOf.get(id) ?? 0,
      reversals: reversalsOf.get(id) ?? 0,
    };
    const f = tradeAccountFlags(facts);
    if (f.length === 0) continue;
    const created = byId.get(id)?.created_at;
    accountViews.push({
      who: whoOf(id),
      trades: a?.trades ?? 0,
      partners: a?.partners.size ?? 0,
      given: a?.given ?? zero(),
      received: a?.received ?? zero(),
      ...facts,
      accountAgeDays: created
        ? Math.floor((now.getTime() - new Date(created).getTime()) / DAY_MS)
        : 0,
      capsReached: [...(capMetrics.get(id) ?? [])].sort(),
      flags: f,
    });
  }
  accountViews.sort(
    (x, y) =>
      y.flags.length - x.flags.length ||
      y.trades - x.trades ||
      x.who.handle.localeCompare(y.who.handle),
  );

  // Invite clusters: accounts of one invite joined by trades among themselves.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const clusterTrades = new Map<string, number>();
  for (const p of pairs.values()) {
    const ia = byId.get(p.a)?.invite_id;
    if (!ia || ia !== byId.get(p.b)?.invite_id) continue;
    parent.set(find(p.a), find(p.b));
  }
  for (const p of pairs.values()) {
    const ia = byId.get(p.a)?.invite_id;
    if (!ia || ia !== byId.get(p.b)?.invite_id) continue;
    const root = find(p.a);
    clusterTrades.set(root, (clusterTrades.get(root) ?? 0) + p.trades);
  }
  const members = new Map<string, string[]>();
  for (const x of parent.keys()) {
    const root = find(x);
    const list = members.get(root) ?? [];
    if (!list.includes(x)) list.push(x);
    members.set(root, list);
  }
  for (const [root, list] of members) if (!list.includes(root)) list.push(root);
  const inviteClusters: TradeInviteCluster[] = [...members.entries()]
    .filter(
      ([, list]) =>
        list.length >= TRADE_PATTERN_RULES.inviteClusterAccounts &&
        list.every(notViewer) &&
        list.some(visible),
    )
    .map(([root, list]) => ({
      members: list.map(whoOf).sort((x, y) => x.handle.localeCompare(y.handle)),
      trades: clusterTrades.get(root) ?? 0,
    }))
    .sort((x, y) => y.members.length - x.members.length || y.trades - x.trades);

  return {
    windowDays: days,
    rules: TRADE_PATTERN_RULES,
    totals: {
      trades: trades.length,
      reversed: reversals.length,
      flaggedItems: flags.reduce((n, f) => n + Number(f.n), 0),
    },
    pairs: pairViews.slice(0, limit),
    accounts: accountViews.slice(0, limit),
    inviteClusters: inviteClusters.slice(0, limit),
  };
}

const flow = (f: TradeFlow) =>
  `${f.items} item${f.items === 1 ? '' : 's'}, ${f.gold} gold, ${f.materialUnits} material units`;

/** Plain text of the report (the command). Handles and display names only. */
export function formatTradePatterns(r: TradePatternReport): string {
  const name = (w: PatternWho) =>
    `${w.displayName} (${w.handle}${w.role !== 'player' ? `, ${w.role}` : ''})`;
  const lines = [
    `Trade patterns, last ${r.windowDays} days: ${r.totals.trades} completed trades, ${r.totals.reversed} reversed, ${r.totals.flaggedItems} unprovenanced items flagged.`,
  ];
  lines.push('', `Pairs (${r.pairs.length}):`);
  if (r.pairs.length === 0) lines.push('  none');
  for (const p of r.pairs) {
    lines.push(
      `  ${name(p.a)} and ${name(p.b)}: ${p.trades} trades ${p.firstOn}–${p.lastOn}${p.reversed ? `, ${p.reversed} reversed` : ''}${p.flags.length ? ` [${p.flags.join(', ')}]` : ''}`,
      `    ${p.a.displayName} gave ${flow(p.aToB)}; ${p.b.displayName} gave ${flow(p.bToA)}`,
    );
  }
  lines.push('', `Accounts (${r.accounts.length}):`);
  if (r.accounts.length === 0) lines.push('  none');
  for (const a of r.accounts) {
    lines.push(
      `  ${name(a.who)}: ${a.trades} trades with ${a.partners} partners, account ${a.accountAgeDays} days old [${a.flags.join(', ')}]`,
      `    received ${flow(a.received)} (while new: ${flow(a.receivedWhileNew)}); gave ${flow(a.given)}; weeks at a cap ${a.weeksAtCap}${a.capsReached.length ? ` (${a.capsReached.join(', ')})` : ''}; flagged items ${a.flaggedItems}; reversals ${a.reversals}`,
    );
  }
  lines.push('', `Invite clusters (${r.inviteClusters.length}):`);
  if (r.inviteClusters.length === 0) lines.push('  none');
  for (const c of r.inviteClusters) {
    lines.push(`  ${c.members.map(name).join(', ')}: ${c.trades} trades among them`);
  }
  return lines.join('\n');
}
