'use strict';
/*
 * track.js - iteriodev-turnview: where the next turn is, counted down between navigation updates, and the view state
 * (spec 4.2). Pure: time comes in as t (ms).
 *   const tr = createTrack();
 *   tr.nav(rec, t)  a nav.js record;  tr.speed(kmh | null, t);  tr.calib(on);  tr.enabled(on);  tr.tick(t) -> view
 *   view = { state, video, l0, travel, speed, angle, side, exit, icon, text, alpha, dim }
 * travel: metres driven since the start (never reset, so the chevrons' phase mod(travel, 4) stays continuous; the
 * float guard below takes whole multiples of 4 m off it). l0: the turn's place on that scale (nav metres + travel at
 * the last sync), so l0 - travel = metres to the turn. view.l0 is that while a bend can be in sight (near, passed),
 * else travel + NO_BEND (spec 5.1: no bend drawn).
 * States: off (enabled false) - none (no guidance / no maneuver) - route (> NEAR_M) - near (<= NEAR_M) - passed (counted
 * past the turn, or a new maneuver came: PASSED_MS fade of the old one) - recalc (calculating: dimmed up to RECALC_MS,
 * then none) - calib (calibrating: wins over everything). video: route / near / passed / recalc / calib.
 */
const NEAR_M = 80, JUMP_M = 30, BLEND_MS = 1000, PASSED_MS = 500, RECALC_MS = 5000, STALE_MS = 1000;
const GUARD_M = 10000, NO_BEND = 10000;
const VIDEO = { route: true, near: true, passed: true, recalc: true, calib: true };
const NONE = { uid: null, angle: 0, side: 1, exit: 0, icon: '', text: '' };

function createTrack(o) {
    const PASSED = (o && o.passedMs) || PASSED_MS;      // (tests: longer, so a slow machine sees it)
    let travel = 0, l0 = 0, lastT = null, lastSeq;
    let kmh = null, speedT = -Infinity;
    let blend = null;                       // { from, to, t0 }: l0 moving to a sync's value
    let man = null;                         // the maneuver in front: { uid, angle, side, exit, icon, text }
    let passed = null;                      // { at, m, l0 }: the one being passed (l0 null: the live one)
    let active = false, recalc = false, recalcSince = null;
    let calibOn = false, on = true;

    const mps = () => (kmh === null ? 0 : kmh / 3.6);
    function curL0(t) {
        if (!blend) return l0;
        const f = Math.min(1, Math.max(0, (t - blend.t0) / BLEND_MS));
        return blend.from + (blend.to - blend.from) * f;
    }
    function syncTo(meters, t, hard) {
        const want = meters + travel, cur = curL0(t);
        if (hard || Math.abs(want - cur) > JUMP_M) { l0 = want; blend = null; } else blend = { from: cur, to: want, t0: t };
    }
    function guard(k) { travel -= k; l0 -= k; if (blend) { blend.from -= k; blend.to -= k; } if (passed && passed.l0 !== null) passed.l0 -= k; }

    return {
        nav(rec, t) {
            active = !!rec.active; recalc = !!rec.recalc;
            if (recalc) { if (recalcSince === null) recalcSince = t; } else recalcSince = null;
            // the distance only from a new conclusiveDart (rec.seq): a state or provider change carries the old metres
            if (rec.seq !== undefined && rec.seq === lastSeq) return;
            lastSeq = rec.seq;
            if (!rec.kind || typeof rec.meters !== 'number') { man = null; passed = null; return; }
            const m = { uid: rec.uid, angle: rec.angle || 0, side: rec.side < 0 ? -1 : 1, exit: rec.exit || 0, icon: rec.icon || '', text: rec.text || '' };
            if (man && m.uid !== man.uid) {            // a new maneuver: the old one fades where it was, the new one counts at once
                passed = { at: t, m: man, l0: curL0(t) };
                man = m;
                syncTo(rec.meters, t, true);
                return;
            }
            const first = !man;
            man = m;
            syncTo(rec.meters, t, first);
        },
        speed(v, t) { kmh = typeof v === 'number' && isFinite(v) && v >= 0 ? v : null; speedT = t; },
        calib(v) { calibOn = !!v; },
        enabled(v) { on = !!v; },
        tick(t) {
            const fresh = kmh !== null && t - speedT <= STALE_MS;
            if (lastT !== null && fresh && t > lastT) travel += mps() * (t - lastT) / 1000;
            lastT = t;
            if (blend && t - blend.t0 >= BLEND_MS) { l0 = blend.to; blend = null; }
            let state, alpha = 1, dim = false, shown = man || NONE, L = curL0(t);
            if (calibOn) state = 'calib';
            else if (!on) state = 'off';
            else if (recalc) { state = t - recalcSince >= RECALC_MS ? 'none' : 'recalc'; alpha = 0.4; dim = true; }
            else if (!active || !man) state = 'none';
            else {
                if (L - travel < 0 && !(passed && passed.m === man)) passed = { at: t, m: man, l0: null };
                if (passed && (t - passed.at < PASSED || (passed.m === man && L - travel < 0))) {
                    state = 'passed';
                    alpha = Math.max(0, 1 - (t - passed.at) / PASSED);
                    shown = passed.m;
                    if (passed.l0 !== null) L = passed.l0;
                } else {
                    passed = null;
                    state = L - travel > NEAR_M ? 'route' : 'near';
                }
            }
            if ((state === 'none' || state === 'route') && travel > GUARD_M) {     // float guard (32-bit shader floats)
                const k = Math.floor(travel / 4) * 4;
                guard(k);
                L -= k;
            }
            const bend = state === 'near' || state === 'passed';
            return { state, video: !!VIDEO[state], l0: bend ? L : travel + NO_BEND, travel, speed: fresh ? mps() : 0,
                angle: state === 'recalc' ? 0 : shown.angle, side: shown.side, exit: shown.exit, icon: shown.icon, text: shown.text,
                alpha: state === 'calib' || state === 'off' || state === 'none' ? 0 : alpha, dim };
        },
        toTurn: (t) => curL0(t) - travel,               // metres to the turn (status, tests)
    };
}

module.exports = { createTrack, NEAR_M, JUMP_M, BLEND_MS, PASSED_MS, RECALC_MS, STALE_MS, GUARD_M, NO_BEND };
