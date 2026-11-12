#!/bin/sh
# 1.1.3, run by iteriodev-drplay.service (root, beside mgu-drplay, in its cgroup): the car's udisks mounts a USB stick
# for the media player read-only (/media/<label>, ro), and mgu-drplay copies only to a writable one, so Copy to USB
# found "No USB stick" (G20, iDrive 7, 2026-11-06; remounted rw by hand the player saw it at once). While the Drive
# Recorder app wants the stick - its flag file, written every few seconds while Copy to USB is open or a copy runs,
# owned by the app's uid - each USB stick the car mounted read-only under /media is remounted read-write; 20 s after
# the flag stops, the ones remounted here go back to read-only. Only then: a stick pulled while read-write is left
# marked dirty (the car does not unmount it first), and the media player expects read-only.
FLAG=/dev/shm/oap-driverecorder-usb
STATE=/run/iteriodev-drplay-usb-rw     # the mount points remounted here, one per line (root's, not the player's folder)
HOLD=20                                 # seconds a flag counts after it was last written

# the Drive Recorder app's uid (its home under /var/opt/public/oap), looked up again when the flag's owner differs
APP_UID=
app_uid() {
    for d in /var/opt/public/oap/oap_*; do
        grep -q '"name": *"oap-driverecorder-next"' "$d/source/package.json" 2>/dev/null && { APP_UID=${d##*_}; return 0; }
    done
    APP_UID=
}

wanted() {
    [ -f "$FLAG" ] && [ ! -L "$FLAG" ] || return 1
    owner=$(stat -c %u "$FLAG" 2>/dev/null) || return 1
    [ "$owner" = "$APP_UID" ] || { app_uid; [ "$owner" = "$APP_UID" ] || return 1; }
    [ $(( $(date +%s) - $(stat -c %Y "$FLAG" 2>/dev/null || echo 0) )) -lt "$HOLD" ]
}

# USB sticks (/dev/sd*) the car mounted read-only directly under /media, as /proc/mounts names them (\040 = space)
read_only_sticks() {
    awk '$1 ~ "^/dev/sd" && $2 ~ "^/media/[^/]+$" && $3 ~ "^(vfat|msdos|texfat|exfat|tntfs|ntfs|fuseblk)$" && ("," $4 ",") ~ /,ro,/ { print $2 }' /proc/mounts
}

[ -L "$STATE" ] && rm -f "$STATE"
: > "$STATE" 2>/dev/null
app_uid
while :; do
    if wanted; then
        read_only_sticks | while read -r m; do
            m=$(printf '%b' "$m")
            [ -d "$m" ] && [ ! -L "$m" ] || continue
            if mount -o remount,rw "$m"; then
                grep -qxF "$m" "$STATE" 2>/dev/null || echo "$m" >> "$STATE"
                echo "usb: $m writable for Copy to USB"
            else
                echo "usb: $m could not be made writable"
            fi
        done
    elif [ -s "$STATE" ]; then
        sync
        while read -r m; do
            # still mounted at that point (the stick not pulled meanwhile): back to read-only, as the car had it
            awk -v m="$m" '{ p = $2; gsub(/\\040/, " ", p) } p == m { f = 1 } END { exit !f }' /proc/mounts &&
                mount -o remount,ro "$m" && echo "usb: $m read-only again"
        done < "$STATE"
        : > "$STATE"
    fi
    sleep 3
done
