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
