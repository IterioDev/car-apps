#!/bin/sh
# 1.2.6 (car-apps issue #23, iDrive 7, 2026-11-15): the Drive Recorder app started at every start of the car, so its
# "Start with the car" records from the start. On iDrive 7 nothing else starts it: the app is registered to start by
# hand (appStartType manually, as the deploy tool registers apps) and runs FOREGROUND (PR #9), so the camera unit was
# only put into its recording mode once the app was opened. Here the MainApp's own AppStart service (0xF9CA, the same
# on iDrive 7 and 8) is asked to start it, through hmictl: every 10 s until it runs, since for about the first minute
# after a start the service is not there yet or answers "no reply" / code 4 (UNKNOWN_ERROR; Turn View on a G20,
# 2026-11-14). Done on OK or code 2 (iDrive 7's APP_ALREADY_RUNNING); stops on code 1 (APP_NOT_INSTALLED) and after
# 5 min. Nothing when "Start with the car" is off in the app (its driverec.json: "autoCam":false). Run in the
# background from iteriodev-drplay.service (ExecStartPost); never fails it. One line per outcome in autostart.log.
# Env (tests): DR_HMICTL, DR_OAP (the OAP apps' folder), DR_AUTOLOG, DR_TRIES, DR_WAIT.
HM=${DR_HMICTL:-/var/opt/iteriodev-drplay/current/hmictl}
OAP=${DR_OAP:-/var/opt/public/oap}
LOG=${DR_AUTOLOG:-/var/opt/iteriodev-drplay/autostart.log}
TRIES=${DR_TRIES:-30}
WAIT=${DR_WAIT:-10}
APP=oap-driverecorder-next
say() {
    [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 65536 ] && : > "$LOG"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"
}

for f in "$OAP"/oap_*/data/driverec.json; do
    if [ -f "$f" ] && grep -q '"autoCam":false' "$f"; then
        say "Start with the car is off in the app: not started"
        exit 0
    fi
done
i=0 r=
while [ "$i" -lt "$TRIES" ]; do
    r=$(printf 'start %s\n' "$APP" | "$HM" serve 2>/dev/null | head -n 1)
    case "$r" in
        ok*) say "app started${i:+ (try $((i + 1)))}"; exit 0 ;;
        *"code 2"*) say "app already running"; exit 0 ;;
        *"code 1"*) say "app not installed: $r"; exit 0 ;;
    esac
    i=$((i + 1))
    [ "$i" = 1 ] && say "app start: ${r:-no answer} (asked again every $WAIT s)"
    sleep "$WAIT"
done
say "app start: gave up after $TRIES tries (${r:-no answer})"
exit 0
