/**
 * Guilds (ticket 4.4, docs/SOCIAL.md "Guilds"): roles, what each may do, the caps and the
 * creation cost, as data. The server asks `guildDecision` for every guild action; the client asks
 * the same function to decide which buttons to show. Tested as a matrix (every standing × every
 * action × every target) in the server's `guild-permissions.test.ts` against a hand-written table.
 */

export const GUILD_ROLES = ['leader', 'officer', 'member'] as const;
export type GuildRole = (typeof GUILD_ROLES)[number];

/** The actor's place relative to a guild: one of its roles, or `none` (not a member). */
export type GuildStanding = GuildRole | 'none';
export const GUILD_STANDINGS: readonly GuildStanding[] = [...GUILD_ROLES, 'none'];

/** The target of a member action: a role in the actor's guild, `none`, or the actor themselves. */
export type GuildTarget = GuildRole | 'none' | 'self';
export const GUILD_TARGETS: readonly GuildTarget[] = [...GUILD_ROLES, 'none', 'self'];

const RANK: Record<GuildRole, number> = { member: 0, officer: 1, leader: 2 };

export function guildRoleRank(role: GuildRole): number {
  return RANK[role];
}

export function isGuildRole(value: unknown): value is GuildRole {
  return typeof value === 'string' && (GUILD_ROLES as readonly string[]).includes(value);
}

export const GUILD_ROLE_LABELS: Record<GuildRole, string> = {
  leader: 'Leader',
  officer: 'Officer',
  member: 'Member',
};

export const GUILD_ACTIONS = [
  // Not a member yet.
  'create',
  'apply',
  'acceptInvite',
  // Anyone (stepping away from an offer).
  'cancelApplication',
  'declineInvite',
  // Officers and the leader.
  'viewRequests',
  'invite',
  'cancelInvite',
  'acceptApplication',
  'declineApplication',
  // On another member.
  'kick',
  'promote',
  'demote',
  'transferLeadership',
  // The leader.
  'setEmblem',
  'rename',
  'disband',
  // Officers and members.
  'leave',
] as const;
export type GuildAction = (typeof GUILD_ACTIONS)[number];

/** Actions aimed at another member (they take a `GuildTarget`). */
export const GUILD_TARGET_ACTIONS = ['kick', 'promote', 'demote', 'transferLeadership'] as const;
export type GuildTargetAction = (typeof GUILD_TARGET_ACTIONS)[number];

export function isGuildTargetAction(action: GuildAction): action is GuildTargetAction {
  return (GUILD_TARGET_ACTIONS as readonly string[]).includes(action);
}

export interface GuildRefusal {
  status: 403 | 404 | 409 | 422;
  code: string;
  message: string;
}
export type GuildDecision = 'allowed' | GuildRefusal;

export const GUILD_REFUSALS = {
  notInGuild: { status: 404, code: 'not_in_guild', message: 'You are not in a guild.' },
  alreadyInGuild: {
    status: 409,
    code: 'already_in_guild',
    message: 'You are already in a guild. Leave it first.',
  },
  forbidden: {
    status: 403,
    code: 'guild_forbidden',
    message: 'Your rank in the guild does not allow that.',
  },
  self: { status: 422, code: 'cannot_target_self', message: 'That is you.' },
  notAMember: {
    status: 404,
    code: 'not_a_member',
    message: 'That player is not in your guild.',
  },
  alreadyOfficer: { status: 409, code: 'already_officer', message: 'They are an officer already.' },
  notAnOfficer: { status: 409, code: 'not_an_officer', message: 'They are not an officer.' },
  leaderMustHandOver: {
    status: 409,
    code: 'leader_must_hand_over',
    message:
      'The leader cannot simply leave. Hand the leadership to a member, or disband the guild.',
  },
} as const satisfies Record<string, GuildRefusal>;

/** Who may take each action at all (before the target is looked at). */
const ALLOWED: Record<GuildAction, readonly GuildStanding[]> = {
  create: ['none'],
  apply: ['none'],
  acceptInvite: ['none'],
  cancelApplication: ['leader', 'officer', 'member', 'none'],
  declineInvite: ['leader', 'officer', 'member', 'none'],
  viewRequests: ['leader', 'officer'],
  invite: ['leader', 'officer'],
  cancelInvite: ['leader', 'officer'],
  acceptApplication: ['leader', 'officer'],
  declineApplication: ['leader', 'officer'],
  kick: ['leader', 'officer'],
  promote: ['leader'],
  demote: ['leader'],
  transferLeadership: ['leader'],
  setEmblem: ['leader'],
  rename: ['leader'],
  disband: ['leader'],
  leave: ['officer', 'member'],
};

/**
 * Whether `actor` may take `action` (on `target`, for the member actions). Refusals, in order:
 * not a member (`404 not_in_guild`) or already in one (`409 already_in_guild`); aimed at oneself
 * (`422`); the rank does not allow the action (`403 guild_forbidden`; the leader leaving is
 * `409 leader_must_hand_over`); the target is not in the guild (`404 not_a_member`); the target's
 * rank is not below the actor's (`403`); the target's role makes the action moot (`409`).
 * The server checks what exists (an invite, an application, the caps) afterwards.
 */
export function guildDecision(
  actor: GuildStanding,
  action: GuildAction,
  target?: GuildTarget,
): GuildDecision {
  const allowed = ALLOWED[action];
  if (!allowed.includes(actor)) {
    if (actor === 'none') return GUILD_REFUSALS.notInGuild;
    if (allowed.length === 1 && allowed[0] === 'none') return GUILD_REFUSALS.alreadyInGuild;
    if (action === 'leave') return GUILD_REFUSALS.leaderMustHandOver;
    if (isGuildTargetAction(action) && target === 'self') return GUILD_REFUSALS.self;
    return GUILD_REFUSALS.forbidden;
  }
  if (!isGuildTargetAction(action)) return 'allowed';
  if (target === undefined || target === 'none') return GUILD_REFUSALS.notAMember;
  if (target === 'self') return GUILD_REFUSALS.self;
  // `actor` is a role here (`none` is never allowed a target action).
  if (RANK[target] >= RANK[actor as GuildRole]) return GUILD_REFUSALS.forbidden;
  if (action === 'promote' && target === 'officer') return GUILD_REFUSALS.alreadyOfficer;
  if (action === 'demote' && target === 'member') return GUILD_REFUSALS.notAnOfficer;
  return 'allowed';
}

/** Caps, exact under races (the server counts them under the guild's and the accounts' locks). */
export const GUILD_LIMITS = {
  /** Members including the leader (owner-confirmed default). */
  members: 30,
  /** Invites a guild may have waiting. */
  invitesPerGuild: 30,
  /** Invites waiting for one player, from all guilds. */
  invitesPerAccount: 20,
  /** Applications waiting at one guild. */
  applicationsPerGuild: 30,
  /** Applications one player may have waiting. */
  applicationsPerAccount: 5,
} as const;

export const GUILD_LIMIT_REFUSALS = {
  full: {
    status: 409,
    code: 'guild_full',
    message: `The guild has ${GUILD_LIMITS.members} members, the most there can be.`,
  },
  invitesPerGuild: {
    status: 409,
    code: 'invite_limit',
    message: `The guild has ${GUILD_LIMITS.invitesPerGuild} invites waiting. Withdraw one first.`,
  },
  invitesPerAccount: {
    status: 409,
    code: 'invite_inbox_full',
    message: 'This player has too many guild invites waiting.',
  },
  applicationsPerGuild: {
    status: 409,
    code: 'application_limit_guild',
    message: 'This guild has too many applications waiting. Try again later.',
  },
  applicationsPerAccount: {
    status: 409,
    code: 'application_limit',
    message: `You have ${GUILD_LIMITS.applicationsPerAccount} applications waiting. Withdraw one first.`,
  },
} as const satisfies Record<string, GuildRefusal>;

/**
 * Founding a guild costs gold from one of the founder's heroes (a sink, owner-confirmed default).
 * About an evening of mid-level farming; the Phase 2 purse at level 17 is 25–30k.
 */
export const GUILD_CREATE_COST = 5_000;

/**
 * Emblems a guild can choose (no uploads: no player images in Phase 4). Placeholders until the art
 * ticket A.8 draws the 32×32 icons (`assetId`); the client draws a glyph on a shield meanwhile.
 * Never rename or reuse an id: guilds store it.
 */
export const GUILD_EMBLEMS = [
  { id: 'anvil', label: 'Anvil', glyph: 'A', assetId: 'guild-emblem.anvil' },
  { id: 'crow', label: 'Crow', glyph: 'C', assetId: 'guild-emblem.crow' },
  { id: 'tower', label: 'Tower', glyph: 'T', assetId: 'guild-emblem.tower' },
  { id: 'flame', label: 'Flame', glyph: 'F', assetId: 'guild-emblem.flame' },
  { id: 'skull', label: 'Skull', glyph: 'S', assetId: 'guild-emblem.skull' },
  { id: 'oak', label: 'Oak', glyph: 'O', assetId: 'guild-emblem.oak' },
] as const;
export type GuildEmblemId = (typeof GUILD_EMBLEMS)[number]['id'];
export const GUILD_EMBLEM_IDS = GUILD_EMBLEMS.map((e) => e.id) as GuildEmblemId[];
export const DEFAULT_GUILD_EMBLEM: GuildEmblemId = 'anvil';

export function isGuildEmblem(value: unknown): value is GuildEmblemId {
  return typeof value === 'string' && (GUILD_EMBLEM_IDS as readonly string[]).includes(value);
}

export function guildEmblem(id: string) {
  return GUILD_EMBLEMS.find((e) => e.id === id) ?? GUILD_EMBLEMS[0];
}
