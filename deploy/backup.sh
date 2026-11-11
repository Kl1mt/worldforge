#!/usr/bin/env bash
# Dumps the database (pg_dump custom format, compressed) and prunes old dumps (docs/DEPLOY.md §10).
#
#   deploy/backup.sh                  nightly dump: keeps BACKUP_KEEP_DAILY (14) daily dumps,
#                                     and one per week for BACKUP_KEEP_WEEKLY (8) weeks
#   deploy/backup.sh --kind manual    a dump that is never pruned automatically
#
# Kinds: daily (default), manual, pre-deploy (deploy.sh, keeps 5), pre-restore (restore.sh,
# keeps 5). Prints the new file's path on stdout. After a good dump it also writes
# deploy/status/backup.json (the time and size only) for the admin panel's Readiness tab.
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

kind=daily
while (($#)); do
  case $1 in
    --kind)
      [[ $# -ge 2 ]] || die "--kind needs a value"
      kind=$2
      shift
      ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
case $kind in daily | manual | pre-deploy | pre-restore) ;; *) die "unknown kind: $kind" ;; esac

require_setup
take_lock
service_running db || die "the db container is not running (docker compose up -d db)"

root=$(backup_root)
umask 077
mkdir -p "$root/$kind"
file="$root/$kind/worldforge-$(date '+%Y%m%d-%H%M%S').dump"
tmp="$file.partial"
trap 'rm -f "$tmp"' EXIT

log "dumping the database to $file"
# shellcheck disable=SC2016 # expanded by the shell inside the db container
compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6' >"$tmp"
# A dump that pg_restore cannot list is not a backup.
compose exec -T db pg_restore --list <"$tmp" >/dev/null || die "the dump is not readable"
mv "$tmp" "$file"
log "done: $(du -h "$file" | cut -f1)"

# Ticket 8.6: the admin panel's Readiness tab shows the last good backup. The status file holds a
# time and a size only (no path, no name); the server reads it through a read-only mount.
write_backup_status() {
  local dir="$DEPLOY_DIR/status" bytes
  bytes=$(wc -c <"$file" | tr -d ' ')
  mkdir -p "$dir" && chmod 755 "$dir" &&
    printf '{"finishedAt":"%s","bytes":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$bytes" >"$dir/backup.json.partial" &&
    chmod 644 "$dir/backup.json.partial" &&
    mv "$dir/backup.json.partial" "$dir/backup.json"
}
write_backup_status || warn "could not write the backup status file (deploy/status/backup.json)"

# prune DIR KEEP: keeps the KEEP newest dumps (file names sort by time).
prune() {
  local dir=$1 keep=$2 old
  [[ -d $dir ]] || return 0
  find "$dir" -maxdepth 1 -name 'worldforge-*.dump' | sort -r | tail -n +"$((keep + 1))" |
    while IFS= read -r old; do
      log "pruning $old"
      rm -f -- "$old"
    done
}

case $kind in
  daily)
    mkdir -p "$root/weekly"
    # Promote one dump per week (Sundays, or whenever the newest weekly is older than 7 days).
    if [[ $(date +%u) == 7 ]] || [[ -z $(find "$root/weekly" -maxdepth 1 -name 'worldforge-*.dump' -mtime -7) ]]; then
      ln "$file" "$root/weekly/" 2>/dev/null || cp "$file" "$root/weekly/"
      log "kept as this week's dump"
    fi
    prune "$root/daily" "$(env_get BACKUP_KEEP_DAILY 14)"
    prune "$root/weekly" "$(env_get BACKUP_KEEP_WEEKLY 8)"
    ;;
  pre-deploy | pre-restore) prune "$root/$kind" 5 ;;
esac
printf '%s\n' "$file"
