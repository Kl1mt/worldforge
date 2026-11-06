# shellcheck shell=bash
# Shared helpers for the deploy/*.sh scripts (ticket D.1, docs/DEPLOY.md). Sourced, not run.

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
export DEPLOY_DIR REPO_DIR ENV_FILE

# Progress goes to stderr, so a script's stdout can carry a result (backup.sh prints the path).
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
warn() { log "WARNING: $*"; }
die() {
  log "ERROR: $*"
  exit 1
}

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml" \
    --env-file "$ENV_FILE" "$@"
}

# env_get KEY [default]: a plain value from deploy/.env (no interpolation, quotes stripped).
env_get() {
  local key=$1 default=${2-} line value
  line=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)
  value=${line#*=}
  value=${value%\"}
  value=${value#\"}
  value=${value%\'}
  value=${value#\'}
  printf '%s' "${value:-$default}"
}

require_setup() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed (docs/DEPLOY.md §5)"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing (docs/DEPLOY.md §5)"
  [[ -f $ENV_FILE ]] || die "missing $ENV_FILE: cp deploy/.env.example deploy/.env and fill it in"
}

# One deploy/backup/restore at a time. Child scripts inherit the lock via WORLDFORGE_LOCK_HELD.
take_lock() {
  [[ ${WORLDFORGE_LOCK_HELD:-} == 1 ]] && return 0
  exec 9>"$DEPLOY_DIR/.lock"
  flock -w "${1:-900}" 9 || die "another deploy, backup or restore is still running"
  export WORLDFORGE_LOCK_HELD=1
}

backup_root() {
  local dir
  dir=$(env_get BACKUP_DIR backups)
  [[ $dir == /* ]] || dir="$DEPLOY_DIR/$dir"
  printf '%s' "$dir"
}

service_running() { [[ -n $(compose ps --status running -q "$1" 2>/dev/null) ]]; }

# wait_healthy SERVICE [seconds]: waits for the container's Docker health check to pass.
wait_healthy() {
  local service=$1 deadline=$((SECONDS + ${2:-120})) id status
  while ((SECONDS < deadline)); do
    id=$(compose ps -q "$service" 2>/dev/null || true)
    if [[ -n $id ]]; then
      status=$(docker inspect -f '{{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo '0 missing')
      case $status in
        '0 healthy') return 0 ;;
        *' unhealthy' | *' exited' | *' dead') return 1 ;;
        0\ *) ;;
        *) return 1 ;; # crashed and restarted by Docker: not going to be healthy
      esac
    fi
    sleep 2
  done
  return 1
}
