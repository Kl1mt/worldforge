# Going live: the owner's checklist (ticket 8.6)

The steps between "the server runs" (`docs/DEPLOY.md` §1–9) and "players are invited". Work through them in order; each says **where** you do it and **how to check** it worked. The admin panel's **Readiness** tab (`/#/admin/readiness`) shows the state of every step at a glance: a brass seal when it is done, an ember seal when it needs attention, an empty ring when it is not set. The tab only reads; each entry links to the tab or the section of this guide that changes it.

Nothing on the Readiness tab shows a secret: it says *whether* mail is set up, never the host, user or password; *whether* your legal files exist, never what they say; and the time and size of the last backup, nothing else.

## 1. Email provider and SMTP settings

Players need mail to verify their address, reset a password, and (later) to trade.

- **Where:** at a provider of your choice (Brevo, Postmark, Amazon SES, Mailgun, Scaleway, your domain host…), then `deploy/.env` on the VPS. The full walk-through, with the DNS records (SPF, DKIM, DMARC), is `docs/DEPLOY.md` "Email".
- **Do:** verify your sending domain at the provider, create SMTP credentials, set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` in `deploy/.env`, then run `deploy/deploy.sh`.
- **Check:** `docker compose -f deploy/docker-compose.yml logs server | grep -i smtp` shows `SMTP connection and login ok`. On the Readiness tab, **Email (SMTP)** says "Transport: SMTP (your provider)".

## 2. A test letter

- **Where:** admin panel → **Readiness** → "Send a test letter".
- **Do:** type your own address and send. The address goes to the server once and is stored nowhere (not in the audit log, not in telemetry, not in the server log). Three letters an hour per admin.
- **Check:** the panel says "Handed to the mail provider", and the letter ("Worldforge test letter") arrives within a minute, **in the inbox, not in spam**. If it lands in spam, the SPF/DKIM records are not right yet. If the panel says the provider refused it, it shows the provider's code (e.g. `535` for a wrong password); fix `deploy/.env`, redeploy, try again. The **Email** entry turns to done once the last test letter was sent.

## 3. The privacy policy

- **Where:** `deploy/legal/datenschutz.md` and `deploy/legal/impressum.md` on the VPS (`docs/DEPLOY.md` "Legal pages"); the ticks in admin panel → **Readiness** → "What the policy mentions".
- **Do:** copy the templates into `deploy/legal/`, fill in every bracket and **delete the first line** `<!-- worldforge:template -->`. Make sure the privacy policy mentions:
  - **public leaderboards:** every player is listed by display name, with no opt-out;
  - **verification and reset emails:** what is mailed, and that the address is used only for the account;
  - **the mail provider** by name, as a processor (sign its data processing agreement);
  - **trading:** trades are kept in a history staff can review and checked for abuse patterns;
  - **events and cosmetics:** participation and earned cosmetics are stored with the account;
  - **test accounts:** staff test accounts exist and don't count on boards, rankings or statistics.

  Then tick each item off on the Readiness tab and **Save ticks** (stored and audited; the tab never reads the file's text).
- **Check:** `/#/datenschutz` and `/#/impressum` show your text without the "Template" note; the **Privacy policy** entry is done (both files present and filled in, every item ticked).

## 4. Reserved staff names

- **Where:** admin panel → **Names**, or `deploy/admin.sh reserved-name add <name> [--note <text>]`.
- **Do:** add your own name and every moderator's name (the display names players will see), so nobody can register a look-alike.
- **Check:** the name appears under "Added by admins"; the **Reserved staff names** entry is done. Try to rename a test hero to a look-alike (e.g. with a digit for a letter): it is refused.

## 5. A test account for your own testing

The admin testing tools (grant items, set levels, fast-forward) only work on test accounts and on your own account; on your own account what you do shows on the public boards, so test on a test account.

- **Where:** register a second account in the game (with an invite code if `REGISTRATION_MODE=invite`), then on the VPS: `deploy/admin.sh test-account <handle> on` (the handle is on the profile and in the Inspector).
- **Rule:** never switch a test account back to normal while it holds anything granted with the admin tools (items, gold, materials, XP); switching it off releases all of it into the real game. Delete its heroes, or keep it a test account (`docs/DEPLOY.md` "Admin tools").
- **Check:** the Inspector shows "Test account"; the account is missing from every leaderboard; the **Test accounts** entry counts it.

## 6. Season 1

Seasons don't start by themselves. Until one is scheduled the boards run, but nothing is sealed or honoured.

- **Where:** admin panel → **Seasons**, or `deploy/admin.sh seasons schedule --start <ISO, UTC> [--weeks 8]`.
- **Do:** pick a start (a Monday 00:00 UTC is easy to remember); the next seasons follow back to back.
- **Note:** the newer board formulas (Phase 6: Power 2, PvE Progress 4) **switch in at the end of the season under way** (`docs/LEADERBOARDS.md` "Formula versions between seasons"); the Readiness tab lists the switches still waiting.
- **Check:** `deploy/admin.sh seasons status` shows Season 1 as next or current; the **Season 1** entry is done.

## 7. The first event

- **Where:** admin panel → **Events**, or `deploy/admin.sh events schedule harvestOfBones --start <ISO, UTC> --days 7`.
- **Do:** schedule the Harvest of Bones (`docs/EVENTS.md`). One event runs at a time; events and seasons are independent.
- **Check:** `deploy/admin.sh events status` lists it as next; the **The first event** entry is done. When it starts, the town shows the event banner.

## 8. Trading, in launch-order steps

Only after steps 1–2: a player can trade only with a verified address. The switches are in admin panel → **Trading**; the Readiness tab shows the step the town is at, read-only (`docs/TRADING.md` "Admin switches").

1. **Step 1:** turn on *Trading*, *Trade: items* and *Shelf: items* (Epic, Legendary and set pieces are already on).
2. **Step 2**, after a few weeks of clean telemetry: add *Trade: materials* and *Shelf: materials*.
3. **Step 3**, last and **one at a time**: gold (*Trade: gold* and *Shelf: gold*), then *Tradeable: Mythic*, *Void*, *Prismatic*.

**After each step, watch** for a week or two:
- the **trade pattern report**: admin panel → **Trades**, or `deploy/admin.sh trading patterns --days 28` (one-way flows, shared invites or mailboxes, new accounts receiving a lot, weekly caps reached again and again);
- the **`trade.items`** telemetry (admin panel → **Telemetry**): if more than about **10 % of the Legendary and set pieces in use came from trades**, lower "Legendary and set pieces per week" from 3 to 2 (`docs/TRADING.md` "T.7 as built").

**Check:** the **Trading** entry shows the step you took; "Out of order" appears if a switch is on ahead of the order (or a step-1 category was switched off).

## 9. Backups and a restore drill

- **Where:** the VPS (`docs/DEPLOY.md` §10).
- **Do:**
  1. enable the nightly timer: `sudo cp ~/worldforge/deploy/systemd/worldforge-backup.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now worldforge-backup.timer`;
  2. run one now: `sudo systemctl start worldforge-backup.service` (or `deploy/backup.sh --kind manual`);
  3. copy the backups off the VPS (`rsync -av deploy@<server-ip>:worldforge/deploy/backups/ ./worldforge-backups/`), at least weekly;
  4. **restore drill:** once, before you need it, restore a recent dump (`deploy/restore.sh deploy/backups/manual/<file>.dump`, type `RESTORE`; players are disconnected for about a minute and every change since the dump is lost, so do it before inviting players or in a quiet hour). Check that you can log in and your heroes are there.
- **How the tab knows:** after every good dump `deploy/backup.sh` writes `deploy/status/backup.json` with the time and the size, nothing else; the server reads it through a read-only mount (`BACKUP_STATUS_FILE`). `deploy/deploy.sh` creates the folder.
- **Check:** the **Backups** entry is done and shows the last backup's time and size. It turns to "needs attention" when the last good backup is more than 36 hours old.

## 10. Inviting players

- **Where:** admin panel → **Invites**, or `deploy/admin.sh invite create --uses 10 --expires 30d --note "first wave"` (`docs/DEPLOY.md` "Registration and invite codes").
- **Do:** start with a small group of people you know, keep `REGISTRATION_MODE=invite`, and send each the ready link. Keep an eye on the Server tab (active players), the moderator queue (reports) and the Readiness tab.
- **Check:** the invite list shows who registered with each code. When everything on the Readiness tab is done and the first wave is happy, open more widely (`REGISTRATION_MODE=open`, `docs/DEPLOY.md` §16 "Before going public").

## The other entries on the Readiness tab

- **Deploy:** the game version, commit and build time this server runs (as on the Server tab). "Not recorded" means the image wasn't built by `deploy/deploy.sh`. CI and the auto-deploy are on GitHub (Actions); the tab does not reach GitHub.
- **Shared state:** the `SHARED_STATE` mode (`docs/DEPLOY.md` §17). `postgres`, the production default, counts rate limits in the database and is safe for two API instances; `memory` is only for one.
