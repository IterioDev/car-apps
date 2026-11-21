"use strict";
// Node 8, fake gateway and virtual time only. Never starts Comfort or its native helper.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ambient = require('./ambient');
const source = path.resolve(process.argv[2] || path.join(__dirname, 'comfort.js'));
const service = fs.readFileSync(source, 'utf8');
const start = service.indexOf('    /* ---- ambient ---- */'), end = service.indexOf('    /* ---- seats ---- */');
assert.ok(start >= 0 && end > start, 'ambient implementation boundaries');
let checks = 0;
const eq = (a, b, message) => { assert.deepStrictEqual(a, b, message); checks++; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(options) {
    options = options || {};
    let now = 100000, sequence = 0;
    const timers = [], calls = [], logs = [], module = { exports: {} };
    const data = { ambient: ambient.settings(null, { on: options.on === undefined ? false : options.on, rgb: [7, 8, 9], bright: 50 }) };
    const car = { mode: 1, ambientOn: true };
    const state = { inside: true, read: options.read };
    const buses = [{ name: 'lin1', read: [1, 1] }, { name: 'lin2', read: [1, 2] }];
    const context = { module, shuttingDown: false, READ_MS: 15000, Date: class extends Date { static now() { return now; } }, data, car,
        setTimeout: (fn, ms) => { const t = { fn, at: now + ms, id: ++sequence, active: true }; timers.push(t); return t; },
        clearTimeout: t => { if (t) t.active = false; },
        inCar: () => state.inside, push: () => {}, save: () => {}, log: line => logs.push(line),
        diag: { send: async (unit, sid, payload) => {
            calls.push({ unit, sid, payload: Array.from(payload), at: now });
            if (sid !== 0x22) return [];
            if (state.read) return state.read(payload);
            throw Object.assign(Error('no answer'), { code: 'timeout' });   // as uds.js's timeout
        } },
        amb: { BUSES: buses, BDC: 64,
            effective: ambient.effective, settings: ambient.settings,
            parse: modules => modules, split: modules => modules,
            key: m => m.bus + '.' + m.nad,
            plan: (modules, settings) => modules.map(m => ({ m, off: !settings.on, rgb: settings.rgb, bright: settings.bright })),
            release: m => [m.nad, 0, 0], frame: (m, rgb, bright) => [m.nad, rgb[0], bright]
        }
    };
    vm.runInNewContext(service.slice(start, end) + '\nmodule.exports = { light, lightSoon, state: () => ({ lit, writing, force, modules: mods, oem }) };', context, { filename: source });
    const advance = async ms => {
        await flush(); const until = now + ms;
        for (let i = 0; i < 1000; i++) {
            const t = timers.filter(t => t.active && t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!t) { now = until; await flush(); return; }
            now = t.at; t.active = false; t.fn(); await flush();
        }
        throw Error('unbounded virtual timer loop');
    };
    const apply = async renew => { const pending = module.exports.light(renew); await advance(500); await pending; };
    const reads = () => calls.filter(c => c.sid === 0x22);
    const writes = () => calls.filter(c => c.sid === 0x2e);
    return { data, car, state, calls, logs, api: module.exports, advance, apply, reads, writes };
}
const modules = payload => [{ bus: 'lin' + payload[1], nad: payload[1], name: 'fixture', zone: 'front', bright: 30 }];
const cases = [];
const test = (name, run) => cases.push({ name, run });
// 0.6.3 (customer M8 2026-11-19: off, the app listed no zones): off, the lights are looked for once (both buses), never
// again, nothing written
test('disabled startup discovers once, no retries over one minute', async () => {
    const t = fixture(); await t.apply(true); await t.advance(60000);
    eq(t.reads().length, 2); eq(t.writes().length, 0); eq(t.api.state().writing, false);
});
test('repeated disabled renewals and scheduled UI updates do not discover again', async () => {
    const t = fixture(); for (let i = 0; i < 4; i++) await t.apply(true);
    t.api.lightSoon(); await t.advance(1000); eq(t.reads().length, 2); eq(t.api.state().force, false);
});
test('enabled override still discovers and retries missing buses', async () => {
    const t = fixture({ on: true }); await t.apply(true); eq(t.reads().length, 2);
    await t.advance(20000); eq(t.reads().length, 4); eq(t.logs.some(x => x.indexOf('no answer') >= 0), true);
});
test('disabling override prevents previously scheduled discovery retries', async () => {
    const t = fixture({ on: true }); await t.apply(true); t.data.ambient.on = false;
    await t.advance(60000); eq(t.reads().length, 2); eq(t.writes().length, 0); eq(t.api.state().lit, false);
});
test('hardware light OFF and absent cabin readiness: one discovery, no writes, no retries', async () => {
    const a = fixture({ on: true }); a.car.ambientOn = false; await a.apply(true); await a.advance(60000); eq([a.reads().length, a.writes().length], [2, 0]);
    const b = fixture({ on: true }); b.state.inside = false; await b.apply(true); await b.advance(60000); eq([b.reads().length, b.writes().length], [2, 0]);
});
test('losing hardware/readiness prevents pending rediscovery', async () => {
    for (const reason of ['hardware', 'cabin']) {
        const t = fixture({ on: true }); await t.apply(true);
        if (reason === 'hardware') t.car.ambientOn = false; else t.state.inside = false;
        await t.advance(60000); eq(t.reads().length, 2);
    }
});
test('enabling later still discovers and writes normally', async () => {
    const t = fixture({ read: modules }); await t.apply(true); eq([t.reads().length, t.writes().length], [2, 0]);
    t.data.ambient.on = true; await t.apply(true); eq(t.reads().length, 2); eq(t.writes().length, 2); eq(t.api.state().lit, true);
});
test('drive-mode override is evaluated before deciding to discover', async () => {
    const t = fixture({ read: modules }); t.data.ambient.modes = { on: true, rgb: { 1: [10, 20, 30] } };
    await t.apply(true); eq(t.reads().length, 2); eq(t.writes().length, 2);
});
test('settings changed during awaited discovery prevent unwanted writes', async () => {
    let resolveRead;
    const t = fixture({ on: true, read: payload => payload[1] === 1 ? new Promise(resolve => { resolveRead = resolve; }) : modules(payload) });
    const pending = t.api.light(true); await flush(); eq(t.reads().length, 1);
    t.data.ambient.on = false; resolveRead(modules([1, 1])); await pending;
    eq(t.writes().length, 0); eq(t.api.state().lit, false); eq(t.api.state().writing, false);
});
test('latest settings are used after discovery completes', async () => {
    let resolveRead;
    const t = fixture({ on: true, read: payload => payload[1] === 1 ? new Promise(resolve => { resolveRead = resolve; }) : modules(payload) });
    const pending = t.api.light(true); await flush(); t.data.ambient.rgb = [9, 9, 9];
    resolveRead(modules([1, 1])); await pending; eq(t.writes().length, 2); eq(t.writes().every(c => c.payload[1] === 9), true);
});
test('pending partial-discovery retry releases known outputs after disabling', async () => {
    const t = fixture({ on: true, read: payload => { if (payload[1] === 2) throw Error('missing bus'); return modules(payload); } });
    await t.apply(true); eq(t.writes().length, 1); eq(t.api.state().lit, true);
    t.data.ambient.on = false;
    t.state.read = () => { throw Error('both buses now unavailable'); };
    // Let the retry be the next caller: keep the known module even if rediscovery would now fail.
    await t.advance(20000); eq(t.reads().length, 2); eq(t.writes().length, 2);
    eq(t.writes()[1].payload.join(','), '1,0,0'); eq(t.api.state().lit, false); eq(t.api.state().oem['lin1.1'], 30);
});
test('explicit OFF releases owned modules without new discovery', async () => {
    const t = fixture({ on: true, read: modules }); await t.apply(true); t.data.ambient.on = false;
    await t.apply(true); eq(t.reads().length, 2); eq(t.writes().length, 4);
    eq(t.writes().slice(2).every(c => c.payload[1] === 0 && c.payload[2] === 0), true); eq(t.api.state().lit, false);
});
// 0.6.4 (customer M8 2026-11-20): the buses silent at a start while off (car asleep) -> 0 modules all boot
test('buses silent while off: looked for again once wanted', async () => {
    const t = fixture(); await t.apply(true); eq([t.reads().length, t.api.state().modules.length], [2, 0]);
    await t.advance(3600000); eq(t.reads().length, 2);                // off: no looking meanwhile
    t.state.read = modules; t.data.ambient.on = true; await t.apply(true);
    eq(t.reads().length, 4); eq(t.writes().length, 2); eq(t.api.state().lit, true);
    await t.advance(120000); await t.apply(true); eq(t.reads().length, 4);  // all buses answered: no more looking
});
// 0.6.5 (customer M8 2026-11-20): front footwells "faulty" from a read while the car was off, clean later
const faulty = (n) => (payload) => [{ bus: 'lin' + payload[1], nad: payload[1], name: 'fixture', zone: 'front', bright: 30,
    fault: payload[1] === 1 && n-- > 0, faults: payload[1] === 1 && n >= 0 ? ['open load'] : [] }];
test('a fault from the search is read again once, 30 s after the lights are on', async () => {
    const t = fixture({ on: true, read: faulty(1) }); await t.apply(true);
    eq([t.reads().length, t.writes().length, t.api.state().modules[0].fault], [2, 2, true]);
    await t.advance(29000); eq(t.reads().length, 2);
    await t.advance(2000); eq(t.reads().length, 3);                   // only the bus with the faulty light
    eq(t.api.state().modules.map((m) => m.fault).join(), 'false,false'); eq(t.logs.some((x) => /lin1\.1 fixture: no fault now/.test(x)), true);
    await t.advance(600000); await t.apply(true); eq(t.reads().length, 3);   // once
});
test('no fault, or the lights off: no fault read', async () => {
    const a = fixture({ on: true, read: modules }); await a.apply(true); await a.advance(120000); eq(a.reads().length, 2);
    const b = fixture({ read: faulty(1) }); await b.apply(true); await b.advance(120000); eq(b.reads().length, 2);
    eq(b.api.state().modules[0].fault, true);                         // off: the search's flag stays
});
test('a fault still there after the read stays, with its kind logged', async () => {
    const t = fixture({ on: true, read: faulty(9) }); await t.apply(true); await t.advance(31000);
    eq([t.reads().length, t.api.state().modules[0].fault], [3, true]); eq(t.logs.some((x) => /fault \(open load\)/.test(x)), true);
});
test('unchanged enabled output stays deduplicated and renew still writes', async () => {
    const t = fixture({ on: true, read: modules }); await t.apply(true); await t.apply(false);
    eq(t.reads().length, 2); eq(t.writes().length, 2);
    await t.apply(true); eq(t.reads().length, 2); eq(t.writes().length, 4);
});
(async () => {
    const results = [];
    for (const c of cases) {
        try { await c.run(); results.push({ name: c.name, pass: true }); }
        catch (error) { results.push({ name: c.name, pass: false, error: error.message }); }
    }
    console.log(JSON.stringify({ node: process.version, source, assertions: checks, cases: results, vehicleIO: false }, null, 2));
    if (results.some(x => !x.pass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
