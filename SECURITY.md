# Security policy

Worldforge runs live at a public website with real player accounts. Thank you for helping keep it safe.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for security problems.**

Report it privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- what the problem is and where (route, screen or file);
- the steps to reproduce it;
- what an attacker could do with it.

You should get a first reply within a few days. Please give us reasonable time to fix the problem before you share details anywhere else.

## What counts

Examples of what we want to hear about:

- getting into another player's account, characters, items or private data;
- getting a role (moderator or admin) or reaching admin or moderator routes without one;
- changing gold, items, loot, combat results or other game values the server should decide;
- duplicating items or gold, for example through races or replayed requests;
- leaking emails, IP addresses, session tokens, invite codes or other secrets;
- bypassing sanctions, blocks, privacy settings or invite-only registration.

## Rules for testing

- Use only accounts you own. Never access, change or delete other players' data.
- No denial-of-service, load testing, spam or automated scanning against the live site.
- No social engineering of players or the operator.
- Prefer testing against a local copy (`pnpm playtest`, see `docs/PLAYTEST.md`) over the live site.

Testing in good faith within these rules will not lead to action against you.

## Accounts

How player accounts are protected (ticket 5.7; details in `docs/API_CONVENTIONS.md` "Auth & sessions"):

- **Passwords** are stored as argon2id hashes. Sessions are random 256-bit tokens in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; only their SHA-256 is stored.
- **Login throttling:** per client IP (10 a minute) and per account: after 5 wrong passwords for one address, each further failure locks that address for a while (30 seconds, doubling up to 15 minutes). Unknown addresses lock the same way, and the answers and timing are the same for known and unknown addresses, so neither login nor its lock reveals whether an account exists. A password reset is never blocked by the lock and lifts it. Guesses sent together get no more checks than the same guesses one after another (ticket 5.8: a check is reserved before the password is read; before, every guess already in flight when the lock started was still checked).
- **Email verification and password reset** use single-use links that expire (24 hours to verify, 30 minutes to reset), are stored only as hashes, work only for the address they were sent to and are replaced by any newer link. "Forgot your password?" gives the same answer, in about the same time, for every address, and sends at most 3 letters an hour to one address. Setting a new password logs out every device, voids every outstanding link and sends a notice to the account's address.
- **Email changes** need the current password (under the same throttle as login); the old address is told (without the new one); at most 3 an hour per account, with or without mail set up (ticket 5.8), so the "address already taken" answer can't be used to test addresses faster than registration.
- **Rate limits:** every limit and its value is listed in `docs/SOCIAL.md` "Rate limits: the Phase 5 review" (ticket 5.8). They live in the API process's memory: one API instance until a shared store exists.
- **"Log out other devices"** on the account screen ends every other session.
- **Unverified accounts** play normally. Trading will require a verified email address. Expired sessions and links are deleted hourly.
- **Registration** logs the new player in at once and answers "address already taken" for a known address (owner decision, 2026-11-08: instant play over hiding taken addresses; registration is invite-only, so only invite holders could probe).
- Mail is sent over the operator's SMTP provider; tokens travel in the part of the link after `#`, which browsers never send to a server.

## Admin tools

Ticket D.4 (`docs/DEPLOY.md` "Admin tools", `docs/SOCIAL.md` "Admin tools"). What a stolen admin session can and can't do:
- It can't create admins or test accounts: roles and the test-account flag change only on the server (CLI). It can't see emails, password data or session tokens (a test checks every admin answer for them).
- Testing tools that mint value (items, gold, materials, XP, levels, progress) work only on test accounts and the admin's own account. Test accounts can't trade and are off the boards, so minted value can't reach other players or the rankings; on the admin's own account it would show on the boards, and the panel says so.
- Support tools change other players' accounts (removals, refunds, deletion, rename, logout); every one needs a reason, an `Idempotency-Key`, typed confirmation where destructive, and leaves an `admin.*` audit row with before and after. Deleting a hero is restorable for 14 days; only the CLI purges.
- Admin writes follow the gameplay lock order (shelf, account row, the admin's row, the hero, its items), so they can't race a trade, a shelf move or farming into a bad state (real-Postgres race tests).

## Supported versions

Only the current `main` branch, which is what the live site runs, receives security fixes.
