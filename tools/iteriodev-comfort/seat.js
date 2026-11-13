'use strict';
/*
 * seat.js - iteriodev-comfort: front seat moves, software memories and the Gentleman function through the seat
 * modules (driver 0x6D FAS_G11, passenger 0x6E BFS_G11), the workshop jobs (car-tested on mgu-m4 2026-11-07: the
 * passenger seat forward and back half a second from the head unit, hall counter +10 / -12):
 *   10 03                     extended session (the motor job needs it); 10 01 back once idle
 *   2E D7 08 <motor> <action> <pwm %>   MOTOR: motor = TAB_SV_MOTOREN_FCT (00 SLV fore/aft, 01 SHV height,
 *                             02 LNV backrest, 03 SNV tilt, 04 KHV headrest), action 00 stop / 01 plus / 02 minus
 *   22 D7 02                  HALLZAEHLER: u16 per axis SLV SHV LNV SNV KHV STV LBV LKV (+3 spare), 8192..57344
 *   22 D7 00                  CONFIG_HW: per motor 0 none, 1 motor only, 2 motor + hall sensor (probe(), only for a seat
 *                             whose D702 gives no position): a motor-only axis moves while held, without readings (0.4.0)
 * End stop = no progress since the newest reading at least STALL_MS old (0.4.0: a slow gateway took longer than that
 * between two readings and stopped every recall half way); a recall takes a standstill short of its target twice for
 * a pause (the seat module holding its motors, e.g. while the engine starts) before it takes it for the end stop.
 * The seat's own switches still work and win over a diagnostic stop (car-tested), so nothing here can lock a seat.
 * 0.6.0 (issues #24 / #28 / #29, user 2026-11-13): only the newest move request waits for the one before it to stop (each
 * 300 ms repeat of a held control queued a move of its own, and the stale ones ran after the release); a control held
 * on at its end stop is not pushed into the block again until it is let go; a recall stops ahead by what the seat moves
 * on after a stop (its speed x the stop's delay, learned from every stop) and corrects from standstill while that gets
 * it closer (TOL was 40 counts, no correction: easy exit came back a few cm off); a seat module that does not answer is
 * reported as such, a hall axis standing at 0x8000 counts when D700 says it has a sensor.
 * Every move ends with STOP: at its target, at the end stop (the counter stands still), on a stop request, when its
 * holder stops asking (jog: the app repeats every 300 ms), after its time limit, and - the Gentleman moves only (user
 * 2026-11-08: a mistaken tap while driving with a front passenger) - as soon as the car is not parked. Hold-to-move
 * and memory recall also run while driving, as the seat's own switches do (the user: adjusting a passenger's seat).
 *
 * The electric steering column ('wheel', 0.3.0: easy exit + the driver's memories with the wheel, user 2026-11-08) is a
 * LIN slave of the body controller (BDC 0x40, SGBD BDC_G05 / BDC_G11 / BDC), driven by the same Mover:
 *   22 D0 7F                  ELSV_VORHANDEN: 00 01 = the car has one
 *   2E D0 72 <axis> <dir>     ELSV: axis 00 stop / 01 reach (LEN) / 02 height (HGT); dir 00 plus = out to the driver
 *                             / down, 01 minus = in to the dash / up
 *   22 D0 89                  ELSV_POS_STATUS: u16 height, u16 reach (digits), moving up / down / in / out, at the
 *                             softstop up / down / in / out, calibration (TAB_ELSV_NORMIERUNG: 01 = calibrated)
 * NOT car-tested. The column stops at its softstop flags or when it stands still, never pushed against its block on
 * purpose (the BDC counts block runs, DTC 0304C7, and then needs a new calibration); it moves only calibrated and only
 * while the car stands. Default session first; extended only once the BDC refuses a move without it.
 */
const UNITS = { driver: 0x6d, passenger: 0x6e, wheel: 0x40 };
const AXES = ['SLV', 'SHV', 'LNV', 'SNV', 'KHV', 'STV', 'LBV', 'LKV'];   // D702 order = the motor number
const ORDER = ['LNV', 'SLV', 'SHV', 'SNV', 'KHV'];                        // a recall: backrest first, then the seat
const WHEEL = ['HGT', 'LEN'];                                             // the column: D089 order = a recall's order
const TOL = 8, STALL_MS = 700, STALL_COUNTS = 15, TICK_MS = 250, RESEND_MS = 500, JOG_MS = 900, IDLE_MS = 3000;
// ponytail: the column's digits per mm are unknown (not car-tested): its tolerance and standstill counts are guesses, tune on the car
const WHEEL_TOL = 8, WHEEL_STALL = 3;
const LIMIT_MS = 25000, ROOM_REST_MS = 2500, PAUSE_MS = 1500, PAUSES = 3;
// a recall: tries per axis (the approach, its corrections, a wrong way), the wait for the seat to stand after a stop
// (FAST_MS: a recall's readings at least this far apart - on the car a reading takes longer by itself)
const TRIES = 4, SETTLE_MS = 200, FAST_MS = 40;
const PROBE_MS = 1500, REPROBE_MS = 20000;  // a probe's answer time (a unit the car lacks holds the queue), its rate
const EXT_NRC = [0x7f, 0x7e, 0x31];        // a write refused in the default session: tried once more in the extended one

/** 22 D702 reply -> { SLV: count, ... } for the axes this seat has (an axis it lacks reads 0x8000 or 0); cfg (D700): an
 * axis with a hall sensor standing at 0x8000 is a place too */
function parseHall(uds, cfg) {
    const out = {};
    AXES.forEach((a, i) => {
        const v = (uds[3 + 2 * i] << 8) | uds[4 + 2 * i];
        if (v >= 8192 && v <= 57344 && (v !== 0x8000 || (cfg && cfg[a] === 2))) out[a] = v;
    });
    return out;
}
/** 22 D700 CONFIG_HW reply -> { SLV: 0 none | 1 motor only | 2 motor + hall sensor, ... } (TAB_CONFIG_HW_MOTOR). A seat
 * with motors only (electric seats with memory on the driver's side only, user 2026-11-09) moves, but has no position */
function parseConfig(uds) {
    if (uds.length < 3 + AXES.length) throw new Error('short CONFIG_HW');
    const out = {};
    AXES.forEach((a, i) => { out[a] = uds[3 + i] <= 2 ? uds[3 + i] : 0; });
    return out;
}
/** 22 D089 reply -> { pos: { HGT, LEN }, moving, soft: { axis: { 1: at the plus softstop, -1: at the minus one } }, norm } */
function parseWheel(u) {
    if (u.length < 16) throw new Error('short ELSV status');
    const w = (i) => (u[i] << 8) | u[i + 1];
    return { pos: { HGT: w(3), LEN: w(5) }, moving: [7, 8, 9, 10].some((i) => u[i] === 1),
        soft: { HGT: { 1: u[12] === 1, '-1': u[11] === 1 }, LEN: { 1: u[14] === 1, '-1': u[13] === 1 } }, norm: u[15] };
}
const move = (axis, dir) => [0xd7, 0x08, AXES.indexOf(axis), dir > 0 ? 1 : 2, 100];
const stop = (axis) => [0xd7, 0x08, AXES.indexOf(axis), 0, 0];
const wheelMove = (axis, dir) => [0xd0, 0x72, axis === 'LEN' ? 1 : 2, dir > 0 ? 0 : 1];
const WHEEL_STOP = [0xd0, 0x72, 0, 0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Mover {
    /** uds: uds.js Uds; parked(): true while the car stands; changed(): something to push to the app */
    constructor(uds, parked, log, changed) {
        Object.assign(this, { uds, parked, log: log || (() => {}), changed: changed || (() => {}) });
        this.pos = { driver: {}, passenger: {}, wheel: {} };
        this.inv = { driver: {}, passenger: {}, wheel: {} };    // an axis whose counter runs against plus (found while recalling)
        this.ext = { driver: true, passenger: true, wheel: false };   // extended session: the seats always, the BDC once it asks
        this.cfg = { driver: null, passenger: null };  // parseConfig() of each seat, null = not known (then: the axes read)
        this.sess = {};
        this.wheel = null;                           // the column's last status (parseWheel)
        this.hasWheel = null;                        // the car has an electric column: null = not known yet
        this.motion = null;                          // { seat, axis, dir, holder, why }: the move running
        this.next = null;                            // the one move waiting for it to stop (a newer one replaces it)
        this.blocked = null;                         // { k: 'seat axis dir', at }: a held control that reached its end stop
        this.wake = () => {};                        // ends the running move's nap at once (a stop, a newer move)
        this.found = { driver: null, passenger: null };   // probe(): 'ok', 'no answer', 'no motors' or the refusal
        this.probing = {}; this.probedAt = {};
        this.rtt = 0;                                // a reading's time there and back (ms, averaged)
        this.lagMs = {};                             // per seat: how long a seat moves on after a stop is decided (learned)
        this.speed = {};                             // per 'seat axis': counts per ms at its last stop (learned)
        this.idle = setInterval(() => this.closeIdle(), 1000);
    }

    async read(seat) {
        const t = Date.now();
        if (seat === 'wheel') {
            this.wheel = parseWheel(await this.uds.send(UNITS.wheel, 0x22, [0xd0, 0x89]));
            this.pos.wheel = this.wheel.pos;
        } else this.pos[seat] = parseHall(await this.uds.send(UNITS[seat], 0x22, [0xd7, 0x02]), this.cfg[seat]);
        this.rtt = this.rtt ? 0.8 * this.rtt + 0.2 * (Date.now() - t) : Date.now() - t;
        this.changed();
        return this.pos[seat];
    }

    /** at the start, when the car is switched on and when an app connects while a seat is still unknown (force: not held
     * back by REPROBE_MS): where it is (D702, as up to 1.4.x); only a seat that answered without a position is asked which
     * motors it has (D700: motors without hall sensors; an axis with one standing at 0x8000). 1.5.0 asked D700 first and
     * believed it, and a car's passenger seat (positions fine) vanished (user 2026-11-09). No answer at all (0.6.0,
     * issue #29: an empty passenger half, nothing said): reported, D700 not asked (the queue waits PROBE_MS each) */
    async probe(seat, force) {
        if (this.probing[seat] || (!force && Date.now() - (this.probedAt[seat] || 0) < REPROBE_MS)) return;
        this.probing[seat] = true; this.probedAt[seat] = Date.now();
        let err = null, raw = null;
        try { raw = await this.uds.send(UNITS[seat], 0x22, [0xd7, 0x02], PROBE_MS); this.pos[seat] = parseHall(raw, this.cfg[seat]); } catch (e) { err = e; }
        if (!Object.keys(this.pos[seat]).length && !(err && err.code === 'timeout')) {
            try {
                this.cfg[seat] = parseConfig(await this.uds.send(UNITS[seat], 0x22, [0xd7, 0x00], PROBE_MS));
                if (raw) this.pos[seat] = parseHall(raw, this.cfg[seat]);
            } catch (e) { err = err || e; }
        }
        this.found[seat] = this.axes(seat).length ? 'ok' : !err ? 'no motors' : err.code === 'timeout' ? 'no answer' : err.message;
        this.log(`${seat} seat: ${this.found[seat]}, positions ${JSON.stringify(this.pos[seat])}, motors ${JSON.stringify(this.cfg[seat])}`);
        this.probing[seat] = false;
        this.changed();
    }
    // ponytail: a seat with positions shows only those axes; a motor-only axis on such a seat (none seen) stays hidden
    /** the axes this seat moves: the ones reporting a position; none: its motors (D700) */
    axes(seat) {
        const p = this.pos[seat], c = this.cfg[seat];
        return Object.keys(p).length ? AXES.filter((a) => p[a] !== undefined) : c ? AXES.filter((a) => c[a] > 0) : [];
    }
    /** does this axis report its position (a hall sensor)? Without: hold-to-move only, no memory */
    hall(seat, axis) { return this.pos[seat][axis] !== undefined; }

    /** does the car have an electric steering column? (null again when the BDC did not answer: ask later) */
    async probeWheel() {
        if (Date.now() - (this.probedAt.wheel || 0) < REPROBE_MS) return this.hasWheel;   // no answer just now: not again yet
        this.probedAt.wheel = Date.now();
        try {
            const r = await this.uds.send(UNITS.wheel, 0x22, [0xd0, 0x7f], PROBE_MS);
            this.hasWheel = ((r[3] << 8) | r[4]) === 1;
            if (this.hasWheel) await this.read('wheel');
            this.log(`steering column: ${this.hasWheel ? `electric, ${JSON.stringify(this.wheel)}` : 'not electric'}`);
        } catch (e) {
            this.hasWheel = typeof e.code === 'number' ? false : null;
            this.log(`steering column: ${e.message}`);
        }
        this.changed();
        return this.hasWheel;
    }

    async session(seat) {
        if (!this.ext[seat]) return;
        if (!this.sess[seat]) { await this.uds.send(UNITS[seat], 0x10, [0x03]); this.log(`${seat}: extended session`); }
        this.sess[seat] = Date.now();
    }
    closeIdle() {
        Object.keys(this.sess).forEach((seat) => {
            if ((this.motion && this.motion.seat === seat) || Date.now() - this.sess[seat] < IDLE_MS) return;
            delete this.sess[seat];
            this.uds.send(UNITS[seat], 0x10, [0x01]).catch((e) => this.log(`${seat}: default session: ${e.message}`));
        });
    }
    /** a motor write; refused in the default session (the column): once more in the extended one, from then on there */
    async write(seat, data) {
        try { await this.uds.send(UNITS[seat], 0x2e, data); } catch (e) {
            if (this.ext[seat] || EXT_NRC.indexOf(e.code) < 0) throw e;
            this.ext[seat] = true;
            this.log(`${seat}: ${e.message} in the default session: extended`);
            await this.session(seat);
            await this.uds.send(UNITS[seat], 0x2e, data);
        }
    }

    /** a sleep that halt() and a newer move end at once */
    nap(ms) {
        return new Promise((r) => {
            const end = () => { clearTimeout(t); this.wake = () => {}; r(); };
            const t = setTimeout(end, ms);
            this.wake = end;
        });
    }

    /** run one axis until until(pos, ms, rate counts/ms) says so; o: { holder (hold-to-move: { deadline }), limit ms,
     * parkedOnly (only while the car stands; the column: always), fast (no rest between readings: a recall's stop
     * lands closer) }; resolves with why it stopped */
    async drive(seat, axis, dir, until, o) {
        o = o || {};
        const me = { seat, axis, dir, holder: o.holder || null, why: null };
        // only the newest request waits for the move before it to stop: an older waiting one is dropped, not run later
        [this.next, this.motion].forEach((m) => { if (m && !m.why) m.why = 'replaced'; });
        this.next = me;
        this.wake();
        while (this.busy && !me.why) await sleep(20);
        if (this.next === me) this.next = null;
        if (me.why) return me.why;
        const wheel = seat === 'wheel', still = wheel ? WHEEL_STALL : STALL_COUNTS;
        const blind = !wheel && !this.hall(seat, axis);   // no position: moves while its holder asks, no end stop seen
        const parked = () => (!o.parkedOnly && !wheel) || this.parked();
        if (!parked()) return 'not parked';
        this.busy = true;
        this.motion = me;
        const t0 = Date.now(), hist = [];
        let sent = 0;
        try {
            await this.session(seat);
            if (wheel) {                              // calibrated, and not at its softstop that way already
                await this.read(seat);
                if (this.wheel.norm !== 1) me.why = 'not calibrated';
                else if (this.wheel.soft[axis][dir]) me.why = 'end stop';
            }
            for (;;) {
                const now = Date.now();
                if (me.why) break;
                if (me.holder && now > me.holder.deadline) { me.why = 'released'; break; }   // let go before it even started
                if (!parked()) { me.why = 'not parked'; break; }
                if (now - t0 > (o.limit || LIMIT_MS)) { me.why = 'time limit'; break; }
                if (now - sent >= RESEND_MS) {
                    await this.write(seat, wheel ? wheelMove(axis, dir) : move(axis, dir));
                    sent = now;
                    if (this.sess[seat]) this.sess[seat] = now;
                }
                if (blind) {
                    const u = until(null, Date.now() - t0, 0);
                    if (u) { me.why = u; break; }
                    await this.nap(TICK_MS);
                    continue;
                }
                const r0 = Date.now(), p = await this.read(seat), v = p[axis];
                if (v === undefined) { me.why = 'no such axis'; break; }
                // an end stop: no progress since the newest reading at least STALL_MS old (a slow gateway takes longer
                // than that between two readings: compared with the one just taken, it stopped half way before 0.3.3)
                const t = Date.now();
                hist.push([t, v, wheel && this.wheel.moving]);
                while (hist.length > 1 && hist[1][0] <= t - STALL_MS) hist.shift();
                const prev = hist[hist.length - 2], rate = prev ? (v - prev[1]) / Math.max(1, t - prev[0]) : 0;
                if (wheel && this.wheel.soft[axis][dir]) { me.why = 'end stop'; break; }   // the BDC's own limit
                if (t - t0 > STALL_MS + 300 && t - hist[0][0] >= STALL_MS && Math.abs(v - hist[0][1]) < still && hist.every((h) => !h[2])) { me.why = 'end stop'; break; }
                const u = until(p, Date.now() - t0, rate);
                if (u) { me.why = u; break; }
                await this.nap(o.fast ? Math.max(0, FAST_MS - (Date.now() - r0)) : TICK_MS);
            }
        } catch (e) {
            me.why = 'error: ' + e.message;
        } finally {
            // held on at its end stop: the holder's next repeats (while the stops go out, too) do not push again (jog)
            if (me.holder && me.why === 'end stop') this.blocked = { k: `${seat} ${axis} ${dir}`, at: Date.now() };
            // handed over to the next move on this seat: one stop, the next one reads anyway; else twice and a reading
            const handover = me.why === 'replaced' && this.next && this.next.seat === seat;
            for (let i = 0; i < (handover ? 1 : 2); i++) await this.uds.send(UNITS[seat], 0x2e, wheel ? WHEEL_STOP : stop(axis)).catch(() => {});
            if (this.motion === me) this.motion = null;
            this.busy = false;
            this.log(`${seat} ${axis} ${dir > 0 ? '+' : '-'}: ${me.why}`);
            if (!blind && !handover && !o.fast) this.read(seat).catch(() => {});
        }
        return me.why;
    }

    /** hold-to-move: called again every 300 ms while the button is held; stops JOG_MS after the last call */
    jog(seat, axis, dir) {
        const m = this.next || this.motion, k = `${seat} ${axis} ${dir}`, b = this.blocked;
        if (m && m.holder && !m.why && m.seat === seat && m.axis === axis && m.dir === dir) { m.holder.deadline = Date.now() + JOG_MS; return; }
        // held on at the end stop it reached: not driven into the block again until it is let go (each repeat used to
        // start a new push, the seat module backing off each time: the back and forth near the limits, issue #24)
        if (b && b.k === k && Date.now() - b.at < JOG_MS) { b.at = Date.now(); return; }
        const holder = { deadline: Date.now() + JOG_MS };
        this.drive(seat, axis, dir, () => null, { holder }).catch(() => {});
    }

    /** stops the move (and the one waiting), and a recall between two of its moves (a pause, a reading) */
    halt() {
        this.haltAt = Date.now();
        this.blocked = null;
        [this.next, this.motion].forEach((m) => { if (m && !m.why) m.why = 'stopped'; });
        this.wake();
    }

    /** how long this seat moves on after a stop is decided (ms): learned from its stops, else a reading's time (the
     * reading is half of it old, the stop takes the other half to arrive) and a little for the motor */
    lag(seat) { return this.lagMs[seat] !== undefined ? this.lagMs[seat] : (this.rtt || 100) + 30; }
    learn(seat, axis, ms, rate) {
        const ema = (o, k, x) => { o[k] = o[k] === undefined ? x : 0.5 * o[k] + 0.5 * x; };
        ema(this.lagMs, seat, Math.max(0, Math.min(1500, ms)));
        ema(this.speed, `${seat} ${axis}`, rate);
    }
    /** the least a correction from standstill moves this axis (counts): its speed over a reading and the stop's lag */
    pulse(seat, axis) { const v = this.speed[`${seat} ${axis}`]; return v ? v * ((this.rtt || 100) + this.lag(seat)) : 0; }

    /** drive each axis of a saved position (from read()) back to its counts (parkedOnly: the Gentleman's way back, easy
     * exit): 'done', 'short' (an axis stood short of it: blocked, or its seat module kept holding the motors) or why
     * it stopped */
    async recall(seat, target, parkedOnly) {
        const t0 = Date.now();
        let short = false;
        for (const axis of seat === 'wheel' ? WHEEL : ORDER) {
            if (this.haltAt >= t0) return 'stopped';
            if (target[axis] === undefined) continue;
            const r = await this.approach(seat, axis, target[axis], parkedOnly, t0);
            if (r === 'short') short = true;
            else if (r !== 'there') return r;
        }
        return short ? 'short' : 'done';
    }

    /** one axis to its counts: stopped ahead by what it moves on after the stop (its speed x lag(), learned from each
     * stop), then corrected from standstill while that gets it closer - never back and forth more than TRIES */
    async approach(seat, axis, want, parkedOnly, t0) {
        const tol = seat === 'wheel' ? WHEEL_TOL : TOL, still = seat === 'wheel' ? WHEEL_STALL : STALL_COUNTS;
        let v = (await this.read(seat))[axis], best = Infinity, pauses = 0;
        for (let n = 0; v !== undefined && n < TRIES; n++) {
            const e = want - v;
            if (this.haltAt >= t0) return 'stopped';
            if (Math.abs(e) <= tol) return 'there';
            // as close as it gets: the last correction did not get closer, or the next would overshoot by more
            if (Math.abs(e) >= best || (best < Infinity && Math.abs(e) <= this.pulse(seat, axis) / 2)) break;
            const s = Math.sign(e), dir = s * (this.inv[seat][axis] ? -1 : 1);
            let worse = false, stopAt = null, rateAt = 0;
            const why = await this.drive(seat, axis, dir, (p, ms, rate) => {
                const left = (want - p[axis]) * s;    // still to go (below 0: past it)
                if (ms > STALL_MS && left > Math.abs(e) + still) { worse = true; return 'wrong way'; }
                // stop now when what it moves on after the stop leaves it closer than the next reading would
                const r = Math.abs(rate), coast = r * this.lag(seat), step = r * Math.max(this.rtt, FAST_MS);
                if (left - coast <= Math.max(tol, step) / 2) { stopAt = p[axis]; rateAt = r; return 'there'; }
                return null;
            }, { parkedOnly, fast: true });
            if (why !== 'there' && why !== 'end stop' && why !== 'wrong way') return why;
            await sleep(SETTLE_MS);
            if (this.haltAt >= t0) return 'stopped';
            const now = (await this.read(seat))[axis];
            if (now === undefined) break;
            if (stopAt !== null && rateAt > 0.005) this.learn(seat, axis, ((now - stopAt) * s) / rateAt, rateAt);
            if (worse) { this.inv[seat][axis] = !this.inv[seat][axis]; v = now; continue; }   // its counter runs the other way
            // ponytail: a standstill short of a saved (so reachable) place is taken for a pause PAUSES times (the seat
            // module holds its motors while the car switches on / the engine starts, user 2026-11-09), then for a block
            if (why === 'end stop' && Math.abs(want - now) > tol) {
                if (pauses++ >= PAUSES) return Math.abs(want - now) > 3 * tol ? 'short' : 'there';
                await this.nap(PAUSE_MS);             // a stop ends it at once
                if (this.haltAt >= t0) return 'stopped';
                v = (await this.read(seat))[axis];
                n--;
                continue;
            }
            best = Math.abs(e);
            v = now;
        }
        return 'there';
    }

    /** Gentleman (parked only): the passenger seat all the way forward, the backrest a little forward; back: recall()
     * of where room() saved it was, parked only too */
    async room() {
        if (!this.hall('passenger', 'SLV')) return { why: 'no positions', was: null };   // its end stop and way back need them
        const was = await this.read('passenger');
        const why = await this.drive('passenger', 'SLV', 1, () => null, { parkedOnly: true });
        if (why !== 'end stop' && why !== 'time limit') return { why, was };
        await this.drive('passenger', 'LNV', 1, (p, ms) => (ms > ROOM_REST_MS ? 'tilted' : null), { parkedOnly: true });
        return { why: 'done', was };
    }
}

module.exports = { UNITS, AXES, ORDER, WHEEL, TOL, parseHall, parseConfig, parseWheel, move, stop, wheelMove, WHEEL_STOP, Mover };

if (require.main === module && process.argv.includes('--test')) {
    const assert = require('assert');
    // mgu-m4 driver seat (2026-11-07)
    const h = parseHall(Array.from(Buffer.from('62d70281287f917ef87f418030800080008000000000000000', 'hex')));
    assert.deepStrictEqual(h, { SLV: 0x8128, SHV: 0x7f91, LNV: 0x7ef8, SNV: 0x7f41, KHV: 0x8030 });
    assert.deepStrictEqual([move('SLV', 1), move('LNV', -1), stop('SHV')], [[0xd7, 8, 0, 1, 100], [0xd7, 8, 2, 2, 100], [0xd7, 8, 1, 0, 0]]);
    // BDC_G05 ARG_0xD072_D: reach out = plus = 00, height up = minus = 01; RES_0xD089_D: height, reach, 4 moving, 4 softstops, calibration
    assert.deepStrictEqual([wheelMove('LEN', 1), wheelMove('HGT', -1), WHEEL_STOP], [[0xd0, 0x72, 1, 0], [0xd0, 0x72, 2, 1], [0xd0, 0x72, 0, 0]]);
    const w = parseWheel(Array.from(Buffer.from('62d08940003000' + '00000000' + '01000000' + '01', 'hex')));
    assert.deepStrictEqual([w.pos, w.moving, w.soft.HGT[-1], w.soft.HGT[1], w.norm], [{ HGT: 0x4000, LEN: 0x3000 }, false, true, false, 1], 'at the top softstop');
    // a fake seat: SLV counts up on plus at 80 counts / s, stops at 0x8200; LNV runs the other way. A fake column (BDC):
    // height counts up on plus (down), reach counts DOWN on plus (out); softstops 0x3f00 / 0x4200 and 0x2e00 / 0x3100;
    // the BDC takes D072 in the extended session only
    const st = { SLV: 0x8000 + 0x28, LNV: 0x7f00 }, run = {}, sent = [];
    const col = { HGT: 0x4000, LEN: 0x3000, run: {}, norm: 1, ext: false };
    const SOFT = { HGT: [0x3f00, 0x4200], LEN: [0x2e00, 0x3100] };
    const nrc = (c) => Promise.reject(Object.assign(new Error('NRC ' + c.toString(16)), { code: c }));
    const fake = { send: (unit, sid, data) => {
        sent.push([unit, sid].concat(data).map((x) => x.toString(16)).join(' '));
        if (unit === 0x40) {
            if (sid === 0x10) { col.ext = data[0] === 3; return Promise.resolve([0x50]); }
            if (sid === 0x2e) {
                if (!col.ext) return nrc(0x7f);
                col.run = data[2] === 0 ? {} : { [data[2] === 1 ? 'LEN' : 'HGT']: data[3] === 0 ? 1 : -1 };
                return Promise.resolve([0x6e, 0xd0, 0x72]);
            }
            if (data[1] === 0x7f) return Promise.resolve([0x62, 0xd0, 0x7f, 0, 1]);
            const at = (a, i) => (col[a] === SOFT[a][i] ? 1 : 0), mv = (a, d) => (col.run[a] === d && !at(a, a === 'HGT' ? (d > 0 ? 1 : 0) : (d > 0 ? 0 : 1)) ? 1 : 0);
            return Promise.resolve([0x62, 0xd0, 0x89, col.HGT >> 8, col.HGT & 0xff, col.LEN >> 8, col.LEN & 0xff,
                mv('HGT', -1), mv('HGT', 1), mv('LEN', -1), mv('LEN', 1), at('HGT', 0), at('HGT', 1), at('LEN', 1), at('LEN', 0), col.norm]);
        }
        if (sid === 0x2e) { const ax = AXES[data[2]]; run[ax] = data[3] === 1 ? 1 : data[3] === 2 ? -1 : 0; }
        if (sid === 0x22) {
            const b = [0x62, 0xd7, 0x02];
            AXES.forEach((a) => { const v = st[a] || 0x8000; b.push(v >> 8, v & 0xff); });
            return Promise.resolve(b);
        }
        return Promise.resolve([sid + 0x40]);
    } };
    const clamp = (a, v) => Math.max(SOFT[a][0], Math.min(SOFT[a][1], v));
    setInterval(() => {
        if (run.SLV) st.SLV = Math.min(0x8200, st.SLV + run.SLV * 20);
        if (run.LNV) st.LNV -= run.LNV * 20;
        if (col.run.HGT) col.HGT = clamp('HGT', col.HGT + col.run.HGT * 64);
        if (col.run.LEN) col.LEN = clamp('LEN', col.LEN - col.run.LEN * 64);
    }, 250).unref();
    let parked = true;
    const mv = new Mover(fake, () => parked, process.env.SEAT_DEBUG ? console.log : undefined);
    (async () => {
        assert.strictEqual(await mv.recall('passenger', { SLV: 0x8100, LNV: 0x7e80 }), 'done');
        assert.ok(Math.abs(mv.pos.passenger.SLV - 0x8100) <= TOL + 40 && Math.abs(mv.pos.passenger.LNV - 0x7e80) <= TOL + 40, JSON.stringify(mv.pos));
        assert.strictEqual(mv.inv.passenger.LNV, true);
        const r = await mv.room();
        assert.deepStrictEqual([r.why, mv.pos.passenger.SLV], ['done', 0x8200]);
        // the column: found, recalled (reach's counter runs against plus), refused in the default session -> extended
        assert.strictEqual(await mv.probeWheel(), true);
        assert.deepStrictEqual(mv.pos.wheel, { HGT: 0x4000, LEN: 0x3000 });
        assert.strictEqual(await mv.recall('wheel', { HGT: 0x4100, LEN: 0x2f00 }), 'done');
        assert.ok(Math.abs(col.HGT - 0x4100) <= WHEEL_TOL + 64 && Math.abs(col.LEN - 0x2f00) <= WHEEL_TOL + 64, JSON.stringify(col));
        assert.deepStrictEqual([mv.inv.wheel.LEN, mv.ext.wheel], [true, true]);
        assert.ok(sent.includes('40 10 3') && sent.filter((s) => s === '40 2e d0 72 0 0').length >= 2, 'extended once refused, every move stopped');
        // up to the softstop: stops on its flag, nothing pushed past it; already there: no move at all
        assert.strictEqual(await mv.drive('wheel', 'HGT', -1, () => null), 'end stop');
        assert.strictEqual(col.HGT, 0x3f00);
        const n = sent.length;
        assert.strictEqual(await mv.drive('wheel', 'HGT', -1, () => null), 'end stop');
        assert.ok(!sent.slice(n).some((s) => s === '40 2e d0 72 2 1'), 'at the softstop: no move sent');
        col.norm = 4;
        assert.strictEqual(await mv.drive('wheel', 'LEN', 1, () => null), 'not calibrated');
        col.norm = 1;
        // driving: hold-to-move and a recall run (the seat's own switches do too); the Gentleman and the column do not
        parked = false;
        assert.strictEqual(await mv.drive('passenger', 'SLV', -1, (p, ms) => (ms > 300 ? 'released' : null)), 'released', 'a jog while driving');
        assert.strictEqual(await mv.recall('passenger', { SLV: mv.pos.passenger.SLV - 60 }), 'done', 'a memory while driving');
        assert.deepStrictEqual((await mv.room()).why, 'not parked', 'Make room: parked only');
        assert.strictEqual(await mv.recall('passenger', { SLV: 0x8000 }, true), 'not parked', 'Move back: parked only');
        assert.strictEqual(await mv.recall('wheel', { HGT: 0x4100 }), 'not parked', 'the column: parked only, always');
        assert.ok(sent.includes('6e 10 3') && sent.filter((s) => s === '6e 2e d7 8 0 0 0').length >= 2);
        // a slow gateway (400 ms a request: more than STALL_MS between two readings) while the seat moves: no end stop
        // half way (it stopped after ~1 s before 0.3.3, user 2026-11-09: "did only half the movement back")
        const logs = [], slow = new Mover({ send: (u, s, d) => sleep(400).then(() => fake.send(u, s, d)) }, () => true, (l) => logs.push(l));
        st.SLV = 0x8028;
        assert.strictEqual(await slow.recall('passenger', { SLV: 0x81f0 }), 'done');
        assert.ok(Math.abs(st.SLV - 0x81f0) <= 160 && !logs.some((l) => /end stop/.test(l)), `${st.SLV.toString(16)} ${logs.join(' | ')}`);
        // a pause on the way (the seat module holds the motors while the engine starts): moved on, not taken for the end
        st.SLV = 0x8028;
        let held = true;
        setTimeout(() => { held = false; }, 2500);
        const pausing = new Mover({ send: (u, s, d) => (held && s === 0x2e && d[3] ? Promise.resolve([0x6e]) : fake.send(u, s, d)) }, () => true);
        assert.strictEqual(await pausing.recall('passenger', { SLV: 0x8100 }), 'done');
        assert.ok(Math.abs(st.SLV - 0x8100) <= TOL + 40, `after the pause: ${st.SLV.toString(16)}`);
        // a passenger seat with motors only (D700 01 each, no D702: electric seats, memory on the driver's side only):
        // hold-to-move works and reads nothing while it moves; no Make room (no end stop, no way back)
        const bare = [], only = new Mover({ send: (u, s, d) => {
            bare.push([s].concat(d).map((x) => x.toString(16)).join(' '));
            if (s === 0x22 && d[1] === 0x00) return Promise.resolve([0x62, 0xd7, 0x00, 1, 1, 1, 0, 0, 0, 0, 0]);
            return s === 0x22 ? nrc(0x31) : Promise.resolve([s + 0x40]);
        } }, () => true);
        await only.probe('passenger');
        assert.deepStrictEqual([only.axes('passenger'), only.hall('passenger', 'SLV')], [['SLV', 'SHV', 'LNV'], false]);
        const until = Date.now() + 700, b0 = bare.length;
        assert.strictEqual(await only.drive('passenger', 'SLV', 1, () => (Date.now() > until ? 'released' : null)), 'released');
        assert.ok(bare.filter((s) => s === '2e d7 8 0 1 64').length >= 2 && !bare.slice(b0).some((s) => s === '22 d7 2'), bare.join(' | '));
        assert.strictEqual((await only.room()).why, 'no positions');
        // a seat whose D700 says nothing usable but whose D702 reports positions (a car's passenger seat lost in 1.5.0,
        // user 2026-11-09): the positions win, D700 is not even asked
        const odd = [], both = new Mover({ send: (u, s, d) => {
            odd.push([s].concat(d).map((x) => x.toString(16)).join(' '));
            if (s === 0x22 && d[1] === 0x00) return Promise.resolve([0x62, 0xd7, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
            return fake.send(u, s, d);
        } }, () => true);
        await both.probe('passenger');
        assert.deepStrictEqual([both.axes('passenger'), both.hall('passenger', 'SLV'), odd.includes('22 d7 0')], [['SLV', 'LNV'], true, false]);
        assert.strictEqual(only.found.passenger, 'ok');
        // 0.6.0 (issue #29): a seat module that never answers is reported as such (D700 not asked, the queue waits for
        // each); one refusing both; a hall axis standing at 0x8000 counts once D700 says it has a sensor
        const asked = [], none = new Mover({ send: (u, s, d) => { asked.push(d[1]); return Promise.reject(Object.assign(new Error('no answer'), { code: 'timeout' })); } }, () => true);
        await none.probe('passenger', true);
        assert.deepStrictEqual([none.found.passenger, none.axes('passenger'), asked], ['no answer', [], [0x02]]);
        await none.probe('passenger');
        assert.strictEqual(asked.length, 1, 'asked again only after REPROBE_MS (an app opening) or forced (the car on)');
        const deny = new Mover({ send: () => nrc(0x31) }, () => true);
        await deny.probe('passenger', true);
        assert.deepStrictEqual([deny.found.passenger, deny.axes('passenger')], ['NRC 31', []]);
        const mid = new Mover({ send: (u, s, d) => Promise.resolve(d[1] === 0x00 ? [0x62, 0xd7, 0x00, 2, 2, 0, 0, 0, 0, 0, 0]
            : [0x62, 0xd7, 0x02].concat([].concat.apply([], AXES.map(() => [0x80, 0])))) }, () => true);
        await mid.probe('passenger', true);
        assert.deepStrictEqual([mid.found.passenger, mid.axes('passenger'), mid.hall('passenger', 'SHV')], ['ok', ['SLV', 'SHV'], true]);

        // a seat moving smoothly: every axis counts `rate` per ms while it runs (up to `top`: its end stop); a request
        // takes `rtt` there and back and acts (or reads) half way, as the gateway does
        const smooth = (rtt, rate, top) => {
            const v = { SLV: 0x8040, SHV: 0x8040, LNV: 0x8040 }, run = {}, at = { t: Date.now() }, moves = [];
            const tick = () => {
                const t = Date.now();
                Object.keys(run).forEach((a) => { v[a] = Math.max(0x7000, Math.min(top || 0x9000, v[a] + run[a] * rate * (t - at.t))); });
                at.t = t;
            };
            const send = (u, sid, d) => new Promise((res) => setTimeout(() => {
                tick();
                if (sid === 0x2e) { const a = AXES[d[2]]; run[a] = d[3] === 1 ? 1 : d[3] === 2 ? -1 : 0; if (run[a]) moves.push(a); }
                const b = [0x62, 0xd7, 0x02];
                AXES.forEach((a) => { const x = v[a] !== undefined ? Math.round(v[a]) : 0x8000; b.push(x >> 8, x & 0xff); });
                setTimeout(() => res(sid === 0x22 ? b : [sid + 0x40]), rtt / 2);
            }, rtt / 2));
            return { v, run, moves, send };
        };
        // hold-to-move on a slow gateway (issues #24 / #28): the finger goes from the seat to the backrest while the
        // seat's stop is still on its way; the backrest's repeats queue nothing, and after the release nothing moves
        const qlog = [], q = smooth(200, 0.15), qm = new Mover(q, () => true, (l) => qlog.push(l));
        await qm.read('passenger');
        qm.jog('passenger', 'SLV', 1);
        await sleep(700);
        for (let i = 0; i < 5; i++) { qm.jog('passenger', 'LNV', 1); await sleep(300); }
        qm.halt();
        await sleep(400);
        const mark = q.moves.length;
        await sleep(2000);
        assert.deepStrictEqual([q.moves.length, q.run.SLV, q.run.LNV], [mark, 0, 0], `nothing moves after the release: ${qlog.join(' | ')}`);
        assert.strictEqual(qlog.filter((l) => /^passenger LNV \+/.test(l)).length, 1, `one backrest move for five repeats: ${qlog.join(' | ')}`);
        // held on at the end stop for 4 s: one push into the block, not one per repeat
        const elog = [], es = smooth(60, 0.3, 0x8100), em = new Mover(es, () => true, (l) => elog.push(l));
        await em.read('passenger');
        for (const t1 = Date.now() + 4000; Date.now() < t1;) { em.jog('passenger', 'SLV', 1); await sleep(300); }
        em.halt();
        await sleep(300);
        assert.strictEqual(elog.filter((l) => /^passenger SLV \+/.test(l)).length, 1, elog.join(' | '));
        // a recall lands within TOL and back (easy exit came back a few cm off: 40 counts and no correction, user
        // 2026-11-13); on a slow gateway still near; no back and forth: a few moves at most
        const pz = smooth(80, 0.15), pm = new Mover(pz, () => true);
        assert.strictEqual(await pm.recall('passenger', { SLV: 0x8040 + 600 }), 'done');
        const out1 = pz.v.SLV - (0x8040 + 600);
        assert.strictEqual(await pm.recall('passenger', { SLV: 0x8040 }), 'done');
        const back1 = pz.v.SLV - 0x8040, moves1 = pz.moves.length;
        assert.ok(Math.abs(out1) <= TOL && Math.abs(back1) <= TOL && typeof pm.lagMs.passenger === 'number', `out ${out1}, back ${back1}, lag ${pm.lagMs.passenger}`);
        const sz = smooth(300, 0.15), sm = new Mover(sz, () => true);
        assert.strictEqual(await sm.recall('passenger', { SLV: 0x8040 + 600 }), 'done');
        assert.strictEqual(await sm.recall('passenger', { SLV: 0x8040 }), 'done');
        const back2 = sz.v.SLV - 0x8040;
        console.log(`recall: off ${out1.toFixed(1)} / ${back1.toFixed(1)} counts (${moves1} move writes, lag ${Math.round(pm.lagMs.passenger)} ms); slow gateway ${back2.toFixed(1)} (${sz.moves.length} move writes)`);
        assert.ok(Math.abs(back2) <= 3 * TOL, `slow gateway: ${back2}`);
        [mv, slow, pausing, only, both, none, deny, mid, qm, em, pm, sm].forEach((m) => clearInterval(m.idle));
        console.log('seat ok');
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
}
