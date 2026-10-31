#!/usr/bin/env bash
# Trusted, root-controlled release approval. Sourced by the SBP poller.
# Deliberately NO environment variable or GitHub-based activation bypass.
sbp_approval_dir=/etc/billok
sbp_approval_file=/etc/billok/sbp-catalog-release-approval
sbp_approval_owner_uid=0

require_sbp_catalog_release_approval() {
  # Refuse before making ANY network requests or modifying local state.
  if [[ ! -d "$sbp_approval_dir" || -L "$sbp_approval_dir" ||
        ! -f "$sbp_approval_file" || -L "$sbp_approval_file" ]]; then
    echo 'SBP automation denied: initial release acceptance and separate opt-in required' >&2
    return 1
  fi
  local path uid mode
  for path in "$sbp_approval_dir" "$sbp_approval_file"; do
    uid="$(stat -c '%u' -- "$path")" || return 1
    mode="$(stat -c '%a' -- "$path")" || return 1
    if [[ "$uid" != "$sbp_approval_owner_uid" || ! "$mode" =~ ^[0-7]{3,4}$ ]]; then
      echo 'SBP automation denied: untrusted approval ownership or permissions' >&2
      return 1
    fi
    if (( (8#$mode & 8#22) != 0 )); then
      echo 'SBP automation denied: approval file/directory writable by non-owner' >&2
      return 1
    fi
  done
  if ! cmp -s "$sbp_approval_file" <(printf 'firstReleasePublishedAndAccepted=true
catalogAutomationExplicitlyEnabled=true
'); then
    echo 'SBP automation denied: initial release acceptance and separate enablement missing' >&2
    return 1
  fi
}
