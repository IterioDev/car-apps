#!/bin/sh
# ExecStartPre (root): the daemon's state folder, its runtime folder (socket) and the resolv.conf ExecStart binds
# over /etc/resolv.conf, all for uid 3910.
set -e
U=3910
D=/var/opt/iteriodev-tailscale
R=/run/iteriodev-tailscale
mkdir -p "$D/state" "$R"
chown "$U:$U" "$D/state" "$R"
chmod 700 "$D/state"
chmod 755 "$R"
[ -f "$R/resolv.conf" ] || : > "$R/resolv.conf"
chown "$U:$U" "$R/resolv.conf"
chmod 644 "$R/resolv.conf"
