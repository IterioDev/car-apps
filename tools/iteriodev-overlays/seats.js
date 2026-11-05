'use strict';
/*
 * seats.js - iteriodev-overlays: front seat heating / ventilation read and set over SOME/IP the way Hmi8 does it,
 * through whichever backend the car's climate unit offers (Hmi8: CDevCarClimateMaster / CDevCarClimateLegacy).
 * Pure: hmictl "ev" lines and getter replies -> a state; a seat's new level -> an hmictl line. overlays.js draws.
 * ClimateMaster 0xB09A inst 1 v1 (newer climate units):
 *   status heating 0x802A (getter 42) / cooling 0x8038 (56): array of {configured u8, actual u8, min u8, max u8,
 *   zone u8, saveLUM u8}; availability 0x8036 (54): array of {AvailabilitySeat u8 (1 heat, 2 cool, 3 neck), zone u8,
 *   priorityClient u16}; zone 1 driver, 2 passenger.
 *   requestSeatClimateSeatHeating 41 / SeatCooling 55: clientGroupId u8 (4, as Hmi8: rodata b4a9cc5) + array of
 *   {level u8, zone u8, saveLUM u8} -> array of {accepted u8, zone u8}.
 *   Steering wheel heating: status 0x8046 (getter 70) {configured u8, actual u8, min u8, max u8, saveLUM u8},
 *   availability 0x8049 (73) array of {available u8, priorityClient u16}; requestSteeringWheelHeating 69:
 *   clientGroupId u8, level u8, saveLUM u8 -> accepted u8. (Legacy Climate: Hmi8's manual wheel path not found yet,
 *   so a legacy car shows no wheel.)
 * Legacy Climate 0xB511 inst 1 v1 (G series): statusSeatHeatingDR 0x8013 (19) / PS 0x8015 (21), statusSeatClimate
 *   (ventilation) DR 0x801B (27) / PS 0x8018 (24): u8 level 0-3, 15 = invalid (that seat has no such function).
 *   Set: operationStratificationSeatHeating, setter 3: 17 u8 (OperationStratificationSeatHeatingWrapper), the
 *   seat's stage (STUFE_n = n) at index 4 (heat DR), 5 (vent DR), 6 (heat PS), 7 (vent PS), the rest "no action"
 *   (KEINE_AKTION: 4 for the stages, 0 for the neck and 3-tier parts; 31 for the 4 stratification bytes).
 *   G82 2026-11-02: the M4 has only this backend; setting DR heat 1 answered and statusSeatHeatingDR became 1.
 *   The AUTO program (Hmi8 CDevCarClimateLegacy::setSeatClimateHeating / -Cooling, from the dump): for a zone whose
 *   climate runs in AUTO (statusACFunctionsAvailibility 0x8031, getter 49: u16, intensity DR, PS, then
 *   statusModeAirConditioningDR byte 4 / PS byte 5: 1 on, 0 off, 3 not filled in) Hmi8 sends operationAURAPerso,
 *   setter 2, 15 u8 instead: seat heater AUTO DR / PS at 0 / 1, seat ventilation AUTO DR / PS at 2 / 3, levels 0-4
 *   (off, Low, Medium, High, Very high: its fourStepValues), 15 (not filled in) at 0-5, 3 at 6-14; and shows that
 *   zone's levels from statusAURAPerso 0x802B (no getter; the same places, 0-5, 13-15 none). The manual setter does
 *   nothing then (a client's M2, 2026-11-05: heat taps in AUTO did nothing, the HMI showed 4 levels).
 *   Ventilation: statusSeatClimate reads 0 on cars without it too (a client's M2, 2026-11-04), so a legacy car shows it
 *   only once a level 1-3 was seen (seen{}, kept in slots.json by overlays.js).
 * Steering wheel on such a car: body SteeringWheelClimate 0x5002 inst 1 v1, heatingState 0x8001 (getter 1)
 *   {functionalityCoded, availability, heating} (3 bools); requestHeating method 2 (requestor 5 u8, no length; heating
 *   bool), no reply payload. G82: 010100 -> request 0000000000 01 -> 010101.
 * Payloads big-endian, arrays behind a u32 byte length (CommonAPI SOME/IP). The VM has no climate unit.
 */
const MASTER = 0xb09a, LEGACY = 0xb511, WHEEL = 0x5002;
const SEATS = ['driver', 'passenger'];
const ZONE = { driver: 1, passenger: 2 };
const INVALID = 15;

// the first value of each field comes with the subscription, every change after it
const SUBS = ['sub 0xb09a 1 1 1 0x802a 0x8038 0x8036 0x8046 0x8049',
    'sub 0xb511 1 1 1 0x8013 0x8015 0x801b 0x8018 0x8031 0x802b', 'sub 0x5002 1 1 1 0x8001'];
// getter -> the notification it mirrors, per backend: a re-read now and then
const GETTERS = { master: { 54: 0x8036, 42: 0x802a, 56: 0x8038, 70: 0x8046, 73: 0x8049 },
    legacy: { 19: 0x8013, 21: 0x8015, 27: 0x801b, 24: 0x8018, 49: 0x8031 } };
const LEGACY_EV = { 0x8013: ['driver', 'heat'], 0x8015: ['passenger', 'heat'], 0x801b: ['driver', 'cool'], 0x8018: ['passenger', 'cool'] };
const LEGACY_AT = { 'driver.heat': 4, 'driver.cool': 5, 'passenger.heat': 6, 'passenger.cool': 7 };
const LEGACY_NONE = [31, 31, 31, 31, 4, 4, 4, 4, 4, 4, 4, 4, 0, 0, 0, 0, 0];
const AUTO_EV = 0x8031, AURA_EV = 0x802b, AUTO_AT = { driver: 4, passenger: 5 };
const AURA_AT = { 'driver.heat': 0, 'passenger.heat': 1, 'driver.cool': 2, 'passenger.cool': 3 };
const AURA_NONE = [15, 15, 15, 15, 15, 15, 3, 3, 3, 3, 3, 3, 3, 3, 3], AURA_MAX = 4;

function state(demo) {
    const st = { backend: demo ? 'demo' : null, seats: {}, wheel: { have: !!demo, level: 0, max: 1, src: demo ? 'demo' : null },
        legacy: { auto: {}, man: {}, aura: {}, seen: {} } };   // the legacy backend's raw statuses (legacyShow)
    for (const n of SEATS) st.seats[n] = { heat: { have: !!demo, level: 0, max: 3 }, cool: { have: !!demo, level: 0, max: 3 } };
    return st;
}
/* legacy: what each button shows - the AUTO program's level (0-4) for a zone in AUTO, else the manual one (0-3) */
function legacyShow(st) {
    const lg = st.legacy;
    for (const seat of SEATS) {
        for (const kind of ['heat', 'cool']) {
            const key = `${seat}.${kind}`, man = lg.man[key], k = st.seats[seat][kind];
            if (man === undefined) continue;
            k.have = man !== INVALID && (kind === 'heat' || man > 0 || !!lg.seen[seat]);
            const auto = !!lg.auto[seat] && lg.aura[key] !== undefined && lg.aura[key] !== null;
            k.level = auto ? lg.aura[key] : man !== INVALID ? man : k.level;
            k.max = auto ? AURA_MAX : 3;
        }
    }
}
function elements(b, size) {
    if (b.length < 4) return [];
    const end = 4 + Math.min(b.readUInt32BE(0), b.length - 4), out = [];
    for (let o = 4; o + size <= end; o += size) out.push(b.slice(o, o + size));
    return out;
}
const seatOf = (zone) => (zone === 1 ? 'driver' : zone === 2 ? 'passenger' : null);

/* one notification (svc, event id, payload hex) into st; true when anything changed */
function apply(st, svc, ev, hex) {
    const b = Buffer.from(hex || '', 'hex'), before = JSON.stringify(st);
    if (svc === MASTER) {
        st.backend = 'master';
        if (ev === 0x8036) {
            for (const n of SEATS) st.seats[n].heat.have = st.seats[n].cool.have = false;
            for (const e of elements(b, 4)) {
                const s = seatOf(e[1]);
                if (s && e[0] === 1) st.seats[s].heat.have = true;
                if (s && e[0] === 2) st.seats[s].cool.have = true;
            }
        } else if (ev === 0x8049) {
            st.wheel.have = elements(b, 3).some((e) => e[0] === 1);
            st.wheel.src = 'master';
        } else if (ev === 0x8046 && b.length >= 4) {
            st.wheel.level = b[0];
            if (b[3]) st.wheel.max = b[3];
        } else if (ev === 0x802a || ev === 0x8038) {
            for (const e of elements(b, 6)) {
                const s = seatOf(e[4]);
                if (!s) continue;
                const k = st.seats[s][ev === 0x802a ? 'heat' : 'cool'];
                k.level = e[0];
                if (e[3]) k.max = e[3];
            }
        }
    } else if (svc === LEGACY && st.backend !== 'master' && (LEGACY_EV[ev] || ev === AUTO_EV || ev === AURA_EV)) {
        const lg = st.legacy;
        if (LEGACY_EV[ev] && b.length >= 1) {
            const [seat, kind] = LEGACY_EV[ev];
            if (kind === 'cool' && b[0] >= 1 && b[0] <= 3) lg.seen[seat] = true;
            lg.man[`${seat}.${kind}`] = b[0];
            st.backend = 'legacy';
        } else if (ev === AUTO_EV && b.length >= 6) {
            for (const seat of SEATS) { const v = b[AUTO_AT[seat]]; if (v <= 1) lg.auto[seat] = v === 1; }
        } else if (ev === AURA_EV && b.length >= 4) {
            for (const key of Object.keys(AURA_AT)) { const v = b[AURA_AT[key]]; lg.aura[key] = v <= 5 ? Math.min(v, AURA_MAX) : null; }
        }
        legacyShow(st);
    } else if (svc === WHEEL && ev === 0x8001 && st.wheel.src !== 'master' && b.length >= 3) {
        Object.assign(st.wheel, { have: !!(b[0] && b[1]), level: b[2] ? 1 : 0, max: 1, src: 'body' });
    }
    return JSON.stringify(st) !== before;
}
/* the hmictl line that sets seat's kind ('heat' | 'cool') to level, or the wheel (seat 'wheel'); null for the
 * demo / no backend */
function request(st, seat, kind, level) {
    const h = (v) => (v & 0xff).toString(16).padStart(2, '0');
    if (seat === 'wheel') {
        if (st.wheel.src === 'master') return `call 0xb09a 1 69 1 04${h(level)}01`;
        return st.wheel.src === 'body' ? `call 0x5002 1 2 1 0000000000${level ? '01' : '00'}` : null;
    }
    if (st.backend === 'master') return `call 0xb09a 1 ${kind === 'heat' ? 41 : 55} 1 04${'00000003'}${h(level)}${h(ZONE[seat])}01`;
    if (st.backend === 'legacy' && st.legacy.auto[seat]) {   // that zone in AUTO: operationAURAPerso, as Hmi8
        const v = AURA_NONE.slice();
        v[AURA_AT[seat + '.' + kind]] = Math.min(level, AURA_MAX);
        return `call 0xb511 1 2 1 ${Buffer.from(v).toString('hex')}`;
    }
    if (st.backend === 'legacy') {
        const v = LEGACY_NONE.slice();
        v[LEGACY_AT[seat + '.' + kind]] = level;
        return `call 0xb511 1 3 1 ${Buffer.from(v).toString('hex')}`;
    }
    return null;
}
/* 1 -> 2 -> 3 -> off (the user's order) */
const next = (level, max) => (level >= max ? 0 : level + 1);
/* the getter lines for a re-read: [{ line, svc, ev }] */
function rereads(st) {
    const g = GETTERS[st.backend] || {};
    const svc = st.backend === 'master' ? MASTER : LEGACY;
    const out = Object.keys(g).map((m) => ({ line: `call 0x${svc.toString(16)} 1 ${m} 1`, svc, ev: g[m] }));
    if (st.wheel.src === 'body') out.push({ line: 'call 0x5002 1 1 1', svc: WHEEL, ev: 0x8001 });
    return out;
}

function test() {
    const assert = require('assert');
    let st = state();
    // ClimateMaster: driver heat + cool, passenger heat only; driver heating at 2 of 3
    assert(apply(st, MASTER, 0x8036, '0000000c' + '01010000' + '02010000' + '01020000'));
    assert(apply(st, MASTER, 0x802a, '0000000c' + '020200030100' + '000000030200'));
    assert.deepStrictEqual(st.seats.driver, { heat: { have: true, level: 2, max: 3 }, cool: { have: true, level: 0, max: 3 } });
    assert.deepStrictEqual(st.seats.passenger.cool.have, false);
    assert.strictEqual(request(st, 'passenger', 'heat', 1), 'call 0xb09a 1 41 1 0400000003010201');
    assert.strictEqual(apply(st, LEGACY, 0x8013, '00'), false);              // master wins once seen
    assert.strictEqual(rereads(st).length, 5);
    // wheel: available, on/off (range 0-1), now on
    assert(apply(st, MASTER, 0x8049, '00000003' + '010000'));
    assert(apply(st, MASTER, 0x8046, '0101000101'));
    assert.deepStrictEqual(st.wheel, { have: true, level: 1, max: 1, src: 'master' });
    assert.strictEqual(request(st, 'wheel', null, 0), 'call 0xb09a 1 69 1 040001');
    // legacy: driver vent at 1, passenger without heating (15)
    st = state();
    apply(st, LEGACY, 0x801b, '01'); apply(st, LEGACY, 0x8015, '0f'); apply(st, LEGACY, 0x8013, '03');
    assert.deepStrictEqual([st.backend, st.seats.driver.cool.level, st.seats.driver.heat.level, st.seats.passenger.heat.have],
        ['legacy', 1, 3, false]);
    assert.strictEqual(request(st, 'driver', 'cool', 2), 'call 0xb511 1 3 1 1f1f1f1f0402040404040404' + '0000000000');
    assert.deepStrictEqual([next(0, 3), next(1, 3), next(3, 3)], [1, 2, 0]);
    assert.strictEqual(request(state(true), 'driver', 'heat', 1), null);
    assert.strictEqual(request(st, 'wheel', null, 1), null);                  // no wheel reported yet
    // the G82: wheel from body SteeringWheelClimate (coded, available, off), then on
    assert(apply(st, WHEEL, 0x8001, '010100'));
    assert.deepStrictEqual(st.wheel, { have: true, level: 0, max: 1, src: 'body' });
    assert.strictEqual(request(st, 'wheel', null, 1), 'call 0x5002 1 2 1 000000000001');
    assert(apply(st, WHEEL, 0x8001, '010101')); assert.strictEqual(st.wheel.level, 1);
    assert.strictEqual(rereads(st).length, 6);
    // legacy ventilation reading 0 (cars without it read that too): hidden until a level 1-3 was seen, then kept
    const lg = state();
    apply(lg, LEGACY, 0x801b, '00'); apply(lg, LEGACY, 0x8013, '00'); apply(lg, LEGACY, 0x8015, '01');
    assert.deepStrictEqual([lg.seats.driver.cool.have, lg.seats.driver.heat.have], [false, true]);
    apply(lg, LEGACY, 0x801b, '02'); apply(lg, LEGACY, 0x801b, '00');
    assert.deepStrictEqual([lg.seats.driver.cool.have, lg.legacy.seen], [true, { driver: true }]);
    // the AUTO program: the driver's zone in AUTO (byte 4), the passenger's not; its levels 0-4 from statusAURAPerso
    assert(apply(lg, LEGACY, 0x8031, '0000' + '0b0b' + '01' + '00' + '000000'));
    assert(apply(lg, LEGACY, 0x802b, '0302' + '0000' + '0f'.repeat(15)));
    assert.deepStrictEqual([lg.seats.driver.heat, lg.seats.driver.cool, lg.seats.passenger.heat],
        [{ have: true, level: 3, max: 4 }, { have: true, level: 0, max: 4 }, { have: true, level: 1, max: 3 }]);
    assert.strictEqual(request(lg, 'driver', 'heat', 4), 'call 0xb511 1 2 1 040f0f0f0f0f030303030303030303');
    assert.strictEqual(request(lg, 'driver', 'cool', 1), 'call 0xb511 1 2 1 0f0f010f0f0f030303030303030303');
    assert.strictEqual(request(lg, 'passenger', 'heat', 2), 'call 0xb511 1 3 1 1f1f1f1f' + '0404020404040404' + '0000000000');
    apply(lg, LEGACY, 0x8013, '01');
    assert.strictEqual(lg.seats.driver.heat.level, 3, 'in AUTO the manual status does not show');
    apply(lg, LEGACY, 0x8031, '0000' + '0b0b' + '03' + '00' + '000000');        // not filled in: stays in AUTO
    assert.strictEqual(lg.seats.driver.heat.level, 3);
    apply(lg, LEGACY, 0x8031, '0000' + '0b0b' + '00' + '00' + '000000');        // AUTO off: the manual level again
    assert.deepStrictEqual(lg.seats.driver.heat, { have: true, level: 1, max: 3 });
    assert.strictEqual(request(lg, 'driver', 'heat', 2), 'call 0xb511 1 3 1 1f1f1f1f' + '0204040404040404' + '0000000000');
    assert.strictEqual(apply(st, WHEEL, 0x8001, '000100') && st.wheel.have, false);   // not coded: no wheel
    console.log('seats self-check ok');
}

module.exports = { SEATS, SUBS, state, apply, request, next, rereads, test };
if (require.main === module) test();
