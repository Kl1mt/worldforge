# Deploy Worldforge on your own server

This guide takes a fresh **Debian 13 (trixie)** VPS to a public Worldforge at `https://your-domain`, with HTTPS, nightly backups and one-command updates. It assumes the reference machine: 2 vCPU, 4 GB RAM, ~40 GB free disk. Expect about an hour the first time.

You type the commands in a terminal **on the server** unless a step says "on your computer". Lines starting with `sudo` need the deploy user's password.

Ticket D.1. Files: `deploy/` (Dockerfile, Compose stack, Caddyfile, scripts, systemd timer) and `.github/workflows/deploy.yml` (optional automatic deploys).

## What runs where

```
Internet ──► :80/:443  web     Caddy 2: HTTPS (Let's Encrypt), static client, /api ─┐
                                                                                     ▼
                       server  Node 22, `node dist/index.js`, port 3000 (not published)
                                                                                     ▼
                       db      PostgreSQL 16, volume `db-data` (no port published, internal network)
                       migrate one-shot: applies migrations before the server starts, then exits
```

- **One origin**: the browser loads the client and calls `/api` on the same domain, so there is no CORS and the session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api`) works as in development.
- **Single API instance.** Rate limits live in process memory (`docs/TECH_STACK.md`), so do not scale the server to several containers.
- **The server never migrates on startup.** `deploy.sh` runs the `migrate` service first, in one transaction.
- **Memory caps** (fit 4 GB with room for the OS and image builds): db 1 GB (`shared_buffers` 256 MB), server 768 MB (V8 heap 512 MB), Caddy 256 MB.
- The e2e and playtest servers (`pnpm e2e:serve`, `pnpm playtest`) are not in the image: the production build excludes them, the image build fails if they appear, and both refuse `NODE_ENV=production`.

Commands below that start with `docker compose` are run **in `~/worldforge/deploy`**. The `deploy/*.sh` scripts work from any directory.

---

## 1. Domain and DNS

At your DNS provider, create records for the name players will use (for example `play.example.de`), pointing at the VPS:

| Type   | Name   | Value                        |
| ------ | ------ | ---------------------------- |
| `A`    | `play` | the VPS's IPv4 address       |
| `AAAA` | `play` | the VPS's IPv6 address (if it has one) |

Check from your computer: `ping play.example.de` should answer from the VPS's address (DNS changes can take up to an hour). Let's Encrypt needs this **before** the first start.

With an `AAAA` record, also set `ENABLE_IPV6=true` in step 7. Otherwise Docker relays IPv6 players through its proxy and they all appear to the game under one internal address, which means they share one login rate limit.

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

Open a **new** terminal and check that `ssh deploy@<server-ip>` logs you in without the server password. Keep the root session open until step 3 is done.

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

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp      # HTTP/3
sudo ufw enable
sudo ufw status verbose
```

Docker writes its own firewall rules for **published** ports, and these bypass ufw. That is why the stack publishes only 80 and 443 (Caddy). The server and the database have no `ports:` entry, so they stay unreachable from outside whatever ufw says. Never add a `ports:` line to `db` or `server`.

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

Log out and back in (so the `docker` group applies), then check: `docker run --rm hello-world` and `docker compose version` (v2.24 or newer).

Membership in the `docker` group is equivalent to root on this machine. Keep the `deploy` account's key safe.

## 6. Get the code

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

## 7. Configure

```sh
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
openssl rand -hex 32          # copy this: it becomes POSTGRES_PASSWORD
nano deploy/.env
```

Set at least:
- `DOMAIN`: the name from step 1, without `https://`.
- `ACME_EMAIL`: your email, for Let's Encrypt notices.
- `POSTGRES_PASSWORD`: the random hex string. Leave `DATABASE_URL` as it is, because it is built from the `POSTGRES_*` values.
- `ENABLE_IPV6=true` if you created an `AAAA` record.

Every variable is explained in `deploy/.env.example`. `deploy/.env` is git-ignored: never commit it or paste it anywhere. `NODE_ENV=production`, `SESSION_COOKIE_SECURE=1` and `TRUST_PROXY=1` are fixed in `docker-compose.yml`. `TRUST_PROXY=1` is safe here because Caddy is the only thing that can reach the server, and Caddy replaces any `X-Forwarded-For` a client sends with the real client address. That lets the rate limits see each player's own IP.

## 8. First start

```sh
deploy/deploy.sh
```

The first run pulls the base images and builds everything, which takes a few minutes. It then starts PostgreSQL, applies all migrations, starts the server, waits for its health check, starts Caddy (which gets the certificate) and checks `https://$DOMAIN/api/health`. It ends with `deployed <commit>`.

Open `https://your-domain`, register your own account, then make it an admin:

```sh
deploy/admin.sh grant you@example.com admin
```

(`deploy/admin.sh revoke <email|handle>` takes it back; `moderator` is the other role. This runs the production `admin:role:prod` command inside the server container, see `docs/SOCIAL.md`.)

## 9. Backups

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
rsync -av deploy@play.example.de:worldforge/deploy/backups/ ./worldforge-backups/
```

(Windows: `scp -r deploy@play.example.de:worldforge/deploy/backups .`) A storage box from your hosting provider with a nightly `rsync` works too. The dumps contain email addresses and password hashes: keep them private, and encrypt copies you store elsewhere (for example `gpg -c file.dump`).

**Restore** (replaces the whole database; every change since the dump is lost):

```sh
deploy/restore.sh deploy/backups/daily/worldforge-20261106-034012.dump
```

It shows the dump and asks you to type `RESTORE`. It then saves the current database to `backups/pre-restore/` (so a restore can itself be undone), stops the server, recreates the database from the dump, applies any newer migrations and starts the server again. Players are disconnected for about a minute. To restore a dump from your computer, copy it back first (`scp file.dump deploy@play.example.de:worldforge/deploy/backups/manual/`). Try a restore once before you need it.

## 10. Updates

```sh
deploy/deploy.sh
```

It fast-forwards the checkout to `origin/main` and builds the new images while the old ones keep serving. Then it takes a pre-deploy dump, applies migrations and replaces the server container: Caddy holds API requests for up to 30 s, so players see a short pause rather than errors. It waits for the health check, and if the new server does not become healthy it **rolls back to the previous images** automatically. Running it again with nothing new to deploy is harmless. Each run also refreshes the base images (security updates) and prunes old image layers.

- A failed **migration** leaves the database unchanged (one transaction) and the running server untouched. The error is in `deploy.sh`'s output, just above the failure.
- A rollback restores the *images*, not the database. Migrations are forward-only, so they stay applied. They are written to be additive, so the previous server keeps working. If it does not, restore the newest `backups/pre-deploy/` dump.
- Going back to an older commit by hand: `git reset --hard <commit>` and then `deploy/deploy.sh --no-pull`. The next normal `deploy.sh` fast-forwards to `main` again.
- Options: `--ref <commit>` (deploy a specific commit of `main`), `--no-pull` (deploy the checkout as it is), `--skip-backup`.

## 11. Optional: deploy automatically from GitHub

`.github/workflows/deploy.yml` deploys every push to `main` once CI is green (and from *Actions → Deploy → Run workflow*). It does **nothing** until you enable it. It logs in with a dedicated SSH key that can only run `deploy <commit>`, nothing else.

1. On your computer: `ssh-keygen -t ed25519 -f worldforge-gh-deploy -N '' -C github-deploy`.
2. On the server, add the **public** key (`worldforge-gh-deploy.pub`) as one line to `~/.ssh/authorized_keys`, prefixed with the forced command:
   ```
   command="/home/deploy/worldforge/deploy/ssh-deploy.sh",restrict ssh-ed25519 AAAA… github-deploy
   ```
3. On the server, `ssh-keyscan -t ed25519 localhost` shows the host key. On your computer, `ssh-keyscan -t ed25519 play.example.de` should print the same key after the name; that line is the known-hosts value.
4. On GitHub, under *Settings → Secrets and variables → Actions*:
   - **Secrets**: `DEPLOY_HOST` (`play.example.de`), `DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY` (the content of the **private** file `worldforge-gh-deploy`), `DEPLOY_KNOWN_HOSTS` (the `ssh-keyscan` line).
   - **Variables**: `DEPLOY_ENABLED` = `true`; `DEPLOY_PORT` only if SSH is not on 22.
   - Optional: under *Settings → Environments → production*, add yourself as a required reviewer, so every deploy waits for your click. The secrets can live there instead of at repository level.
5. Delete the private key file from your computer, or keep it somewhere safe.

The workflow deploys exactly the commit CI tested (`deploy.sh` refuses commits that are not on `main`). Set `DEPLOY_ENABLED` to anything else to switch it off.

Separately, the *Deploy config* workflow builds and starts the whole stack on every PR that touches `deploy/`, the workflows or the dependencies, so a broken Dockerfile is caught before it reaches the server.

## 12. Logs and monitoring

```sh
cd ~/worldforge/deploy
docker compose ps                         # state and health of each service
docker compose logs -f --tail 100 server  # API logs (JSON, one line per request)
docker compose logs --tail 100 web        # Caddy: certificates, proxy errors
docker stats --no-stream                  # memory and CPU per container
free -h                                   # RAM and swap
df -h /                                   # disk
docker system df                          # space used by images, volumes, build cache
du -sh ~/worldforge/deploy/backups
```

Container logs are rotated (5 × 10 MB per service). Look at disk and backups about once a week. If the disk fills up, `docker builder prune -af` and `docker image prune -af` are safe to run. **Never** run `docker volume prune` or `docker compose down -v`: those delete the database and the certificates.

An external uptime check on `https://your-domain/api/health` (any free uptime monitor) emails you when the game or the database is down. The endpoint answers `503` when the database is unreachable.

## 13. Troubleshooting

**No certificate / browser warning.** `docker compose logs web | grep -i -E 'acme|certificate|error'`. Usually the DNS record does not point at this server yet (`getent hosts play.example.de` on the server should print its own address), or port 80/443 is closed at the provider's firewall (some providers have one in their web console as well as ufw). Let's Encrypt limits failed attempts, so fix DNS first and then `docker compose restart web`. The certificates live in the `caddy-data` volume and renew automatically.

**502 Bad Gateway or long pauses on `/api`.** The server is down or restarting: `docker compose ps` and `docker compose logs --tail 100 server`. Common causes: a wrong `DATABASE_URL` or password (the server exits at startup with the reason), the database not healthy (`docker compose logs db`), or memory (`dmesg -T | grep -i oom`). `deploy/deploy.sh --no-pull` brings the stack back to the configured state.

**Migration failed.** `deploy.sh`'s output names the failing statement (rerun the step alone with `docker compose run --rm migrate`). Nothing was applied (one transaction) and the old server keeps running. Report the error. Do not edit migration files on the server.

**`deploy.sh` says "local changes" or "not on main".** The clone was edited by hand: `git status`, then `git checkout -- .` (or `git switch main`). Your `.env` and backups are git-ignored and unaffected.

**"network … enable_ipv6" error after changing `ENABLE_IPV6`.** The network must be recreated: `docker compose down` (without `-v`), then `deploy/deploy.sh --no-pull`.

**Build killed or very slow.** Memory: check that swap is on (`free -h`), and if needed run `docker compose stop web server` during the build.

**Forgot the admin.** `deploy/admin.sh grant <email|handle> admin` works at any time.

## 14. Before going public

Worldforge is ready to run for a **small, invited group**. Before you advertise it:

- [ ] **No password reset or email verification yet** (ticket 1.2 follow-ups). A player who forgets their password cannot get back in on their own. Tell testers, or be ready to help by hand.
- [ ] **Datenschutzerklärung (privacy policy)**: required in Germany as soon as you store accounts. It must cover what is stored (email, display name, password hash, game data, IP addresses in the server's request logs, which rotate at 5 × 10 MB, and in the in-memory rate limits), the hoster as processor (sign the hoster's AV contract / DPA), retention and the players' rights. The content must come from you (a generator or a lawyer). The game can host the pages later.
- [ ] **Impressum**: required for a German public website that is not purely private. The content (name, address, contact) comes from you; the code can host the page later.
- [ ] **Backups are copied off the VPS** and a restore has been tried once (§9).
- [ ] **An uptime check** on `/api/health` (§12).
- [ ] Keep it **semi-private** (share the link with testers rather than publicly) until the Phase 4 hardening ticket (4.11) has reviewed the social features for abuse and privacy.
