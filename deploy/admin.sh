#!/usr/bin/env bash
# Grants or revokes moderator/admin roles inside the running server container: the production
# build's `admin:role:prod` command (dist/social/role-cli.js; docs/SOCIAL.md, docs/DEPLOY.md §8).
#
#   deploy/admin.sh grant <email|handle> <moderator|admin>
#   deploy/admin.sh revoke <email|handle>
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if (($# == 0)) || [[ $1 == -h || $1 == --help ]]; then
  sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi
require_setup
service_running server || die "the server container is not running (deploy/deploy.sh)"
compose exec -T server node dist/social/role-cli.js "$@"
