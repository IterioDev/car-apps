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
 */
const UNITS = { driver: 0x6d, passenger: 0x6e };
const AXES = ['SLV', 'SHV', 'LNV', 'SNV', 'KHV', 'STV', 'LBV', 'LKV'];   // D702 order = the motor number
const ORDER = ['LNV', 'SLV', 'SHV', 'SNV', 'KHV'];                        // a recall: backrest first, then the seat
const TOL = 40, STALL_MS = 700, STALL_COUNTS = 15, TICK_MS = 250, RESEND_MS = 500, JOG_MS = 900, IDLE_MS = 3000;
const LIMIT_MS = 25000, ROOM_REST_MS = 2500;

/** 22 D702 reply -> { SLV: count, ... } for the axes this seat has (an axis it lacks reads 0x8000 or 0) */
function parseHall(uds) {
    const out = {};
    AXES.forEach((a, i) => {
        const v = (uds[3 + 2 * i] << 8) | uds[4 + 2 * i];
        if (v >= 8192 && v <= 57344 && v !== 0x8000) out[a] = v;
    });
    return out;
}
const move = (axis, dir) => [0xd7, 0x08, AXES.indexOf(axis), dir > 0 ? 1 : 2, 100];
const stop = (axis) => [0xd7, 0x08, AXES.indexOf(axis), 0, 0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Mover {
    /** uds: uds.js Uds; parked(): true while the car stands; changed(): something to push to the app */
    constructor(uds, parked, log, changed) {
        Object.assign(this, { uds, parked, log: log || (() => {}), changed: changed || (() => {}) });
        this.pos = { driver: {}, passenger: {} };
        this.inv = { driver: {}, passenger: {} };    // an axis whose counter runs against plus (found while recalling)
        this.sess = {};
        this.motion = null;                          // { seat, axis, dir, until, why }
        this.idle = setInterval(() => this.closeIdle(), 1000);
    }

    async read(seat) {
        this.pos[seat] = parseHall(await this.uds.send(UNITS[seat], 0x22, [0xd7, 0x02]));
        this.changed();
        return this.pos[seat];
    }

    async session(seat) {
        if (!this.sess[seat]) { await this.uds.send(UNITS[seat], 0x10, [0x03]); this.log(`${seat} seat: extended session`); }
        this.sess[seat] = Date.now();
    }
    closeIdle() {
        Object.keys(this.sess).forEach((seat) => {
            if ((this.motion && this.motion.seat === seat) || Date.now() - this.sess[seat] < IDLE_MS) return;
            delete this.sess[seat];
            this.uds.send(UNITS[seat], 0x10, [0x01]).catch((e) => this.log(`${seat} seat: default session: ${e.message}`));
        });
    }

    /** run one axis until until(pos, ms) says so; parkedOnly: only while the car stands; resolves with why it stopped */
    async drive(seat, axis, dir, until, limit, holder, parkedOnly) {
        const me = { seat, axis, dir, until, holder, why: null };
        if (this.motion) this.motion.why = 'replaced';
        while (this.busy) await sleep(20);        // the previous move sends its stop first
        if (me.why) return me.why;
        const parked = () => !parkedOnly || this.parked();
        if (!parked()) return 'not parked';
        this.busy = true;
        this.motion = me;
        const t0 = Date.now(), hist = [];
        let sent = 0;
        try {
            await this.session(seat);
            for (;;) {
                const now = Date.now();
                if (me.why) break;
                if (!parked()) { me.why = 'not parked'; break; }
                if (now - t0 > (limit || LIMIT_MS)) { me.why = 'time limit'; break; }
                if (now - sent >= RESEND_MS) { await this.uds.send(UNITS[seat], 0x2e, move(axis, dir)); sent = now; this.sess[seat] = now; }
                const p = await this.read(seat), v = p[axis];
                if (v === undefined) { me.why = 'no such axis'; break; }
                hist.push([Date.now(), v]);
                while (hist.length > 1 && hist[0][0] < Date.now() - STALL_MS) hist.shift();
                if (Date.now() - t0 > STALL_MS + 300 && Math.abs(v - hist[0][1]) < STALL_COUNTS) { me.why = 'end stop'; break; }
                const u = until(p, Date.now() - t0);
                if (u) { me.why = u; break; }
                await sleep(TICK_MS);
            }
        } catch (e) {
            me.why = 'error: ' + e.message;
        } finally {
            for (let i = 0; i < 2; i++) await this.uds.send(UNITS[seat], 0x2e, stop(axis)).catch(() => {});
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
        for (const axis of ORDER) {
            if (target[axis] === undefined) continue;
            const v0 = (await this.read(seat))[axis];
            if (v0 === undefined || Math.abs(target[axis] - v0) <= TOL) continue;
            for (let turn = 0; turn < 2; turn++) {
                const want = target[axis], start = this.pos[seat][axis];
                const dir = Math.sign(want - start) * (this.inv[seat][axis] ? -1 : 1);
                let worse = false;
                const why = await this.drive(seat, axis, dir, (p, ms) => {
                    const e = want - p[axis];
                    if (Math.abs(e) <= TOL || Math.sign(e) !== Math.sign(want - start)) return 'there';
                    if (ms > STALL_MS && Math.abs(e) > Math.abs(want - start) + STALL_COUNTS) { worse = true; return 'wrong way'; }
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

module.exports = { UNITS, AXES, ORDER, TOL, parseHall, move, stop, Mover };

if (require.main === module && process.argv.includes('--test')) {
    const assert = require('assert');
    // mgu-m4 driver seat (2026-11-07)
    const h = parseHall(Array.from(Buffer.from('62d70281287f917ef87f418030800080008000000000000000', 'hex')));
    assert.deepStrictEqual(h, { SLV: 0x8128, SHV: 0x7f91, LNV: 0x7ef8, SNV: 0x7f41, KHV: 0x8030 });
    assert.deepStrictEqual([move('SLV', 1), move('LNV', -1), stop('SHV')], [[0xd7, 8, 0, 1, 100], [0xd7, 8, 2, 2, 100], [0xd7, 8, 1, 0, 0]]);
    // a fake seat: SLV counts up on plus at 80 counts / s, stops at 0x8200; LNV runs the other way
    const st = { SLV: 0x8000 + 0x28, LNV: 0x7f00 }, run = {}, sent = [];
    const fake = { send: (unit, sid, data) => {
        sent.push([sid].concat(data).map((x) => x.toString(16)).join(' '));
        if (sid === 0x2e) { const ax = AXES[data[2]]; run[ax] = data[3] === 1 ? 1 : data[3] === 2 ? -1 : 0; }
        if (sid === 0x22) {
            const b = [0x62, 0xd7, 0x02];
            AXES.forEach((a) => { const v = st[a] || 0x8000; b.push(v >> 8, v & 0xff); });
            return Promise.resolve(b);
        }
        return Promise.resolve([sid + 0x40]);
    } };
    setInterval(() => {
        if (run.SLV) st.SLV = Math.min(0x8200, st.SLV + run.SLV * 20);
        if (run.LNV) st.LNV -= run.LNV * 20;
    }, 250).unref();
    let parked = true;
    const mv = new Mover(fake, () => parked);
    (async () => {
        assert.strictEqual(await mv.recall('passenger', { SLV: 0x8100, LNV: 0x7e80 }), 'done');
        assert.ok(Math.abs(mv.pos.passenger.SLV - 0x8100) <= TOL + 40 && Math.abs(mv.pos.passenger.LNV - 0x7e80) <= TOL + 40, JSON.stringify(mv.pos));
        assert.strictEqual(mv.inv.passenger.LNV, true);
        const r = await mv.room();
        assert.deepStrictEqual([r.why, mv.pos.passenger.SLV], ['done', 0x8200]);
        // driving: hold-to-move and a recall run (the seat's own switches do too); the Gentleman does not
        parked = false;
        assert.strictEqual(await mv.drive('passenger', 'SLV', -1, (p, ms) => (ms > 300 ? 'released' : null)), 'released', 'a jog while driving');
        assert.strictEqual(await mv.recall('passenger', { SLV: mv.pos.passenger.SLV - 60 }), 'done', 'a memory while driving');
        assert.deepStrictEqual((await mv.room()).why, 'not parked', 'Make room: parked only');
        assert.strictEqual(await mv.recall('passenger', { SLV: 0x8000 }, true), 'not parked', 'Move back: parked only');
        assert.ok(sent.includes('10 3') && sent.filter((s) => s === '2e d7 8 0 0 0').length >= 2);
        clearInterval(mv.idle);
        console.log('seat ok');
        process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });
}
