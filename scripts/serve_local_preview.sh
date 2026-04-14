#!/usr/bin/env bash

set -euo pipefail

HOST="127.0.0.1"
START_PORT=4000
END_PORT=4010
PORT=""

for candidate in $(seq "$START_PORT" "$END_PORT"); do
  if ! lsof -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
    PORT="$candidate"
    break
  fi
done

if [ -z "$PORT" ]; then
  echo "No free port found between ${START_PORT} and ${END_PORT}." >&2
  exit 1
fi

echo "Starting local preview on http://${HOST}:${PORT}/"

exec "$(dirname "$0")/jekyll.sh" serve --host "$HOST" --port "$PORT"
