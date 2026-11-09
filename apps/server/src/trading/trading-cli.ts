// `pnpm admin:trading patterns [--days N] [--json]` (ticket T.6, docs/TRADING.md "T.6 as built",
// docs/DEPLOY.md): the trade pattern report on the server, the same as the moderators' panel but
// unfiltered (every account, staff included). Players appear by handle and display name; no
// emails, ids or invite codes are printed. Read-only. Uses DATABASE_URL, else (outside
// production) the playtest database. In production: `deploy/admin.sh trading patterns`.
import { TRADE_PATTERN_RULES } from '@worldforge/game-core';
import { loadConfig } from '../config.js';
import { openCliDatabase } from '../db/cli-database.js';
import { formatTradePatterns, tradePatterns } from './patterns.js';

const USAGE = `Usage:
  pnpm admin:trading patterns [--days N] [--json]   (the trade pattern report; N 1–${TRADE_PATTERN_RULES.maxWindowDays}, default ${TRADE_PATTERN_RULES.windowDays})`;

/** Parses the command line; null when it is not a valid command. Exported for tests. */
export function parseTradingArgs(argv: readonly string[]): { days: number; json: boolean } | null {
  const [command, ...rest] = argv;
  if (command !== 'patterns') return null;
  let days: number = TRADE_PATTERN_RULES.windowDays;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') json = true;
    else if (arg === '--days') {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 1 || n > TRADE_PATTERN_RULES.maxWindowDays) return null;
      days = n;
    } else return null;
  }
  return { days, json };
}

const isMain =
  process.argv[1]?.endsWith('trading-cli.ts') || process.argv[1]?.endsWith('trading-cli.js');
if (isMain) {
  const args = parseTradingArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    process.exit(2);
  }
  const config = loadConfig();
  let cli: Awaited<ReturnType<typeof openCliDatabase>>;
  try {
    cli = await openCliDatabase(config.databaseUrl);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  try {
    const report = await tradePatterns(cli.database.db, null, new Date(), args.days, 200);
    console.log(args.json ? JSON.stringify(report, null, 2) : formatTradePatterns(report));
  } catch (err) {
    console.error('Trading command failed:', err);
    process.exitCode = 1;
  } finally {
    await cli.close();
  }
}
