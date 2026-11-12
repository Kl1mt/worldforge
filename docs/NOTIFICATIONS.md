# Notifications: the inbox ("Letters")

Ticket 8.5. One place for the news that matters to an account. Code: server `apps/server/src/inbox/` (`notify.ts` writer and pruning, `routes.ts`), table `account_notifications` (`docs/DATA_MODEL.md`), web `apps/web/src/inbox/` (`#/inbox`, the shell's "Letters" link and badge).

## Rules
- **Written by the server only, in the event's own transaction**, next to that event's audit row (`notifyTx`, `broadcastTx`). No route takes an entry from a client; an entry commits or rolls back with what it reports.
- **What an entry holds:** its `kind` and a small `data` object of content ids and the account's *own* things (its hero's id, an offer or a duel it is part of). Never another player's account id, hero id or name, and no email (the privacy tests check every answer). The client turns kinds and content ids into words (`inbox/text.ts`); a kind or field it does not know falls back to a plain line.
- **Read and unread** live on the server (`read_at`), per account, so every device shows the same.
- **Bounded:** the newest `INBOX_KEEP` = 200 entries per account, for `INBOX_KEEP_DAYS` = 60 days. A personal write prunes its account at once; the scheduler's hourly pruning step (`pruneInboxes`, game clock) prunes everything else (town-wide entries, idle accounts). Letters whose number another player chooses (`INBOX_FROM_OTHERS_KINDS`: a trade offer received, a duel against the account's defence) are kept to the newest `INBOX_KEEP_FROM_OTHERS` = 100 among themselves first, so a flood of them never pushes out the account's own letters (honours, event tiers, drops, the town's news), which are written once (ticket 8.7, `docs/PHASE8_EXPLOIT_REVIEW.md` F3).
- **Once:** jobs that can be resumed (honours, event tiers, eras, town stages) write with a `dedupe_key`, unique per account, so a rerun writes nothing twice.

## Sources

| Kind | Written by (transaction) | To | Data |
| --- | --- | --- | --- |
| `drop` | the farming settlement (`settleActivityTx`) and the crypt claim, after the items are inserted | the hero's account | `characterId`, `source` (`farming`/`crypt`), `placeId`, `count`, up to 5 `items` (`baseId`, `rarityId`, `setId?`, `mythicId?`, `variant?`) |
| `trade.received` | sending an offer (`trade.offer`) | the receiver | `offerId` |
| `trade.accepted` | accepting (`trade.accept`) | the sender | `offerId` |
| `trade.voided` | a void (`trade.void`: switch, block, sanction, relation, deletion) | both sides | `offerId`, `reason`, `side` (`sent`/`received`) |
| `trade.released` | a hold's release (`trade.release`, the sweep) | the receiving account | `offerId`, `items` (count), `gold` |
| `duel.defence` | a duel (`duel.fight`) | the defender | `duelId` (the defender may open it), `kind`, `bracketId`, `outcome` (`held`/`fell`/`draw`), `rating` (rated: the defender's change) |
| `event.reward` | a tier granted (`grantTiersTx`, live or by the sweep) | the account | `eventId`, `event`, `tier`, `cosmeticId`; dedupe `event:<n>:tier:<t>` |
| `season.honours` | a season's awards (`awardSeason`'s last transaction) | each honoured account | `season`, `tiers`; dedupe `season:<n>` |
| `guild.honours` | guild honours (`awardGuildSeason`'s batches) | each honoured member | `season`, `tier`; dedupe `guildSeason:<n>` |
| `world.stage` | a town-works stage finished (`advanceProject`) | every account (`broadcastTx`, one statement) | `projectId`, `stageId`, `stageIndex`; dedupe `stage:<project>:<stage>` |
| `world.era` | an era change (`recordEraChange`) | every account | `from`, `to`; dedupe `era:<to>` |
| `release` | the account's first inbox read on a new version (a deploy has no transaction) | the account | `version`; dedupe `release:<version>` |

Only kept drops count: what the loot filter handled never reached the hero. Drops worth an entry are Legendary and Mythic (set pieces, Void and Prismatic are among them). Achievements, quest turn-ins and level-ups keep their in-game notices (`onboarding/notices.ts`) and have no letter.

## Privacy, blocks and test accounts
- A player only ever reads their own account's entries (`GET` filters by the session's account; marking read touches only the account's own rows: foreign ids mark nothing).
- An entry caused by **another** player (`from`: an offer sent, an offer accepted, a duel) is not written when either account blocks the other (4.3), or when the actor is a **test account** (D.4): a test account's play reaches only its own inbox. Its own entries (its drops, its trades' outcomes caused by staff or switches, town-wide news) are written as for anyone.

## API
- `GET /api/inbox/summary` → `{ unread, newest }` with an `ETag` (`304` when unchanged, `cache-control: private, no-cache`). The shell polls it every 60 s while the tab is visible, at once when the tab becomes visible again or the inbox changed in this tab.
- `GET /api/inbox?limit=` (1–200, default 50) → `{ entries: [{ id, kind, data, createdAt, read }], unread }`, newest first, with an `ETag`.
- `POST /api/inbox/read { ids: [uuid…] }` or `{ all: true }` → `{ marked, unread }`. Repeat-safe by state (no `Idempotency-Key`).

**Load:** one summary poll a minute per visible tab, mostly `304`s; under 1 % of the 3.9 account limit (900 requests a minute) even with three tabs (`docs/SOCIAL.md` "Rate limits: ticket 8.5"). A notification write is one insert plus one indexed prune per personal entry; a town-wide entry is one `insert … select` over the accounts.

## The client
- The top bar's **Letters** link carries the unread count (an envelope mark on phones). `#/inbox`: letters grouped by day, each with its sigil (a shape per kind), "New" while unread, a link to its screen (following it marks it read), "Mark read", "Mark all read" and "Unread only". Loading, error (Try again), empty and "all read" states.
- The F.3 "New in v…" slip and the F.4 reload hint are unchanged; the `release` letter is a lasting record beside them.
