import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  PROFILE_FIELD_IDS,
  REPORT_TARGET_KINDS,
  HANDLE_RE,
  type ReportTarget,
  type ReportTargetKind,
} from '@worldforge/game-core';
import { accounts, characters, guilds, type Account } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { guildByHandle, guildLeaderId, guildTargetKey } from './guild-model.js';

/**
 * Report target registry (ticket 4.1, docs/SOCIAL.md "Reports"). Each kind of game-core
 * `ReportTarget` registers how to find the account it belongs to (the subject), its internal key
 * (one open report per reporter and key; a `hide` sanction hides a key) and the context snapshot
 * stored with the report. Later tickets add a resolver for each new kind (guild, message) and a
 * branch in `reportTargetSchema`.
 */
export interface ResolvedTarget {
  subject: Account;
  /** Internal, never sent to players: `player:<account id>`, `profileField:<account id>:<field>`. */
  key: string;
  /** The canonical public target (handles only). */
  target: ReportTarget;
  /** What the reporter saw, kept as evidence. */
  context: Record<string, unknown>;
}

type Resolver<K extends ReportTargetKind> = (
  executor: Executor,
  target: Extract<ReportTarget, { kind: K }>,
) => Promise<ResolvedTarget | null>;

async function accountByHandle(executor: Executor, handle: string): Promise<Account | null> {
  if (!HANDLE_RE.test(handle)) return null;
  const [row] = await executor.select().from(accounts).where(eq(accounts.handle, handle)).limit(1);
  return row ?? null;
}

const RESOLVERS: { [K in ReportTargetKind]: Resolver<K> } = {
  player: async (executor, t) => {
    const subject = await accountByHandle(executor, t.handle);
    if (!subject) return null;
    return {
      subject,
      key: `player:${subject.id}`,
      target: { kind: 'player', handle: subject.handle },
      context: { displayName: subject.displayName },
    };
  },
  profileField: async (executor, t) => {
    const subject = await accountByHandle(executor, t.handle);
    if (!subject) return null;
    return {
      subject,
      key: profileFieldKey(subject.id, t.field),
      target: { kind: 'profileField', handle: subject.handle, field: t.field },
      context: { displayName: subject.displayName, value: subject.displayName },
    };
  },
  // Ticket 4.2: a character's name on its owner's profile. Names are unique and permanent.
  characterName: async (executor, t) => {
    const subject = await accountByHandle(executor, t.handle);
    if (!subject || typeof t.name !== 'string') return null;
    const [hero] = await executor
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .where(
        and(
          eq(characters.accountId, subject.id),
          sql`lower(${characters.name}) = lower(${t.name.trim()})`,
        ),
      )
      .limit(1);
    if (!hero) return null;
    return {
      subject,
      key: characterNameKey(hero.id),
      target: { kind: 'characterName', handle: subject.handle, name: hero.name },
      context: { displayName: subject.displayName, value: hero.name },
    };
  },
  // Ticket 4.4: a guild (name and tag). The subject is its leader at the time of the report.
  guild: async (executor, t) => {
    if (typeof t.handle !== 'string') return null;
    const guild = await guildByHandle(executor, t.handle);
    if (!guild) return null;
    const leaderId = await guildLeaderId(executor, guild.id);
    if (!leaderId) return null;
    const [subject] = await executor.select().from(accounts).where(eq(accounts.id, leaderId));
    if (!subject) return null;
    return {
      subject,
      key: guildTargetKey(guild.id),
      target: { kind: 'guild', handle: guild.handle },
      context: {
        displayName: subject.displayName,
        value: `${guild.name} [${guild.tag}]`,
        name: guild.name,
        tag: guild.tag,
      },
    };
  },
};

export function characterNameKey(characterId: string): string {
  return `characterName:${characterId}`;
}

/**
 * The current value of each target key, for the moderator queue ("what does it say now?"):
 * display names for player and profile-field keys, character names for character keys.
 */
export async function currentTargetValues(
  executor: Executor,
  rows: readonly { key: string; subject: Pick<Account, 'displayName'> }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const heroIds = rows
    .map((r) => r.key)
    .filter((k) => k.startsWith('characterName:'))
    .map((k) => k.slice('characterName:'.length));
  const guildIds = rows
    .map((r) => r.key)
    .filter((k) => k.startsWith('guild:'))
    .map((k) => k.slice('guild:'.length));
  const guildRows = guildIds.length
    ? await executor
        .select({
          id: guilds.id,
          name: guilds.name,
          tag: guilds.tag,
          disbandedAt: guilds.disbandedAt,
        })
        .from(guilds)
        .where(inArray(guilds.id, guildIds))
    : [];
  const heroes = heroIds.length
    ? await executor
        .select({ id: characters.id, name: characters.name })
        .from(characters)
        .where(inArray(characters.id, heroIds))
    : [];
  for (const r of rows) {
    if (r.key.startsWith('characterName:')) {
      const hero = heroes.find((h) => characterNameKey(h.id) === r.key);
      out.set(r.key, hero?.name ?? '(character deleted)');
    } else if (r.key.startsWith('guild:')) {
      const g = guildRows.find((x) => guildTargetKey(x.id) === r.key);
      out.set(
        r.key,
        !g ? '(guild gone)' : `${g.name} [${g.tag}]${g.disbandedAt ? ' (disbanded)' : ''}`,
      );
    } else out.set(r.key, r.subject.displayName);
  }
  return out;
}

export function profileFieldKey(accountId: string, field: string): string {
  return `profileField:${accountId}:${field}`;
}

export function resolveReportTarget(
  executor: Executor,
  target: ReportTarget,
): Promise<ResolvedTarget | null> {
  const resolver = RESOLVERS[target.kind] as Resolver<ReportTargetKind>;
  return resolver(executor, target as never);
}

export function isHideable(kind: ReportTargetKind): boolean {
  return REPORT_TARGET_KINDS[kind].hideable;
}

const handleSchema = { type: 'string', minLength: 1, maxLength: 64 } as const;

/** JSON Schema for a `ReportTarget` in request bodies. */
export const reportTargetSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'handle'],
      properties: { kind: { const: 'player' }, handle: handleSchema },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'handle', 'field'],
      properties: {
        kind: { const: 'profileField' },
        handle: handleSchema,
        field: { type: 'string', enum: [...PROFILE_FIELD_IDS] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'handle', 'name'],
      properties: {
        kind: { const: 'characterName' },
        handle: handleSchema,
        name: { type: 'string', minLength: 1, maxLength: 64 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'handle'],
      properties: { kind: { const: 'guild' }, handle: handleSchema },
    },
  ],
} as const;

export const reportTargetViewSchema = {
  type: 'object',
  required: ['kind', 'handle'],
  properties: {
    kind: { type: 'string' },
    handle: { type: 'string' },
    field: { type: 'string' },
    name: { type: 'string' },
  },
} as const;
