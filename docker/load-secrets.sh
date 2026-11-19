#!/bin/sh
# BillOK 8.11: sourced by entrypoint; no tracing or secret logging.
# Only root-owned files in a read-only bind-mount are accepted.
if [ -n "${DB_PASSWORD+x}" ] || [ -n "${NEXTAUTH_SECRET+x}" ] ||
   [ -n "${AUTH_SECRET+x}" ] || [ -n "${EMAIL_SERVER_PASSWORD+x}" ] ||
   [ -n "${DATABASE_URL+x}" ] || [ -n "${WEB_PUSH_VAPID_PRIVATE_KEY+x}" ]; then
    echo "ERROR: Production secrets must come only from mounted secret files" >&2
    exit 1
fi

BILLOK_SECRETS_DIR=/run/billok-secrets
if [ ! -d "$BILLOK_SECRETS_DIR" ] || [ -L "$BILLOK_SECRETS_DIR" ]; then
    echo "ERROR: BillOK secrets directory missing or symlinked" >&2
    exit 1
fi
secret_dir_uid=$(stat -c '%u' "$BILLOK_SECRETS_DIR") || exit 1
secret_dir_mode=$(stat -c '%a' "$BILLOK_SECRETS_DIR") || exit 1
if [ "$secret_dir_uid" != 0 ] || [ "$secret_dir_mode" != 700 ]; then
    echo "ERROR: BillOK secret directory requires root ownership and 0700" >&2
    exit 1
fi

read_billok_secret() {
    secret_path="$BILLOK_SECRETS_DIR/$1"
    if [ ! -f "$secret_path" ] || [ -L "$secret_path" ]; then
        echo "ERROR: BillOK secret file missing or symlinked: $1" >&2
        return 1
    fi
    file_uid=$(stat -c '%u' "$secret_path") || return 1
    file_mode=$(stat -c '%a' "$secret_path") || return 1
    if [ "$file_uid" != 0 ] || [ "$file_mode" != 600 ]; then
        echo "ERROR: BillOK secret requires root ownership and 0600: $1" >&2
        return 1
    fi
    if [ ! -s "$secret_path" ]; then
        echo "ERROR: BillOK secret is empty: $1" >&2
        return 1
    fi
    cat -- "$secret_path"
}

case "$BILLOK_DB_PHASE" in
  prod|test) : ;;
  *) echo "ERROR: Set BILLOK_DB_PHASE=prod or test" >&2; exit 1 ;;
esac
db_parent="$BILLOK_SECRETS_DIR/postgres"
if [ ! -d "$db_parent" ] || [ -L "$db_parent" ] ||
  [ "$(stat -c '%u' "$db_parent")" != 0 ] ||
  [ "$(stat -c '%a' "$db_parent")" != 700 ]; then
  echo "ERROR: PostgreSQL secret directory requires root ownership and 0700" >&2
  exit 1
fi
DB_PASSWORD=$(read_billok_secret "postgres/$BILLOK_DB_PHASE.password") || exit 1
AUTH_SECRET=$(read_billok_secret auth-secret) || exit 1
NEXTAUTH_SECRET=$(read_billok_secret nextauth-secret) || exit 1
EMAIL_SERVER_PASSWORD=$(read_billok_secret reg-ru-smtp-password) || exit 1

for hex_secret in "$DB_PASSWORD" "$AUTH_SECRET" "$NEXTAUTH_SECRET"; do
    case "$hex_secret" in
        *[!a-f0-9]* | '') echo "ERROR: Invalid BillOK 64-hex secret" >&2; exit 1 ;;
    esac
    if [ "${#hex_secret}" -lt 64 ]; then
        echo "ERROR: BillOK hex secret is too short" >&2
        exit 1
    fi
done
# SMTP secret is provider-defined; reject embedded newlines.
case "$EMAIL_SERVER_PASSWORD" in
    *'
'*) echo "ERROR: SMTP secret must be single-line" >&2; exit 1 ;;
esac

# Optional push secret until the PWA push feature is configured.
if [ -e "$BILLOK_SECRETS_DIR/vapid-private-key" ]; then
    WEB_PUSH_VAPID_PRIVATE_KEY=$(read_billok_secret vapid-private-key) || exit 1
    export WEB_PUSH_VAPID_PRIVATE_KEY
fi

export DB_PASSWORD AUTH_SECRET NEXTAUTH_SECRET EMAIL_SERVER_PASSWORD
unset hex_secret file_uid file_mode secret_path secret_dir_uid secret_dir_mode
