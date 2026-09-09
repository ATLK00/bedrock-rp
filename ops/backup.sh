#!/usr/bin/env bash
# Backs up the production postgres + redis data stores managed by
# ops/docker-compose.prod.yml. Run from the host (the compose services must be
# up). Outputs timestamped dumps into ops/backups/ (or $BACKUP_DIR) and prunes
# files older than RETENTION_DAYS.
#
#   ops/backup.sh                       # -> ops/backups/postgres_<ts>.dump + redis_<ts>.rdb
#   BACKUP_DIR=/srv/backups RETENTION_DAYS=30 ops/backup.sh
#
# Cron example (every 3h):
#   0 */3 * * * /path/to/bedrock-rp/ops/backup.sh >> /var/log/bedrock-rp-backup.log 2>&1

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# cd first so the compose `-f` arg is a relative path: MSYS path-conversion
# then only needs disabling for the in-container redis path, not for the
# compose file.
cd "$DIR"
COMPOSE=(docker compose -f docker-compose.prod.yml)
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-$DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

# Pull POSTGRES_USER/POSTGRES_DB from the compose .env so pg_dump targets the
# same database as the running stack.
if [[ -f "$DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$DIR/.env"
  set +a
fi
PG_USER="${POSTGRES_USER:-bedrock_rp}"
PG_DB="${POSTGRES_DB:-bedrock_rp}"

mkdir -p "$BACKUP_DIR"

echo "[backup] ${STAMP} postgres -> ${BACKUP_DIR}/postgres_${STAMP}.dump"
"${COMPOSE[@]}" exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --format=custom \
  > "$BACKUP_DIR/postgres_${STAMP}.dump"

echo "[backup] ${STAMP} redis -> ${BACKUP_DIR}/redis_${STAMP}.rdb"
"${COMPOSE[@]}" exec -T redis redis-cli SAVE >/dev/null
# /data/dump.rdb is a path *inside the redis container*. Without this,
# Git-Bash/MSYS would rewrite the leading /data as a Windows path and the
# cat would look for the file on the host, not in the container.
MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" exec -T redis cat /data/dump.rdb > "$BACKUP_DIR/redis_${STAMP}.rdb"

echo "[backup] pruning backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'postgres_*.dump' -mtime "+${RETENTION_DAYS}" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'redis_*.rdb' -mtime "+${RETENTION_DAYS}" -delete

echo "[backup] done (${BACKUP_DIR}/postgres_${STAMP}.dump, ${BACKUP_DIR}/redis_${STAMP}.rdb)"