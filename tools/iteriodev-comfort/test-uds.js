"use strict";
// Dependency-free Node 8 tests. All gateway replies, helper ACKs and timers are fake.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const source = path.resolve(process.argv[2] || path.join(__dirname, 'uds.js'));
let checks = 0;
const equal = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); checks++; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(manualAck) {
    let now = 0, sequence = 0;
    const timers = [], wire = [], acks = [], module = { exports: {} };
    function timeout(fn, ms) { const timer = { fn, at: now + ms, id: ++sequence, active: true }; timers.push(timer); return timer; }
    function clear(timer) { if (timer) timer.active = false; }
    vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
        module, require, Buffer, console, process: { argv: [] }, setTimeout: timeout, clearTimeout: clear
    }, { filename: source });
    const api = module.exports;
    const u = new api.Uds(line => {
        wire.push(line);
        return manualAck ? new Promise((resolve, reject) => acks.push({ resolve, reject })) : Promise.resolve('ok');
    });
    const event = (unit, bytes, service, eventId) => {
        const b = Buffer.concat([Buffer.from([0xf0, 0xf2, 0x71, 1, 0x0f, 0x0b, unit, 0, bytes.length]), Buffer.from(bytes)]);
        u.onEvent(service === undefined ? api.SVC : service, eventId === undefined ? api.EV : eventId,
            b.length.toString(16).padStart(8, '0') + b.toString('hex') + '000c00000000');
    };
    const advance = async ms => {
        await flush(); const end = now + ms;
        for (let i = 0; i < 100; i++) {
            const next = timers.filter(t => t.active && t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!next) { now = end; await flush(); return; }
            now = next.at; next.active = false; next.fn(); await flush();
        }
        throw Error('Unbounded fake timer loop');
    };
    const observed = promise => promise.then(value => ({ ok: true, value: Array.from(value) }),
        error => ({ ok: false, message: error.message, code: error.code }));
    const done = () => { equal(u.cur, null, 'no active request remains'); equal(u.q.length, 0); equal(timers.filter(t => t.active).length, 0); };
    return { api, u, wire, acks, event, advance, observed, done };
}
const cases = [];
const test = (name, run) => cases.push({ name, run });
test('existing gateway encoding and parsing', async () => {
    const t = fixture();
    equal(Object.keys(t.api).sort().join(','), 'EV,SUB,SVC,Uds,line,parse', 'public exports unchanged');
    equal(t.api.line(0x40, 0x22, [0xf1, 0x50]), 'call 0xf8a6 128 1 1 f2402200000200000002f15000');
    equal(JSON.stringify(t.api.parse('0000000ff0f271010f0b40000662f1500f2680000f00000000')),
        JSON.stringify({ unit: 0x40, uds: [0x62, 0xf1, 0x50, 0x0f, 0x26, 0x80] }));
    t.done();
});
test('malformed or truncated gateway frames are ignored', async () => {
    const t = fixture();
    [null, undefined, 123, {}, '', 'zz', '00000000z0', '000000000', '00000020f0f271010f0b6d000362d702'].forEach(hex => equal(t.api.parse(hex), null));
    const p = t.observed(t.u.send(0x6d, 0x22, [0xd7, 2])); await flush();
    t.u.onEvent(t.api.SVC, t.api.EV, '00000020f0f271010f0b6d000362d702');
    equal(t.u.cur !== null, true); t.event(0x6d, [0x62, 0xd7, 2]); equal((await p).ok, true); t.done();
});
test('positive read and write replies must echo the requested DID', async () => {
    for (const sid of [0x22, 0x2e]) {
        const t = fixture(); const p = t.observed(t.u.send(0x6d, sid, [0xd7, 8, 0, 0, 0])); await flush();
        t.event(0x6d, [sid + 0x40, 0xd7]); equal(t.u.cur !== null, true, 'short DID');
        t.event(0x6d, [sid + 0x40, 0xd7, 2]); equal(t.u.cur !== null, true, 'different DID');
        t.event(0x6d, [sid + 0x40, 0xd7, 8]); equal((await p).ok, true); t.done();
    }
});
test('session echo matches with suppress-positive-response bit masked', async () => {
    const t = fixture(); const p = t.observed(t.u.send(0x6d, 0x10, [0x83])); await flush();
    t.event(0x6d, [0x50, 1]); equal(t.u.cur !== null, true);
    t.event(0x6d, [0x50, 3]); equal((await p).ok, true); t.done();
});
test('wrong target, service and event cannot finish the active request', async () => {
    const t = fixture(); const p = t.observed(t.u.send(0x6d, 0x22, [0xd7, 2])); await flush();
    t.event(0x6e, [0x62, 0xd7, 2]); t.event(0x6d, [0x6e, 0xd7, 2]);
    t.event(0x6d, [0x62, 0xd7, 2], 0x1234); t.event(0x6d, [0x62, 0xd7, 2], undefined, 0x8002);
    equal(t.u.cur !== null, true); t.event(0x6d, [0x62, 0xd7, 2]); equal((await p).ok, true); t.done();
});
test('pending before helper ACK preserves ten-second timeout', async () => {
    const t = fixture(true); const p = t.observed(t.u.send(0x6d, 0x22, [0xd7, 2], 500));
    t.event(0x6d, [0x7f, 0x22, 0x78]); await t.advance(100);
    t.acks[0].resolve('ok'); await flush(); await t.advance(5000);
    equal(t.u.cur !== null, true, 'late ACK must not shorten pending timer');
    await t.advance(4899); equal(t.u.cur !== null, true);
    await t.advance(1); equal((await p).code, 'timeout'); equal(t.wire.length, 1); t.done();
});
test('pending after ACK extends timeout and can finish normally', async () => {
    const t = fixture(); const p = t.observed(t.u.send(0x6d, 0x22, [0xd7, 2])); await flush();
    await t.advance(2900); t.event(0x6d, [0x7f, 0x22, 0x78]); await t.advance(5000);
    equal(t.u.cur !== null, true); t.event(0x6d, [0x62, 0xd7, 2]); equal((await p).ok, true); t.done();
});
test('STOPs bypass queued reads in FIFO order without preempting active work', async () => {
    const t = fixture(); const block = t.observed(t.u.send(0x40, 0x22, [0xf1, 0x50]));
    const data = [0xd7, 2]; const read = t.observed(t.u.send(0x6d, 0x22, data)); data[1] = 0;
    const stopA = t.observed(t.u.send(0x6d, 0x2e, [0xd7, 8, 0, 0, 0]));
    const stopB = t.observed(t.u.send(0x6e, 0x2e, [0xd7, 8, 1, 0, 0]));
    const columnStop = t.observed(t.u.send(0x40, 0x2e, [0xd0, 0x72, 0, 0]));
    equal(t.wire.length, 1); await flush(); t.event(0x40, [0x62, 0xf1, 0x50]); await block;
    equal(t.wire[1], t.api.line(0x6d, 0x2e, [0xd7, 8, 0, 0, 0]));
    t.event(0x6d, [0x6e, 0xd7, 8]); await stopA;
    equal(t.wire[2], t.api.line(0x6e, 0x2e, [0xd7, 8, 1, 0, 0]));
    t.event(0x6e, [0x6e, 0xd7, 8]); await stopB;
    equal(t.wire[3], t.api.line(0x40, 0x2e, [0xd0, 0x72, 0, 0]));
    t.event(0x40, [0x6e, 0xd0, 0x72]); await columnStop;
    equal(t.wire[4], t.api.line(0x6d, 0x22, [0xd7, 2]), 'queued data was copied');
    t.event(0x6d, [0x62, 0xd7, 2]); await read; t.done();
});
test('ordinary motor and column writes retain FIFO order', async () => {
    const t = fixture(); const a = t.observed(t.u.send(0x40, 0x22, [0xf1, 0x50]));
    const read = t.observed(t.u.send(0x6d, 0x22, [0xd7, 2]));
    const move = t.observed(t.u.send(0x6d, 0x2e, [0xd7, 8, 0, 1, 100]));
    const column = t.observed(t.u.send(0x40, 0x2e, [0xd0, 0x72, 1, 0]));
    t.event(0x40, [0x62, 0xf1, 0x50]); await a;
    equal(t.wire[1], t.api.line(0x6d, 0x22, [0xd7, 2])); t.event(0x6d, [0x62, 0xd7, 2]); await read;
    equal(t.wire[2], t.api.line(0x6d, 0x2e, [0xd7, 8, 0, 1, 100])); t.event(0x6d, [0x6e, 0xd7, 8]); await move;
    equal(t.wire[3], t.api.line(0x40, 0x2e, [0xd0, 0x72, 1, 0])); t.event(0x40, [0x6e, 0xd0, 0x72]); await column; t.done();
});
test('negative UDS and gateway errors reject without write replay', async () => {
    const t = fixture(); const p = t.observed(t.u.send(0x6d, 0x2e, [0xd7, 8, 0, 1, 100])); await flush();
    t.event(0x6d, [0x7f, 0x22, 0x31]); equal(t.u.cur !== null, true);
    t.event(0x6d, [0x7f, 0x2e, 0x31]); equal((await p).code, 0x31); equal(t.wire.length, 1); t.done();
    const g = fixture(); const gp = g.observed(g.u.send(0x6d, 0x22, [0xd7, 2]));
    g.u.onEvent(g.api.SVC, g.api.EV, '00000005f0f27f0131'); equal((await gp).code, 0x31); g.done();
});
test('helper promise rejection rejects current request and advances queue', async () => {
    const t = fixture(true); const a = t.observed(t.u.send(0x6d, 0x22, [0xd7, 2]));
    const b = t.observed(t.u.send(0x6e, 0x22, [0xd7, 2]));
    t.acks[0].reject(Error('helper unavailable')); await flush();
    equal(t.u.cur && t.u.cur.target, 0x6e); equal((await a).message, 'helper unavailable'); equal(t.wire.length, 2);
    t.acks[1].resolve('ok'); await flush(); t.event(0x6e, [0x62, 0xd7, 2]); equal((await b).ok, true); t.done();
});
test('late ACK from completed request cannot arm the next request timer', async () => {
    const t = fixture(true); const a = t.observed(t.u.send(0x6d, 0x22, [0xd7, 2]));
    const b = t.observed(t.u.send(0x6e, 0x22, [0xd7, 2], 7000));
    t.event(0x6d, [0x62, 0xd7, 2]); await a; t.acks[1].resolve('ok'); await flush();
    await t.advance(100); t.acks[0].resolve('ok'); await flush(); await t.advance(4000);
    equal(t.u.cur !== null, true); t.event(0x6e, [0x62, 0xd7, 2]); equal((await b).ok, true); t.done();
});
test('timeout advances to queued STOP without retrying motor write', async () => {
    const t = fixture(); const move = t.observed(t.u.send(0x6d, 0x2e, [0xd7, 8, 0, 1, 100], 100));
    const stop = t.observed(t.u.send(0x6d, 0x2e, [0xd7, 8, 0, 0, 0]));
    await t.advance(100); equal((await move).code, 'timeout'); equal(t.wire.length, 2);
    equal(t.wire[1], t.api.line(0x6d, 0x2e, [0xd7, 8, 0, 0, 0]));
    t.event(0x6d, [0x6e, 0xd7, 8]); await stop; equal(t.wire.length, 2); t.done();
});
// Attach before a deliberate rejected-helper test so baseline comparisons report the
// missing rejection handler as a failed case rather than leaking a process warning.
const unhandled = [];
process.on('unhandledRejection', error => unhandled.push(error.message));
(async () => {
    const results = [];
    for (const c of cases) {
        try { await c.run(); results.push({ name: c.name, pass: true }); }
        catch (error) { results.push({ name: c.name, pass: false, error: error.message }); }
    }
    // Allow the unhandled-rejection bookkeeping one event-loop turn.
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify({ node: process.version, assertions: checks, source,
        cases: results, unhandledRejections: unhandled, vehicleIO: false }, null, 2));
    if (results.some(r => !r.pass) || unhandled.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
