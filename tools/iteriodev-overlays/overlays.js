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
 * layout? }. VM ids (2026-11-01): Media 2 23, Nav 1 32, Phone 24 34, All apps 20 4, Home 20000 4, Climate 3 517.
 *   node overlays.js          the service (OVERLAYS_SEAT_DEMO=1: seats without a car, for the VM)
 *   node overlays.js --test   the self-check (no car needed)
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const png = require('./png');
const seats = require('./seats');

const DATA = process.env.OVERLAYS_DATA || '/var/opt/iteriodev-overlays/slots.json';
const CTL = process.env.OVERLAYS_CTL || '/run/iteriodev-overlays/ctl.sock';
const OAP = process.env.OVERLAYS_OAP || '/var/opt/public/oap';
const CLIENT = process.env.MGU_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js';
const HMICTL = path.join(__dirname, 'hmictl');
const SELF = 'iteriodev_overlays';               // the control-panel app: not offered as a slot
const HOLD_MS = 1000, PENDING_MS = 3000, REREAD_MS = 60000;
const OFFSETS = [0, 3000];                   // an app's RHMI application against its appletId (oap-sdk)
// screen px. The M4's bar (screenshot 2026-11-02): temperatures 365-843 | 1987-2465, CLIMATE MENU 1386-1495. The HMI's
// seat buttons are 120 px wide, 21 px off a temperature: driver heat measured (864-983, its icon 24.5 px off the
// button's centre away from the temperature, the accent line at y 99-104 of the bar), the other spots by symmetry
const LAYOUT = { x: 0, y: 840, w: 2880, h: 120, slots: [1055, 1200, 1540, 1685], slotW: 140, buttonW: 120,
    buttons: { 'driver.wheel': 20, 'driver.cool': 224, 'driver.heat': 864, 'passenger.cool': 1846, 'passenger.heat': 2486 },
    iconY: 55, lineY: 99, lineH: 6 };
const AWAY = { wheel: -1, cool: -1, heat: 1 };   // which way a button's icon sits off its centre
const DEFAULTS = [{ state: 2, applet: 23 }, { state: 1, applet: 32 }, { state: 24, applet: 34 }, { state: 20, applet: 4 }];
// the BMW screens the app offers (a slot can hold any other one, saved by a hold): strip picture, the app's icon
const SCREENS = [
    { title: 'Media', state: 2, applet: 23, png: 'media', icon: 'Playlist' },
    { title: 'Navigation', state: 1, applet: 32, png: 'nav', icon: 'Navigation' },
    { title: 'Phone', state: 24, applet: 34, png: 'phone', icon: 'Smartphone' },
    { title: 'All apps', state: 20, applet: 4, png: 'apps', icon: 'Menu' },
    { title: 'Home', state: 20000, applet: 4, png: 'home', icon: 'MainMenu' },
    { title: 'Climate', state: 3, applet: 517, png: 'climate', icon: 'Fan' },
];
const RED = [255, 48, 49], BLUE = [29, 120, 223], WHITE = [255, 255, 255];   // the HMI's accent colours
const OFF_ALPHA = 0.6;
const MODES = ['road', 'sport', 'track'];
const SETTINGS = { shortcuts: true, seats: true, wheel: true, order: 'up', mmode: { on: true, m1: 'sport', m2: 'sport', off: 'road' } };
// MDrive 0xB51F, the active M setup: statusMConfigurationMDrive 0x8018 byte 0 (Hmi8's ...SP21: 0 none, 1 M1, 2 M2,
// 3 unset) or, older, statusMDriveTwo 0x8001 byte 0 (...SP18: statusMDrive2 0 off, 1 on); SP21 wins once seen
const MDRIVE = 0xb51f, MDRIVE_SUB = 'sub 0xb51f 1 1 1 0x8018 0x8001';

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
/* a slot -> its picture: { builtin: name } or { file } (+ missing for an app that is gone) */
function iconOf(slot, apps) {
    if (!slot.app) { const s = SCREENS.find((x) => x.state === slot.state && x.applet === slot.applet); return { builtin: s ? s.png : 'screen' }; }
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
/* an app's name (its package's productName) and the screen its tile opens (the lowest RHMI state; ids from 3000 =
 * the oap-sdk's offset, the AppletID is then appletId + 3000) */
function appInfo(a) {
    let title = a.id, state = null;
    try { title = JSON.parse(fs.readFileSync(path.join(a.dir, 'source', 'package.json'), 'utf8')).productName || title; } catch (e) { /* none */ }
    const ui = findFile(path.join(a.dir, 'rhmiData', 'uiDescriptions', 'ID8'), 'uiDescription.json', 1) ||
        findFile(path.join(a.dir, 'rhmiData'), 'uiDescription.json', 3);
    try {
        const c = JSON.parse(fs.readFileSync(ui, 'utf8')).containers || {};
        Object.keys(c).filter((k) => c[k].type === 'state').forEach((k) => { if (state === null || +k < state) state = +k; });
    } catch (e) { /* no description */ }
    return state === null ? null : { id: a.id, title, state, offset: state >= 3000 ? 3000 : 0 };
}
/* a slot as the app shows it */
function describe(slot, apps) {
    if (slot.app) {
        const a = apps.find((x) => x.id === slot.app), i = a && appInfo(a);
        return { kind: 'app', app: slot.app, title: i ? i.title : slot.app, missing: !a };
    }
    const s = SCREENS.find((x) => x.state === slot.state && x.applet === slot.applet);
    return { kind: 'bmw', title: s ? s.title : 'BMW screen', icon: s ? s.icon : 'Display' };
}
/* settings from the app (or the file): only known keys of the right kind; the rest stays */
function mergeSettings(cur, p) {
    const out = JSON.parse(JSON.stringify(cur));
    if (!p || typeof p !== 'object') return out;
    ['shortcuts', 'seats', 'wheel'].forEach((k) => { if (typeof p[k] === 'boolean') out[k] = p[k]; });
    if (p.order === 'up' || p.order === 'down') out.order = p.order;
    if (p.mmode && typeof p.mmode === 'object') {
        if (typeof p.mmode.on === 'boolean') out.mmode.on = p.mmode.on;
        ['m1', 'm2', 'off'].forEach((k) => { if (MODES.indexOf(p.mmode[k]) >= 0) out.mmode[k] = p.mmode[k]; });
    }
    return out;
}
const slotOk = (s) => s && Number.isInteger(s.state) &&
    (typeof s.app === 'string' ? OFFSETS.indexOf(s.offset) >= 0 : Number.isInteger(s.applet));
function loadData(file) {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') log('slots.json: ' + e.message + ', the defaults instead'); }
    const good = Array.isArray(j.slots) && j.slots.length === 4 && j.slots.every(slotOk);
    if (j.slots && !good) log('slots.json: not 4 good slots, the defaults instead');
    return { slots: good ? j.slots : DEFAULTS.map((s) => Object.assign({}, s)), layout: j.layout,
        settings: mergeSettings(SETTINGS, j.settings), mcar: j.mcar === true };
}
function saveData(file, data) {
    try { fs.mkdirSync(path.dirname(file)); } catch (e) { if (e.code !== 'EEXIST') throw e; }   // node 8: no recursive
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
}
/* an MDrive notification -> the active M setup (0 none, 1 M1 - SP18: an M setup on -, 2 M2), or null: not about
 * that, unset, or SP18 after SP21 was seen */
function mSetupOf(m, ev, hex) {
    const v = parseInt((hex || '').slice(0, 2), 16);
    if (ev === 0x8018 && v <= 2) { m.sp21 = true; return v; }
    if (ev === 0x8001 && !m.sp21 && v <= 1) return v;
    return null;
}
/* the next level of a tap: 1 -> 2 -> 3 -> off ('up'), or 3 -> 2 -> 1 -> off ('down') */
const nextLevel = (level, max, order) => (order === 'down' ? (level > 0 ? level - 1 : max) : seats.next(level, max));
/* the seat / wheel buttons to show: what the car has and the settings allow, [{ key, x }] */
function buttons(L, st, set) {
    const out = [];
    if (set.wheel && st.wheel.have) out.push({ key: 'driver.wheel', x: L.buttons['driver.wheel'] });
    if (set.seats) {
        for (const seat of seats.SEATS) {
            for (const kind of ['cool', 'heat']) if (st.seats[seat][kind].have) out.push({ key: `${seat}.${kind}`, x: L.buttons[`${seat}.${kind}`] });
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
function drawButton(px, L, kind, img, level, pressed) {
    const BW = L.buttonW, on = level > 0, rgb = kind === 'cool' ? BLUE : RED;
    if (pressed) blend(px, BW, 0, 0, pill(BW, L.h, 6, 16, 0.18), 1);
    if (img) {
        const cx = BW / 2 + 24.5 * AWAY[kind];
        blend(px, BW, Math.round(cx - img.w / 2), Math.round(L.iconY - img.h / 2), tint(img, on ? rgb : WHITE), on ? 1 : OFF_ALPHA);
    }
    if (on) blend(px, BW, 0, L.lineY, pill(BW, L.lineH, 0, 0, 1, rgb), 1);
}

/* ---- the service ---- */
function main() {
    const { RenderClient, imageOp } = require(CLIENT);
    const conf = loadData(DATA);
    const L = Object.assign({}, LAYOUT, conf.layout || {});
    let slots = conf.slots, settings = conf.settings, mcar = conf.mcar, apps = installedApps(OAP);
    const SW = L.slotW, H = L.h, BW = L.buttonW, ICON_MAX = 76, HMI_PX = 84;
    const pics = {}, flash = [0, 0, 0, 0], looks = [];
    const st = seats.state(!!process.env.OVERLAYS_SEAT_DEMO);
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
        try { saveData(DATA, Object.assign(conf.layout ? { layout: conf.layout } : {}, { slots, settings, mcar })); } catch (e) { log('save: ' + e.message); }
    };
    function drawSlot(i) {
        const ic = iconOf(slots[i], apps);
        looks[i] = JSON.stringify(ic);
        picture(ic, (img) => {
            const px = Buffer.alloc(SW * H * 4);
            const bg = flash[i] > Date.now() ? 0.4 : gestures.pressed() === i ? 0.18 : 0;
            if (bg) blend(px, SW, 0, 0, pill(SW, H, 10, 20, bg), 1);
            if (img) blend(px, SW, (SW - img.w) >> 1, (H - img.h) >> 1, img, ic.missing ? 0.4 : 1);
            gpu.pixels(i + 1, [{ x: 0, y: 0, w: SW, h: H }], px);
            frame();
        });
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
        picture({ builtin: kind === 'wheel' ? 'hmi-wheel' : `hmi-${kind}-${seat}` }, (img) => {
            const px = Buffer.alloc(BW * H * 4);
            drawButton(px, L, kind, img, shown(key), gestures.pressed() === key);
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
    function claims() {                               // the shortcuts and the buttons shown
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
        redrawAll();
        push();
    }
    function onEvent(line) {
        const w = line.split(' '), svc = parseInt(w[1], 16), ev = parseInt(w[2], 16);
        if (svc === MDRIVE) mSetup(ev, w[3]); else seatChanged(seats.apply(st, svc, ev, w[3]));
    }
    const m = { sp21: false, setup: 0 };
    function mSetup(ev, hex) {                        // a setup on (also already on at start) -> its mode, off -> 'off'
        const s = mSetupOf(m, ev, hex);
        if (s === null) return;
        if (!mcar || (m.sp21 && !m.told)) { mcar = true; m.told = m.sp21; save(); push(); }   // an M car: the app shows M Mode
        if (s === m.setup) return;
        m.setup = s;
        if (!settings.mmode.on) return;
        const mode = s === 0 ? settings.mmode.off : s === 1 ? settings.mmode.m1 : settings.mmode.m2;
        hmi(`mmode ${mode}`).then((r) => log(`M setup ${s} (0x${ev.toString(16)} ${hex}): mmode ${mode}: ${r}`));
    }
    function subscribe() {
        if (st.backend !== 'demo') seats.SUBS.forEach((l) => hmi(l));
        hmi(MDRIVE_SUB);
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
        let r = await hmi(`open ${t.state} ${t.applet}`);
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
        setSlot(i, classify(+mm[1], +mm[2], apps));
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
            mcar, setups: m.sp21 ? 2 : 1 } } });
    function push() { const l = JSON.stringify(status()) + '\n'; clients.forEach((c) => c.write(l)); }
    function targets() {
        apps = installedApps(OAP);
        const list = apps.filter((a) => a.tile && a.id !== SELF).map((a) => {
            const i = appInfo(a), ic = iconOf({ app: a.id }, apps);
            let pic = null;
            try { if (ic.file) pic = fs.readFileSync(ic.file).toString('base64'); } catch (e) { /* none */ }
            return i && Object.assign(i, { pic });
        }).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
        return { targets: { bmw: SCREENS.map((s) => ({ title: s.title, state: s.state, applet: s.applet, icon: s.icon })), apps: list } };
    }
    function request(c, q) {
        if (q.op === 'set') {
            settings = mergeSettings(settings, q.settings);
            save(); redrawAll(); push();
        } else if (q.op === 'slot' && Number.isInteger(q.i) && q.i >= 0 && q.i < 4 && slotOk(q.target)) {
            const t = q.target;
            setSlot(q.i, t.app ? { app: t.app, state: t.state, offset: t.offset } : { state: t.state, applet: t.applet });
        } else if (q.op === 'reset') {
            slots = DEFAULTS.map((s) => Object.assign({}, s));
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
    claims();
    gpu.show(true);
    gpu.on('ready', () => { log('renderer ready'); frame(); });
    gpu.on('touch', (phase, x) => {
        const before = gestures.pressed();
        gestures.touch(phase, x);
        if (gestures.pressed() !== before) [before, gestures.pressed()].forEach(draw);
    });
    gpu.on('closed', () => gpu.show(true));         // a renderer without overlay_apps for us closes it on HMI touches
    redrawAll();
    subscribe();
    serve();
    setInterval(frame, 1000);                        // an app silent for 3 s is hidden
    setInterval(() => {                              // apps installed, updated or removed: new pictures
        apps = installedApps(OAP);
        slots.forEach((s, i) => { if (JSON.stringify(iconOf(s, apps)) !== looks[i] && settings.shortcuts) drawSlot(i); });
    }, 30000);
    setInterval(reread, REREAD_MS);
    process.on('SIGTERM', () => { gpu.close(); if (child) child.kill(); process.exit(0); });
    gpu.connect();
    log(`overlays: ${JSON.stringify(slots)} ${JSON.stringify(settings)}${st.backend === 'demo' ? ', seats: demo' : ''}`);
}

/* ---- self-check: node overlays.js --test ---- */
function test() {
    const assert = require('assert');
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
    // buttons: only what the car has and the settings allow, in the HMI's spots
    const keys = (st, set) => buttons(LAYOUT, st, set).map((b) => b.key + '@' + b.x).join(' ');
    const all = seats.state(true);
    assert.strictEqual(keys(all, SETTINGS), 'driver.wheel@20 driver.cool@224 driver.heat@864 passenger.cool@1846 passenger.heat@2486');
    const heatOnly = seats.state(false);
    heatOnly.seats.driver.heat.have = heatOnly.seats.passenger.heat.have = true;
    assert.strictEqual(keys(heatOnly, SETTINGS), 'driver.heat@864 passenger.heat@2486');
    assert.strictEqual(keys(all, mergeSettings(SETTINGS, { seats: false })), 'driver.wheel@20');
    assert.strictEqual(keys(all, mergeSettings(SETTINGS, { wheel: false, seats: 'no' })), 'driver.cool@224 driver.heat@864 passenger.cool@1846 passenger.heat@2486');
    // settings: known keys of the right kind only
    const s2 = mergeSettings(SETTINGS, { order: 'down', mmode: { m2: 'track', off: 'warp', on: false }, extra: 1, shortcuts: 0 });
    assert.deepStrictEqual(s2, { shortcuts: true, seats: true, wheel: true, order: 'down', mmode: { on: false, m1: 'sport', m2: 'track', off: 'road' } });
    assert.strictEqual(SETTINGS.order, 'up', 'defaults untouched');
    // taps: up 1 -> 2 -> 3 -> off, down 3 -> 2 -> 1 -> off
    assert.deepStrictEqual([0, 1, 2, 3].map((l) => nextLevel(l, 3, 'up')), [1, 2, 3, 0]);
    assert.deepStrictEqual([0, 3, 2, 1].map((l) => nextLevel(l, 3, 'down')), [3, 2, 1, 0]);
    // M setups: SP18 (on = 1) until SP21 shows up (0 none, 1 M1, 2 M2), unset / unchanged / other fields -> null
    const ms = { sp21: false };
    assert.deepStrictEqual([mSetupOf(ms, 0x8001, '01000000'), mSetupOf(ms, 0x8001, '02'), mSetupOf(ms, 0x8018, '03')], [1, null, null]);
    assert.deepStrictEqual([mSetupOf(ms, 0x8018, '0201'), mSetupOf(ms, 0x8001, '00'), mSetupOf(ms, 0x8018, '00'), mSetupOf(ms, 0x8005, '01')],
        [2, null, 0, null]);
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
    const btn = (kind, level) => { const px = Buffer.alloc(LAYOUT.buttonW * LAYOUT.h * 4); drawButton(px, LAYOUT, kind, icon, level, false); return px; };
    const at4 = (px, x, y) => Array.from(px.slice((y * LAYOUT.buttonW + x) * 4, (y * LAYOUT.buttonW + x) * 4 + 4));
    const heatOn = btn('heat', 2), coolOn = btn('cool', 1), heatOff = btn('heat', 0);
    assert.deepStrictEqual(at4(heatOn, 0, LAYOUT.lineY), RED.concat(255), 'heat on: red line from the button\'s left');
    assert.deepStrictEqual(at4(coolOn, LAYOUT.buttonW - 1, LAYOUT.lineY + 5), BLUE.concat(255), 'vent on: blue line');
    assert.deepStrictEqual(at4(heatOff, 0, LAYOUT.lineY), [0, 0, 0, 0], 'off: no line');
    assert.deepStrictEqual(at4(heatOn, 84, LAYOUT.iconY), RED.concat(255), 'heat icon right of the centre (60 + 24.5)');
    assert.deepStrictEqual(at4(heatOff, 84, LAYOUT.iconY).slice(3), [Math.round(255 * OFF_ALPHA)], 'off: white, dimmed');
    assert.deepStrictEqual(at4(coolOn, 36, LAYOUT.iconY), BLUE.concat(255), 'vent icon left of the centre');
    const p = pill(150, 120, 10, 20, 1);
    assert.strictEqual(p.data[(60 * 150 + 75) * 4 + 3], 255); assert.strictEqual(p.data[3], 0);
    seats.test();
    console.log('overlays self-check ok');
}

if (process.argv[2] === '--test') test(); else main();
