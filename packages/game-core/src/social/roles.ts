/**
 * Account roles and what each may do in moderation (ticket 4.1, docs/SOCIAL.md "Roles").
 * Permissions are data: `MODERATION_ACTIONS` lists every action, `moderationDecision` is the one
 * function the server asks. Roles are granted only by the `pnpm admin:role` CLI; no API path
 * changes a role.
 */
export const ACCOUNT_ROLES = ['player', 'moderator', 'admin'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

const RANK: Record<AccountRole, number> = { player: 0, moderator: 1, admin: 2 };

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === 'string' && (ACCOUNT_ROLES as readonly string[]).includes(value);
}

export function roleRank(role: AccountRole): number {
  return RANK[role];
}

/** Whether the role is staff (may open the moderator queue). */
export function isStaff(role: AccountRole): boolean {
  return RANK[role] >= RANK.moderator;
}

export const MODERATION_ACTIONS = [
  'viewQueue',
  'dismissReport',
  'mute',
  'suspend',
  'forceRename',
  'hideContent',
  'liftSanction',
  // Ticket 4.4: on a reported guild (the subject is its leader).
  'renameGuild',
  'disbandGuild',
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** Actions that touch a subject account (all but opening the queue). */
export type SubjectAction = Exclude<ModerationAction, 'viewQueue'>;

/**
 * - `allowed`
 * - `not_found`: the actor is not staff. Moderation routes answer `404` so they can't be found.
 * - `forbidden`: staff, but not over this subject: nobody acts on themselves, and a subject of
 *   the actor's rank or higher is out of reach (a moderator can't act on another moderator or an
 *   admin; an admin can't act on another admin; reports about admins are handled outside the app).
 */
export type ModerationDecision = 'allowed' | 'not_found' | 'forbidden';

export interface ModerationSubject {
  /** The subject is the actor's own account. */
  self: boolean;
  role: AccountRole;
}

export function moderationDecision(
  actor: AccountRole,
  action: ModerationAction,
  subject?: ModerationSubject,
): ModerationDecision {
  if (!isStaff(actor)) return 'not_found';
  if (action === 'viewQueue') return 'allowed';
  if (!subject) return 'forbidden';
  if (subject.self) return 'forbidden';
  return RANK[subject.role] < RANK[actor] ? 'allowed' : 'forbidden';
}

/** Roles whose accounts this actor may act on (used to filter the queue). */
export function actionableRoles(actor: AccountRole): AccountRole[] {
  if (!isStaff(actor)) return [];
  return ACCOUNT_ROLES.filter((r) => RANK[r] < RANK[actor]);
}
