'use strict';
// 0.6.6: the control socket's diag op - any read (22 + 2-byte DID, any unit), writes only the ambient light's. Node 8.
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, 'comfort.js'), 'utf8'), a = src.indexOf('function diagAllowed('),
    m = /\r?\n\}\r?\n/.exec(src.slice(a)), b = a + m.index + m[0].length;   // CRLF or LF
const ctx = {};
vm.runInNewContext(`${src.slice(a, b)}\nthis.f = diagAllowed;`, ctx);
const ok = (target, sid, data) => ctx.f({ target, sid, data });
assert.strictEqual(ok(0x07, 0x22, [0xdd, 0xbc]), true, 'the SME battery %');
assert.strictEqual(ok(0x12, 0x22, [0x40, 0x0a]), true, 'a DME read (boost)');
assert.strictEqual(ok(0x10, 0x22, [0xf1, 0x90]), true, 'the VIN');
assert.strictEqual(ok(0x40, 0x22, [0xda, 0x5f]), true, 'the ambient table, as before');
assert.strictEqual(ok(0x40, 0x22, [0xda]), false, 'a 1-byte DID');
assert.strictEqual(ok(0x100, 0x22, [0xf1, 0x90]), false, 'no such unit');
assert.strictEqual(ok(0x60, 0x11, [0x01]), false, 'no reset');
assert.strictEqual(ok(0x12, 0x2e, [0x40, 0x0a, 0]), false, 'no other write');
assert.strictEqual(ok(0x40, 0x2e, [0xda, 0x5e, 1, 1, 100, 0, 0, 254, 254]), true, 'the ambient write, as before');
assert.strictEqual(ok(0x40, 0x22, [0xda, 300]), false, 'bytes 0-255 only');
console.log('diag allowed ok');
