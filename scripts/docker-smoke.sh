#!/usr/bin/env bash
# Manual-only: test existing billok_pg_test. No new DB or volume.
set -Eeuo pipefail
IMAGE=billok:smoke; BUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD=true ;;
    --image) IMAGE="$2"; shift ;;
    -h|--help) echo "Usage: docker-smoke.sh [--build] [--image NAME]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
cd "$(dirname "$0")/.."
die(){ echo "BILLOK_SMOKE=FAIL: $*" >&2; exit 1; }
db=billok_pg_test; net=billok_pg_test_net; sec=/etc/billok/secrets
[[ $(docker inspect -f '{{.Config.Image}}' "$db") == postgres:16-alpine ]] || die "No existing test DB"
[[ $(docker inspect -f '{{.State.Health.Status}}' "$db") == healthy ]] || die "Test DB unhealthy"
[[ $(docker network inspect -f '{{.Internal}}' "$net") == true ]] || die "Test network not internal"
[[ -z $(docker port "$db") ]] || die "DB port published"
[[ $(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$db") == billok_pg_test_data ]] || die "Wrong test data volume"
for f in auth-secret nextauth-secret reg-ru-smtp-password postgres/test.password; do
 [[ -f "$sec/$f" && ! -L "$sec/$f" ]] || die "Required secret missing: $f"
done
[[ $(docker exec "$db" psql -X -qAt -U billok_test -d billok_test -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'") == 26 ]] || die "Expected schema missing"
if [[ "$BUILD" == true ]]; then docker build -f docker/Dockerfile -t "$IMAGE" --build-arg COMMIT_SHA="$(git rev-parse HEAD)" .; fi
container="billok-smoke-$$-$RANDOM"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$container" --network "$net" --env BILLOK_DB_PHASE=test  --env NEXTAUTH_URL=http://localhost:3000  --mount "type=bind,src=$sec,dst=/run/billok-secrets,readonly" "$IMAGE" >/dev/null
ready=false
for _ in $(seq 1 50); do
 [[ $(docker inspect -f '{{.State.Running}}' "$container") == true ]] || die "App exited"
 if docker exec "$container" wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ready=true; break; fi
 sleep 2
done
[[ "$ready" == true ]] || die "App health failed"
[[ -z $(docker port "$container") ]] || die "App published ports"
[[ $(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}BAD{{end}}{{end}}' "$container") != BAD ]] || die "Embedded database volume"
echo "BILLOK_SMOKE=PASS (app-only; preexisting test DB)"
