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

## Supported versions

Only the current `main` branch, which is what the live site runs, receives security fixes.
