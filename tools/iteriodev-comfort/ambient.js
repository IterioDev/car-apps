'use strict';
/*
 * ambient.js - iteriodev-comfort: any colour on the interior ambient light, per module, through the body controller
 * (BDC, 0x40, SGBD BDC_G05) - the workshop jobs INNENLICHT_FI_LIN_1_LAYERING(_STEUERN) / _FI_LIN_2_LAYERING (car-tested
 * on mgu-m4 2026-11-07: all 8 modules green for 30 s from the head unit, then back by themselves). Pure: replies in,
 * request bytes out; comfort.js sends them.
 *   read   22 DA 5F (LIN 1) / 22 E3 D1 (LIN 2): 26 records of 10 bytes + 1: location, blue, green, red, brightness,
 *          white, short circuit, over-temperature, open load, internal fault; an empty slot has location FF.
 *          The BDC polls its LIN slaves first: 7F 22 78 (pending), the reply a few seconds later.
 *   write  2E DA 5E / 2E E3 D1 <NAD> <on 1> <brightness 0-100> <red> <green> <blue> <seconds 0-254>: NAD = the
 *          record's place (1-based). The module shows it for that long, then the car's own colour again. Colour
 *          bytes are capped at FE (FF = no change); off = <NAD> 00 00 00 00 00 00 (the car's colour at once).
 */
const BDC = 0x40;
const BUSES = [{ name: 'lin1', read: [0xda, 0x5f], write: [0xda, 0x5e] }, { name: 'lin2', read: [0xe3, 0xd1], write: [0xe3, 0xd1] }];
const HOLD_S = 254, RENEW_MS = 120000;     // each write lasts 254 s; written again every 2 minutes

// TAB_INNENLICHT_VERBAUORT_LIN (BDC_G05) location ranges -> zone (the rest: doors)
const ZONE = { footwell: [0x01, 0x04, 0x23, 0x24], dash: [0x13, 0x18, 0x4f, 0x50], roof: [0x35, 0x3e],
    seats: [0x19, 0x1c, 0x33, 0x34, 0x71, 0x74], console: [0x1d, 0x20, 0x2b, 0x32, 0x47, 0x4c, 0x5f, 0x61] };
// TAB_INNENLICHT_VERBAUORT_LIN (BDC_G05, all 106): the kind of light (line, decor, top / bottom decor, other) and its name
const LOC = {
    0x01: 'other|Footwell driver front', 0x02: 'other|Footwell driver rear', 0x03: 'other|Footwell passenger front',
    0x04: 'other|Footwell passenger rear', 0x05: 'line|Driver door front line', 0x06: 'decor|Driver door front decor',
    0x07: 'other|Driver door front handle', 0x08: 'other|Driver door front pocket', 0x09: 'line|Driver door rear line',
    0x0a: 'decor|Driver door rear decor', 0x0b: 'other|Driver door rear pocket', 0x0c: 'line|Passenger door front line',
    0x0d: 'decor|Passenger door front decor', 0x0e: 'other|Passenger door front handle',
    0x0f: 'other|Passenger door front pocket', 0x10: 'line|Passenger door rear line',
    0x11: 'decor|Passenger door rear decor', 0x12: 'other|Passenger door rear pocket', 0x13: 'line|Dash line driver',
    0x14: 'decor|Dash decor driver', 0x15: 'line|Dash line centre', 0x16: 'decor|Dash decor centre',
    0x17: 'line|Dash line passenger', 0x18: 'decor|Dash decor passenger', 0x19: 'other|B-pillar driver',
    0x1a: 'other|B-pillar passenger', 0x1b: 'other|Driver seat back', 0x1c: 'other|Passenger seat back',
    0x1d: 'other|Centre stack tray', 0x1e: 'other|Console tray', 0x1f: 'other|Gear selector left',
    0x20: 'other|Gear selector right', 0x21: 'other|Driver door rear handle', 0x22: 'other|Passenger door rear handle',
    0x23: 'other|Footwell driver 3rd row', 0x24: 'other|Footwell passenger 3rd row',
    0x25: 'other|Driver door 3rd row pocket', 0x26: 'other|Passenger door 3rd row pocket',
    0x27: 'line|Driver door 3rd row line', 0x28: 'line|Passenger door 3rd row line',
    0x29: 'decor|Driver door 3rd row decor', 0x2a: 'decor|Passenger door 3rd row decor',
    0x2b: 'line|Console line driver front', 0x2c: 'line|Console line driver rear',
    0x2d: 'line|Console line passenger front', 0x2e: 'line|Console line passenger rear',
    0x2f: 'decor|Console decor driver front', 0x30: 'decor|Console decor driver rear',
    0x31: 'decor|Console decor passenger front', 0x32: 'decor|Console decor passenger rear',
    0x33: 'other|Driver seat back 2nd row', 0x34: 'other|Passenger seat back 2nd row',
    0x35: 'other|Roof front left front', 0x36: 'other|Roof front left rear', 0x37: 'other|Roof front right front',
    0x38: 'other|Roof front right rear', 0x39: 'other|Roof rear left front', 0x3a: 'other|Roof rear left rear',
    0x3b: 'other|Roof rear right front', 0x3c: 'other|Roof rear right rear', 0x3d: 'other|Light sword left',
    0x3e: 'other|Light sword right', 0x3f: 'decor|Driver door front front backlit decor',
    0x40: 'decor|Driver door front rear backlit decor', 0x41: 'decor|Driver door rear front backlit decor',
    0x42: 'decor|Driver door rear rear backlit decor', 0x43: 'decor|Passenger door front front backlit decor',
    0x44: 'decor|Passenger door front rear backlit decor', 0x45: 'decor|Passenger door rear front backlit decor',
    0x46: 'decor|Passenger door rear rear backlit decor', 0x47: 'decor|Console backlit decor driver front',
    0x48: 'decor|Console backlit decor driver rear', 0x49: 'decor|Console backlit decor passenger front',
    0x4a: 'decor|Console backlit decor passenger rear', 0x4b: 'other|Cupholder front', 0x4c: 'other|Cupholder rear',
    0x4d: 'other|Driver door rear 2 pocket', 0x4e: 'other|Passenger door rear 2 pocket',
    0x4f: 'top|Dash backlit decor passenger top', 0x50: 'bottom|Dash backlit decor passenger bottom',
    0x51: 'top|Driver door front top backlit decor', 0x52: 'bottom|Driver door front bottom backlit decor',
    0x53: 'top|Driver door rear top backlit decor', 0x54: 'bottom|Driver door rear bottom backlit decor',
    0x55: 'top|Passenger door front top backlit decor', 0x56: 'bottom|Passenger door front bottom backlit decor',
    0x57: 'top|Passenger door rear top backlit decor', 0x58: 'bottom|Passenger door rear bottom backlit decor',
    0x59: 'other|Driver door front tweeter', 0x5a: 'other|Passenger door front tweeter',
    0x5b: 'other|Driver door front mid speaker', 0x5c: 'other|Passenger door front mid speaker',
    0x5d: 'other|Driver door rear mid speaker', 0x5e: 'other|Passenger door rear mid speaker',
    0x5f: 'other|Centre speaker', 0x60: 'other|Console fireplace front', 0x61: 'other|Console fireplace rear',
    0x62: 'line|Driver door front rear line', 0x63: 'line|Driver door rear rear line',
    0x64: 'line|Passenger door front rear line', 0x65: 'line|Passenger door rear rear line',
    0x71: 'other|Driver seat back left', 0x72: 'other|Passenger seat back left', 0x73: 'other|Driver seat back right',
    0x74: 'other|Passenger seat back right',
};
const ZONES = ['dash', 'doors', 'footwell', 'console', 'seats', 'roof'];
const KINDS = ['line', 'top', 'decor', 'bottom', 'other'];         // the order a split zone's parts come in
// a zone's settings key: the zone, or zone.kind where the car has more than one kind of light in it (split())
const PART = new RegExp(`^(${ZONES.join('|')})(\\.(${KINDS.join('|')}))?$`);

function zoneOf(loc) {
    for (const z of Object.keys(ZONE)) {
        const r = ZONE[z];
        for (let i = 0; i < r.length; i += 2) if (loc >= r[i] && loc <= r[i + 1]) return z;
    }
    return 'doors';                                    // 0x05-0x12, 0x21-0x2A, 0x3F-0x46, 0x4D/4E, 0x51-0x58, 0x59-0x5E, 0x62-0x65
}
const nameOf = (loc) => (LOC[loc] ? LOC[loc].split('|')[1] : `Light 0x${loc.toString(16)}`);
const kindOf = (loc) => (LOC[loc] ? LOC[loc].split('|')[0] : 'other');

/** a 22 DA5F / 22 E3D1 reply -> the modules fitted on that bus */
function parse(uds, bus) {
    const out = [];
    for (let i = 3, nad = 1; i + 10 <= uds.length; i += 10, nad++) {
        const r = uds.slice(i, i + 10);
        if (r[0] === 0xff) continue;
        const base = zoneOf(r[0]);
        out.push({ bus, nad, loc: r[0], base, kind: kindOf(r[0]), zone: base, name: nameOf(r[0]), rgb: [r[3], r[2], r[1]], bright: r[4],
            fault: !!(r[6] || r[7] || r[8] || r[9]) });
    }
    return out;
}
/** every module of both buses: a zone with more than one kind of light (an X6's dash: a line above, decor below) is
 *  split into its parts, m.zone = 'dash.line' / 'dash.decor'; a zone of one kind stays whole */
function split(mods) {
    ZONES.forEach((z) => {
        const ms = mods.filter((m) => m.base === z), kinds = ms.map((m) => m.kind).filter((k, i, a) => a.indexOf(k) === i);
        ms.forEach((m) => { m.zone = kinds.length > 1 ? `${z}.${m.kind}` : z; });
    });
    return mods;
}

const cap = (v) => Math.max(0, Math.min(0xfe, Math.round(v)));
const busOf = (name) => BUSES.find((b) => b.name === name);

/** the write for one module: colour [r, g, b] at brightness 0-100, for secs */
function frame(m, rgb, bright, secs) {
    return busOf(m.bus).write.concat([m.nad, 1, Math.max(0, Math.min(100, Math.round(bright))), cap(rgb[0]), cap(rgb[1]), cap(rgb[2]),
        Math.max(1, Math.min(HOLD_S, secs || HOLD_S))]);
}
/** hand the module back to the car's own colour */
const release = (m) => busOf(m.bus).write.concat([m.nad, 0, 0, 0, 0, 0, 0]);

/** settings -> the colour and brightness each module gets (null: the car's own) */
function plan(mods, set, oem) {
    return mods.map((m) => {
        if (!set.on) return { m, off: true };
        // its part's setting, else its whole zone's (a preset made on a car whose zone is not split), else the main colour
        const zs = set.zones || {}, z = zs[m.zone] || (m.base && zs[m.base]), rgb = (z && z.rgb) || set.rgb;
        if (z && z.off) return { m, off: true };
        const base = (oem && oem[key(m)]) || 100;      // the car's own brightness for that module (dimmed at night, door lines lower)
        return { m, rgb, bright: set.follow === false ? set.bright : base * set.bright / 100 };
    });
}
const key = (m) => m.bus + '.' + m.nad;

/** h 0-360, s 0-1, v 0-1 -> [r, g, b] 0-255 (the app's wheel sends RGB; kept here for the self-check and presets) */
function hsv(h, s, v) {
    const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
    return [f(5), f(3), f(1)];
}

const DEFAULTS = { on: false, rgb: [254, 0, 0], bright: 100, follow: true, zones: {} };
function settings(cur, p) {
    const out = Object.assign({}, DEFAULTS, cur || {});
    if (!p || typeof p !== 'object') return out;
    const rgb = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255);
    if (typeof p.on === 'boolean') out.on = p.on;
    if (typeof p.follow === 'boolean') out.follow = p.follow;
    if (rgb(p.rgb)) out.rgb = p.rgb.slice();
    if (Number.isInteger(p.bright) && p.bright >= 5 && p.bright <= 100) out.bright = p.bright;
    if (p.zones && typeof p.zones === 'object') {
        out.zones = Object.assign({}, out.zones);
        Object.keys(p.zones).filter((z) => PART.test(z)).forEach((z) => {
            const v = p.zones[z];
            if (v === null) delete out.zones[z];
            else if (v && (rgb(v.rgb) || v.off === true)) out.zones[z] = v.off === true ? { off: true } : { rgb: v.rgb.slice() };
        });
    }
    return out;
}

module.exports = { BDC, BUSES, HOLD_S, RENEW_MS, ZONES, KINDS, PART, parse, split, frame, release, plan, key, hsv, settings, zoneOf, nameOf, kindOf };

if (require.main === module && process.argv.includes('--test')) {
    const assert = require('assert');
    // mgu-m4's LIN 2 reply (2026-11-07), 7 modules then empty slots
    const hex = '62e3d1150000fe600000000000170000fe600000000000130000fe6000000000001d0000fe300000000000030000fe600000000000010000fe600000000000050000fe300000000000' +
        'ffffffff7f0307070707'.repeat(19) + '02';
    const mods = parse(Array.from(Buffer.from(hex, 'hex')), 'lin2');
    assert.strictEqual(mods.length, 7);
    assert.deepStrictEqual(mods.map((m) => m.zone), ['dash', 'dash', 'dash', 'console', 'footwell', 'footwell', 'doors']);
    assert.deepStrictEqual([mods[0].rgb, mods[0].bright, mods[0].fault], [[254, 0, 0], 0x60, false]);
    // the write that turned the dash centre green on the car
    assert.deepStrictEqual(frame(mods[0], [0, 254, 0], 100, 5), [0xe3, 0xd1, 1, 1, 0x64, 0, 0xfe, 0, 5]);
    assert.deepStrictEqual(frame({ bus: 'lin1', nad: 1 }, [255, 300, -1], 150, 999), [0xda, 0x5e, 1, 1, 100, 0xfe, 0xfe, 0, 254]);
    assert.deepStrictEqual(release(mods[6]), [0xe3, 0xd1, 7, 0, 0, 0, 0, 0, 0]);
    // plans: off, one colour following the car's brightness, a zone of its own, a zone left to the car
    const set = settings(null, { on: true, rgb: [0, 0, 254], bright: 50, zones: { dash: { rgb: [254, 254, 0] }, doors: { off: true } } });
    const p = plan(mods, set, { 'lin2.1': 96 });
    assert.deepStrictEqual([p[0].rgb, p[0].bright, p[3].rgb, p[3].bright, !!p[6].off], [[254, 254, 0], 48, [0, 0, 254], 50, true]);
    assert.ok(plan(mods, settings(set, { on: false })).every((x) => x.off));
    assert.deepStrictEqual(settings(set, { zones: { dash: null }, bright: 3, rgb: [1, 2] }).zones, { doors: { off: true } });
    assert.deepStrictEqual([hsv(0, 1, 1), hsv(120, 1, 1), hsv(240, 1, 0.5)], [[255, 0, 0], [0, 255, 0], [0, 0, 128]]);
    // mgu-m4: one kind per zone, nothing split; the names from the BDC's table
    assert.deepStrictEqual(split(mods).map((m) => m.zone), ['dash', 'dash', 'dash', 'console', 'footwell', 'footwell', 'doors']);
    assert.deepStrictEqual([mods[0].name, mods[6].name, nameOf(0x18), kindOf(0x18), nameOf(0x99)], ['Dash line centre', 'Driver door front line', 'Dash decor passenger', 'decor', 'Light 0x99']);
    // a dash with a line above and decor below (an X6): two parts, each its own colour, the whole zone's setting under them
    const x6 = split([0x13, 0x14, 0x15, 0x16, 0x05].map((loc, i) => ({ bus: 'lin2', nad: i + 1, loc, base: zoneOf(loc), kind: kindOf(loc) })));
    assert.deepStrictEqual(x6.map((m) => m.zone), ['dash.line', 'dash.decor', 'dash.line', 'dash.decor', 'doors']);
    const two = settings(null, { on: true, rgb: [0, 0, 254], zones: { 'dash.line': { rgb: [254, 0, 0] }, 'dash.decor': { rgb: [254, 254, 254] }, 'dash.x': { off: true }, evil: { off: true } } });
    assert.deepStrictEqual(Object.keys(two.zones), ['dash.line', 'dash.decor'], 'only zones and zone parts');
    assert.deepStrictEqual(plan(x6, two).map((x) => x.rgb), [[254, 0, 0], [254, 254, 254], [254, 0, 0], [254, 254, 254], [0, 0, 254]]);
    assert.deepStrictEqual(plan(x6, settings(null, { on: true, rgb: [0, 0, 254], zones: { dash: { rgb: [1, 2, 3] } } })).map((x) => x.rgb)[1], [1, 2, 3], 'a whole-zone setting reaches its parts');
    console.log('ambient ok');
}
