'use strict';
/*
 * scene.js - iteriodev-turnview: the tool's cluster-render layers on the iDrive 8 widget for a track.js view
 * (spec 5). All on one target: `widget` (the user picks it in the cluster's widget menu) or `popup` (the pop-up
 * setting, 2026-11-13: the cluster shows it by itself while a layer is drawn, so the tool shows the view 'off' while
 * it is down), class overlay, over the camera's rect (camcluster's last `rect` line):
 *   chevrons  mesh  z 10   the road arrows (shaders.js), only over the whole frame (`rect full`) while it decodes
 *   marks     mesh  z 15   5 / 10 / 20 m lines while calibrating, same camera
 *   card      image z 20   icon + distance, top centre (card.js)
 *   shade     effect z 30  a dark fill with soft edges, no upload
 *   notice    image z 31   "No front camera" (the car has none: before everything, alone) / "no route" / "Camera busy" /
 *                          "No camera", centred
 *   const sc = createScene(cr, { log, now, target });   cr: a ClusterRender (cluster_render_client.js) or a fake with its methods
 *   sc.rect(kind, r); sc.camera(status); sc.camreq(state); sc.noFront(on); sc.setCal(cal); sc.budget(capKb); sc.show(view, t);
 *   sc.retarget(target) -> changed (the layers made again there by the next show); sc.drop(); sc.status()
 * Uploads: geometry once; the card when its icon / text changes, at most once a second (every 3 s while the shared
 * budget's cap is under 3000 KB/s); a notice when its text changes. u_travel is animated by the renderer between ticks
 * (keys 0:travel 200:travel + speed * 0.2, one animation number replaced every tick).
 */
const SH = require('./shaders');
const C = require('./card');

const KLASS = 'overlay';
const K1 = 0;                       // the lens term (car step C2 measures it; 0 = no correction)
const NOCAM_MS = 30000, CARD_MS = 1000, CARD_SLOW_MS = 3000, SLOW_CAP_KB = 3000, FAR_SEND = 10000, ANIM_MS = 200;
const DRAWN = { route: true, near: true, passed: true, recalc: true };

function camOf(cal) { return { cx: cal.x, cy: cal.h, cz: 0, crx: -cal.pitch, cry: -cal.yaw, crz: 0, fov: cal.fov }; }

function createScene(cr, o) {
    o = o || {};
    const log = o.log || (() => {}), now = o.now || Date.now;
    let target = o.target || 'widget';
    let refs = null, rect = null, kind = null;
    let camera = 'off', cameraSince = now(), camreq = 'idle', capKb = 5500, noFront = false;
    let cal = { h: 0.5, pitch: 12, fov: 60, yaw: 0, x: 0 };
    let vis = {}, uni = {}, travelSent = false, animAt = -Infinity, cardKey = '', cardWant = '', cardAt = -Infinity, noticeKey = null, lastNotice = null;

    const place = (w, h, at) => (at === 'top'
        ? { x: Math.round(rect.x + (rect.w - w) / 2), y: rect.y + 16, w, h }
        : { x: Math.round(rect.x + (rect.w - w) / 2), y: Math.round(rect.y + (rect.h - h) / 2), w, h });
    function make() {
        const base = { target, klass: KLASS, visible: false };
        const mesh = (z) => cr.mesh(Object.assign({}, base, rect, { z, near: 0.5, far: 150 }, camOf(cal)));
        refs = { chevrons: mesh(10), marks: mesh(15) };
        cr.part(refs.chevrons, 1, { vs: SH.CHEVRON_VS, fs: SH.CHEVRON_FS, depth: false, cull: 'none', blend: 'alpha' });
        cr.geometry(refs.chevrons, 1, SH.chevronGeometry());
        cr.part(refs.marks, 1, { vs: SH.MARKS_VS, fs: SH.MARKS_FS, depth: false, cull: 'none', blend: 'alpha' });
        cr.geometry(refs.marks, 1, SH.marksGeometry());
        refs.card = cr.image(Object.assign({}, base, place(C.CARD.w, C.CARD.h, 'top'), { z: 20, iw: C.CARD.w, ih: C.CARD.h }));
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
        if (view.state === 'none') return 'none';
        if (camera === 'stalled') return 'busy';
        if (camreq === 'refused' || (camera === 'waiting' && t - cameraSince >= NOCAM_MS)) return 'nocam';
        return null;
    }

    const sc = {
        rect(k, r) {
            if (!r || !(r.w > 0 && r.h > 0)) return;
            const moved = !rect || r.x !== rect.x || r.y !== rect.y || r.w !== rect.w || r.h !== rect.h;
            kind = k; rect = { x: r.x, y: r.y, w: r.w, h: r.h };
            if (!refs) { if (!o.dropped) make(); return; }
            if (!moved) return;
            ['chevrons', 'marks', 'shade'].forEach((n) => cr.set(refs[n], rect));
            cr.set(refs.card, place(C.CARD.w, C.CARD.h, 'top'));
            cr.set(refs.notice, place(C.NOTICE.w, C.NOTICE.h, 'mid'));
            cr.uniform(refs.shade, 'u_size', [rect.w, rect.h]);
        },
        camera(s) { if (s !== camera) { camera = s; cameraSince = now(); } },
        camreq(s) { camreq = s || 'idle'; },
        noFront(on) { noFront = !!on; },
        budget(kb) { if (typeof kb === 'number') capKb = kb; },
        setCal(c) {
            const was = JSON.stringify(camOf(cal));
            cal = Object.assign({}, cal, c);
            if (refs && JSON.stringify(camOf(cal)) !== was) { cr.set(refs.chevrons, camOf(cal)); cr.set(refs.marks, camOf(cal)); }
        },
        show(view, t) {
            if (!refs && rect && !o.dropped) make();
            if (!refs) return;
            const st = view.state, drawn = !!DRAWN[st], decoding = camera === 'decoding', full = kind === 'full';
            const off = st === 'off';
            const shade = !off && (noFront || st === 'none' || (view.video && !decoding));
            const n = shade ? noticeOf(view, t) : null;
            const want = { chevrons: !off && drawn && decoding && full && !shade, marks: !off && st === 'calib' && decoding && full && !shade,
                card: !off && drawn && !shade, shade, notice: !!n };
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
                uniform('u_angle', view.angle); uniform('u_side', view.side); uniform('u_alpha', view.alpha);
                uniform('u_k1', K1); uniform('u_aspect', rect.w / rect.h);
                if (st === 'near' || st === 'passed') uniform('u_l0', view.l0);
                else if (uni.u_l0 === undefined || uni.u_l0 - view.travel < FAR_SEND / 2 || uni.u_l0 - view.travel > FAR_SEND * 2) uniform('u_l0', view.travel + FAR_SEND);
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
            notice: lastNotice, rect: kind, made: !!refs }),
    };
    return sc;
}

module.exports = { createScene, camOf, K1, NOCAM_MS, CARD_MS, CARD_SLOW_MS };
