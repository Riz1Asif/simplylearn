#!/bin/sh
set -eu
data_dir="${DATA_DIR:-/app/data}"
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$data_dir/uploads" "$data_dir/.conversion-jobs"
  chown node:node "$data_dir" "$data_dir/uploads" "$data_dir/.conversion-jobs"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
