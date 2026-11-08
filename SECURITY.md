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
- **Login throttling:** per client IP (10 a minute) and per account: after 5 wrong passwords for one address, each further failure locks that address for a while (30 seconds, doubling up to 15 minutes). Unknown addresses lock the same way, and the answers and timing are the same for known and unknown addresses, so neither login nor its lock reveals whether an account exists. A password reset is never blocked by the lock and lifts it.
- **Email verification and password reset** use single-use links that expire (24 hours to verify, 30 minutes to reset), are stored only as hashes, work only for the address they were sent to and are replaced by any newer link. "Forgot your password?" gives the same answer, in about the same time, for every address, and sends at most 3 letters an hour to one address. Setting a new password logs out every device, voids every outstanding link and sends a notice to the account's address.
- **Email changes** need the current password; the old address is told (without the new one).
- **"Log out other devices"** on the account screen ends every other session.
- **Unverified accounts** play normally. Trading will require a verified email address. Expired sessions and links are deleted hourly.
- **Registration** logs the new player in at once and answers "address already taken" for a known address (owner decision, 2026-11-08: instant play over hiding taken addresses; registration is invite-only, so only invite holders could probe).
- Mail is sent over the operator's SMTP provider; tokens travel in the part of the link after `#`, which browsers never send to a server.

## Supported versions

Only the current `main` branch, which is what the live site runs, receives security fixes.
