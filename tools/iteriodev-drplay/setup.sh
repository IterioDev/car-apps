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
