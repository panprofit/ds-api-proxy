#!/bin/sh
# Point git at the committed .githooks/ directory so the pre-commit hook is
# version-controlled (copying files into .git/hooks is not). Run automatically
# by the npm "prepare" script after `npm install`, or manually with:
#   sh scripts/install-hooks.sh
#
# Safe to run outside a git checkout (e.g. from a published tarball): it exits
# 0 without changing anything.
set -eu

if ! root=$(git rev-parse --show-toplevel 2>/dev/null); then
    echo "[hooks] not a git checkout; skipping pre-commit install"
    exit 0
fi

git -C "$root" config core.hooksPath .githooks
echo "[hooks] core.hooksPath -> .githooks (pre-commit enabled)"
