#!/bin/sh
# ExecStartPre (root): for mgu-drplay (uid 3912, group 929 mgu_driverec) - the thumbnail and export (a camera's MP4
# before the copy child puts it on the stick) folders, the app's socket folder, and locked/ in the clip folders (Lock
# moves a clip's files there). The renderer's frame file /dev/shm/mgu-video-drplay: mgu-drplay itself, by its
# descriptor while still root (65534:929 0660).
set -e
U=3912
G=929
# (in root's own folders: nobody else can put a link at these names)
T=/var/opt/iteriodev-drplay/thumbs
X=/var/opt/iteriodev-drplay/export
R=/run/iteriodev-drplay
mkdir -p "$T" "$X" "$R"
chown "$U:$G" "$T" "$X" "$R"
chmod 755 "$T" "$X" "$R"
# the clip folders (02775 ent_mono:mgu_driverec: group 929 writes there; the HDD one only on cars with a disk): root
# only makes locked/ where nothing is - mkdir never follows a link at that name, the setgid folder gives it group 929
# and setgid. No chown / chmod by path in a folder others write to.
for C in /var/opt/public/ent/driverecorder /mnt/share/ent/driverecorder; do
    [ -d "$C" ] && [ ! -L "$C" ] || continue
    [ -e "$C/locked" ] || [ -L "$C/locked" ] || (umask 002; mkdir "$C/locked") || :   # (made meanwhile: fine)
done

# 1.1.1, provisioning: icam2proxy offers its video buffer only when the das files enable the Drive Recorder. On a car
# coded COMMUNICATION_PARKMASTER gen2 it reads the section oap_drive_recorder, not the app's own line
# (oap-driverecorder-next, written by the Store's deploy tool), so that line goes next to the app's in each das file that
# has the app's line and lacks it (car 2026-11-05: the same fix as by hand on mgu-m4). icam2proxy reads the files at its
# start: the head unit's next start takes it. Under the deploy tool's own lock (its format: "<pid> <boot id>", linked
# into place; held by a run: skipped, tried at the next start), in a rootfs window like the deploy tool's (a / found
# read-write stays so). Never fails the service: a failed ExecStartPre would stop it.
# 1.1.2, iDrive 7 (MainApp in /usr/lib/oap-mainapp, none in oap-mainapp21): a car without BMW's backend has its
# provisioning from the das files alone (data state DAS, G20 2026-11-06), and the deploy tool writes no das lines there,
# so both lines go in here - the app's (appStartType manually, as the deploy tool registers the app) and
# oap_drive_recorder - after x_call's line (where the deploy tool puts an app's on iDrive 8), else before </data>. Each
# file's first copy is kept in /var/opt/iteriodev-drplay/das-orig/ before it is changed.
P=/usr/share/tm/prov
L='<oap_drive_recorder enabled="true" allowed="true" appStartType="autostart" userLoginRequired="false"/>'
A='<oap-driverecorder-next enabled="true" allowed="true" appStartType="manually" userLoginRequired="false"/>'
ID7=
[ -d /usr/lib/oap-mainapp ] && [ ! -d /usr/lib/oap-mainapp21 ] && ID7=1

# das_edit <das file> <result file>: 0 when the result is to be written (the file lacked lines), else 1
das_edit() {
    f=$1; out=$2; add=; n=0
    if [ -n "$ID7" ]; then
        grep -q '<oap-driverecorder-next ' "$f" || { add="$A"; n=1; }
        grep -q '<oap_drive_recorder ' "$f" || { add="${add:+$add#}$L"; n=$((n + 1)); }
        [ "$n" -gt 0 ] || return 1
        if [ "$(grep -c '<x_call ' "$f")" = 1 ]; then
            awk -v l="$add" '{ print } /<x_call / { i = $0; sub(/<.*/, "", i); c = split(l, a, "#"); for (k = 1; k <= c; k++) print i a[k] }' "$f" > "$out"
        elif [ "$(grep -c '^[[:space:]]*</data>[[:space:]]*$' "$f")" = 1 ]; then
            awk -v l="$add" '/^[[:space:]]*<\/data>[[:space:]]*$/ { i = $0; sub(/<.*/, "", i); c = split(l, a, "#"); for (k = 1; k <= c; k++) print i "\t" a[k] } { print }' "$f" > "$out"
        else
            echo "das: $f has neither one x_call line nor one </data> line: left as it is"
            return 1
        fi
        [ "$(grep -c '<oap-driverecorder-next ' "$out")" = 1 ] || return 1
    else
        grep -q '<oap-driverecorder-next ' "$f" && ! grep -q '<oap_drive_recorder ' "$f" || return 1
        n=1
        # the app's line, then ours with its indentation
        awk -v l="$L" '{ print } /<oap-driverecorder-next / { i = $0; sub(/<.*/, "", i); print i l }' "$f" > "$out"
    fi
    # only a result n lines longer, with oap_drive_recorder once
    [ "$(grep -c '<oap_drive_recorder ' "$out")" = 1 ] && [ "$(($(grep -c '' "$f") + n))" = "$(grep -c '' "$out")" ]
}

das_fix() {
    need=
    for f in "$P"/das_00*.xml; do
        [ -f "$f" ] && [ ! -L "$f" ] || continue
        das_edit "$f" "/tmp/das.drplay-$$.$(basename "$f")" && need="$need $f" || rm -f "/tmp/das.drplay-$$.$(basename "$f")"
    done
    [ -n "$need" ] || return 0
    D=/var/opt/mgu-deploy
    mkdir -p "$D" && echo "$$ $(cat /proc/sys/kernel/random/boot_id)" > "$D/lock.$$" || return 0
    ln "$D/lock.$$" "$D/lock" 2>/dev/null || { rm -f "$D/lock.$$" /tmp/das.drplay-$$.*; echo "das: the deploy tool is busy, next start"; return 0; }
    rm -f "$D/lock.$$"
    O=/var/opt/iteriodev-drplay/das-orig
    mkdir -p "$O"
    ro=
    case ",$(awk '$2 == "/" { o = $4 } END { print o }' /proc/mounts)," in *,ro,*) ro=1 ;; esac
    if [ -z "$ro" ] || mount -o remount,rw /; then
        for f in $need; do
            r="/tmp/das.drplay-$$.$(basename "$f")"
            [ -e "$O/$(basename "$f")" ] || cp -p "$f" "$O/$(basename "$f")" || { rm -f "$r"; continue; }
            cat "$r" > "$f" && echo "das: drive recorder lines added to $f"
            rm -f "$r"
        done
        sync
        [ -z "$ro" ] || mount -o remount,ro / || echo "das: / stays read-write: mount -o remount,ro /"
    fi
    rm -f "$D/lock" /tmp/das.drplay-$$.*
}
[ -d "$P" ] && (set +e; das_fix) || :
