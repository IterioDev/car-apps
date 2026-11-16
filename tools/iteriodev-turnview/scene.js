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
 *                          route = the camera alone, no notice
 *   const sc = createScene(cr, { log, now, target });   cr: a ClusterRender (cluster_render_client.js) or a fake with its methods
 *   sc.rect(r); sc.camera(status); sc.camreq(state); sc.noFront(on); sc.disabled(on); sc.setCal(cal); sc.budget(capKb); sc.show(view, t);
 *   sc.retarget(target) -> changed (the layers made again there by the next show); sc.drop(); sc.restore(); sc.status()
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

function camOf(cal) { return { cx: cal.x, cy: cal.h, cz: 0, crx: -cal.pitch, cry: -cal.yaw, crz: 0, fov: cal.fov }; }

function createScene(cr, o) {
    o = o || {};
    const log = o.log || (() => {}), now = o.now || Date.now;
    let target = o.target || 'widget';
    let refs = null, rect = null;
    let camera = 'off', cameraSince = now(), camreq = 'idle', capKb = 5500, noFront = false, disabled = false;
    let cal = { h: 0.5, pitch: 12, fov: 60, yaw: 0, x: 0 };
    let vis = {}, uni = {}, travelSent = false, animAt = -Infinity, cardKey = '', cardWant = '', cardAt = -Infinity, noticeKey = null, lastNotice = null;

    const place = (w, h, at) => (at === 'top'
        ? { x: Math.round(rect.x + (rect.w - w) / 2), y: rect.y + 16, w, h }
        : { x: Math.round(rect.x + (rect.w - w) / 2), y: Math.round(rect.y + (rect.h - h) / 2), w, h });
    function cardRect() {
        if (target !== 'map') return place(C.CARD.w, C.CARD.h, 'top');
        const w = Math.round(C.CARD.w * CARD_MAP.k), h = Math.round(C.CARD.h * CARD_MAP.k);
        return { x: Math.round(rect.x + (rect.w - w) / 2), y: rect.y + CARD_MAP.y, w, h };
    }
    // the sign's highest top (NDC y of the rect): SIGN_GAP px under the card
    function signTop() { const c = cardRect(); return 1 - 2 * (c.y + c.h + SIGN_GAP - rect.y) / rect.h; }
    function make() {
        const base = { target, klass: KLASS, visible: false, contend: SELF_SHOWN[target] ? 1 : 0 };
        const mesh = (z) => cr.mesh(Object.assign({}, base, rect, { z, near: 0.5, far: 150 }, camOf(cal)));
        refs = { chevrons: mesh(10), marks: mesh(15) };
        cr.part(refs.chevrons, 1, { vs: SH.CHEVRON_VS, fs: SH.CHEVRON_FS, depth: false, cull: 'none', blend: 'alpha' });
        cr.geometry(refs.chevrons, 1, SH.signGeometry());
        cr.part(refs.marks, 1, { vs: SH.MARKS_VS, fs: SH.MARKS_FS, depth: false, cull: 'none', blend: 'alpha' });
        cr.geometry(refs.marks, 1, SH.marksGeometry());
        refs.card = cr.image(Object.assign({}, base, cardRect(), { z: 20, iw: C.CARD.w, ih: C.CARD.h }));
        refs.shade = cr.effect(Object.assign({}, base, rect, { z: 30, fs: SH.SHADE_FS }));
        refs.notice = cr.image(Object.assign({}, base, place(C.NOTICE.w, C.NOTICE.h, 'mid'), { z: 31, iw: C.NOTICE.w, ih: C.NOTICE.h }));
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
        if (noFront) return 'nofront';                  // (user 2026-11-12: such a car gets that and nothing else)
        if (camera === 'stalled') return 'busy';
        if (camera === 'refused') return 'full';        // (0.6.1: the cluster's 2 videos are other apps')
        if (camreq === 'refused' || (camera === 'waiting' && t - cameraSince >= NOCAM_MS)) return 'nocam';
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
            cr.set(refs.notice, place(C.NOTICE.w, C.NOTICE.h, 'mid'));
            cr.uniform(refs.shade, 'u_size', [rect.w, rect.h]);
        },
        camera(s) { if (s !== camera) { camera = s; cameraSince = now(); } },
        camreq(s) { camreq = s || 'idle'; },
        noFront(on) { noFront = !!on; },
        disabled(on) { disabled = !!on; },
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
            const off = st === 'off', self = !!SELF_SHOWN[target];
            const offNote = off && disabled && !self;       // switched off: said, not black (iDrive 8's picked widget)
            const gone = self && noFront;                   // iDrive 7, no front camera: the map area given back
            const shade = !gone && (offNote || (!off && (noFront || (view.video && !decoding))));
            const n = offNote ? 'off' : shade ? noticeOf(view, t) : null;
            const turn = (st === 'near' || st === 'passed') && view.angle > 0;
            const want = { chevrons: !off && !gone && turn && decoding && !shade, marks: !off && !gone && st === 'calib' && decoding && !shade,
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
                if (!travelSent) { cr.uniform(refs.chevrons, 'u_travel', [view.travel], { part: 1 }); travelSent = true; }
                // one animation per ANIM_MS (its keys span that long): each one is a scene change cluster-render
                // sends to the cluster (car 2026-11-07: the head unit lagged)
                if (t - animAt >= ANIM_MS) {
                    animAt = t;
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

module.exports = { createScene, camOf, K1, NOCAM_MS, CARD_MS, CARD_SLOW_MS };
