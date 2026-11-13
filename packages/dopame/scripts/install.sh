#!/bin/sh
set -eu
MARKTEXT_PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
acde install "$MARKTEXT_PACKAGE_ROOT/packages/marktext-workspace"
acde install "$MARKTEXT_PACKAGE_ROOT/packages/marktext-dopame"
