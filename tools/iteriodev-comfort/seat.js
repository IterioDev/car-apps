'use strict';
/*
 * seat.js - iteriodev-comfort: front seat moves, software memories and the Gentleman function through the seat
 * modules (driver 0x6D FAS_G11, passenger 0x6E BFS_G11), the workshop jobs (car-tested on mgu-m4 2026-11-07: the
 * passenger seat forward and back half a second from the head unit, hall counter +10 / -12):
 *   10 03                     extended session (the motor job needs it); 10 01 back once idle
 *   2E D7 08 <motor> <action> <pwm %>   MOTOR: motor = TAB_SV_MOTOREN_FCT (00 SLV fore/aft, 01 SHV height,
 *                             02 LNV backrest, 03 SNV tilt, 04 KHV headrest), action 00 stop / 01 plus / 02 minus
 *   22 D7 02                  HALLZAEHLER: u16 per axis SLV SHV LNV SNV KHV STV LBV LKV (+3 spare), 8192..57344
 * The seat's own switches still work and win over a diagnostic stop (car-tested), so nothing here can lock a seat.
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
const TOL = 40, STALL_MS = 700, STALL_COUNTS = 15, TICK_MS = 250, RESEND_MS = 500, JOG_MS = 900, IDLE_MS = 3000;
// ponytail: the column's digits per mm are unknown (not car-tested): its tolerance and standstill counts are guesses, tune on the car
const WHEEL_TOL = 8, WHEEL_STALL = 3;
const LIMIT_MS = 25000, ROOM_REST_MS = 2500;
const EXT_NRC = [0x7f, 0x7e, 0x31];        // a write refused in the default session: tried once more in the extended one

/** 22 D702 reply -> { SLV: count, ... } for the axes this seat has (an axis it lacks reads 0x8000 or 0) */
function parseHall(uds) {
    const out = {};
    AXES.forEach((a, i) => {
        const v = (uds[3 + 2 * i] << 8) | uds[4 + 2 * i];
        if (v >= 8192 && v <= 57344 && v !== 0x8000) out[a] = v;
    });
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
        this.sess = {};
        this.wheel = null;                           // the column's last status (parseWheel)
        this.hasWheel = null;                        // the car has an electric column: null = not known yet
        this.motion = null;                          // { seat, axis, dir, until, why }
        this.idle = setInterval(() => this.closeIdle(), 1000);
    }

    async read(seat) {
        if (seat === 'wheel') {
            this.wheel = parseWheel(await this.uds.send(UNITS.wheel, 0x22, [0xd0, 0x89]));
            this.pos.wheel = this.wheel.pos;
        } else this.pos[seat] = parseHall(await this.uds.send(UNITS[seat], 0x22, [0xd7, 0x02]));
        this.changed();
        return this.pos[seat];
    }

    /** does the car have an electric steering column? (null again when the BDC did not answer: ask later) */
    async probeWheel() {
        try {
            const r = await this.uds.send(UNITS.wheel, 0x22, [0xd0, 0x7f]);
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

    /** run one axis until until(pos, ms) says so; parkedOnly: only while the car stands (the column: always);
     * resolves with why it stopped */
    async drive(seat, axis, dir, until, limit, holder, parkedOnly) {
        const me = { seat, axis, dir, until, holder, why: null };
        if (this.motion) this.motion.why = 'replaced';
        while (this.busy) await sleep(20);        // the previous move sends its stop first
        if (me.why) return me.why;
        const wheel = seat === 'wheel', still = wheel ? WHEEL_STALL : STALL_COUNTS;
        const parked = () => (!parkedOnly && !wheel) || this.parked();
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
                if (!parked()) { me.why = 'not parked'; break; }
                if (now - t0 > (limit || LIMIT_MS)) { me.why = 'time limit'; break; }
                if (now - sent >= RESEND_MS) {
                    await this.write(seat, wheel ? wheelMove(axis, dir) : move(axis, dir));
                    sent = now;
                    if (this.sess[seat]) this.sess[seat] = now;
                }
                const p = await this.read(seat), v = p[axis];
                if (v === undefined) { me.why = 'no such axis'; break; }
                hist.push([Date.now(), v, wheel && this.wheel.moving]);
                while (hist.length > 1 && hist[0][0] < Date.now() - STALL_MS) hist.shift();
                if (wheel && this.wheel.soft[axis][dir]) { me.why = 'end stop'; break; }   // the BDC's own limit
                if (Date.now() - t0 > STALL_MS + 300 && Math.abs(v - hist[0][1]) < still && hist.every((h) => !h[2])) { me.why = 'end stop'; break; }
                const u = until(p, Date.now() - t0);
                if (u) { me.why = u; break; }
                await sleep(TICK_MS);
            }
        } catch (e) {
            me.why = 'error: ' + e.message;
        } finally {
            for (let i = 0; i < 2; i++) await this.uds.send(UNITS[seat], 0x2e, wheel ? WHEEL_STOP : stop(axis)).catch(() => {});
            if (this.motion === me) this.motion = null;
            this.busy = false;
            this.log(`${seat} ${axis} ${dir > 0 ? '+' : '-'}: ${me.why}`);
            this.read(seat).catch(() => {});
        }
        return me.why;
    }

    /** hold-to-move: called again every 300 ms while the button is held; stops JOG_MS after the last call */
    jog(seat, axis, dir) {
        const m = this.motion;
        if (m && m.holder && m.seat === seat && m.axis === axis && m.dir === dir) { m.holder.deadline = Date.now() + JOG_MS; return; }
        const holder = { deadline: Date.now() + JOG_MS };
        this.drive(seat, axis, dir, () => (Date.now() > holder.deadline ? 'released' : null), undefined, holder).catch(() => {});
    }

    halt() { if (this.motion) this.motion.why = 'stopped'; }

    /** drive each axis of a saved position (from read()) back to its counts (parkedOnly: the Gentleman's way back) */
    async recall(seat, target, parkedOnly) {
        const wheel = seat === 'wheel', tol = wheel ? WHEEL_TOL : TOL, still = wheel ? WHEEL_STALL : STALL_COUNTS;
        for (const axis of wheel ? WHEEL : ORDER) {
            if (target[axis] === undefined) continue;
            const v0 = (await this.read(seat))[axis];
            if (v0 === undefined || Math.abs(target[axis] - v0) <= tol) continue;
            for (let turn = 0; turn < 2; turn++) {
                const want = target[axis], start = this.pos[seat][axis];
                const dir = Math.sign(want - start) * (this.inv[seat][axis] ? -1 : 1);
                let worse = false;
                const why = await this.drive(seat, axis, dir, (p, ms) => {
                    const e = want - p[axis];
                    if (Math.abs(e) <= tol || Math.sign(e) !== Math.sign(want - start)) return 'there';
                    if (ms > STALL_MS && Math.abs(e) > Math.abs(want - start) + still) { worse = true; return 'wrong way'; }
                    return null;
                }, undefined, undefined, parkedOnly);
                if (worse) { this.inv[seat][axis] = !this.inv[seat][axis]; continue; }   // its counter runs the other way
                if (why !== 'there' && why !== 'end stop') return why;
                break;
            }
        }
        return 'done';
    }

    /** Gentleman (parked only): the passenger seat all the way forward, the backrest a little forward; back: recall()
     * of where room() saved it was, parked only too */
    async room() {
        const was = await this.read('passenger');
        const why = await this.drive('passenger', 'SLV', 1, () => null, undefined, undefined, true);
        if (why !== 'end stop' && why !== 'time limit') return { why, was };
        await this.drive('passenger', 'LNV', 1, (p, ms) => (ms > ROOM_REST_MS ? 'tilted' : null), undefined, undefined, true);
        return { why: 'done', was };
    }
}

module.exports = { UNITS, AXES, ORDER, WHEEL, TOL, parseHall, parseWheel, move, stop, wheelMove, WHEEL_STOP, Mover };

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
    const mv = new Mover(fake, () => parked);
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
        clearInterval(mv.idle);
        console.log('seat ok');
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
}
