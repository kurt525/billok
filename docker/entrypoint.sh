#!/bin/sh
set -eu
# No embedded PostgreSQL or automatic Prisma DDL is allowed.
for name in PGDATA POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DB_USER DB_NAME; do
  if printenv "$name" >/dev/null; then echo "ERROR: embedded PostgreSQL configuration forbidden" >&2; exit 1; fi
done
unset name
. /app/load-secrets.sh
case "$BILLOK_DB_PHASE" in
  prod|test) : ;;
  *) echo "ERROR: invalid database phase" >&2; exit 1 ;;
esac
export DATABASE_URL="postgresql://billok_$BILLOK_DB_PHASE:$DB_PASSWORD@billok_pg_$BILLOK_DB_PHASE:5432/billok_$BILLOK_DB_PHASE?schema=public"
unset DB_PASSWORD
UPLOAD_DIR=/app/uploads
mkdir -p "$UPLOAD_DIR/receipts"
chown -R nextjs:nodejs "$UPLOAD_DIR"
export HOME=/home/nextjs
echo "BillOK: existing external PostgreSQL selected (phase=$BILLOK_DB_PHASE)"
exec su-exec nextjs node server.js
