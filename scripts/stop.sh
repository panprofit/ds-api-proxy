#!/bin/sh
# Stop the ds-api-proxy started by scripts/start.sh.
#
# Usage:
#   scripts/stop.sh [--pid-file PATH] [--force]
#
# Sends SIGTERM by default (graceful drain), or SIGKILL with --force.
#
# The log timestamping filter started by start.sh is not tracked here: it reads
# the log FIFO and exits by itself once the server closes the write end (on
# graceful stop or crash), so there is nothing to signal. We only drop the
# leftover FIFO name so the next start creates a fresh one.
set -eu

pid_file="${DS_PID_FILE:-./.run/ds-api-proxy.pid}"
signal=TERM

while [ $# -gt 0 ]; do
    case "$1" in
        --pid-file) pid_file="$2"; shift 2 ;;
        --force) signal=KILL; shift ;;
        *) echo "[stop] unknown argument: $1" >&2; exit 2 ;;
    esac
done

fifo_file="${DS_LOG_FILE:-./.run/ds-api-proxy.log}.fifo"

if [ ! -f "$pid_file" ]; then
    echo "[stop] PID file not found: $pid_file" >&2
    exit 1
fi

pid=$(cat "$pid_file")
if ! kill -0 "$pid" 2>/dev/null; then
    echo "[stop] no live process with PID $pid; removing stale PID file"
    rm -f "$pid_file" "$fifo_file"
    exit 0
fi

kill -"$signal" "$pid"
echo "[stop] sent SIG$signal to PID $pid"
rm -f "$pid_file" "$fifo_file"
