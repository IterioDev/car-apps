#!/bin/sh
# The service (uid 3910): tailscaled in userspace networking (the kernel has no TUN), its traffic routed by mgu-uplink.
# Incoming tailnet connections are forwarded to this unit's 127.0.0.1 (ssh: port 22). The control socket is opened
# to the head unit's apps (the Tailscale app logs in and out through it).
# While it runs, /run/iteriodev-tailscale/resolv.conf follows the uplink lease's DNS servers every 5 s, written in
# place (the unit binds that file over /etc/resolv.conf; Go re-reads it when it changes). Offline: kept as it was,
# tailscaled then falls back to its built-in DERP bootstrap DNS.
# Opt-in: a port in $D/socks5-port (written by root, kept over updates) adds a SOCKS5 server on 127.0.0.1:<port>
# for the head unit's apps to reach the tailnet. Loopback only, whatever the file says; no file, no proxy.
D=${D:-/var/opt/iteriodev-tailscale}   # overridable for test.sh
R=${R:-/run/iteriodev-tailscale}
LEASE=/run/mgu-uplink/lease.json

dns() {
    [ -r "$LEASE" ] || return 0
    servers=$(grep -o '"dns"[^]]*' "$LEASE" | grep -oE '"[0-9a-fA-F.:]+"' | tr -d '"')
    [ -n "$servers" ] || return 0
    new=$(for s in $servers; do echo "nameserver $s"; done)
    [ "$new" = "$(cat "$R/resolv.conf" 2>/dev/null)" ] || echo "$new" > "$R/resolv.conf"
}

dns
set --
if [ -r "$D/socks5-port" ]; then
    port=$(tr -d ' \t\r\n' < "$D/socks5-port")
    case "$port" in
        ''|*[!0-9]*) echo "socks5-port: '$port' is not a port, no SOCKS5 server" >&2 ;;
        *) if [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; then set -- --socks5-server="127.0.0.1:$port"
           else echo "socks5-port: $port is out of range, no SOCKS5 server" >&2; fi ;;
    esac
fi
"$D/current/tailscaled" --tun=userspace-networking --statedir="$D/state" --socket="$R/tailscaled.sock" \
    --port=41641 --no-logs-no-support "$@" &
pid=$!
trap 'kill "$pid" 2>/dev/null; wait "$pid"; exit 0' TERM INT
while kill -0 "$pid" 2>/dev/null; do
    dns
    # the Tailscale app (another uid) talks to the daemon here; built without per-user checks, tailscaled
    # makes the socket 0600 - open it to the head unit's apps
    [ -S "$R/tailscaled.sock" ] && chmod 666 "$R/tailscaled.sock"
    sleep 5 & wait $!
done
wait "$pid"
