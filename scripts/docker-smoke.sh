#!/usr/bin/env bash
# Smoke-test fresh BillOK Docker install, schema and restarts.
# Usage: bash scripts/docker-smoke.sh [--build] [--image NAME] [--keep]
set -euo pipefail

IMAGE="sharetab:smoke"
BUILD=false
KEEP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD=true ;;
    --image) IMAGE="$2"; shift ;;
    --keep) KEEP=true ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$(dirname "$0")/.."

CONTAINER="sharetab-smoke-$$-$RANDOM"
FAILED=true
ADMIN_EMAIL="smoke-admin@example.com"
ADMIN_PASSWORD=$(openssl rand -hex 16)

# ── Output ─────────────────────────────────────────────────────

GROUP_OPEN=false
section() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    [[ "$GROUP_OPEN" == true ]] && echo "::endgroup::"
    echo "::group::$1"
    GROUP_OPEN=true
  else
    printf '\n== %s\n' "$1"
  fi
}

fail() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::error::$*"
  else
    echo "FAIL: $*" >&2
  fi
  exit 1
}

cleanup() {
  if [[ "$GROUP_OPEN" == true ]]; then
    echo "::endgroup::"
    GROUP_OPEN=false
  fi
  if { [[ "$FAILED" == true ]] || [[ -n "${GITHUB_ACTIONS:-}" ]]; } &&
    docker inspect "$CONTAINER" >/dev/null 2>&1; then
    printf '\n== Container logs (last 200 lines)\n'
    docker logs --tail 200 "$CONTAINER" 2>&1 || true
  fi
  if [[ "$KEEP" == true ]]; then
    echo "Kept container $CONTAINER (admin: $ADMIN_EMAIL / $ADMIN_PASSWORD)"
    return
  fi
  docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true

}
trap cleanup EXIT

# ── Helpers ────────────────────────────────────────────────────

# Wait until /api/health answers inside the container, failing fast if the
# container exits. Usage: wait_healthy <label>
wait_healthy() {
  local label="$1"
  for _ in $(seq 1 90); do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]]; then
      fail "The container exited during startup ($label)."
    fi
    if docker exec "$CONTAINER" wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null; then
      echo
      return 0
    fi
    sleep 2
  done
  fail "Timed out waiting for /api/health ($label)."
}

# Run SQL against the bundled database as the postgres superuser; prints
# unaligned, tuples-only output and fails on the first error.
# Usage: db -c '<sql>' [-c '<sql>' ...]
db() {
  docker exec "$CONTAINER" su-exec postgres psql -h /run/postgresql -d sharetab \
    -v ON_ERROR_STOP=1 -tA "$@"
}

# Insert a minimal user row. Usage: add_user <id> <email>
add_user() {
  db -c "INSERT INTO \"User\" (id, email, \"updatedAt\") VALUES ('$1', '$2', now())"
}

# Prints "t" when the case-insensitive email index exists, "f" otherwise.
has_email_index() {
  db -c "SELECT to_regclass('\"User_email_lower_key\"') IS NOT NULL"
}

# ── Build ──────────────────────────────────────────────────────

if [[ "$BUILD" == true ]]; then
  section "Build $IMAGE"
  docker build -f docker/Dockerfile -t "$IMAGE" \
    --build-arg COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)" .
fi

# ── Checks ─────────────────────────────────────────────────────

section "Start on an empty database"
secret=$(openssl rand -base64 32)
docker run -d --name "$CONTAINER" --label sharetab-smoke \
  -e NEXTAUTH_SECRET="$secret" -e AUTH_SECRET="$secret" \
  -e AUTH_TRUST_HOST=true -e ADMIN_EMAIL="$ADMIN_EMAIL" \
wait_healthy "first start"
# The tables exist, not just a reachable database (psql fails if either is
# missing).
db -c 'SELECT count(*) FROM "User"' -c 'SELECT count(*) FROM "GuestSplit"'

section "Emails are unique ignoring case"
add_user ci-1 'CI@Example.com'
if add_user ci-2 'ci@example.com'; then
  fail "A case variant of an existing email was accepted."
fi
add_user ci-3 'other@example.com'
db -c "DELETE FROM \"User\" WHERE id LIKE 'ci-%'"

section "Restart, and prisma db push keeps the email index"
# The after-push SQL would recreate a dropped index before we look, so
# compare the index's identity instead of just its existence.
before=$(db -c "SELECT '\"User_email_lower_key\"'::regclass::oid")
docker restart "$CONTAINER" >/dev/null
wait_healthy "restart"
after=$(db -c "SELECT '\"User_email_lower_key\"'::regclass::oid")
if [[ "$before" != "$after" ]]; then
  fail "prisma db push dropped User_email_lower_key (oid $before -> $after)."
fi

section "Existing case-variant duplicates don't block startup"
# An install from before the index, with case-variant duplicates.
db -c 'DROP INDEX "User_email_lower_key"'
add_user dup-1 'Dup@Example.com'
add_user dup-2 'dup@example.com'
docker restart "$CONTAINER" >/dev/null
wait_healthy "restart with duplicates"
# Not `docker logs | grep -q`: grep -q exits at the first match, docker logs
# then dies of SIGPIPE writing the rest, and pipefail fails the pipeline, so
# the check failed at random.
startup_log=$(docker logs "$CONTAINER" 2>&1)
if ! grep -qF "more than one account uses each of these addresses in different letter cases: dup@example.com" <<<"$startup_log"; then
  fail "No warning about the duplicate emails in the startup log."
fi
if [[ "$(has_email_index)" != "f" ]]; then
  fail "The email index exists although duplicates do."
fi
# Once the duplicate is gone, the next start creates the index.
db -c "DELETE FROM \"User\" WHERE id = 'dup-2'"
docker restart "$CONTAINER" >/dev/null
wait_healthy "restart after removing the duplicate"
if [[ "$(has_email_index)" != "t" ]]; then
  fail "The email index wasn't created after the duplicate was removed."
fi

FAILED=false
section "Done"
echo "All smoke checks passed for $IMAGE."
