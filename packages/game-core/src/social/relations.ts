/**
 * Friends, requests, blocks and presence (ticket 4.3, docs/SOCIAL.md "Relations").
 *
 * One player's view of another is a single `Relation`, derived from three facts (the pair's
 * friendship row and a block in either direction). Every friend action asks `friendDecision`,
 * so what each relation allows is data, tested as a matrix (relation × every action).
 * Other features (profiles 4.2, guild invites 4.4, chat 4.5) read the same relation through the
 * server's `relationBetween` / `relationsFor` / `isBlockedEitherWay` helpers.
 */

export const RELATIONS = [
  'self',
  'stranger',
  'requested-by-me',
  'requested-by-them',
  'friend',
  'blocked-by-me',
  'blocked-by-them',
] as const;
export type Relation = (typeof RELATIONS)[number];

export interface RelationFacts {
  self?: boolean;
  /** The viewer blocks the other player. */
  blockedByMe: boolean;
  /** The other player blocks the viewer. */
  blockedByThem: boolean;
  /** The pair's friendship row, if any. */
  friendship: null | { status: 'pending' | 'friends'; requestedByMe: boolean };
}

/**
 * The viewer's relation to another player. A block wins over everything (and the viewer's own
 * block wins over theirs, so the viewer can always see and lift it). A block removes the pair's
 * friendship and requests, so a friendship row next to a block only exists mid-transaction.
 */
export function relationFromFacts(f: RelationFacts): Relation {
  if (f.self) return 'self';
  if (f.blockedByMe) return 'blocked-by-me';
  if (f.blockedByThem) return 'blocked-by-them';
  if (!f.friendship) return 'stranger';
  if (f.friendship.status === 'friends') return 'friend';
  return f.friendship.requestedByMe ? 'requested-by-me' : 'requested-by-them';
}

/** Whether either player blocks the other (the "invisible everywhere" rule). */
export function isBlockRelation(r: Relation): boolean {
  return r === 'blocked-by-me' || r === 'blocked-by-them';
}

/**
 * What another player may learn of the relation. `blocked-by-them` is shown as `stranger`-like
 * absence: routes answer `404` as for an unknown player, so a block is never announced.
 */
export function visibleRelation(r: Relation): Exclude<Relation, 'blocked-by-them'> | null {
  return r === 'blocked-by-them' ? null : r;
}

export const FRIEND_ACTIONS = [
  'sendRequest',
  'accept',
  'decline',
  'cancel',
  'remove',
  'block',
  'unblock',
  'report',
  'viewPresence',
] as const;
export type FriendAction = (typeof FRIEND_ACTIONS)[number];

export interface FriendRefusal {
  status: 404 | 409 | 422;
  code: string;
  message: string;
}
export type FriendDecision = 'allowed' | FriendRefusal;

const SELF: FriendRefusal = {
  status: 422,
  code: 'cannot_target_self',
  message: 'That is you.',
};
const UNKNOWN: FriendRefusal = {
  status: 404,
  code: 'not_found',
  message: 'No player by that name.',
};
const NO_REQUEST: FriendRefusal = {
  status: 404,
  code: 'no_request',
  message: 'There is no such request (it may have been withdrawn).',
};
const NOT_FRIENDS: FriendRefusal = {
  status: 404,
  code: 'not_friends',
  message: 'You are not friends.',
};
const ALREADY_FRIENDS: FriendRefusal = {
  status: 409,
  code: 'already_friends',
  message: 'You are already friends.',
};
const PENDING: FriendRefusal = {
  status: 409,
  code: 'request_pending',
  message: 'Your request is already waiting for an answer.',
};
const YOU_BLOCK: FriendRefusal = {
  status: 409,
  code: 'blocked_by_you',
  message: 'You block this player. Unblock them first.',
};
const ALREADY_BLOCKED: FriendRefusal = {
  status: 409,
  code: 'already_blocked',
  message: 'You already block this player.',
};
const NOT_BLOCKED: FriendRefusal = {
  status: 404,
  code: 'not_blocked',
  message: 'You do not block this player.',
};
const HIDDEN: FriendRefusal = { status: 404, code: 'not_found', message: 'Not visible.' };

type Row = Record<Exclude<Relation, 'self'>, FriendDecision>;

/**
 * The relation matrix (docs/SOCIAL.md). `sendRequest` to someone whose request is waiting
 * accepts it (both sending at once makes one friendship). A player who blocks the viewer is
 * answered like an unknown player (`404 not_found`), except that the viewer may still block them
 * back and report them.
 */
export const FRIEND_MATRIX: Record<FriendAction, Row> = {
  sendRequest: {
    stranger: 'allowed',
    'requested-by-me': PENDING,
    'requested-by-them': 'allowed',
    friend: ALREADY_FRIENDS,
    'blocked-by-me': YOU_BLOCK,
    'blocked-by-them': UNKNOWN,
  },
  accept: {
    stranger: NO_REQUEST,
    'requested-by-me': NO_REQUEST,
    'requested-by-them': 'allowed',
    friend: ALREADY_FRIENDS,
    'blocked-by-me': NO_REQUEST,
    'blocked-by-them': UNKNOWN,
  },
  decline: {
    stranger: NO_REQUEST,
    'requested-by-me': NO_REQUEST,
    'requested-by-them': 'allowed',
    friend: NO_REQUEST,
    'blocked-by-me': NO_REQUEST,
    'blocked-by-them': UNKNOWN,
  },
  cancel: {
    stranger: NO_REQUEST,
    'requested-by-me': 'allowed',
    'requested-by-them': NO_REQUEST,
    friend: NO_REQUEST,
    'blocked-by-me': NO_REQUEST,
    'blocked-by-them': UNKNOWN,
  },
  remove: {
    stranger: NOT_FRIENDS,
    'requested-by-me': NOT_FRIENDS,
    'requested-by-them': NOT_FRIENDS,
    friend: 'allowed',
    'blocked-by-me': NOT_FRIENDS,
    'blocked-by-them': UNKNOWN,
  },
  block: {
    stranger: 'allowed',
    'requested-by-me': 'allowed',
    'requested-by-them': 'allowed',
    friend: 'allowed',
    'blocked-by-me': ALREADY_BLOCKED,
    'blocked-by-them': 'allowed',
  },
  unblock: {
    stranger: NOT_BLOCKED,
    'requested-by-me': NOT_BLOCKED,
    'requested-by-them': NOT_BLOCKED,
    friend: NOT_BLOCKED,
    'blocked-by-me': 'allowed',
    'blocked-by-them': UNKNOWN,
  },
  // Reports go through 4.1's `POST /api/reports`; a block never stops a report.
  report: {
    stranger: 'allowed',
    'requested-by-me': 'allowed',
    'requested-by-them': 'allowed',
    friend: 'allowed',
    'blocked-by-me': 'allowed',
    'blocked-by-them': 'allowed',
  },
  // Presence is for friends (guildmates join in 4.4), and only when the friend does not hide it.
  viewPresence: {
    stranger: HIDDEN,
    'requested-by-me': HIDDEN,
    'requested-by-them': HIDDEN,
    friend: 'allowed',
    'blocked-by-me': HIDDEN,
    'blocked-by-them': HIDDEN,
  },
};

export function friendDecision(relation: Relation, action: FriendAction): FriendDecision {
  if (relation === 'self')
    return action === 'report' ? { ...SELF, message: 'You cannot report yourself.' } : SELF;
  return FRIEND_MATRIX[action][relation];
}

/**
 * Caps (checked on the server under the pair's locks, so they are exact under races). A
 * request to someone whose request is waiting is an accept and needs no request slot.
 */
export const FRIEND_LIMITS = {
  /** Friends per account. */
  friends: 100,
  /** Requests an account has sent that wait for an answer. */
  outgoingRequests: 25,
  /** Requests waiting in an account's inbox. */
  incomingRequests: 50,
  /** Players an account blocks. */
  blocks: 500,
} as const;

export const FRIEND_LIMIT_REFUSALS = {
  friends: {
    status: 409,
    code: 'friend_limit',
    message: `You have ${FRIEND_LIMITS.friends} friends, the most there can be. Remove one first.`,
  },
  theirFriends: {
    status: 409,
    code: 'friend_limit_them',
    message: 'This player cannot take more friends.',
  },
  outgoingRequests: {
    status: 409,
    code: 'request_limit',
    message: `You have ${FRIEND_LIMITS.outgoingRequests} requests waiting. Cancel one or wait for answers.`,
  },
  incomingRequests: {
    status: 409,
    code: 'inbox_full',
    message: 'This player has too many requests waiting. Try again later.',
  },
  blocks: {
    status: 409,
    code: 'block_limit',
    message: `You block ${FRIEND_LIMITS.blocks} players, the most there can be.`,
  },
} as const satisfies Record<string, FriendRefusal>;

/**
 * Presence (docs/SOCIAL.md "Presence"): a coarse bucket from the last authenticated request,
 * never a time. The server records "last seen" at most once per `PRESENCE_WRITE_INTERVAL_MS` per
 * account, so `online` must cover more than one interval.
 */
export const PRESENCE_BUCKETS = ['online', 'today', 'week', 'longer'] as const;
export type PresenceBucket = (typeof PRESENCE_BUCKETS)[number];

export const PRESENCE_WRITE_INTERVAL_MS = 3 * 60_000;
export const PRESENCE_ONLINE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export function presenceBucket(lastSeen: Date | null | undefined, now: Date): PresenceBucket {
  if (!lastSeen) return 'longer';
  const ago = now.getTime() - lastSeen.getTime();
  if (ago <= PRESENCE_ONLINE_MS) return 'online';
  if (ago <= DAY_MS) return 'today';
  if (ago <= 7 * DAY_MS) return 'week';
  return 'longer';
}

export const PRESENCE_LABELS: Record<PresenceBucket, string> = {
  online: 'Online now',
  today: 'Seen today',
  week: 'Seen this week',
  longer: 'Away for a while',
};
