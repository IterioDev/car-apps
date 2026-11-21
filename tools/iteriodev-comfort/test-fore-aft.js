'use strict';
// Exercise the unmodified Mover with virtual time and a fake diagnostic transport.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Clock } = require('./test-clock');
const sourcePath = path.resolve(__dirname, 'seat.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const cases = [
    { name: 'normal travel', rate: 150 },
    { name: 'slow continuous travel', rate: 8 },
    { name: 'moves then plateaus', rate: 150, floor: 33050 },
    { name: 'never starts', rate: 0 },
    { name: 'position feedback lost', rate: 150, loseAfterMs: 450 },
    { name: 'plateau with no STOP acknowledgement', rate: 150, floor: 33050, loseStopReplies: true }
];

async function replay(spec, rtt) {
    const clock = new Clock({});
    const epoch = clock.now;
    const start = 33100;
    const target = 32950;
    let last = epoch;
    let position = start;
    let direction = 0;
    let firstMove = null;
    let attempts = 0;
    let restarts = 0;
    let stopWrites = 0;
    let firstStop = null;
    let stopAcks = 0;
    let absentReads = 0;
    const reasons = [];
    const events = [];
    const tick = () => {
        position = Math.max(spec.floor === undefined ? -Infinity : spec.floor,
            position + direction * spec.rate * (clock.now - last) / 1000);
        last = clock.now;
    };

    const fake = {
        send: (unit, service, data, unusedTimeout, unusedCleanup, permission) => new Promise((resolve, reject) => {
            assert.strictEqual(unit, 0x6e);
            const blocked = permission && permission();
            if (blocked) return reject(new Error(blocked));
            clock.add(() => {
                tick();
                let reply;
                let loseReply = false;
                if (service === 0x22) {
                    assert.deepStrictEqual(Array.from(data), [0xd7, 0x02]);
                    const missing = spec.loseAfterMs && firstMove !== null && clock.now - firstMove >= spec.loseAfterMs;
                    const reading = missing ? 0 : Math.round(position);
                    if (missing) absentReads++;
                    reply = [0x62, 0xd7, 0x02, reading >> 8, reading & 255];
                    while (reply.length < 19) reply.push(0);
                    events.push({ ms: clock.now - epoch, reading: missing ? null : reading });
                } else if (service === 0x2e) {
                    assert.deepStrictEqual(Array.from(data).slice(0, 3), [0xd7, 0x08, 0]);
                    const action = data[3];
                    if (action === 0) {
                        if (firstStop === null) firstStop = clock.now;
                        stopWrites++;
                        direction = 0;
                        loseReply = !!spec.loseStopReplies;
                    } else {
                        const next = action === 1 ? 1 : -1;
                        if (direction === 0) {
                            attempts++;
                            if (stopWrites && next === -1) restarts++;
                        }
                        direction = next;
                        if (firstMove === null) firstMove = clock.now;
                    }
                    events.push({ ms: clock.now - epoch, action, position: Math.round(position) });
                    reply = [0x6e, 0xd7, 0x08];
                } else {
                    assert.strictEqual(service, 0x10);
                    reply = [0x50, data[0]];
                }
                clock.add(() => {
                    if (loseReply) return reject(new Error('simulated STOP reply missing'));
                    if (service === 0x2e && data[3] === 0) stopAcks++;
                    resolve(reply);
                }, rtt / 2);
            }, rtt / 2);
        })
    };

    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        require: () => { throw new Error('No VM imports allowed'); },
        Date: class extends Date { static now() { return clock.now; } },
        setTimeout: (f, ms) => clock.add(f, ms),
        clearTimeout: id => clock.clear(id),
        setInterval: (f, ms) => clock.add(f, ms, ms),
        clearInterval: id => clock.clear(id)
    }, { filename: 'local-seat.js' });
    const mover = new module.exports.Mover(fake, () => true, msg => {
        if (/^passenger SLV [+-]:/.test(msg)) reasons.push(msg.split(': ')[1]);
    });
    const outcome = await clock.run(mover.recall('passenger', { SLV: target }, true));
    tick();
    clock.clear(mover.idle);
    assert.strictEqual(direction, 0, 'Virtual motor left active');
    assert.strictEqual(mover.busy, false);
    assert.strictEqual(mover.motion, null);
    return {
        scenario: spec.name, rttMs: rtt, outcome, target, firstStopMsAfterStart: firstStop - firstMove,
        finalVirtualPosition: Math.round(position), attempts, rearwardRestartsAfterStop: restarts,
        stopWrites, stopAcks, stopFailures: mover.stopFailures, absentReads, reasons, events
    };
}

function evaluateRegression(spec, run) {
    const expectation = [];
    const check = (description, ok) => expectation.push({ description, ok });
    const noNewMotionAfterStop = run.attempts === 1;
    const stall = run.reasons.some(reason => /end stop|no progress|never started/.test(reason));
    if (spec.name === 'normal travel') {
        check('normal travel approaches the target without a stall', run.finalVirtualPosition < 33000 && !stall);
    } else if (spec.name === 'slow continuous travel') {
        check('slow travel reaches tolerance without a false stall', Math.abs(run.finalVirtualPosition - run.target) <= 8 && !stall);
        check('no restart after STOP', noNewMotionAfterStop);
    } else if (spec.loseStopReplies) {
        check('recall reports unconfirmed STOP', run.outcome === 'STOP unconfirmed');
        check('no new movement after unconfirmed STOP', noNewMotionAfterStop);
        check('missing replies are counted', run.stopWrites > 0 && run.stopAcks === 0 && run.stopFailures === run.stopWrites);
    } else if (spec.loseAfterMs) {
        check('missing feedback ends the recall', run.outcome === 'position feedback lost' && run.absentReads > 0);
        check('no restart after lost feedback', noNewMotionAfterStop);
    } else {
        const expected = spec.rate === 0 ? 'never started' : 'no progress';
        check('recall reports ' + expected, run.outcome === expected);
        check('no restart after STOP', noNewMotionAfterStop);
    }
    return expectation;
}

(async () => {
    const results = [];
    for (const rtt of [150, 200, 300]) {
        for (const spec of cases) {
            const r = await replay(spec, rtt);
            r.expectations = evaluateRegression(spec, r);
            r.passed = r.expectations.every(expectation => expectation.ok);
            results.push(r);
        }
    }
    console.log(JSON.stringify({ node: process.version,
        sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), results }, null, 2));
    if (results.some(run => !run.passed)) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
