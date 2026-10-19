#!/bin/sh
# Start ds-api-proxy in the background, detached from the controlling
# terminal so it survives closing the console. Records its PID so `stop.sh`
# can target exactly this instance (instead of matching every process whose
# command line contains "index.js").
#
# Every log line is prefixed with an ISO-8601 UTC timestamp (e.g.
# `2026-10-07T13:13:11Z `). The Node process is left untouched: it writes
# plain lines to a FIFO, and a detached filter drains that FIFO into the log
# file, stamping each line. The filter exits by itself when the server closes
# the FIFO (on stop or crash), so `stop.sh` needs no extra bookkeeping.
#
# Usage:
#   scripts/start.sh [--pid-file PATH] [--log PATH] [--keep-port]
#
# Defaults: PID file ./.run/.pid, log ./.run/.log
# A listener already holding PORT is stopped before start; pass --keep-port to
# keep it (the server will then fail to bind).
set -eu

pid_file="${DS_PID_FILE:-./.run/.pid}"
log_file="${DS_LOG_FILE:-./.run/.log}"
free_port=1

while [ $# -gt 0 ]; do
    case "$1" in
        --pid-file) pid_file="$2"; shift 2 ;;
        --log) log_file="$2"; shift 2 ;;
        --keep-port) free_port=0; shift ;;
        *) echo "[start] unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "[start] already running with PID $(cat "$pid_file")" >&2
    exit 1
fi

mkdir -p "$(dirname "$pid_file")" "$(dirname "$log_file")"

# Reclaim PORT from whatever still holds it (usually a crash orphaned by a
# reboot, so the PID file is stale or gone). This frees any listener on the
# port, not just ours: the operator asked for a fresh instance on that port.
# Config precedence matches lib/config.js: real env wins over .env, and a
# commented line is not a value.
if [ "$free_port" = 1 ]; then
    port="${PORT:-}"
    if [ -z "$port" ] && [ -f .env ]; then
        port=$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' .env | tail -n 1 | tr -d '"'"'"' ' )
    fi
    port="${port:-9876}"
    # Portable fallback only: lsof/ss/fuser are absent from many minimal
    # images. Match the listening socket inode in /proc/net/tcp{,6} (port is
    # the hex field after the address colon) and then find the PID owning it.
    hexport=$(printf '%04X' "$port")
    inodes=$(awk -v p=":$hexport" 'NR>1 && $4=="0A" && substr($2,length($2)-4)==p {print $10}' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u)
    holders=$(for ino in $inodes; do
        for fd in /proc/[0-9]*/fd/*; do
            [ "$(readlink "$fd" 2>/dev/null)" = "socket:[$ino]" ] || continue
            echo "$fd" | cut -d/ -f3
        done
    done | sort -u)
    for holder in $holders; do
        [ "$holder" = "$$" ] && continue
        echo "[start] port $port held by PID $holder; stopping it" >&2
        kill "$holder" 2>/dev/null || true
        n=0
        while kill -0 "$holder" 2>/dev/null && [ $n -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
        if kill -0 "$holder" 2>/dev/null; then
            echo "[start] PID $holder ignored SIGTERM; sending SIGKILL" >&2
            kill -9 "$holder" 2>/dev/null || true
        fi
    done
fi

# Set up the timestamping path. The server writes to a FIFO; a detached filter
# reads it and appends stamped lines to the real log file. If the FIFO cannot
# be created we fall back to writing the raw log directly.
fifo_file="${log_file}.fifo"
log_target="$log_file"
rm -f "$fifo_file"
if mkfifo "$fifo_file" 2>/dev/null; then
    # `awk`'s strftime is a single process and exact; the POSIX-shell fallback
    # forks `date` per line but works on awk implementations without strftime.
    # The filter must be detached too, otherwise the closing terminal's SIGHUP
    # would kill it and break the server's stdout pipe.
    #
    # Both branches stamp UTC, matching the header contract and the zone-free
    # epoch ms in .account-state.json. `awk`'s strftime honours the ambient TZ,
    # so a host with a local zone printed local time with a hard-coded `Z`
    # suffix -- which then read as already-expired next to the `toISOString()`
    # deadlines in the body (e.g. a 14:06Z header over an 11:09Z deadline). Pin
    # TZ=UTC0 for BOTH the probe and the live filter; the fallback pins it too
    # so the two paths cannot drift.
    #
    # The stamp is wrapped in [] so it reads as a field (`[2026-10-08T11:12:21Z]
    # ...`) and cannot be mistaken for part of the message.
    if TZ=UTC0 awk 'BEGIN { exit !(strftime("%Y-%m-%dT%H:%M:%SZ", systime()) ~ /^[0-9][0-9][0-9][0-9]-/) }' </dev/null 2>/dev/null; then
        setsid env TZ=UTC0 awk '{ print "[" strftime("%Y-%m-%dT%H:%M:%SZ", systime()) "]", $0; fflush() }' <"$fifo_file" >>"$log_file" &
    else
        setsid sh -c 'while IFS= read -r line; do printf "%s %s\n" "[$(TZ=UTC0 date -u +%Y-%m-%dT%H:%M:%SZ)]" "$line"; done' <"$fifo_file" >>"$log_file" &
    fi
    log_target="$fifo_file"
else
    echo "[start] WARNING: could not create $fifo_file; logging without timestamps" >&2
fi

# Detach from the controlling terminal: `setsid` starts a new session so the
# shell's SIGHUP on exit/close never reaches the server. `nohup` is the
# fallback where setsid is unavailable (e.g. some minimal images).
# The FIFO is a pipe, not a regular file, so it must not be opened in append
# mode; the real log file is appended to (restarts must not truncate history).
if command -v setsid >/dev/null 2>&1; then
    if [ "$log_target" = "$log_file" ]; then
        setsid node --env-file-if-exists=.env index.js >>"$log_target" 2>&1 </dev/null &
    else
        setsid node --env-file-if-exists=.env index.js >"$log_target" 2>&1 </dev/null &
    fi
else
    if [ "$log_target" = "$log_file" ]; then
        nohup node --env-file-if-exists=.env index.js >>"$log_target" 2>&1 </dev/null &
    else
        nohup node --env-file-if-exists=.env index.js >"$log_target" 2>&1 </dev/null &
    fi
fi
pid=$!
echo "$pid" > "$pid_file"
echo "[start] ds-api-proxy started (PID $pid), logging to $log_file"
