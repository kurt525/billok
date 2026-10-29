#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
source "$repo_dir/scripts/ops/sbp-catalog-trust.sh"
temp="$(mktemp -d)"
trap 'rm -rf -- "$temp"' EXIT
mkdir -p "$temp/work/scripts/lib" "$temp/work/src/lib"
for path in scripts/sync-sbp-banks.mjs scripts/lib/sbp-catalog-sync.mjs scripts/lib/sbp-catalog-sync.test.mjs src/lib/sbp-bank-catalog.json; do
  cp "$repo_dir/$path" "$temp/work/$path"
done
cd "$temp/work"
git init --quiet
git config user.name 'BillOK CI'
git config user.email 'ci@example.invalid'
git add .
git commit --quiet -m 'trusted snapshot'
verify_sbp_catalog_checkout HEAD
git branch --quiet trusted-main HEAD
echo 'trust guard accepts unchanged main executables'
for path in scripts/sync-sbp-banks.mjs scripts/lib/sbp-catalog-sync.mjs scripts/lib/sbp-catalog-sync.test.mjs; do
  printf '\n// unexpected modification\n' >> "$path"
  if verify_sbp_catalog_checkout HEAD 2>/dev/null; then
    echo "Trust guard accepted modified executable: $path" >&2
    exit 1
  fi
  git restore -- "$path"
done
echo 'trust guard rejects changed proposal executables'
mv scripts/sync-sbp-banks.mjs scripts/sync-sbp-banks.mjs.saved
ln -s /etc/passwd scripts/sync-sbp-banks.mjs
if verify_sbp_catalog_checkout HEAD 2>/dev/null; then
  echo 'Trust guard accepted executable symlink' >&2
  exit 1
fi
rm scripts/sync-sbp-banks.mjs
mv scripts/sync-sbp-banks.mjs.saved scripts/sync-sbp-banks.mjs
echo 'trust guard rejects executable symlinks'
mv src/lib/sbp-bank-catalog.json src/lib/sbp-bank-catalog.json.saved
ln -s /etc/passwd src/lib/sbp-bank-catalog.json
if verify_sbp_catalog_checkout HEAD 2>/dev/null; then
  echo 'Trust guard accepted catalog symlink' >&2
  exit 1
fi
rm src/lib/sbp-bank-catalog.json
mv src/lib/sbp-bank-catalog.json.saved src/lib/sbp-bank-catalog.json
echo 'trust guard rejects catalog symlinks'
verify_sbp_catalog_checkout HEAD

# Existing proposal branch may change JSON bank membership, but it must not
# also smuggle package, app or CI changes into a PR produced by automation.
printf '\n' >> src/lib/sbp-bank-catalog.json
git add -- src/lib/sbp-bank-catalog.json
git commit --quiet -m 'proposed catalog refresh'
verify_sbp_catalog_checkout trusted-main
echo 'trust guard permits JSON-only proposal changes'
for other in package.json .github/workflows/billok-ci.yml src/lib/hidden.ts; do
  mkdir -p "$(dirname -- "$other")"
  printf 'unreviewed content\n' > "$other"
  git add -- "$other"
  git commit --quiet -m 'unexpected proposal content'
  if verify_sbp_catalog_checkout trusted-main 2>/dev/null; then
    echo "Trust guard accepted unauthorized proposal change: $other" >&2
    exit 1
  fi
  git rm --quiet -- "$other"
  git commit --quiet -m 'restore catalog-only branch'
  verify_sbp_catalog_checkout trusted-main
done
echo 'trust guard rejects changes outside the JSON catalog'

# A JSON-only PR must not silently replace the stable ID or the local logo
# used by an already saved payer profile.
for attribute in id nspkId icon source; do
  python3 - "$attribute" <<'PYCODE'
import json
import sys
from pathlib import Path
path = Path('src/lib/sbp-bank-catalog.json')
catalog = json.loads(path.read_text())
field = sys.argv[1]
if field == 'source':
    catalog[field] = 'https://untrusted.invalid'
elif field == 'icon':
    catalog['banks'][0][field] = 'https://untrusted.invalid/icon.svg'
elif field == 'nspkId':
    catalog['banks'][0][field] = '999999999995'
else:
    catalog['banks'][0][field] = 'substituted-sberbank'
path.write_text(json.dumps(catalog, ensure_ascii=False))
PYCODE
  if verify_sbp_catalog_checkout trusted-main 2>/dev/null; then
    echo "Trust guard accepted modified catalog identity: $attribute" >&2
    exit 1
  fi
  git restore -- src/lib/sbp-bank-catalog.json
done
echo 'trust guard rejects altered saved IDs, logos and provenance'

# Keep normal upstream name changes, retirements and newly joined banks
# permissible, without rewriting any existing profile identifiers.
python3 - <<'PYCODE'
import json
from pathlib import Path
path = Path('src/lib/sbp-bank-catalog.json')
catalog = json.loads(path.read_text())
catalog['banks'][0]['name'] = 'Сбербанк — новое название'
catalog['banks'][1]['active'] = False
catalog['banks'].append({
    'id': '999999999991',
    'nspkId': '999999999991',
    'name': 'Новый участник СБП',
    'icon': None
})
path.write_text(json.dumps(catalog, ensure_ascii=False))
PYCODE
verify_sbp_catalog_checkout trusted-main
echo 'trust guard permits legal bank renames, retirement and additions'
