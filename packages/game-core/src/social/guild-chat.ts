import {
  GUILD_REFUSALS,
  guildRoleRank,
  type GuildRefusal,
  type GuildStanding,
  type GuildTarget,
} from './guilds.js';

/**
 * Guild chat and the guild notice (ticket 4.5, docs/SOCIAL.md "Guild chat"). Who may do what is
 * data here; the server asks `guildChatDecision` for every chat action and the client asks it to
 * decide which buttons to draw. Tested as a matrix (every standing × every action × every author)
 * through the API in the server's `guild-chat.test.ts`, against a hand-written table.
 *
 * Blocks are not a standing: a message whose author blocks the viewer, or whom the viewer blocks,
 * does not exist for the viewer (it is left out of every page, and acting on it answers
 * `404 message_not_found`), whatever the viewer's rank.
 */

export const GUILD_CHAT_ACTIONS = ['read', 'post', 'delete', 'setNotice', 'report'] as const;
export type GuildChatAction = (typeof GUILD_CHAT_ACTIONS)[number];

/** Who may take each action (before the message's author is looked at). */
const ALLOWED: Record<GuildChatAction, readonly GuildStanding[]> = {
  read: ['leader', 'officer', 'member'],
  post: ['leader', 'officer', 'member'],
  delete: ['leader', 'officer', 'member'],
  setNotice: ['leader', 'officer'],
  report: ['leader', 'officer', 'member'],
};

export const GUILD_CHAT_REFUSALS = {
  messageNotFound: {
    status: 404,
    code: 'message_not_found',
    message: 'That message is not in your guild’s chat.',
  },
  alreadyRemoved: {
    status: 409,
    code: 'message_removed',
    message: 'That message was removed already.',
  },
} as const satisfies Record<string, GuildRefusal>;

/**
 * Whether `actor` may take `action`; for `delete`, on a message by `author` (`self`, the author's
 * role in the guild now, or `none` when the author has left it). Refusals: not a member
 * (`404 not_in_guild`); the rank does not allow it (`403 guild_forbidden`). Anyone may remove
 * their own message; officers remove members' messages (and those of former members); only the
 * leader removes an officer's. Nobody removes the leader's but the leader.
 */
export function guildChatDecision(
  actor: GuildStanding,
  action: GuildChatAction,
  author?: GuildTarget,
): 'allowed' | GuildRefusal {
  if (actor === 'none') return GUILD_REFUSALS.notInGuild;
  if (!ALLOWED[action].includes(actor)) return GUILD_REFUSALS.forbidden;
  if (action !== 'delete') return 'allowed';
  if (author === 'self') return 'allowed';
  if (actor === 'member') return GUILD_REFUSALS.forbidden;
  // A former member ranks below every member.
  const authorRank = author === undefined || author === 'none' ? -1 : guildRoleRank(author);
  return authorRank < guildRoleRank(actor) ? 'allowed' : GUILD_REFUSALS.forbidden;
}

/** The kinds of line in the chat: a message, or a notice the leader or an officer pinned. */
export const GUILD_MESSAGE_KINDS = ['chat', 'notice'] as const;
export type GuildMessageKind = (typeof GUILD_MESSAGE_KINDS)[number];

/**
 * Why a line shows as a tombstone (its text is never sent): withdrawn by its author, removed by
 * an officer or the leader, or hidden by a moderator (an active `hide` sanction).
 */
export const GUILD_TOMBSTONES = ['withdrawn', 'removed', 'hidden'] as const;
export type GuildTombstone = (typeof GUILD_TOMBSTONES)[number];

export const GUILD_TOMBSTONE_LABELS: Record<GuildTombstone, string> = {
  withdrawn: 'Withdrawn by its author.',
  removed: 'Struck from the record by an officer.',
  hidden: 'Hidden by the wardens.',
};

/**
 * Pages, the readable history and polling (docs/SOCIAL.md "Guild chat": the numbers are sized
 * against 3.9's per-account limits and 4.1's social-write limit for a full guild of 30).
 */
export const GUILD_CHAT_LIMITS = {
  /** Messages in the first page and in each "load older" page. */
  page: 30,
  /** New messages one poll returns at most (oldest first); more sets `more`. */
  pollMax: 50,
  /** Only the newest this many messages of a guild are readable… */
  historyMessages: 500,
  /** …and none older than this many days. Older rows stay stored for moderation, unserved. */
  historyDays: 30,
  /** A poll re-reads the removal state of at most this many messages below its cursor. */
  revisionWindow: 200,
  /** The open chat polls this often while the tab is visible… */
  pollVisibleMs: 5_000,
  /** …and this often while it is hidden. */
  pollHiddenMs: 30_000,
} as const;
