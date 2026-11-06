# Social safety & moderation

Ticket 4.1 builds the safety foundation every later Phase 4 ticket uses (ROADMAP "Phase 4 ground rules": *safety before reach*). This file is the contract for those tickets: a profile, friend, guild or chat route that stores player text or reaches another player uses the pieces below and adds nothing parallel.

Code: `packages/game-core/src/social/` (rules and data, usable by server and client) and `apps/server/src/social/` (routes, helpers, CLI). Endpoints are listed in `API_CONVENTIONS.md`, tables in `DATA_MODEL.md`.

## Checklist for a new social feature

1. **Text:** every player-written string goes through `assertPlayerText(kind, raw, field)` on the server (the client may call game-core `validatePlayerText` for instant feedback). Add a kind to `PLAYER_TEXT_RULES` if none fits. Store the returned (normalised) value.
2. **Write:** the route runs behind `app.requireAccount` and does its work inside `socialWrite(app, request, reply, action, fn)` (or calls `assertSocialWriteAllowed(tx, …)` first inside its own transaction helper, e.g. `idempotentTransaction`). Name a new `SocialWriteAction` (`'chat'`, `'guildCreate'`, …).
3. **Report:** add the new target to game-core's `ReportTarget` union and `REPORT_TARGET_KINDS`, a resolver in `apps/server/src/social/targets.ts` (`RESOLVERS`) and a branch in `reportTargetSchema`; open `ReportDialog` with a fixed `target` from the UI.
4. **Hide:** if the content is `hideable`, filter it out of other players' views with `hiddenTargetKeys(executor, keys, now)`.
5. **Permissions:** new moderator actions go into `MODERATION_ACTIONS` and the hand-written table in `permission-matrix.test.ts`.
6. **Races and journey:** a real-PG race test for anything shared; a step in `e2e/journey.ts`.

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

Actions: `viewQueue` (allowed for staff, 404 for players), `dismissReport`, `mute`, `suspend`, `forceRename`, `hideContent`, `liftSanction`. Nobody acts on themselves; a subject of the actor's rank or higher is out of reach. Reports about admins are handled outside the app (the queue never shows a case its viewer cannot act on). Every action re-reads the actor's role under a share lock, so a revoke racing an action either precedes it (404) or follows it.

**404 for non-staff:** `/api/mod/*` uses `app.requireStaff` as an `onRequest` hook, before body validation, so players and anonymous visitors get exactly the not-found handler's body, whatever they send. The web client treats `#/moderation` like an unknown address for players.

## Reports

`POST /api/reports` with a `ReportTarget`, a reason (`REPORT_REASONS`) and an optional note. Today's targets: `{ kind: 'player', handle }` and `{ kind: 'profileField', handle, field: 'displayName' }`. One open report per reporter and target (partial unique index; a concurrent duplicate gets `409 report_open`). The report stores a context snapshot (the display name as seen), so later renames keep the evidence. A muted player can still report; self-reports are refused. Every report writes `report.create`.

The moderator queue groups open reports by target into cases, oldest first, with the subject's handle, name, role, active sanctions and past-sanction count, and each report's reason, note and reporter. Acting on any report of a case (dismiss or a sanction) closes every open report on that target; a second moderator acting on the same report gets `409 report_closed`.

## Sanctions

| Kind | Action | Effect |
|---|---|---|
| `mute` | `mute` | No social writes (`403 muted`), except `report` and `rename`. Play continues. |
| `suspend` | `suspend` | No login (`403 account_suspended` after a correct password) and every request of a live session answers `403 account_suspended` at once (checked in `requireAccount` on each request). Sessions are not revoked, so they work again when it expires. |
| `rename` | `forceRename` | The display name becomes a placeholder (`Wanderer 482913`) at once; the player chooses a new one (`POST /api/account/display-name`, not the old name) within the duration. Lifting it restores the old name if still free. |
| `hide` | `hideContent` | Hides one `hideable` target (today the display name) from other players (the lookup); kinds other than content answer `422 not_hideable`. |

Every sanction has a reason (shown to the player), an expiry (`SANCTION_DURATIONS`: presets and bounds per kind), an issuer, and audit rows (`sanction.issue` on the subject's account with the issuer in the data; `sanction.lift`). One active sanction per kind (and per content for `hide`): a second is `409 already_sanctioned`, lift first. The player sees active sanctions in `GET /api/account/standing`, in the shell's standing strip and the account screen; the `403` bodies carry the sanction (`details.sanction`).

**Locking:** sanction issue locks the subject's account row `FOR UPDATE`; every social write share-locks the writer's row before checking sanctions, so a write either commits before the sanction or sees it. Lock order everywhere: actor (share) → report → subject account (update) → sanctions.

## Social writes

`socialWrite` counts each write in the **social-write rate-limit class** before any work (in-process, per account, on top of 3.9's limits): **12 a minute and 240 an hour** by default (`DEFAULT_SOCIAL_WRITE_LIMIT`, sized for guild chat at one message every 5 s), `429 rate_limited` with `Retry-After` and `details.limit: 'social'`. Refused writes are not counted. Configurable per app (`auth.socialWriteLimit`). Like the other limits it lives in process memory (one API instance).

## Race tests

`apps/server/src/social/social.pg.test.ts` (real PostgreSQL, part of `test:pg`, three rounds each in varied orders, asserting only what holds in every order): concurrent duplicate reports on one target; a mute racing the target's social writes; a suspension racing the target's requests; several moderators acting on one report; a role revoke racing the moderator's actions; no deadlock or retry.
