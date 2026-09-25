#!/bin/sh
# Start ds-api-proxy in the background, detached from the controlling
# terminal so it survives closing the console. Records its PID so `stop.sh`
# can target exactly this instance (instead of matching every process whose
# command line contains "index.js").
#
# Usage:
#   scripts/start.sh [--pid-file PATH] [--log PATH]
#
# Defaults: PID file ./.run/ds-api-proxy.pid, log ./.run/ds-api-proxy.log
set -eu

pid_file="${DS_PID_FILE:-./.run/ds-api-proxy.pid}"
log_file="${DS_LOG_FILE:-./.run/ds-api-proxy.log}"

while [ $# -gt 0 ]; do
    case "$1" in
        --pid-file) pid_file="$2"; shift 2 ;;
        --log) log_file="$2"; shift 2 ;;
        *) echo "[start] unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "[start] already running with PID $(cat "$pid_file")" >&2
    exit 1
fi

mkdir -p "$(dirname "$pid_file")"

# Detach from the controlling terminal: `setsid` starts a new session so the
# shell's SIGHUP on exit/close never reaches the server. `nohup` is the
# fallback where setsid is unavailable (e.g. some minimal images).
if command -v setsid >/dev/null 2>&1; then
    setsid node --env-file-if-exists=.env index.js >"$log_file" 2>&1 </dev/null &
else
    nohup node --env-file-if-exists=.env index.js >"$log_file" 2>&1 </dev/null &
fi
pid=$!
echo "$pid" > "$pid_file"
echo "[start] ds-api-proxy started (PID $pid), logging to $log_file"
