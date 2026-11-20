'use strict';
/*
 * oap-seats ("Seats"): the front end of the iteriodev-comfort tool's seats (iDrive 8): the front seats moved from the
 * screen (Make room while the car is parked), three memories per seat (the tool's own) and the Gentleman function (the passenger
 * seat out of the way and back). Everything is the tool's: this app talks to it over its control socket (JSON lines,
 * CTL) and shows what it pushes.
 *   -> { op: 'get' } | { op: 'jog', seat, axis, dir: 1 | -1 } (again every JOG_MS while held) | { op: 'stop' }
 *      | { op: 'memory', seat, slot: 0-2, save } | { op: 'gentleman' }
 *   <- { state: { parked, carOn, seats: { pos: { driver: { SLV, ... }, passenger }, moving: { seat, axis } | null,
 *        job: 'memory' | 'gentleman' | null, memories: { driver: [3], passenger: [3] }, roomOut } } }
 * 1.1.0 (user 2026-11-08): one page, the driver's seat left and the passenger's right, the same layout: the seat from
 * the side with hold controls round it (holdPill: Fore, Height, Tilt, Head - its two ends; holdRound: BackUp,
 * BackDown on the backrest's arc), small M1 M2 M3 + Save under it. Hold to move: a control tells the app its touch and
 * its release; while held the app sends 'jog' every JOG_MS (the tool stops ~0.9 s after the last one), on the release
 * 'stop'. It also stops on leaving the page or the app, and after HOLD_MAX_MS. No STOP bar: while a memory move or
 * Make room runs, the lit button (or any control) stops it. 1.1.1 (user 2026-11-08): hold-to-move and memories also
 * while driving (as the seat's own switches; a passenger who can't reach theirs); Make room / Move back parked only.
 * No socket: the screens say to install the Comfort tool instead of showing controls.
 * 1.4.0 (user 2026-11-08): easy exit - Exit next to the driver's memories (Save, then Exit: the seat, and an electric
 * steering column, as they are; Exit alone: there now). The tool moves there by itself when the driver door opens
 * while the car stands and back when the driver door is shut with the ignition or engine on (1.4.1: not
 * the belt, user: not everyone wears it); Settings: Easy exit Off / On. The driver's M1-M3
 * keep the column too (the tool's). -> { op: 'exit', save } | { op: 'set', settings: { easyExit } };
 * <- seats.exit (an Exit position saved), seats.pre (out of the way: door shut + car on brings it back), seats.wheel, settings.
 * 1.5.0 (user 2026-11-09): easy exit for the passenger seat too (its door, and the seat sensor: someone in it - not a
 * child seat, not an empty seat - the door opening moves it out; seated, the door shut: back), Easy exit in both halves;
 * a seat with motors but no position (electric seats, memory on the driver's side only: user) keeps its hold controls
 * and loses its memories, Easy exit and Make room. -> { op: 'exit', seat, save }; <- seats.axes / hall / exit / pre per
 * seat, seats.jobSeat.
 * 1.6.0 (user 2026-11-12): the iDrive controller too, for cars without a touchscreen: FrontCCU's knob state
 * (oap-shared/frontccu.js) into the screens (renderer/controller.js): turn = next control (clockwise round each seat,
 * then its memories), press = tap; a hold control moves the seat while the knob stays pressed down.
 * 1.6.1: the controller on the car (mgu-m4): only the first states came, the FrontCCU proxy was not kept (collected).
 * 1.6.2 (issue #29): a half without controls says what its seat module answered (<- seats.found, Comfort 0.6.0).
 * 1.6.3 (issue #37, iDrive 7): FrontCCU waited for with a plain timeout (oap-shared/frontccu.js: iDrive 7's SDK timed
 * { timeoutMs } out at once); the builder's newer controller runtime (the ring follows the screen). Needs Comfort 0.6.1
 * (issue #42: Make room / easy exit only on a known standing car).
 *
 * Screens: drawn by the GPU renderer, designed in the HMI UI builder: apps/hmi-ui-builder/projects/seats.json
 * (scripts/oap-tools/make_seats_project.js), exported into this folder (rhmiData/ = one empty RHMI host state per
 * screen, renderer/ = screens.json + the builder's runtime). Start, tile and shutdown: the shared OnlineApp host
 * (oap-shared/online-host.js). Node 8: no newer syntax here.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const util = require('util');
const { createHost }                   = require('./online-host.js');
const { watchController }              = require('./frontccu.js');

const LOG = '[iteriodev_seats]';
const STATES = ['seats', 'settings'];  // screens = their RHMI host states, seats the entry (the lowest)
const CTL = process.env.COMFORT_CTL || '/run/iteriodev-comfort/ctl.sock';
const RETRY_MS = 2000;
const JOG_MS = 300;               // a held control repeats its jog this often
const HOLD_MAX_MS = 30000;        // a hold this long ends anyway (a release the renderer never delivered)
const RECALL_MS = 2000;           // a recall sent: its button lit this long before the tool reports the job

const SOURCE = typeof __dirname === 'string' ? path.join(__dirname, '..') : `/var/opt/public/oap/oap_${process.getuid()}/source`;
const DATA = process.env.SEATS_DATA || path.join(__dirname, '..', '..', 'data');
const LOG_FILE = `${DATA}/seats.log`;

function log() {
    const line = [new Date().toISOString()].concat([].slice.call(arguments)
        .map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 4 }).slice(0, 2000)))).join(' ');
    console.error(LOG, line);
    try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) { /* no file yet */ }
    try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch (e) { /* no data folder */ }
}

// ---- the axes (seat.js: 1 = plus; SLV / LNV 1 = forward, SHV 1 = up; SNV / KHV taken as up for plus, as the seat's
// own switch) and their controls: a pill's two ends ('a' top / left, 'b' bottom / right; the seat faces left, so
// left = forward) or the backrest's two round buttons
const AXES = ['SLV', 'SHV', 'LNV', 'SNV', 'KHV'];
const NAME = { SLV: 'Seat', SHV: 'Height', LNV: 'Backrest', SNV: 'Seat tilt', KHV: 'Headrest' };
const VERB = { SLV: ['moving back', 'moving forward'], SHV: ['down', 'up'], LNV: ['reclining', 'upright'], SNV: ['down', 'up'], KHV: ['down', 'up'] };
const PILL = { Fore: 'SLV', Height: 'SHV', Tilt: 'SNV', Head: 'KHV' };          // end a = plus
const ROUND = { BackUp: ['LNV', 1], BackDown: ['LNV', -1] };
const PARTS = { SLV: ['Fore', 'ForeLbl'], SHV: ['Height', 'HeightLbl'], LNV: ['Arc', 'BackUp', 'BackDown', 'BackLbl'], SNV: ['Tilt', 'TiltLbl'], KHV: ['Head', 'HeadLbl'] };
const COL = { dim: '#8b9099', accent: '#ffb020', warn: '#ffb020' };        // tele-widgets C
// the halves: 'd' left, 'p' right. Which seat each one moves: the steering wheel's side (Settings, user 2026-11-08):
// left-hand drive the driver's seat left, right-hand drive the driver's seat right; kept in data/seats.json { side }
const SIDE_FILE = `${DATA}/seats.json`;
let side = 'left';
try { if (JSON.parse(fs.readFileSync(SIDE_FILE, 'utf8')).side === 'right') side = 'right'; } catch (e) { /* none yet: left */ }
const SEAT = (p) => ((p === 'd') === (side !== 'right') ? 'driver' : 'passenger');   // a half -> its seat
const PFX = (seat) => ((seat === 'driver') === (side !== 'right') ? 'd' : 'p');     // a seat -> its half
function setSide(s) {
    if (s === side) return;
    jogEnd(true);                                      // nothing keeps moving under a half that changes its seat
    side = s;
    saveMode.driver = saveMode.passenger = false;
    try { fs.mkdirSync(DATA); } catch (e) { /* there already (Node 8: no recursive) */ }
    try { fs.writeFileSync(SIDE_FILE, JSON.stringify({ side })); } catch (e) { log('side not saved:', e.message); }
    log(`steering wheel: ${side}`);
    render();
}

// ---- the tool ---------------------------------------------------------------------------------------------
let tool = null;                  // its last state, null = no connection
let sock = null;
let busy = false;                 // a connection being made
let held = null;                  // the control held: { seat, axis, dir, timer, limit }
let recall = null;                // the memory last recalled: { seat, slot, t }
const saveMode = { driver: false, passenger: false };

function connect() {
    if (sock || busy) return;
    busy = true;
    const s = net.connect(CTL);
    let buf = '';
    s.setEncoding('utf8');
    s.on('connect', () => { busy = false; sock = s; log('tool connected'); });
    s.on('data', (d) => {
        buf += d;
        for (let n; (n = buf.indexOf('\n')) >= 0; buf = buf.slice(n + 1)) {
            let m;
            try { m = JSON.parse(buf.slice(0, n)); } catch (e) { continue; }
            if (m.state) { tool = m.state; render(); }
        }
    });
    s.on('error', (e) => { if (!/ENOENT|ECONNREFUSED/.test(e.code)) log('tool:', e.message); });
    s.on('close', () => { busy = false; sock = null; tool = null; jogEnd(false); render(); setTimeout(connect, RETRY_MS); });
}
const send = (q) => { if (sock) sock.write(`${JSON.stringify(q)}\n`); };

function jogStart(seat, axis, dir) {
    jogEnd(false);
    const q = { op: 'jog', seat, axis, dir };
    held = { seat, axis, dir, timer: setInterval(() => send(q), JOG_MS), limit: setTimeout(() => { log('hold too long: stop'); jogEnd(true); }, HOLD_MAX_MS) };
    send(q);
    render();
}
function jogEnd(stop) {                           // stop: tell the tool (a release); else only the repeat ends
    if (!held) return;
    clearInterval(held.timer); clearTimeout(held.limit);
    held = null;
    if (stop) send({ op: 'stop' });
    render();
}
/** a job runs (a memory move, Make room): a touch on the lit button or any control stops it */
const busyJob = () => !!(tool && tool.seats.job);
function stopJob() { send({ op: 'stop' }); recall = null; render(); }

// ---- screens (the renderer) ----------------------------------------------------------------------------
const RENDERER = path.join(SOURCE, 'renderer');
const runtime = (f) => require(path.join(RENDERER, f));
let screens = null;
let content = [];                 // every element but the frames and the no-tool notes: hidden without the tool
const MENUS = { seats: 'seatsMenu', settings: 'settingsMenu' };
const SUBS = { seats: 'Hold a control: the seat moves while you hold it', settings: 'Where the steering wheel is, easy exit, and how the Seats app works' };
// what each seat has: the tool's axes (its motors), and whether they tell their position (memories, Easy exit, Make room)
const axesOf = (seat) => {
    const s = tool && tool.seats, pos = (s && s.pos[seat]) || {};
    return AXES.filter((a) => (s && s.axes ? s.axes[seat].indexOf(a) >= 0 : typeof pos[a] === 'number'));
};
const hallOf = (seat) => !!(tool && (tool.seats.hall ? tool.seats.hall[seat] : axesOf(seat).length));

function render() {
    if (!screens) return;
    const t = tool, hide = {};
    if (t && recall && !t.seats.job && Date.now() - recall.t > RECALL_MS) recall = null;
    ['driver', 'passenger'].forEach((seat) => {
        const p = PFX(seat), axes = axesOf(seat), hall = hallOf(seat);
        AXES.forEach((a) => PARTS[a].forEach((n) => { hide[p + n] = axes.indexOf(a) < 0; }));
        if (!axes.length) hide[`${p}Seat`] = true;
        if (!hall) ['Mem0', 'Mem1', 'Mem2', 'Save', 'Exit'].forEach((n) => { hide[p + n] = true; });   // no position: hold only
        hide[`${p}Gentleman`] = seat === 'driver' || !hall;         // Make room: the passenger's half only
        hide[`${p}NoSeat`] = axes.length > 0;
    });
    content.forEach((name) => screens.set(name, { hidden: !t || !!hide[name] }));
    ['seatsNoTool', 'settingsNoTool'].forEach((name) => screens.set(name, { hidden: !!t }));
    Object.keys(MENUS).forEach((pg) => screens.set(MENUS[pg], { sel: STATES.indexOf(pg) }));
    if (!t) {
        Object.keys(MENUS).forEach((pg) => screens.set(MENUS[pg], { chips: [['Comfort tool not running', 'crit']], sub: 'Install the Comfort tool from the Store' }));
        return;
    }
    Object.keys(MENUS).forEach((pg) => screens.set(MENUS[pg], { chips: [], sub: SUBS[pg] }));
    screens.set('sideRow', { sel: side === 'right' ? 1 : 0, sub: side === 'right' ? 'The driver\'s seat in the right half' : 'Right: the driver\'s seat in the right half' });
    screens.set('exitRow', { sel: t.settings && t.settings.easyExit === false ? 0 : 1,
        sub: t.seats.exit.driver || t.seats.exit.passenger ? 'Door open: out of the way · door shut: back' : 'Seats: Save, then Easy exit, first' });
    screens.set('passengerExitRow', { sel: t.settings && t.settings.passengerEasyExit === true ? 1 : 0 });
    ['driver', 'passenger'].forEach((seat) => renderSeat(seat));
}
function renderSeat(seat) {
    const p = PFX(seat), s = tool.seats, mv = s.moving, job = s.job, parked = !!tool.parked;   // moves at any speed but Make room
    screens.set(`${p}Title`, { text: seat === 'driver' ? 'DRIVER SEAT' : 'PASSENGER SEAT' });
    // no controls: what its seat module said (1.6.2, issue #29: the same note whether it was asleep or not there at all)
    const found = s.found && s.found[seat];
    screens.set(`${p}NoSeat`, !found || (found === 'no answer' && !tool.carOn)
        ? { head: 'Seat not read yet', line: 'The seat module has not answered: switch the car on' }
        : found === 'no answer' ? { head: 'No seat module answered', line: 'Seats without memory may have no module of their own' }
            : { head: 'No seat motors reported', line: `Its seat module answered: ${found}` });
    const h = held && held.seat === seat ? held : null;
    const axis = h ? h.axis : mv && mv.seat === seat ? mv.axis : null;
    Object.keys(PILL).forEach((n) => {
        const a = PILL[n];
        screens.set(p + n, { disabled: false, pressed: h && h.axis === a ? (h.dir > 0 ? 'a' : 'b') : '' });
        screens.set(`${p}${n}Lbl`, { color: axis === a ? COL.accent : COL.dim });
    });
    Object.keys(ROUND).forEach((n) => screens.set(p + n, { disabled: false, pressed: !!h && h.axis === ROUND[n][0] && h.dir === ROUND[n][1] }));
    screens.set(`${p}BackLbl`, { color: axis === 'LNV' ? COL.accent : COL.dim });
    // the memories: set ones white; Save on: every slot ringed (tap = keep the seat there); the one moving to: amber
    const save = saveMode[seat], going = job === 'memory' && recall && recall.seat === seat ? recall.slot : -1;
    s.memories[seat].forEach((m, j) => screens.set(`${p}Mem${j}`, { set: !!m, lit: save, moving: j === going,
        disabled: !save && !m && !job }));
    screens.set(`${p}Save`, { lit: save, disabled: false });
    // Easy exit: set white, ringed in Save mode, amber while the seat goes there or back; moves only standing
    const out = (job === 'exit' || job === 'back') && s.jobSeat === seat;
    screens.set(`${p}Exit`, { set: !!s.exit[seat], lit: save, moving: out, disabled: !save && !out && (!s.exit[seat] || !parked) });
    // Make room / Move back: parked only (a mistaken tap while driving with a front passenger); its Stop always works
    if (seat === 'passenger') screens.set(`${p}Gentleman`, { text: job === 'gentleman' ? 'Stop' : s.roomOut ? 'Move back' : 'Make room', disabled: !parked && job !== 'gentleman' });
    // what moves on this seat
    const driver = seat === 'driver';
    const status = going >= 0 ? [`Moving to M${going + 1} · tap M${going + 1} to stop`, COL.accent]
            : job === 'gentleman' && !driver ? [s.roomOut ? 'Moving back · tap Stop to stop' : 'Making room · tap Stop to stop', COL.accent]
                : out ? [job === 'exit' ? 'Moving out of the way · tap Easy exit to stop' : 'Back to where you sat · tap Easy exit to stop', COL.accent]
                    : job === 'memory' && !recall ? ['Moving to a memory · tap any control to stop', COL.accent]
                        : h ? [`${NAME[h.axis]}: ${VERB[h.axis][h.dir > 0 ? 1 : 0]}`, COL.accent]
                            : axis ? [`${NAME[axis]}: moving`, COL.accent]
                                : save ? ['Tap M1 - M3 or Easy exit to keep the seat here', COL.accent]
                                    : s.pre[seat] ? [driver ? 'Easy exit · door shut, car on: moves back' : 'Easy exit · seated, door shut: moves back', COL.dim]
                                        : !driver && !parked && hallOf(seat) ? ['Hold a control · Make room: parked only', COL.dim]
                                            : ['Hold a control to move the seat', COL.dim];
    screens.set(`${p}Status`, { text: status[0], color: status[1] });
}

// ---- what the user does ---------------------------------------------------------------------------------
function onEvent(name) {
    let m;
    if (!tool) return;
    if ((m = /^([dp])Mem(\d)$/.exec(name))) {
        const seat = SEAT(m[1]), slot = +m[2];
        if (busyJob()) return stopJob();                                // the lit one (or any): stop
        if (saveMode[seat]) { send({ op: 'memory', seat, slot, save: true }); saveMode[seat] = false; return render(); }
        if (tool.seats.memories[seat][slot]) { recall = { seat, slot, t: Date.now() }; send({ op: 'memory', seat, slot, save: false }); render(); }
        return;
    }
    if ((m = /^([dp])Save$/.exec(name))) { const seat = SEAT(m[1]); saveMode[seat] = !saveMode[seat]; return render(); }
    if ((m = /^([dp])Exit$/.exec(name))) {
        const seat = SEAT(m[1]);
        if (busyJob()) return stopJob();
        if (saveMode[seat]) { send({ op: 'exit', seat, save: true }); saveMode[seat] = false; return render(); }
        if (tool.seats.exit[seat] && tool.parked) send({ op: 'exit', seat });
        return;
    }
    if (name === 'gentleman') { if (busyJob()) stopJob(); else send({ op: 'gentleman' }); }
}
function onChange(name, o) {
    let m;
    const page = Object.keys(MENUS).find((pg) => MENUS[pg] === name);
    if (page) {                                       // a tab (o is the shell's opts: read before the set)
        const to = STATES[o.sel];
        screens.set(name, { sel: STATES.indexOf(page) });
        return goTo(to);
    }
    if (name === 'sideRow') return setSide(o.sel === 1 ? 'right' : 'left');   // Settings: works without the tool too
    if (!tool) return null;
    if (name === 'passengerExitRow') { send({ op: 'set', settings: { passengerEasyExit: o.sel === 1 } }); return null; }
    if (name === 'exitRow') { send({ op: 'set', settings: { easyExit: o.sel === 1 } }); return null; }   // the tool pushes it back
    let seat = null, axis = null, dir = 0, on = false;
    if ((m = /^([dp])(Fore|Height|Tilt|Head)$/.exec(name))) { seat = SEAT(m[1]); axis = PILL[m[2]]; on = o.pressed === 'a' || o.pressed === 'b'; dir = o.pressed === 'a' ? 1 : -1; }
    else if ((m = /^([dp])(BackUp|BackDown)$/.exec(name))) { seat = SEAT(m[1]); axis = ROUND[m[2]][0]; dir = ROUND[m[2]][1]; on = !!o.pressed; }
    else return null;
    if (on) {
        if (busyJob()) stopJob();                     // a memory move or Make room running: this touch stops it
        else jogStart(seat, axis, dir);
    } else if (held && held.seat === seat && held.axis === axis) jogEnd(true);
    else render();                                   // a release after a stop: the control lets go
    return null;
}
// the seats page is the app's first screen, About opens over it (BACK returns to it)
function goTo(page) {
    const now = screens.st && screens.st.name;
    if (!page || page === now) return;
    if (now && now !== 'seats') closeScreen(now);
    if (page !== 'seats') showScreen(page);
}

// ---- RHMI: the host states (the shared OnlineApp host hands over the RHMI application) -------------------
let app = null;
const comp = (n) => app.getByName(n);
function showScreen(name) {
    return comp(name).updateResources().then(() => app.openState(name))
        .then(() => log(`opened ${name}`))
        .catch((e) => log(`open ${name} failed:`, e));
}
const closeScreen = (name) => app.closeState(name).catch((e) => log(`close ${name} failed:`, e));

function startScreens(rhmiApp) {
    app = rhmiApp;
    const design = JSON.parse(fs.readFileSync(path.join(RENDERER, 'screens.json'), 'utf8'));
    content = [].concat.apply([], design.screens.map((s) => s.components.map((c) => c.name))).filter((n) => !/Menu$|NoTool$/.test(n));
    const { RenderClient } = runtime('kit/renderd.js');
    const { ScreenApp } = runtime('screenapp.js');
    const rlog = { info: (m) => log(m), warn: (m) => log(m), error: (m) => log(m) };
    const gpu = new RenderClient('iteriodev_seats', rlog);
    screens = new ScreenApp(gpu, design, { view: 'id8', log: rlog });
    const hosts = {};
    STATES.forEach((s) => { hosts[s] = comp(s); });
    screens.bindHosts(hosts, { open: (name) => showScreen(name), close: closeScreen });
    screens.on('event', (n) => { try { onEvent(n); } catch (e) { log(`${n} failed:`, e); } });
    screens.on('change', (n, o) => { try { onChange(n, o); } catch (e) { log(`${n} failed:`, e); } });
    // another page: nothing keeps moving
    screens.on('show', () => {
        jogEnd(true);
        render();
    });
    screens.on('closed', (why) => { jogEnd(true); if (why !== 'hmi') STATES.slice().reverse().forEach(closeScreen); });
    gpu.connect();
    connect();
    watchController((v) => screens.controller(v), log);
    render();
}

// ---- lifecycle: the shared OnlineApp host (start, tile, shutdown) -----------------------------------------
log('start', process.getuid());
createHost({
    states: STATES,
    log,
    onReady: (rhmiApp) => { startScreens(rhmiApp); log('screens ready'); },
    onShutdown: () => jogEnd(true),
});
