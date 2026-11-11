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

Ticket 4.11 (review findings): capital letters of other scripts that look like Latin capitals (Greek `ΑDΜΙΝ`, Cyrillic `МОDЕRАТОR`, Cherokee `Ꮪ`) are folded *before* lower-casing (their own small forms look different: `Ν` → `ν` read as `v`), and a few more small look-alikes (Armenian `ս`, `օ`; small capital `ꜰ`). A capital `I` and a small `l` look alike, so every term is also matched with both read as `i` (`ADMlN`, `WorIdforge`). The server's placeholder names (`Wanderer 482913`, `Nameless Company 482913`: six digits) are reserved for name kinds. Still not handled (accepted): a display name that copies another player's with a look-alike letter (`Аlice` next to `Alice`, uniqueness compares `lower()` only) and a forced rename dodged that way; it needs a confusable skeleton stored per name (a migration), left for a later ticket. Names already taken before this ticket are not re-checked.

**Link policy** (Phase 4: no links): `http(s)://`, `www.`, a word followed by `.`/`(dot)`/` dot ` and a common TLD, and Discord invites are refused (`problem: 'link'`). Report notes and sanction reasons keep links as plain text; they are never rendered as links. Ticket 4.11: a dot also counts as written `。`, `｡`, `․`, `·`, `(.)`, `[.]` or `{.}`; one-letter names count (`t.me`); more country domains (`.fr`, `.ca`, `.ws`, `.ai`, …, not ones that are English words such as `.it` or `.is`); `hxxp://` and spaced-out `h t t p s : / /`, bare IPv4 addresses and `discord gg` are refused. A dot with spaces around it (`example . com`) counts only when the domain ends the text or a `/` or `:` follows, so a sentence end such as "Done. Me next" or "Ok. Co-op tonight?" is no longer refused (it was). The guild notice is at most **8 lines**.

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

Actions: `viewQueue` (allowed for staff, 404 for players), `dismissReport`, `mute`, `suspend`, `forceRename`, `hideContent`, `liftSanction`, (ticket T.4) `restrictTrade`, (ticket T.6) `reverseTrade` (a completed trade between the subject and a player: **both** players must be in reach, so a moderator never reverses a trade with another moderator or an admin in it, and nobody reverses their own; docs/TRADING.md "T.6 as built"), and (ticket 4.4, on a reported guild whose leader is the subject) `renameGuild`, `disbandGuild`. Nobody acts on themselves; a subject of the actor's rank or higher is out of reach. Reports about admins are handled outside the app (the queue never shows a case its viewer cannot act on). Every action re-reads the actor's role under a share lock, so a revoke racing an action either precedes it (404) or follows it.

**404 for non-staff:** `/api/mod/*` uses `app.requireStaff` as an `onRequest` hook, before body validation, so players and anonymous visitors get exactly the not-found handler's body, whatever they send. The web client treats `#/moderation` like an unknown address for players.

## Admin panel — ticket D.3

`#/admin` (linked in the footer for admins only; for anyone else the address behaves like an unknown one) on `/api/admin/*` (`apps/server/src/admin/`, docs/API_CONVENTIONS.md). Every route answers the not-found handler's exact `404` to anonymous visitors, players and moderators, before body validation (`app.requireAdmin` as the scope's `onRequest` hook, like `requireStaff` for `/api/mod/*`); tested per role × route in `admin/admin.test.ts`. Admin requests count against 3.9's per-account limits; the audit-log reconcile has a stricter class of its own.

- **Roles stay CLI-only.** The panel lists moderators and admins read-only and shows the `deploy/admin.sh grant|revoke` commands. No API path grants or revokes a role, so a stolen admin session cannot mint admins or lock the owner out. A role revoked by the CLI stops the next admin request (the session is re-checked on every request; mutations re-read the role under a share lock).
- **No emails.** Decision: the panel never shows a player's email, not even to admins. Players are identified by handle and display name, like in the moderator queue; the search matches only those. An admin who must contact a player by email does it on the server (`deploy/admin.sh`, the database). This keeps a stolen admin session from harvesting addresses.
- **Read-only player files.** Account age, role, the invite used at registration (its note), heroes (class, level), every sanction (active, expired, lifted; issuer, lifter, reasons) and reports about them. No account ids and no presence times. Open reports link into the moderator queue (`#/moderation?case=<report id>` opens the case holding it); acting happens there, under the queue's rules (reports about admins are handled outside the app; ticket 4.11: so an admin's file, one's own included, lists no reports and never shows who reported an admin).
- **Invite codes** are shown once, in the create response, and never again: the list, the logs and the audit rows carry only the invite id. Revoking is by id.
- **Audit:** every admin request writes a row on the admin's account: `admin.view` (`section`: invites, telemetry, status, roles), `admin.player.search` (result count only, never the query), `admin.player.view` (`handle`), `admin.telemetry.reconcile` (`ok`), and D.2's `invite.create` / `invite.revoke` with `via: 'admin'`. No codes, emails, IPs or search text.

## Admin tools — ticket D.4

The admin panel's Inspector and World tabs (`docs/DEPLOY.md` "Admin tools", `apps/server/src/admin/tool-routes.ts`, routes in docs/API_CONVENTIONS.md "Admin tools"). The D.3 rules hold: the not-found `404` for everyone but admins before body validation, the role re-read inside every write's transaction (`lockAdmin`), **no tool reads or writes a role** (a guard test checks the admin sources), and no email: the inspector shows only "verified yes/no".
- **Test accounts** (`accounts.is_test`) are marked **only by the CLI** (`deploy/admin.sh test-account <handle> on|off`, audit `admin.test_account`, `via: 'cli'`). They are left off every board, the season archive (so awards) and the arena ladder at read time (`admin/eligibility.ts`, next to the sanction rule), matched in the arena only with each other, refused by trading (game-core standing check `test_account`), and their telemetry goes to `telemetry_daily_test`.
- **Cheat tools** (grants, level, progress, professions, daily resets, quests, fast-forward) need a test account or the admin's own account (`403 test_account_required` otherwise); on the admin's own non-test account the answer carries `warning: 'public_boards'` and the panel warns before. **Support tools** (removals, refunds, deletion and restore, rename, sessions, login lock) work on any account.
- **Audit:** one row per tool **on the target account** (and hero), `data`: `by` (the admin's account id), `reason`, `before`, `after` and tool details: `admin.item.grant` (plus `item.provenance` `{ from: 'admin' }`), `admin.item.remove` (`location`), `admin.gold` / `admin.materials` (`mode`: grant, refund, remove), `admin.xp`, `admin.level`, `admin.progress`, `admin.professions`, `admin.daily_reset`, `admin.quest.complete` / `admin.quest.reset`, `admin.fast_forward`, `admin.hero.delete` / `admin.hero.restore` / `admin.hero.rename` / `admin.hero.purge` (CLI), `admin.sessions.revoke`, `admin.login_lock.clear`; `admin.world.flag` on the admin's own account (world-wide); reads: `admin.player.inspect`, `admin.view` (`section`: `view_as`, `world`). The inspector's audit trail drops any key that could hold personal or secret data (`scrubAuditData`).
- **Hero rename** is moderation by an admin (the player rules for names apply; `409 name_taken`); the account's forced-rename sanction is unchanged.

## Reports

`POST /api/reports` with a `ReportTarget`, a reason (`REPORT_REASONS`) and an optional note. Today's targets: `{ kind: 'guild', handle }` (ticket 4.4: a guild's opaque handle; subject = its leader at the time; key `guild:<guild id>`; not hideable, see "Guilds"), `{ kind: 'player', handle }`, `{ kind: 'profileField', handle, field: 'displayName' }` and (ticket 4.2) `{ kind: 'characterName', handle, name }` (key `characterName:<character id>`, hideable: a hidden hero name shows as "Name withheld" on the profile; the queue's `current.value` is the hero's current name), and (ticket 4.5) `{ kind: 'message', id }` (a guild chat line or notice; key `message:<message id>`; hideable: a hidden line is a tombstone; subject = its author; only a player who can see the line may report it, see "Guild chat"), and (ticket T.6) `{ kind: 'trade', id }` (a trade offer or completed trade, from the Trading screen; only its two players may report it, anyone else gets `404` like an unknown id; subject = the other player; key `trade:<offer id>`; not hideable; the queue's `current.value` reads "Completed trade", "Open offer", … with "(reversed)", and the case links to the trade desk). Ticket T.6 also adds the reason `scam` ("A scam, a stolen account or selling for real money"). One open report per reporter and target (partial unique index; a concurrent duplicate gets `409 report_open`). The report stores a context snapshot (the display name as seen), so later renames keep the evidence. A muted player can still report; self-reports are refused. Every report writes `report.create`.

Ticket 4.11: a player may have at most **20 reports waiting** (`MAX_OPEN_REPORTS`; `409 report_limit`, counted under the reporter's social lock, so exact under races); a moderator's answer frees a slot. A hero name (`characterName`) can be reported only by a player who can see the hero's profile (otherwise `404`, like an unknown name), so a report cannot confirm a guessed name of a hidden player's hero. Display names and players stay reportable by anyone who knows the handle (those names show outside profiles: chat, rosters, boards).

The moderator queue groups open reports into cases, oldest first, with the subject's handle, name, role, active sanctions and past-sanction count, and each report's reason, note and reporter. **A case is one target and one subject** (ticket 4.11: a guild's reports name its leader at the time, so after a handover one guild can hold reports about two players; before, they were one case, and a moderator who had taken over a reported guild saw the reports about themselves in it and could dismiss them with the case). A viewer sees only reports whose subject they may act on. Acting on any report of a case (dismiss or a sanction) closes every open report of that case; a second moderator acting on the same report gets `409 report_closed`. The resolve locks the case's reports in id order before the subject (ticket 4.11: two moderators answering different reports of one case deadlocked, and Postgres retried one), then rename/disband re-checks the rank against the guild's **current** leader (a moderator could disband a guild whose leadership had passed to an admin since the report).

## Sanctions

| Kind | Action | Effect |
|---|---|---|
| `mute` | `mute` | No social writes (`403 muted`), except `report` and `rename`. Play continues. |
| `suspend` | `suspend` | No login (`403 account_suspended` after a correct password) and every request of a live session answers `403 account_suspended` at once (checked in `requireAccount` on each request). Sessions are not revoked, so they work again when it expires. |
| `rename` | `forceRename` | The display name becomes a placeholder (`Wanderer 482913`) at once; the player chooses a new one (`POST /api/account/display-name`, not the old name) within the duration. Lifting it restores the old name if still free. |
| `hide` | `hideContent` | Hides one `hideable` target (the display name, a hero name) from other players (the lookup and the profile); kinds other than content answer `422 not_hideable`. |
| `trade` | `restrictTrade` | Ticket T.4, a **trade restriction**: no trade offers sent or accepted (cancelling and declining still work); play, chat, every social write and the account shelf continue. Issued from a report like a mute (1 hour to 365 days). T.5 voids the subject's open offers through `app.sanctionEvents.onSanctionIssued` (docs/TRADING.md "T.4 as built"). |

Ticket T.4: every new sanction also runs the `onSanctionIssued` listeners inside the issuing transaction, after its rows are written (a throw refuses it), the seam trading uses. Every sanction has a reason (shown to the player), an expiry (`SANCTION_DURATIONS`: presets and bounds per kind), an issuer, and audit rows (`sanction.issue` on the subject's account with the issuer in the data; `sanction.lift`). One active sanction per kind (and per content for `hide`): a second is `409 already_sanctioned`, lift first. The player sees active sanctions in `GET /api/account/standing`, in the shell's standing strip and the account screen; the `403` bodies carry the sanction (`details.sanction`).

**Locking:** sanction issue locks the subject's account row `FOR UPDATE`; every social write share-locks the writer's row before checking sanctions, so a write either commits before the sanction or sees it. Lock order everywhere: actor (share) → the case's reports (id order) → subject account (update) → sanctions (→ the guild, for guild actions).

## Social writes

`socialWrite` counts each write in the **social-write rate-limit class** before any work (in-process, per account, on top of 3.9's limits): **12 a minute and 240 an hour** by default (`DEFAULT_SOCIAL_WRITE_LIMIT`, sized for guild chat at one message every 5 s), `429 rate_limited` with `Retry-After` and `details.limit: 'social'`. Refused writes are not counted. Configurable per app (`auth.socialWriteLimit`). Ticket T.4 adds the **trade class** (`apps/server/src/trading/trade-limit.ts`, `auth.tradeWriteLimit`): **20 trade writes a minute** per account (docs/TRADING.md "Per-account limits"), on top of 3.9's limits and separate from the social class (a trade write is not a social write and the reverse), `429 rate_limited` with `Retry-After` and `details.limit: 'trade'`; T.5's offer routes go through `tradeWrite`. Like the other limits it lives in process memory (one API instance; see "Rate limits and a second API instance" below).

## Profiles

Ticket 4.2. Code: game-core `social/profiles.ts` (`PROFILE_VISIBILITIES`, `PROFILE_RELATIONS`, `canViewProfile`), server `apps/server/src/social/profiles.ts` (routes, `profileRelation`, `viewableProfileOwner`, `profileView`), web `screens/ProfileScreen.tsx` (`#/profile`, `#/profile/<handle>`).

- **Reached** by display name (`GET /api/players/lookup?name=`, the search on the profile page and the report dialog) or handle (`?handle=`, `GET /api/players/:handle/profile`). Logged-in players only.
- **Shows** the display name, the handle, every hero (name, class, level, banner portrait), the achievements the owner picked (up to `MAX_SHOWN_ACHIEVEMENTS` = 5, in their order, with the award day), and optionally one hero's equipped gear (the showcase; never the pack). No account id, email, character or item id, seed, or time finer than a day.
- **Visibility** (`accounts.profile_visibility`): `public` (default), `friendsAndGuild`, `hidden`. The viewer's relation (`self`, `friend`, `guildmate`, `pending`, `stranger`, `blocked` either way) and `canViewProfile` decide; a `false` is `404 not_found` with the same body as an unknown player, for the profile and the lookup. The owner always sees their own.
- **Relations come from 4.3** ("Relations"): `profileRelation` maps `relationBetween`: `blocked-by-me` / `blocked-by-them` → `blocked` (404 for the profile, the lookup and the showcase, either way), `friend` → `friend`, `requested-by-me` / `requested-by-them` → `pending` (treated like a stranger). Ticket 4.4: a shared guild maps to `guildmate` (unless a friendship or a block decides first), so "friends and guild" includes guildmates; it is read live, so leaving or a kick closes the profile at once. Names in the friends list link to the profile (blocked players' do not).
- **Settings:** `POST /api/account/profile` (social write `profile`, rate limited, audited `profile.update`; exempt from mutes because it carries no player text and a muted player must be able to hide their profile).
- **Cosmetics (ticket 6.8, `docs/COSMETICS.md`):** each hero shows its appearance (`characters[].palette`), its banner carries the account's banner style, the frame plate (or, without a season frame, the crest style) holds the first hero in its appearance, and the title takes the account's title colour (`prestige.banner|crest|titleColour`). Only shown where the profile is (a hidden profile is `404` as before). Elsewhere a hero's palette follows its name: shown where the name is (arena: `canViewProfile` and not hidden by a moderator), else the class's own colours; account cosmetics follow `prestige` (not for a member the viewer blocks).
- **Report action** on every other player's profile: the player, and each visible hero name (`characterName`). The display name is reported from the report dialog's "their display name".

## Achievements

Ticket 4.2, GDD §5.3 (account-bound). Cosmetic only: no achievement grants power.

- **Definitions** are data in game-core `achievements/definitions.ts` (`ACHIEVEMENTS`): id, name, description, category, an icon asset id (`achievement.<kebab-id>`, 32×32 art from ticket A.8; the client falls back to a wax-seal placeholder if an icon is missing), and one typed criterion: `itemRarity`, `upgradeLevel`, `characterLevel`, `gravewardenDefeated`, `cryptTier`, `fullSet`, `contracts`, `storyQuest`. `achievementsEarned(facts)` is pure; a fact that was not collected earns nothing.
- **Community projects** (ticket 4.6, category `world`): criterion `communityProject` (fact `communityProjects`: completed projects the account gave to). Awarded to every contributor in the transaction that completes the project (`docs/COMMUNITY.md`), and by the backfill from `community_contributions`.
- **Live awards** (`apps/server/src/achievements/award.ts`): the events that already exist call `refreshAchievements(tx, character, factKeys, now)` inside their own transaction, after their change: the settlement (drops, levels; only when it granted items or a level), the crypt claim (drops, level, boss, tier), the quest turn-in (story or contract count, level, reward item), the forge upgrade and craft, the merchant purchase, and equipping a set piece. Facts are read from the character's state in that transaction (contracts count across the account).
- **At most once:** `account_achievements` has the primary key `(account_id, achievement_id)`; awards insert with `on conflict do nothing`, and only the transaction whose insert created the row writes the `achievement.award` audit row. Two heroes of one account, a live award and the backfill, or two backfills racing all end with one row and one audit row (real-PG test `achievements.pg.test.ts`).
- **Backfill** (`backfill.ts`): run by `migrate-cli` after the migrations (docs/DEPLOY.md "Data backfills"), once per database and achievement id list. It uses each hero's state plus the audit log for lost history: the rarity of sold, salvaged and discarded items (`merchant.sell`, `forge.salvage`, `item.discard`), notable drops, crafted, bought and quest-reward items, and every `forge.upgrade`'s `toLevel`. Loot-filter salvage (`filtered`) was never owned and does not count. Not recoverable (accepted): a set worn in the past but no longer.
- **Showing:** the owner picks up to five earned achievements (`shown_slot`); the profile shows those only.
- **Cosmetics (ticket 6.8):** some achievements come with a collection-book cosmetic (`docs/COSMETICS.md`), granted in the same transaction as the award (`awardAchievements`) and by the cosmetics backfill.

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

**Relations that end (ticket T.5).** Removing a friend, a block, leaving a guild, a kick and a disband (by the leader or a moderator) emit `app.relationEvents.onRelationEnded` inside the transaction that made the change, after it is written. Trading listens: every open offer of those accounts whose pair no longer qualifies (blocked, no relation left, or only one under 7 days) is voided, escrow back to its sender (`trade.void`, reason `block` or `relation`); an offer still covered by the other tie (friends and guildmates) stays open. A trade restriction or a suspension voids the subject's open offers through `app.sanctionEvents` (reason `sanction`); a mute doesn't (a muted player can still cancel and decline).

## Presence — ticket 4.3

A bucket from the last authenticated request (any route behind `requireAccount`): `online` (≤ 10 min), `today` (≤ 24 h), `week` (≤ 7 days), `longer` (or never). A guildmate who blocks you, or whom you block, shows `null`. Shown to friends and (ticket 4.4) guildmates on the guild page; the player can hide it (one setting for both) (`POST /api/account/presence`, a mute-exempt social write `presence` since ticket 4.11, audited only when the setting changes: it was unlimited and wrote an audit row per call), and then friends get `null`. **No timestamp leaves the server**: no route returns `last_seen_at`, and the friends list carries no times at all (tested: no date or epoch in the body).

**Cheap recording:** `createPresenceRecorder` keeps the last write per account in process memory and upserts `account_presence` at most once every **3 minutes** per account (`PRESENCE_WRITE_INTERVAL_MS`), whatever the request rate: under 3.9's limit of 900 requests a minute that is still ≤ 0.34 writes a minute per account, and a busy game tab (settle every 8 s) costs one write per 3 min instead of 22. The upsert touches only `account_presence` (never the locked account row), never moves the time backwards (`greatest`), and a failure is logged without failing the request. A restart forgets the memory, so the first request after it writes once. `online` (10 min) covers several write intervals, so an active player never flickers.

**Accepted:** a friend who polls the list can tell roughly when you went quiet (the moment `online` turns into `today`, ±3 min); that is what "online now" means. Hide presence to avoid it.

**Polling:** the friends screen polls `GET /api/friends` every 60 s and the shell (request badge) every 2 min; the response carries an `ETag` and `Cache-Control: private, no-cache`, so the browser revalidates and an unchanged list is a `304`. That is ≤ 1.5 requests a minute per tab, far below 3.9's 900.

## Rate limits and a second API instance — ticket 4.11

**The Phase 4 load against the limits** (3.9: 900 requests and 300 actions a minute per account; 4.1's social class: 12 writes a minute, 240 an hour; measured from the web client's poll timers):

| Screen open (one tab) | Polls a minute | Notes |
| --- | --- | --- |
| Any game screen | settle 7.5 (every 8 s) + world 0.5 + shell friends badge 0.5 | the Phase 1–3 load |
| Guild Hall, chat visible | + chat 12 (5 s; 2 when hidden) + hall 1 + siege plate 0.5 | ≈ 22 a minute: 2.4 % of 900 |
| Friends | + 1 | `ETag`, `304` when unchanged |
| Town works / hub | + board 1 | `ETag` |
| Roll of Renown (ticket 5.2) | + board 1 | `ETag`; own class: 60 board reads a minute |
| Worst case: three tabs on the Guild Hall | ≈ 66 a minute | 7 % of the request limit; polls are `GET`, so the action limit is untouched |

Writes: chat at one line every 5 s is exactly the social class's 12 a minute; 240 an hour is a sustained line every 15 s, which only a flood reaches. Every Phase 4 write is a social write (reports, renames, profile, presence since 4.11, friends and blocks, every guild action, chat, notice, guild boss attempts), except community contributions, warehouse moves and upgrades and boss claims, which carry no text, reach no one and are value operations under the per-account action limit and `Idempotency-Key`. Reports have their own cap since 4.11 (20 waiting). Ticket 5.5: every duel (rated or friendly) is a social write (`duel`, mute-exempt like guild boss attempts: it carries no text), so friendly challenges have no limit beyond this class (12 a minute, 240 an hour); rated duels are also capped at 10 a day. Saving a defence and drawing opponents are not social writes (they reach no one; the opponent list has a 5-minute refresh rule). Blocks keep players apart in the arena: never offered, never challengeable, names hidden in the duel book (`docs/PVP.md` "The arena"). Ticket 5.6: friends, guildmates and accounts sharing a sign-up signal (the same mailbox, compared on the server only) are never matched in rated duels (friendly challenges stay open), and staff have an **arena pattern report** (`GET /api/mod/arena/patterns`, the Moderation screen's "Arena patterns"): pairs of accounts that fight each other often, lopsidedly or one way, with whether they share an invite; read-only, acted on through sanctions, audited `mod.arena.patterns`, only pairs the viewer may act on (`docs/PVP.md` "Win-trading"). Nothing in the exit run (`phase4-exit-criteria.test.ts`, defaults) was rate limited except where a player sends 12 social writes within one simulated minute (the run spaces its social steps by two minutes, as a player would).

**Single instance.** Everything below lives in the API process's memory; with one instance (D.1's deployment) that is correct:
- the login and registration limits per IP (`@fastify/rate-limit`, memory store);
- the per-account request/action limits (3.9), the social-write class (4.1), the trade class (T.4) and the admin reconcile class (D.3), fixed windows in a `Map`;
- the presence recorder's "last write" per account (4.3), only a write throttle;
- the world-state cache (4.6), invalidated by the completing commit in this process, 60 s TTL otherwise;
- the settlement scheduler and the idempotency-key pruning (one timer per process).

**What a second API instance needs.** Without changes each instance would grant the full limits, so N instances allow N × the limits (a load balancer that spreads one account's requests multiplies its budget), and a flag set by one instance's completing contribution reaches the other within the 60 s TTL. Nothing breaks: rewards never depend on request frequency, value paths are exact under row and advisory locks in PostgreSQL, sessions and idempotency keys are in the database. To scale out: move the limiters to a shared store (Redis with `@fastify/rate-limit`'s Redis store and `INCR`/`EXPIRE` fixed windows for the account and social classes, or an unlogged PostgreSQL counter table keyed by account and window); invalidate the world-state cache across instances (PostgreSQL `LISTEN/NOTIFY` on completion, or keep the TTL as the bound); run the settlement scheduler on one instance only (a session advisory lock as leader election), or accept double work (settlement is idempotent by state); the presence throttle can stay per process (a few more upserts). Until then: one API instance (docs/DEPLOY.md).

## Rate limits: the Phase 5 review — ticket 5.8

Every limiter in the server, checked against realistic play (the web client's timers, the Phase 5 exit run) and against abuse. All are fixed windows in the API process's memory (one instance, above). **Changed in 5.8:** the email change now always takes the mail class (it did only with mail on), and the per-address login throttle counts guesses that arrive together as if they came one after another. **No value changed**: each is far above realistic use and the tight ones sit where a guesser or a flood is stopped.

| Class | Value | Covers | Realistic use | Abuse it stops | Verdict |
| --- | --- | --- | --- | --- | --- |
| Account (3.9) | 900 requests, 300 actions a minute per account | every signed-in route (staff and admin counted after their `404` gate) | one tab ≈ 9 polls a minute (settle 7.5, world, badge); the Guild Hall ≈ 22; Phase 5 adds boards 1, trading inbox 2 (30 s, `ETag`), the arena screen on open only; a busy player ≈ 1 action a second | scripted clients, bulk loops | keep (three tabs on the busiest screen ≈ 7 %) |
| Social writes (4.1) | 12 a minute, 240 an hour per account | reports, renames, profile, prestige choice, presence, friends and blocks, guilds, chat, guild boss attempts, **every duel** | chat every 5 s = 12; ten rated duels a day plus friendly ones; the exit run spaces duels a minute apart | chat floods, report and duel spam | keep (a duel a minute is faster than the arena screen lets anyone play) |
| Trade (T.4) | 20 a minute per account | send, accept, decline, cancel | a few offers an hour; the T.7 and 5.8 runs send 5 | offer spam and cap probing | keep |
| Board reads (5.2) | 60 a minute per account, one counter for the boards and one for the arena ladder | `GET /api/leaderboards/:metric`, `GET /api/arena/ladder` | one poll a minute per open board (`ETag`), a page or filter change a click | scraping every page and filter | keep; a `304` still ranks the board, so the cost per read is the query (accepted: 60 a minute per account) |
| Login per IP | 10 a minute | `POST /api/auth/login` | a mistyped password or two | spraying many addresses from one address | keep |
| Login per address (5.7) | 5 free failures, then 30 s doubling to 15 min; reset after an hour | login and the email change's password | a few typos | guessing one account's password from many IPs: about four tries an hour after the free ones; *5.8:* parallel guesses are checked at most one at a time past the free ones (before, every guess in flight was checked) | keep; the price (a guesser can keep a player locked out; a reset always works and lifts it) is documented in SECURITY.md |
| Registration per IP | 5 an hour | `POST /api/auth/register` | one account | account farms, probing taken addresses (`409 email_taken`, owner decision) | keep (invite-only on the live town) |
| Forgot password per IP | 5 per 15 minutes | `POST /api/auth/forgot-password` | one or two | mailbox floods from one address | keep |
| Tokens per IP | 20 per 15 minutes | verify-email, reset-password | one or two clicks | guessing tokens (256-bit, hashed: hopeless anyway) | keep |
| Mail per key | 3 an hour | resend verification and the email change (`account:<id>`), reset letters (`reset:<address hash>`, known or not) | one letter, a retry | flooding a mailbox; *5.8:* the email change now takes it with mail off too, so `409 email_taken` can't test addresses at 300 a minute | keep, applied always |
| Admin reconcile (D.3) | 3 per 5 minutes | the telemetry reconcile | a check now and then | a heavy query loop from a stolen admin session | keep |
| Opponent lists (5.5) | a fresh list after 5 minutes or once used up | `POST /api/arena/opponents` | a draw, ten duels a day | re-rolling for a favourite | keep; an **empty** list may be drawn again at once (bounded by the account class; each draw samples up to 500 defences under the account's duel lock): accepted, so a lonely bracket finds a new defence as soon as it is set |

Not limited beyond the account class (reviewed, acceptable): saving a defence, every arena read, seasons and prestige reads, scores, the account security panel, log out other devices, the shelf, trading reads, and the staff routes (which answer `404` first). Not limited at all: `POST /api/auth/logout` and `GET /api/config` (one lookup each, no state). The limiter maps are swept of stale keys once they hold 10,000; past that each new key walks the map (a few milliseconds at worst; the per-IP limits bound how fast keys arrive): accepted for one instance.

## Race tests

`apps/server/src/social/social.pg.test.ts` (real PostgreSQL, part of `test:pg`, three rounds each in varied orders, asserting only what holds in every order): concurrent duplicate reports on one target; a mute racing the target's social writes; a suspension racing the target's requests; several moderators acting on one report; a role revoke racing the moderator's actions; no deadlock or retry.

`apps/server/src/social/friends.pg.test.ts` (ticket 4.3): both players of many pairs sending a request at once → one friendship each (one request and one accept audited); a block racing an accept → always blocked, never friends, with the block's audit saying whether it removed a friendship or a request; an unfriend or a cancel racing an accept → the final state matches the audit log; concurrent accepts and sends at the friend and inbox caps → exactly one succeeds. Without the social locks every one of these fails.

`apps/server/src/hardening.pg.test.ts` (ticket 4.11): one reporter racing 30 reports keeps exactly 20 waiting; a block racing the blocked player's petitions and the target's guild's invites leaves no hidden offer, whatever the order; moderators answering two reports of one guild case while its leadership changes hands neither deadlock nor both act.

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

Ticket 4.11: **a block takes the guild offers it hides with it** (`dropGuildOffersBetween`): invites from one to the other, invites from a guild either leads to the other, and petitions by one to a guild the other leads are deleted in the block's transaction (`friend.block` records `guildOffers` when it dropped any). Before, they stayed, invisible to the side that could clear them, and filled the caps: a leader who blocked 30 spam petitioners closed the guild to petitions, a player who blocked 20 inviting leaders could get no invite. A petition an officer can no longer see stays (the guild's other officers can answer it). An officer can no longer invite a player blocked either way with the guild's leader (answered like an unknown player; the invite would only sit hidden), nor withdraw an invite to a player blocked either way with them (`404 no_invite`, like an unknown one). Exact under races: the block holds both players' social locks, and every petition and invite takes the applicant's or invitee's (real-PG race in `hardening.pg.test.ts`).

**Presence and profiles:** the guild page shows every member's presence bucket (`presenceOf`, `null` when hidden or blocked either way); outsiders see members and roles only. `profileRelation` maps a shared guild to `guildmate`, so "friends and guild" profiles open to guildmates. Everything reads membership live: a leave or a kick takes effect at once in every guild feature.

**Locks:** a membership row changes only under the guild's advisory lock (`lockGuild`), and a join also under the joiner's social lock, so the cap and "one guild per account" are exact (the primary key and the one-leader index are the backstops). Order: actor's account (share, `socialWrite`) → social locks (sorted) → guild lock; founding: account → hero → social → name locks; moderators: actor → report → subject (update) → guild.

**Social writes and mutes:** every guild write is a social write (rate limit, sanctions). A mute blocks reaching others (`guildCreate`, `guildInvite`, `guildApply`, `guildAcceptInvite`, `guildAcceptApplication`, kicks and role changes, the emblem) and leaves stepping away open (`guildLeave`, `guildDisband`, `guildDeclineInvite`, `guildCancelApplication`, `guildInviteCancel`, `guildDeclineApplication`) as well as the forced `guildRename`.

**Moderation:** any player reports a guild from its profile (`{ kind: 'guild', handle }`). In the queue a guild case shows "Name [TAG]" and its leader; besides dismiss, mute and suspend (on the leader), staff may **rename the guild** (`renameGuild`: name and tag become placeholders such as "Nameless Company 482913" / "X4821" at once; the leader must pick new ones, not the removed name; the members see the reason on the guild page) or **disband it** (`disbandGuild`: everyone removed; members see "disbanded by the wardens" and the reason for a week). Both follow `moderationDecision` (rank rule against the leader) and close the case; audited as `guild.force_rename` (on the leader, issuer in the data) and `guild.disband` (`byModerator`, reason, members).

**Audit events:** `guild.create`, `guild.invite`, `guild.invite_cancel`, `guild.invite_decline`, `guild.apply`, `guild.application_cancel`, `guild.application_decline`, `guild.join` (`via` invite or application, `by`), `guild.leave` (with the role and, ticket 4.5, `chatSeq`: the guild's newest chat line at that moment), `guild.kick` (also `chatSeq`), `guild.promote`, `guild.demote`, `guild.transfer`, `guild.emblem`, `guild.rename`, `guild.force_rename`, `guild.disband` (the members). The membership of a guild is exactly what these say (checked by the race tests).

**Emblems** (`GUILD_EMBLEMS`, 32×32 charges from ticket A.8 drawn on the dyed shield; a glyph is the fallback): `anvil`, `crow`, `tower`, `flame`, `skull`, `oak`, and since A.8 `wolf`, `key`, `crown`, `moon`, `serpent`, `chalice` (asset ids `guild-emblem.<id>`). Never rename or reuse an id.

**Polling:** the Guild Hall polls `GET /api/guild` every 60 s with an `ETag` (`304` when unchanged).

**Races** (`guilds.pg.test.ts`, real PostgreSQL, three rounds in varied orders, no retries): founders racing for one name (one guild, one charge; gold, audit and telemetry reconcile) and for one tag, one account founding twice; invites and applications accepted at once at 29 members (exactly one joins); one player accepted by several guilds at once (joins one); accepts racing a disband (the guild ends empty, every audited join was in the disband's member list); leaves racing promotions (a promotion that won shows in the leave's role); the leader handing over to an officer while each kicks or demotes the other and officers kick each other (always one leader, never both removed, the roster equals the audit log). Without the guild lock three of these fail.

## Guild boss — ticket 4.9

The weekly guild boss has its own file: `docs/GUILD_BOSS.md` (attempts, the week, stage rewards and who earns them, the permission matrix `guildBossDecision`, locks and races). It uses this file's pieces: attempts are social writes (`guildBossAttempt`, mute-exempt), membership is read under the guild lock, and the damage board hides players blocked either way.

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

**Ordering and cursors:** each line's `seq` is `max(seq) + 1` for its guild, computed under the guild's lock and held to commit, so lines commit in `seq` order and the committed lines are always `1..n`. A poll asking for `seq > since` therefore never skips a line that commits later with a lower number. Pages: the newest 30 first ("Earlier entries" loads 30 more with `before`), polls return up to 50 new lines oldest first (`more` beyond that: the client reloads the newest page). Readable history: the newest **500** lines and none older than **30 days**; older rows stay stored for moderation, unserved. **Retention (ticket 4.11 decision): not pruned in Phase 4.** A busy guild of 30 writing 2,000 lines a day stores ≈ 0.6 MB a day (≈ 300 bytes a row with its indexes), ≈ 220 MB a year; the live town is a few guilds, so the table stays small against the VPS's 40 GB for years. Old lines are evidence: a report's snapshot keeps the reported words, but the moderator queue also shows the line itself. When it is needed, the follow-up is a pruning job for lines older than the readable window (e.g. 180 days) that are not the guild's notice and not the target of an open report or active sanction; deleting is irreversible, so it was not built blind in a hardening ticket.

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

## Trade moderation (ticket T.6)

The docket carries a **trade ledger** below the arena patterns (and the admin panel a "Trades" tab with the same desk): the trade history of everyone, one player or one pair, each trade's case (both sides in full, heroes, holds, the audit trail, its open reports) and, for a completed trade within 14 days, **Reverse this trade…** with a full view of what moves back, a reason both players read and an optional mute, suspension or trade restriction on one of the two, in the same step. Below it, the **trade patterns** panel (one-way flows, pairs that only trade with each other, the same invite or sign-up mailbox, new accounts receiving a lot, weekly caps reached repeatedly, unprovenanced items offered, repeated reversals, invite clusters). The rules (what can be reversed, the lock order, what is kept from staff) are in `docs/TRADING.md` "T.6 as built". Views name players by handle and display name only: no emails, no account ids, no invite codes; the mailbox key and the invite id are compared on the server and never shown. A pattern flag sanctions nobody: it points a moderator at a case.
