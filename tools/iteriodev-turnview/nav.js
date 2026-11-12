'use strict';
/*
 * nav.js - iteriodev-turnview: Guidance 0xFB1A payloads (hex, as hmictl prints them) -> one maneuver record.
 *   conclusiveDart (notifier 0x8018) -> the next maneuver; guidanceStateWithReason (0x8003) -> active / recalc;
 *   guidingProvider (0x8017) -> BMW / CarPlay / Android Auto.
 *   CarPlay / Android Auto (car, 2026-11-07): Guidance stays INACTIVE with a placeholder dart; the phone's maneuvers
 *   land in GuidanceEventList 0xFB1B (queryContent reply, 'events'): the first way-ahead event = the maneuver, a
 *   route = at least one such event. Waze sends none (route summary only).
 *   const nav = createNav({ log, now });  nav.payload('dart' | 'state' | 'provider' | 'events', hex);  nav.on('change', rec)
 *   rec = { active, recalc, provider, kind, angle, side, exit, icon, text, meters, uid, t }
 * The decoder options (enum / union widths) are found on the first conclusiveDart that parses (wire.decodeAny) and
 * kept for every field from then on. A payload that does not parse is dropped (the last good state stays) and its hex
 * logged at most once a minute.
 */
const EventEmitter = require('events');
const path = require('path');
const wire = require('./wire');

const S = (f) => require(path.join(__dirname, 'schemas', f));
const SCHEMA = { dart: S('guidance-conclusiveDart.json'), state: S('guidance-state.json'), provider: S('guidance-provider.json'),
    speed: S('vehicle2-speed.json'), events: S('eventlist-query-out.json') };
const PROVIDER = { NONE: 'BMW', CAR_PLAY: 'CarPlay', ANDROID_AUTO: 'Android Auto', CAR_LIFE: 'CarLife', OTHER: 'Other' };
const UNIT = { METER: 'm', KM: 'km', FEET: 'ft', YARD: 'yd', MILE_UK: 'mi', MILE_US: 'mi', NONE: '' };
// the members that are the way ahead; alongMainRoad ("follow the road") reads as straight on. Every other member
// (speed cameras, traffic events, POIs, lane changes, tolls, the loading placeholder, ...) is not the turn: the last
// maneuver stays while one is the conclusive DART
const KIND = { intersection: 'intersection', branch: 'branch', roundabout: 'roundabout', destinationManeuver: 'destination', tunnel: 'tunnel',
    alongMainRoad: 'other' };
// intersection direction -> [angle, side]
const DIR = { NONE: [0, 1], STRAIGHT_ON: [0, 1], SLIGHT_LEFT: [30, -1], LEFT: [90, -1], HARD_LEFT: [135, -1], UTURN_LEFT: [180, -1],
    SLIGHT_RIGHT: [30, 1], RIGHT: [90, 1], HARD_RIGHT: [135, 1], UTURN_RIGHT: [180, 1] };
const ICON = { 0: 'straight', 30: 'slight', 90: '', 135: 'hard', 180: 'uturn' };
const LOG_EVERY_MS = 60000;

function iconOf(kind, angle, side) {
    if (kind === 'destination') return 'destination';
    if (kind === 'tunnel') return 'tunnel';
    if (kind === 'roundabout') return side < 0 ? 'roundabout-left' : 'roundabout-right';
    if (!angle) return 'straight';
    const lr = side < 0 ? 'left' : 'right';
    return ICON[angle] ? `${ICON[angle]}-${lr}` : lr;
}

/* formattedDistance's text in metres ("1,2" KM -> 1200); null: no number or no unit */
const TO_M = { METER: 1, KM: 1000, FEET: 0.3048, YARD: 0.9144, MILE_UK: 1609.344, MILE_US: 1609.344 };
function textMeters(fd) {
    const n = parseFloat(String(fd.distance || '').replace(',', '.'));
    return TO_M[fd.unit] && isFinite(n) ? n * TO_M[fd.unit] : null;
}

/* a decoded conclusiveDart -> the maneuver part of rec (kind null: none) */
function maneuverOf(dart) {
    const m = dart && dart.maneuver;
    if (!m || !m.value) return { kind: null };
    const v = m.value, kind = KIND[m.type];
    if (!kind) return { kind: 'ignored' };
    let angle = 0, side = 1, exit = 0;
    if (kind === 'intersection') { const d = DIR[v.direction] || DIR.NONE; angle = d[0]; side = d[1]; }
    else if (kind === 'branch') {                     // branchType: BRANCH_LEFT, HIGHWAY_OUT_RIGHT, TRIPLE_FORK_STRAIGHT, ...
        const b = String(v.branchType || '');
        if (/_LEFT$/.test(b)) { angle = 30; side = -1; } else if (/_RIGHT$/.test(b)) angle = 30;
    } else if (kind === 'roundabout') {               // the bend toward the driving side (exitAngle not used: spec 9)
        angle = 90; side = v.driveDirection === 'LEFT' ? -1 : 1; exit = v.exitNumber || 0;
    }
    const fd = v.formattedDistance || {}, unit = UNIT[fd.unit] !== undefined ? UNIT[fd.unit] : '';
    const text = fd.distance === undefined ? '' : unit ? `${fd.distance} ${unit}` : String(fd.distance);
    return { kind, angle, side, exit, icon: iconOf(kind, angle, side), text, meters: typeof fd.rawDistance === 'number' ? fd.rawDistance : null,
        uid: v.uid || null };
}

function createNav(o) {
    o = o || {};
    const log = o.log || (() => {}), now = o.now || Date.now;
    const nav = new EventEmitter();
    let opts = null, errors = 0;
    const lastLog = {};
    // seq: counts the conclusiveDart updates used, so a consumer re-syncs the distance only on a new one (a state or
    // provider change carries the old metres)
    const cur = { active: false, recalc: false, provider: 'BMW', kind: null, angle: 0, side: 1, exit: 0, icon: '', text: '', meters: null, uid: null, seq: 0 };
    const BLANK = { kind: null, angle: 0, side: 1, exit: 0, icon: '', text: '', meters: null, uid: null };
    // guided: BMW guidance ACTIVE; proj: the phone's event list holds a way-ahead event (projKey: the last one used)
    let sent = '', guided = false, proj = false, projKey = '';
    const setManeuver = (m) => { Object.assign(cur, BLANK, m); cur.seq++; };
    function changed() {
        const key = JSON.stringify(cur);
        if (key === sent) return;
        sent = key;
        nav.emit('change', Object.assign({ t: now() }, cur));
    }
    function fail(field, hex, e) {
        errors++;
        if (!lastLog[field] || now() - lastLog[field] >= LOG_EVERY_MS) {
            lastLog[field] = now();
            log(`nav: ${field} payload dropped (${e}): ${String(hex).slice(0, 400)}`);
        }
    }
    // -> true when the payload was decoded (used or not)
    nav.payload = (field, hex) => {
        const buf = Buffer.from(String(hex || ''), 'hex');
        if (!SCHEMA[field]) return false;
        let value = null;
        try {
            // the locked options first; a dart that does not fit them (or none locked yet) finds them again; the small
            // fields (enums only) fall back to whichever candidate fits their length, without locking
            if (opts) {
                try {
                    const r = wire.decode(SCHEMA[field], buf, opts);
                    if (r.end === buf.length) value = r.value;
                } catch (e) { /* below */ }
            }
            if (value === null) {
                const r = wire.decodeAny(SCHEMA[field], buf);
                if (!r) throw new Error('no decoder options fit');
                if ((field === 'dart' || field === 'events') && JSON.stringify(r.opts) !== JSON.stringify(opts)) {
                    opts = r.opts;
                    log(`nav: decoder options ${JSON.stringify(opts)}`);
                }
                value = r.value;
            }
        } catch (e) { fail(field, hex, e.message); return false; }
        if (field === 'dart') {
            const m = maneuverOf(value);
            // not the way ahead, or no distance (placeholderElement's loading indicator, laneGuiding, ...): the last
            // maneuver stays
            if (m.kind === 'ignored' || (m.kind && m.meters === null)) return true;
            setManeuver(m);
        } else if (field === 'state') {
            guided = value.guidanceState === 'ACTIVE';
            cur.recalc = value.guidanceState === 'CALCULATING_ROUTE';
        } else if (field === 'provider') {
            cur.provider = PROVIDER[value] || 'Other';
            if (cur.provider === 'BMW' && proj) { proj = false; projKey = ''; setManeuver({}); }   // the phone gone
        } else if (field === 'events') {
            if (cur.provider === 'BMW') return true;      // BMW guidance: the dart
            const view = value.viewContent[0], list = view ? view.eventsInView : [];
            let m = BLANK;
            for (let i = 0; i < list.length; i++) {
                const x = maneuverOf({ maneuver: list[i] }), v = list[i].value;
                // the phone's rawDistance is not the distance (Apple Maps: always 1, car 2026-11-07): the text is
                // ("250" METER ... "5" METER while driving); the next maneuver after it comes with no text (unit NONE)
                x.meters = x.kind ? textMeters(v.formattedDistance || {}) : null;
                if (!x.kind || x.kind === 'ignored' || x.meters === null) continue;
                // Apple Maps sends uid 0 (and one distanceToDestination for every event): the direction and the road
                // name tell one maneuver from the next (passed fade)
                if (/^0*$/.test(x.uid || '')) {
                    const d = ((v.description && v.description.elements) || []).map((e) => (e.type === 'text' ? e.value : '')).join(' ');
                    x.uid = `${list[i].type}:${v.direction || v.branchType || v.exitNumber || ''}:${d}`;
                }
                m = x;
                break;
            }
            proj = m.kind !== null;
            const key = JSON.stringify(m);
            if (key !== projKey) { projKey = key; setManeuver(m); }   // polled: an unchanged reply is not a new distance
        }
        cur.active = guided || proj;
        changed();
        return true;
    };
    nav.opts = () => opts;
    nav.errors = () => errors;
    nav.record = () => Object.assign({ t: now() }, cur);
    return nav;
}

/* the GuidanceEventList 0xFB1B queryContent (method 4) request, hex: the way ahead from the car position, stateless
 * (no setViewConfig: the HMI's own views stay untouched) */
const QUERY = S('eventlist-query-in.json');
function queryHex(opts) {
    const vc = QUERY.e[0].e, q = wire.sample(QUERY, {});
    q.viewConfigs = [Object.assign(wire.sample(vc), {
        viewport: Object.assign(wire.sample(vc.e[0]), {
            startPoint: { anchorPoint: { type: 'standardReferencePoint', value: 'CCP' }, offsets: [] },
            maxElementCount: 4, endPoints: [], includedActiveTypes: [],
            includedTypes: ['INCLUDE_ACTIVE_MANEUVERS', 'INCLUDE_DESTINATIONS', 'INCLUDE_TUNNELS', 'INCLUDE_ALONG_MAIN_ROAD'] }),
        options: [], minimumUpdateIntervalMs: 0, segmentItemRasterLength: 0 })];
    return wire.encode(QUERY, q, opts).toString('hex');
}

/* Vehicle2 statusCarSpeed2 (getter 8) reply -> km/h; null: invalid (65535) or no payload */
function speedKmh(hex) {
    if (!hex || hex.length < 4) return null;
    const raw = parseInt(hex.slice(0, 4), 16);
    return raw === 65535 ? null : raw / 64;
}

module.exports = { createNav, speedKmh, maneuverOf, iconOf, queryHex, textMeters, SCHEMA };
