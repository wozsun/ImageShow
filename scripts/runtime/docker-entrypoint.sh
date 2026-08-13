#!/bin/sh

set -e

DATA_DIR=/app/data

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/storage" "$DATA_DIR/log"
  if [ "$(stat -c '%u' "$DATA_DIR")" != "$(id -u node)" ]; then
    chown -R node:node "$DATA_DIR"
  else
    chown node:node "$DATA_DIR" "$DATA_DIR/storage" "$DATA_DIR/log"
    if [ -f "$DATA_DIR/config.json" ]; then
      chown node:node "$DATA_DIR/config.json"
    fi
  fi
  exec gosu node "$@"
fi

exec "$@"
