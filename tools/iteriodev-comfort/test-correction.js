'use strict';
// Exercise the staged Mover with deterministic positions, replies and time.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Clock } = require('./test-clock');
const source = fs.readFileSync(path.join(__dirname, 'seat.js'), 'utf8');
const stationary = () => true;

function fixture() {
    const clock = new Clock({});
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        require: () => { throw new Error('No VM imports allowed'); },
        Date: class extends Date { static now() { return clock.now; } },
        setTimeout: (fn, ms) => clock.add(fn, ms),
        clearTimeout: id => clock.clear(id),
        setInterval: (fn, ms) => clock.add(fn, ms, ms),
        clearInterval: id => clock.clear(id)
    });
    let readings, failStops, stops, heldReading, readDelays, readIndex;
    const events = [], logs = [];
    const fake = { send: (unit, service, data) => new Promise((resolve, reject) => {
        assert.strictEqual(unit, 0x6e);
        const delay = service === 0x22 ? (readDelays[readIndex++] || 200) : 200;
        clock.add(() => {
            if (service === 0x10) return resolve([0x50, data[0]]);
            if (service === 0x22) {
                assert(readings.length || heldReading !== undefined, 'Unexpected position read');
                const count = readings.length ? readings.shift() : heldReading;
                if (count instanceof Error) return reject(count);
                events.push(['read', count]);
                return resolve([0x62, 0xd7, 0x02, count >> 8, count & 255, 0x80, 0x80]);
            }
            assert.strictEqual(service, 0x2e);
            events.push(['write', data[2], data[3]]);
            if (!data[3] && failStops.includes(++stops)) return reject(new Error('simulated missing STOP reply'));
            resolve([0x6e, 0xd7, 0x08]);
        }, delay);
    }) };
    const mover = new module.exports.Mover(fake, stationary);
    mover.traceAttempt = (seat, axis, fields) => logs.push(JSON.parse(JSON.stringify(Object.assign({ event: 'axis.attempt', seat, axis }, fields))));
    async function run(positions, target, options) {
        readings = positions.slice();
        events.length = logs.length = stops = 0;
        failStops = options && options.failStops || [];
        heldReading = options && options.heldReading;
        readDelays = options && options.readDelays || [];
        readIndex = 0;
        const argumentsTarget = options && options.otherAxis ? { SLV: target, SHV: 33000 } : { SLV: target };
        if (options && options.legacy) mover.pos.passenger.SLV = 33100; 
        const motion = options && options.legacy
            ? mover.drive('passenger', 'SLV', -1, () => null, {fast: true})
            : mover.recall('passenger', argumentsTarget, true);
        const result = await clock.run(motion);
        assert.strictEqual(!!mover.busy, false);
        assert.strictEqual(mover.motion, null);
        assert.strictEqual(readings.length, 0, 'Unconsumed position readings');
        return {
            result,
            commands: events.filter(event => event[0] === 'write').map(event => event.slice(1)),
            trace: logs.filter(event => event.event === 'axis.attempt')
        };
    }
    async function learn(direction, travel, count) {
        for (let i = 0; i < count; i++) {
            const start = 33100, end = start + direction * travel;
            const result = await run([start, end, end, end], end);
            assert.strictEqual(result.result, 'done');
        }
    }
    function ageSamples(ms) { for (const samples of Object.values(mover.pulseSamples)) for (const sample of samples) sample.at -= ms; }
    return { mover, run, learn, ageSamples };
}

const target = 32821;
const rearFirst = [32877, 32822, 32811, 32811];
const forwardFirst = [32797, 32823, 32833, 32833];
const rearward = [[0,2], [0,0], [0,0]];
const forward = [[0,1], [0,0], [0,0]];
async function cases() {
    let f = fixture();
    let result = await f.run(rearFirst, target);
    assert.strictEqual(result.result, 'short');
    assert.deepStrictEqual(result.commands, rearward);
    assert.strictEqual(result.trace[1].reason, 'reverse pulse estimate unavailable');

    f = fixture();
    await f.learn(1, 20, 3); // Matches the size of the measured Easy Exit correction.
    result = await f.run(rearFirst, target);
    assert.deepStrictEqual(result.commands, rearward);
    assert.strictEqual(result.trace[1].reason, 'reverse pulse may miss tolerance');
    assert.deepStrictEqual(result.trace[1].range, {min:18,max:22,samples:3});
    assert.deepStrictEqual(result.trace[1].landing, [2,18]);

    f = fixture();
    await f.learn(1, 10, 3); // Evidence in the opposite direction is ineligible.
    result = await f.run(forwardFirst, target);
    assert.deepStrictEqual(result.commands, forward);
    assert.strictEqual(result.trace[1].reason, 'reverse pulse estimate unavailable');

    f = fixture();
    await f.learn(1, 10, 2);
    result = await f.run(rearFirst, target);
    assert.deepStrictEqual(result.commands, rearward);
    assert.strictEqual(result.trace[1].reason, 'reverse pulse estimate unavailable');

    f = fixture();
    await f.learn(1, 10, 3);
    result = await f.run(rearFirst.concat([32816,32821,32821]), target);
    assert.strictEqual(result.result, 'done');
    assert.deepStrictEqual(result.commands, rearward.concat(forward));
    assert.strictEqual(result.trace[1].reversal, true);
    assert.strictEqual(result.trace[1].travel, 10);
    assert.strictEqual(result.trace[1].beforeStop, 32816);
    assert.strictEqual(result.trace[1].observedCoast, 5);
    assert.strictEqual(result.trace[1].settled, 32821);

    f = fixture();
    await f.learn(1, 10, 3);
    result = await f.run(rearFirst.concat([32825,32840,32840]), target);
    assert.strictEqual(result.result, 'short');
    assert.deepStrictEqual(result.commands, rearward.concat(forward)); // No second reversal.

    f = fixture();
    await f.learn(1, 10, 3);
    f.ageSamples(600001);
    result = await f.run(rearFirst, target);
    assert.deepStrictEqual(result.commands, rearward);
    assert.strictEqual(result.trace[1].reason, 'reverse pulse estimate unavailable');

    for (const failStops of [[1], [2], [1,2]]) {
        f = fixture();
        await f.learn(1, 10, 3);
        result = await f.run(rearFirst.slice(0,2), target, { failStops, otherAxis:true });
        assert.strictEqual(result.result, 'STOP unconfirmed');
        assert.deepStrictEqual(result.commands, rearward); // No reversal or write to the remaining axis.
        assert.strictEqual(result.trace[0].stopFailures, failStops.length);
        assert.strictEqual(result.trace[0].stopReplies, 2 - failStops.length);
    }

    f = fixture();
    await f.learn(1, 10, 3);
    result = await f.run(rearFirst.concat([32816]), target, { failStops:[3,4], otherAxis:true });
    assert.strictEqual(result.result, 'STOP unconfirmed');
    assert.deepStrictEqual(result.commands, rearward.concat(forward));
    assert.strictEqual(result.trace[1].stopFailures, 2);
    assert.strictEqual(result.trace[1].stopReplies, 0);
    f = fixture();
    result = await f.run([33100,33075], 32950, {heldReading:33075, failStops:[1,2], otherAxis:true});
    assert.strictEqual(result.result, 'STOP unconfirmed');
    const firstStop = result.commands.findIndex(command => command[1] === 0);
    assert(firstStop >= 1);
    assert.deepStrictEqual(result.commands.slice(firstStop), [[0,0], [0,0]]);

    f = fixture();
    result = await f.run([33100,33075,33065], 32950, {readDelays:[200,200,1600], otherAxis:true});
    assert.strictEqual(result.result, 'position feedback lost');
    assert.deepStrictEqual(result.commands.slice(1), [[0,0],[0,0]]);
    assert.strictEqual(result.trace[0].progress.largestGapMs, 1601);

    f = fixture();
    result = await f.run([33100,new Error('simulated read timeout')], 32950, {otherAxis:true});
    assert.strictEqual(result.result, 'position feedback lost');
    assert.deepStrictEqual(result.commands, rearward);
    assert.strictEqual(result.trace[0].progress.error, 'simulated read timeout');

    f = fixture();
    result = await f.run([0], 32950, {otherAxis:true});
    assert.strictEqual(result.result, 'position feedback lost');
    assert.deepStrictEqual(result.commands, []);

    f = fixture();
    result = await f.run([33100], 33050, {heldReading:33057});
    assert.strictEqual(result.result, 'done');
    assert.strictEqual(result.trace[0].reason, 'no progress');
    assert.strictEqual(result.trace[0].firstSettled, 33057);
    assert.strictEqual(result.trace[0].settled, 33057);

    f = fixture();
    // Throw on the first post-STOP read. The second is valid but cannot confirm settling alone.
    result = await f.run([33100,33057,33057,33057,33057,33057,new Error('first settle timeout'),33057],
        33050, {otherAxis:true});
    assert.strictEqual(result.result, 'position feedback lost');
    assert.strictEqual(result.trace[0].reason, 'no progress');
    assert.strictEqual(result.trace[0].settled, 33057);
    assert(result.commands.every(command => command[0] === 0));

    f = fixture();
    result = await f.run([33100], 32950, {heldReading:33070, legacy:true});
    assert.strictEqual(result.result, 'end stop'); // Direct drive paths still use their original behavior.
    assert.deepStrictEqual(result.trace, []);

    f = fixture();
    result = await f.run([33100,33099,33101,33099,33101], 32950, {heldReading:33100, otherAxis:true});
    assert.strictEqual(result.result, 'never started');
    assert.strictEqual(result.trace[0].progress.motionObserved, false);
    assert(result.commands.every(command => command[0] === 0));
    const lastMotion = result.commands.findIndex(command => command[1] === 0);
    assert.deepStrictEqual(result.commands.slice(lastMotion), [[0,0],[0,0]]);

    console.log('19 end-to-end reversal, feedback and STOP scenarios passed with fake transport');
}
cases().catch(err => { console.error(err); process.exitCode = 1; });
