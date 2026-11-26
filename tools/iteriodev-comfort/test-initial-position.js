'use strict';
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const text = fs.readFileSync(require('path').join(__dirname, 'comfort.js'), 'utf8');
const start = text.indexOf('async function initialPosition(');
const helper = vm.runInNewContext(text.slice(start, text.indexOf('function main()', start)) + '\ninitialPosition;');
async function run() {
    const refusal = Error('refused by the gateway');
    let reads = 0, permit = true;
    const read = () => { if (++reads === 1) throw refusal; return 33000; };
    assert.strictEqual(await helper(read, () => permit, ms => assert.strictEqual(ms, 150)), 33000);
    assert.strictEqual(reads, 2);
    reads = 0;
    try { await helper(read, () => permit, () => { permit = false; }); assert.fail('should reject'); }
    catch (err) { assert.strictEqual(err, refusal); }
    assert.strictEqual(reads, 1);
    const timeout = Error('no answer');
    try { await helper(() => { throw timeout; }, () => true, () => assert.fail('unexpected retry')); assert.fail('should reject'); }
    catch (err) { assert.strictEqual(err, timeout); }
    console.log('Guarded initial read retry passed');
}
run().catch(err => { console.error(err); process.exitCode = 1; });
