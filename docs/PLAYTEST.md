# Playtest Worldforge on your own computer

This guide takes you from nothing to playing the Phase 1 build on Windows, macOS or Linux. You don't need to be a developer. Expect about 15 minutes the first time, most of it for installing tools.

You type every command in a **terminal**:
- **Windows:** open *PowerShell* (Start menu → type "PowerShell").
- **macOS:** open *Terminal* (Spotlight → type "Terminal").
- **Linux:** open your terminal app.

Paste a command, press Enter and wait until it finishes before you run the next one.

**Short version** (when Git, Node 22 and pnpm are already installed):

```sh
git clone https://github.com/Kl1mt/worldforge.git
cd worldforge
pnpm install
pnpm playtest
```

Then open <http://localhost:5173>.

---

## 1. Install the prerequisites

You need **Git** (to download the code), **Node.js 22** (runs the game) and **pnpm** (installs its parts). **Docker is not needed**: `pnpm playtest` keeps the game's database in a folder inside the project.

### Windows

1. **Git:** `winget install --id Git.Git -e` (or the installer from <https://git-scm.com/download/win>). Close and reopen PowerShell afterwards.
2. **Node 22** with **nvm-windows**: download `nvm-setup.exe` from <https://github.com/coreybutler/nvm-windows/releases> and run it. Then open a *new* PowerShell **as administrator** (right-click → "Run as administrator") and run:
   ```powershell
   nvm install 22
   nvm use 22
   ```
   (Alternative: `winget install Schniz.fnm`, then `fnm install 22` and `fnm use 22`. Without a version manager, the "LTS 22" installer from <https://nodejs.org/en/download> also works.)
3. **pnpm:** in the same administrator PowerShell, run `corepack enable`. Close it and open a normal PowerShell.

### macOS

1. **Git:** `xcode-select --install` (installs Apple's command line tools, including Git). With Homebrew, `brew install git` works too.
2. **Node 22** with **fnm**:
   ```sh
   curl -fsSL https://fnm.vercel.app/install | bash
   ```
   Close and reopen Terminal, then run `fnm install 22` and `fnm use 22`. (With Homebrew: `brew install fnm`, then follow the line it prints about your shell profile. With nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`, reopen Terminal, `nvm install 22`.)
3. **pnpm:** `corepack enable`.

### Linux

1. **Git:** `sudo apt install git` (Debian/Ubuntu) or `sudo dnf install git` (Fedora).
2. **Node 22** with **fnm**: `curl -fsSL https://fnm.vercel.app/install | bash`, reopen the terminal, then `fnm install 22` and `fnm use 22` (or nvm, as on macOS).
3. **pnpm:** `corepack enable` (if it says permission denied, your Node came from a system package; use fnm/nvm instead).

### Check

Run `node --version` (should print `v22.something`, at least `v22.12`) and `pnpm --version` (should print `10.something`; the first time, corepack may ask to download pnpm, answer `Y`).

---

## 2. Download, install and start

```sh
git clone https://github.com/Kl1mt/worldforge.git
cd worldforge
pnpm install
pnpm run doctor
pnpm playtest
```

- `pnpm install` downloads the project's parts (a minute or two the first time).
- `pnpm run doctor` checks your setup and tells you what to fix. Every line should be ✔ (Docker may show `!` or `·`; that's fine). Type `pnpm run doctor`, not `pnpm doctor`: the short form runs pnpm's own built-in check instead.
- `pnpm playtest` starts the game. When it prints **"Worldforge is running"**, open <http://localhost:5173> in your browser (Chrome, Firefox, Edge or Safari). Keep the terminal open while you play.

Your progress is saved in the `.playtest-data` folder in the project and is kept between runs.

Coming back another day: open a terminal, go to the folder (`cd worldforge`) and run `pnpm playtest` again. To get the newest version first, stop the game and run `git pull` and then `pnpm install`.

---

## 3. What to try

1. **Register.** Choose *Create account* and enter an email (it is never checked or sent anywhere; `me@test.local` is fine), a display name and a password of at least 10 characters.
2. **Create a character.** Pick a name and one of the four classes (Warrior, Mage, Hunter, Warlock). You get two character slots, so you can try a second class later.
3. **Farm.** On *Abandoned Fields* (Area), press **Farm Abandoned Fields**. Your hero fights on their own; the *Chronicle* shows kills, XP, gold and drops. At real time a kill takes a few seconds and loot takes a few minutes.
4. **Inventory and equipment.** Open *Pack*, click an item to see its tooltip and the comparison with what you wear, then **Equip** it. *Equipment & stats* shows the change in your stats.
5. **Log out** (top right) or simply close the browser tab.
6. **Come back later** and log in. A **"While you were away"** summary shows what your hero earned. Offline progress stops after **3 hours**; the summary says how much time earned nothing.

The rest of Graumark (Phase 2; it takes about 30 hours of farming at real time to see it all, so use fast time):

7. **Town and map.** The town is home. On the *World Map*, new areas open as your hero levels (Crowwood at 5, Old Burial Grounds at 9, Blackwater at 13); pick one to travel there.
8. **Tavern.** Take the story quest and up to three contracts a day; they fill while you farm, even offline. Turn them in for XP, gold and sometimes an item.
9. **Materials and professions.** Farming gathers timber, herbs, hides and ore; see them under *Pack → Materials* and the professions on the *Character* screen.
10. **Merchant and Forge.** Sell what you don't wear, buy from the daily stock, salvage items into materials and commission gear at the Forge.
11. **The Nameless Crypt** (level 12+, from the map). A run takes a few minutes and can't be stopped; claim the spoils at the end. Defeating the Gravewarden (and reaching level 17) opens the **Sunken Abbey**.

To see step 6 and the later steps without waiting hours, use fast time (next section).

---

## 4. Fast time (see offline progress in minutes)

```sh
pnpm playtest:fast
```

This speeds up the **game's farming clock** on your local server 60 times: one real minute is one game hour, so the 3-hour offline cap is reached after about 3 real minutes away. Another speed: `pnpm playtest -- --fast=120` (any number from 1 up).

- It is off unless you start with `playtest:fast` or `--fast`, and only exists in this local playtest server (never in a real deployment).
- It only changes how fast farming time passes. Logins and sessions use real time, and the game rules are unchanged.
- Time never runs backwards: after a fast session, the game clock stays ahead of the real one (that's why times in the Chronicle may look like "the future"). Switching back to `pnpm playtest` continues at normal speed from there.
- Balance feels very different at ×60 (lots of loot quickly). Judge balance at real time.
- Fast time also speeds up crypt runs and the game day: merchant stock and Tavern contracts renew every game day (24 real minutes at ×60). The merchant's "Restocks in …" countdown is measured against your computer's clock, so it looks too long under fast time.

---

## 5. Stop the game

Press **Ctrl+C** in the terminal running `pnpm playtest` (on macOS also Ctrl, not Cmd). Wait for "Stopping… (your progress is saved)" and the prompt to come back. If Windows asks "Terminate batch job (Y/N)?", answer `Y`.

If you closed the terminal window instead, the game has stopped too.

After a session, `pnpm report:telemetry` (with the game stopped) prints what the playtest world did in aggregate: drops by rarity, gold sources and sinks, crypt wins and losses, forge spending. It reads `.playtest-data/` and holds no player data (`docs/TELEMETRY.md`).

---

## 6. Start over (delete all game data)

Stop the game first, then:

```sh
pnpm playtest:reset
```

This deletes all accounts, characters, items and progress of the local playtest (the `.playtest-data` folder). The next `pnpm playtest` starts with an empty world. It refuses to run while the game is still running.

---

## 7. Troubleshooting

Run `pnpm run doctor` first; it catches most problems and prints a fix.

**"Port 3000 (server) / 5173 (web) is already in use".** Another program, often an earlier `pnpm playtest` or `pnpm dev` in another terminal, uses the port. Close that terminal or press Ctrl+C there. To find the program:
- Windows: `netstat -ano | findstr :5173` (the last number is the process id), then `taskkill /PID <id> /F`.
- macOS/Linux: `lsof -i :5173`, then `kill <PID>`.

Or start on other ports: `pnpm playtest -- --server-port=3001 --web-port=5174` and open <http://localhost:5174>.

**"A playtest server is already running".** It is, probably in another terminal: use that one or stop it with Ctrl+C. If you are sure nothing is running (for example after a crash), the message goes away by itself, because the check looks at whether that process still exists.

**"Node v… is running, but Worldforge needs Node 22".** Run `fnm use 22` or `nvm use 22` in the project folder (on Windows, `nvm use 22` in an administrator PowerShell). Then `node --version` should print v22. If you installed Node 22 from nodejs.org but an older version still shows, close and reopen the terminal.

**`pnpm` is not recognized / command not found.** Run `corepack enable` (on Windows in an administrator PowerShell) and open a new terminal. If corepack fails, `npm install -g pnpm@10` works too.

**"Dependencies are not installed" or errors about missing modules** (e.g. after `git pull`). Run `pnpm install`.

**The server stops with a migration or database error.** The playtest server sets up and upgrades its database on every start. If a newer version can't open data from an older one, or the data folder was damaged (e.g. by a power cut), reset it: `pnpm playtest:reset` (this deletes your playtest progress). With the Docker setup (`pnpm dev`): check that the database runs (`pnpm db:up`) and run `pnpm db:migrate`; to start that database from scratch, `docker compose down -v` and `pnpm db:up` again.

**Docker isn't running / "Cannot connect to the Docker daemon".** Only matters for `pnpm dev` (the developer setup with PostgreSQL in Docker). Start Docker Desktop and wait until it says it is running. You don't need Docker for `pnpm playtest`.

**Registration or login seems to work, but you land back on the login screen.** The browser didn't keep the login cookie.
- Open the game at exactly <http://localhost:5173> (not an IP address like `192.168.…`, and not `https://`).
- `pnpm playtest` sends a cookie that works over plain `http://` on your machine in every browser. The developer setup (`pnpm dev`) marks the cookie `Secure`, which Chrome, Edge and Firefox accept on `http://localhost` but Safari may reject; there, put `SESSION_COOKIE_SECURE=0` in `apps/server/.env` (or use another browser).
- Don't block cookies for `localhost` in your browser settings. Private windows work, but forget the login when closed.

**"Still not ready after 2 minutes".** The first start after installing can be slow. Scroll up for a red message; otherwise stop with Ctrl+C and start again.

**The page says the server can't be reached.** The terminal running `pnpm playtest` was closed or stopped. Start it again.

Still stuck? Copy the output of `pnpm run doctor` and the last lines of the `pnpm playtest` terminal into the feedback form (`docs/PLAYTEST_FEEDBACK.md`).

---

## 8. Giving feedback

Fill in [`docs/PLAYTEST_FEEDBACK.md`](PLAYTEST_FEEDBACK.md) as you play (make a copy if you test more than once). It goes into Phase 2 planning.

---

## For developers: how the playtest mode works

- `pnpm playtest` runs `tools/playtest/run.mjs`, which checks Node, dependencies and ports, then starts `apps/server/src/playtest/serve.ts` and the Vite dev server as plain Node processes (no shell, so Windows behaves like macOS/Linux) and waits for both before printing the address. Options: `--fast[=N]`, `--server-port=N`, `--web-port=N`; env: `PLAYTEST_DATA_DIR`, `LOG_LEVEL` (default `warn`), `OFFLINE_CAP_SECONDS`.
- `serve.ts` is the real `buildApp()` on PGlite persisted to `PLAYTEST_DATA_DIR` (default `.playtest-data/`, git-ignored), migrated on every start. Like the e2e server it is excluded from the production build and refuses `NODE_ENV=production`. Auth, validation, rate limits and game rules are unchanged. Differences: `SESSION_COOKIE_SECURE` defaults to `0` (plain http on this machine only; Safari), scheduled settlement every `PLAYTEST_SETTLE_INTERVAL_SECONDS` (default 30), and `PLAYTEST_TIME_SCALE` (default 1).
- Fast time is a server-side clock (`apps/server/src/playtest/clock.ts`) injected as `activity.now`; its offset from real time is saved in `.playtest-data/clock.json` and floored by the newest game timestamp stored (farming, crypt runs, quests, purchases, items: `playtest/stored-time.ts`, ticket 2.8), so it never runs backwards across restarts, even with a hero in the crypt.
- A `server.lock` file (pid) prevents two servers from opening the same PGlite files; `pnpm playtest:reset` refuses while that pid runs and only deletes a folder containing playtest files.
- `pnpm run doctor` (`tools/doctor.mjs`) needs no dependencies, so `node tools/doctor.mjs` works before `pnpm install`.
