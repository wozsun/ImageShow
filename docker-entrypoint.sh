#!/bin/sh
# Fix ownership of the (usually bind-mounted) data dir so the unprivileged 'node'
# user can write to it, then drop privileges and run the app. Runs as root; if the
# container was started as a non-root user, it just execs the command unchanged.
set -e

DATA_DIR=/app/data

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/storage" "$DATA_DIR/log"
  # A fresh bind mount / named volume comes up owned by root. Deep-chown only when
  # the data root isn't already node-owned, so large local-storage trees don't pay
  # a recursive chown on every boot.
  if [ "$(stat -c '%u' "$DATA_DIR")" != "$(id -u node)" ]; then
    chown -R node:node "$DATA_DIR"
  else
    chown node:node "$DATA_DIR" "$DATA_DIR/storage" "$DATA_DIR/log"
  fi
  exec gosu node "$@"
fi

exec "$@"
