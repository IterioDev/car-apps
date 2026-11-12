'use strict';
/*
 * overlays.js - iteriodev-overlays: the QuickSelect strip (iDrive 8.5 style) on iDrive 8, root service, Node 8.
 * Drawn by mgu-render as an overlay over the climate bar (its overlay_apps must list iteriodev-overlays: always shown,
 * touch first, may claim the climate bar). One layer, the bar's width:
 *   four shortcuts, two left and two right of CLIMATE MENU
 *     tap         opens the slot's screen: HMIControl2.requestGraphicalContext through `hmictl serve`
 *     long-press  (1 s) saves the screen on the CID now into that slot: a BMW screen, or an app's screen
 *   the seat buttons in the HMI's own spots, [vent][- temp +][heat] on each side (seats.js; only what the car has),
 *     the HMI's own icons at their size: off white, on red / blue with the HMI's accent line under the button
 *     tap         the level steps 1 -> 2 -> 3 -> off (or 3 -> 2 -> 1 -> off); what is shown is always the car's live
 *                 status (the climate menu or the seat buttons may change it), the asked level only until it answers
 *   the steering wheel heating at the bar's far left, the same kind of button (one tap: on / off)
 *   a right-hand drive car (the setting side 'right', set in the app; default 'left', user 2026-11-08): the driver's
 *     seat buttons in the right-hand spots, the passenger's in the left-hand ones, the wheel at the far right
 *   M1 / M2 on the steering wheel (M cars): an M setup switched on also switches the M Mode (cluster, HUD, as the M
 *     Mode panel's button: `hmictl mmode sport`), switched off back; which mode for each: the settings
 * The Overlays app (iteriodev_overlays) is its control panel: a JSON-lines socket (CTL) with the settings, the slots,
 * what the car has and the screens a slot can open; every change is pushed to it.
 * A slot is a graphical context. An OAP app's screens sit at its installed rhmiData/application.json appletId
 * (+ 3000 with the oap-sdk's offset; MainApp / mgu-deploy give the id at install and keep it on updates), so an app
 * slot keeps the app's id and the offset and reads the appletId again on every tap. The app's picture is its tile
 * icon (application.json entryPoints[0].icon, a PNG in rhmiData) or its package icon.png; BMW's own gid:// tile
 * icons can't be drawn here, so those apps, and BMW screens the strip has no icon for, get a plain one.
 * Data: /var/opt/iteriodev-overlays/slots.json { slots: [4 x {state, applet} | {app, state, offset}], settings, mcar,
 * learned, vents (legacy cars: ventilation seen on, per seat), layout? }. VM ids (2026-11-01): Media 2 23, Nav 1 32, Phone 24 34, All apps 20 4, Home 20000 4, Climate 3 517.
 *   node overlays.js          the service (OVERLAYS_SEAT_DEMO=1: seats without a car, for the VM)
 *   node overlays.js --test   the self-check (no car needed)
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const png = require('./png');
const seats = require('./seats');
const shift = require('./shiftlights');
const hmiIcons = require('./hmiicons');

const DATA = process.env.OVERLAYS_DATA || '/var/opt/iteriodev-overlays/slots.json';
const CTL = process.env.OVERLAYS_CTL || '/run/iteriodev-overlays/ctl.sock';
const OAP = process.env.OVERLAYS_OAP || '/var/opt/public/oap';
const CLIENT = process.env.MGU_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js';
const CLUSTER = process.env.CLUSTER_RENDER_CLIENT || '/var/opt/cluster-render/current/cluster_render_client.js';
const HMICTL = path.join(__dirname, 'hmictl');
const SELF = 'iteriodev_overlays';               // the control-panel app: not offered as a slot
const HOLD_MS = 1000, PENDING_MS = 3000, REREAD_MS = 60000;
const OFFSETS = [0, 3000];                   // an app's RHMI application against its appletId (oap-sdk)
// screen px. The M4's bar (screenshots 2026-11-02 / -03): temperatures 365-843 | 1987-2465, CLIMATE MENU 1386-1495.
// The HMI's seat buttons are 120 px wide, their accent line at y 99-104 of the bar, and the icon sits ICON_DX right of
// the button's centre on every button (not mirrored): heat 864-983 (21 px right of a temperature), ventilation
// 222-341 / 1844-1963 (24 px left of one), measured with the HMI's own icons on; passenger heat by the driver's
const LAYOUT = { x: 0, y: 840, w: 2880, h: 120, slots: [1055, 1200, 1540, 1685], slotW: 140, buttonW: 120,
    buttons: { 'driver.wheel': 20, 'driver.cool': 222, 'driver.heat': 864, 'passenger.cool': 1844, 'passenger.heat': 2486 },
    iconY: 55, lineY: 99, lineH: 6 };
const ICON_DX = 24;
// the BMW screens the app offers (a slot can hold any other one, saved by a hold): strip picture, the app's icon.
// The ids are the VM's (mgu-m4's HMI). Another HMI build can number a screen differently (a client's M2, 2026-11-04:
// Navigation did nothing): a tap that leaves the screen as it was counts as failed, and a hold soon after it learns the
// screen's own ids under that name (learned{}, kept in slots.json).
const SCREENS = [
    { title: 'Media', state: 2, applet: 23, png: 'media', icon: 'Playlist' },
    { title: 'Navigation', state: 1, applet: 32, png: 'nav', icon: 'Navigation' },
    { title: 'Phone', state: 24, applet: 34, png: 'phone', icon: 'Smartphone' },
    { title: 'All apps', state: 20, applet: 4, png: 'apps', icon: 'Menu' },
    { title: 'Home', state: 20000, applet: 4, png: 'home', icon: 'MainMenu' },
    { title: 'Climate', state: 3, applet: 517, png: 'climate', icon: 'Fan' },
];
let learned = {};                                    // title -> { state, applet } this car's HMI uses instead
const screenList = () => SCREENS.map((s) => (learned[s.title] ? Object.assign({}, s, learned[s.title]) : s));
const DEFAULT_TITLES = ['Media', 'Navigation', 'Phone', 'All apps'];
const defaults = () => DEFAULT_TITLES.map((t) => { const s = screenList().find((x) => x.title === t); return { state: s.state, applet: s.applet }; });
const FAIL_MS = 800, REPAIR_MS = 10 * 60000;          // a tap's screen read again after; a hold that repairs it, within
/* a tap that did nothing: the screen read before and after the open is the same, and is not the one asked for */
function stuck(before, after, t) {
    const p = (r) => { const m = /^ok (-?\d+) (-?\d+)/.exec(r || ''); return m ? [+m[1], +m[2]] : null; };
    const b = p(before), a = p(after);
    return !!(b && a && b[0] === a[0] && b[1] === a[1] && !(a[0] === t.state && a[1] === t.applet));
}
// the seat / wheel buttons in the bar: 'auto' = what the car reports, 'on' / 'off' = the user's choice (cars that report
// a function they don't have: a client's M2 without ventilation showed its icon, 2026-11-04)
const BUTTON_KEYS = ['driver.wheel', 'driver.cool', 'driver.heat', 'passenger.cool', 'passenger.heat'];
const SHOW = ['auto', 'on', 'off'], MCAR = ['auto', 'yes', 'no'];
/* an M car: the user's choice, else what the car reported (an M setup seen) */
const mcarOf = (found, set) => (set.mmode.car === 'yes' ? true : set.mmode.car === 'no' ? false : !!found);
const RED = [255, 48, 49], BLUE = [29, 120, 223], WHITE = [255, 255, 255];   // the HMI's accent colours
const OFF_ALPHA = 0.6;
const MODES = ['road', 'sport', 'track'];
const SIDES = ['left', 'right'];                     // where the steering wheel is (LAYOUT is a left-hand drive car's)
const SETTINGS = { shortcuts: true, seats: true, wheel: true, ambient: true, ambientHeat: 3, ambientCool: 9, order: 'up', side: 'left',
    show: BUTTON_KEYS.reduce((o, k) => { o[k] = 'auto'; return o; }, {}),
    mmode: { on: true, m1: 'sport', m2: 'sport', off: 'road', boot: false, car: 'auto' }, shift: shift.DEFAULTS };
// MDrive 0xB51F, the active M setup: statusMConfigurationMDrive 0x8018 byte 0 (Hmi8's ...SP21: 0 none, 1 M1, 2 M2,
// 3 unset) or, older, statusMDriveTwo 0x8001 byte 0 (...SP18: statusMDrive2 0 off, 1 on); SP21 wins once seen
const MDRIVE = 0xb51f, MDRIVE_SUB = `sub 0xb51f 1 1 1 0x8018 0x8001 0x${shift.DME.ev.toString(16)}`;
// Vehicle2 0xB519 statusDisplayKombi 0x807C (getter 124): the cluster's view, 1 standard, 2 M view, 3 M view plus,
// 15 not filled in (mgu-m4 2026-11-03: 02 in SPORT, the getter answers)
const VEHICLE2 = 0xb519, KOMBI_EV = 0x807c, KOMBI_SUB = 'sub 0xb519 1 1 1 0x807c';
// the car switched off ends an M setup, and SP18's toggle with it (a client's M2, 2026-11-05: switched off in M1, the
// next M press read as leaving): VehicleCondition 0x1531 vehicleConditionNoCrc 0x8002 (event group 2), byte 5
// statusConditionVehicle 1 / 2 PARKEN, 3 STANDFUNKTIONEN, 5 WOHNEN (10 FAHREN, 8 / 12 drive-ready coming / going);
// and the head unit asleep (STR: the process stood still WAKE_MS or longer)
const VCOND = 0x1531, VCOND_EV = 0x8002, VCOND_SUB = 'sub 0x1531 1 1 2 0x8002', WAKE_MS = 60000;
const carOff = (hex) => [1, 2, 3, 5].indexOf(parseInt((hex || '').slice(10, 12), 16)) >= 0;
const mReset = (m) => { m.sp18 = 0; m.setup = 0; };
// the ambient light flash when a seat or the wheel heating goes on: ComfortFunctionIuK 0xB512, the 12-colour ambient
// light (G8x): status getter 3 / setter 26, 10 bytes {hue u16, colour 1-12, layer 1-3, brightness, mode (1 on),
// dynamic x2}; 0fff / ff / 03 = no change. The colour byte is the 0-based place in the HMI's list (sqltext.db: Ivory,
// Citrine, Coral, ... Azure 9th); mgu-m4 2026-11-03 (user): 3rd red, 9th azure. Back to the colour read before after FLASH_MS.
// The settings hold the colours' numbers as the menu counts them (1-12): ambientHeat, ambientCool.
const AMBIENT = { get: 'call 0xb512 1 3 1', set: (c) => `call 0xb512 1 26 1 0fff${c}ffffffff030303`,
    byte: (n) => (n - 1).toString(16).padStart(2, '0') };
const FLASH_MS = 5000, FLASH_AFTER_MS = 10000;      // ponytail: no flash for the start's first statuses (grace window)
// boot: the strip shows with the HMI, not over the black screen of a start nor the M start animation (a client
// 2026-11-07: "overlaps with the M boot animation"; mgu-m4: the animation is a video cameraplayer plays on surface 0x198,
// 1280x480 surface ~50 s from boot, the animation itself a few seconds). Shown AFTER_MS after the start (the head unit's
// boot, or a wake from sleep; a tester 2026-11-07: 1 min too long, 10-15 s enough) and only once the HMI answers its
// graphical context (HMIContext2); it stays over the cameras after that. No HMI answer by MAX_MS: shown all the same.
// A restart of the tool later (an update) shows it at once.
const BOOT = { AFTER_MS: 15000, MAX_MS: 60000 };
function bootGate(now, b) {                          // b: { since (the start), hmiAt (0: not yet) } -> why up, or null
    if (b.hmiAt && now - b.since >= BOOT.AFTER_MS) return 'HMI up';
    return now - b.since >= BOOT.MAX_MS ? 'timeout' : null;
}
/** when the head unit started: now less its uptime (/proc/uptime counts sleep too: a wake is told by the tick gap) */
function bootedAt() {
    try { return Date.now() - parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) * 1000; } catch (e) { return Date.now(); }
}

const log = (m) => console.log(m);

/* ---- what is installed, slots <-> graphical contexts (pure; --test) ---- */
function installedApps(root) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return []; }
    const apps = [];
    for (const d of dirs) {
        try {
            const a = JSON.parse(fs.readFileSync(path.join(root, d, 'rhmiData', 'application.json'), 'utf8')
                .replace(/^﻿/, '')).application;
            if (a && a.name && typeof a.appletId === 'number') {
                const ep = (a.entryPoints || [])[0];
                apps.push({ id: a.name, appletId: a.appletId, dir: path.join(root, d), icon: ep && ep.icon, tile: !!ep });
            }
        } catch (e) { /* no RHMI app there */ }
    }
    return apps;
}
/* the screen on the CID (StateID, AppletID) -> what a slot keeps */
function classify(state, applet, apps) {
    for (const a of apps) {
        const off = applet - a.appletId;
        if (OFFSETS.indexOf(off) >= 0) return { app: a.id, state, offset: off };
    }
    return { state, applet };
}
/* a slot -> the context to open now (null: its app is not installed) */
function target(slot, apps) {
    if (!slot.app) return { state: slot.state, applet: slot.applet };
    const a = apps.find((x) => x.id === slot.app);
    return a ? { state: slot.state, applet: a.appletId + slot.offset } : null;
}
/* a slot -> its picture: { builtin: name } or { file } (+ missing for an app that is gone); the icon picked for it in the
 * app (slot.icon, one of the head unit's own: hmiicons.js) wins: { file, hmi } */
function iconOf(slot, apps) {
    const b = ownIcon(slot, apps), f = slot.icon && hmiIcons.file(slot.icon);
    return f ? Object.assign({ file: f, hmi: slot.icon }, b.missing ? { missing: true } : {}) : b;
}
function ownIcon(slot, apps) {
    if (!slot.app) { const s = screenList().find((x) => x.state === slot.state && x.applet === slot.applet); return { builtin: s ? s.png : 'screen' }; }
    const a = apps.find((x) => x.id === slot.app);
    if (!a) return { builtin: 'app', missing: true };
    const want = typeof a.icon === 'string' && !/^gid:/.test(a.icon) ? path.basename(a.icon) : null;
    const f = (want && findFile(path.join(a.dir, 'rhmiData'), want, 4)) ||
        [path.join(a.dir, 'source', 'icon.png')].find((p) => fs.existsSync(p));
    return f ? { file: f } : { builtin: 'app' };
}
function findFile(dir, name, depth) {
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch (e) { return null; }
    if (ents.indexOf(name) >= 0 && fs.statSync(path.join(dir, name)).isFile()) return path.join(dir, name);
    for (const e of ents) {
        const p = path.join(dir, e);
        if (depth > 0 && fs.statSync(p).isDirectory()) { const f = findFile(p, name, depth - 1); if (f) return f; }
    }
    return null;
}
/* an app's name (its package's productName) and the screen its tile opens (the lowest RHMI state). The AppletID is the
 * appletId itself on the car (mgu-m4 2026-11-03: Car Data, Fault Codes held at state 3000 with offset 0); some SDK
 * builds add 3000 (the VM's older apps): tap() tries the other offset when this one fails, and keeps the one that works */
function appInfo(a) {
    let title = a.id, state = null;
    try { title = JSON.parse(fs.readFileSync(path.join(a.dir, 'source', 'package.json'), 'utf8')).productName || title; } catch (e) { /* none */ }
    const ui = findFile(path.join(a.dir, 'rhmiData', 'uiDescriptions', 'ID8'), 'uiDescription.json', 1) ||
        findFile(path.join(a.dir, 'rhmiData'), 'uiDescription.json', 3);
    try {
        const c = JSON.parse(fs.readFileSync(ui, 'utf8')).containers || {};
        Object.keys(c).filter((k) => c[k].type === 'state').forEach((k) => { if (state === null || +k < state) state = +k; });
    } catch (e) { /* no description */ }
    return state === null ? null : { id: a.id, title, state, offset: 0 };
}
/* a slot as the app shows it (+ hmiIcon / iconName: the head unit's icon picked for it) */
function describe(slot, apps) {
    const own = slot.icon ? { hmiIcon: slot.icon, iconName: hmiIcons.nameOf(slot.icon) } : {};
    if (slot.app) {
        const a = apps.find((x) => x.id === slot.app), i = a && appInfo(a);
        return Object.assign({ kind: 'app', app: slot.app, title: i ? i.title : slot.app, missing: !a }, own);
    }
    const s = screenList().find((x) => x.state === slot.state && x.applet === slot.applet);
    return Object.assign({ kind: 'bmw', title: s ? s.title : 'BMW screen', icon: s ? s.icon : 'Display' }, own);
}
const ICON_ID = /^icon_[A-Za-z0-9_]{1,80}$/;
/* a slot from the file: a picked icon only by its id's form (one the head unit no longer has draws the slot's own) */
const cleanSlot = (s) => { const o = Object.assign({}, s); if (o.icon !== undefined && !(typeof o.icon === 'string' && ICON_ID.test(o.icon))) delete o.icon; return o; };
/* settings from the app (or the file): only known keys of the right kind; the rest stays */
function mergeSettings(cur, p) {
    const out = JSON.parse(JSON.stringify(cur));
    if (!p || typeof p !== 'object') return out;
    ['shortcuts', 'seats', 'wheel', 'ambient'].forEach((k) => { if (typeof p[k] === 'boolean') out[k] = p[k]; });
    ['ambientHeat', 'ambientCool'].forEach((k) => { if (Number.isInteger(p[k]) && p[k] >= 1 && p[k] <= 12) out[k] = p[k]; });
    if (p.order === 'up' || p.order === 'down') out.order = p.order;
    if (SIDES.indexOf(p.side) >= 0) out.side = p.side;
    if (p.show && typeof p.show === 'object') BUTTON_KEYS.forEach((k) => { if (SHOW.indexOf(p.show[k]) >= 0) out.show[k] = p.show[k]; });
    if (p.mmode && typeof p.mmode === 'object') {
        ['on', 'boot'].forEach((k) => { if (typeof p.mmode[k] === 'boolean') out.mmode[k] = p.mmode[k]; });
        ['m1', 'm2', 'off'].forEach((k) => { if (MODES.indexOf(p.mmode[k]) >= 0) out.mmode[k] = p.mmode[k]; });
        if (MCAR.indexOf(p.mmode.car) >= 0) out.mmode.car = p.mmode.car;
    }
    out.shift = shift.mergeSettings(out.shift, p.shift);
    return out;
}
const slotOk = (s) => s && Number.isInteger(s.state) &&
    (typeof s.app === 'string' ? OFFSETS.indexOf(s.offset) >= 0 : Number.isInteger(s.applet));
function loadData(file) {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') log('slots.json: ' + e.message + ', the defaults instead'); }
    const good = Array.isArray(j.slots) && j.slots.length === 4 && j.slots.every(slotOk);
    if (j.slots && !good) log('slots.json: not 4 good slots, the defaults instead');
    const lr = {};
    if (j.learned && typeof j.learned === 'object') {
        SCREENS.forEach((s) => { const v = j.learned[s.title]; if (v && Number.isInteger(v.state) && Number.isInteger(v.applet)) lr[s.title] = { state: v.state, applet: v.applet }; });
    }
    learned = lr;
    const vents = {};                                  // legacy cars: seats whose ventilation was seen on (seats.js)
    seats.SEATS.forEach((s) => { if (j.vents && j.vents[s] === true) vents[s] = true; });
    return { slots: good ? j.slots.map(cleanSlot) : defaults(), layout: j.layout, learned: lr, settings: migrate(mergeSettings(SETTINGS, j.settings), j.settings),
        mcar: j.mcar === true, vents };
}
/* 0.3.5 and older had one switch for all seat buttons and one for the wheel; the per-button choice replaces them (the
 * app shows only that): a switch that was off turns its buttons 'off' */
function migrate(set, old) {
    if (!old || typeof old !== 'object' || old.show) return set;
    if (old.seats === false) BUTTON_KEYS.filter((k) => k !== 'driver.wheel').forEach((k) => { set.show[k] = 'off'; });
    if (old.wheel === false) set.show['driver.wheel'] = 'off';
    set.seats = set.wheel = true;
    return set;
}
function saveData(file, data) {
    try { fs.mkdirSync(path.dirname(file)); } catch (e) { if (e.code !== 'EEXIST') throw e; }   // node 8: no recursive
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
}
/* an MDrive notification -> the active M setup (0 none, 1 M1 - SP18: an M setup on -, 2 M2), or null: not about
 * that, unset, or SP18 after SP21 was seen. SP21's 0x8018 is a state. SP18's statusMDriveTwo 0x8001 is NOT
 * (mgu-m4 2026-11-03): each M button action sends ONE "EIN" frame with the configuration it applies (entering M1, also
 * by the double press DSC off needs: M1's; leaving: the car's normal one) and at once "AUS" again. So an EIN frame
 * toggles (at a start no M setup is active); AUS frames and repeats within PULSE_MS are ignored. Only frames with
 * byte 1 controlDisplayMDrive2 = 1 (M1_M2_TASTE_AKTIV) come from the M buttons: the car also sends EIN frames with 0
 * there and the normal settings by itself (5 in 13 min on mgu-m4, 2026-11-03), which must not toggle. A direct
 * M1 -> M2 switch would read as leaving (not seen on the car yet). */
const PULSE_MS = 1000;
function mSetupOf(m, ev, hex, now) {
    const v = parseInt((hex || '').slice(0, 2), 16);
    if (ev === 0x8018 && v <= 2) { m.sp21 = true; return v; }
    if (ev !== 0x8001 || m.sp21 || v !== 1 || parseInt(hex.slice(2, 4), 16) !== 1) return null;
    if (now - (m.pulseAt || -Infinity) < PULSE_MS) return null;
    m.pulseAt = now;
    m.sp18 = m.sp18 ? 0 : 1;
    return m.sp18;
}
/* which flash for levels (one per key, 0 off) going from off to on: 'heat' (seat, wheel; also when both) or 'cool'
 * (ventilation); null when nothing went on */
function flashKind(keys, before, after) {
    const on = keys.filter((k, i) => !before[i] && after[i]);
    return !on.length ? null : on.some((k) => !k.endsWith('.cool')) ? 'heat' : 'cool';
}
/* the ambient light's colour number from its status (hex), or null when it is off or unreadable */
function ambientColour(hex) {
    return hex && hex.length === 20 && hex.slice(14, 16) === '01' ? hex.slice(4, 6) : null;
}
/* the cluster's view (statusDisplayKombi byte 0) -> it, when the cluster just came up: the first filled-in value
 * since the tool started or since it read 15. "Start in M SPORT" waits for that, not for the head unit's own start:
 * the head unit wakes before the cluster does */
function clusterUp(k, hex) {
    const v = parseInt((hex || '').slice(0, 2), 16);
    if (!(v >= 1 && v <= 3)) { k.up = false; return null; }
    if (k.up) return null;
    k.up = true;
    return v;
}
/* the next level of a tap: 1 -> 2 -> 3 -> off ('up'), or 3 -> 2 -> 1 -> off ('down') */
const nextLevel = (level, max, order) => (order === 'down' ? (level > 0 ? level - 1 : max) : seats.next(level, max));
/* the seat whose spots a seat's buttons take: its own on a left-hand drive car, the other one's on a right-hand drive
 * one (the driver sits on the right: a client's report 2026-11-08, the left icons switched the right seat) */
const spotSeat = (seat, side) => (side !== 'right' ? seat : seat === 'driver' ? 'passenger' : 'driver');
/* where a seat / wheel button sits (L.buttons: a left-hand drive car's); the wheel at the other end on a right-hand one */
function spot(L, key, side) {
    const [seat, kind] = key.split('.');
    if (kind === 'wheel') return side === 'right' ? L.w - L.buttons[key] - L.buttonW : L.buttons[key];
    return L.buttons[`${spotSeat(seat, side)}.${kind}`];
}
/* the seat / wheel buttons to show, [{ key, x }]: per button the user's choice ('on' / 'off'), on 'auto' what the car has;
 * the old master switches (seats, wheel) still hide theirs */
function buttons(L, st, set) {
    const want = (key, have) => (set.show[key] === 'on' || (set.show[key] !== 'off' && have));
    const out = [];
    if (set.wheel && want('driver.wheel', st.wheel.have)) out.push({ key: 'driver.wheel', x: spot(L, 'driver.wheel', set.side) });
    if (set.seats) {
        for (const seat of seats.SEATS) {
            for (const kind of ['cool', 'heat']) {
                const key = `${seat}.${kind}`;
                if (want(key, st.seats[seat][kind].have)) out.push({ key, x: spot(L, key, set.side) });
            }
        }
    }
    return out;
}

/* ---- touch: tap or hold, per gesture (pure; --test). Targets: slot numbers (tap + hold), button keys (tap) ---- */
class Gestures {
    constructor(targetAt, onTap, onHold, timers) {
        this.targetAt = targetAt; this.onTap = onTap; this.onHold = onHold; this.t = timers || { set: setTimeout, clear: clearTimeout };
        this.cur = -1; this.held = false; this.timer = null;
    }
    touch(phase, x) {
        const k = this.targetAt(x);
        if (phase === 'down') {
            this.cancel(); this.cur = k; this.held = false;
            if (typeof k === 'number' && k >= 0) this.timer = this.t.set(() => { this.timer = null; this.held = true; this.onHold(k); }, HOLD_MS);
        } else if (phase === 'move' && k !== this.cur) this.cancel();
        else if (phase === 'up') {
            if (this.cur !== -1 && !this.held && k === this.cur) this.onTap(k);
            this.cancel();
        }
    }
    cancel() { if (this.timer) this.t.clear(this.timer); this.timer = null; this.cur = -1; }
    pressed() { return this.held ? -1 : this.cur; }
}

/* ---- drawing: premultiplied RGBA ---- */
function blend(dst, w, x0, y0, img, alpha) {         // img straight RGBA, alpha 0..1
    for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
            const s = (y * img.w + x) * 4, a = img.data[s + 3] * alpha / 255;
            const dx = x0 + x, dy = y0 + y;
            if (!a || dx < 0 || dy < 0 || dx >= w || dy * w * 4 >= dst.length) continue;
            const d = (dy * w + dx) * 4;
            for (let c = 0; c < 3; c++) dst[d + c] = Math.round(img.data[s + c] * a + dst[d + c] * (1 - a));
            dst[d + 3] = Math.round(255 * a + dst[d + 3] * (1 - a));
        }
    }
}
function pill(w, h, inset, r, alpha, rgb) {          // a rounded rect, edges anti-aliased, as a straight image
    const data = Buffer.alloc(w * h * 4), c = rgb || [255, 255, 255];
    const hw = w / 2 - inset, hh = h / 2 - inset;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const qx = Math.abs(x + 0.5 - w / 2) - (hw - r), qy = Math.abs(y + 0.5 - h / 2) - (hh - r);
            const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
            const cov = Math.max(0, Math.min(1, 0.5 - dist)), i = (y * w + x) * 4;
            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = Math.round(255 * alpha * cov);
        }
    }
    return { w, h, data };
}
function tint(img, rgb) {                            // the HMI's icons are grey + alpha: coloured like the HMI does
    if (!img) return img;
    const data = Buffer.from(img.data);
    for (let i = 0; i < data.length; i += 4) { data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; }
    return { w: img.w, h: img.h, data };
}
/* one seat / wheel button (buttonW x h): the icon off its centre, the accent line when on */
/* on, the accent line shows the level: `max` segments, `level` of them lit, the rest dim; over the bar's own colour,
 * so the HMI's full line under it doesn't show through (one segment: the whole line, the wheel's on / off) */
const BAR_BG = [1, 4, 8], DIM_SEG = [80, 86, 94], SEG_GAP = 6;
function drawButton(px, L, kind, img, level, pressed, max) {
    const BW = L.buttonW, on = level > 0, rgb = kind === 'cool' ? BLUE : RED;
    if (pressed) blend(px, BW, 0, 0, pill(BW, L.h, 6, 16, 0.18), 1);
    if (img) {
        const cx = BW / 2 + ICON_DX;
        blend(px, BW, Math.round(cx - img.w / 2), Math.round(L.iconY - img.h / 2), tint(img, on ? rgb : WHITE), on ? 1 : OFF_ALPHA);
    }
    if (!on) return;
    const n = Math.max(1, max || 1), sw = (BW - (n - 1) * SEG_GAP) / n;
    blend(px, BW, 0, L.lineY, pill(BW, L.lineH, 0, 0, 1, BAR_BG), 1);
    for (let i = 0; i < n; i++) {
        const x0 = Math.round(i * (sw + SEG_GAP)), x1 = Math.round(i * (sw + SEG_GAP) + sw);
        blend(px, BW, x0, L.lineY, pill(x1 - x0, L.lineH, 0, 0, 1, i < level ? rgb : DIM_SEG), 1);
    }
}

/* ---- the service ---- */
function main() {
    const { RenderClient, imageOp } = require(CLIENT);
    const conf = loadData(DATA);
    const L = Object.assign({}, LAYOUT, conf.layout || {});
    let slots = conf.slots, settings = conf.settings, mcar = conf.mcar, apps = installedApps(OAP);   // mcar: an M setup was seen
    const mEff = () => mcarOf(mcar, settings);       // an M car: the user's choice wins
    const SW = L.slotW, H = L.h, BW = L.buttonW, ICON_MAX = 76, HMI_PX = 84;
    const pics = {}, flash = [0, 0, 0, 0], looks = [], failAt = [0, 0, 0, 0];
    let notice = null;                                // the last tap that did nothing: { slot, title, at }
    const boot = { since: 0, hmiAt: 0, up: false };    // BOOT: shown once up
    const st = seats.state(!!process.env.OVERLAYS_SEAT_DEMO);
    Object.assign(st.legacy.seen, conf.vents);
    let ventsSaved = JSON.stringify(st.legacy.seen);
    const pending = {};                               // pending['driver.heat'] = { level, until }
    const gpu = new RenderClient('iteriodev-overlays', { info: log, warn: log, error: log });
    const PIX = { 'driver.wheel': 5, 'driver.cool': 6, 'driver.heat': 7, 'passenger.cool': 8, 'passenger.heat': 9 };

    function picture(ic, cb, max) {                   // a decoded, fitted picture; cached by file + mtime
        const file = ic.file || path.join(__dirname, 'icons', ic.builtin + '.png');
        let key = file;
        try { key += ':' + fs.statSync(file).mtime.getTime(); } catch (e) { return cb(null); }
        if (pics[key] !== undefined) return cb(pics[key]);
        let buf;
        try { buf = fs.readFileSync(file); } catch (e) { return cb(null); }
        png.decodeAsync(buf, (e, img) => {
            if (e) log(`icon ${file}: ${e.message}`);
            pics[key] = e ? null : png.fit(img, max || ICON_MAX);
            cb(pics[key]);
        });
    }
    const save = () => {
        try { saveData(DATA, Object.assign(conf.layout ? { layout: conf.layout } : {}, { slots, settings, mcar, learned, vents: st.legacy.seen })); } catch (e) { log('save: ' + e.message); }
    };
    function drawSlot(i) {
        const ic = iconOf(slots[i], apps);
        looks[i] = JSON.stringify(ic);
        picture(ic, (img) => {
            const px = Buffer.alloc(SW * H * 4);
            const failed = failAt[i] + 1500 > Date.now();  // the tap did nothing: red for a moment
            const bg = failed ? 0.45 : flash[i] > Date.now() ? 0.4 : gestures.pressed() === i ? 0.18 : 0;
            if (bg) blend(px, SW, 0, 0, pill(SW, H, 10, 20, bg, failed ? RED : null), 1);
            if (img) blend(px, SW, (SW - img.w) >> 1, (H - img.h) >> 1, img, ic.missing ? 0.4 : 1);
            gpu.pixels(i + 1, [{ x: 0, y: 0, w: SW, h: H }], px);
            frame();
        }, ic.hmi ? HMI_PX : undefined);               // the head unit's icons at their own size
    }
    const state = (key) => {                          // 'driver.heat' -> its { have, level, max }; 'driver.wheel' too
        const [seat, kind] = key.split('.');
        return kind === 'wheel' ? st.wheel : st.seats[seat][kind];
    };
    const shown = (key) => {                          // the level to show: the asked one until the car answers
        const p = pending[key], k = state(key);
        return p && p.until > Date.now() && p.level !== k.level ? p.level : k.level;
    };
    function drawButtonKey(key) {
        const [seat, kind] = key.split('.');
        // the HMI's icon for the spot it is drawn in (a right-hand drive car: the driver's buttons in the right-hand spots)
        picture({ builtin: kind === 'wheel' ? 'hmi-wheel' : `hmi-${kind}-${spotSeat(seat, settings.side)}` }, (img) => {
            const px = Buffer.alloc(BW * H * 4);
            drawButton(px, L, kind, img, shown(key), gestures.pressed() === key, state(key).max);
            gpu.pixels(PIX[key], [{ x: 0, y: 0, w: BW, h: H }], px);
            frame();
        }, HMI_PX);
    }
    const shownButtons = () => buttons(L, st, settings);
    const shownSlots = () => (settings.shortcuts ? L.slots : []);
    const draw = (k) => (typeof k === 'number' ? (k >= 0 ? drawSlot(k) : null) : drawButtonKey(k));
    function frame() {
        const ops = shownSlots().map((x, i) => imageOp(i + 1, x, 0, SW, H, 0));
        for (const b of shownButtons()) ops.push(imageOp(PIX[b.key], b.x, 0, BW, H, 0));
        const all = new Uint32Array(ops.reduce((n, o) => n + o.length, 0));
        ops.reduce((at, o) => { all.set(o, at); return at + o.length; }, 0);
        gpu.frameWords(all);
    }
    function claims() {                               // the shortcuts and the buttons shown (none while booting)
        if (!boot.up) return gpu.claim([]);
        gpu.claim(shownSlots().map((x) => ({ x, y: 0, w: SW, h: H })).concat(shownButtons().map((b) => ({ x: b.x, y: 0, w: BW, h: H }))));
    }
    function targetAt(x) {
        const i = shownSlots().findIndex((l) => x >= l && x < l + SW);
        if (i >= 0) return i;
        const b = shownButtons().find((c) => x >= c.x && x < c.x + BW);
        return b ? b.key : -1;
    }
    const redrawAll = () => { shownSlots().forEach((x, i) => drawSlot(i)); shownButtons().forEach((b) => drawButtonKey(b.key)); claims(); frame(); };

    /* hmictl serve: one line out, one line back, in order; "ev" lines are notifications */
    let child = null, out = '', busy = null, busyTimer = null;
    const queue = [];
    function hmi(line) { return new Promise((res) => { queue.push({ line, res }); pump(); }); }
    function pump() {
        if (busy || !queue.length) return;
        if (!child) {
            child = spawn(HMICTL, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
            child.on('error', (e) => log('hmictl: ' + e.message));
            child.stdin.on('error', (e) => log('hmictl: ' + e.message));   // it died with a line on its way (EPIPE)
            child.stdout.on('data', (d) => {
                out += d;
                for (let n; (n = out.indexOf('\n')) >= 0; out = out.slice(n + 1)) {
                    const line = out.slice(0, n);   // vsomeip may log to stdout too (under systemd): not ours
                    if (line.startsWith('ev ')) onEvent(line); else if (/^(ok|error)\b/.test(line)) done(line);
                }
            });
            child.on('exit', (c) => {
                log('hmictl exited ' + c); child = null; out = '';
                if (busy) done('error hmictl exited');
                setTimeout(subscribe, 2000);          // a new hmictl has no subscriptions
            });
        }
        busy = queue.shift();
        busyTimer = setTimeout(() => { if (child) child.kill(); }, 10000);
        child.stdin.write(busy.line + '\n');
    }
    function done(line) {
        clearTimeout(busyTimer);
        const b = busy; busy = null;
        if (b) b.res(line);
        pump();
    }
    function seatChanged(changed) {
        if (!changed) return;
        for (const k of Object.keys(pending)) {      // the car took (or refused) the asked level
            if (pending[k].level === state(k).level || pending[k].until <= Date.now()) delete pending[k];
        }
        if (JSON.stringify(st.legacy.seen) !== ventsSaved) { ventsSaved = JSON.stringify(st.legacy.seen); save(); }
        redrawAll();
        push();
    }
    function onEvent(line) {
        const w = line.split(' '), svc = parseInt(w[1], 16), ev = parseInt(w[2], 16);
        if (svc === MDRIVE && ev === shift.DME.ev) sl.dme(w[3]);
        else if (svc === MDRIVE) mSetup(ev, w[3]);
        else if (svc === VEHICLE2 && ev === KOMBI_EV) kombi(w[3]);
        else if (svc === VCOND && ev === VCOND_EV) { if (carOff(w[3]) && (m.sp18 || m.setup)) { log(`car off (${w[3]}): no M setup`); mReset(m); } }
        else if (svc === shift.RPM.svc && ev === shift.RPM.ev) sl.rpm(w[3]);
        else if (svc === shift.LIMIT.svc && ev === shift.LIMIT.ev) sl.limit(w[3]);
        else {
            const before = levels(), changed = seats.apply(st, svc, ev, w[3]), k = flashKind(KEYS, before, levels());
            if (k && settings.ambient && Date.now() > flashFrom) {
                ambientFlash(AMBIENT.byte(k === 'heat' ? settings.ambientHeat : settings.ambientCool));
            }
            seatChanged(changed);
        }
    }
    const KEYS = Object.keys(PIX), flashFrom = Date.now() + FLASH_AFTER_MS;
    const levels = () => KEYS.map((k) => (state(k).have ? state(k).level : 0));
    const amb = { orig: null, timer: null };
    async function ambientFlash(c) {                  // the colour for FLASH_MS, then the one read before
        if (!amb.orig) {
            const r = await hmi(AMBIENT.get), o = ambientColour(r.slice(3));
            if (!o) return;                               // off, or no answer: no flash
            if (!amb.orig) amb.orig = o;
        }
        clearTimeout(amb.timer);
        hmi(AMBIENT.set(c));
        amb.timer = setTimeout(() => {
            const o = amb.orig;
            amb.orig = null;
            hmi(AMBIENT.set(o)).then((r) => log(`ambient flash ${c} -> back to ${o}: ${r.split(' ')[0]}`));
        }, FLASH_MS);
    }

    /* shift lights in cluster-render's `guide` target and in `hud` (shiftlights.js), only on cars without their own: an
     * M car (an M setup seen, the DME's shift-light signal seen, or the user's choice) has its own in the cluster and the
     * HUD (a client's M2, 2026-11-05: ours over the map). Off or an M car: no rpm polling, no layer shown */
    const sl = (() => {
        const v = { rpm: 0, limit: null, dme: null, dmeAt: 0, seg: -1, flash: null, shown: {}, vis: { shown: false, lowSince: 0 },
            renderer: 'missing', layer: '', own: null };
        const own = () => mcarOf(mcar || v.dmeAt > 0, settings);
        const poll = () => hmi(settings.shift.on && !v.own ? shift.RPM.poll : shift.RPM.poll.replace(/ 50 /, ' 0 '));
        let cr = null;
        const layers = {};                            // target -> layer ref
        if (fs.existsSync(CLUSTER)) {
            try {
                const { ClusterRender } = require(CLUSTER);
                cr = new ClusterRender('iteriodev-overlays');
                Object.keys(shift.TARGETS).forEach((t) => {
                    const g = shift.TARGETS[t];
                    layers[t] = cr.effect({ target: t, klass: 'overlay', x: 0, y: 0, w: g.w, h: g.h, fs: shift.fs(g), time: true, visible: 0 });
                    cr.uniform(layers[t], 'u_seg', [0]); cr.uniform(layers[t], 'u_flash', [0]);
                });
                cr.on('layer', (ref, state, reason) => {
                    if (ref === layers.guide) { v.layer = state; push(); }
                    log(`shift lights: ${ref === layers.hud ? 'hud' : 'guide'} layer ${state}${reason ? ` (${reason})` : ''}`);
                });
                cr.on('target', (name, state, holder, reason) => log(`shift lights: target ${name} ${state}${reason ? ` (${reason})` : ''}`));
                cr.on('ready', () => { v.renderer = 'connected'; push(); });
                cr.on('disconnected', () => { v.renderer = 'not running'; push(); });
                cr.on('refused', (op, ref, reason) => { v.layer = `refused: ${reason}`; log(`shift lights: ${op} refused: ${reason}`); push(); });
                cr.connect();
                v.renderer = 'connecting';
            } catch (e) { log('shift lights: cluster-render client: ' + e.message); }
        } else log('shift lights: cluster-render is not installed');
        function update() {
            const s = settings.shift, now = Date.now(), th = shift.thresholds(s, v.limit);
            if (own() !== v.own) { v.own = own(); poll(); push(); }
            const l = v.dme && now - v.dmeAt < shift.DME_FRESH_MS ? v.dme : shift.lights(v.rpm, th);
            const near = s.on && !v.own && shift.visible(v.vis, v.rpm, th, l.seg, now);
            const shown = { guide: near, hud: near && s.hud };
            if (!cr) return;
            const all = (name, val) => Object.keys(layers).forEach((t) => cr.uniform(layers[t], name, [val]));
            if (l.seg !== v.seg) { v.seg = l.seg; all('u_seg', l.seg); }
            if (l.flash !== v.flash) { v.flash = l.flash; all('u_flash', l.flash ? 1 : 0); }
            Object.keys(layers).forEach((t) => {
                if (shown[t] !== v.shown[t]) { v.shown[t] = shown[t]; cr.set(layers[t], { visible: shown[t] ? 1 : 0 }); }
            });
        }
        return {
            rpm(hex) { const r = shift.rpmOf(hex); if (r !== null) { v.rpm = r; update(); } },
            limit(hex) { const l = shift.limitOf(hex); if (l !== v.limit) { v.limit = l; update(); push(); } },
            dme(hex) { const d = shift.dmeOf(hex); if (d) { v.dme = d; v.dmeAt = Date.now(); update(); } },
            settings() { v.own = own(); poll(); update(); },
            status: () => ({ renderer: v.renderer, layer: v.layer, limit: v.limit, dme: v.dmeAt > 0, own: own(), th: shift.thresholds(settings.shift, v.limit) }),
            tick: update,                             // the hysteresis' timeout
            close() { if (cr) cr.close(); },
        };
    })();
    const m = { sp21: false, setup: 0 };
    function mSetup(ev, hex) {                        // a setup on (also already on at start) -> its mode, off -> 'off'
        const s = mSetupOf(m, ev, hex, Date.now());
        if (s === null) return;
        if (!mcar || (m.sp21 && !m.told)) { mcar = true; m.told = m.sp21; save(); push(); }   // an M car (found)
        if (s === m.setup) return;
        m.setup = s;
        if (!settings.mmode.on || !mEff()) return;     // the user said: not an M car
        const mode = s === 0 ? settings.mmode.off : s === 1 ? settings.mmode.m1 : settings.mmode.m2;
        hmi(`mmode ${mode}`).then((r) => log(`M setup ${s} (0x${ev.toString(16)} ${hex}): mmode ${mode}: ${r}`));
    }
    const k = { up: false, view: null };
    function kombi(hex) {                             // Start in M SPORT (M cars): once the cluster is up, in its standard view
        const v = parseInt(hex.slice(0, 2), 16), up = clusterUp(k, hex);
        if (v !== k.view) { log(`cluster view ${k.view} -> ${v}`); k.view = v; }
        if (up === 1 && mEff() && settings.mmode.boot) hmi('mmode sport').then((r) => log(`cluster up: mmode sport: ${r}`));
    }
    function subscribe() {
        if (st.backend !== 'demo') seats.SUBS.forEach((l) => hmi(l));
        hmi(MDRIVE_SUB);
        hmi(KOMBI_SUB);
        hmi(VCOND_SUB);
        hmi(shift.LIMIT.sub);
        sl.settings();                                // the rpm poll (hmictl's own thread), when the shift lights are on
    }
    async function reread() {                         // the notifications keep it current; this is the safety net
        for (const g of seats.rereads(st)) {
            const r = await hmi(g.line);
            if (r.startsWith('ok ')) seatChanged(seats.apply(st, g.svc, g.ev, r.slice(3)));
        }
    }

    async function tap(i) {
        apps = installedApps(OAP);
        const s = slots[i], t = target(s, apps);
        if (!t) { log(`slot ${i}: ${s.app} is not installed`); return; }
        const before = s.app ? null : await hmi('ctx');   // a BMW screen: did the tap change anything?
        let r = await hmi(`open ${t.state} ${t.applet}`);
        if (!s.app) {
            await new Promise((res) => setTimeout(res, FAIL_MS));
            const after = await hmi('ctx');
            if (stuck(before, after, t)) {
                const title = describe(s, apps).title;
                failAt[i] = Date.now();
                notice = { slot: i, title, at: failAt[i] };
                log(`slot ${i}: ${title} (${t.state} ${t.applet}) did not open: still ${after.slice(3)}`);
                drawSlot(i); setTimeout(() => drawSlot(i), 1550);
                push();
                return;
            }
        }
        if (r !== 'ok' && s.app) {                    // the other offset (appInfo): kept when it opens
            const other = OFFSETS.find((o) => o !== s.offset), alt = target(Object.assign({}, s, { offset: other }), apps);
            if (await hmi(`open ${alt.state} ${alt.applet}`) === 'ok') {
                log(`slot ${i}: ${s.app} opens at offset ${other}`);
                setSlot(i, Object.assign({}, s, { offset: other }));
                return;
            }
        }
        if (r !== 'ok' && s.app) {                    // not registered with the HMI yet: launch it, then again
            log(`slot ${i}: open ${t.state} ${t.applet}: ${r}, starting ${s.app}`);
            await hmi(`start ${s.app}`);
            await new Promise((res) => setTimeout(res, 2000));
            r = await hmi(`open ${t.state} ${t.applet}`);
        }
        log(`slot ${i}: open ${s.app || 'screen'} ${t.state} ${t.applet}: ${r}`);
    }
    function setSlot(i, s) {
        slots[i] = s;
        save();
        log(`slot ${i}: saved ${JSON.stringify(s)}`);
        flash[i] = Date.now() + 1000;
        drawSlot(i);
        setTimeout(() => drawSlot(i), 1050);
        push();
    }
    async function hold(i) {
        const r = await hmi('ctx'), mm = /^ok (-?\d+) (-?\d+)/.exec(r);
        if (!mm) { log(`slot ${i}: no screen to save (${r})`); drawSlot(i); return; }
        apps = installedApps(OAP);
        const c = classify(+mm[1], +mm[2], apps), was = describe(slots[i], apps);
        // a hold soon after this slot's BMW screen did not open, on a screen we don't know: that screen's own ids here
        if (Date.now() - failAt[i] < REPAIR_MS && !slots[i].app && !c.app && was.title !== 'BMW screen' &&
            !screenList().some((x) => x.state === c.state && x.applet === c.applet)) {
            learned[was.title] = { state: c.state, applet: c.applet };
            log(`slot ${i}: ${was.title} is ${c.state} ${c.applet} on this car`);
            failAt[i] = 0;
            if (notice && notice.slot === i) notice = null;
        }
        setSlot(i, c);
    }
    async function buttonTap(key) {
        const [seat, kind] = key.split('.'), k = state(key);
        const level = kind === 'wheel' ? seats.next(shown(key), k.max) : nextLevel(shown(key), k.max, settings.order);
        pending[key] = { level, until: Date.now() + PENDING_MS };
        setTimeout(() => seatChanged(true), PENDING_MS + 50);     // nothing back: show the car's level again
        drawButtonKey(key);
        if (st.backend === 'demo') { k.level = level; push(); return; }
        const line = kind === 'wheel' ? seats.request(st, 'wheel', null, level) : seats.request(st, seat, kind, level);
        const r = line ? await hmi(line) : 'error no climate service';
        log(`${key} -> ${level}: ${r}`);
    }
    const gestures = new Gestures(targetAt, (k) => { draw(k); return typeof k === 'number' ? tap(k) : buttonTap(k); }, hold);

    /* the control panel (the Overlays app): JSON lines; every change is pushed to every client */
    const clients = new Set();
    const has = (s) => ({ heat: s.heat.have, cool: s.cool.have });
    const status = () => ({ state: { settings, slots: slots.map((s) => describe(s, apps)),
        car: { backend: st.backend, seats: { driver: has(st.seats.driver), passenger: has(st.seats.passenger) }, wheel: st.wheel.have,
            mcar: mEff(), mfound: mcar, setups: m.sp21 ? 2 : 1 }, shift: sl.status(),
        notice: notice && Date.now() - notice.at < REPAIR_MS ? notice : null } });
    function push() { const l = JSON.stringify(status()) + '\n'; clients.forEach((c) => c.write(l)); }
    function targets() {
        apps = installedApps(OAP);
        const list = apps.filter((a) => a.tile && a.id !== SELF).map((a) => {
            const i = appInfo(a), ic = iconOf({ app: a.id }, apps);
            let pic = null;
            try { if (ic.file) pic = fs.readFileSync(ic.file).toString('base64'); } catch (e) { /* none */ }
            return i && Object.assign(i, { pic });
        }).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
        return { targets: { bmw: screenList().map((s) => ({ title: s.title, state: s.state, applet: s.applet, icon: s.icon })), apps: list } };
    }
    function request(c, q) {
        if (q.op === 'set') {
            const was = settings.shift.on;
            settings = mergeSettings(settings, q.settings);
            save(); redrawAll(); push();
            if (settings.shift.on !== was) sl.settings(); else sl.tick();
        } else if (q.op === 'slot' && Number.isInteger(q.i) && q.i >= 0 && q.i < 4 && slotOk(q.target)) {
            const t = q.target;
            setSlot(q.i, t.app ? { app: t.app, state: t.state, offset: t.offset } : { state: t.state, applet: t.applet });
        } else if (q.op === 'icon' && Number.isInteger(q.i) && q.i >= 0 && q.i < 4 && (q.icon === null || hmiIcons.known(q.icon))) {
            // the slot's picture: one of the head unit's icons, or null = its own again (a new target resets it too)
            const s = Object.assign({}, slots[q.i]);
            if (q.icon) s.icon = q.icon; else delete s.icon;
            setSlot(q.i, s);
        } else if (q.op === 'icons') {
            // the picker: a page (search q, page n) or the ids asked for (the slots' own), each with its PNG
            if (Array.isArray(q.ids)) {
                const items = q.ids.filter((id) => hmiIcons.known(id)).slice(0, 8).map((id) => ({ id, name: hmiIcons.nameOf(id) }));
                c.write(JSON.stringify({ icons: { ids: true, items: hmiIcons.withPics(items) } }) + '\n');
            } else {
                const p = hmiIcons.page(typeof q.q === 'string' ? q.q.slice(0, 40) : '', Number.isInteger(q.page) ? q.page : 0);
                p.items = hmiIcons.withPics(p.items);
                c.write(JSON.stringify({ icons: p }) + '\n');
            }
        } else if (q.op === 'reset') {
            slots = defaults();
            save(); redrawAll(); push();
        } else if (q.op === 'targets') {
            c.write(JSON.stringify(targets()) + '\n');
        } else c.write(JSON.stringify(status()) + '\n');    // 'get' and anything else
    }
    function serve() {
        try { fs.unlinkSync(CTL); } catch (e) { /* none yet */ }
        const srv = net.createServer((c) => {
            clients.add(c);
            let buf = '';
            c.setEncoding('utf8');
            c.on('data', (d) => {
                buf += d;
                if (buf.length > 65536) { c.destroy(); return; }
                for (let n; (n = buf.indexOf('\n')) >= 0; buf = buf.slice(n + 1)) {
                    let q;
                    try { q = JSON.parse(buf.slice(0, n)); } catch (e) { continue; }
                    if (q && typeof q === 'object') request(c, q);
                }
            });
            c.on('error', () => {});
            c.on('close', () => clients.delete(c));
            c.write(JSON.stringify(status()) + '\n');
        });
        srv.on('error', (e) => log('control socket: ' + e.message));
        srv.listen(CTL, () => { try { fs.chmodSync(CTL, 0o666); } catch (e) { log('control socket: ' + e.message); } });   // the app's own uid
    }

    gpu.mode('layer');
    gpu.place({ x: L.x, y: L.y, w: L.w, h: L.h, scale: 1, ox: 0, oy: 0 });
    L.slots.forEach((x, i) => gpu.pixmap(i + 1, SW, H, 'rgba', 'linear'));
    Object.keys(PIX).forEach((k) => gpu.pixmap(PIX[k], BW, H, 'rgba', 'linear'));
    /* boot (BOOT): hidden, claiming nothing, until AFTER_MS after the start with the HMI up; armed again after a sleep */
    function arm(why, since) {
        Object.assign(boot, { since, hmiAt: 0, up: false });
        gpu.show(false);
        claims();
        log(`boot: strip hidden (${why}) until ${Math.round(BOOT.AFTER_MS / 1000)} s after the start with the HMI up`);
    }
    function bootTick() {
        if (boot.up) return;
        if (!boot.hmiAt) hmi('ctx').then((r) => { if (!boot.hmiAt && /^ok -?\d+ -?\d+/.test(r)) { boot.hmiAt = Date.now(); log(`boot: HMI up (${r})`); } });
        const why = bootGate(Date.now(), boot);
        if (!why) return;
        boot.up = true;
        log(`boot: strip shown ${Math.round((Date.now() - boot.since) / 1000)} s after the start (${why})`);
        gpu.show(true);
        redrawAll();
    }
    gpu.on('ready', () => { log('renderer ready'); frame(); });
    gpu.on('touch', (phase, x) => {
        const before = gestures.pressed();
        gestures.touch(phase, x);
        if (gestures.pressed() !== before) [before, gestures.pressed()].forEach(draw);
    });
    gpu.on('closed', () => { if (boot.up) gpu.show(true); });   // a renderer without overlay_apps for us closes it on HMI touches
    redrawAll();
    subscribe();
    serve();
    setInterval(frame, 1000);                        // an app silent for 3 s is hidden
    setInterval(() => {                              // apps installed, updated or removed: new pictures
        apps = installedApps(OAP);
        slots.forEach((s, i) => { if (JSON.stringify(iconOf(s, apps)) !== looks[i] && settings.shortcuts) drawSlot(i); });
    }, 30000);
    setInterval(reread, REREAD_MS);
    setInterval(sl.tick, 500);
    let tickAt = Date.now();
    setInterval(() => {                              // the head unit slept (the car off): no M setup now
        const now = Date.now();
        if (now - tickAt >= WAKE_MS && (m.sp18 || m.setup)) { log(`woke up after ${Math.round((now - tickAt) / 1000)} s: no M setup`); mReset(m); }
        if (now - tickAt >= WAKE_MS) arm('woke up', now);   // a start after a sleep: its animation too
        tickAt = now;
    }, 5000);
    process.on('SIGTERM', () => { gpu.close(); sl.close(); if (child) child.kill(); process.exit(0); });
    arm('start', bootedAt());
    setInterval(bootTick, 1000);
    gpu.connect();
    log(`overlays: ${JSON.stringify(slots)} ${JSON.stringify(settings)}${st.backend === 'demo' ? ', seats: demo' : ''}`);
}

/* ---- self-check: node overlays.js --test ---- */
function test() {
    const assert = require('assert');
    // boot: black screen (no HMI), the animation (HMI up), 15 s after the start with the HMI up; no HMI: the timeout
    const b0 = { since: 0, hmiAt: 0 }, hmiUp = { since: 0, hmiAt: 4000 };
    assert.deepStrictEqual([bootGate(5000, b0), bootGate(10000, hmiUp), bootGate(14999, hmiUp), bootGate(15000, hmiUp), bootGate(30000, b0),
        bootGate(60000, b0)], [null, null, null, 'HMI up', null, 'timeout']);
    const apps = [{ id: 'iteriodev_cardash', appletId: 20097 }, { id: 'robertn_store', appletId: 20650 }];
    assert.deepStrictEqual(classify(3000, 23097, apps), { app: 'iteriodev_cardash', state: 3000, offset: 3000 });
    assert.deepStrictEqual(classify(5, 20650, apps), { app: 'robertn_store', state: 5, offset: 0 });
    assert.deepStrictEqual(classify(24, 34, apps), { state: 24, applet: 34 });
    assert.deepStrictEqual(classify(1, 21097, apps), { state: 1, applet: 21097 });        // the tile's id, not a screen
    assert.deepStrictEqual(target({ app: 'iteriodev_cardash', state: 3000, offset: 3000 }, [{ id: 'iteriodev_cardash', appletId: 20111 }]),
        { state: 3000, applet: 23111 });                                                 // reinstalled under a new id
    assert.strictEqual(target({ app: 'gone', state: 1, offset: 0 }, apps), null);
    assert.deepStrictEqual(iconOf({ state: 20000, applet: 4 }, []), { builtin: 'home' });
    assert.deepStrictEqual(iconOf({ state: 20, applet: 4 }, []), { builtin: 'apps' });
    assert.deepStrictEqual(iconOf({ state: 9, applet: 77 }, []), { builtin: 'screen' });
    assert.deepStrictEqual(iconOf({ app: 'gone', state: 1, offset: 0 }, []), { builtin: 'app', missing: true });
    assert.deepStrictEqual(describe({ state: 1, applet: 32 }, []), { kind: 'bmw', title: 'Navigation', icon: 'Navigation' });
    assert.deepStrictEqual(describe({ state: 9, applet: 77 }, []), { kind: 'bmw', title: 'BMW screen', icon: 'Display' });
    assert.deepStrictEqual(describe({ app: 'gone', state: 1, offset: 0 }, []), { kind: 'app', app: 'gone', title: 'gone', missing: true });
    // a head-unit icon picked for a slot: named for the app; a bad id from the file is dropped; one not on this head unit
    // (no folder here) draws the slot's own picture
    assert.deepStrictEqual(describe({ state: 1, applet: 32, icon: 'icon_Call_Filled' }, []),
        { kind: 'bmw', title: 'Navigation', icon: 'Navigation', hmiIcon: 'icon_Call_Filled', iconName: 'Call Filled' });
    assert.deepStrictEqual([cleanSlot({ state: 1, applet: 2, icon: '../x' }), cleanSlot({ state: 1, applet: 2, icon: 'icon_Spotify' })],
        [{ state: 1, applet: 2 }, { state: 1, applet: 2, icon: 'icon_Spotify' }]);
    assert.deepStrictEqual(iconOf({ state: 20000, applet: 4, icon: 'icon_Nope' }, []), { builtin: 'home' });
    // buttons: only what the car has and the settings allow, in the HMI's spots
    const keys = (st, set) => buttons(LAYOUT, st, set).map((b) => b.key + '@' + b.x).join(' ');
    const all = seats.state(true);
    assert.strictEqual(keys(all, SETTINGS), 'driver.wheel@20 driver.cool@222 driver.heat@864 passenger.cool@1844 passenger.heat@2486');
    const heatOnly = seats.state(false);
    heatOnly.seats.driver.heat.have = heatOnly.seats.passenger.heat.have = true;
    assert.strictEqual(keys(heatOnly, SETTINGS), 'driver.heat@864 passenger.heat@2486');
    assert.strictEqual(keys(all, mergeSettings(SETTINGS, { seats: false })), 'driver.wheel@20');
    assert.strictEqual(keys(all, mergeSettings(SETTINGS, { wheel: false, seats: 'no' })), 'driver.cool@222 driver.heat@864 passenger.cool@1844 passenger.heat@2486');
    // a right-hand drive car: the driver's buttons in the right-hand spots, the passenger's left, the wheel at the far right
    const rhd = mergeSettings(SETTINGS, { side: 'right' });
    assert.strictEqual(keys(all, rhd), 'driver.wheel@2740 driver.cool@1844 driver.heat@2486 passenger.cool@222 passenger.heat@864');
    assert.deepStrictEqual([spotSeat('driver', 'right'), spotSeat('passenger', 'right'), spotSeat('driver', 'left')], ['passenger', 'driver', 'driver']);
    assert.strictEqual(mergeSettings(rhd, { side: 'middle' }).side, 'right', 'a bad side: kept');
    // settings: known keys of the right kind only
    const s2 = mergeSettings(SETTINGS, { order: 'down', mmode: { m2: 'track', off: 'warp', on: false, boot: 1 }, extra: 1, shortcuts: 0,
        ambientHeat: 4, ambientCool: 13 });
    assert.deepStrictEqual(s2, { shortcuts: true, seats: true, wheel: true, ambient: true, ambientHeat: 4, ambientCool: 9, order: 'down', side: 'left',
        show: SETTINGS.show, mmode: { on: false, m1: 'sport', m2: 'track', off: 'road', boot: false, car: 'auto' },
        shift: shift.DEFAULTS });
    // per-button choice: 'on' shows what the car doesn't report, 'off' hides what it does (an M2 without ventilation that
    // reports it: the client's car, 2026-11-04); bad values are ignored
    const s3 = mergeSettings(SETTINGS, { show: { 'driver.cool': 'off', 'passenger.cool': 'off', 'driver.wheel': 'maybe', x: 'on' } });
    assert.strictEqual(keys(all, s3), 'driver.wheel@20 driver.heat@864 passenger.heat@2486');
    assert.strictEqual(keys(heatOnly, mergeSettings(SETTINGS, { show: { 'driver.wheel': 'on', 'passenger.heat': 'off' } })), 'driver.wheel@20 driver.heat@864');
    // the old master switches: off -> that group 'off', switches back on (the app no longer shows them); new files keep theirs
    const mg = migrate(mergeSettings(SETTINGS, { seats: false, wheel: true }), { seats: false, wheel: true });
    assert.deepStrictEqual([mg.seats, mg.wheel, mg.show['driver.heat'], mg.show['passenger.cool'], mg.show['driver.wheel']], [true, true, 'off', 'off', 'auto']);
    assert.strictEqual(migrate(mergeSettings(SETTINGS, { seats: false, show: {} }), { seats: false, show: {} }).seats, false);
    // M car: the user's choice wins over what was found
    const car = (c) => mergeSettings(SETTINGS, { mmode: { car: c } });
    assert.deepStrictEqual([mcarOf(false, car('auto')), mcarOf(true, car('auto')), mcarOf(false, car('yes')), mcarOf(true, car('no')), mcarOf(false, car('nope'))],
        [false, true, true, false, false]);
    // a tap that did nothing: the screen before and after the same and not the asked one
    const nav = { state: 1, applet: 32 };
    assert.deepStrictEqual([stuck('ok 20000 4', 'ok 20000 4', nav), stuck('ok 20000 4', 'ok 1 32', nav), stuck('ok 1 32', 'ok 1 32', nav),
        stuck('ok 20000 4', 'ok 2 23', nav), stuck('error timeout', 'ok 20000 4', nav)], [true, false, false, false, false]);
    // a screen learned under its name: the app offers it there, a slot with those ids is that screen, Restore uses it
    learned = { Navigation: { state: 7, applet: 91 } };
    assert.deepStrictEqual(describe({ state: 7, applet: 91 }, []), { kind: 'bmw', title: 'Navigation', icon: 'Navigation' });
    assert.deepStrictEqual(iconOf({ state: 7, applet: 91 }, []), { builtin: 'nav' });
    assert.deepStrictEqual(defaults()[1], { state: 7, applet: 91 });
    learned = {};
    assert.deepStrictEqual(defaults(), [{ state: 2, applet: 23 }, { state: 1, applet: 32 }, { state: 24, applet: 34 }, { state: 20, applet: 4 }]);
    assert.deepStrictEqual(mergeSettings(SETTINGS, { shift: { on: false, flash: 7000 } }).shift, { on: false, auto: true, start: 4500, flash: 7000, hud: true });
    assert.strictEqual(SETTINGS.order, 'up', 'defaults untouched');
    // taps: up 1 -> 2 -> 3 -> off, down 3 -> 2 -> 1 -> off
    assert.deepStrictEqual([0, 1, 2, 3].map((l) => nextLevel(l, 3, 'up')), [1, 2, 3, 0]);
    assert.deepStrictEqual([0, 3, 2, 1].map((l) => nextLevel(l, 3, 'down')), [3, 2, 1, 0]);
    // M setups, SP18 as the G82 sends them (2026-11-03 capture): entering M1 (double press, DSC off) = an EIN frame with
    // M1's settings and at once AUS; leaving (one press) = EIN with the normal settings and AUS: EIN toggles, AUS and
    // repeats within a second don't count
    const ms = { sp21: false };
    const ENTER = '01010302020202020000010001', LEAVE = '01010202010101010000010000', IDLE = '00000002000000000000000003';
    const CAR = '01000202010101010000010000', CAR2 = '01000002000000000000000003';   // EIN frames not from the M buttons
    assert.deepStrictEqual([mSetupOf(ms, 0x8001, IDLE, 0), mSetupOf(ms, 0x8001, CAR, 5000), mSetupOf(ms, 0x8001, ENTER, 15000),
        mSetupOf(ms, 0x8001, IDLE, 15010), mSetupOf(ms, 0x8001, ENTER, 15500), mSetupOf(ms, 0x8001, CAR2, 20000), mSetupOf(ms, 0x8001, CAR, 22000),
        mSetupOf(ms, 0x8001, LEAVE, 27000), mSetupOf(ms, 0x8001, IDLE, 27010), mSetupOf(ms, 0x8001, '02', 30000), mSetupOf(ms, 0x8001, '01', 31000)],
        [null, null, 1, null, null, null, null, 0, null, null, null]);
    // the car switched off in M1: the next press enters again (not leaving); VehicleCondition byte 5
    const mo = { sp21: false };
    assert.deepStrictEqual([mSetupOf(mo, 0x8001, ENTER, 1000), (mReset(mo), mSetupOf(mo, 0x8001, ENTER, 9000)), mSetupOf(mo, 0x8001, LEAVE, 12000)], [1, 1, 0]);
    assert.deepStrictEqual(['00000000000502', '00000000000a02', '00000000000202', '00000000000c02', ''].map(carOff), [true, false, true, false, false]);
    // ambient flash: off -> on only; heat / wheel 'heat', ventilation 'cool', heat wins; the colour only while it is on;
    // the menu's 3rd colour = byte 02
    const K = ['driver.wheel', 'driver.cool', 'driver.heat', 'passenger.cool', 'passenger.heat'];
    assert.deepStrictEqual([flashKind(K, [0, 0, 0, 0, 0], [0, 2, 0, 0, 0]), flashKind(K, [0, 0, 0, 0, 0], [0, 0, 0, 0, 3]),
        flashKind(K, [0, 0, 0, 0, 0], [1, 0, 0, 0, 0]), flashKind(K, [0, 0, 0, 0, 0], [0, 1, 0, 1, 2]),
        flashKind(K, [0, 1, 0, 0, 0], [0, 2, 0, 0, 0]), flashKind(K, [0, 0, 2, 0, 0], [0, 0, 0, 0, 0])], ['cool', 'heat', 'heat', 'heat', null, null]);
    assert.deepStrictEqual([ambientColour('00000602fffffa010001'), ambientColour('00000602fffffa000001'), ambientColour(''),
        ambientColour('rror service 0xb512.1 not there')], ['06', null, null, null]);
    assert.deepStrictEqual([AMBIENT.byte(SETTINGS.ambientHeat), AMBIENT.byte(SETTINGS.ambientCool), AMBIENT.byte(12)], ['02', '08', '0b']);
    assert.strictEqual(AMBIENT.set(AMBIENT.byte(3)), 'call 0xb512 1 26 1 0fff02ffffffff030303');
    // the cluster comes up: its first filled-in view counts once, again after 15 (not filled in)
    const kb = { up: false };
    assert.deepStrictEqual(['0f', '01', '01', '02', '0f', '0f', '02', '01', '00', '01'].map((h) => clusterUp(kb, h)),
        [null, 1, null, null, null, null, 2, null, null, 1]);
    // SP21 (0 none, 1 M1, 2 M2) is a state and wins once seen; other fields -> null
    assert.deepStrictEqual([mSetupOf(ms, 0x8018, '0201', 40000), mSetupOf(ms, 0x8001, ENTER, 50000), mSetupOf(ms, 0x8018, '00', 50000),
        mSetupOf(ms, 0x8018, '03', 50000), mSetupOf(ms, 0x8005, '01', 50000)], [2, null, 0, null, null]);
    // gestures: tap, hold, slide off, nothing; a button key taps but never holds
    let timers = [], ev = [];
    const T = { set: (f) => { timers.push(f); return f; }, clear: (f) => { timers = timers.filter((x) => x !== f); } };
    const at = (x) => (x < 150 ? 0 : x >= 650 && x < 800 ? 2 : x >= 2750 ? 'passenger.heat' : -1);
    const g = new Gestures(at, (i) => ev.push('tap' + i), (i) => ev.push('hold' + i), T);
    g.touch('down', 10); assert.strictEqual(g.pressed(), 0); g.touch('up', 12);
    g.touch('down', 700); timers.shift()(); g.touch('up', 700);
    g.touch('down', 10); g.touch('move', 400); g.touch('up', 10);
    g.touch('down', 400); g.touch('up', 400);
    g.touch('down', 2800); assert.strictEqual(timers.length, 0); g.touch('up', 2801);
    assert.deepStrictEqual(ev, ['tap0', 'hold2', 'tappassenger.heat']);
    // a button: off = white icon, no line; on = coloured icon + the accent line under the whole button
    const icon = { w: 10, h: 10, data: Buffer.alloc(400, 255) };
    const btn = (kind, level, max) => { const px = Buffer.alloc(LAYOUT.buttonW * LAYOUT.h * 4); drawButton(px, LAYOUT, kind, icon, level, false, max); return px; };
    const at4 = (px, x, y) => Array.from(px.slice((y * LAYOUT.buttonW + x) * 4, (y * LAYOUT.buttonW + x) * 4 + 4));
    const heatOn = btn('heat', 2, 3), coolOn = btn('cool', 1, 3), heatOff = btn('heat', 0, 3), wheelOn = btn('wheel', 1, 1);
    assert.deepStrictEqual(at4(heatOn, 0, LAYOUT.lineY), RED.concat(255), 'heat on: red line from the button\'s left');
    // the level: 3 segments of 36 px, 6 px apart (0-35, 42-77, 84-119); the gaps the bar's colour (the HMI's line hidden)
    assert.deepStrictEqual([at4(heatOn, 50, LAYOUT.lineY), at4(heatOn, 100, LAYOUT.lineY), at4(heatOn, 38, LAYOUT.lineY)],
        [RED.concat(255), DIM_SEG.concat(255), BAR_BG.concat(255)], 'heat 2 of 3: two red segments, one dim');
    assert.deepStrictEqual([at4(coolOn, 0, LAYOUT.lineY + 5), at4(coolOn, 60, LAYOUT.lineY)], [BLUE.concat(255), DIM_SEG.concat(255)], 'vent 1 of 3');
    assert.deepStrictEqual(at4(wheelOn, 60, LAYOUT.lineY), RED.concat(255), 'the wheel: one segment, the whole line');
    assert.deepStrictEqual(at4(heatOff, 0, LAYOUT.lineY), [0, 0, 0, 0], 'off: no line');
    assert.deepStrictEqual(at4(heatOn, 84, LAYOUT.iconY), RED.concat(255), 'heat icon right of the centre (60 + 24)');
    assert.deepStrictEqual(at4(heatOff, 84, LAYOUT.iconY).slice(3), [Math.round(255 * OFF_ALPHA)], 'off: white, dimmed');
    assert.deepStrictEqual(at4(coolOn, 84, LAYOUT.iconY), BLUE.concat(255), 'vent icon right of the centre too');
    assert.deepStrictEqual(at4(coolOn, 36, LAYOUT.iconY), [0, 0, 0, 0], '... not left of it');
    const p = pill(150, 120, 10, 20, 1);
    assert.strictEqual(p.data[(60 * 150 + 75) * 4 + 3], 255); assert.strictEqual(p.data[3], 0);
    seats.test();
    shift.test();
    console.log('overlays self-check ok');
}

if (process.argv[2] === '--test') test(); else main();
