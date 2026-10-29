#!/usr/bin/env bash
# Load from the locally installed, reviewed systemd script; NEVER source this
# from an open proposal branch.
verify_sbp_catalog_checkout() {
  local trusted_ref="$1"
  local path
  # The proposal branch is only allowed to differ from reviewed main in the
  # JSON catalog. Reject any other tracked change (including workflows,
  # config, scripts, deletions and executable mode bits) before running code.
  # A fresh clone supplies no local untracked files. Do not auto-rebase.
  if ! git rev-parse --verify --quiet "$trusted_ref^{commit}" >/dev/null ||
    ! git diff --quiet --no-ext-diff --no-renames "$trusted_ref" HEAD -- . ':(exclude)src/lib/sbp-bank-catalog.json'; then
    echo 'Unsafe SBP proposal: changes outside the JSON catalog require review' >&2
    return 1
  fi
  for path in \
    scripts/sync-sbp-banks.mjs \
    scripts/lib/sbp-catalog-sync.mjs \
    scripts/lib/sbp-catalog-sync.test.mjs; do
    if [[ ! -f "$path" || -L "$path" ]] ||
      ! git cat-file -e "$trusted_ref:$path" 2>/dev/null ||
      ! cmp -s "$path" <(git show "$trusted_ref:$path"); then
      echo "Unsafe SBP proposal: executable differs from trusted main: $path" >&2
      return 1
    fi
  done
  if [[ ! -f src/lib/sbp-bank-catalog.json || -L src/lib/sbp-bank-catalog.json ]]; then
    echo 'Unsafe SBP proposal: catalog must be a regular JSON file' >&2
    return 1
  fi
}
