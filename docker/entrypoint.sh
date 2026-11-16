#!/bin/sh
set -e

# 8.11: fail closed before starting PostgreSQL or application processes.
# Credentials are loaded from root-owned files, never Docker inspect.
. /app/load-secrets.sh

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
DB_USER="${DB_USER:-sharetab}"
# Loaded from /run/billok-secrets/database-password.
: "${DB_PASSWORD:?BillOK secret database-password missing}"
DB_NAME="${DB_NAME:-sharetab}"

# Keep Auth.js and SMTP secrets out of PostgreSQL child environments.
postgres_command() {
  env -u DB_PASSWORD -u AUTH_SECRET -u NEXTAUTH_SECRET \
    -u EMAIL_SERVER_PASSWORD -u WEB_PUSH_VAPID_PRIVATE_KEY \
    su-exec postgres "$@"
}

# ── Start PostgreSQL ────────────────────────────────────────

# Ensure data directory exists and is owned by postgres (needed for host bind-mounts)
mkdir -p "$PGDATA"
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

# Ensure uploads directory exists and is writable by the app user (needed for host bind-mounts)
UPLOAD_DIR="${UPLOAD_DIR:-/app/uploads}"
mkdir -p "$UPLOAD_DIR/receipts"
chown -R nextjs:nodejs "$UPLOAD_DIR"

# Initialize database if needed
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL database..."
  postgres_command initdb -D "$PGDATA" --auth-local=trust --auth-host=md5

  # Allow local connections
  echo "host all all 127.0.0.1/32 md5" >> "$PGDATA/pg_hba.conf"
  echo "host all all ::1/128 md5" >> "$PGDATA/pg_hba.conf"

  # Listen only on localhost (internal use only)
  sed -i "s/#listen_addresses = 'localhost'/listen_addresses = 'localhost'/" "$PGDATA/postgresql.conf"

  # Start temporarily to create user and database
  postgres_command pg_ctl -D "$PGDATA" -w start -o "-k /run/postgresql"

  # 8.11: validated hex secret reaches psql through stdin, not process argv,
  # GitHub logs, or docker inspect. Identifier arguments contain no secrets.
  # DB_PASSWORD is strictly validated as a >=64-character lowercase hex value.
  postgres_command psql -h /run/postgresql -v ON_ERROR_STOP=1 \
    -v db_user="$DB_USER" -v db_name="$DB_NAME" <<EOSQL
CREATE USER :"db_user" WITH PASSWORD '$DB_PASSWORD';
CREATE DATABASE :"db_name" OWNER :"db_user";
GRANT ALL PRIVILEGES ON DATABASE :"db_name" TO :"db_user";
EOSQL

  postgres_command pg_ctl -D "$PGDATA" -w stop
  echo "PostgreSQL initialized."
fi

echo "Starting PostgreSQL..."
# Remove stale PID file left behind by unclean container restarts
rm -f "$PGDATA/postmaster.pid"
postgres_command pg_ctl -D "$PGDATA" -w start -o "-k /run/postgresql"

# Wait for PostgreSQL to be ready
until postgres_command pg_isready -h localhost -q; do
  echo "Waiting for PostgreSQL..."
  sleep 1
done
echo "PostgreSQL is ready."

# ── Set DATABASE_URL if not already pointing externally ─────

export DATABASE_URL="${DATABASE_URL:-postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME}"

# ── Run Migrations ──────────────────────────────────────────

# Run manual SQL migrations (for changes prisma db push can't handle, e.g. enum conversions).
# They run before `prisma db push` on every start, including a fresh install's
# first, so each file must be idempotent and a no-op on an empty database.
if [ -d "/app/prisma/migrations" ]; then
  for sqlfile in /app/prisma/migrations/*.sql; do
    [ -f "$sqlfile" ] || continue
    echo "Running migration: $(basename "$sqlfile")..."
    PGPASSWORD="$DB_PASSWORD" postgres_command psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -f "$sqlfile" 2>&1
  done
fi

echo "Running database migrations..."
NODE_PATH=/prisma-cli/node_modules node /prisma-cli/node_modules/prisma/build/index.js db push

# Run SQL that needs the schema to exist and that prisma db push can't express
# (e.g. an index on lower(email)). Each file must be idempotent; any failure
# stops startup, so files log a warning instead for anything optional.
if [ -d "/app/prisma/after-push" ]; then
  for sqlfile in /app/prisma/after-push/*.sql; do
    [ -f "$sqlfile" ] || continue
    echo "Running post-schema SQL: $(basename "$sqlfile")..."
    PGPASSWORD="$DB_PASSWORD" postgres_command psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" \
      -v ON_ERROR_STOP=1 -f "$sqlfile" 2>&1
  done
fi

# ── Print config summary ────────────────────────────────────

echo ""
echo "============================================"
echo "  BillOK Configuration"
echo "============================================"
echo "  Version:        $(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo 'unknown')"
echo "  Commit:         $(cat .commit-sha 2>/dev/null || echo 'unknown')"
echo "  Database:       local PostgreSQL; credentials not logged"
echo "  DB User:        ${DB_USER:-sharetab}"
echo "  DB Name:        ${DB_NAME:-sharetab}"
echo "  Auth URL:       ${NEXTAUTH_URL:-not set}"
echo "  Auth Trust:     ${AUTH_TRUST_HOST:-false}"
echo "  Owner Setup:    ${ADMIN_EMAIL:-not set}"
echo "  Upload Dir:     ${UPLOAD_DIR:-/app/uploads}"
echo "  Auth RL Max:    ${AUTH_RATE_LIMIT_MAX:-5}"
echo "  Register RL:    ${REGISTER_RATE_LIMIT_MAX:-10}"
if [ -n "$EMAIL_SERVER_HOST" ]; then
  echo "  Registration Mail: configured"
  echo "  Email Host:     ${EMAIL_SERVER_HOST}"
  echo "  Email Port:     ${EMAIL_SERVER_PORT:-465}"
  echo "  Email From:     ${EMAIL_FROM:-not set}"
else
  echo "  Registration Mail: not configured"
fi
echo "  Log Level:      ${LOG_LEVEL:-info}"
echo "============================================"
echo ""

# ── Start App ───────────────────────────────────────────────

echo "Starting BillOK..."
export HOME=/home/nextjs

# Run Node in the background so this script (PID 1) can forward signals.
# 'docker stop' must reach Postgres too — otherwise it gets SIGKILLed when
# the grace period expires and is forced into crash recovery on every
# restart (the stale postmaster.pid this script used to clean up).
stop_postgres() {
  echo "Stopping PostgreSQL..."
  postgres_command pg_ctl -D "$PGDATA" -m fast -w stop || true
}

shutdown() {
  echo "Received stop signal, shutting down..."
  if [ -n "$APP_PID" ]; then
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  stop_postgres
  exit 0
}
trap shutdown TERM INT

su-exec nextjs node server.js &
APP_PID=$!
APP_EXIT=0
wait "$APP_PID" || APP_EXIT=$?
stop_postgres
exit "$APP_EXIT"
