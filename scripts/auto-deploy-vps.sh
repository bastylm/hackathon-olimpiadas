#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/hackathon-olimpiadas}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
PM2_NAME="${PM2_NAME:-olimpiadas}"
LOG_FILE="${LOG_FILE:-$APP_DIR/auto-deploy.log}"
LOCK_FILE="${LOCK_FILE:-/tmp/hackathon-olimpiadas-auto-deploy.lock}"

mkdir -p "$(dirname "$LOG_FILE")"
exec >>"$LOG_FILE" 2>&1
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

echo "[$(date -Is)] Revisando actualizaciones..."
cd "$APP_DIR"

git fetch "$REMOTE" "$BRANCH"
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "$REMOTE/$BRANCH")"

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  echo "[$(date -Is)] Sin cambios."
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
DATA_BACKUP=""
RESPONSES_BACKUP=""

if [ -f data.json ]; then
  DATA_BACKUP="data.backup-auto-deploy-${STAMP}.json"
  cp data.json "$DATA_BACKUP"
fi

if [ -f responses-db.json ]; then
  RESPONSES_BACKUP="responses-db.backup-auto-deploy-${STAMP}.json"
  cp responses-db.json "$RESPONSES_BACKUP"
fi

git reset --hard "$REMOTE/$BRANCH"

if [ -n "$DATA_BACKUP" ] && [ -f "$DATA_BACKUP" ]; then
  cp "$DATA_BACKUP" data.json
fi

if [ -n "$RESPONSES_BACKUP" ] && [ -f "$RESPONSES_BACKUP" ]; then
  cp "$RESPONSES_BACKUP" responses-db.json
fi

npm install --omit=dev
node --check server.js
node --check public/app.js
pm2 restart "$PM2_NAME"

echo "[$(date -Is)] Despliegue completado: $LOCAL_HEAD -> $REMOTE_HEAD"
