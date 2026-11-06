#!/usr/bin/env bash
# Admin commands inside the running server container (docs/DEPLOY.md §9 and "Registration"):
# account roles (the production `admin:role:prod` build, dist/social/role-cli.js; docs/SOCIAL.md)
# and invite codes (`admin:invite:prod`, dist/auth/invite-cli.js; ticket D.2).
#
#   deploy/admin.sh grant <email|handle> <moderator|admin>
#   deploy/admin.sh revoke <email|handle>
#   deploy/admin.sh invite create [--uses N] [--expires 14d|12h|30m|never] [--note "…"]
#   deploy/admin.sh invite list
#   deploy/admin.sh invite revoke <invite id|code>
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if (($# == 0)) || [[ $1 == -h || $1 == --help ]]; then
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi
require_setup
service_running server || die "the server container is not running (deploy/deploy.sh)"
if [[ $1 == invite ]]; then
  shift
  compose exec -T server node dist/auth/invite-cli.js "$@"
else
  compose exec -T server node dist/social/role-cli.js "$@"
fi
