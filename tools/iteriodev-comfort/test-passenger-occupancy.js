'use strict';
const assert = require('assert');
const { PassengerOccupancy, crc, FRESH_MS } = require('./passenger-occupancy');

let now = 1000;
const samples = new PassengerOccupancy(() => now);
function frame(counter, occupied) {
    const bytes = Buffer.from([0, counter, 0, occupied ? 12 : 0, 0, 0, 0]);
    bytes[0] = crc(bytes);
    return bytes.toString('hex');
}
assert.strictEqual(samples.view().ready, false);
samples.event(frame(1, true));
assert.strictEqual(samples.view().ready, false);
samples.event(frame(2, true));
assert.strictEqual(samples.view().classification, 'occupied');
samples.event(frame(3, false));
assert.strictEqual(samples.view().classification, 'empty');
now += FRESH_MS;
assert.strictEqual(samples.view().ready, false);
samples.event(frame(4, true));
samples.event(frame(5, true));
samples.event('ff');
assert.strictEqual(samples.view().ready, false);
console.log('Passenger occupancy freshness and invalidation passed');
