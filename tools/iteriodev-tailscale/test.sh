#!/bin/sh
# Offline check of run.sh's tailscaled command line (not shipped to the head unit): without
# /var/opt/iteriodev-tailscale/socks5-port it is unchanged, with a free port it gains --socks5-server=127.0.0.2:<port>.
#   sh tools/iteriodev-tailscale/test.sh        (about 45 s: run.sh's 5 s loop runs once per case)
set -e
S=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/current" "$T/run"
printf '#!/bin/sh\necho "$*" > "%s/args"\n' "$T" > "$T/current/tailscaled"
chmod 755 "$T/current/tailscaled"
BASE="--tun=userspace-networking --statedir=$T/state --socket=$T/run/tailscaled.sock --port=41641 --no-logs-no-support"
fail=0
check() {   # $1: socks5-port contents ("-" = no file), $2: the extra arguments expected
    rm -f "$T/socks5-port" "$T/args"
    [ "$1" = - ] || printf '%s' "$1" > "$T/socks5-port"
    D=$T R=$T/run sh "$S/run.sh" 2>/dev/null
    want=$(echo "$BASE $2" | sed 's/ $//')
    if [ "$(cat "$T/args")" = "$want" ]; then echo "ok   socks5-port=$1"
    else echo "FAIL socks5-port=$1: got '$(cat "$T/args")', want '$want'"; fail=1; fi
}
check - ""
check "1055" "--socks5-server=127.0.0.2:1055"
check "1065
" "--socks5-server=127.0.0.2:1065"
check "" ""
check "0.0.0.0:1055" ""
check "1055 --foo" ""
check "70000" ""
check "0" ""
check "01055" ""
# a file the service cannot read: no flag (as root every file is readable, so only checked as another user)
if [ "$(id -u)" != 0 ]; then
    printf 1055 > "$T/socks5-port"; chmod 000 "$T/socks5-port"
    D=$T R=$T/run sh "$S/run.sh" 2>/dev/null
    if [ "$(cat "$T/args")" = "$BASE" ]; then echo "ok   socks5-port unreadable"
    else echo "FAIL socks5-port unreadable: got '$(cat "$T/args")'"; fail=1; fi
    chmod 600 "$T/socks5-port"
fi
# a port another program listens on: no flag, so tailscaled still starts (needs nc and Linux's /proc/net/tcp)
P=47123
if command -v nc >/dev/null && [ -r /proc/net/tcp ]; then
    { nc -l -p $P 2>/dev/null || nc -l $P; } >/dev/null 2>&1 &
    nc_pid=$!
    sleep 1
    if grep -qi ":$(printf %04X $P) [0-9A-F]*:[0-9A-F]* 0A " /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
        check "$P" ""
    else echo "skip socks5-port busy (nc did not listen)"; fi
    kill $nc_pid 2>/dev/null; pkill -f "nc -l.*$P" 2>/dev/null || :
else echo "skip socks5-port busy (no nc or no /proc/net/tcp)"; fi
exit $fail
