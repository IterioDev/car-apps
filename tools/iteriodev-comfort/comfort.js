'use strict';
/*
 * comfort.js - iteriodev-comfort: the root service behind the Ambient Light and Seats apps on iDrive 8 (Node 8).
 *   ambient   any colour on the interior ambient light, per zone, through the body controller (ambient.js); only
 *             while the car's own ambient light is on (ComfortFunctionIuK 0xB512 status, mode byte); written again
 *             every 2 minutes (each write lasts 254 s), handed back to the car's colour when switched off
 *   seats     hold-to-move, three memories per front seat and the Gentleman function (passenger seat out of the way
 *             and back), through the seat modules (seat.js); the Gentleman parked only (standing, as easy exit
 *             below), hold-to-move and memories also while driving (user 2026-11-08)
 *   easy exit (0.3.0, user 2026-11-08) the driver's own Exit position (the seat + the electric steering column when the
 *             car has one, seat.js 'wheel'; the driver's memories keep the column too): the driver door opening while
 *             the car stands keeps where the driver sat and moves to Exit; the driver door closed with the ignition or
 *             the engine on (whichever comes last; 0.3.1, user: not everyone wears the belt) moves back there.
 *             Stands = under 2 km/h; no fresh speed: the engine under 1000 rpm; neither: the car off. Both moves only
 *             while it stands. Door: DoorsWindowsRoofMirrors 0x5530 ev 0x8001 / 0x8006 byte 2 (1 open), events only;
 *             ignition / engine: VehicleCondition test / ready to drive / driving (events); rpm: CDS 0xB513 getter 25
 *             (x 0.25, 400 rpm or more = running), asked only while the speed getter gives nothing. No polling for
 *             the door or the ignition, nothing polled on the BDC (0.3.2, user: no poll spam, as the old SET
 *             button poll): the column is read once at the start and while it moves. NOT car-tested.
 * All UDS goes through the head unit's diagnostic gateway on one `hmictl serve` (uds.js).
 * Control socket /run/iteriodev-comfort/ctl.sock, JSON lines in and out; every change is pushed to every client:
 *   {op:'get'}  {op:'ambient', settings:{on, rgb:[r,g,b], bright 5-100, follow, zones:{dash:{rgb}|{off:true}|null}}}
 *   {op:'jog', seat:'driver'|'passenger', axis:'SLV'|'SHV'|'LNV'|'SNV'|'KHV', dir:1|-1}   (again every 300 ms while held)
 *   {op:'stop'}  {op:'memory', seat, slot:0-2, save:true|false}  {op:'gentleman'}  (out of the way, again: back)
 *   {op:'exit', save:true|false}  (save: the driver's seat + column as they are = Exit; else: to Exit now, as the door)
 *   {op:'set', settings:{easyExit:true|false}}
 * Data /var/opt/iteriodev-comfort/data.json { ambient, memories:{driver:[3], passenger:[3]}, room, exit, pre, settings }.
 *   node comfort.js           the service
 *   node comfort.js --test    the modules' self-checks
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const uds = require('./uds');
const amb = require('./ambient');
const seat = require('./seat');

const DATA = process.env.COMFORT_DATA || '/var/opt/iteriodev-comfort/data.json';
const CTL = process.env.COMFORT_CTL || '/run/iteriodev-comfort/ctl.sock';
const HMICTL = process.env.COMFORT_HMICTL || path.join(__dirname, 'hmictl');   // tests: a .js stand-in, run with this Node
const SPEED_SUB = 'sub 0xb519 1 1 1 0x8008', SPEED_GET = 'call 0xb519 1 8 1', SPEED_FRESH_MS = 3000;
const AMB_SUB = 'sub 0xb512 1 1 1 0x8003', AMB_GET = 'call 0xb512 1 3 1';
const RPM_GET = 'call 0xb513 1 25 1';
const DOOR_SUB = 'sub 0x5530 1 1 1 0x8001 0x8006';
const STOP_SPEED = 2 * 64, STOP_RPM = 1000 * 4, RUN_RPM = 400 * 4;   // raw: speed 1/64 km/h (V_VEH_COG), rpm x 0.25
// VehicleCondition: shown to the apps (the car switched on or not)
const VCOND_SUB = 'sub 0x1531 1 1 2 0x8002';                 // no getter: its notifications only
const carOn = (hex) => [7, 8, 10].indexOf(parseInt((hex || '').slice(10, 12), 16)) >= 0;   // test / ready to drive / driving
const log = (m) => console.log(m);

function load() {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { /* first start */ }
    const obj = (o) => (o && typeof o === 'object' ? o : null), mem = (a) => [0, 1, 2].map((i) => obj(a && a[i]));
    return { ambient: amb.settings(d.ambient), memories: { driver: mem(d.memories && d.memories.driver),
        passenger: mem(d.memories && d.memories.passenger) }, room: d.room || null, exit: obj(d.exit), pre: obj(d.pre),
        settings: { easyExit: !(d.settings && d.settings.easyExit === false) } };
}
function save(d) {
    try {
        try { fs.mkdirSync(path.dirname(DATA)); } catch (e) { /* there already (Node 8: no recursive) */ }
        fs.writeFileSync(DATA + '.tmp', JSON.stringify(d));
        fs.renameSync(DATA + '.tmp', DATA);
    } catch (e) { log('save: ' + e.message); }
}


function main() {
    const data = load();
    /* hmictl serve: one line out, one line back, in order; "ev" lines are notifications */
    let child = null, out = '', busy = null, busyTimer = null;
    const queue = [];
    const hmi = (line) => new Promise((res) => { queue.push({ line, res }); pump(); });
    function pump() {
        if (busy || !queue.length) return;
        if (!child) {
            child = /\.js$/.test(HMICTL) ? spawn(process.execPath, [HMICTL, 'serve'], { stdio: ['pipe', 'pipe', 'inherit'] })
                : spawn(HMICTL, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
            child.on('error', (e) => log('hmictl: ' + e.message));
            child.stdin.on('error', (e) => log('hmictl: ' + e.message));
            child.stdout.on('data', (d) => {
                out += d;
                for (let n; (n = out.indexOf('\n')) >= 0; out = out.slice(n + 1)) {
                    const line = out.slice(0, n);
                    if (line.startsWith('ev ')) onEvent(line); else if (/^(ok|error)\b/.test(line)) done(line);
                }
            });
            child.on('exit', (c) => {
                log('hmictl exited ' + c); child = null; out = '';
                if (busy) done('error hmictl exited');
                setTimeout(subscribe, 2000);
            });
        }
        busy = queue.shift();
        busyTimer = setTimeout(() => { if (child) child.kill(); }, 10000);
        child.stdin.write(busy.line + '\n');
    }
    function done(line) { clearTimeout(busyTimer); const b = busy; busy = null; if (b) b.res(line); pump(); }

    const diag = new uds.Uds(hmi, log);
    const car = { speed: null, speedAt: 0, rpm: null, rpmAt: 0, ambientOn: null, on: false, door: null };
    const cond = (hex) => { const on = carOn(hex); if (on !== car.on) { car.on = on; log(`car ${on ? 'on' : 'off'} (${hex})`); push(); back(); } };
    // stands: under 2 km/h; no fresh speed: the engine under 1000 rpm (idle or off); neither: the car switched off
    const fresh = (t) => Date.now() - t < SPEED_FRESH_MS;
    const parked = () => (fresh(car.speedAt) ? car.speed < STOP_SPEED : fresh(car.rpmAt) ? car.rpm < STOP_RPM : !car.on);
    const u16 = (k) => (hex) => { const v = parseInt((hex || '').slice(0, 4), 16); if (v >= 0 && v !== 0xffff) { car[k] = v; car[k + 'At'] = Date.now(); } };
    const speed = u16('speed'), rpm = u16('rpm');
    // the driver door: its changes only (a state seen first - a restart with the door open - moves nothing)
    function door(hex) {
        const v = parseInt((hex || '').slice(4, 6), 16), was = car.door;
        if (v !== 0 && v !== 1) return;
        car.door = v === 1;
        if (was === null || was === car.door) return;
        log(`driver door ${car.door ? 'open' : 'closed'}`);
        if (car.door) easyExit(false);
        back();
    }
    // back to the driving position: the driver door closed with the ignition or the engine on, whichever comes last
    let ready = false;
    function back() {
        const r = car.door === false && (car.on || (fresh(car.rpmAt) && car.rpm >= RUN_RPM));
        if (r && !ready) { log('driver door closed, car on'); easyBack(); }
        ready = r;
    }
    function ambientStatus(hex) {
        const on = (hex || '').length >= 16 ? parseInt(hex.slice(14, 16), 16) === 1 : null;
        if (on !== car.ambientOn) { car.ambientOn = on; log(`car ambient light: ${on ? 'on' : 'off'} (${hex})`); light(true); push(); }
    }
    function onEvent(line) {
        const w = line.split(' '), svc = parseInt(w[1], 16), ev = parseInt(w[2], 16);
        if (svc === uds.SVC) diag.onEvent(svc, ev, w[3]);
        else if (svc === 0xb519 && ev === 0x8008) speed(w[3]);
        else if (svc === 0xb512 && ev === 0x8003) ambientStatus(w[3]);
        else if (svc === 0x1531 && ev === 0x8002) cond(w[3]);
        else if (svc === 0x5530 && (ev === 0x8001 || ev === 0x8006)) door(w[3]);
    }
    function subscribe() {
        [uds.SUB, SPEED_SUB, AMB_SUB, VCOND_SUB, DOOR_SUB].forEach((l) => hmi(l));
        hmi(AMB_GET).then((r) => { if (r.startsWith('ok ')) ambientStatus(r.slice(3)); });
    }

    /* ---- ambient ---- */
    let mods = null, oem = {}, lit = false, writing = false, again = false, litAt = 0;
    async function discover() {
        const found = [];
        let missed = 0;
        for (const b of amb.BUSES) {
            try { found.push.apply(found, amb.parse(await diag.send(amb.BDC, 0x22, b.read), b.name)); } catch (e) { missed++; log(`ambient ${b.name}: ${e.message}`); }
        }
        // the car's own brightness, before ours: a module's first reading only (renewals read our own back)
        found.forEach((m) => { if (m.bright && oem[amb.key(m)] === undefined) oem[amb.key(m)] = m.bright; });
        // a bus that did not answer (the BDC busy right after a start, mgu-m4 2026-11-07): asked again in 20 s
        if (missed) setTimeout(() => { mods = null; light(true); }, 20000);
        mods = amb.split(found);                     // a zone with two kinds of light (line above, decor below): two parts
        log(`ambient: ${mods.length} modules: ${mods.map((m) => `${m.bus}.${m.nad} ${m.name} (${m.zone})`).join(', ')}`);
        push();
    }
    /* A drag across the colour bars sends a new colour every 250 ms: the BDC gets at most one round per GAP_MS (the
     * first at once, the last always), only the modules whose bytes changed, and the file is written once it rests. */
    const GAP_MS = 500, SAVE_MS = 2000;
    const sent = {};                                  // module -> the bytes it got last
    let roundAt = 0, force = false, lightTimer = null, saveTimer = null;
    function lightSoon() {
        if (lightTimer) return;                       // the round already waiting reads the newest settings
        lightTimer = setTimeout(() => { lightTimer = null; light(); }, Math.max(0, roundAt + GAP_MS - Date.now()));
    }
    const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(data), SAVE_MS); };
    async function light(renew) {                     // apply the settings; a call while writing runs once more after
        if (renew) force = true;
        if (writing) { again = true; return; }
        writing = true;
        try {
            do {
                again = false;
                const wait = roundAt + GAP_MS - Date.now();
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
                roundAt = Date.now();
                if (!mods) await discover();
                const want = data.ambient.on && car.ambientOn === true, all = force;
                force = false;
                if (!want && !lit) break;
                for (const x of amb.plan(mods, want ? data.ambient : amb.settings(data.ambient, { on: false }), oem)) {
                    const b = x.off ? amb.release(x.m) : amb.frame(x.m, x.rgb, x.bright), k = amb.key(x.m), h = b.join(',');
                    if (!all && sent[k] === h) continue;
                    try { await diag.send(amb.BDC, 0x2e, b); sent[k] = h; } catch (e) { log(`ambient ${k}: ${e.message}`); }
                }
                if (all || want !== lit) litAt = Date.now();   // the last round that wrote every module
                lit = want;
            } while (again);
        } finally { writing = false; }
    }

    /* ---- seats ---- */
    const mover = new seat.Mover(diag, parked, log, () => push());
    let busyJob = null;                               // 'memory' / 'gentleman' / 'exit' / 'back' while one runs
    async function job(name, fn) {
        if (busyJob) { mover.halt(); return; }        // a second press stops it
        busyJob = name; push();
        try { log(`${name}: ${JSON.stringify(await fn())}`); } catch (e) { log(`${name}: ${e.message}`); }
        busyJob = null; push();
    }
    const AUTO = ['exit', 'back'];                    // the door's: they stop whatever runs first
    async function auto(name, fn) {
        if (busyJob) { mover.halt(); while (busyJob) await new Promise((r) => setTimeout(r, 50)); }
        return job(name, fn);
    }

    /* ---- easy exit: the driver's seat + the steering column (when electric) ---- */
    const hasWheel = async () => (mover.hasWheel === null ? mover.probeWheel() : mover.hasWheel);
    async function driverPos() {                      // where the driver sits: the seat's counters + the column's
        const p = Object.assign({}, await mover.read('driver'));
        if (await hasWheel()) p.wheel = Object.assign({}, await mover.read('wheel'));
        return p;
    }
    /** to a saved driver position: the seat, then the column (wheelFirst: the column first, out of the way) */
    async function driverTo(p, wheelFirst, parkedOnly) {
        const steps = [() => mover.recall('driver', p, parkedOnly),
            async () => (p.wheel && (await hasWheel()) ? mover.recall('wheel', p.wheel) : 'done')];
        if (wheelFirst) steps.reverse();
        for (const s of steps) { const r = await s(); if (r !== 'done') return r; }
        return 'done';
    }
    // out of the way (the door, or the app's Exit): the driving position kept until the way back - a
    // second door opening before that keeps the first one
    function easyExit(manual) {
        if (!data.exit || (!manual && !data.settings.easyExit)) return;
        if (!parked()) { log('easy exit: the car is not standing'); return; }
        auto('exit', async () => {
            if (!data.pre) { data.pre = await driverPos(); save(data); push(); }
            return driverTo(data.exit, true, true);
        });
    }
    function easyBack() {
        if (!data.pre) return;
        if (!parked()) { log('easy exit back: the car is not standing'); return; }
        auto('back', async () => {
            const r = await driverTo(data.pre, false, true);
            if (r === 'done') { data.pre = null; save(data); push(); }
            return r;
        });
    }
    // parked only, both ways (a mistaken tap while driving with a front passenger); a press while one runs still stops it
    const gentleman = () => (!busyJob && !parked() ? log('gentleman: not parked') : job('gentleman', async () => {
        if (data.room) { const r = await mover.recall('passenger', data.room, true); if (r === 'done') { data.room = null; save(data); } return r; }
        const r = await mover.room();
        if (r.why === 'done') { data.room = r.was; save(data); }
        return r.why;
    }));


    /* ---- the apps ---- */
    const clients = new Set();
    const status = () => ({ state: {
        parked: parked(), carOn: car.on, ambient: { settings: data.ambient, carOn: car.ambientOn, lit,
            modules: (mods || []).map((m) => ({ id: amb.key(m), name: m.name, zone: m.zone, fault: m.fault })) },
        seats: { pos: mover.pos, moving: mover.motion ? { seat: mover.motion.seat, axis: mover.motion.axis } : null, job: busyJob,
            memories: data.memories, roomOut: !!data.room, wheel: mover.hasWheel === true, exit: !!data.exit, pre: !!data.pre },
        settings: data.settings } });
    let pushTimer = null;
    function push() {                                 // coalesced: a move pushes every counter read
        if (pushTimer) return;
        pushTimer = setTimeout(() => { pushTimer = null; const l = JSON.stringify(status()) + '\n'; clients.forEach((c) => c.write(l)); }, 100);
    }
    function request(c, q) {
        const seatOk = q.seat === 'driver' || q.seat === 'passenger';
        if (q.op === 'ambient') { data.ambient = amb.settings(data.ambient, q.settings); saveSoon(); lightSoon(); push(); }
        else if (q.op === 'jog' && seatOk && seat.AXES.indexOf(q.axis) >= 0 && (q.dir === 1 || q.dir === -1)) {
            if (!busyJob) mover.jog(q.seat, q.axis, q.dir);
        } else if (q.op === 'stop') mover.halt();
        else if (q.op === 'memory' && seatOk && [0, 1, 2].indexOf(q.slot) >= 0) {
            const m = data.memories[q.seat], drv = q.seat === 'driver';   // the driver's: the column too
            if (q.save) (drv ? driverPos() : mover.read(q.seat)).then((p) => { m[q.slot] = p; save(data); push(); }).catch((e) => log('memory: ' + e.message));
            else if (m[q.slot]) job('memory', () => (drv ? driverTo(m[q.slot]) : mover.recall(q.seat, m[q.slot])));
        } else if (q.op === 'exit') {
            if (q.save) driverPos().then((p) => { data.exit = p; save(data); push(); }).catch((e) => log('exit: ' + e.message));
            else easyExit(true);
        } else if (q.op === 'set' && q.settings && typeof q.settings.easyExit === 'boolean') {
            data.settings.easyExit = q.settings.easyExit; save(data); push();
        } else if (q.op === 'gentleman') gentleman();
        else c.write(JSON.stringify(status()) + '\n');
    }
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
        // the app gone: nothing it started keeps moving (the door's moves run without it)
        c.on('close', () => { clients.delete(c); if (!clients.size && AUTO.indexOf(busyJob) < 0) mover.halt(); });
        c.write(JSON.stringify(status()) + '\n');
    });
    srv.on('error', (e) => log('control socket: ' + e.message));
    srv.listen(CTL, () => { try { fs.chmodSync(CTL, 0o666); } catch (e) { log('control socket: ' + e.message); } });

    subscribe();
    const poll = (l, fn) => hmi(l).then((r) => { if (r.startsWith('ok ')) fn(r.slice(3)); });
    setInterval(() => {                               // HU getters, not the BDC; rpm only while no speed comes
        poll(SPEED_GET, speed);
        if (!fresh(car.speedAt)) poll(RPM_GET, (h) => { rpm(h); back(); });
    }, 2000);
    setInterval(() => { if (lit && Date.now() - litAt > amb.RENEW_MS) light(true); }, 10000);
    setTimeout(() => {
        ['driver', 'passenger'].forEach((s) => mover.read(s).catch((e) => log(`${s} seat: ${e.message}`)));
        mover.probeWheel();
        light(true);
    }, 3000);
    process.on('SIGTERM', () => {                     // hand the ambient light back, stop any move, then go
        mover.halt();
        const end = () => { if (child) child.kill(); process.exit(0); };
        if (!lit || !mods) return end();
        Promise.all(mods.map((m) => diag.send(amb.BDC, 0x2e, amb.release(m)).catch(() => {}))).then(end);
        setTimeout(end, 3000);
    });
    log(`comfort: ${JSON.stringify(data.settings)} ambient ${JSON.stringify(data.ambient)}`);
}

if (process.argv.includes('--test')) {
    const { execFileSync } = require('child_process');
    ['uds.js', 'ambient.js', 'seat.js'].forEach((f) => process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, f), '--test'])));
    console.log('comfort ok');
} else main();
