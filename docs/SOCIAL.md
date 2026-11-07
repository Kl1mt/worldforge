# Social safety & moderation

Ticket 4.1 builds the safety foundation every later Phase 4 ticket uses (ROADMAP "Phase 4 ground rules": *safety before reach*). This file is the contract for those tickets: a profile, friend, guild or chat route that stores player text or reaches another player uses the pieces below and adds nothing parallel.

Code: `packages/game-core/src/social/` (rules and data, usable by server and client) and `apps/server/src/social/` (routes, helpers, CLI). Endpoints are listed in `API_CONVENTIONS.md`, tables in `DATA_MODEL.md`.

## Checklist for a new social feature

1. **Text:** every player-written string goes through `assertPlayerText(kind, raw, field)` on the server (the client may call game-core `validatePlayerText` for instant feedback). Add a kind to `PLAYER_TEXT_RULES` if none fits. Store the returned (normalised) value.
2. **Write:** the route runs behind `app.requireAccount` and does its work inside `socialWrite(app, request, reply, action, fn)` (or calls `assertSocialWriteAllowed(tx, …)` first inside its own transaction helper, e.g. `idempotentTransaction`). Name a new `SocialWriteAction` (`'chat'`, `'guildCreate'`, …).
3. **Report:** add the new target to game-core's `ReportTarget` union and `REPORT_TARGET_KINDS`, a resolver in `apps/server/src/social/targets.ts` (`RESOLVERS`) and a branch in `reportTargetSchema`; open `ReportDialog` with a fixed `target` from the UI.
4. **Blocks and relations:** anything that shows one player to another, or lets one reach another, asks the relationship model (below): a block either way hides each from the other (`isBlockedEitherWay`, or `blockedEitherWay` to filter a list). Profiles (ticket 4.2) do this in one place: `viewableProfileOwner` / `canViewProfile` ("Profiles" below).
5. **Hide:** if the content is `hideable`, filter it out of other players' views with `hiddenTargetKeys(executor, keys, now)`.
6. **Permissions:** new moderator actions go into `MODERATION_ACTIONS` and the hand-written table in `permission-matrix.test.ts`.
7. **Races and journey:** a real-PG race test for anything shared; a step in `e2e/journey.ts`.

## Player text

`validatePlayerText(kind, raw)` → `{ ok: true, value }` or `{ ok: false, value, problem, message }`; `problem` is one of `too_short`, `too_long`, `pattern`, `link`, `reserved`, `blocked`. The server's `assertPlayerText` turns a failure into `400 validation_failed` with `details.fields[field]` (message) and `details.problems[field]` (code).

**Normalisation** (`normalizePlayerText`): Unicode NFKC (full-width and mathematical letters become plain), invisible characters removed (`\p{Cf}`: zero-width, bidi controls, soft hyphen, tag characters; plus Hangul fillers and the Braille blank), other control characters removed, whitespace runs collapsed to one space (multiline kinds keep single line breaks, at most two in a row), stacked combining marks capped at two per letter, trimmed. Lengths count code points after normalisation.

| Kind | Length | Shape | Block list | Reserved names | Links |
|---|---|---|---|---|---|
| `displayName` | 3–20 | letters/digits, single inner space, `-`, `'`, `_` | yes | yes | no |
| `guildName` | 3–24 | as display name | yes | yes | no |
| `guildTag` | 2–5 | `A–Z`, `0–9` | yes | yes | no |
| `profileField` | 0–160 | single line | yes | no | no |
| `chatMessage` | 1–300 | single line | yes | no | no |
| `guildNotice` | 1–400 | multiline (ticket 4.5) | yes | no | no |
| `reportNote` | 0–500 | multiline | no (moderators need the words) | no | kept as plain text |
| `sanctionReason` | 3–300 | single line, moderator-written | no | no | kept as plain text |

**Block list** (`blocklist.ts`, data): `BLOCKED_TERMS` for every filtering kind, `RESERVED_NAME_TERMS` (admin, moderator, mod, gm, staff, worldforge, …) for name kinds. Matching folds case, accents, Cyrillic/Greek/small-capital look-alikes and leetspeak (`0→o`, `1→i`, `3→e`, `4/@→a`, `5/$→s`, `7/+→t`, …), lets each letter repeat (`fuuuck`), and treats everything else as a separator. `anywhere` terms match across separators and inside words (`f.u.c.k`, `xfuckx`); `word` terms match whole words with common suffixes (`-s`, `-er`, `-ing`, …) and runs of single letters are joined first (`s h i t`), so innocent words pass (`Scunthorpe`, `assassin`, `cocktail`, `Niger`, `fire retardant`). Doubled letters in a term stay required (so `nigger` does not match `Niger`). Not handled (accepted): phonetic spellings (`phuck`), letters replaced by `*`, words split in two halves.

**Link policy** (Phase 4: no links): `http(s)://`, `www.`, a word followed by `.`/`(dot)`/` dot ` and a common TLD, and Discord invites are refused (`problem: 'link'`). Report notes and sanction reasons keep links as plain text; they are never rendered as links.

## Handles

Every account has a `handle`: 12 characters from `0123456789abcdefghjkmnpqrstvwxyz` (60 random bits, `crypto.randomBytes`), generated on insert, permanent, unique, and unrelated to the account id or anything else. Public views and report targets name players by handle and display name only; never by account id, email or IP. Nothing (seed, reward, order) may derive from a handle.

## Roles

`accounts.role`: `player` (default), `moderator`, `admin`. Changed only by the CLI; there is no API path, and the registration and account bodies reject a `role` field:

```
pnpm admin:role grant <email|handle> <moderator|admin>
pnpm admin:role revoke <email|handle>            # back to player
pnpm --filter @worldforge/server admin:role:prod …   # from dist/, in production
```

It uses `DATABASE_URL`, locks the account row and writes `role.grant` / `role.revoke`. The owner grants themselves `admin` first.

**Permission matrix** (game-core `moderationDecision`; tested role × every action × subject in `permission-matrix.test.ts`):

| Actor ↓ / subject → | self | player | moderator | admin |
|---|---|---|---|---|
| player | 404 | 404 | 404 | 404 |
| moderator | 403 | allowed | 403 | 403 |
| admin | 403 | allowed | allowed | 403 |

Actions: `viewQueue` (allowed for staff, 404 for players), `dismissReport`, `mute`, `suspend`, `forceRename`, `hideContent`, `liftSanction`, and (ticket 4.4, on a reported guild whose leader is the subject) `renameGuild`, `disbandGuild`. Nobody acts on themselves; a subject of the actor's rank or higher is out of reach. Reports about admins are handled outside the app (the queue never shows a case its viewer cannot act on). Every action re-reads the actor's role under a share lock, so a revoke racing an action either precedes it (404) or follows it.

**404 for non-staff:** `/api/mod/*` uses `app.requireStaff` as an `onRequest` hook, before body validation, so players and anonymous visitors get exactly the not-found handler's body, whatever they send. The web client treats `#/moderation` like an unknown address for players.

## Admin panel — ticket D.3

`#/admin` (linked in the footer for admins only; for anyone else the address behaves like an unknown one) on `/api/admin/*` (`apps/server/src/admin/`, docs/API_CONVENTIONS.md). Every route answers the not-found handler's exact `404` to anonymous visitors, players and moderators, before body validation (`app.requireAdmin` as the scope's `onRequest` hook, like `requireStaff` for `/api/mod/*`); tested per role × route in `admin/admin.test.ts`. Admin requests count against 3.9's per-account limits; the audit-log reconcile has a stricter class of its own.

- **Roles stay CLI-only.** The panel lists moderators and admins read-only and shows the `deploy/admin.sh grant|revoke` commands. No API path grants or revokes a role, so a stolen admin session cannot mint admins or lock the owner out. A role revoked by the CLI stops the next admin request (the session is re-checked on every request; mutations re-read the role under a share lock).
- **No emails.** Decision: the panel never shows a player's email, not even to admins. Players are identified by handle and display name, like in the moderator queue; the search matches only those. An admin who must contact a player by email does it on the server (`deploy/admin.sh`, the database). This keeps a stolen admin session from harvesting addresses.
- **Read-only player files.** Account age, role, the invite used at registration (its note), heroes (class, level), every sanction (active, expired, lifted; issuer, lifter, reasons) and reports about them. No account ids and no presence times. Open reports link into the moderator queue (`#/moderation?case=<report id>` opens the case holding it); acting happens there, under the queue's rules (reports about admins are handled outside the app).
- **Invite codes** are shown once, in the create response, and never again: the list, the logs and the audit rows carry only the invite id. Revoking is by id.
- **Audit:** every admin request writes a row on the admin's account: `admin.view` (`section`: invites, telemetry, status, roles), `admin.player.search` (result count only, never the query), `admin.player.view` (`handle`), `admin.telemetry.reconcile` (`ok`), and D.2's `invite.create` / `invite.revoke` with `via: 'admin'`. No codes, emails, IPs or search text.

## Reports

`POST /api/reports` with a `ReportTarget`, a reason (`REPORT_REASONS`) and an optional note. Today's targets: `{ kind: 'guild', handle }` (ticket 4.4: a guild's opaque handle; subject = its leader at the time; key `guild:<guild id>`; not hideable, see "Guilds"), `{ kind: 'player', handle }`, `{ kind: 'profileField', handle, field: 'displayName' }` and (ticket 4.2) `{ kind: 'characterName', handle, name }` (key `characterName:<character id>`, hideable: a hidden hero name shows as "Name withheld" on the profile; the queue's `current.value` is the hero's current name), and (ticket 4.5) `{ kind: 'message', id }` (a guild chat line or notice; key `message:<message id>`; hideable: a hidden line is a tombstone; subject = its author; only a player who can see the line may report it, see "Guild chat"). One open report per reporter and target (partial unique index; a concurrent duplicate gets `409 report_open`). The report stores a context snapshot (the display name as seen), so later renames keep the evidence. A muted player can still report; self-reports are refused. Every report writes `report.create`.

The moderator queue groups open reports by target into cases, oldest first, with the subject's handle, name, role, active sanctions and past-sanction count, and each report's reason, note and reporter. Acting on any report of a case (dismiss or a sanction) closes every open report on that target; a second moderator acting on the same report gets `409 report_closed`.

## Sanctions

| Kind | Action | Effect |
|---|---|---|
| `mute` | `mute` | No social writes (`403 muted`), except `report` and `rename`. Play continues. |
| `suspend` | `suspend` | No login (`403 account_suspended` after a correct password) and every request of a live session answers `403 account_suspended` at once (checked in `requireAccount` on each request). Sessions are not revoked, so they work again when it expires. |
| `rename` | `forceRename` | The display name becomes a placeholder (`Wanderer 482913`) at once; the player chooses a new one (`POST /api/account/display-name`, not the old name) within the duration. Lifting it restores the old name if still free. |
| `hide` | `hideContent` | Hides one `hideable` target (the display name, a hero name) from other players (the lookup and the profile); kinds other than content answer `422 not_hideable`. |

Every sanction has a reason (shown to the player), an expiry (`SANCTION_DURATIONS`: presets and bounds per kind), an issuer, and audit rows (`sanction.issue` on the subject's account with the issuer in the data; `sanction.lift`). One active sanction per kind (and per content for `hide`): a second is `409 already_sanctioned`, lift first. The player sees active sanctions in `GET /api/account/standing`, in the shell's standing strip and the account screen; the `403` bodies carry the sanction (`details.sanction`).

**Locking:** sanction issue locks the subject's account row `FOR UPDATE`; every social write share-locks the writer's row before checking sanctions, so a write either commits before the sanction or sees it. Lock order everywhere: actor (share) → report → subject account (update) → sanctions.

## Social writes

`socialWrite` counts each write in the **social-write rate-limit class** before any work (in-process, per account, on top of 3.9's limits): **12 a minute and 240 an hour** by default (`DEFAULT_SOCIAL_WRITE_LIMIT`, sized for guild chat at one message every 5 s), `429 rate_limited` with `Retry-After` and `details.limit: 'social'`. Refused writes are not counted. Configurable per app (`auth.socialWriteLimit`). Like the other limits it lives in process memory (one API instance).

## Profiles

Ticket 4.2. Code: game-core `social/profiles.ts` (`PROFILE_VISIBILITIES`, `PROFILE_RELATIONS`, `canViewProfile`), server `apps/server/src/social/profiles.ts` (routes, `profileRelation`, `viewableProfileOwner`, `profileView`), web `screens/ProfileScreen.tsx` (`#/profile`, `#/profile/<handle>`).

- **Reached** by display name (`GET /api/players/lookup?name=`, the search on the profile page and the report dialog) or handle (`?handle=`, `GET /api/players/:handle/profile`). Logged-in players only.
- **Shows** the display name, the handle, every hero (name, class, level, banner portrait), the achievements the owner picked (up to `MAX_SHOWN_ACHIEVEMENTS` = 5, in their order, with the award day), and optionally one hero's equipped gear (the showcase; never the pack). No account id, email, character or item id, seed, or time finer than a day.
- **Visibility** (`accounts.profile_visibility`): `public` (default), `friendsAndGuild`, `hidden`. The viewer's relation (`self`, `friend`, `guildmate`, `pending`, `stranger`, `blocked` either way) and `canViewProfile` decide; a `false` is `404 not_found` with the same body as an unknown player, for the profile and the lookup. The owner always sees their own.
- **Relations come from 4.3** ("Relations"): `profileRelation` maps `relationBetween`: `blocked-by-me` / `blocked-by-them` → `blocked` (404 for the profile, the lookup and the showcase, either way), `friend` → `friend`, `requested-by-me` / `requested-by-them` → `pending` (treated like a stranger). Ticket 4.4: a shared guild maps to `guildmate` (unless a friendship or a block decides first), so "friends and guild" includes guildmates; it is read live, so leaving or a kick closes the profile at once. Names in the friends list link to the profile (blocked players' do not).
- **Settings:** `POST /api/account/profile` (social write `profile`, rate limited, audited `profile.update`; exempt from mutes because it carries no player text and a muted player must be able to hide their profile).
- **Report action** on every other player's profile: the player, and each visible hero name (`characterName`). The display name is reported from the report dialog's "their display name".

## Achievements

Ticket 4.2, GDD §5.3 (account-bound). Cosmetic only: no achievement grants power.

- **Definitions** are data in game-core `achievements/definitions.ts` (`ACHIEVEMENTS`): id, name, description, category, an icon asset id for the art ticket A.8 (the client shows a wax-seal placeholder until then), and one typed criterion: `itemRarity`, `upgradeLevel`, `characterLevel`, `gravewardenDefeated`, `cryptTier`, `fullSet`, `contracts`, `storyQuest`. `achievementsEarned(facts)` is pure; a fact that was not collected earns nothing.
- **Live awards** (`apps/server/src/achievements/award.ts`): the events that already exist call `refreshAchievements(tx, character, factKeys, now)` inside their own transaction, after their change: the settlement (drops, levels; only when it granted items or a level), the crypt claim (drops, level, boss, tier), the quest turn-in (story or contract count, level, reward item), the forge upgrade and craft, the merchant purchase, and equipping a set piece. Facts are read from the character's state in that transaction (contracts count across the account).
- **At most once:** `account_achievements` has the primary key `(account_id, achievement_id)`; awards insert with `on conflict do nothing`, and only the transaction whose insert created the row writes the `achievement.award` audit row. Two heroes of one account, a live award and the backfill, or two backfills racing all end with one row and one audit row (real-PG test `achievements.pg.test.ts`).
- **Backfill** (`backfill.ts`): run by `migrate-cli` after the migrations (docs/DEPLOY.md "Data backfills"), once per database and achievement id list. It uses each hero's state plus the audit log for lost history: the rarity of sold, salvaged and discarded items (`merchant.sell`, `forge.salvage`, `item.discard`), notable drops, crafted, bought and quest-reward items, and every `forge.upgrade`'s `toLevel`. Loot-filter salvage (`filtered`) was never owned and does not count. Not recoverable (accepted): a set worn in the past but no longer.
- **Showing:** the owner picks up to five earned achievements (`shown_slot`); the profile shows those only.

**Adding an achievement:** append a definition (never rename or reuse an id), make sure its fact is collected by `characterFacts` (and the backfill if history matters) and called from the event that changes it, and list the new icon id for the art ticket. The next deploy backfills it.
## Relations (friends, requests, blocks) — ticket 4.3

Code: game-core `social/relations.ts` (the matrix, caps, presence buckets) and server `apps/server/src/social/relations.ts` (the reusable API) and `friends.ts` (routes). Tables: `friendships` (one row per unordered pair, `account_low < account_high`; `pending` with `requested_by`, or `friends`), `blocks` (directional), `account_presence`.

**The API for other features** (internal account ids in, never shown to players):

| Helper | Answers |
|---|---|
| `relationBetween(executor, viewerId, targetId)` | `'self' \| 'stranger' \| 'requested-by-me' \| 'requested-by-them' \| 'friend' \| 'blocked-by-me' \| 'blocked-by-them'` |
| `relationsFor(executor, viewerId, targetIds)` | `Map<id, Relation>` for a list, two queries whatever its length |
| `isBlockedEitherWay(executor, a, b)` | either blocks the other |
| `blockedEitherWay(executor, viewerId, ids?)` | the ids (of `ids`, or of everyone) the viewer must not see: blocked by or blocking the viewer |
| `friendIds(executor, accountId)` | accepted friends |
| `presenceOf(executor, ids, now)` | `Map<id, PresenceBucket \| null>` (null = hidden); the caller checks who may see it |
| `lockSocialAccounts(tx, ids)` | takes each account's social lock (advisory, transaction-scoped, sorted); hold it to change a relation |

game-core: `relationFromFacts`, `friendDecision(relation, action)`, `visibleRelation` (`blocked-by-them` → null: answer as for an unknown player), `isBlockRelation`, `FRIEND_LIMITS`, `presenceBucket`, `PRESENCE_LABELS`. The client can ask `GET /api/players/:handle/relation`.

How later tickets use it: **4.2** profiles answer `404` when `isBlockedEitherWay`, and `friends and guild` privacy means `relation === 'friend'` (or a guildmate, 4.4). **4.4** guild invites refuse a block either way and show guildmates' presence through `presenceOf` (respecting `hidden`). **4.5** chat leaves out lines whose author is in `blockedEitherWay(viewer)`.

**The relation matrix** (game-core `FRIEND_MATRIX`; tested per relation × action in `friends.test.ts` against a hand-written table). Codes are the error codes; ✓ is allowed, with the relation afterwards.

| Action ↓ / relation → | stranger | requested-by-me | requested-by-them | friend | blocked-by-me | blocked-by-them |
|---|---|---|---|---|---|---|
| sendRequest | ✓ requested-by-me | 409 request_pending | ✓ friend (accepts theirs) | 409 already_friends | 409 blocked_by_you | 404 not_found |
| accept | 404 no_request | 404 no_request | ✓ friend | 409 already_friends | 404 no_request | 404 not_found |
| decline | 404 no_request | 404 no_request | ✓ stranger | 404 no_request | 404 no_request | 404 not_found |
| cancel | 404 no_request | ✓ stranger | 404 no_request | 404 no_request | 404 no_request | 404 not_found |
| remove | 404 not_friends | 404 not_friends | 404 not_friends | ✓ stranger | 404 not_friends | 404 not_found |
| block | ✓ | ✓ (drops the request) | ✓ (drops the request) | ✓ (ends the friendship) | 409 already_blocked | ✓ |
| unblock | 404 not_blocked | 404 not_blocked | 404 not_blocked | 404 not_blocked | ✓ stranger | 404 not_found |
| report | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| viewPresence | — | — | — | ✓ (unless hidden) | — | — |

Self: `422 cannot_target_self` (`cannot_report_self` for reports). A player who blocks you is answered exactly like an unknown player, so a block is never announced; you may still block them back and report them. A block wins over everything in `relationFromFacts` (yours over theirs, so you can always see and lift your own).

**Writes:** every action runs in `socialWrite` (social rate-limit class) and holds both accounts' social locks while it reads the relation, checks the matrix and the caps, and writes. Mutes block `friendRequest` and `friendAccept` (reaching someone); `friendDecline`, `friendCancel`, `friendRemove`, `block` and `unblock` are mute-exempt (stepping away is always allowed). Audit: `friend.request`, `friend.accept`, `friend.decline`, `friend.cancel`, `friend.remove`, `friend.block` (with what it removed), `friend.unblock`, `presence.setting`.

**Caps** (`FRIEND_LIMITS`, exact under races): 100 friends (`409 friend_limit`, or `friend_limit_them` for the other side), 25 requests waiting that you sent (`request_limit`), 50 waiting in an inbox (`inbox_full`), 500 blocks (`block_limit`). Answering a waiting request needs no request slot.

## Presence — ticket 4.3

A bucket from the last authenticated request (any route behind `requireAccount`): `online` (≤ 10 min), `today` (≤ 24 h), `week` (≤ 7 days), `longer` (or never). A guildmate who blocks you, or whom you block, shows `null`. Shown to friends and (ticket 4.4) guildmates on the guild page; the player can hide it (one setting for both) (`POST /api/account/presence`), and then friends get `null`. **No timestamp leaves the server**: no route returns `last_seen_at`, and the friends list carries no times at all (tested: no date or epoch in the body).

**Cheap recording:** `createPresenceRecorder` keeps the last write per account in process memory and upserts `account_presence` at most once every **3 minutes** per account (`PRESENCE_WRITE_INTERVAL_MS`), whatever the request rate: under 3.9's limit of 900 requests a minute that is still ≤ 0.34 writes a minute per account, and a busy game tab (settle every 8 s) costs one write per 3 min instead of 22. The upsert touches only `account_presence` (never the locked account row), never moves the time backwards (`greatest`), and a failure is logged without failing the request. A restart forgets the memory, so the first request after it writes once. `online` (10 min) covers several write intervals, so an active player never flickers.

**Accepted:** a friend who polls the list can tell roughly when you went quiet (the moment `online` turns into `today`, ±3 min); that is what "online now" means. Hide presence to avoid it.

**Polling:** the friends screen polls `GET /api/friends` every 60 s and the shell (request badge) every 2 min; the response carries an `ETag` and `Cache-Control: private, no-cache`, so the browser revalidates and an unchanged list is a `304`. That is ≤ 1.5 requests a minute per tab, far below 3.9's 900.

## Race tests

`apps/server/src/social/social.pg.test.ts` (real PostgreSQL, part of `test:pg`, three rounds each in varied orders, asserting only what holds in every order): concurrent duplicate reports on one target; a mute racing the target's social writes; a suspension racing the target's requests; several moderators acting on one report; a role revoke racing the moderator's actions; no deadlock or retry.

`apps/server/src/social/friends.pg.test.ts` (ticket 4.3): both players of many pairs sending a request at once → one friendship each (one request and one accept audited); a block racing an accept → always blocked, never friends, with the block's audit saying whether it removed a friendship or a request; an unfriend or a cancel racing an accept → the final state matches the audit log; concurrent accepts and sends at the friend and inbox caps → exactly one succeeds. Without the social locks every one of these fails.

## Guilds — ticket 4.4

Code: game-core `social/guilds.ts` (roles, `guildDecision`, `GUILD_LIMITS`, `GUILD_CREATE_COST`, `GUILD_EMBLEMS`), server `apps/server/src/social/guild-model.ts` (helpers, locks, disband and forced rename) and `guilds.ts` (routes), web `screens/GuildScreen.tsx` (`#/guild`, `#/guild/<handle>`). Tables: `guilds`, `guild_members`, `guild_invites`, `guild_applications` (`DATA_MODEL.md`).

**Owner-confirmed defaults:** founding costs **5,000 gold** from one of the founder's heroes (a sink; `gold.out guild_create`), **30 members** at most, **one guild per account** (the membership table's primary key is the account).

**Founding** (`POST /api/guilds`): an `Idempotency-Key` value operation. Name (`guildName`, 3–24) and tag (`guildTag`, 2–5, upper-cased) go through the text module and are unique case-insensitively among existing guilds (a disbanded guild frees both). In one transaction: share lock on the account → the hero's lock (its activity settles first) → the founder's social lock → the name and tag locks; then the gold is charged, the guild and the leader's membership written, `guild.create` audited (hero, gold, gold after) and the telemetry recorded. Telemetry reconciles with the audit log (`reconcileWithAudit`: "guilds: founded", "guilds: founding gold").

**The permission matrix** (game-core `guildDecision`, tested through the API for every standing × action × target in `guild-permissions.test.ts`, 140 cells plus the block cells; the client draws its buttons from the same function):

| Action ↓ / actor → | leader | officer | member | not a member |
|---|---|---|---|---|
| create, apply, accept an invite | 409 already_in_guild | 409 | 409 | ✓ |
| decline an invite, withdraw a petition | ✓ | ✓ | ✓ | ✓ |
| see requests, invite, withdraw an invite, accept / decline a petition | ✓ | ✓ | 403 guild_forbidden | 404 not_in_guild |
| kick | ✓ officer, member | ✓ member only | 403 | 404 |
| promote (member → officer), demote (officer → member), transfer leadership | ✓ | 403 | 403 | 404 |
| emblem, disband, rename (after a forced rename) | ✓ | 403 | 403 | 404 |
| leave | 409 leader_must_hand_over | ✓ | ✓ | 404 |

On oneself: `422 cannot_target_self`. A target outside the guild: `404 not_a_member`. A target of equal or higher rank: `403`. Promoting an officer `409 already_officer`, demoting a member `409 not_an_officer`. Transfer makes the leader an officer and the target the leader. A leader leaves by handing over first, or disbands (typing the guild's name).

**Invites and applications:** an officer invites by handle or display name; the player answers from their Guild Hall. A player applies from a guild's profile; an officer takes them in. Applying while invited, or inviting an applicant, joins at once. Joining drops the joiner's other invites and applications. Caps (`GUILD_LIMITS`, exact under races): 30 members (`409 guild_full`, also checked when accepting), 30 invites waiting per guild, 20 per player, 30 applications per guild, 5 per player.

**Blocks** (4.3's helpers): an officer cannot invite a player they block (`409 blocked_by_you`) or one who blocks them (`404 not_found`, like an unknown player). A guild is the leader's: to a player who blocks its leader, or is blocked by them, it does not exist (profile, search and apply all answer the unknown-guild `404`; an invitation from it is hidden). An officer does not see, and cannot answer, petitions from players they block or who block them; an invitation from an officer the invitee blocks since is gone (`404 no_invite`). Members who block each other stay guildmates: the blocker sees the other's row without a name or presence (officers still act on it), the blocked side sees no presence. Chat (4.5) leaves out each other's lines (see "Guild chat").

**Presence and profiles:** the guild page shows every member's presence bucket (`presenceOf`, `null` when hidden or blocked either way); outsiders see members and roles only. `profileRelation` maps a shared guild to `guildmate`, so "friends and guild" profiles open to guildmates. Everything reads membership live: a leave or a kick takes effect at once in every guild feature.

**Locks:** a membership row changes only under the guild's advisory lock (`lockGuild`), and a join also under the joiner's social lock, so the cap and "one guild per account" are exact (the primary key and the one-leader index are the backstops). Order: actor's account (share, `socialWrite`) → social locks (sorted) → guild lock; founding: account → hero → social → name locks; moderators: actor → report → subject (update) → guild.

**Social writes and mutes:** every guild write is a social write (rate limit, sanctions). A mute blocks reaching others (`guildCreate`, `guildInvite`, `guildApply`, `guildAcceptInvite`, `guildAcceptApplication`, kicks and role changes, the emblem) and leaves stepping away open (`guildLeave`, `guildDisband`, `guildDeclineInvite`, `guildCancelApplication`, `guildInviteCancel`, `guildDeclineApplication`) as well as the forced `guildRename`.

**Moderation:** any player reports a guild from its profile (`{ kind: 'guild', handle }`). In the queue a guild case shows "Name [TAG]" and its leader; besides dismiss, mute and suspend (on the leader), staff may **rename the guild** (`renameGuild`: name and tag become placeholders such as "Nameless Company 482913" / "X4821" at once; the leader must pick new ones, not the removed name; the members see the reason on the guild page) or **disband it** (`disbandGuild`: everyone removed; members see "disbanded by the wardens" and the reason for a week). Both follow `moderationDecision` (rank rule against the leader) and close the case; audited as `guild.force_rename` (on the leader, issuer in the data) and `guild.disband` (`byModerator`, reason, members).

**Audit events:** `guild.create`, `guild.invite`, `guild.invite_cancel`, `guild.invite_decline`, `guild.apply`, `guild.application_cancel`, `guild.application_decline`, `guild.join` (`via` invite or application, `by`), `guild.leave` (with the role and, ticket 4.5, `chatSeq`: the guild's newest chat line at that moment), `guild.kick` (also `chatSeq`), `guild.promote`, `guild.demote`, `guild.transfer`, `guild.emblem`, `guild.rename`, `guild.force_rename`, `guild.disband` (the members). The membership of a guild is exactly what these say (checked by the race tests).

**Emblems** (`GUILD_EMBLEMS`; placeholders drawn as a glyph on a shield until A.8): `anvil`, `crow`, `tower`, `flame`, `skull`, `oak` (asset ids `guild-emblem.<id>`). Never rename or reuse an id.

**Polling:** the Guild Hall polls `GET /api/guild` every 60 s with an `ETag` (`304` when unchanged).

**Races** (`guilds.pg.test.ts`, real PostgreSQL, three rounds in varied orders, no retries): founders racing for one name (one guild, one charge; gold, audit and telemetry reconcile) and for one tag, one account founding twice; invites and applications accepted at once at 29 members (exactly one joins); one player accepted by several guilds at once (joins one); accepts racing a disband (the guild ends empty, every audited join was in the disband's member list); leaves racing promotions (a promotion that won shows in the leave's role); the leader handing over to an officer while each kicks or demotes the other and officers kick each other (always one leader, never both removed, the roster equals the audit log). Without the guild lock three of these fail.

## Guild chat — ticket 4.5

Code: game-core `social/guild-chat.ts` (`guildChatDecision`, `GUILD_CHAT_LIMITS`, tombstones), server `apps/server/src/social/chat-model.ts` (`visibleMessage`, `messageTargetKey`, `latestSeq`) and `guild-chat.ts` (routes), web `social/guildChat.ts` (`useGuildChat`) and `screens/GuildChat.tsx` (the chronicle in the Guild Hall). Table: `guild_messages`, plus `guilds.notice_message_id` (`DATA_MODEL.md`). Endpoints in `API_CONVENTIONS.md`.

**Owner-confirmed default:** guild chat is the only player-to-player communication in Phase 4. No global chat, no direct messages.

**The permission matrix** (game-core `guildChatDecision`, tested through the API in `guild-chat.test.ts` against a hand-written table; the client draws its buttons from the same function). "Blocked" is an officer with a block either way with the line's author:

| Action ↓ / actor → | leader | officer | member | not a member | blocked (either way) |
|---|---|---|---|---|---|
| read | ✓ | ✓ | ✓ | 404 not_in_guild | ✓, without the other's lines |
| post | ✓ | ✓ | ✓ | 404 | ✓ |
| set / take down the notice | ✓ | ✓ | 403 guild_forbidden | 404 | ✓ |
| report a line | ✓ | ✓ | ✓ | 404 not_found | 404 not_found |
| remove own line (`withdrawn`) | ✓ | ✓ | ✓ | 404 | — |
| remove a member's or former member's line (`removed`) | ✓ | ✓ | 403 | 404 | 404 message_not_found |
| remove an officer's line | ✓ | 403 | 403 | 404 | 404 message_not_found |
| remove the leader's line | (own) | 403 | 403 | 404 | 404 message_not_found |

Reporting one's own line: `422 cannot_report_self`. A line of another guild, or an unknown id: `404` like an unknown line. Removing twice: `409 message_removed`.

**Text and writes:** posts use the text module's `chatMessage` (1–300, one line, block list, no links), the notice `guildNotice` (1–400, up to a few lines). Every write is a social write (rate limit, sanctions): `chat` and `guildNotice` are blocked by a mute (`403 muted` with the sanction; the chat shows the reason in place of the input), `chatDelete` is mute-exempt (removing a line adds nothing). Writes hold the guild's lock (`lockGuild`), the same lock every membership change takes, and re-read the membership under it: a post racing a kick lands before it or is refused.

**Ordering and cursors:** each line's `seq` is `max(seq) + 1` for its guild, computed under the guild's lock and held to commit, so lines commit in `seq` order and the committed lines are always `1..n`. A poll asking for `seq > since` therefore never skips a line that commits later with a lower number. Pages: the newest 30 first ("Earlier entries" loads 30 more with `before`), polls return up to 50 new lines oldest first (`more` beyond that: the client reloads the newest page). Readable history: the newest **500** lines and none older than **30 days**; older rows stay stored for moderation, unserved (pruning is left to 4.11).

**Reads in one snapshot:** `GET /api/guild/chat` runs in a read-only `repeatable read` transaction. The membership check, the blocks, the lines and the hidden keys come from the same moment, so a poll racing a kick either sees the member and only lines from before the kick, or answers `404 not_in_guild`; the web client then clears the chat at once and refreshes the hall. (`guild.kick` / `guild.leave` record `chatSeq`, the newest line at that moment; the race test checks no read or post of the departed reaches past it.)

**Tombstones:** a line withdrawn by its author, removed by an officer, or hidden by a moderator (an active `hide` sanction on `message:<id>`, through the queue: report → "Hide content") is sent as `{ text: null, tombstone }` to everyone, the author included (they see the sanction and its reason in their standing). The words are never sent; they stay in the row and in the report's snapshot, and the queue shows them (marked "removed by an officer" if so). Removing the notice's line takes the notice down; a hidden notice shows as a tombstone on the parchment. A poll re-reads the removal state of up to 200 lines below its cursor (`from`) and returns those that turned into tombstones (`revised`); older lines held on screen update on the next reload.

**Blocks** (4.3): lines by a player the viewer blocks, or who blocks the viewer, are left out of every page, poll and the notice, and acting on them answers `404 message_not_found` (a block is never announced). A poll returns the `seq`s of such lines below its cursor as `gone`, so a block made while the chat is open removes them at once. Other officers still see and moderate those lines.

**Polling and load** (3.9 allows 900 requests and 300 actions a minute per account; 4.1's social class 12 writes a minute, 240 an hour):

| | Per member | A busy guild (30 members, all with chat open) |
|---|---|---|
| Chat polls | every 5 s while visible = **12/min**; every 30 s while hidden = 2/min | 30 × 12 = **360 polls/min** (6 a second) |
| Other polling while the hall is open | guild page 1/min, shell badge 0.5/min | 45/min |
| Share of 3.9's limit | ≈ 14 of 900 requests a minute (1.5 %) | — |
| Posts | ≤ 12/min, 240/h (social class) | worst case 360/min; a 5 s poll then holds ≤ 30 new lines, under the 50 per poll, so a polling client never falls behind |
| Server reads per poll | ≤ 9 indexed reads in one snapshot: membership + guild, roster (≤ 30 rows), blocks, newest `seq`, active mute, the lines (`(guild_id, seq)` index, ≤ 51 rows), the removal window (polls only, ≤ 200 slim rows), the notice (if set), hidden keys (`sanctions.target_key` index); no writes (presence writes at most every 3 min) | ≈ 360 × 9 ≈ 3,240 reads/min (54/s) at the worst case; an unchanged answer is a `304` without a body |
| Server work per post | the guild lock, two membership reads, `max(seq)` (index), one insert | — |

**Moderation:** any member reports a line or the notice from the chat (the 4.1 dialog with a fixed `{ kind: 'message', id }`); the queue shows "Guild chat in <guild> · “<the words>” · by <author>" with dismiss, mute, suspend, force rename (the author's display name) and hide content. Audit: `guild.chat_remove` (message, author, `withdrawn`/`removed`), `guild.notice` (new and previous line). Posts are not audited one by one (the table is the record).

**Races** (`guild-chat.pg.test.ts`, real PostgreSQL, three rounds in varied orders, no retries): eight members posting six lines each at once while the leader polls: `seq` is exactly `1..48`, the poller saw every line exactly once in `seq` order, each author's lines are in the order they were sent, and paging back from the newest page joins up exactly; a member polling and posting without pause while others post and the leader kicks them part-way: no read or post of theirs reaches past the kick's `chatSeq`, and afterwards they get `404`. Without the guild lock both fail (duplicate `seq`); with the reads outside one snapshot the kick race fails once the gap between the membership check and the line read is widened (checked by hand with a 20 ms delay; the snapshot version passes with the same delay).
