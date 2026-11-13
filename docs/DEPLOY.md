# Deploy Worldforge on your own server

This guide takes a fresh **Debian 13 (trixie)** VPS to a public Worldforge at `https://play.your-domain`, with nightly backups and one-command updates. Players reach it through a **Cloudflare Tunnel**, so **the VPS's IP address is never published**. No DNS record points at the server, and the server opens no web ports. It assumes the reference machine: 2 vCPU, 4 GB RAM, ~40 GB free disk. Expect about an hour the first time.

You type the commands in a terminal **on the server** unless a step says "on your computer". Lines starting with `sudo` need the deploy user's password. `<server-ip>` is the VPS's address from your hosting provider. You need it only for SSH, so keep it to yourself.

Ticket D.1. Files: `deploy/` (Dockerfile, Compose stack, Caddyfile, scripts, systemd timer) and `.github/workflows/deploy.yml` (optional automatic deploys). Ticket D.2 added invite-only registration and the legal pages (§9, "Registration and invite codes" and "Legal pages").

## What runs where

```
Player ──HTTPS──► Cloudflare edge ◄══ tunnel (outbound from the VPS) ══ cloudflared
                                                                              │ http://web:80
                  web      Caddy 2: static client, security headers, /api ────┤
                  server   Node 22, `node dist/index.js`, port 3000            ▼
                  db       PostgreSQL 16, volume `db-data`, internal network only
                  migrate  one-shot: applies migrations before the server starts, then exits
```

- **No public ports except SSH.** `cloudflared` dials *out* to Cloudflare; Cloudflare terminates HTTPS and sends the traffic back through that connection. Caddy listens only inside Docker and on `127.0.0.1:8080` of the VPS itself (for checks). The firewall can close 80 and 443.
- **One origin**: the browser loads the client and calls `/api` on the same domain, so there is no CORS and the session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api`) works as in development.
- **Real player IPs.** Cloudflare passes the player's address in `CF-Connecting-IP`, which its edge always overwrites. Caddy forwards exactly that to the server (`TRUST_PROXY=1`), so per-IP rate limits see each player and a forged `X-Forwarded-For` is ignored.
- **One API instance, ready for two** (ticket 6.9). Production runs one `server` container. Rate limits, cache invalidation and the scheduler are shared through PostgreSQL, so a second instance is safe; how to run one is in §17. Don't scale up without reading it.
- **The server never migrates on startup.** `deploy.sh` runs the `migrate` service first, in one transaction.
- **Memory caps** (fit 4 GB with room for the OS and image builds): db 1 GB (`shared_buffers` 256 MB), server 768 MB (V8 heap 512 MB), Caddy 256 MB, cloudflared 128 MB.
- The e2e and playtest servers (`pnpm e2e:serve`, `pnpm playtest`) are not in the image: the production build excludes them, the image build fails if they appear, and both refuse `NODE_ENV=production`.

Commands below that start with `docker compose` are run **in `~/worldforge/deploy`**. The `deploy/*.sh` scripts work from any directory.

---

## 1. Domain at Cloudflare

Buy the domain with **Cloudflare Registrar** (dash.cloudflare.com → *Domain Registration → Register Domains*). It then uses Cloudflare's nameservers automatically, which the tunnel needs. (A domain bought elsewhere works too: add it to Cloudflare and switch its nameservers at the registrar.)

**Do not create `A` or `AAAA` records pointing at the VPS**, not even briefly to test: DNS history services keep old records forever, and the IP would be public. The tunnel creates the game's DNS record for you in §6.

In the Cloudflare dashboard for the domain, also set:
- *SSL/TLS → Edge Certificates*: **Always Use HTTPS** on, **Minimum TLS Version** 1.2.
- *Security → Bots*: leave **Bot Fight Mode** off. It can challenge the game's own API calls, and the game then fails to load.

## 2. First login and a deploy user

Log in as root with the password or key from your hosting provider (on your computer: `ssh root@<server-ip>`), then:

```sh
apt update && apt full-upgrade -y
apt install -y sudo git curl ca-certificates ufw unattended-upgrades
timedatectl set-timezone Europe/Berlin
adduser deploy                 # choose a strong password: sudo asks for it
usermod -aG sudo deploy
```

**Your SSH key for `deploy`.** On your computer, if you have no key yet, run `ssh-keygen -t ed25519` (Windows: in PowerShell). Then copy the public half to the server:

```sh
# on your computer (macOS/Linux; on Windows paste the content of ~/.ssh/id_ed25519.pub by hand)
ssh-copy-id deploy@<server-ip>
```

Open a **new** terminal and check that `ssh deploy@<server-ip>` logs you in without the server password. Keep the root session open until §3 is done.

**Automatic security updates:** `sudo dpkg-reconfigure -plow unattended-upgrades` and answer *Yes*.

**Swap** (builds need memory while the game runs; 2 GB is plenty):

```sh
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. SSH hardening

Only after the key login for `deploy` works:

```sh
sudo tee /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF
sudo sshd -t && sudo systemctl reload ssh
```

Check from a new terminal that `ssh deploy@<server-ip>` still works and `ssh root@<server-ip>` is refused. Only then close the old root session. (Optional: `sudo apt install fail2ban` bans addresses that keep guessing.)

## 4. Firewall

Only SSH needs to be reachable; the game arrives through the tunnel.

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw enable
sudo ufw status verbose
```

Docker writes its own firewall rules for **published** ports, and those bypass ufw. That is why nothing in the stack publishes a public port. Caddy is bound to `127.0.0.1:8080` (loopback only), and the server and the database have no `ports:` entry. Never add a public `ports:` line (e.g. `80:80`) to any service: it would serve the game on the VPS's IP and give the IP away.

(Optional: if your home connection has a fixed IP, allow SSH only from it: `sudo ufw allow from <your-ip> to any port 22 proto tcp` and `sudo ufw delete allow 22/tcp`.)

## 5. Install Docker (official repository for trixie)

Debian's own `docker.io` package lags behind; use Docker's repository:

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
```

Log out and back in (so the `docker` group applies), then check: `docker run --rm hello-world` and `docker compose version` (v2.24 or newer; Compose jumped from v2 to v5, so v5.x is fine).

Membership in the `docker` group is equivalent to root on this machine. Keep the `deploy` account's key safe.

## 6. Create the Cloudflare Tunnel

In the Cloudflare dashboard, open **Zero Trust** (left sidebar; the first time it asks for a team name and the free plan) and go to *Networks → Tunnels*:

1. **Create a tunnel** → type **Cloudflared** → name it `worldforge` → *Save tunnel*.
2. On the *Install and run a connector* page, choose **Docker**. The page shows a command like `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJh…`. **Do not run it.** Copy only the long token after `--token`; it goes into `deploy/.env` in §8. Treat it like a password: whoever has it can serve traffic for your hostname.
3. *Next* → add a **public hostname** (newer dashboards call it a *published application route*):
   - Subdomain `play`, domain: yours, path: empty.
   - Service: type **HTTP**, URL **`web:80`** (the Caddy container's name inside Docker).
   - *Save*.

Cloudflare now creates the DNS record `play.your-domain` as a proxied `CNAME` to the tunnel. Under *DNS → Records* it shows as `play` → `….cfargotunnel.com`, with no IP anywhere. The tunnel shows *Inactive* until the stack runs in §9.

## 7. Get the code

```sh
cd ~
git clone https://github.com/Kl1mt/worldforge.git
cd worldforge
```

If the repository is private: on the server run `ssh-keygen -t ed25519 -f ~/.ssh/worldforge_repo -N ''`, add `~/.ssh/worldforge_repo.pub` on GitHub under *Repository → Settings → Deploy keys* (read-only), and clone with:

```sh
GIT_SSH_COMMAND='ssh -i ~/.ssh/worldforge_repo' git clone git@github.com:Kl1mt/worldforge.git
git -C worldforge config core.sshCommand 'ssh -i ~/.ssh/worldforge_repo'
```

The clone must stay on `main` without local edits: `deploy.sh` only fast-forwards it.

## 8. Configure

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
openssl rand -hex 32          # copy this: it becomes POSTGRES_PASSWORD
nano deploy/.env
```

Set at least:
- `DOMAIN`: the public hostname from §6, e.g. `play.example.de`, without `https://`.
- `CLOUDFLARE_TUNNEL_TOKEN`: the token from §6.
- `POSTGRES_PASSWORD`: the random hex string. Leave `DATABASE_URL` as it is, because it is built from the `POSTGRES_*` values.
- Leave `COMPOSE_PROFILES=tunnel`, which starts `cloudflared`.
- `REGISTRATION_MODE`: `invite` (the default in `.env.example`) until you open the game to everyone; see §9 "Registration and invite codes".
- Optional, can be done later: the `SMTP_*` and `MAIL_FROM` values for verification and password-reset letters; see §9 "Email".

Every variable is explained in `deploy/.env.example`. `deploy/.env` is git-ignored: never commit it or paste it anywhere. `NODE_ENV=production`, `SESSION_COOKIE_SECURE=1` and `TRUST_PROXY=1` are fixed in `docker-compose.yml`.

## 9. First start

```sh
deploy/deploy.sh
```

The first run pulls the base images and builds everything, which takes a few minutes. It then:
1. starts PostgreSQL;
2. applies all migrations;
3. starts the server and waits for its health check;
4. starts Caddy and checks `http://127.0.0.1:8080/api/health` on the VPS;
5. starts `cloudflared`, waits for the tunnel, and checks `https://$DOMAIN/api/health` through Cloudflare.

Expect these lines near the end:

```
… http://127.0.0.1:8080/api/health is ok
… the Cloudflare Tunnel is connected
… https://play.example.de/api/health is ok
… deployed <commit>
```

In the Zero Trust dashboard the tunnel now shows *Healthy*. Open `https://play.your-domain`, register your own account, then make it an admin:

```sh
deploy/admin.sh grant you@example.com admin
```

(`deploy/admin.sh revoke <email|handle>` takes it back; `moderator` is the other role. This runs the production `admin:role:prod` command inside the server container, see `docs/SOCIAL.md`.)

With `REGISTRATION_MODE=invite` you need an invite code for your own account too: create one first (next section), then register with it.

### Registration and invite codes

`REGISTRATION_MODE` in `deploy/.env` decides who may create an account (ticket D.2):

| Mode | Register screen | Use it when |
|------|-----------------|-------------|
| `open` | anyone can register | the game is public (also the default when the variable is unset, and in development, tests, playtest and e2e) |
| `invite` | asks for an invite code | a small, invited group (the default in `.env.example`) |
| `closed` | says registration is closed | you want no new accounts for now |

Login, existing accounts and their sessions work the same in every mode. After changing the value, apply it with `docker compose up -d server` (or the next `deploy/deploy.sh`).

Invite codes are created only by an admin on the server:

```sh
deploy/admin.sh invite create                                   # 1 use, expires in 14 days
deploy/admin.sh invite create --uses 10 --expires 30d --note "guild friends"
deploy/admin.sh invite list                                     # id, status, uses, expiry, note
deploy/admin.sh invite revoke <invite id|code>                  # accounts it created stay
```

Leaderboards (ticket 5.2, `docs/LEADERBOARDS.md`): `deploy/admin.sh leaderboards check` recomputes every stored board row with the game's formulas and compares it with the hero's current state (exit 1 if a stored value is wrong; stale or missing rows are listed and the running server's sweep fixes them by itself). `deploy/admin.sh leaderboards refresh` rewrites every hero's rows now, e.g. after a formula version bump; safe while the server runs. Nothing to run on deploy: migration `0025` only adds a table, and the server's scheduled sweep backfills existing heroes in batches of 200 per run (`SETTLE_INTERVAL_SECONDS`, default 5 minutes).

Community projects (ticket 4.6, `docs/COMMUNITY.md`): `deploy/admin.sh project status` prints each project's progress; `deploy/admin.sh project complete <projectId>` finishes an open project for everyone (playtesting only: it sets the world flag, cannot be undone, and is audited). The admin panel's status page shows the progress too.

`create` prints the code and a ready link, `https://$DOMAIN/#/register?invite=CODE`, which opens the register screen with the code filled in. **Copy it right away**: the code is random and only its SHA-256 hash is stored, so it cannot be shown again (create a new one instead). `--expires` takes `14d`, `12h`, `30m` or `never`. A code is used up after `--uses` accounts; a failed registration (e.g. a taken email) does not use it up. Which code created which account is in the audit log (`account.register` with `data.inviteId`); the code itself never appears in logs. Wrong codes count against the per-IP registration limit (5 per hour). In development the same commands are `pnpm admin:invite …`.

### Seasons

Seasons (ticket 5.3, `docs/LEADERBOARDS.md` "Seasons and prestige") do not start by themselves: schedule the first one, in the admin panel's **Seasons** tab or on the VPS. Times are UTC:

```bash
deploy/admin.sh seasons status
deploy/admin.sh seasons schedule --start 2026-12-07T00:00:00Z            # 8 weeks by default
deploy/admin.sh seasons schedule --start 2026-12-07T00:00:00Z --weeks 6  # or --end <ISO>
deploy/admin.sh seasons extend 1 --to 2027-02-08T00:00:00Z               # move the end (later or earlier)
deploy/admin.sh seasons end 1                                            # end the current season now
deploy/admin.sh seasons close                                            # seal and honour due seasons now
```

(`pnpm admin:seasons …` in development.) After that, each season follows the last one back to back for 8 weeks unless you re-plan the next one (`schedule` replaces a season that has not begun). A few minutes after a season ends, the running server seals its final standings and gives the honours (each scheduler run, `SETTLE_INTERVAL_SECONDS`); `close` does the same at once and is safe to repeat. Every change is audited. Migration `0026` only adds tables.

Trade patterns (ticket T.6, `docs/TRADING.md` "T.6 as built"): `deploy/admin.sh trading patterns` prints the trade pattern report of the last 28 days (`--days 1–90`, `--json` for the raw report): pairs with one-way flows or no other partners, the same invite or sign-up mailbox, accounts that received a lot while new, reached a weekly cap in several weeks, offered unprovenanced items or had trades reversed, and invite clusters. Players appear by handle and display name; no emails, ids or invite codes are printed. Read-only (`pnpm admin:trading patterns` in development). Moderators see the same report on the docket, and admins in the panel's "Trades" tab. Migration `0035` only adds three nullable columns and three indexes.

### Events
Rotating events (ticket 6.6, `docs/EVENTS.md`): you schedule each one, in the admin panel (Events tab) or here, or (ticket 8.3) let the **automatic calendar** rotate them. One runs at a time; times are UTC; every change is audited.

```bash
deploy/admin.sh events list                       # the events you can schedule (e.g. harvestOfBones)
deploy/admin.sh events schedule harvestOfBones --start 2026-11-23T00:00:00Z --days 7
deploy/admin.sh events status                     # current, next and past, with participation
deploy/admin.sh events extend 1 --to 2026-12-01T00:00:00Z   # move the end (later or earlier)
deploy/admin.sh events end 1                      # end the event under way now
deploy/admin.sh events cancel 2                   # call off one that has not begun
deploy/admin.sh events close                      # close ended events and give owed rewards now
```

The running server closes an ended event a few minutes after its end and gives any reward still owed, once. In development: `pnpm admin:events …`.

**The automatic calendar (ticket 8.3).** It **starts paused** (also here, after the deploy) and does nothing until you turn it on. Once on, the scheduler puts the next event of your rotation on the calendar when the last one has closed, starting on the first Monday 00:00 UTC at least the gap after its end (never in the past). An event of several weeks can't be given fewer days than its weeks (the Lantern Procession: 28); the commands and the panel refuse it with the minimum. An event you schedule by hand always wins: it replaces an automatic one that has not begun, and the rotation carries on after it. Same controls as the admin panel's Events tab ("The automatic calendar"):

```bash
deploy/admin.sh events calendar status            # on or paused, the rotation, the gap, the next 3 planned
deploy/admin.sh events calendar set --rotation lanternProcession:28,harvestOfBones:7 --gap 7
                                                  # the events in order with each length (days 1–28; a
                                                  # missing ":days" takes the event's own), the gap (0–60)
deploy/admin.sh events calendar resume            # turn it on
deploy/admin.sh events calendar pause             # stop creating new ones (a waiting one still begins)
deploy/admin.sh events calendar skip              # pass over the next one (cancels it if already waiting)
```

With two API instances (§17) only the leader of the event jobs creates events; a restart never creates one twice.

### Admin panel

Signed in as an admin, the footer has an **Admin panel** link (`/#/admin`, ticket D.3). It covers what you would otherwise do with `deploy/admin.sh` and `pnpm report:telemetry` on the VPS:
- **Invites:** create a code (uses, expiry, a note for yourself), shown once with a copy button for the code and the ready link; the list shows each code's status, uses, expiry, who created it and which accounts registered with it; revoke. The CLI above keeps working; both write the same audit rows.
- **Players:** look someone up by display name or handle: account age, role, the invite they joined with, heroes, sanctions and reports, with links into the moderator queue. Emails are never shown.
- **Telemetry:** the balance report for a date window, optionally checked against the audit log.
- **Server:** the deployed commit and build time, uptime, database, registration mode, accounts, heroes, active players (24 h / 7 d, counts only) and whether migrations are pending.
- **Seasons:** the current and next season with their dates and counts, past seasons; schedule or re-plan the next season, move a season's end (extend or shorten), or end the current season early. The same rules as `deploy/admin.sh seasons`.
- **Trading:** every trading switch and weekly limit (ticket T.2, `docs/TRADING.md` "Admin switches"), each with what it controls and what switching it off does to players, the limits with their hard maxima, the suggested launch order, and the change history (who, when, old and new value). At launch the master switch is off, so nothing can be traded until you turn it on. Change switches and numbers, then **Save changes**; a number over its hard maximum can't be saved. If another admin saved in between, you're told to reload instead of overwriting their change. A save takes effect on the server at once (with several instances, within a minute), without a deploy. Moderators see the same board read-only at the bottom of the moderator queue.
- **Trades** (ticket T.6): the trade history (everyone, one player or a pair), each trade's case with both sides in full and its audit trail, the reversal of a completed trade within 14 days (all or nothing, with a reason both players read and an optional sanction), and the trade pattern report. Moderators have the same desk on the docket.
- **Readiness** (ticket 8.6): the going-live checklist (`docs/GOING_LIVE.md`) at a glance, read-only: email, the privacy policy, reserved names, test accounts, Season 1, the first event, the trading launch step, the last backup, the deployed version and the `SHARED_STATE` mode, each done / needs attention / not set, with a link to the tab or the doc that changes it. Two actions: **Send test letter** (to an address you type, which is stored and logged nowhere; 3 an hour) and the ticks of what your privacy policy mentions (stored and audited). It never shows an SMTP setting, your legal text or a file path.
- **Roles:** who is moderator or admin. Granting and revoking stay on the server (`deploy/admin.sh grant|revoke`): there is deliberately no button, so a stolen admin session cannot create admins.

Everything there is audited on your account. To other players and moderators `/api/admin/*` does not exist (`404`); the trading settings' read view (`/api/mod/settings/trading`) is open to moderators, read-only.

The commit and build time come from `deploy/deploy.sh`, which passes them to the image build (`WORLDFORGE_GIT_SHA`, `WORLDFORGE_BUILD_TIME`); an image built another way shows "Not recorded".

### Admin tools (ticket D.4)

Two more admin tabs for testing and support. Everything is admin-only (`404` for everyone else), needs a reason, and writes an `admin.*` audit row on the player's account (who, what, before and after, the reason). Roles stay CLI-only: no tool can change one.

- **Inspector** (`#/admin/inspect/<handle>`): search by handle or display name, then the whole account on one page: test-account flag, "email verified" yes/no (never the address), sessions, login lock, account shelf, every hero with level, gold, materials, professions, quests, progress, daily limits, holds, arena defence and every item by location (pack, worn, Warehouse, shelf, escrow), deleted heroes, sanctions, open offers and the recent audit trail. **View as player** shows a hero's sheet read-only (gear, pack, Warehouse, stats, unlocked areas): nothing there can change the game.
- **Support tools** (any account): remove an item (from the pack, the gear, the Warehouse or the shelf; an item held after a trade or in an open offer is refused with the reason), refund or remove gold and materials (never below zero or into what is held after a trade), rename a hero, delete and restore a hero, log an account out everywhere, clear its login lock.
- **Testing tools** (only on **test accounts** or on your own account): grant an item (base, rarity, item level, Void, upgrade level; set pieces and Mythics are particular bases) after a preview of exactly the item that will be created, grant gold, materials or XP, set the level, set boss progress (which opens areas and Crypt tiers), set professions, reset the daily limits (rated duels, contracts, the merchant's stock for that hero), complete or reset quests, and fast-forward a hero's farming by up to the offline cap through the normal settlement. On your own account that is not a test account the panel warns you first: what you do shows on public boards. Granted items are account-bound for good and never tradeable. Setting progress, the level or XP, or granting an item awards what the new state earns at once (achievements and their cosmetics, the level-40 and boss and Heroic cosmetics), exactly as play would, and the admin audit row lists them (D.4b); clearing a flag or lowering a level takes nothing back.
- **Names** tab (ticket 6.9): the reserved names: the built-in ones (staff and the game, every boss, the town's people as players meet them) and the ones you add (a staff member's name, anything else). A new or changed display, hero or guild name that imitates one is refused (look-alike letters of other alphabets, accents, digits for letters, a capital `I` for a small `l`, other case, the name inside a longer one). Adding a name takes it from nobody: players who already carry it keep it (report and rename them if needed). The same on the server: `deploy/admin.sh reserved-name list`, `deploy/admin.sh reserved-name add <name> [--note <text>]`, `deploy/admin.sh reserved-name remove <name>` (only names you added; audited `admin.reserved_name.*`).
- **World** tab: the world flags (e.g. `ashenPassCleared`) with set/unset (affects every player, so typed confirmation), and the scheduler: last and next tick, each job's last run, the season under way and the next, and how many deleted heroes are due for the purge.
- **Destructive actions** (deleting a hero, removing an item, gold or materials, logging out everywhere, a world flag) open a full-view confirmation listing exactly what changes, and need the hero's name, the handle or the flag id typed.

**Test accounts** are set only on the server:

```
deploy/admin.sh test-account <handle> on    # mark (handle from the inspector or the profile)
deploy/admin.sh test-account <handle> off   # back to a normal account
```

**Rule (owner decision, 2026-11-11):** never switch a test account back to normal while it holds anything granted with the admin tools (items, gold, materials, XP). Switching it off releases all of it into the real game. Delete its heroes, or keep it a test account. Cheat tools used on the admin's own normal account create real value too, so test on a test account.


A test account is hidden from every leaderboard, the season archive and so its awards, and the arena ladder; it is matched in the arena only against other test accounts; it can't trade, give to the town works, or fight the guild boss in a guild with players who are not test accounts (ticket 6.10); and its telemetry is left out of the balance report (it still counts in the reconciliation). Turning the flag off puts it back on the boards as its heroes stand.

**Hero deletion** is a soft delete: the hero disappears for the player and is frozen, its farming is settled and stopped, its open trade offers are voided (escrow goes back), its shelf items move to another hero of the account (refused when there is none: take them off the shelf first; refused too while the hero has a dungeon run that is not claimed yet, ticket 6.10), its arena defence and board rows go. Guild roles belong to the account and don't change. Within **14 days** the inspector can restore it (refused when every hero slot is taken). After that, remove it for good:

```
deploy/admin.sh purge --dry-run    # list heroes past the 14 days
deploy/admin.sh purge              # delete them
```

A hero that a past trade still names is kept soft-deleted for good (the trade history stays complete); the purge reports it as kept. Locally: `pnpm admin:tools test-account <handle> on|off`, `pnpm admin:tools purge [--dry-run]`.

### Legal pages

The Impressum (`/#/impressum`) and the privacy policy (`/#/datenschutz`) are linked in the footer of every screen and in the consent line under the register button. Their text is **yours**: the image ships placeholder templates (`content/legal/*.md` in the repository, marked "Platzhalter" and shown with a "Template" note) that list what you must fill in. They are not legal advice.

On the server, put your own files in `~/worldforge/deploy/legal/`, which is mounted read-only into the server container at `/app/legal` (`LEGAL_DIR`). It is git-ignored and excluded from the image build, so your address never lands in the repository or an image:

```sh
cp content/legal/impressum.md content/legal/datenschutz.md deploy/legal/
nano deploy/legal/impressum.md     # fill in every [bracket]; delete the first line <!-- worldforge:template -->
nano deploy/legal/datenschutz.md
```

Changes show on the next page load; no restart or deploy needed. A file missing in `deploy/legal/` falls back to the template, and as long as the first line `<!-- worldforge:template -->` is there the page shows the "Template" note. The Markdown supports headings, paragraphs (a single line break stays a line break, handy for addresses), lists, `>` quotes, `---` rules, `**bold**`, `*italic*` and links (`https:`, `mailto:`, `tel:`); HTML is shown as plain text. Include `deploy/legal/` in your off-VPS copies (§10), since it is not in git.

### Email

Since ticket 5.7 the server sends a few letters: the link that verifies a player's email address (on registration and on an email change), the password-reset link, and short notices ("your password was changed", "your account has a new email address", the latter to the old address). It speaks plain **SMTP**, so any provider works: Brevo, Postmark, Amazon SES, Mailgun, Scaleway, your domain host's mail server, and others. Nothing about a provider is in the code; you choose one and put its settings in `deploy/.env`.

**Without mail** (no `SMTP_HOST`) the server starts and the game works as before: logins are unaffected, accounts stay "not verified", and "Forgot your password?" and "send the letter again" tell players that email is not set up on this server yet. The log says `email is not set up` at start. This is the state right after the update.

**To set it up:**
1. At your provider, add and verify your sending domain (e.g. `play.example.com` or `example.com`). The provider shows DNS records to add at Cloudflare (DNS → Records): typically an **SPF** `TXT` record (or an `include:` added to your existing SPF), one or more **DKIM** records (`TXT` or `CNAME`), and sometimes a return-path `CNAME`. Set them **DNS only** (grey cloud). Add a **DMARC** record too, starting gently: `TXT` on `_dmarc.example.com` with `v=DMARC1; p=none; rua=mailto:dmarc@example.com` (an address you read), and tighten to `p=quarantine` once reports look clean. Without SPF and DKIM, letters land in spam or are refused. Guides: your provider's "domain authentication" page; Cloudflare's "Email security DNS records" page.
2. Create SMTP credentials at the provider (often an API key used as the SMTP password).
3. In `deploy/.env` set:
   - `SMTP_HOST`, e.g. `smtp-relay.brevo.com`, `smtp.postmarkapp.com`, `email-smtp.eu-central-1.amazonaws.com`;
   - `SMTP_PORT`: `587` (STARTTLS, the default) or `465` (implicit TLS; `SMTP_SECURE` then defaults to `1`). The server refuses to send without TLS;
   - `SMTP_USER` and `SMTP_PASS`: the credentials (secrets: only in `deploy/.env`);
   - `MAIL_FROM`: the sender, e.g. `Worldforge <no-reply@play.example.com>`, on the verified domain;
   - `PUBLIC_BASE_URL` only if players open the game somewhere other than `https://$DOMAIN` (the default).
4. `deploy/deploy.sh`. The log shows `email is set up` and, a moment later, `SMTP connection and login ok`, or `SMTP check failed` with the error code (wrong host, port or password). A half-finished configuration (`SMTP_HOST` without `MAIL_FROM`, a user without a password) stops the server at start with a clear message, and `deploy.sh` rolls back.
5. Test: in the admin panel's **Readiness** tab, **Send test letter** to your own address (ticket 8.6; the address is stored nowhere), or register a throwaway account with your own address, or use "Forgot your password?" on your account; the letter should arrive within a minute. If not, check the provider's activity log and the server log (`docker compose logs server | grep mail`).

Letters are sent after the request finishes, so a slow provider never slows the game; failures are logged (without addresses) and counted in telemetry (`mail.send`). Links point to `PUBLIC_BASE_URL` and carry their token after `#`, so it never appears in Caddy's or Cloudflare's logs. **Privacy policy:** once you send letters, mention them in `deploy/legal/datenschutz.md`: verification and reset emails, the provider as a processor (sign its DPA), and that the address is used only for the account.

**Existing accounts** stay unverified until their players verify (a "Your email is not verified yet" strip with a "Later" button reminds them); nothing else changes for them. Trading (Phase 5, later) will require a verified address.

## 10. Backups

`deploy/backup.sh` writes a compressed `pg_dump` (custom format) to `deploy/backups/` and checks that it can be read back. It keeps **14 daily** and **8 weekly** dumps (`BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`, `BACKUP_DIR` in `.env`). `deploy.sh` also takes a `pre-deploy` dump before every update (the last 5 are kept). Manual dumps that are never pruned: `deploy/backup.sh --kind manual`.

**Nightly at 03:40** with the systemd timer (edit `User=` and the paths in the `.service` file first if your user or folder differ):

```sh
sudo cp ~/worldforge/deploy/systemd/worldforge-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now worldforge-backup.timer
systemctl list-timers worldforge-backup.timer     # next run
sudo systemctl start worldforge-backup.service     # one run now, to test
journalctl -u worldforge-backup -n 20              # its output
ls -lh ~/worldforge/deploy/backups/daily/
```

(If you prefer cron, `crontab -e` with `40 3 * * * /home/deploy/worldforge/deploy/backup.sh >> /home/deploy/worldforge-backup.log 2>&1` does the same.)

**Backup status for the admin panel** (ticket 8.6): after every good dump `backup.sh` writes `deploy/status/backup.json` with the time and the size only (`{"finishedAt":"…Z","bytes":…}`, mode 644), and the server reads it through a read-only mount (`./status:/app/status:ro`, `BACKUP_STATUS_FILE`) for the Readiness tab, which marks a backup older than 36 hours. `deploy.sh` creates `deploy/status/` (as your user, so Docker never creates it as root); the dumps themselves are never mounted into the server.

**Copy backups off the VPS.** A backup that lives only on the server is gone when the server is. At least weekly, pull them to another machine. On your computer:

```sh
rsync -av deploy@<server-ip>:worldforge/deploy/backups/ ./worldforge-backups/
```

(Windows: `scp -r deploy@<server-ip>:worldforge/deploy/backups .`) A storage box from your hosting provider with a nightly `rsync` works too. The dumps contain email addresses and password hashes: keep them private, and encrypt copies you store elsewhere (for example `gpg -c file.dump`).

**Restore** (replaces the whole database; every change since the dump is lost):

```sh
deploy/restore.sh deploy/backups/daily/worldforge-20261106-034012.dump
```

It shows the dump and asks you to type `RESTORE`. It then saves the current database to `backups/pre-restore/` (so a restore can itself be undone), stops the server, recreates the database from the dump, applies any newer migrations and starts the server again. Players are disconnected for about a minute. To restore a dump from your computer, copy it back first (`scp file.dump deploy@<server-ip>:worldforge/deploy/backups/manual/`). Try a restore once before you need it.

## 11. Updates

```sh
deploy/deploy.sh
```

It fast-forwards the checkout to `origin/main` and builds the new images while the old ones keep serving. Then it takes a pre-deploy dump, applies migrations and replaces the server container: Caddy holds API requests for up to 30 s, so players see a short pause rather than errors. It waits for the server's health check and for Caddy on `127.0.0.1:8080`, and if either fails it **rolls back to the previous images** automatically. A tunnel or Cloudflare problem only produces a warning, because rolling back the app would not fix it. Running it again with nothing new to deploy is harmless. Each run also refreshes the base images (security updates) and prunes old image layers.

- A failed **migration** leaves the database unchanged (one transaction) and the running server untouched. The error is in `deploy.sh`'s output, just above the failure.
- A rollback restores the *images*, not the database. Migrations are forward-only, so they stay applied. They are written to be additive, so the previous server keeps working. If it does not, restore the newest `backups/pre-deploy/` dump.
- Going back to an older commit by hand: `git reset --hard <commit>` and then `deploy/deploy.sh --no-pull`. The next normal `deploy.sh` fast-forwards to `main` again.
- Options: `--ref <commit>` (deploy a specific commit of `main`), `--no-pull` (deploy the checkout as it is), `--skip-backup`.
- Each deploy also pulls the newest `cloudflared` image (it runs with auto-update off).

### Data backfills

Some tickets need a one-shot data step on live data. It runs in the same one-shot `migrate` service, right after the migrations (`dist/db/migrate-cli.js`), so every deploy (and `restore.sh`) applies it before the new server starts; nothing is run by hand.

- **Achievements** (ticket 4.2): awards every account the achievements its existing progress already earned: each character's state (items, upgrade levels, level, crypt progress, quests) plus the audit log for items that were sold, salvaged or discarded and for past forge upgrades. It runs once per database, recorded in `data_backfills` under `achievements:<hash of the achievement ids>`, so adding an achievement later runs it again for the new one. It can never award twice: awards are unique per account and achievement (the primary key), one transaction per account, and a re-run or a crash half-way only fills in what is missing. The output line `Backfill achievements:…: N achievements for M accounts` (or `already done`) is in `deploy.sh`'s output.
- **Item binding** (ticket T.1, `docs/TRADING.md`): gives every item row from before T.1 its binding (worn or forged → account-bound, boss-hoard drops recognised from their stored crypt run and re-labelled `hoard:<dungeon>`, the rest by game-core's rarity and source table) and sets `unprovenanced` on bind-on-equip items whose creation isn't in the audit log. Unlike the achievements, it runs **in the server, in the background right after start-up**, so it never holds up a deploy and also catches rows the old server wrote while the new images were being built. One short transaction per character, item rows taken with `for update skip locked` (a row a request holds is left for the next start-up) and only rows still unbound are written, so it never overwrites an equip or a Forge action. It records `item-binding:t1` in `data_backfills` once no unbound row is left; after that every start-up skips it. The log line `item-binding backfill ran` (with the counts) or `… already done` is in `docker compose logs server`; a failure is logged and retried at the next start. Trading is off, so the minutes before it finishes matter only to tooltips.
- **Cosmetics** (ticket 6.8, `docs/COSMETICS.md`): right after the achievements, grants every account the collection-book cosmetics its existing progress already earned: those of its achievements (`account_achievements`, e.g. the Forgeward banner for every Forgeward contributor), its heroes' milestones (level 40, the Ashen Warden or the Forge Tyrant slain, the Heroic crypt cleared, read from each hero's level and progress) and its season honours (`season_awards`). Event keepsakes were granted by 6.6 already. Once per database and catalogue (`cosmetics:<hash of every id and source>` in `data_backfills`, so a new or moved cosmetic runs it again); exactly once per account and cosmetic (the primary key), one short transaction per account, so a re-run or a crash half-way only fills in what is missing. Each grant is audited `cosmetic.grant` with source `backfill:…`. Output line `Backfill cosmetics:…: N cosmetics for M accounts`.
- **Account growth** (ticket 9.4, `docs/ACCOUNTS.md`): right after the cosmetics, grants every account the character slots and offline-cap steps its heroes already earned (level 28, the Heroic crypt; level 10, the Gravewarden, crypt tier III, the Ashen Warden), read from each hero's level and progress. Once per database and rule set (`account-growth:<hash of every rule>` in `data_backfills`, so a new rule, like the 5th slot's community project, runs it again); at most once per account and grant (the primary key), one short transaction per account, so a re-run or a crash half-way only fills in what is missing. Each grant is audited `account.grow` with `backfill: true` and counts from the backfill's time. Output line `Backfill account-growth:…: N grants for M accounts`.
- **Awaken lock** (ticket 6.5c, `docs/AWAKENING.md`): locks items awakened under 0.6.9, before awakening locked its item, each with an `item.lock` audit row (`via: 'backfill'`). Like the item binding, it runs **in the server in the background after start-up**: one transaction, rows taken with `for update skip locked`, only awakened unlocked rows written. It records `awaken-lock:6.5c` in `data_backfills` once none is left; after that start-ups skip it (a later manual unlock is never undone). Log line `awaken-lock backfill ran` / `… already done`.
- **Name skeletons** (ticket 6.9, `docs/SOCIAL.md` "Look-alike and reserved names"): stores the look-alike skeleton of every display, hero and guild name taken before 6.9, so new names are compared against them (the names themselves are kept: grandfathered). Runs **in the server in the background after start-up**, like the item binding: rows walked by id in batches, a row written only if its name is still the one read. Recorded `name-skeletons:v<n>` in `data_backfills` (a new skeleton version runs it again). Log line `name-skeleton backfill ran` / `… already done`. Until it has finished (seconds), a new name is only compared with names chosen since 6.9.
- **Unlogged limiter tables** (ticket 6.9, §17): `migrate` switches `rate_limit_counters` and `login_throttle` to `UNLOGGED` after the migrations (once; output line `Unlogged: …`).
- The server's start-up backfills (item binding, awaken lock, name skeletons) run on one instance only: the one that takes their lead (§17); another instance starting at the same time logs `start-up backfills: another instance runs them`.
- A failing backfill fails the `migrate` step like a failed migration: the migrations it follows stay applied (they are additive), the running server is untouched, and the next deploy retries it.

## 12. Optional: deploy automatically from GitHub

`.github/workflows/deploy.yml` deploys every push to `main` once CI is green (and from *Actions → Deploy → Run workflow*). It does **nothing** until you enable it. It logs in with a dedicated SSH key that can only run `deploy <commit>`, nothing else.

1. On your computer: `ssh-keygen -t ed25519 -f worldforge-gh-deploy -N '' -C github-deploy`.
2. On the server, add the **public** key (`worldforge-gh-deploy.pub`) as one line to `~/.ssh/authorized_keys`, prefixed with the forced command:
   ```
   command="/home/deploy/worldforge/deploy/ssh-deploy.sh",restrict ssh-ed25519 AAAA… github-deploy
   ```
3. On the server, `ssh-keyscan -t ed25519 localhost` shows the host key. On your computer, `ssh-keyscan -t ed25519 <server-ip>` should print the same key after the address; that line is the known-hosts value.
4. On GitHub, under *Settings → Secrets and variables → Actions*:
   - **Secrets**: `DEPLOY_HOST` (the **server IP**; the domain points at Cloudflare, not at the VPS; GitHub secrets stay private), `DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY` (the content of the **private** file `worldforge-gh-deploy`), `DEPLOY_KNOWN_HOSTS` (the `ssh-keyscan` line).
   - **Variables**: `DEPLOY_ENABLED` = `true`; `DEPLOY_PORT` only if SSH is not on 22.
   - Optional: under *Settings → Environments → production*, add yourself as a required reviewer, so every deploy waits for your click. The secrets can live there instead of at repository level.
5. Delete the private key file from your computer, or keep it somewhere safe.

The workflow deploys exactly the commit CI tested (`deploy.sh` refuses commits that are not on `main`). Set `DEPLOY_ENABLED` to anything else to switch it off.

Separately, the *Deploy config* workflow builds and starts the whole stack on every PR that touches `deploy/`, the workflows or the dependencies, so a broken Dockerfile is caught before it reaches the server.

## 13. Logs and monitoring

```sh
cd ~/worldforge/deploy
docker compose ps                         # state and health of each service
docker compose logs -f --tail 100 server  # API logs (JSON, one line per request)
docker compose logs --tail 100 web        # Caddy
docker compose logs --tail 50 cloudflared # tunnel connections
curl -s http://127.0.0.1:8080/api/health  # the game on the VPS itself, without Cloudflare
docker stats --no-stream                  # memory and CPU per container
free -h                                   # RAM and swap
df -h /                                   # disk
docker system df                          # space used by images, volumes, build cache
du -sh ~/worldforge/deploy/backups
```

**Look at the game without Cloudflare** (e.g. while the tunnel is down). On your computer, run `ssh -L 8080:127.0.0.1:8080 deploy@<server-ip>`, then open <http://localhost:8080>.

Container logs are rotated (5 × 10 MB per service). Look at disk and backups about once a week. If the disk fills up, `docker builder prune -af` and `docker image prune -af` are safe to run. **Never** run `docker volume prune` or `docker compose down -v`: those delete the database.

An external uptime check on `https://play.your-domain/api/health` (any free uptime monitor) emails you when the game, the tunnel or the database is down. The endpoint answers `503` when the database is unreachable. The tunnel page in Zero Trust can also send notifications (*Notifications → Tunnel health*).

## 14. Troubleshooting

**Cloudflare error 1033 ("Argo Tunnel error"), or the tunnel shows *Inactive/Down*.** `cloudflared` is not connected: `docker compose ps cloudflared` and `docker compose logs --tail 50 cloudflared`. Usually the token is wrong or incomplete (copy it again from *Zero Trust → Networks → Tunnels → worldforge → Configure*), or `COMPOSE_PROFILES=tunnel` is missing from `.env`. After fixing `.env`: `deploy/deploy.sh --no-pull`.

**Cloudflare error 502 / "Bad gateway" while the tunnel is healthy.** The public hostname's service is wrong: it must be **HTTP** and **`web:80`** (not `localhost`, not HTTPS). Check `curl -s http://127.0.0.1:8080/api/health` on the VPS. If that fails, Caddy or the server is down: see the next item.

**Long pauses or 502 on `/api` only.** The server is down or restarting: `docker compose ps` and `docker compose logs --tail 100 server`. Common causes: a wrong `DATABASE_URL` or password (the server exits at startup with the reason), the database not healthy (`docker compose logs db`), or memory (`dmesg -T | grep -i oom`). `deploy/deploy.sh --no-pull` brings the stack back to the configured state.

**The site loads but logging in fails or every request is "Too many requests".** Check that requests come through the tunnel with the player's IP: `docker compose logs server | grep remoteAddress | tail` should show varied public addresses, not one `172.x` address. If every request shows the same address, traffic isn't reaching the server through Cloudflare (e.g. someone added a `ports:` line). Also make sure Bot Fight Mode is off (§1).

**Migration failed.** `deploy.sh`'s output names the failing statement (rerun the step alone with `docker compose run --rm migrate`). Nothing was applied (one transaction) and the old server keeps running. Report the error. Do not edit migration files on the server.

**`deploy.sh` says "local changes" or "not on main".** The clone was edited by hand: `git status`, then `git checkout -- .` (or `git switch main`). Your `.env` and backups are git-ignored and unaffected.

**Build killed or very slow.** Memory: check that swap is on (`free -h`), and if needed run `docker compose stop web server` during the build.

**Forgot the admin.** `deploy/admin.sh grant <email|handle> admin` works at any time.

## 15. Keeping the server's IP private

The tunnel keeps the IP out of DNS and off the web ports. Don't give it away elsewhere:
- **Never** create an `A`/`AAAA` record for the VPS, including `ssh.`, `vps.` or test names. Use the IP directly for SSH.
- Never add a public `ports:` entry to `docker-compose.yml`, and don't run other websites on this VPS under related names.
- Leave the VPS's reverse DNS (PTR, set at the hosting provider) at the provider's default; don't set it to your domain.
- Future email (password reset, ticket 1.2 follow-ups) must go through an email provider's API, not be sent from the VPS: mail headers carry the sending IP.
- If the IP has leaked anyway (e.g. an old `A` record existed), the clean fix is a new IP from the hosting provider. Then restore the latest backup on a fresh server, or ask the provider to swap the address.

## 16. Before going public

The step-by-step version, with how to check each step, is **`docs/GOING_LIVE.md`**; the admin panel's Readiness tab shows where you are.


Worldforge is ready to run for a **small, invited group**. Before you advertise it:

- [ ] **Email is set up** (§9 "Email"): without it, a player who forgets their password cannot get back in on their own, and nobody can verify their address. Send yourself a reset letter once to check SPF/DKIM.
- [ ] **Datenschutzerklärung (privacy policy)** in `deploy/legal/datenschutz.md` (§9 "Legal pages"): required in Germany as soon as you store accounts. It must cover what is stored (email, display name, password hash, game data, IP addresses in the server's request logs, which rotate at 5 × 10 MB; the rate limits keep only a hash of the address, for the length of the limit's window), the hoster and Cloudflare as processors (sign the hoster's AV contract / DPA; Cloudflare's DPA is part of its terms), retention and the players' rights. The template lists these points; the content must come from you (a generator or a lawyer).
- [ ] **Impressum** in `deploy/legal/impressum.md`: required for a German public website that is not purely private. The content (name, address, contact per § 5 DDG) comes from you.
- [ ] **`REGISTRATION_MODE`** is what you want (`invite` for a closed group, §9).
- [ ] **Backups are copied off the VPS** and a restore has been tried once (§10).
- [ ] **An uptime check** on `/api/health` (§13).
- [ ] Keep it **semi-private** (share the link with testers rather than publicly) until the Phase 4 hardening ticket (4.11) has reviewed the social features for abuse and privacy.

## 17. Running two API instances

Ticket 6.9. Production runs **one** `server` container, and that stays the default. Everything an instance used to keep for itself is now shared through PostgreSQL, so a second instance (more CPU for requests, or a rolling restart without the 30 s hold) is safe. Nothing else is needed: no Redis, no sticky sessions.

**What is shared, and how**

| What | Where | How it holds across instances |
| --- | --- | --- |
| Sessions, idempotency keys, all game state | PostgreSQL (as before) | Row and advisory locks; nothing was ever per instance |
| Every rate limit: per account (requests and actions), social writes, trade writes, board and ladder reads, the admin reconcile, mail letters, the per-IP login, registration, forgot-password and token limits | `rate_limit_counters` (unlogged) | One atomic `insert … on conflict … do update … returning` per counted request: fixed windows from the first request, a refused request counted in no window. Parallel requests on two instances count exactly like sequential ones on one |
| The per-address login lock (5.7) and its parallel-guess rule (5.8) | `login_throttle` (unlogged) | Each check is reserved under the address's row lock; a reservation lapses after 60 s, so an instance that dies mid-check frees it |
| World flags (4.6), game settings (T.2), season windows and board formulas (5.3, 6.1) | Each instance's cache, versioned in `cache_versions` | The writing transaction bumps the cache's version and sends `NOTIFY wf_cache` (delivered on commit). Every instance listens on its own connection and drops its copy at once. An instance that missed a notify (its listener dropped and is reconnecting) compares the versions every 15 s, and every cache still expires after 60 s: a change reaches every instance within 60 s whatever happens. The owner's CLIs (`project`, `seasons`, `leaderboards`) bump too |
| Event state (6.6) | PostgreSQL | Not cached: read from its tables on every request |
| The scheduler: settlement, pruning, the leaderboard sweep, season jobs, event close, the trade sweep (offer expiry and hold release); the start-up backfills | One advisory lock per job | Each instance's timer ticks, but a job runs only on the instance holding its session lock (`pg_try_advisory_lock`) on a dedicated connection. If that instance dies or its connection drops, PostgreSQL frees the lock and another instance takes the job at its next tick. Jobs are idempotent, so the moment of a handover can at most repeat a harmless run. The admin panel's World tab shows `standby: another instance runs it` on the instance that does not lead a job |
| Presence ("last seen", 4.3) | PostgreSQL, throttled per process | Each instance writes at most once every 3 minutes per account: two instances mean at most twice as many tiny upserts. Nothing to share |

**What it costs on the 2-vCPU VPS.** One extra small write per signed-in request (and per counted auth request), on an unlogged table: no WAL, so no fsync and nothing for backups to replay. Measured against PostgreSQL 16 on a 4-vCPU development machine (`src/shared/scale.pg.test.ts`, logged on every CI run): a counted request costs **about 1.1 ms of round trip** one after another (mean 1.04–1.17 ms, p95 1.3–1.4 ms over three runs), and with ten clients at once `GET /api/account` served 603–720 requests a second against 625–733 with the in-process store: **0.27 ms per request at most, within the run-to-run noise** (the write overlaps with the request's other queries). The busiest real player sends about 22 requests a minute, so the limiter adds well under 1 % of the database's work. The test fails above a budget of 10 ms per counted request, far above what a healthy database takes and far below a lock wait. Expired windows and idle login entries are deleted by the hourly pruning job (one delete each; the tables hold a few rows per active account and address). The trade-off of `UNLOGGED`: after a database crash (not a clean restart) the tables are empty, so every count starts over, just as an API restart forgot them before 6.9; and they are not replicated (there is no replica). Each instance holds two extra database connections (the scheduler leader's and the notify listener): keep `DATABASE_POOL_MAX` × instances + 4 under PostgreSQL's `max_connections` (100 here).

`SHARED_STATE=memory` (in `deploy/.env`) counts the limits in the server process instead, as before 6.9: for one instance only, never with two.

**Compose changes for two instances** (not applied in this repository: production keeps one):

1. In `deploy/docker-compose.yml`, give the `server` service `deploy: { replicas: 2 }` (or copy it as `server2` with the same environment). Keep `SHARED_STATE=postgres`.
2. Halve the memory where needed: two servers at 768 MB plus the database fit 4 GB only just; set `mem_limit: 640m` and `NODE_OPTIONS=--max-old-space-size=448` on each, and `DATABASE_POOL_MAX=8`.
3. Caddy: with replicas, `reverse_proxy server:3000` resolves both containers through Docker's DNS; to list them explicitly use `reverse_proxy server:3000 server2:3000 { lb_policy round_robin … }`. **No sticky sessions:** every request can go to either instance (the session is a database row, the limits are shared).
4. `deploy.sh` restarts the services as before; with two instances, restart them one after the other for no downtime (`docker compose up -d --no-deps server` then `server2`). Migrations still run once, in the one-shot `migrate` service, before either starts.
5. Watch `docker compose logs server` for `scheduler: this instance now leads the job` (one line per job, on one instance) and, after a database restart, `cache notify connection lost; reconnecting` followed by normal operation.
