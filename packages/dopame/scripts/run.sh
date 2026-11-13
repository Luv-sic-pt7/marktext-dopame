#!/bin/sh
set -eu
MARKTEXT_PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$MARKTEXT_PACKAGE_ROOT"
exec acde dev "$MARKTEXT_PACKAGE_ROOT/packages/marktext-dopame" --desktop "$MARKTEXT_PACKAGE_ROOT/packages/marktext-workspace" "$@"
