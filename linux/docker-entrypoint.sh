#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

case "$PUID" in
    ''|*[!0-9]*) echo "PUID must be a positive integer" >&2; exit 1 ;;
esac
case "$PGID" in
    ''|*[!0-9]*) echo "PGID must be a positive integer" >&2; exit 1 ;;
esac

if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
    echo "PUID and PGID must be greater than zero" >&2
    exit 1
fi

if [ "$(id -g node)" != "$PGID" ]; then
    groupmod --non-unique --gid "$PGID" node
fi
usermod --non-unique --uid "$PUID" --gid node node

# Generated JSON must remain writable after changing IDs. Covers are read by
# the Linux server, so only its mount point needs the requested ownership.
chown node:node /data /data/covers /data/json
chown -R node:node /data/json

echo "Starting FPKGi Node Server as node ($(id -u node):$(id -g node))"
exec su-exec node:node "$@"
