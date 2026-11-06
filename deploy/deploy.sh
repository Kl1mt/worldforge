#!/usr/bin/env bash
# Deploys main: pull → build → backup → migrate → restart → health check, and rolls the app
# images back if the new server does not become healthy. Safe to re-run (docs/DEPLOY.md §10).
#
#   deploy/deploy.sh                 fast-forward to origin/main and deploy
#   deploy/deploy.sh --ref <sha>     deploy that commit (must be on origin/main; used by CI)
#   deploy/deploy.sh --no-pull       deploy the current checkout as is (first start, testing)
#   deploy/deploy.sh --skip-backup   skip the pre-deploy database dump
set -euo pipefail
# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

ref='' pull=1 backup=1
while (($#)); do
  case $1 in
    --ref)
      [[ $# -ge 2 ]] || die "--ref needs a commit"
      ref=$2
      shift
      ;;
    --no-pull) pull=0 ;;
    --skip-backup) backup=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
  shift
done

require_setup
[[ $(env_get POSTGRES_PASSWORD) != change-me ]] || die "set a real POSTGRES_PASSWORD in $ENV_FILE"
domain=$(env_get DOMAIN)
[[ -n $domain && $domain != play.example.com ]] || die "set DOMAIN in $ENV_FILE"
take_lock

# --- 1. Code ---------------------------------------------------------------------------------
cd "$REPO_DIR"
if ((pull)); then
  [[ $(git rev-parse --abbrev-ref HEAD) == main ]] || die "the checkout is not on main"
  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "the checkout has local changes (git status)"
  fi
  log "fetching origin/main"
  git fetch --quiet origin main
  target=${ref:-origin/main}
  git rev-parse --verify --quiet "$target^{commit}" >/dev/null || die "unknown commit: $target"
  git merge-base --is-ancestor "$target" origin/main || die "$target is not on origin/main"
  # Never moves backwards: an older --ref than HEAD is already contained, so this is a no-op.
  git merge --ff-only --quiet "$target"
elif [[ -n $ref ]]; then
  die "--ref and --no-pull exclude each other"
fi
rev=$(git rev-parse --short HEAD)
log "deploying $rev: $(git log -1 --format=%s)"

# --- 2. Build (the running containers keep serving meanwhile) --------------------------------
images=(worldforge-server worldforge-web)
for image in "${images[@]}"; do
  if docker image inspect "$image:latest" >/dev/null 2>&1; then
    docker image tag "$image:latest" "$image:previous"
  fi
done
log "building images"
compose build --pull server web

restore_previous_tags() {
  local image
  for image in "${images[@]}"; do
    if docker image inspect "$image:previous" >/dev/null 2>&1; then
      docker image tag "$image:previous" "$image:latest"
    fi
  done
}

# --- 3. Backup (skipped on the very first start, when there is no database yet) --------------
if ((backup)) && service_running db; then
  log "pre-deploy backup"
  "$DEPLOY_DIR/backup.sh" --kind pre-deploy >/dev/null
fi

# --- 4. Migrate (one transaction; a failure leaves the database as it was) -------------------
compose up -d --wait db
log "applying migrations"
if ! compose run --rm --no-TTY migrate; then
  restore_previous_tags
  die "migration failed (output above); the database and the running server are unchanged"
fi

# --- 5. Restart and verify ---------------------------------------------------------------------
# Caddy holds /api requests for up to 30 s while the server container is replaced.
log "restarting the server"
compose up -d --no-deps server
if ! wait_healthy server 150; then
  compose logs --tail 50 server >&2 || true
  if docker image inspect worldforge-server:previous >/dev/null 2>&1; then
    warn "the new server is not healthy; rolling back to the previous images"
    restore_previous_tags
    compose up -d --no-deps server web
    if wait_healthy server 150; then
      die "deploy of $rev failed and was rolled back (the checkout stays at $rev; migrations are not undone)"
    fi
    die "deploy of $rev failed and the rollback is not healthy either: check 'docker compose logs server'"
  fi
  die "the server is not healthy and there is no previous image to roll back to"
fi
compose up -d --no-deps web

# End to end through Caddy and the real certificate. Not fatal: DNS or certificate trouble is
# not fixed by rolling back the app (docs/DEPLOY.md §13).
curl_args=(-fsS --max-time 10 --resolve "$domain:443:127.0.0.1")
[[ $domain == localhost ]] && curl_args+=(-k)
if command -v curl >/dev/null 2>&1; then
  ok=0
  for _ in $(seq 1 30); do
    if curl "${curl_args[@]}" "https://$domain/api/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 3
  done
  if ((ok)); then
    log "https://$domain/api/health is ok"
  else
    warn "https://$domain/api/health is not reachable yet (certificate or DNS? docker compose logs web)"
  fi
fi

# --- 6. Clean up old layers so builds don't fill the disk ------------------------------------
docker image prune -f >/dev/null || true
docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
log "deployed $rev"
