'use strict';
/*
 * uds.js - iteriodev-comfort: UDS through the head unit's diagnostic gateway (TASU, SOME/IP 0xF8A6 instance 128),
 * over one `hmictl serve` session. The reply event is selective (sent only to the caller), so the subscription and
 * every request go through the same hmictl process (car-tested on mgu-m4 2026-11-07).
 *   request  method 1 sendTasuRequest: sourceAddress F2, target, service, subroutine 0, length u16,
 *            ByteBuffer (u32 length + bytes), deadlockTime 0. The UDS data does not repeat the service byte.
 *   reply    event 0x8001: ByteBuffer (u32 length + bytes) + u16 length + error u32; in the bytes [2] 0x7F = refused
 *            by the transport (code at [4]), [6] the unit that answered, the UDS reply from [9].
 * One request at a time: the gateway answers one caller's requests in order, and a reply carries no request id.
 */
const SUB = 'sub 0xf8a6 128 1 1 0x8001';
const EV = 0x8001, SVC = 0xf8a6;
const TIMEOUT_MS = 3000, PENDING_MS = 10000;       // 7F xx 78 = response pending: BMW waits up to 10 s

const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0');

/** the hmictl line for one request; data = the UDS bytes after the service byte */
function line(target, sid, data) {
    const d = Buffer.from(data || []), n = d.length;
    return `call 0xf8a6 128 1 1 f2${hex2(target)}${hex2(sid)}00${n.toString(16).padStart(4, '0')}` +
        `${n.toString(16).padStart(8, '0')}${d.toString('hex')}00`;
}

/** an event payload (hex) -> { unit, uds: [bytes] } | { reject: code } | null */
function parse(hex) {
    if (!/^[0-9a-f]{8}/i.test(hex || '')) return null;
    const n = parseInt(hex.slice(0, 8), 16), b = Buffer.from(hex.slice(8, 8 + 2 * n), 'hex');
    if (b.length >= 5 && b[2] === 0x7f) return { reject: b[4] };
    if (b.length < 10) return null;
    return { unit: b[6], uds: Array.from(b.slice(9)) };
}

/**
 * The request queue. hmi(line) -> Promise<"ok .." | "error ..">; feed every "ev 0xf8a6 0x8001 <hex>" line to onEvent.
 * send(target, sid, data) -> Promise<[uds bytes]> with the positive reply, rejects with an Error (code: NRC or 'timeout').
 */
class Uds {
    constructor(hmi, log) { this.hmi = hmi; this.log = log || (() => {}); this.q = []; this.cur = null; }

    send(target, sid, data) {
        return new Promise((res, rej) => { this.q.push({ target, sid, data, res, rej }); this.pump(); });
    }

    pump() {
        if (this.cur || !this.q.length) return;
        const c = this.cur = this.q.shift();
        // the answer's time counts from the request's going out, not from its waiting behind hmictl's line before it
        this.hmi(line(c.target, c.sid, c.data)).then((r) => {
            if (this.cur !== c) return;
            if (/^ok/.test(r)) this.arm(TIMEOUT_MS); else this.finish(null, new Error('gateway: ' + r));
        });
    }

    arm(ms) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.finish(null, Object.assign(new Error('no answer'), { code: 'timeout' })), ms);
    }

    finish(uds, err) {
        const c = this.cur;
        if (!c) return;
        clearTimeout(this.timer);
        this.cur = null;
        if (err) c.rej(err); else c.res(uds);
        this.pump();
    }

    /** one "ev" line's svc, event id and payload */
    onEvent(svc, ev, hex) {
        if (svc !== SVC || ev !== EV || !this.cur) return;
        const r = parse(hex), c = this.cur;
        if (!r) return;
        if (r.reject !== undefined) { this.finish(null, Object.assign(new Error('refused by the gateway'), { code: r.reject })); return; }
        if (r.unit !== c.target) return;
        const u = r.uds;
        if (u[0] === 0x7f && u[1] === c.sid) {
            if (u[2] === 0x78) { this.arm(PENDING_MS); return; }
            this.finish(null, Object.assign(new Error('NRC ' + hex2(u[2])), { code: u[2] }));
        } else if (u[0] === c.sid + 0x40) this.finish(u);
    }
}

module.exports = { SUB, SVC, EV, line, parse, Uds };

if (require.main === module && process.argv.includes('--test')) {
    const assert = require('assert');
    // the requests sent on the car (2026-11-07)
    assert.strictEqual(line(0x40, 0x22, [0xf1, 0x50]), 'call 0xf8a6 128 1 1 f2402200000200000002f15000');
    assert.strictEqual(line(0x6e, 0x2e, [0xd7, 0x08, 0, 1, 0x64]), 'call 0xf8a6 128 1 1 f26e2e00000500000005d70800016400');
    // replies seen on the car
    assert.deepStrictEqual(parse('0000000ff0f271010f0b40000662f1500f2680000f00000000'), { unit: 0x40, uds: [0x62, 0xf1, 0x50, 0x0f, 0x26, 0x80] });
    assert.deepStrictEqual(parse('0000000cf0f271010f0b6e00037f2e31000c00000000'), { unit: 0x6e, uds: [0x7f, 0x2e, 0x31] });
    assert.strictEqual(parse('zz'), null);
    // the queue: one at a time, pending extends, NRC rejects, the next one goes after
    const sent = [], hmi = (l) => { sent.push(l); return Promise.resolve('ok 00000001'); };
    const u = new Uds(hmi), out = [];
    const ev = (unit, bytes) => {
        const b = Buffer.concat([Buffer.from([0xf0, 0xf2, 0x71, 1, 0x0f, 0x0b, unit, 0, bytes.length]), Buffer.from(bytes)]);
        u.onEvent(SVC, EV, b.length.toString(16).padStart(8, '0') + b.toString('hex') + '000c00000000');
    };
    u.send(0x40, 0x22, [0xf1, 0x50]).then((r) => out.push(r));
    u.send(0x6e, 0x2e, [0xfd, 0xfd, 0]).catch((e) => out.push(e.code));
    setImmediate(() => {
        assert.strictEqual(sent.length, 1);
        ev(0x6e, [0x62, 0xf1, 0x50]);                  // another unit: not ours
        ev(0x40, [0x7f, 0x22, 0x78]);                  // pending
        ev(0x40, [0x62, 0xf1, 0x50, 0x0f, 0x26, 0x80]);
        setImmediate(() => {
            assert.strictEqual(sent.length, 2);
            ev(0x6e, [0x7f, 0x2e, 0x31]);
            setImmediate(() => {
                assert.deepStrictEqual(out, [[0x62, 0xf1, 0x50, 0x0f, 0x26, 0x80], 0x31]);
                clearTimeout(u.timer);
                console.log('uds ok');
            });
        });
    });
}
