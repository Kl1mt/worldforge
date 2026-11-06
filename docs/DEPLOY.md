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
- **Single API instance.** Rate limits live in process memory (`docs/TECH_STACK.md`), so do not scale the server to several containers.
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

`create` prints the code and a ready link, `https://$DOMAIN/#/register?invite=CODE`, which opens the register screen with the code filled in. **Copy it right away**: the code is random and only its SHA-256 hash is stored, so it cannot be shown again (create a new one instead). `--expires` takes `14d`, `12h`, `30m` or `never`. A code is used up after `--uses` accounts; a failed registration (e.g. a taken email) does not use it up. Which code created which account is in the audit log (`account.register` with `data.inviteId`); the code itself never appears in logs. Wrong codes count against the per-IP registration limit (5 per hour). In development the same commands are `pnpm admin:invite …`.

### Legal pages

The Impressum (`/#/impressum`) and the privacy policy (`/#/datenschutz`) are linked in the footer of every screen and in the consent line under the register button. Their text is **yours**: the image ships placeholder templates (`content/legal/*.md` in the repository, marked "Platzhalter" and shown with a "Template" note) that list what you must fill in. They are not legal advice.

On the server, put your own files in `~/worldforge/deploy/legal/`, which is mounted read-only into the server container at `/app/legal` (`LEGAL_DIR`). It is git-ignored and excluded from the image build, so your address never lands in the repository or an image:

```sh
cp content/legal/impressum.md content/legal/datenschutz.md deploy/legal/
nano deploy/legal/impressum.md     # fill in every [bracket]; delete the first line <!-- worldforge:template -->
nano deploy/legal/datenschutz.md
```

Changes show on the next page load; no restart or deploy needed. A file missing in `deploy/legal/` falls back to the template, and as long as the first line `<!-- worldforge:template -->` is there the page shows the "Template" note. The Markdown supports headings, paragraphs (a single line break stays a line break, handy for addresses), lists, `>` quotes, `---` rules, `**bold**`, `*italic*` and links (`https:`, `mailto:`, `tel:`); HTML is shown as plain text. Include `deploy/legal/` in your off-VPS copies (§10), since it is not in git.

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

Worldforge is ready to run for a **small, invited group**. Before you advertise it:

- [ ] **No password reset or email verification yet** (ticket 1.2 follow-ups). A player who forgets their password cannot get back in on their own. Tell testers, or be ready to help by hand.
- [ ] **Datenschutzerklärung (privacy policy)** in `deploy/legal/datenschutz.md` (§9 "Legal pages"): required in Germany as soon as you store accounts. It must cover what is stored (email, display name, password hash, game data, IP addresses in the server's request logs, which rotate at 5 × 10 MB, and in the in-memory rate limits), the hoster and Cloudflare as processors (sign the hoster's AV contract / DPA; Cloudflare's DPA is part of its terms), retention and the players' rights. The template lists these points; the content must come from you (a generator or a lawyer).
- [ ] **Impressum** in `deploy/legal/impressum.md`: required for a German public website that is not purely private. The content (name, address, contact per § 5 DDG) comes from you.
- [ ] **`REGISTRATION_MODE`** is what you want (`invite` for a closed group, §9).
- [ ] **Backups are copied off the VPS** and a restore has been tried once (§10).
- [ ] **An uptime check** on `/api/health` (§13).
- [ ] Keep it **semi-private** (share the link with testers rather than publicly) until the Phase 4 hardening ticket (4.11) has reviewed the social features for abuse and privacy.
