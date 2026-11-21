'use strict';
/*
 * comfort.js - iteriodev-comfort: the root service behind the Ambient Light and Seats apps on iDrive 8 (Node 8).
 *   ambient   any colour on the interior ambient light, per zone, through the body controller (ambient.js); only
 *             while the car's own ambient light is on (ComfortFunctionIuK 0xB512 status, mode byte) and someone is in
 *             the car (VehicleCondition: not parked / standby - 0.5.1, issue #17: lights on after locking); written
 *             again every 2 minutes (each write lasts 254 s), handed back to the car's colour when switched off
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
 *             0.4.0 (user 2026-11-09): the passenger seat too, its own Exit position; its door (byte 3) and the seat
 *             sensor (SeatInformation 0x1030 ev 0x8001, events only): the door opening moves a seat out only with
 *             someone in it, never with a child seat on it; the passenger's way back = its door shut with someone
 *             seated (no sensor news: the car on, as the driver). Both doors at once: one seat after the other.
 *   0.4.0 fixes (user 2026-11-09: "controls 15 s late on a lot of cars", "only half the way back"): a getter of a
 *             service the car lacks held hmictl's one-at-a-time queue up 3 s each, every 2 s - they piled up in front of
 *             every seat request; now getters wait behind the UDS requests, never two of one, and a failing one rests a
 *             minute. A slow gateway read as an end stop half way (seat.js), and a seat module pausing its motors
 *             (engine start) ended the axis: two more tries. Seats with motors but no position (D700: electric seats,
 *             memory on the driver's side only) move while held, no memory / Easy exit / Make room.
 *   drive modes 0.5.0 (user 2026-11-09): a colour per drive mode (ambient.js MODES), switched with it while the drive
 *             modes are on: the mode's colour in every zone (our colour on), a mode without one: the settings as they
 *             are. The mode: FES 0xB50D notifier 0x8025, and its getter 37 read every second by hmictl's own poll thread
 *             (a head-unit getter on the MGU's signal gateway, nothing asked on the bus; FES notifiers did not run for
 *             Car Data). NOT car-tested.
 *   0.6.0 (issues #19 / #24 / #28 / #29, user 2026-11-13): seat moves smoother and recalls precise (seat.js); a seat
 *             module that does not answer is asked again when an app opens and told to the app (seats.found); easy exit:
 *             a column that cannot move (not calibrated, no answer) no longer stops the seat; where the seat sat is kept
 *             again only when nobody moved it since our last move (seats.out: else an old place came back); the way back
 *             on the car switching on waits ON_SETTLE_MS (the seat module holds its motors then) and a way back that
 *             stood short keeps the place for the next try. Log also in comfort.log beside the data (the journal is
 *             gone within minutes).
 *   0.6.1 (issue #42; PRs #38 #39 #44 #45 by dino15309): without a fresh speed or rpm the car stands only when
 *             VehicleCondition said parked / standby / residing with a valid qualifier (it was "not on": true before any
 *             signal, so Make room / easy exit could run while driving on a car whose head unit sends none); a stop
 *             (SIGTERM) waits for the seat STOPs and the ambient hand-back (up to 20 s); STOPs go first in the UDS queue;
 *             each subscription's answer is logged (which signals this car's head unit has).
 *   0.6.2 (2026-11-19, customer M8: the ambient light's writes unanswered, lin 2 silent): {op:'diag'} - support reads
 *             and test writes through this service's own TASU session (diagAllowed).
 *   0.6.3 (same car): the lights looked for once at the start also with our colour off (zones listed again); a bus
 *             read waited for up to 15 s and a refused one (no lights on it) not asked again - the 3 s timeout left the
 *             BDC busy and the first writes after it unanswered, every 20 s (car read: writes work once it is free).
 * All UDS goes through the head unit's diagnostic gateway on one `hmictl serve` (uds.js).
 * Control socket /run/iteriodev-comfort/ctl.sock, JSON lines in and out; every change is pushed to every client:
 *   {op:'get'}  {op:'ambient', settings:{on, rgb:[r,g,b], bright 5-100, follow, zones:{dash:{rgb}|{off:true}|null},
 *               modes:{on, rgb:{<mode 1-10>:[r,g,b]|null}}}}
 *   {op:'jog', seat:'driver'|'passenger', axis:'SLV'|'SHV'|'LNV'|'SNV'|'KHV', dir:1|-1}   (again every 300 ms while held)
 *   {op:'stop'}  {op:'memory', seat, slot:0-2, save:true|false}  {op:'gentleman'}  (out of the way, again: back)
 *   {op:'exit', seat, save:true|false}  (save: the seat (+ the driver's column) as it is = its Exit; else: there now;
 *               no seat: the driver's)
 *   {op:'set', settings:{easyExit:true|false}}
 *   {op:'diag', id, target, sid, data:[bytes], ms}  (0.6.2, support: a UDS request through this service's own TASU
 *               session - a second session beside it restarted a head unit, 2026-11-19; diagAllowed(): any read
 *               22 to the BDC, the seats and the column, and only the self-reverting ambient writes 2E DA5E / E3D1)
 *               -> {diag:{id, ok, uds:'hex'} | {id, ok:false, error, code}}
 * Data /var/opt/iteriodev-comfort/data.json { ambient, memories:{driver:[3], passenger:[3]}, room, exit:{driver, passenger},
 * pre:{driver, passenger}, out:{driver, passenger} (where our last easy exit move left it), settings } (0.3.x: exit / pre
 * the driver's alone, read as the driver's).
 *   node comfort.js           the service
 *   node comfort.js --test    the modules' self-checks
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const uds = require('./uds');
const READ_MS = 15000;          // 0.6.3: an ambient bus read (the BDC polls its LIN lights first)

/* 0.6.2 {op:'diag'}: reads (22 + a 2-byte DID) to the BDC 0x40 and the seat modules 0x6D / 0x6E; writes only the
 * ambient light's per-module colour (2E DA5E / E3D1 + 7 bytes: NAD, on, brightness, R, G, B, seconds <= 254 - the
 * module returns to the car's colour by itself) */
function diagAllowed(q) {
    const d = q && q.data;
    if (!q || !Array.isArray(d) || !d.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return false;
    // 0.6.6: any read (22 + a 2-byte DID, any unit) - another tool's reads (boost, battery %, the VIN) go through
    // this one session instead of a second TASU client beside ours; writes stay the ambient light's only
    if (q.sid === 0x22) return Number.isInteger(q.target) && q.target > 0 && q.target <= 0xff && d.length === 2;
    return q.sid === 0x2e && q.target === 0x40 && d.length === 9 && ((d[0] === 0xda && d[1] === 0x5e) || (d[0] === 0xe3 && d[1] === 0xd1));
}
const amb = require('./ambient');
const seat = require('./seat');

const DATA = process.env.COMFORT_DATA || '/var/opt/iteriodev-comfort/data.json';
const CTL = process.env.COMFORT_CTL || '/run/iteriodev-comfort/ctl.sock';
const HMICTL = process.env.COMFORT_HMICTL || path.join(__dirname, 'hmictl');   // tests: a .js stand-in, run with this Node
const SPEED_SUB = 'sub 0xb519 1 1 1 0x8008', SPEED_GET = 'call 0xb519 1 8 1', SPEED_FRESH_MS = 3000;
const AMB_SUB = 'sub 0xb512 1 1 1 0x8003', AMB_GET = 'call 0xb512 1 3 1';
const RPM_GET = 'call 0xb513 1 25 1';
const FES_SUB = 'sub 0xb50d 1 1 1 0x8025', FES_POLL = 'poll 0xb50d 1 37 1 1000 0x8025';   // the drive mode
const DOOR_SUB = 'sub 0x5530 1 1 1 0x8001 0x8006', DOOR_BYTE = { driver: 2, passenger: 3 };   // statusDoorSwitchDRD / PSD, 1 open
// SeatInformation seatOccupancyStatusForEachSeat (events only): relativeSeatLocation 1 the driver's, 3 the passenger's
const OCC_SUB = 'sub 0x1030 1 1 1 0x8001', REL_SEAT = { 1: 'driver', 3: 'passenger' };
const OCC = { 0: 'empty', 1: 'a person', 2: 'a child seat, child in', 3: 'a child seat', 4: 'a thing', 5: 'not empty', 6: 'none', 7: 'unknown', 8: 'a child seat, empty', 9: 'error' };
const SEATS = ['driver', 'passenger'];
const per = (f) => ({ driver: f('driver'), passenger: f('passenger') });
const STOP_SPEED = 2 * 64, STOP_RPM = 1000 * 4, RUN_RPM = 400 * 4;   // raw: speed 1/64 km/h (V_VEH_COG), rpm x 0.25
// VehicleCondition: shown to the apps (the car switched on or not)
const VCOND_SUB = 'sub 0x1531 1 1 2 0x8002';                 // no getter: its notifications only
const carOn = (hex) => [7, 8, 10].indexOf(parseInt((hex || '').slice(10, 12), 16)) >= 0;   // test / ready to drive / driving
// statusConditionVehicle: someone in the car (WOHNEN, test, ready to drive, driving, ending it) or not (PARKEN, STANDFUNKTIONEN:
// locked and left). Our ambient colour only while someone is in it (issue #17: it stayed on after locking, each renewal
// holding the lights 254 s while the head unit stayed awake); not told yet: as before
const COND = { 1: 'parked', 2: 'parked', 3: 'standby, nobody in the car', 5: 'residing', 7: 'test', 8: 'ready to drive', 10: 'driving', 12: 'ending ready to drive' };
const IN_CAR = [5, 7, 8, 10, 12];
const ON_SETTLE_MS = 2000;                                     // the way back on the car switching on: after this
const NEAR = 32;                                               // counts: a seat where our move left it (easy exit)
// the log also in a file beside the data (0.6.0): the car's journal keeps only minutes; 256 KB, then one old file
const LOG_FILE = path.join(path.dirname(DATA), 'comfort.log');
const log = (m) => {
    console.log(m);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (e) { /* none yet */ }
    try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${m}\n`); } catch (e) { /* no folder yet */ }
};

function load() {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { /* first start */ }
    const obj = (o) => (o && typeof o === 'object' ? o : null), mem = (a) => [0, 1, 2].map((i) => obj(a && a[i]));
    // { driver, passenger }; 0.3.x kept the driver's alone
    const bySeat = (o) => (o && ('driver' in o || 'passenger' in o) ? per((s) => obj(o[s])) : { driver: obj(o), passenger: null });
    return { ambient: amb.settings(d.ambient), memories: { driver: mem(d.memories && d.memories.driver),
        passenger: mem(d.memories && d.memories.passenger) }, room: d.room || null, exit: bySeat(d.exit), pre: bySeat(d.pre),
        out: per((s) => obj(d.out && d.out[s])), settings: { easyExit: !(d.settings && d.settings.easyExit === false) } };
}
const mkdir = () => { try { fs.mkdirSync(path.dirname(DATA)); } catch (e) { /* there already (Node 8: no recursive) */ } };
function save(d) {
    try {
        mkdir();
        fs.writeFileSync(DATA + '.tmp', JSON.stringify(d));
        fs.renameSync(DATA + '.tmp', DATA);
    } catch (e) { log('save: ' + e.message); }
}


function main() {
    mkdir();
    const data = load();
    let shuttingDown = false, transportClosed = false;
    const SHUTDOWN_LIMIT_MS = 20000;
    /* hmictl serve: one line out, one line back, in order; "ev" lines are notifications. low: a getter, sent only
     * when no UDS request / subscription waits (hmictl holds a call to a service the car lacks up 3 s) */
    let child = null, out = '', busy = null, busyTimer = null;
    const queue = [], lowQueue = [];
    const hmi = (line, low, cleanup) => new Promise((res) => {
        if (transportClosed || (shuttingDown && (!cleanup || !child))) { res('error service shutting down'); return; }
        (low ? lowQueue : queue).push({ line, res, cleanup: cleanup === true }); pump();
    });
    function pump() {
        if (transportClosed) return;
        if (shuttingDown) {
            [queue, lowQueue].forEach(q => {
                for (let i = q.length - 1; i >= 0; i--) if (!q[i].cleanup) q.splice(i, 1)[0].res('error service shutting down');
            });
            if (!child) return; // never respawn a helper while stopping
        }
        if (busy || !(queue.length || lowQueue.length)) return;
        if (!child) {
            child = /\.js$/.test(HMICTL) ? spawn(process.execPath, [HMICTL, 'serve'], { stdio: ['pipe', 'pipe', 'inherit'] })
                : spawn(HMICTL, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
            child.on('error', (e) => { resetStanding(); log('hmictl: ' + e.message); });
            child.stdin.on('error', (e) => { resetStanding(); log('hmictl: ' + e.message); });
            child.stdout.on('data', (d) => {
                out += d;
                for (let n; (n = out.indexOf('\n')) >= 0; out = out.slice(n + 1)) {
                    const line = out.slice(0, n);
                    if (line.startsWith('ev ')) onEvent(line); else if (/^(ok|error)\b/.test(line)) done(line);
                }
            });
            child.on('exit', (c) => {
                resetStanding();
                log('hmictl exited ' + c); child = null; out = '';
                if (busy) done('error hmictl exited');
                if (!shuttingDown) setTimeout(subscribe, 2000);
            });
        }
        busy = queue.length ? queue.shift() : lowQueue.shift();
        busyTimer = setTimeout(() => { if (child) child.kill(); }, 10000);
        child.stdin.write(busy.line + '\n');
    }
    function done(line) { clearTimeout(busyTimer); const b = busy; busy = null; if (b) b.res(line); pump(); }
    // a getter: low priority, never two of one waiting, and one that fails (a service this car lacks) left alone for a
    // minute - piled up behind each other they held every seat control up ~15 s (0.3.3, user 2026-11-09)
    const polls = {};
    function poll(l, fn) {
        if (shuttingDown) return;
        const p = polls[l] || (polls[l] = { busy: false, until: 0 });
        if (p.busy || Date.now() < p.until) return;
        p.busy = true;
        hmi(l, true).then((r) => {
            p.busy = false;
            if (r.startsWith('ok ')) fn(r.slice(3));
            else { p.until = Date.now() + 60000; log(`${l}: ${r} (again in a minute)`); }
        });
    }

    const diag = new uds.Uds(hmi, log);
    const car = { speed: null, speedAt: 0, rpm: null, rpmAt: 0, ambientOn: null, on: false, mode: null, cond: null,
        door: { driver: null, passenger: null }, occ: { driver: null, passenger: null } };
    // A known off/standing condition is a fallback, not the default false car.on.
    // Condition notifications may be change-only: retain it until invalidated,
    // changed explicitly, or the helper connection is lost; no short expiry timer.
    let conditionStanding = false;
    function resetStanding() { conditionStanding = false; car.speedAt = car.rpmAt = 0; }
    const inCar = () => car.cond === null || IN_CAR.indexOf(car.cond) >= 0;
    const cond = (hex) => {
        const v = parseInt((hex || '').slice(10, 12), 16);
        conditionStanding = typeof hex === 'string' && /^[0-9a-f]{14}$/i.test(hex) &&
            parseInt(hex.slice(12, 14), 16) === 2 && [1, 2, 3, 5].indexOf(v) >= 0;
        if (COND[v] && v !== car.cond) {
            const was = inCar();
            car.cond = v; log(`car ${COND[v]} (${hex})`);
            if (inCar() !== was) { light(true); push(); }
        }
        const on = carOn(hex);
        if (on === car.on) return;
        car.on = on; log(`car ${on ? 'on' : 'off'} (${hex})`); push(); SEATS.forEach((s) => back(s, true));
        if (on) SEATS.filter((s) => !mover.axes(s).length).forEach((s) => mover.probe(s, true));   // a seat asleep at the start
    };
    // Preserve speed/RPM policy; absent readings need an explicitly valid off/standing condition.
    const fresh = (t) => t > 0 && Date.now() >= t && Date.now() - t < SPEED_FRESH_MS;
    const parked = () => (fresh(car.speedAt) ? car.speed < STOP_SPEED : fresh(car.rpmAt) ? car.rpm < STOP_RPM : conditionStanding);
    const u16 = (k) => (hex) => { const v = parseInt((hex || '').slice(0, 4), 16); if (v >= 0 && v !== 0xffff) { car[k] = v; car[k + 'At'] = Date.now(); } };
    const speed = u16('speed'), rpm = u16('rpm');
    // the front doors: their changes only (a state seen first - a restart with a door open - moves nothing)
    function door(hex) {
        SEATS.forEach((s) => {
            const v = parseInt((hex || '').substr(2 * DOOR_BYTE[s], 2), 16), was = car.door[s];
            if (v !== 0 && v !== 1) return;
            car.door[s] = v === 1;
            if (was === null || was === car.door[s]) return;
            log(`${s} door ${car.door[s] ? 'open' : 'closed'}`);
            if (car.door[s]) easyExit(s, false);
            back(s);
        });
    }
    // who sits in the front seats (SeatInformation: ArrayD = u32 byte length, then per seat its absolute and relative
    // place, the occupancy, a confidence)
    function occupancy(hex) {
        const end = 8 + 2 * (parseInt((hex || '').slice(0, 8), 16) || 0);
        for (let i = 8; i + 8 <= Math.min(end, hex.length); i += 8) {
            const s = REL_SEAT[parseInt(hex.substr(i + 2, 2), 16)], v = parseInt(hex.substr(i + 4, 2), 16);
            if (!s || v === car.occ[s]) continue;
            car.occ[s] = v;
            log(`${s} seat: ${OCC[v] || v}`);
            back(s);
        }
    }
    const person = (s) => car.occ[s] === 1, childSeat = (s) => [2, 3, 8].indexOf(car.occ[s]) >= 0;
    const known = (s) => [0, 1, 2, 3, 4, 8].indexOf(car.occ[s]) >= 0;   // else: no seat sensor news, the doors alone
    // back to where it sat, whichever comes last: its door closed and - the driver - the ignition or the engine on,
    // - the passenger - someone in the seat (not told: the car on, as the driver); never with a child seat on it.
    // switchedOn: the car just switched on (its seat modules hold the motors a moment: the way back waits ON_SETTLE_MS)
    const ready = { driver: false, passenger: false };
    function back(s, switchedOn) {
        const on = car.on || (fresh(car.rpmAt) && car.rpm >= RUN_RPM);
        const r = car.door[s] === false && !childSeat(s) && (known(s) ? person(s) && (s === 'passenger' || on) : on);
        if (r && !ready[s]) { log(`${s} door closed, ${known(s) && s === 'passenger' ? 'seated' : 'car on'}`); easyBack(s, switchedOn ? ON_SETTLE_MS : 0); }
        ready[s] = r;
    }
    function ambientStatus(hex) {
        const on = (hex || '').length >= 16 ? parseInt(hex.slice(14, 16), 16) === 1 : null;
        if (on !== car.ambientOn) { car.ambientOn = on; log(`car ambient light: ${on ? 'on' : 'off'} (${hex})`); light(true); push(); }
    }
    function driveMode(hex) {
        const v = amb.driveMode(hex);
        if (v === null || v === car.mode) return;
        car.mode = v; log(`drive mode ${amb.MODES[v] || v} (${hex})`); lightSoon(); push();
    }
    function onEvent(line) {
        const w = line.split(' '), svc = parseInt(w[1], 16), ev = parseInt(w[2], 16);
        if (svc === uds.SVC) diag.onEvent(svc, ev, w[3]);
        else if (shuttingDown) return;
        else if (svc === 0xb519 && ev === 0x8008) speed(w[3]);
        else if (svc === 0xb512 && ev === 0x8003) ambientStatus(w[3]);
        else if (svc === 0x1531 && ev === 0x8002) cond(w[3]);
        else if (svc === 0x5530 && (ev === 0x8001 || ev === 0x8006)) door(w[3]);
        else if (svc === 0x1030 && ev === 0x8001) occupancy(w[3]);
        else if (svc === 0xb50d && ev === 0x8025) driveMode(w[3]);
    }
    function subscribe() {
        if (shuttingDown) return;
        [uds.SUB, SPEED_SUB, AMB_SUB, VCOND_SUB, DOOR_SUB, OCC_SUB, FES_SUB, FES_POLL].forEach((l) =>
            hmi(l).then((r) => log(`${l}: ${r}`)));   // 0.6.1 (issue #42): which signals this head unit has
        poll(AMB_GET, ambientStatus);
    }

    /* ---- ambient ---- */
    let mods = null, oem = {}, lit = false, writing = false, again = false, litAt = 0, missedAt = 0;
    // 0.6.5 (customer M8 2026-11-20): a light can report a fault while the car is off (both front footwells "faulty" all
    // boot, clean when read later): a fault from the search is read again once, FAULT_MS after the lights are on
    const FAULT_MS = 30000;
    let faultChecked = true, faultTimer = null;
    async function recheckFaults() {
        faultTimer = null;
        if (shuttingDown || faultChecked || !mods || !lit) return;
        faultChecked = true;
        for (const b of amb.BUSES.filter((x) => mods.some((m) => m.fault && m.bus === x.name))) {
            let fresh;
            try { fresh = amb.parse(await diag.send(amb.BDC, 0x22, b.read, READ_MS), b.name); } catch (e) {
                log(`ambient ${b.name} fault check: ${e.message}`); continue;
            }
            fresh.forEach((f) => mods.filter((m) => amb.key(m) === amb.key(f) && (m.fault || f.fault)).forEach((m) => {
                log(`ambient ${amb.key(m)} ${m.name}: ${f.fault ? `fault (${(f.faults || []).join(', ')})` : 'no fault now'}`);
                m.fault = f.fault; m.faults = f.faults;
            }));
        }
        push();
    }
    async function discover() {
        if (shuttingDown) return;
        const found = [];
        let missed = 0;
        for (const b of amb.BUSES) {
            // 0.6.3 (customer M8 2026-11-19): a bus read can take ~9 s (pending) and end in a refusal (7F 22 10: no
            // layering lights on that bus) - waited for, so the BDC is free for the writes after it (the 3 s timeout
            // left it busy: the first writes went unanswered, every 20 s); a refusal is an answer, not asked again
            // 0.6.7 (customer M8 2026-11-21): uds.js's timeout carries code 'timeout' - it is no answer, not a refusal
            // (0.6.4-0.6.6 counted it as "none": 0 modules for the whole boot, never looked for again)
            try { found.push.apply(found, amb.parse(await diag.send(amb.BDC, 0x22, b.read, READ_MS), b.name)); } catch (e) {
                const silent = e.code === undefined || e.code === 'timeout';
                if (silent) missed++;
                log(`ambient ${b.name}: ${silent ? e.message : `none (${e.message})`}`);
            }
        }
        // the car's own brightness, before ours: a module's first reading only (renewals read our own back)
        found.forEach((m) => { if (m.bright && oem[amb.key(m)] === undefined) oem[amb.key(m)] = m.bright; });
        missedAt = missed ? Date.now() : 0;
        // a bus that did not answer (the BDC busy right after a start, mgu-m4 2026-11-07): asked again in 20 s
        if (missed) setTimeout(() => {
            const set = amb.effective(data.ambient, car.mode);
            // Keep known modules for OEM release when OFF; rediscover only a wanted override.
            if (set.on && car.ambientOn === true && inCar()) mods = null;
            light(true);
        }, 20000);
        mods = amb.split(found);                     // a zone with two kinds of light (line above, decor below): two parts
        log(`ambient: ${mods.length} modules: ${mods.map((m) => `${m.bus}.${m.nad} ${m.name} (${m.zone})`).join(', ')}`);
        const bad = mods.filter((m) => m.fault);
        if (bad.length) log(`ambient faults: ${bad.map((m) => `${amb.key(m)} ${m.name} (${(m.faults || []).join(', ')})`).join(', ')}`);
        faultChecked = !bad.length;
        push();
    }
    /* A drag across the colour bars sends a new colour every 250 ms: the BDC gets at most one round per GAP_MS (the
     * first at once, the last always), only the modules whose bytes changed, and the file is written once it rests. */
    const GAP_MS = 500, SAVE_MS = 2000;
    const sent = {};                                  // module -> the bytes it got last
    let roundAt = 0, force = false, lightTimer = null, saveTimer = null;
    function lightSoon() {
        if (shuttingDown) return;
        if (lightTimer) return;                       // the round already waiting reads the newest settings
        lightTimer = setTimeout(() => { lightTimer = null; light(); }, Math.max(0, roundAt + GAP_MS - Date.now()));
    }
    const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(data), SAVE_MS); };
    async function light(renew) {                     // apply the settings; a call while writing runs once more after
        if (shuttingDown) return;
        if (renew) force = true;
        if (writing) { again = true; return; }
        writing = true;
        try {
            do {
                again = false;
                const wait = roundAt + GAP_MS - Date.now();
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
                roundAt = Date.now();
                // OFF with no owned output needs no discovery or discovery retry.
                // Previously lit modules must still reach the OEM release path below.
                let set = amb.effective(data.ambient, car.mode), want = set.on && car.ambientOn === true && inCar();
                // 0.6.3: the lights are looked for once also while off (the app lists the zones: 0.6.1 showed none)
                if (!want && !lit && mods) { force = false; break; }
                // 0.6.4 (customer M8 2026-11-20): a bus silent at a start while the light was not wanted (head unit up
                // at night, car asleep) left 0 modules for the whole boot; once wanted, looked for again (once a minute)
                if (!mods || (want && missedAt && Date.now() - missedAt >= 60000)) await discover();
                // Settings may change while discovery waits for the diagnostic gateway.
                set = amb.effective(data.ambient, car.mode); want = set.on && car.ambientOn === true && inCar();
                const all = force; force = false;
                if (!want && !lit) break;
                for (const x of amb.plan(mods, want ? set : amb.settings(set, { on: false }), oem)) {
                    const b = x.off ? amb.release(x.m) : amb.frame(x.m, x.rgb, x.bright), k = amb.key(x.m), h = b.join(',');
                    if (!all && sent[k] === h) continue;
                    try { await diag.send(amb.BDC, 0x2e, b); sent[k] = h; } catch (e) { log(`ambient ${k}: ${e.message}`); }
                }
                if (all || want !== lit) litAt = Date.now();   // the last round that wrote every module
                lit = want;
                if (lit && !faultChecked && !faultTimer) faultTimer = setTimeout(recheckFaults, FAULT_MS);
            } while (again);
        } finally { writing = false; }
    }

    /* ---- seats ---- */
    const mover = new seat.Mover(diag, parked, log, () => push());
    let busyJob = null, jobSeat = null;               // 'memory' / 'gentleman' / 'exit' / 'back' while one runs, its seat
    async function job(name, fn, s) {
        if (shuttingDown) return;
        if (busyJob) { mover.halt(); return; }        // a second press stops it
        busyJob = name; jobSeat = s || null; push();
        try { log(`${name}${s ? ' ' + s : ''}: ${JSON.stringify(await fn())}`); } catch (e) { log(`${name}: ${e.message}`); }
        busyJob = jobSeat = null; push();
    }
    // the doors' moves: one seat after the other (both doors open together: each gets its turn), a newer one for the
    // same seat replaces the older; they stop a memory move or Make room
    const AUTO = ['exit', 'back'], want = { driver: null, passenger: null };
    let autoRun = false;
    function auto(s, name, fn) {
        if (shuttingDown) return;
        want[s] = { name, fn };
        if (busyJob && (jobSeat === s || AUTO.indexOf(busyJob) < 0)) mover.halt();
        runAuto();
    }
    async function runAuto() {
        if (autoRun) return;
        autoRun = true;
        for (let s; (s = SEATS.find((x) => want[x]));) {
            while (busyJob) await new Promise((r) => setTimeout(r, 50));
            const w = want[s];
            want[s] = null;
            if (w) await job(w.name, w.fn, s);
        }
        autoRun = false;
    }

    /* ---- easy exit: either front seat (+ the driver's steering column, when electric) ---- */
    const hasWheel = async () => (mover.hasWheel === null ? mover.probeWheel() : mover.hasWheel);
    async function seatPos(s) {                       // where it is: the seat's counters (+ the driver's column)
        const p = Object.assign({}, await mover.read(s));
        if (s === 'driver' && (await hasWheel())) p.wheel = Object.assign({}, await mover.read('wheel'));
        return p;
    }
    /** to a saved position: the seat, then the driver's column (wheelFirst: the column first, out of the way). A column
     * that cannot move (not calibrated, no answer) leaves the seat to go on (0.6.0: it stopped easy exit, issue #19);
     * 'short' (stood short, blocked) goes on too */
    async function seatTo(s, p, wheelFirst, parkedOnly) {
        const steps = [() => mover.recall(s, p, parkedOnly),
            async () => (s === 'driver' && p.wheel && (await hasWheel()) ? mover.recall('wheel', p.wheel) : 'done')];
        if (wheelFirst) steps.reverse();
        let short = false;
        for (let i = 0; i < steps.length; i++) {
            const r = await steps[i](), column = (i === 0) === !!wheelFirst;
            if (r === 'short') short = true;
            else if (r !== 'done' && (!column || r === 'stopped' || r === 'not parked')) return r;
            else if (r !== 'done') log(`${s} steering column: ${r} (the seat goes on)`);
        }
        return short ? 'short' : 'done';
    }
    /** the seat (its hall axes) within NEAR counts of a saved place */
    const near = (p, q) => {
        const k = Object.keys(q || {}).filter((a) => a !== 'wheel' && typeof p[a] === 'number');
        return k.length > 0 && k.every((a) => Math.abs(p[a] - q[a]) <= NEAR);
    };
    // where our last easy exit move left it (0.3.x / 0.5.x data: its Exit position)
    const lastOut = (s) => data.out[s] || data.exit[s];
    // out of the way (the door, or the app's Easy exit): where it was kept until the way back - kept again only while
    // the seat stands where our last move left it (a second door opening, a way back that did not finish); moved by
    // someone since (its switches, a memory): where it is now (0.6.0: an old place came back). The door alone moves a
    // seat only with someone in it (or the car not telling) and never one with a child seat on it
    function easyExit(s, manual) {
        if (!data.exit[s] || (!manual && !data.settings.easyExit)) return;
        if (!parked()) { log(`easy exit ${s}: the car is not standing`); return; }
        if (!manual && (childSeat(s) || (known(s) && !person(s)))) { log(`easy exit ${s}: nobody in the seat (${car.occ[s]})`); return; }
        auto(s, 'exit', async () => {
            const p = await seatPos(s);
            if (!data.pre[s] || !near(p, lastOut(s))) { data.pre[s] = p; save(data); push(); }
            return outAt(s, await seatTo(s, data.exit[s], true, true));
        });
    }
    // back where it sat - only while it stands where our move left it: moved since (its switches, a memory), the place is
    // dropped, not driven back to (it came back later, at a car start); stood short: kept for the next try
    function easyBack(s, wait) {
        if (!data.pre[s]) return;
        if (!parked()) { log(`easy exit ${s} back: the car is not standing`); return; }
        auto(s, 'back', async () => {
            const h0 = Date.now();
            if (wait) await new Promise((r) => setTimeout(r, wait));
            if (mover.haltAt >= h0) return 'stopped';
            if (!near(await mover.read(s), lastOut(s))) { data.pre[s] = null; save(data); push(); return 'moved since: stays'; }
            const r = await seatTo(s, data.pre[s], false, true);
            if (r === 'done') data.pre[s] = null;
            return outAt(s, r);
        });
    }
    /** keeps where our move left the seat (a job's end, however it ended) */
    async function outAt(s, r) {
        try { data.out[s] = Object.assign({}, await mover.read(s)); } catch (e) { log(`${s} seat: ${e.message}`); }
        save(data); push();
        return r;
    }
    // parked only, both ways (a mistaken tap while driving with a front passenger); a press while one runs still stops it
    const gentleman = () => (!busyJob && !parked() ? log('gentleman: not parked') : job('gentleman', async () => {
        if (data.room) { const r = await mover.recall('passenger', data.room, true); if (r === 'done') { data.room = null; save(data); } return r; }
        const r = await mover.room();
        if (r.why === 'done') { data.room = r.was; save(data); }
        return r.why;
    }, 'passenger'));


    /* ---- the apps ---- */
    const clients = new Set();
    const status = () => ({ state: {
        parked: parked(), carOn: car.on, ambient: { settings: data.ambient, carOn: car.ambientOn, lit, mode: car.mode,
            modules: (mods || []).map((m) => ({ id: amb.key(m), name: m.name, zone: m.zone, fault: m.fault })) },
        seats: { pos: mover.pos, moving: mover.motion ? { seat: mover.motion.seat, axis: mover.motion.axis } : null, job: busyJob,
            jobSeat, memories: data.memories, roomOut: !!data.room, wheel: mover.hasWheel === true,
            axes: per((s) => mover.axes(s)), hall: per((s) => mover.axes(s).some((a) => mover.hall(s, a))), found: mover.found,
            exit: per((s) => !!data.exit[s]), pre: per((s) => !!data.pre[s]) },
        settings: data.settings } });
    let pushTimer = null;
    function push() {                                 // coalesced: a move pushes every counter read
        if (pushTimer) return;
        pushTimer = setTimeout(() => { pushTimer = null; const l = JSON.stringify(status()) + '\n'; clients.forEach((c) => c.write(l)); }, 100);
    }
    function request(c, q) {
        if (shuttingDown && q.op !== 'get' && q.op !== 'stop') {
            c.write(JSON.stringify({ error: 'service shutting down' }) + '\n'); return;
        }
        const seatOk = q.seat === 'driver' || q.seat === 'passenger';
        if (q.op === 'diag') {
            if (!diagAllowed(q)) { c.write(JSON.stringify({ diag: { id: q.id, ok: false, error: 'not allowed' } }) + '\n'); return; }
            const ms = Math.min(20000, Math.max(1000, q.ms | 0 || 5000)), what = `${q.target.toString(16)} ${q.sid.toString(16)} ${Buffer.from(q.data).toString('hex')}`;
            diag.send(q.target, q.sid, q.data, ms).then((u) => {
                if (q.sid !== 0x22) log(`diag ${what}: ${Buffer.from(u).toString('hex')}`);   // 0.6.6: reads (boost: 1-2 a second) not logged
                c.write(JSON.stringify({ diag: { id: q.id, ok: true, uds: Buffer.from(u).toString('hex') } }) + '\n');
            }, (e) => {
                log(`diag ${what}: ${e.message}`);
                c.write(JSON.stringify({ diag: { id: q.id, ok: false, error: e.message, code: e.code } }) + '\n');
            });
            return;
        }
        if (q.op === 'ambient') { data.ambient = amb.settings(data.ambient, q.settings); saveSoon(); lightSoon(); push(); }
        else if (q.op === 'jog' && seatOk && seat.AXES.indexOf(q.axis) >= 0 && (q.dir === 1 || q.dir === -1)) {
            if (!busyJob) mover.jog(q.seat, q.axis, q.dir);
        } else if (q.op === 'stop') mover.halt();
        else if (q.op === 'memory' && seatOk && [0, 1, 2].indexOf(q.slot) >= 0) {
            const m = data.memories[q.seat];          // the driver's: the column too
            if (q.save) seatPos(q.seat).then((p) => { if (shuttingDown) return; m[q.slot] = p; save(data); push(); }).catch((e) => log('memory: ' + e.message));
            else if (m[q.slot]) job('memory', () => seatTo(q.seat, m[q.slot]), q.seat);
        } else if (q.op === 'exit') {                 // no seat: the driver's (Seats 1.4.x)
            const s = q.seat === 'passenger' ? 'passenger' : 'driver';
            if (q.save) seatPos(s).then((p) => { if (shuttingDown) return; data.exit[s] = p; save(data); push(); }).catch((e) => log('exit: ' + e.message));
            else easyExit(s, true);
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
        // an app opened with a seat still unknown: asked again (at most every 20 s; issue #29: never asked again before)
        if (!shuttingDown) SEATS.filter((s) => !mover.axes(s).length).forEach((s) => mover.probe(s));
    });
    srv.on('error', (e) => log('control socket: ' + e.message));
    srv.listen(CTL, () => { try { fs.chmodSync(CTL, 0o666); } catch (e) { log('control socket: ' + e.message); } });

    subscribe();
    setInterval(() => {                               // HU getters, not the BDC; rpm only while no speed comes
        poll(SPEED_GET, speed);
        if (!fresh(car.speedAt)) poll(RPM_GET, (h) => { rpm(h); SEATS.forEach(back); });
    }, 2000);
    setInterval(() => { if (lit && Date.now() - litAt > amb.RENEW_MS) light(true); }, 10000);
    setTimeout(() => {
        if (shuttingDown) return;
        SEATS.forEach((s) => mover.probe(s, true));   // where it is (no position at all: its motors, D700)
        mover.probeWheel();
        light(true);
    }, 3000);
    function shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        log('shutdown: blocking new work; waiting for motor STOP cleanup');
        SEATS.forEach(s => { want[s] = null; });
        const failures = mover.stopFailures;
        mover.halt(); diag.beginShutdown();
        clearTimeout(lightTimer); clearTimeout(saveTimer);
        save(data);
        let ended = false;
        const end = (reason, code) => {
            if (ended) return;
            ended = true; transportClosed = true;
            clearTimeout(deadline); clearTimeout(busyTimer);
            log('shutdown: ' + reason);
            const waiting = (busy ? [busy] : []).concat(queue.splice(0), lowQueue.splice(0));
            busy = null; waiting.forEach(c => c.res('error service shutting down'));
            if (child) { const current = child; child = null; try { current.kill(); } catch (e) { log('shutdown helper: ' + e.message); } }
            process.exit(code);
        };
        const deadline = setTimeout(() => end('STOP/cleanup unconfirmed: deadline reached', 1), SHUTDOWN_LIMIT_MS);
        (async () => {
            // Mover.busy remains true until its existing STOP sends settle.
            // Drain active ambient work too before releasing its owned output.
            while (mover.busy || mover.next || busyJob || autoRun || writing) await new Promise(r => setTimeout(r, 20));
            const failed = mover.stopFailures > failures;
            if (lit && mods) await Promise.all(mods.map(m =>
                diag.send(amb.BDC, 0x2e, amb.release(m), undefined, true).catch(e => {
                    log('shutdown ambient release: ' + e.message); throw e;
                })));
            end(failed ? 'motor STOP response unconfirmed' : 'cleanup complete (not physical stop proof)', failed ? 1 : 0);
        })().catch(e => end('cleanup unconfirmed: ' + e.message, 1));
    }
    process.on('SIGTERM', shutdown);
    log(`comfort: ${JSON.stringify(data.settings)} ambient ${JSON.stringify(data.ambient)}`);
}

if (process.argv.includes('--test')) {
    const { execFileSync } = require('child_process');
    ['uds.js', 'ambient.js', 'seat.js'].forEach((f) => process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, f), '--test'])));
    const assert = require('assert'), ok = (target, sid, data) => diagAllowed({ target, sid, data });
    assert(ok(0x40, 0x22, [0xda, 0x5f]) && ok(0x40, 0x22, [0xe3, 0xd1]) && ok(0x6e, 0x22, [0xd7, 0x02]), 'diag: reads');
    assert(ok(0x40, 0x2e, [0xda, 0x5e, 15, 1, 100, 254, 0, 0, 10]) && ok(0x40, 0x2e, [0xe3, 0xd1, 1, 0, 0, 0, 0, 0, 0]), 'diag: ambient writes');
    assert(!ok(0x40, 0x2e, [0xd3, 0x5d, 1]) && !ok(0x6e, 0x2e, [0xd7, 0x08, 0, 1, 0]) && !ok(0x40, 0x31, [1, 0xa5, 0xf1]) && !ok(0x12, 0x22, [0xf1, 0x50]),
        'diag: no other writes, routines or units');
    assert(!ok(0x40, 0x22, [0xda]) && !ok(0x40, 0x22, [0xda, 256]) && !diagAllowed({ target: 0x40, sid: 0x22, data: 'da5f' }), 'diag: bad data');
    console.log('comfort ok');
} else main();
