#!/usr/bin/env bash
# Publishes local screenshots to the `screenshots` branch (they are not kept on main).
#   tools/screenshots/publish.sh docs/screenshots/phase-5 [message]
# Copies the folder into the same path on the `screenshots` branch, commits and pushes it.
# Run from the repo root. Needs push access to origin. Never touches your current branch.
set -euo pipefail
src="${1:?usage: publish.sh <folder under docs/screenshots> [message]}"
msg="${2:-Screenshots: ${src#docs/screenshots/}}"
case "$src" in docs/screenshots/*) ;; *) echo "folder must be under docs/screenshots/" >&2; exit 1 ;; esac
[ -d "$src" ] || { echo "no such folder: $src" >&2; exit 1; }
root="$(git rev-parse --show-toplevel)"
wt="$(mktemp -d)"
trap 'git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true; rm -rf "$wt"' EXIT
git -C "$root" fetch -q origin screenshots
git -C "$root" worktree add -q --detach "$wt" origin/screenshots
mkdir -p "$wt/$src"
cp -R "$root/$src/." "$wt/$src/"
git -C "$wt" add -A "$src"
if git -C "$wt" diff --cached --quiet; then echo "nothing new to publish"; exit 0; fi
git -C "$wt" commit -q -m "$msg"
for delay in 2 4 8 16 0; do
  if git -C "$wt" push -q origin HEAD:screenshots; then break; fi
  [ "$delay" = 0 ] && { echo "push failed" >&2; exit 1; }
  sleep "$delay"; git -C "$wt" pull -q --rebase origin screenshots
done
echo "published $src to the screenshots branch: https://github.com/Kl1mt/worldforge/tree/screenshots/$src"
