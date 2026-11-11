import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { count, desc, eq } from 'drizzle-orm';
import {
  GAME_VERSION,
  TRADE_CATEGORIES,
  normaliseTradingSettings,
  switchInForce,
  type FormulaSwitch,
  type TradingSettings,
} from '@worldforge/game-core';
import { accounts, auditLog, gameSettings, reservedNames } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import type { Mailer } from '../mail/mailer.js';
import { listSeasons, currentAndNext } from '../seasons/model.js';
import { listEvents, currentAndNextEvent } from '../events/model.js';
import { loadFormulaSchedule } from '../leaderboards/formulas.js';
import { TEMPLATE_MARKER } from '../legal/routes.js';
import type { BuildInfo } from './status.js';

/**
 * The going-live readiness board (ticket 8.6, docs/GOING_LIVE.md): what the live town still needs,
 * one item per step of the owner's checklist. **Read-only**: nothing here changes the game, and
 * the only writes on the tab are the privacy checklist's ticks and the test letter (both in
 * `readiness-routes.ts`).
 *
 * **No secrets leave the server:** the mail item says which transport is in use, never the host,
 * user, password or sender; the legal item says whether the owner's files exist (and whether they
 * still carry the template marker), never what they say; the backup item reads a status file
 * holding a timestamp and a size only. The response is built from fixed fields, so nothing from
 * the environment can slip in.
 */

export type ReadinessStatus = 'done' | 'attention' | 'not_set';

/** Where an item is fixed: an admin tab, or a section of the repository's docs. */
export type ReadinessLink =
  | { kind: 'tab'; section: string; label: string }
  | { kind: 'doc'; path: string; anchor: string; label: string };

export interface ReadinessItem {
  id: ReadinessItemId;
  title: string;
  status: ReadinessStatus;
  /** One or two plain sentences: what the state means and what to do. */
  summary: string;
  /** Short facts (label and value), never a secret. */
  facts: { label: string; value: string }[];
  links: ReadinessLink[];
}

export const READINESS_ITEMS = [
  'email',
  'privacy',
  'reservedNames',
  'testAccounts',
  'season',
  'event',
  'trading',
  'backups',
  'deploy',
  'sharedState',
] as const;
export type ReadinessItemId = (typeof READINESS_ITEMS)[number];

const doc = (path: string, anchor: string, label: string): ReadinessLink => ({
  kind: 'doc',
  path,
  anchor,
  label,
});
const tab = (section: string, label: string): ReadinessLink => ({ kind: 'tab', section, label });

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ---- Email ----------------------------------------------------------------------------------

export interface TestLetterRecord {
  at: Date;
  outcome: 'sent' | 'failed';
}

export function emailItem(mailer: Mailer, last: TestLetterRecord | null): ReadinessItem {
  const facts: ReadinessItem['facts'] = [
    {
      label: 'Transport',
      value:
        mailer.transport === 'smtp'
          ? 'SMTP (your provider)'
          : mailer.transport === 'log'
            ? 'Development log (letters are printed, not sent)'
            : mailer.transport === 'memory'
              ? 'Test capture (letters are kept in memory, not sent)'
              : 'None',
    },
    {
      label: 'Last test letter',
      value: last
        ? `${last.outcome === 'sent' ? 'Sent' : 'Failed'} · ${last.at.toISOString()}`
        : 'Never sent',
    },
  ];
  const links = [doc('docs/DEPLOY.md', 'email', 'DEPLOY.md · Email')];
  if (mailer.transport === 'none') {
    return {
      id: 'email',
      title: 'Email (SMTP)',
      status: 'not_set',
      summary:
        'No mail provider is set up: players can’t verify their address or reset a password, and trading (which needs a verified address) can’t open. Put the SMTP settings in deploy/.env and redeploy.',
      facts,
      links,
    };
  }
  if (mailer.transport !== 'smtp') {
    return {
      id: 'email',
      title: 'Email (SMTP)',
      status: 'attention',
      summary:
        'This server is not sending real mail (development or test). On the live server, set the SMTP settings in deploy/.env.',
      facts,
      links,
    };
  }
  const ok = last?.outcome === 'sent';
  return {
    id: 'email',
    title: 'Email (SMTP)',
    status: ok ? 'done' : 'attention',
    summary: ok
      ? 'Mail is set up and the last test letter was sent. Check that it reached the inbox, not the spam folder.'
      : last
        ? 'Mail is set up, but the last test letter failed. Check the SMTP settings and the provider’s activity log, then send another.'
        : 'Mail is set up. Send a test letter to your own address to check it really arrives.',
    facts,
    links,
  };
}

// ---- Privacy policy -------------------------------------------------------------------------

/** What the privacy policy must mention (DEPLOY.md "Email", the Phase 5 and 6 open items). */
export const PRIVACY_CHECKLIST = [
  {
    id: 'leaderboards',
    label: 'Public leaderboards',
    hint: 'Every player is listed by display name on the public boards, with no opt-out.',
  },
  {
    id: 'emails',
    label: 'Verification and reset emails',
    hint: 'What is mailed (verification, password reset, account notices) and that the address is used only for the account.',
  },
  {
    id: 'provider',
    label: 'The mail provider',
    hint: 'The provider by name, as a processor (sign its data processing agreement).',
  },
  {
    id: 'trading',
    label: 'Trading',
    hint: 'Trades are kept in a history staff can review, and checked for patterns of abuse.',
  },
  {
    id: 'events',
    label: 'Events and cosmetics',
    hint: 'Event participation and the cosmetics players earn are stored with the account.',
  },
  {
    id: 'testAccounts',
    label: 'Test accounts',
    hint: 'Staff test accounts exist and are left out of boards, rankings and statistics.',
  },
] as const;
export type PrivacyCheckId = (typeof PRIVACY_CHECKLIST)[number]['id'];
export const PRIVACY_CHECK_IDS = PRIVACY_CHECKLIST.map((c) => c.id) as PrivacyCheckId[];

export const PRIVACY_SETTINGS_KEY = 'readiness.privacy';

export interface PrivacyTicks {
  ticked: PrivacyCheckId[];
  version: number;
  updatedAt: Date | null;
}

/** A stored value as ticks: unknown ids are dropped, order follows the checklist. */
export function normalisePrivacyTicks(value: unknown): PrivacyCheckId[] {
  const raw =
    value && typeof value === 'object' && Array.isArray((value as { ticked?: unknown }).ticked)
      ? ((value as { ticked: unknown[] }).ticked as unknown[])
      : [];
  return PRIVACY_CHECK_IDS.filter((id) => raw.includes(id));
}

export async function loadPrivacyTicks(db: Executor): Promise<PrivacyTicks> {
  const [row] = await db
    .select()
    .from(gameSettings)
    .where(eq(gameSettings.key, PRIVACY_SETTINGS_KEY));
  return {
    ticked: normalisePrivacyTicks(row?.value),
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** The owner's legal files: present or not, and whether still the unfilled template. */
export interface LegalFileState {
  page: 'impressum' | 'datenschutz';
  present: boolean;
  /** The file still starts with the template marker (not filled in yet). Never its content. */
  template: boolean;
}

export async function legalFileStates(dir: string | undefined): Promise<LegalFileState[]> {
  const pages = ['impressum', 'datenschutz'] as const;
  return Promise.all(
    pages.map(async (page) => {
      if (!dir) return { page, present: false, template: false };
      try {
        const text = await readFile(join(dir, `${page}.md`), 'utf8');
        return { page, present: true, template: text.includes(TEMPLATE_MARKER) };
      } catch {
        return { page, present: false, template: false };
      }
    }),
  );
}

export function privacyItem(files: LegalFileState[], ticks: PrivacyTicks): ReadinessItem {
  const policy = files.find((f) => f.page === 'datenschutz')!;
  const imprint = files.find((f) => f.page === 'impressum')!;
  const fileWord = (f: LegalFileState) =>
    !f.present
      ? 'Missing (the template is shown)'
      : f.template
        ? 'Present, still the template'
        : 'Present';
  const filled = policy.present && !policy.template && imprint.present && !imprint.template;
  const all = ticks.ticked.length === PRIVACY_CHECKLIST.length;
  const status: ReadinessStatus =
    filled && all
      ? 'done'
      : !policy.present && !imprint.present && ticks.ticked.length === 0
        ? 'not_set'
        : 'attention';
  const summary =
    status === 'done'
      ? 'Your own Impressum and privacy policy are in place, and you ticked off every feature the policy must mention.'
      : !filled
        ? 'Put your own impressum.md and datenschutz.md in deploy/legal/ on the server (delete the template line at the top), then tick off what the policy mentions.'
        : 'Your files are in place. Tick off each feature below once the privacy policy mentions it.';
  return {
    id: 'privacy',
    title: 'Privacy policy',
    status,
    summary,
    facts: [
      { label: 'Impressum', value: fileWord(imprint) },
      { label: 'Privacy policy', value: fileWord(policy) },
      { label: 'Mentioned', value: `${ticks.ticked.length} of ${PRIVACY_CHECKLIST.length}` },
    ],
    links: [doc('docs/DEPLOY.md', 'legal-pages', 'DEPLOY.md · Legal pages')],
  };
}

// ---- Season 1 -------------------------------------------------------------------------------

export interface SeasonFacts {
  current: { number: number; startsAt: Date; endsAt: Date } | null;
  next: { number: number; startsAt: Date; endsAt: Date } | null;
  /** Seasons that have ended. */
  past: number;
  /** Formula switches still waiting for a season's end. */
  waiting: FormulaSwitch[];
}

const METRIC_LABEL: Record<string, string> = {
  level: 'Character Level',
  gearScore: 'Gear Score',
  power: 'Power',
  pveProgress: 'PvE Progress',
};

export function seasonItem(s: SeasonFacts): ReadinessItem {
  const facts: ReadinessItem['facts'] = [];
  if (s.current)
    facts.push({
      label: 'Under way',
      value: `Season ${s.current.number}, ends ${s.current.endsAt.toISOString()}`,
    });
  if (s.next)
    facts.push({
      label: 'Next',
      value: `Season ${s.next.number}, starts ${s.next.startsAt.toISOString()}`,
    });
  facts.push({ label: 'Ended', value: String(s.past) });
  for (const w of s.waiting) {
    facts.push({
      label: 'Board formula waiting',
      value: `${METRIC_LABEL[w.metric] ?? w.metric} ${w.from} → ${w.to}${w.afterSeason !== null ? ` after Season ${w.afterSeason}` : ''}`,
    });
  }
  const note =
    ' The newer board formulas (Phase 6: Power 2, PvE Progress 4) switch in at the end of the season under way.';
  const links = [
    tab('seasons', 'Seasons tab'),
    doc(
      'docs/LEADERBOARDS.md',
      'formula-versions-between-seasons-ticket-61',
      'LEADERBOARDS.md · Formula versions',
    ),
  ];
  if (s.current) {
    return {
      id: 'season',
      title: 'Season 1',
      status: 'done',
      summary: `Season ${s.current.number} is running; the next follows back to back.${note}`,
      facts,
      links,
    };
  }
  if (s.next) {
    return {
      id: 'season',
      title: 'Season 1',
      status: 'done',
      summary: `Season ${s.next.number} is scheduled and starts by itself.${note}`,
      facts,
      links,
    };
  }
  return {
    id: 'season',
    title: 'Season 1',
    status: s.past > 0 ? 'attention' : 'not_set',
    summary:
      s.past > 0
        ? 'No season is running or scheduled right now. Schedule the next one in the Seasons tab.'
        : 'No season is scheduled yet: the boards run, but nothing is sealed or honoured. Schedule Season 1 in the Seasons tab.' +
          note,
    facts,
    links,
  };
}

// ---- Trading launch order -------------------------------------------------------------------

/**
 * Where the town is in the documented launch order (docs/TRADING.md "Admin switches"):
 * 0 closed; 1 items (Trading, Trade: items, Shelf: items); 2 plus materials (Trade and Shelf);
 * 3 the last group (gold, Mythic, Void, Prismatic) under way, one at a time; 4 everything open.
 * `outOfOrder` lists switches that are on before the step they belong to.
 */
export interface TradingLaunchStep {
  step: 0 | 1 | 2 | 3 | 4;
  outOfOrder: string[];
  /** Of the last group: how many are on, of how many. */
  lastGroup: { on: number; of: number };
}

const LAST_GROUP = ['gold', 'mythic', 'void', 'prismatic'] as const;

export function tradingLaunchStep(s: TradingSettings): TradingLaunchStep {
  const step1 = s.trading && s.trade.items && s.shelf.items;
  const step2 = step1 && s.trade.materials && s.shelf.materials;
  const last: Record<(typeof LAST_GROUP)[number], boolean> = {
    gold: s.trade.gold && s.shelf.gold,
    mythic: s.tradeable.mythic,
    void: s.tradeable.void,
    prismatic: s.tradeable.prismatic,
  };
  const lastOn = LAST_GROUP.filter((k) => last[k]).length;
  const outOfOrder: string[] = [];
  if (!step1) {
    if (s.trade.materials || s.shelf.materials) outOfOrder.push('materials');
  }
  if (!step2) {
    if (s.trade.gold || s.shelf.gold) outOfOrder.push('gold');
    for (const k of ['mythic', 'void', 'prismatic'] as const) {
      // Mythic/Void/Prismatic start off by default: on before materials is ahead of the order.
      if (s.tradeable[k]) outOfOrder.push(k);
    }
  }
  const step: TradingLaunchStep['step'] = !s.trading
    ? 0
    : !step1
      ? 0
      : !step2
        ? 1
        : lastOn === 0
          ? 2
          : lastOn < LAST_GROUP.length
            ? 3
            : 4;
  // Categories of the first step (Epic, Legendary, set pieces) switched off while trading is open.
  if (step >= 1) {
    for (const k of TRADE_CATEGORIES) {
      if (!(LAST_GROUP as readonly string[]).includes(k) && !s.tradeable[k])
        outOfOrder.push(`${k} off`);
    }
  }
  return { step, outOfOrder, lastGroup: { on: lastOn, of: LAST_GROUP.length } };
}

const STEP_WORDS: Record<TradingLaunchStep['step'], string> = {
  0: 'Closed (no step taken yet)',
  1: 'Step 1 of 3: items and the shelf for items',
  2: 'Step 2 of 3: materials added',
  3: 'Step 3 of 3 under way: gold, Mythic, Void and Prismatic, one at a time',
  4: 'Every step taken: everything is open',
};

export function tradingItem(s: TradingSettings, mailReady: boolean): ReadinessItem {
  const l = tradingLaunchStep(s);
  const facts: ReadinessItem['facts'] = [
    { label: 'Launch order', value: STEP_WORDS[l.step] },
    { label: 'Master switch', value: s.trading ? 'On' : 'Off' },
  ];
  if (l.step >= 2)
    facts.push({ label: 'Last group on', value: `${l.lastGroup.on} of ${l.lastGroup.of}` });
  if (l.outOfOrder.length) facts.push({ label: 'Out of order', value: l.outOfOrder.join(', ') });
  const links = [
    tab('trading', 'Trading tab'),
    tab('trades', 'Trades tab (pattern report)'),
    doc('docs/TRADING.md', 'admin-switches', 'TRADING.md · Admin switches'),
  ];
  let status: ReadinessStatus;
  let summary: string;
  if (l.step === 0 && !s.trading) {
    status = 'not_set';
    summary = mailReady
      ? 'Trading is closed. Open it in the documented order in the Trading tab, and read the pattern report and trade.items telemetry after each step.'
      : 'Trading is closed. Set up mail first: only players with a verified address may trade.';
  } else if (l.outOfOrder.length || (s.trading && !mailReady) || (s.trading && l.step === 0)) {
    status = 'attention';
    summary =
      s.trading && !mailReady
        ? 'Trading is open but mail is not set up, so no player can verify an address and become eligible.'
        : 'Some switches are ahead of (or behind) the documented launch order. Check the Trading tab.';
  } else {
    status = 'done';
    summary =
      l.step === 4
        ? 'Every launch step is taken. Keep reading the pattern report and the trade.items telemetry.'
        : 'Trading is open at the step shown. Take the next step only after a few weeks of clean telemetry and pattern reports.';
  }
  return { id: 'trading', title: 'Trading', status, summary, facts, links };
}

// ---- The first event ------------------------------------------------------------------------

export interface EventFacts {
  current: { number: number; definitionId: string; endsAt: Date } | null;
  next: { number: number; definitionId: string; startsAt: Date } | null;
  /** Events that ran and ended (not cancelled). */
  past: number;
}

export function eventItem(e: EventFacts): ReadinessItem {
  const facts: ReadinessItem['facts'] = [];
  if (e.current)
    facts.push({
      label: 'Under way',
      value: `${e.current.definitionId} (#${e.current.number}), ends ${e.current.endsAt.toISOString()}`,
    });
  if (e.next)
    facts.push({
      label: 'Next',
      value: `${e.next.definitionId} (#${e.next.number}), starts ${e.next.startsAt.toISOString()}`,
    });
  facts.push({ label: 'Ended', value: String(e.past) });
  const links = [
    tab('events', 'Events tab'),
    doc('docs/DEPLOY.md', 'events', 'DEPLOY.md · Events'),
  ];
  if (e.current || e.next) {
    return {
      id: 'event',
      title: 'The first event',
      status: 'done',
      summary: e.current ? 'An event is under way.' : 'An event is scheduled and starts by itself.',
      facts,
      links,
    };
  }
  return {
    id: 'event',
    title: 'The first event',
    status: e.past > 0 ? 'attention' : 'not_set',
    summary:
      e.past > 0
        ? 'No event is running or scheduled now. Events don’t start by themselves: schedule the next in the Events tab.'
        : 'No event has been scheduled yet. Schedule the Harvest of Bones in the Events tab.',
    facts,
    links,
  };
}

// ---- Reserved names, test accounts ----------------------------------------------------------

export function reservedNamesItem(custom: number): ReadinessItem {
  return {
    id: 'reservedNames',
    title: 'Reserved staff names',
    status: custom > 0 ? 'done' : 'not_set',
    summary:
      custom > 0
        ? 'You added your own reserved names on top of the built-in ones. Add each new staff member’s name too.'
        : 'Only the built-in names are reserved. Add the real staff names (yours, your moderators’) so look-alikes are refused.',
    facts: [{ label: 'Added by admins', value: String(custom) }],
    links: [
      tab('names', 'Names tab'),
      doc('docs/DEPLOY.md', 'admin-tools-ticket-d4', 'DEPLOY.md · Admin tools'),
    ],
  };
}

export function testAccountsItem(n: number): ReadinessItem {
  return {
    id: 'testAccounts',
    title: 'Test accounts',
    status: n > 0 ? 'done' : 'not_set',
    summary:
      (n > 0
        ? 'You have a test account for trying things out. '
        : 'No test account yet: register a second account for your own testing and mark it on the server (deploy/admin.sh test-account <handle> on). ') +
      'Rule: never switch a test account back to normal while it holds anything granted with the admin tools; delete its heroes or keep it a test account.',
    facts: [{ label: 'Test accounts', value: String(n) }],
    links: [
      tab('inspect', 'Inspector'),
      doc('docs/DEPLOY.md', 'admin-tools-ticket-d4', 'DEPLOY.md · Test accounts'),
    ],
  };
}

// ---- Backups --------------------------------------------------------------------------------

/** A good backup is at most this old (the timer runs nightly). */
export const BACKUP_FRESH_MS = 36 * HOUR_MS;
/** The status file is a few dozen bytes; anything bigger is not ours. */
const BACKUP_STATUS_MAX_BYTES = 1024;

export type BackupStatus =
  | { state: 'not_configured' }
  | { state: 'missing' }
  | { state: 'unreadable' }
  | { state: 'fresh' | 'old'; finishedAt: Date; bytes: number; ageMs: number };

/**
 * Parses `deploy/backup.sh`'s status file: `{"finishedAt": ISO, "bytes": n}`. Anything else
 * (another shape, a time in the future beyond a little clock skew) is `unreadable`.
 */
export function parseBackupStatus(text: string, now: Date): BackupStatus {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: 'unreadable' };
  }
  if (!value || typeof value !== 'object') return { state: 'unreadable' };
  const { finishedAt, bytes } = value as { finishedAt?: unknown; bytes?: unknown };
  if (
    typeof finishedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(finishedAt)
  )
    return { state: 'unreadable' };
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)
    return { state: 'unreadable' };
  const at = new Date(finishedAt);
  if (Number.isNaN(at.getTime())) return { state: 'unreadable' };
  const ageMs = now.getTime() - at.getTime();
  if (ageMs < -HOUR_MS) return { state: 'unreadable' };
  return {
    state: ageMs <= BACKUP_FRESH_MS ? 'fresh' : 'old',
    finishedAt: at,
    bytes,
    ageMs: Math.max(0, ageMs),
  };
}

export async function readBackupStatus(file: string | undefined, now: Date): Promise<BackupStatus> {
  if (!file) return { state: 'not_configured' };
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > BACKUP_STATUS_MAX_BYTES) return { state: 'unreadable' };
    return parseBackupStatus(await readFile(file, 'utf8'), now);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'unreadable' };
  }
}

function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function ageWords(ms: number): string {
  if (ms >= 2 * DAY_MS) return `${Math.floor(ms / DAY_MS)} days ago`;
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)} h ago`;
  return `${Math.max(0, Math.floor(ms / 60_000))} min ago`;
}

export function backupItem(b: BackupStatus): ReadinessItem {
  const links = [
    doc('docs/DEPLOY.md', '10-backups', 'DEPLOY.md · Backups'),
    doc('docs/GOING_LIVE.md', '9-backups-and-a-restore-drill', 'GOING_LIVE.md · Restore drill'),
  ];
  const base = { id: 'backups' as const, title: 'Backups', links };
  switch (b.state) {
    case 'not_configured':
      return {
        ...base,
        status: 'not_set',
        summary:
          'This server does not read a backup status (BACKUP_STATUS_FILE is not set). On the VPS, deploy.sh sets it up.',
        facts: [],
      };
    case 'missing':
      return {
        ...base,
        status: 'not_set',
        summary:
          'No backup has reported yet. Enable the nightly backup timer and run one backup now (deploy/backup.sh).',
        facts: [],
      };
    case 'unreadable':
      return {
        ...base,
        status: 'attention',
        summary:
          'The backup status file could not be read. Run deploy/backup.sh once; it writes the file again.',
        facts: [],
      };
    default: {
      const facts = [
        {
          label: 'Last good backup',
          value: `${b.finishedAt.toISOString()} (${ageWords(b.ageMs)})`,
        },
        { label: 'Size', value: sizeWords(b.bytes) },
      ];
      return b.state === 'fresh'
        ? {
            ...base,
            status: 'done',
            summary:
              'The last backup is recent. Copy backups off the server regularly, and try a restore once before you need it.',
            facts,
          }
        : {
            ...base,
            status: 'attention',
            summary:
              'The last good backup is more than a day and a half old. Check the backup timer (journalctl -u worldforge-backup).',
            facts,
          };
    }
  }
}

// ---- Deploy, shared state -------------------------------------------------------------------

export function deployItem(build: BuildInfo): ReadinessItem {
  const recorded = build.gitSha !== null;
  return {
    id: 'deploy',
    title: 'Deploy',
    status: recorded ? 'done' : 'attention',
    summary: recorded
      ? 'The version and commit this server runs. CI and the auto-deploy are on GitHub (Actions).'
      : 'This build has no commit recorded (not built by deploy/deploy.sh). On the VPS, deploy with deploy/deploy.sh.',
    facts: [
      { label: 'Game version', value: GAME_VERSION },
      { label: 'Commit', value: build.gitSha ?? 'Not recorded' },
      { label: 'Built', value: build.buildTime ?? 'Not recorded' },
    ],
    links: [
      tab('status', 'Server tab'),
      doc('docs/DEPLOY.md', '11-updates', 'DEPLOY.md · Updates'),
    ],
  };
}

export function sharedStateItem(mode: 'postgres' | 'memory'): ReadinessItem {
  return {
    id: 'sharedState',
    title: 'Shared state',
    status: mode === 'postgres' ? 'done' : 'attention',
    summary:
      mode === 'postgres'
        ? 'Rate limits are counted in the database, so a second API instance would be safe (production default).'
        : 'Rate limits are counted in this process only. That is fine for one API instance; never run two like this.',
    facts: [{ label: 'SHARED_STATE', value: mode }],
    links: [doc('docs/DEPLOY.md', '17-running-two-api-instances', 'DEPLOY.md · Two API instances')],
  };
}

// ---- The whole board ------------------------------------------------------------------------

export interface ReadinessSources {
  mailer: Mailer;
  legalDir: string | undefined;
  backupStatusFile: string | undefined;
  sharedState: 'postgres' | 'memory';
  build: BuildInfo;
}

export const TEST_LETTER_EVENT = 'admin.readiness.test_letter';
export const PRIVACY_EVENT = 'admin.readiness.privacy';

export async function lastTestLetter(db: Executor): Promise<TestLetterRecord | null> {
  const [row] = await db
    .select({ at: auditLog.createdAt, data: auditLog.data })
    .from(auditLog)
    .where(eq(auditLog.event, TEST_LETTER_EVENT))
    .orderBy(desc(auditLog.id))
    .limit(1);
  if (!row) return null;
  const outcome = (row.data as { outcome?: unknown }).outcome === 'sent' ? 'sent' : 'failed';
  return { at: row.at, outcome };
}

export interface ReadinessReport {
  items: ReadinessItem[];
  privacy: {
    checklist: { id: PrivacyCheckId; label: string; hint: string; ticked: boolean }[];
    version: number;
    updatedAt: string | null;
  };
  /** Whether "Send test letter" can work on this server (any transport but `none`). */
  testLetter: { available: boolean };
  generatedAt: string;
}

export async function readinessReport(
  db: Executor,
  src: ReadinessSources,
  now: Date,
): Promise<ReadinessReport> {
  const [
    letter,
    files,
    ticks,
    seasonRows,
    eventRows,
    schedule,
    tradingRow,
    [names],
    [tests],
    backup,
  ] = await Promise.all([
    lastTestLetter(db),
    legalFileStates(src.legalDir),
    loadPrivacyTicks(db),
    listSeasons(db),
    listEvents(db),
    loadFormulaSchedule(db),
    db
      .select({ value: gameSettings.value })
      .from(gameSettings)
      .where(eq(gameSettings.key, 'trading')),
    db.select({ n: count() }).from(reservedNames),
    db.select({ n: count() }).from(accounts).where(eq(accounts.isTest, true)),
    readBackupStatus(src.backupStatusFile, now),
  ]);
  const seasons = currentAndNext(seasonRows, now);
  const events = currentAndNextEvent(eventRows, now);
  const trading = normaliseTradingSettings(tradingRow[0]?.value);
  const mailReady = src.mailer.enabled;
  const items: ReadinessItem[] = [
    emailItem(src.mailer, letter),
    privacyItem(files, ticks),
    reservedNamesItem(names?.n ?? 0),
    testAccountsItem(tests?.n ?? 0),
    seasonItem({
      current: seasons.current,
      next: seasons.next,
      past: seasonRows.filter((s) => s.endsAt.getTime() <= now.getTime()).length,
      waiting: schedule.filter((w) => !switchInForce(w, seasonRows, now)),
    }),
    eventItem({
      current: events.current,
      next: events.next,
      past: eventRows.filter((e) => !e.cancelledAt && e.endsAt.getTime() <= now.getTime()).length,
    }),
    tradingItem(trading, mailReady),
    backupItem(backup),
    deployItem(src.build),
    sharedStateItem(src.sharedState),
  ];
  return {
    items,
    privacy: {
      checklist: PRIVACY_CHECKLIST.map((c) => ({ ...c, ticked: ticks.ticked.includes(c.id) })),
      version: ticks.version,
      updatedAt: ticks.updatedAt?.toISOString() ?? null,
    },
    testLetter: { available: src.mailer.enabled },
    generatedAt: now.toISOString(),
  };
}
