#!/bin/sh
# Offline check of run.sh's tailscaled command line (not shipped to the head unit): without
# /var/opt/iteriodev-tailscale/socks5-port it is unchanged, with a port it gains --socks5-server=127.0.0.1:<port>.
#   sh tools/iteriodev-tailscale/test.sh
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
check "1055" "--socks5-server=127.0.0.1:1055"
check "1065
" "--socks5-server=127.0.0.1:1065"
check "" ""
check "0.0.0.0:1055" ""
check "1055 --foo" ""
check "70000" ""
check "0" ""
exit $fail
