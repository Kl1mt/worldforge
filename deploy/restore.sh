#!/usr/bin/env bash
# Replaces the database with a dump from backup.sh (docs/DEPLOY.md §9). Takes a safety dump
# first, stops the server, restores, applies newer migrations and starts the server again.
#
#   deploy/restore.sh deploy/backups/daily/worldforge-20261106-033000.dump
#   deploy/restore.sh <file> --yes      no prompt (scripts only)
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

file='' yes=0
while (($#)); do
  case $1 in
    --yes) yes=1 ;;
    -h | --help)
      sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown argument: $1" ;;
    *)
      [[ -z $file ]] || die "only one dump file"
      file=$1
      ;;
  esac
  shift
done
[[ -n $file ]] || die "usage: deploy/restore.sh <dump-file> [--yes]"
[[ -f $file && -r $file ]] || die "cannot read $file"

require_setup
take_lock
compose up -d --wait db
compose exec -T db pg_restore --list <"$file" >/dev/null || die "$file is not a pg_dump custom-format dump"

log "dump:     $file ($(du -h "$file" | cut -f1), $(date -r "$file" '+%Y-%m-%d %H:%M'))"
log "replaces: database '$(env_get POSTGRES_DB)' behind https://$(env_get DOMAIN)"
log "Every change since this dump is lost. Players are disconnected for about a minute."
if ((!yes)); then
  [[ -t 0 ]] || die "not a terminal: pass --yes to restore without the prompt"
  read -r -p "Type RESTORE to continue: " answer
  [[ $answer == RESTORE ]] || die "aborted, nothing changed"
fi

safety=$("$DEPLOY_DIR/backup.sh" --kind pre-restore)
log "safety dump of the current database: $safety"

log "stopping the server"
compose stop server
log "recreating the database"
# shellcheck disable=SC2016 # expanded by the shell inside the db container
compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --force --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"'
log "restoring"
# shellcheck disable=SC2016 # expanded by the shell inside the db container
if ! compose exec -T db sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' <"$file"; then
  die "restore failed; the server stays stopped. To go back: deploy/restore.sh $safety"
fi
log "applying migrations newer than the dump"
compose run --rm --no-TTY migrate || die "migration after restore failed; the server stays stopped"
compose up -d --no-deps server
wait_healthy server 150 || die "the server is not healthy after the restore (docker compose logs server)"
log "restored $file"
