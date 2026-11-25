'use strict';
/*
 * scene.js - iteriodev-turnview: the tool's cluster-render layers for a track.js view (spec 5). All on one target:
 * iDrive 8 the widget picked in the cluster's widget menu, `turnview` ("Turn View AR", the tool's drop-in) or `widget`
 * ("Cluster renderer"); iDrive 7 (0.6.0) `map`, the cluster's central map area (Map view), which the cluster shows by
 * itself while a layer wants it: the layers `contend` (take it from the stock map), and Turn View off or no front
 * camera draws nothing there, so the stock map (or Waze on cluster's) comes back. Class overlay, over the camera's rect
 * (camcluster's last `rect` line):
 *   chevrons  mesh  z 10   the turn sign (shaders.js: 3 blue chevrons at the turn) while the camera decodes, only
 *                          near a turn (none straight on / far away, 2026-11-16); its top held under the card
 *   marks     mesh  z 15   5 / 10 / 20 m lines while calibrating, same camera
 *   card      image z 20   icon + distance, top centre (card.js; on `map` 0.8x, below the cluster's model badge)
 *   shade     effect z 30  a dark fill with soft edges, no upload
 *   notice    image z 31   "No front camera" (the car has none: before everything, alone) / "Camera busy" / "No camera",
 *                          centred; "Turn View is off" (switched off, iDrive 8: camcluster keeps the widget in the
 *                          cluster's menu, so picked it would be black - car 2026-11-14). 0.6.0 (user 2026-11-14): no
 *                          route = the camera alone, no notice. 0.9.0 (user 2026-11-19): the picture on the head unit
 *                          instead ("Picture on: Head unit") - the widget says "Turn View is on the head unit" and
 *                          nothing else; iDrive 7's map area is given back (nothing drawn)
 *   const sc = createScene(cr, { log, now, target });   cr: a ClusterRender (cluster_render_client.js) or a fake with its methods
 *   sc.rect(r); sc.camera(status); sc.camreq(state); sc.noFront(on); sc.disabled(on); sc.hu(on); sc.nv(on); sc.setCal(cal); sc.budget(capKb); sc.show(view, t);
 *   0.10.0 nv(on): the picture is Night Vision's - no turn sign or marks (calibrated for the front camera), no front
 *   camera notices; "No Night Vision picture" when it does not come
 *   sc.retarget(target) -> changed (the layers made again there by the next show); sc.drop(); sc.restore(); sc.status()
 * 0.11.0 iDrive 7 with the IterioDev cluster design: `panel`, its widget slot (the rect the design hosts Waze's map at):
 * card and sign at the map's proportions scaled to the slot's height (0.8 x h / 480 at y 80 x h / 480), the notice the
 * same scale; every layer class content (under the design, seen through the slot's hole) but the notice, class overlay
 * (the design's over band: over its empty plate while there is no camera picture); nothing contends there

 * Uploads: geometry once; the card when its icon / text changes, at most once a second (every 3 s while the shared
 * budget's cap is under 3000 KB/s); a notice when its text changes. u_travel is animated by the renderer between ticks
 * (keys 0:travel 200:travel + speed * 0.2, one animation number replaced every tick).
 */
const SH = require('./shaders');
const C = require('./card');

const KLASS = 'overlay';
const K1 = 0;                       // the lens term (car step C2 measures it; 0 = no correction)
const NOCAM_MS = 30000, CARD_MS = 1000, CARD_SLOW_MS = 3000, SLOW_CAP_KB = 3000, ANIM_MS = 200, SIGN_GAP = 8;
const DRAWN = { route: true, near: true, passed: true, recalc: true };
// targets the cluster shows by itself while a layer wants them (iDrive 7's central map area): nothing drawn = given back
const SELF_SHOWN = { map: true };
// iDrive 7's map: the cluster draws its model badge over the top 64 rows and its readouts over the sides (waze-on-cluster
// PATCH.md "Safe area" 504x368@286,72): the card smaller, at the clear middle's top
const CARD_MAP = { k: 0.8, y: 80 };
// iDrive 7's renderer (RAMSES 19): u_travel sent as a uniform every tick, never animated (0.9.1, below)
const NO_ANIM = { map: true, panel: true };

function camOf(cal) { return { cx: cal.x, cy: cal.h, cz: 0, crx: -cal.pitch, cry: -cal.yaw, crz: 0, fov: cal.fov }; }

function createScene(cr, o) {
    o = o || {};
    const log = o.log || (() => {}), now = o.now || Date.now;
    let target = o.target || 'widget';
    let refs = null, rect = null;
    let camera = 'off', cameraSince = now(), camreq = 'idle', capKb = 5500, noFront = false, disabled = false, onHu = false, nvOn = false;
    let cal = { h: 0.5, pitch: 12, fov: 60, yaw: 0, x: 0 };
    let vis = {}, uni = {}, travelSent = false, animAt = -Infinity, cardKey = '', cardWant = '', cardAt = -Infinity, noticeKey = null, lastNotice = null;

    const place = (w, h, at) => (at === 'top'
        ? { x: Math.round(rect.x + (rect.w - w) / 2), y: rect.y + 16, w, h }
        : { x: Math.round(rect.x + (rect.w - w) / 2), y: Math.round(rect.y + (rect.h - h) / 2), w, h });
    // the card's scale and top: iDrive 7's map CARD_MAP; the design's slot (panel) the same scaled to its height
    const cardScale = () => (target === 'map' ? CARD_MAP : target === 'panel' ? { k: CARD_MAP.k * rect.h / 480, y: Math.round(CARD_MAP.y * rect.h / 480) } : null);
    function cardRect() {
        const m = cardScale();
        if (!m) return place(C.CARD.w, C.CARD.h, 'top');
        const w = Math.round(C.CARD.w * m.k), h = Math.round(C.CARD.h * m.k);
        return { x: Math.round(rect.x + (rect.w - w) / 2), y: rect.y + m.y, w, h };
    }
    const noticeRect = () => { const k = target === 'panel' ? cardScale().k : 1; return place(Math.round(C.NOTICE.w * k), Math.round(C.NOTICE.h * k), 'mid'); };
    // the sign's highest top (NDC y of the rect): SIGN_GAP px under the card
    function signTop() { const c = cardRect(); return 1 - 2 * (c.y + c.h + SIGN_GAP - rect.y) / rect.h; }
    function make() {
        const base = { target, klass: target === 'panel' ? 'content' : KLASS, visible: false, contend: SELF_SHOWN[target] ? 1 : 0 };
        const mesh = (z) => cr.mesh(Object.assign({}, base, rect, { z, near: 0.5, far: 150 }, camOf(cal)));
        refs = { chevrons: mesh(10), marks: mesh(15) };
        cr.part(refs.chevrons, 1, { vs: SH.CHEVRON_VS, fs: SH.CHEVRON_FS, depth: false, cull: 'none', blend: 'alpha' });
        cr.geometry(refs.chevrons, 1, SH.signGeometry());
        cr.part(refs.marks, 1, { vs: SH.MARKS_VS, fs: SH.MARKS_FS, depth: false, cull: 'none', blend: 'alpha' });
        cr.geometry(refs.marks, 1, SH.marksGeometry());
        refs.card = cr.image(Object.assign({}, base, cardRect(), { z: 20, iw: C.CARD.w, ih: C.CARD.h }));
        refs.shade = cr.effect(Object.assign({}, base, rect, { z: 30, fs: SH.SHADE_FS }));
        refs.notice = cr.image(Object.assign({}, base, noticeRect(), { klass: 'overlay', z: 31, iw: C.NOTICE.w, ih: C.NOTICE.h }));
        cr.uniform(refs.shade, 'u_size', [rect.w, rect.h]);
        vis = {}; uni = {}; travelSent = false; animAt = -Infinity; cardKey = ''; cardAt = -Infinity; noticeKey = null;
        log(`scene: layers made on ${target} at ${rect.w}x${rect.h}@${rect.x},${rect.y}`);
    }
    function unmake() {
        if (!refs) return;
        ['chevrons', 'marks', 'card', 'shade', 'notice'].forEach((k) => cr.drop(refs[k]));
        refs = null;
        log(`scene: layers dropped from ${target}`);
    }
    function setVis(name, on) {
        if (vis[name] === on) return;
        vis[name] = on;
        cr.set(refs[name], { visible: on });
    }
    function uniform(name, v) {
        if (uni[name] !== undefined && Math.abs(uni[name] - v) <= 1e-4) return;
        uni[name] = v;
        cr.uniform(refs.chevrons, name, [v], { part: 1 });
    }
    function noticeOf(view, t) {
        if (noFront && !nvOn) return 'nofront';         // (user 2026-11-12: such a car gets that and nothing else)
        if (camera === 'stalled') return nvOn ? 'nonv' : 'busy';
        if (camera === 'refused') return 'full';        // (0.6.1: the cluster's 2 videos are other apps')
        if (camera === 'waiting' && t - cameraSince >= NOCAM_MS) return nvOn ? 'nonv' : 'nocam';
        if (camreq === 'refused' && !nvOn) return 'nocam';
        return null;
    }

    const sc = {
        rect(r) {
            if (!r || !(r.w > 0 && r.h > 0)) return;
            const moved = !rect || r.x !== rect.x || r.y !== rect.y || r.w !== rect.w || r.h !== rect.h;
            rect = { x: r.x, y: r.y, w: r.w, h: r.h };
            if (!refs) { if (!o.dropped) make(); return; }
            if (!moved) return;
            ['chevrons', 'marks', 'shade'].forEach((n) => cr.set(refs[n], rect));
            cr.set(refs.card, cardRect());
            cr.set(refs.notice, noticeRect());
            cr.uniform(refs.shade, 'u_size', [rect.w, rect.h]);
        },
        camera(s) { if (s !== camera) { camera = s; cameraSince = now(); } },
        camreq(s) { camreq = s || 'idle'; },
        noFront(on) { noFront = !!on; },
        disabled(on) { disabled = !!on; },
        hu(on) { onHu = !!on; },
        nv(on) { nvOn = !!on; },
        budget(kb) { if (typeof kb === 'number') capKb = kb; },
        setCal(c) {
            const was = JSON.stringify(camOf(cal));
            cal = Object.assign({}, cal, c);
            if (refs && JSON.stringify(camOf(cal)) !== was) { cr.set(refs.chevrons, camOf(cal)); cr.set(refs.marks, camOf(cal)); }
        },
        show(view, t) {
            if (!refs && rect && !o.dropped) make();
            if (!refs) return;
            const st = view.state, drawn = !!DRAWN[st], decoding = camera === 'decoding';
            const self = !!SELF_SHOWN[target], off = st === 'off' || onHu;
            // the picture on the head unit (0.9.0): said in a picked widget, not black; iDrive 7's map area given back
            const huNote = onHu && !self;
            const offNote = !huNote && off && disabled && !self;   // switched off: said, not black (iDrive 8's picked widget)
            const nofront = noFront && !nvOn;               // (0.10.0: Night Vision needs no front camera)
            const gone = self && (nofront || onHu);         // iDrive 7, no front camera / on the head unit: the map area given back
            const shade = !gone && (huNote || offNote || (!off && (nofront || (view.video && !decoding))));
            const n = huNote ? 'hu' : offNote ? 'off' : shade ? noticeOf(view, t) : null;
            const turn = (st === 'near' || st === 'passed') && view.angle > 0;
            const want = { chevrons: !off && !gone && turn && decoding && !shade && !nvOn,
                marks: !off && !gone && st === 'calib' && decoding && !shade && !nvOn,
                card: !off && !gone && drawn && !shade, shade, notice: !!n };
            lastNotice = n;
            // pixels before they show: a layer without content would be stalled
            if (n && n !== noticeKey) { const p = C.notice(n); cr.pixels(refs.notice, null, p.rgba); noticeKey = n; }
            if (want.card) {
                const key = `${view.icon}|${view.text}|${view.dim ? 1 : 0}|${view.exit}`;
                if (key !== cardKey) cardWant = key;
                if (cardWant && cardWant !== cardKey && t - cardAt >= (capKb < SLOW_CAP_KB ? CARD_SLOW_MS : CARD_MS)) {
                    const p = C.card(view.icon, view.text, { dim: view.dim, exit: view.exit });
                    cr.pixels(refs.card, null, p.rgba);
                    cardKey = cardWant; cardAt = t;
                }
                if (!cardKey) want.card = false;          // nothing drawn yet
            }
            if (want.chevrons) {
                uniform('u_side', view.side); uniform('u_alpha', view.alpha); uniform('u_l0', view.l0);
                uniform('u_k1', K1); uniform('u_aspect', rect.w / rect.h); uniform('u_top', signTop());
                // 0.9.1 (customer X3 M, iDrive 7, 2026-11-20: the sign at the first turn only): u_travel itself is sent
                // again, not only animated - a replaced or refused animation falls back to the value the client set,
                // which stayed the first turn's travel, so every later turn sat hundreds of metres too far (faded out).
                // iDrive 7's renderer (RAMSES 19) rebuilds its whole animation system for every replaced animation:
                // there the uniform alone, every tick; iDrive 8: the uniform + one animation per ANIM_MS (its keys span
                // that long; each a scene change cluster-render sends to the cluster - car 2026-11-07: the head unit lagged)
                if (NO_ANIM[target]) uniform('u_travel', view.travel);
                else if (!travelSent || t - animAt >= ANIM_MS) {
                    animAt = t; travelSent = true;
                    cr.uniform(refs.chevrons, 'u_travel', [view.travel], { part: 1 });
                    cr.animate(refs.chevrons, { part: 1, property: 'uniform', name: 'u_travel', anim: 1,
                        keys: `0:${view.travel.toFixed(3)} ${ANIM_MS}:${(view.travel + view.speed * ANIM_MS / 1000).toFixed(3)}` });
                }
            }
            Object.keys(want).forEach((k) => setVis(k, want[k]));
        },
        drop() {
            o.dropped = true;
            unmake();
        },
        retarget(t) {
            if (t === target) return false;
            unmake();
            target = t;
            return true;
        },
        restore() { o.dropped = false; },
        status: () => ({ layers: Object.assign({ chevrons: false, marks: false, card: false, shade: false, notice: false }, vis),
            notice: lastNotice, made: !!refs }),
    };
    return sc;
}

/* 0.9.0 (user 2026-11-19, kerb parking): the head unit's picture - the camera's whole frame (8:3, camcluster --hu) on
 * the app's Camera page - with the cluster's card and turn sign over it, sized as on the iDrive 8 widget (640 px high:
 * card 360 x 150 at the top, 16 px down). Fractions of the picture (0..1, y down) for the app's video element:
 *   huOverlay(view, cal, nv) -> { card: { x, y, w, h } | null, sign: { quads: [[[x, y] x 4] x 6], a } | null }
 *   (nv, 0.10.0: Night Vision's picture - no sign) */
const HU_ASPECT = 8 / 3, HU_H = 640;
const HU_CARD = { w: C.CARD.w / (HU_H * HU_ASPECT), h: C.CARD.h / HU_H, y: 16 / HU_H };
const SIGN = SH.signGeometry();
function huOverlay(view, cal, nv) {
    const st = view.state, card = !!DRAWN[st] && !!view.icon;
    const c = card ? { x: (1 - HU_CARD.w) / 2, y: HU_CARD.y, w: HU_CARD.w, h: HU_CARD.h } : null;
    let sign = null;
    if (!nv && (st === 'near' || st === 'passed') && view.angle > 0) {
        const top = 1 - 2 * (c ? c.y + c.h + SIGN_GAP / HU_H : 0);
        const u = { l0: view.l0, travel: view.travel, side: view.side, alpha: view.alpha, top }, P = SIGN.positions, quads = [];
        let a = 0, ok = true;
        for (let q = 0; q < P.length / 12 && ok; q++) {
            const pts = [];
            for (let v = 0; v < 4; v++) {
                const j = (q * 4 + v) * 3, p = SH.signPoint(P[j], P[j + 1], u, cal, HU_ASPECT);
                if (!p) { ok = false; break; }
                a = p.a;
                pts.push([+((p.x + 1) / 2).toFixed(4), +((1 - p.y) / 2).toFixed(4)]);
            }
            quads.push(pts);
        }
        if (ok && a > 0.01) sign = { quads, a: +a.toFixed(3) };
    }
    return { card: c, sign };
}

module.exports = { createScene, camOf, huOverlay, K1, NOCAM_MS, CARD_MS, CARD_SLOW_MS, HU_ASPECT };
