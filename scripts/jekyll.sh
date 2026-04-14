#!/usr/bin/env bash

set -euo pipefail

pick_utf8_locale() {
  local available
  available="$(locale -a 2>/dev/null || true)"

  for locale_name in "ja_JP.UTF-8" "en_US.UTF-8" "C.UTF-8"; do
    if printf '%s\n' "$available" | grep -Fxq "$locale_name"; then
      printf '%s' "$locale_name"
      return 0
    fi
  done

  printf '%s' "en_US.UTF-8"
}

UTF8_LOCALE="${JEKYLL_UTF8_LOCALE:-$(pick_utf8_locale)}"

export LANG="$UTF8_LOCALE"
export LC_ALL="$UTF8_LOCALE"

exec bundle exec jekyll "$@"
