#!/usr/bin/env bash
# Admin commands inside the running server container (docs/DEPLOY.md §9 and "Registration"):
# account roles (the production `admin:role:prod` build, dist/social/role-cli.js; docs/SOCIAL.md)
# and invite codes (`admin:invite:prod`, dist/auth/invite-cli.js; ticket D.2); seasons (5.3);
# the trade pattern report (T.6); events (6.6).
#
#   deploy/admin.sh grant <email|handle> <moderator|admin>
#   deploy/admin.sh revoke <email|handle>
#   deploy/admin.sh invite create [--uses N] [--expires 14d|12h|30m|never] [--note "…"]
#   deploy/admin.sh invite list
#   deploy/admin.sh invite revoke <invite id|code>
#   deploy/admin.sh project status            (community projects, ticket 4.6)
#   deploy/admin.sh project complete <projectId>   (finishes it for everyone; cannot be undone)
#   (`project stage <projectId>`, ticket 6.7, is for test setups and refused here: NODE_ENV=production)
#   deploy/admin.sh leaderboards check         (recompute every board row, ticket 5.2)
#   deploy/admin.sh leaderboards refresh       (rewrite every hero's rows from current state)
#   deploy/admin.sh seasons status             (current, next and past seasons, ticket 5.3)
#   deploy/admin.sh seasons schedule --start 2026-12-07T00:00:00Z [--weeks 8 | --end <ISO>]
#   deploy/admin.sh seasons end <number>       (ends the season under way now)
#   deploy/admin.sh seasons extend <number> --to <ISO>   (moves a season's end)
#   deploy/admin.sh seasons close              (takes due archives and awards now)
#   deploy/admin.sh events status              (current, next and past events, ticket 6.6)
#   deploy/admin.sh events list                (the events you can schedule)
#   deploy/admin.sh events schedule harvestOfBones --start 2026-11-23T00:00:00Z [--days 7 | --end <ISO>]
#   deploy/admin.sh events end|cancel <number> (end the event under way now / call off a future one)
#   deploy/admin.sh events extend <number> --to <ISO>   (moves an event's end)
#   deploy/admin.sh events close               (closes ended events and sweeps their rewards now)
#   deploy/admin.sh trading patterns [--days 28] [--json]   (trade pattern report, ticket T.6)
#   deploy/admin.sh test-account <handle> on|off   (mark a test account for the admin tools, D.4)
#   deploy/admin.sh purge [--dry-run]          (delete heroes soft-deleted over 14 days ago, D.4)
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if (($# == 0)) || [[ $1 == -h || $1 == --help ]]; then
  sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi
require_setup
service_running server || die "the server container is not running (deploy/deploy.sh)"
if [[ $1 == invite ]]; then
  shift
  compose exec -T server node dist/auth/invite-cli.js "$@"
elif [[ $1 == project ]]; then
  shift
  compose exec -T server node dist/community/project-cli.js "$@"
elif [[ $1 == leaderboards ]]; then
  shift
  compose exec -T server node dist/leaderboards/leaderboard-cli.js "$@"
elif [[ $1 == seasons ]]; then
  shift
  compose exec -T server node dist/seasons/season-cli.js "$@"
elif [[ $1 == events ]]; then
  shift
  compose exec -T server node dist/events/event-cli.js "$@"
elif [[ $1 == test-account || $1 == purge ]]; then
  compose exec -T server node dist/admin/admin-cli.js "$@"
elif [[ $1 == trading ]]; then
  shift
  compose exec -T server node dist/trading/trading-cli.js "$@"
else
  compose exec -T server node dist/social/role-cli.js "$@"
fi
