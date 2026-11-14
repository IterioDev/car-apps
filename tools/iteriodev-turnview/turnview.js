'use strict';
/*
 * turnview.js - iteriodev-turnview: Turn View, the front camera in the iDrive 8 cluster widget (0.6.0: or iDrive 7's
 * central map area, Map view, as Waze on cluster) with navigation chevrons on the road and a turn card
 * (docs/superpowers/specs/2026-11-06-turn-view-design.md). Root service, Node 8. 0.6.0 (user 2026-11-14): the camera
 * also without a route; on iDrive 7 it hides Waze on cluster's map while on (camcluster's exclusive video layer),
 * which is back when Turn View is off or gone.
 *   hmictl serve (child)      Guidance 0xFB1A inst 128: conclusiveDart / guidanceStateWithReason (iDrive 7:
 *                             guidanceState) / guidingProvider (subscribed, getters once if silent; NAV: the ids per
 *                             iDrive), Vehicle2 0xB519 statusCarSpeed2 (getter, 5 a s)
 *   nav.js -> track.js        the next maneuver counted down with the speed -> a view, 10 a second
 *   scene.js                  the tool's cluster-render layers for the view (vendored cluster_render_client.js)
 *   mgu-camcluster (child)    --control stdin: `video on|off` in, `rect full ...` / `video ...` status lines out.
 *                             0.5.0 (user 2026-11-14): its one video layer only while the widget is shown (the whole
 *                             frame only), so nothing to give way to YouTube for any more (no claim file)
 *   where                     0.4.0 (user 2026-11-14): Turn View's own widget, target `turnview` ("Turn View AR" in the
 *                             cluster's widget menu: cluster-render.d/turnview.conf, a cluster-render drop-in read at
 *                             its next start) when cluster-render's hello lists it, else its `widget` ("Cluster
 *                             renderer"); iDrive 7 (backend id7): `map`, the whole target. camcluster starts with the
 *                             first hello, on that target, and moves with the layers when a later hello names another
 *                             one. No pop-up any more (an old saved `popup` setting is dropped)
 *   control socket            /run/iteriodev-turnview/ctl.sock (0666, JSON lines) for the app oap-turnview:
 *       -> { op: 'get' | 'reset' } | { op: 'set', settings } | { op: 'preview', cal } | { op: 'calib', on } | { op: 'camreq', state }
 *       <- { state: { settings, status } }   (pushed on every change, at most 4 a second)
 *   The app asks the camera ECU for the front view (its CameraProxy / ICAM2Proxy grants); the tool starts it in the
 *   background (`hmictl start iteriodev_turnview`) when the camera is wanted and the app is not connected.
 * Data: /var/opt/iteriodev-turnview/settings.json { enabled, cal { h, pitch, fov, yaw, x } }, rear-only (0.2.1: the
 * car has the rear camera alone, the widget says "No front camera" only until the front view works), turnview.log (1 MB, one
 * old file kept). Never stops a system service; the native parts are children, restarted with a growing delay when
 * they die young. Times are monotonic (the MGU sets its clock after boot).
 * Env (tests): TURNVIEW_DATA, TURNVIEW_CTL, TURNVIEW_HMICTL, TURNVIEW_CAMCLUSTER, TURNVIEW_CR_SOCKET, TURNVIEW_TICK_MS,
 * TURNVIEW_START_MS (app start retry), TURNVIEW_PASSED_MS, TURNVIEW_GEN (7 | 8; else by MainApp's folder, as
 * cluster-render's generation.cpp).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createNav, speedKmh, queryHex } = require('./nav');
const { createTrack } = require('./track');
const { createScene } = require('./scene');

const DATA = process.env.TURNVIEW_DATA || '/var/opt/iteriodev-turnview';
const CTL = process.env.TURNVIEW_CTL || '/run/iteriodev-turnview/ctl.sock';
const HMICTL = process.env.TURNVIEW_HMICTL || path.join(__dirname, 'hmictl');
const CAMCLUSTER = process.env.TURNVIEW_CAMCLUSTER || path.join(__dirname, 'mgu-camcluster');
const CR_SOCKET = process.env.TURNVIEW_CR_SOCKET || '/dev/shm/cluster-render/render.sock';
const TICK_MS = +process.env.TURNVIEW_TICK_MS || 100;
const START_MS = +process.env.TURNVIEW_START_MS || 30000;
const START_SOON_MS = +process.env.TURNVIEW_START_SOON_MS || 10000;   // (the app start while the MainApp starts up)
const CAMERA_UP = { waiting: true, decoding: true, stalled: true, refused: true };   // camcluster's decoder running
const APP_ID = 'iteriodev_turnview';
const CAM_FPS = 15;                         // camcluster --fps (1-30)
const CAM_RECT = '1320x640@400,136';        // camcluster --rect: its widget default (it knows no `turnview`)
// target -> where the driver finds it: the widget menu entry (iDrive 8), the cluster setting (iDrive 7)
const WIDGETS = { turnview: 'Turn View AR', widget: 'Cluster renderer', map: 'Map view' };
const SETTINGS = path.join(DATA, 'settings.json'), LOG = path.join(DATA, 'turnview.log');
const LOG_MAX = 1024 * 1024, PUSH_MS = 250, RESTART_MS = 5000, RESTART_MAX_MS = 60000, YOUNG_MS = 10000;
const SPEED_MS = 200, EVENTS_MS = 1000, NAV_SILENT_MS = 10000, BUSY_MS = 10000, KILL_MS = 2000;
const MAX_CLIENTS = 4, CLIENT_BUF = 65536, LINE_MAX = 65536;
const GEN = +process.env.TURNVIEW_GEN || (fs.existsSync('/usr/lib/oap-mainapp21') ? 8 : fs.existsSync('/usr/lib/oap-mainapp') ? 7 : 8);
// Guidance 0xFB1A major 7 on both; iDrive 7 (G20 catalogue v7.8, car-read 2026-11-14) has other ids and a plain
// guidanceState
const NAV = {
    8: { subs: ['sub 0xfb1a 128 7 24 0x8018', 'sub 0xfb1a 128 7 3 0x8003', 'sub 0xfb1a 128 7 23 0x8017'],
        getters: { dart: 'call 0xfb1a 128 30 7', state: 'call 0xfb1a 128 3 7', provider: 'call 0xfb1a 128 29 7' },
        events: { 0x8018: 'dart', 0x8003: 'state', 0x8017: 'provider' } },
    7: { subs: ['sub 0xfb1a 128 7 22 0x8016', 'sub 0xfb1a 128 7 2 0x8002', 'sub 0xfb1a 128 7 21 0x8015'],
        getters: { dart: 'call 0xfb1a 128 28 7', state: 'call 0xfb1a 128 2 7', provider: 'call 0xfb1a 128 27 7' },
        events: { 0x8016: 'dart', 0x8002: 'state', 0x8015: 'provider' } },
};
const { subs: SUBS, getters: GETTERS, events: EVENTS } = NAV[GEN === 7 ? 7 : 8];
const SPEED = 'call 0xb519 1 8 1';

const mono = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; };

/* a child (a .js one, the tests' fakes, under this node) -> the process, or null when it could not start; done(why)
 * is called once, whatever the way it ended (spawn error, exit, close) */
function child(p, args, log, done) {
    let c, ended = false;
    const end = (why) => { if (!ended) { ended = true; done(why); } };
    try {
        c = /\.js$/.test(p) ? spawn(process.execPath, [p].concat(args), { stdio: ['pipe', 'pipe', 'inherit'] })
            : spawn(p, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    } catch (e) { log(`${path.basename(p)}: ${e.message}`); setImmediate(() => end(e.message)); return null; }
    c.on('error', (e) => { log(`${path.basename(p)}: ${e.message}`); end(e.message); });
    c.on('close', (code, sig) => end(`exit ${code}${sig ? ` ${sig}` : ''}`));
    c.stdin.on('error', (e) => log(`${path.basename(p)}: ${e.message}`));   // it died with a line on its way (EPIPE)
    return c;
}
/* the delay before starting a child again: RESTART_MS, doubled up to RESTART_MAX_MS while it keeps dying young */
function backoff(st, now) {
    st.delay = now - st.startedAt < YOUNG_MS ? Math.min(RESTART_MAX_MS, (st.delay || RESTART_MS / 2) * 2) : RESTART_MS;
    return st.delay;
}
const stop = (c) => { if (!c) return; try { c.kill(); } catch (e) { /* gone */ } setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, KILL_MS); };

// ---- settings (pure; tests) ----
const DEFAULT_CAL = { h: 0.6, pitch: 3, fov: 60, yaw: 0, x: 0 };   // mgu-m4 front camera: the horizon near the middle (photo 2026-11-07)
const RANGE = { h: [0.3, 1.2], pitch: [0, 30], fov: [30, 120], yaw: [-10, 10], x: [-0.5, 0.5] };
/* cal values: p's where they are numbers, else cur's, else the default; each within its slider's range */
function clampCal(cur, p) {
    const out = {};
    Object.keys(RANGE).forEach((k) => {
        const ok = (o) => o && typeof o === 'object' && typeof o[k] === 'number' && isFinite(o[k]);
        const v = ok(p) ? p[k] : ok(cur) ? cur[k] : DEFAULT_CAL[k];
        out[k] = Math.min(RANGE[k][1], Math.max(RANGE[k][0], v));
    });
    return out;
}
function mergeSettings(cur, p) {
    const out = { enabled: cur && typeof cur.enabled === 'boolean' ? cur.enabled : true, cal: clampCal(cur && cur.cal) };
    if (!p || typeof p !== 'object') return out;
    if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
    if (p.cal) out.cal = clampCal(out.cal, p.cal);
    return out;
}

function main() {
    try { fs.mkdirSync(DATA); } catch (e) { /* there */ }
    function log(m) {
        const line = `${new Date().toISOString()} ${m}`;
        console.log(m);
        try { if (fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, `${LOG}.1`); } catch (e) { /* no file yet */ }
        try { fs.appendFileSync(LOG, `${line}\n`); } catch (e) { /* no data dir */ }
    }
    let settings = mergeSettings(null, null);
    try { settings = mergeSettings(JSON.parse(fs.readFileSync(SETTINGS, 'utf8')), null); } catch (e) { /* defaults */ }
    // (iDrive 7: the on / off switch is never remembered, only the calibration: below)
    const save = () => {
        const keep = GEN === 7 ? Object.assign({}, settings, { enabled: false }) : settings;
        try { fs.writeFileSync(`${SETTINGS}.new`, JSON.stringify(keep, null, 2)); fs.renameSync(`${SETTINGS}.new`, SETTINGS); } catch (e) { log(`settings: ${e.message}`); }
    };
    // no front camera on this car (the app's camreq 'rearonly': the ECU gave the rear camera alone, never the front) -
    // kept in a file so the widget says so at once after every start, with or without a route; gone as soon as the
    // front view works or camcluster decodes (its frames hold the front camera). 0.2.1: 0.2.0's file `nofront` was
    // guessed from a front view that did not come (wrong on a BMW XM with cameras): dropped, and app 1.1.0's
    // 'nofront' counts as 'refused'
    const NOFRONT = path.join(DATA, 'rear-only');
    try { fs.unlinkSync(path.join(DATA, 'nofront')); } catch (e) { /* none */ }
    let noFront = fs.existsSync(NOFRONT);
    // 0.7.0 iDrive 7 (user 2026-11-15): no widget menu to pick it, so it is off at every start of the car, whatever
    // was set before (never remembered), and the driver switches it on in the app; off it holds nothing (no camera
    // request, no video slot, the map area the stock map's / Waze's)
    if (GEN === 7) settings.enabled = false;
    log(`start: enabled ${settings.enabled}${GEN === 7 ? ' (iDrive 7: off at every start)' : ''}, cal ${JSON.stringify(settings.cal)}${noFront ? ', no front camera (saved)' : ''}`);

    const status = { camera: 'off', rect: null, route: 'none', provider: null, maneuver: null, cr: 'connecting', backend: null,
        nav: 'waiting', state: 'none', camreq: 'idle', noFront, widget: WIDGETS.widget };
    let crTarget = null;                                // the target, from cluster-render's hello (null: none yet)
    function setNoFront(on) {
        if (on === noFront) return;
        noFront = on; status.noFront = on; scene.noFront(on);
        try { if (on) fs.writeFileSync(NOFRONT, 'rear camera only\n'); else fs.unlinkSync(NOFRONT); } catch (e) { log(`rear-only: ${e.message}`); }
        log(on ? 'camera: this car has no front camera' : 'camera: the front camera works');
    }
    const nav = createNav({ log, now: mono, gen: GEN }), track = createTrack({ passedMs: +process.env.TURNVIEW_PASSED_MS || 0 });
    let calibBy = null, lastNavAt = 0;
    track.enabled(settings.enabled);

    // ---- cluster-render: the client keeps trying (also while the service is not installed yet) and makes every layer
    // again on each connection ----
    const { ClusterRender } = require('./cluster_render_client');
    const cr = new ClusterRender('iteriodev-turnview', CR_SOCKET), scene = createScene(cr, { log, now: mono });
    scene.setCal(settings.cal); scene.noFront(noFront); scene.disabled(!settings.enabled);
    cr.on('ready', () => {
        status.backend = cr.backend;
        status.cr = cr.backend === 'id8' || cr.backend === 'id7' ? 'connected' : 'unsupported';
        log(`cluster-render: backend ${cr.backend}, targets ${cr.targets} (head unit: iDrive ${GEN})`);
        // iDrive 7: the central map area; iDrive 8: Turn View's own widget when this cluster-render has it, else the
        // shared one. Another one than before: the layers and camcluster move (camcluster's end starts it again at once)
        const t = cr.backend === 'id7' ? 'map' : `,${cr.targets}`.indexOf(',turnview:') >= 0 ? 'turnview' : 'widget';
        if (t !== crTarget) {
            crTarget = t; status.widget = WIDGETS[t];
            scene.retarget(t);
            log(t === 'map' ? 'target map: the cluster\'s central map area (Map view)' : `target ${t}: "${status.widget}" in the cluster's widget menu`);
            if (cam) { try { cam.stdin.end(); } catch (e) { /* gone */ } } else camStart();
        }
        push();
    });
    cr.on('disconnected', () => { status.cr = 'not running'; push(); });
    cr.on('budget', (cap) => scene.budget(cap));
    cr.on('refused', (op, ref, reason) => log(`cluster-render refused ${op} (ref ${ref}): ${reason}`));
    cr.on('layer', (ref, state, reason) => { if (/error/.test(state)) log(`layer ${ref}: ${state} ${reason || ''}`); });
    cr.connect();
    setInterval(() => {                                    // not connected: not installed, or not up
        if (cr.ready) return;
        const s = process.platform === 'win32' || fs.existsSync(CR_SOCKET) ? 'not running' : 'missing';
        if (s !== status.cr) { status.cr = s; push(); }
    }, RESTART_MS);

    // ---- hmictl serve: one line out, one ok / error line back, in order; "ev" lines are notifications ----
    let hm = null, hmOut = '', busy = null, busyTimer = null, speedQueued = false, subscribedAt = 0, hmWait = null;
    const hmSt = { startedAt: 0, delay: 0 }, queue = [], seen = {};
    function hmi(line) { return new Promise((res) => { queue.push({ line, res }); pump(); }); }
    function hmStart() {
        hmSt.startedAt = mono();
        const c = child(HMICTL, ['serve'], log, (why) => {
            log(`hmictl ended (${why})`);
            if (hm === c) { hm = null; hmOut = ''; }
            clearTimeout(busyTimer);
            // what was asked is lost with it: everything queued is answered now (the subscriptions are made again on the
            // next start), so a crash loop never piles up commands
            const lost = busy ? [busy].concat(queue.splice(0)) : queue.splice(0);
            busy = null;
            lost.forEach((q) => q.res('error hmictl exited'));
            const d = backoff(hmSt, mono());
            hmWait = setTimeout(() => { hmWait = null; subscribe(); }, d);
        });
        if (!c) return false;
        hm = c;
        c.stdout.on('data', (d) => {
            hmOut += d;
            if (hmOut.length > LINE_MAX && hmOut.indexOf('\n') < 0) hmOut = '';      // not ours
            for (let n; (n = hmOut.indexOf('\n')) >= 0; hmOut = hmOut.slice(n + 1)) {
                const line = hmOut.slice(0, n).replace(/\r$/, '');
                if (line.startsWith('ev ')) onEvent(line); else if (/^(ok|error)\b/.test(line)) done(line);
            }
        });
        return true;
    }
    function pump() {
        if (busy || !queue.length || hmWait) return;
        if (!hm && !hmStart()) return;
        busy = queue.shift();
        busyTimer = setTimeout(() => { log(`hmictl: no answer to "${busy && busy.line}" in ${BUSY_MS} ms`); stop(hm); }, BUSY_MS);
        hm.stdin.write(`${busy.line}\n`);
    }
    function done(line) {
        clearTimeout(busyTimer);
        const b = busy; busy = null;
        if (b) b.res(line);
        pump();
    }
    function field(name, hex) {
        lastNavAt = mono();
        if (status.nav !== 'ok') { status.nav = 'ok'; push(); }
        if (nav.payload(name, hex)) seen[name] = true;     // seen once decoded: else its getter is asked
    }
    function onEvent(line) {
        const w = line.split(' '), svc = parseInt(w[1], 16), ev = parseInt(w[2], 16);
        if (svc === 0xfb1a && EVENTS[ev]) field(EVENTS[ev], w[3] || '');
    }
    function subscribe() {
        subscribedAt = mono();
        SUBS.forEach((l) => hmi(l));
        setTimeout(() => Object.keys(GETTERS).forEach((f) => {                // a field silent 2 s after subscribing
            if (seen[f]) return;
            hmi(GETTERS[f]).then((r) => { if (r.startsWith('ok ') && !seen[f]) field(f, r.slice(3).trim()); });
        }), 2000);
    }
    setInterval(() => {                                     // the speed, by its getter: each reply is fresh
        if (speedQueued || hmWait) return;
        speedQueued = true;
        hmi(SPEED).then((r) => {
            speedQueued = false;
            track.speed(r.startsWith('ok ') ? speedKmh(r.slice(3).trim()) : null, mono());
        });
    }, SPEED_MS);
    // CarPlay / Android Auto: the phone's maneuvers, asked of GuidanceEventList (no notifier without a view of our own);
    // in the options the dart was decoded with (the placeholder dart arrives first)
    let eventsQueued = false, queryOpts = null, query = '';
    setInterval(() => {
        const o = nav.opts();
        if (eventsQueued || hmWait || !o || nav.record().provider === 'BMW') return;
        if (o !== queryOpts) { queryOpts = o; query = `call 0xfb1b 128 4 5 ${queryHex(o, GEN)}`; }
        eventsQueued = true;
        hmi(query).then((r) => {
            eventsQueued = false;
            if (r.startsWith('ok ')) field('events', r.slice(3).trim());
        });
    }, EVENTS_MS);
    subscribe();

    // ---- mgu-camcluster: the video, as its status lines say ----
    let cam = null, camOut = '', videoOn = false, camTarget = null;
    const camSt = { startedAt: 0, delay: 0 };
    function camState(s) {
        if (status.camera === s) return;
        log(`camera: ${s}`); status.camera = s; scene.camera(s);
        if (s === 'decoding') setNoFront(false);
        push();
    }
    function camStart() {
        if (cam || !crTarget) return;                      // (one running, or no hello yet: the first one starts it)
        camSt.startedAt = mono();
        if (!fs.existsSync(CAMCLUSTER)) { camState('missing'); setTimeout(camStart, backoff(camSt, mono())); return; }
        // the widget picked in the cluster's widget menu (user 2026-11-06: only where it is picked)
        // 0.3.1 (user 2026-11-13): 15 pictures a second, not camcluster's 20: room for the head unit (~3 MB/s upload)
        camTarget = crTarget;
        // iDrive 7's map: the whole target, its size from the hello (map:WxH)
        const m = /(?:^|,)map:(\d+)x(\d+)/.exec(cr.targets || ''), rect = camTarget !== 'map' ? CAM_RECT : m ? `${m[1]}x${m[2]}@0,0` : '1088x480@0,0';
        const c = child(CAMCLUSTER, ['--control', 'stdin', '--target', camTarget, '--rect', rect, '--fps', String(CAM_FPS)], log, (why) => {
            log(`mgu-camcluster ended (${why})`);
            if (cam === c) { cam = null; camOut = ''; }
            if (camTarget !== crTarget) { camStart(); return; }   // stopped for the other widget: on it at once
            camState('restarting');
            setTimeout(camStart, backoff(camSt, mono()));
        });
        if (!c) return;
        cam = c;
        c.stdout.on('data', (d) => {
            camOut += d;
            if (camOut.length > LINE_MAX && camOut.indexOf('\n') < 0) camOut = '';
            for (let n; (n = camOut.indexOf('\n')) >= 0; camOut = camOut.slice(n + 1)) camLine(camOut.slice(0, n).replace(/\r$/, ''));
        });
        c.stdin.write(`video ${videoOn ? 'on' : 'off'}\n`);
    }
    function camLine(line) {                                // anything else on its stdout (a library's print) is ignored
        let m;
        if ((m = /^rect full (\d+)x(\d+)@(-?\d+),(-?\d+)$/.exec(line))) {   // 0.5.0: the whole frame only
            status.rect = 'full';
            scene.rect({ w: +m[1], h: +m[2], x: +m[3], y: +m[4] });
            push();
        } else if ((m = /^video (idle|waiting|decoding|stalled|off|refused)$/.exec(line))) camState(m[1]);   // 0.6.1: refused
    }
    function video(on) {
        if (on === videoOn) return;
        videoOn = on;
        log(`video ${on ? 'on' : 'off'}`);
        if (cam) cam.stdin.write(`video ${on ? 'on' : 'off'}\n`);
    }

    // ---- the app: started when the camera is wanted and it is not connected ----
    const clients = new Set();
    let startedAt = -Infinity;
    // 0.6.1 (G20, iDrive 7, 2026-11-14): AppStart 0xF9CA is the same service there, but for about the first minute
    // after a start of the head unit it is not offered yet or answers "no reply" / code 4 (UNKNOWN_ERROR): asked again
    // after START_SOON_MS; code 2 is iDrive 7's APP_ALREADY_RUNNING (its connection comes)
    function startApp() {
        if (clients.size || mono() - startedAt < START_MS) return;
        startedAt = mono();
        hmi(`start ${APP_ID}`).then((r) => {
            log(`app start: ${r}`);
            if (/code 1\b/.test(r)) startedAt += 9 * START_MS;     // APP_NOT_INSTALLED: asked again far less often
            else if (/not there|no reply|code 4\b/.test(r)) startedAt -= START_MS - START_SOON_MS;   // not ready yet
        });
    }

    // ---- the tick ----
    nav.on('change', (r) => {
        track.nav(r, mono());
        status.route = r.active ? 'active' : r.recalc ? 'recalculating' : 'none';
        status.provider = r.active || r.recalc ? r.provider : null;
        status.maneuver = r.kind ? { kind: r.kind, angle: r.angle, side: r.side, exit: r.exit, text: r.text } : null;
        push();
    });
    let lastState = '';
    setInterval(() => {
        const t = mono(), v = track.tick(t);
        if (v.state !== lastState) { log(`state ${lastState || '-'} -> ${v.state}`); lastState = v.state; status.state = v.state; push(); }
        if (status.nav === 'waiting' && t - subscribedAt > NAV_SILENT_MS && !lastNavAt) { status.nav = 'no navigation data'; push(); }
        if (status.cr === 'unsupported') return;              // not our cluster: nothing drawn
        scene.show(v, t);
        video(v.video);
        // the app (it asks the camera ECU for the front view) only while the camera is really wanted: the widget shown
        // (iDrive 8) or Turn View switched on (iDrive 7) - camcluster decoding, not merely the video allowed (0.7.0,
        // user 2026-11-15: never start in the background and take Drive Recorder's camera when not in use)
        if (v.video && CAMERA_UP[status.camera]) startApp();
    }, TICK_MS);

    // ---- the control socket ----
    let pushTimer = null, pushedAt = -Infinity;
    const stateMsg = () => `${JSON.stringify({ state: { settings, status } })}\n`;
    function send(c, m) {                                   // a client that does not read is dropped, not buffered for
        if (c.destroyed) return;
        if (c.bufferSize > CLIENT_BUF) { c.destroy(); return; }
        c.write(m);
    }
    function push() {
        if (pushTimer) return;
        const wait = Math.max(0, Math.min(PUSH_MS, PUSH_MS - (mono() - pushedAt)));
        pushTimer = setTimeout(() => {
            pushTimer = null; pushedAt = mono();
            const m = stateMsg();
            clients.forEach((c) => send(c, m));
        }, wait);
    }
    const applyCal = (c) => scene.setCal(c);
    function calibOff() { track.calib(false); calibBy = null; applyCal(settings.cal); }
    function request(c, q) {
        if (q.op === 'set') {
            const was = settings.enabled;
            settings = mergeSettings(settings, q.settings);
            save();
            // 0.3.2: off keeps the layers - the widget picked says "Turn View is off" (it was black: car 2026-11-14)
            if (settings.enabled !== was) { track.enabled(settings.enabled); scene.disabled(!settings.enabled); }
            if (!calibBy) applyCal(settings.cal);
            push();
        } else if (q.op === 'preview') {
            applyCal(clampCal(settings.cal, q.cal));
        } else if (q.op === 'calib') {
            if (q.on === true) { track.calib(true); calibBy = c; } else calibOff();
            push();
        } else if (q.op === 'reset') {
            settings = mergeSettings(settings, { cal: DEFAULT_CAL });
            save(); applyCal(settings.cal); push();
        } else if (q.op === 'camreq' && typeof q.state === 'string') {
            status.camreq = q.state === 'nofront' ? 'refused' : q.state.slice(0, 20); scene.camreq(status.camreq);
            if (status.camreq === 'rearonly' && status.camera !== 'decoding') setNoFront(true);
            else if (status.camreq === 'on') setNoFront(false);
            push();
        } else send(c, stateMsg());                       // 'get' and anything else
    }
    try { fs.unlinkSync(CTL); } catch (e) { /* none yet */ }
    const srv = net.createServer((c) => {
        if (clients.size >= MAX_CLIENTS) { c.destroy(); return; }
        clients.add(c);
        log(`control: a client connected (${clients.size})`);   // (the app, or a test tool: when the app came)
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (d) => {
            buf += d;
            if (buf.length > LINE_MAX) { c.destroy(); return; }
            for (let n; (n = buf.indexOf('\n')) >= 0; buf = buf.slice(n + 1)) {
                let q;
                try { q = JSON.parse(buf.slice(0, n)); } catch (e) { continue; }
                if (q && typeof q === 'object') request(c, q);
            }
        });
        c.on('error', () => {});
        c.on('close', () => {
            clients.delete(c);
            log(`control: a client left (${clients.size})`);
            if (calibBy === c) { log('app gone while calibrating: saved calibration back'); calibOff(); push(); }
            // no app: nobody asks the camera any more (its "refused" would make the next handover read No camera at once)
            if (!clients.size && status.camreq !== 'idle') { status.camreq = 'idle'; scene.camreq('idle'); }
        });
        send(c, stateMsg());
    });
    srv.on('error', (e) => log(`control socket: ${e.message}`));
    srv.listen(CTL, () => { try { fs.chmodSync(CTL, 0o666); } catch (e) { /* a pipe on the PC */ } });

    const quit = () => { try { if (cam) cam.stdin.end(); } catch (e) { /* gone */ } stop(hm); process.exit(0); };
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
}

if (require.main === module) main();
module.exports = { mergeSettings, clampCal, backoff, DEFAULT_CAL, RANGE };
