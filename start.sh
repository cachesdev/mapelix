#!/bin/sh
# Starts Mapelix on Linux and macOS: ./start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Mapelix needs Node.js 24 or newer. Download it from https://nodejs.org, install it, then start again."
  exit 1
fi
exec node scripts/start.mjs "$@"
