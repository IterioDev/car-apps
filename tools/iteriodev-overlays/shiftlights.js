'use strict';
/*
 * shiftlights.js - iteriodev-overlays: shift lights on the instrument cluster for any car (iDrive 8), M or not,
 * drawn by cluster-render (robertnisipeanu/idrive-apps) as effect layers: in its target `guide`, the cluster's
 * guiding-panel area, top centre over the map (Ca_GuidingPanel_IC, 702x213), and on cars without their own (not M)
 * in `hud`, the head-up display above its speed bar (Ca_ComCenter_HUD, 353x203). Both are shown by the cluster as
 * soon as they are offered: no widget menu. Pure: values in, segments and the shaders out; overlays.js reads the car
 * and talks to cluster-render. analysis/2026-11-03-m-shiftlights.md.
 *
 * What lights them (0.6.0, user 2026-11-20: the rpm set in the app only, nothing taken from the car): the engine
 * speed, CDS 0xB513 statusEngineSpeed2 (getter 25 every 50 ms, u16 x 0.25 rpm, as Car Data reads it), against the
 * start and flash rpm of the settings. 8 segments from start to flash; at the flash rpm all flash. (0.5.x followed
 * the DME's allowed maximum, VehicleInformation 0x1536 byte 13, and an M car's own segments, MDrive 0xB51F 0x8010:
 * both gone; the DME's segments are still read, only to know an M car whose cluster has its own shift lights.)
 */

const SEGMENTS = 8;
const SHOW_BELOW = 1000, HIDE_BELOW = 1500, HIDE_AFTER_MS = 3000;
// the targets' canvases and where the bars go in them: 8 a side from the outer edges inward, `top`-`bottom` high,
// `inset` from the edge, one every `pitch` px, `bar` wide, leaning `slant` px per px of height; `dim` unlit bars drawn
// (not in the HUD: anything drawn there is light, black is see-through). The HUD's bars sit at its bottom, over its
// speed bar.
const TARGETS = {
    guide: { w: 702, h: 213, top: 64, bottom: 132, inset: 20, pitch: 38, bar: 30, slant: 0.35, dim: true },
    hud: { w: 353, h: 203, top: 150, bottom: 190, inset: 8, pitch: 20, bar: 15, slant: 0.35, dim: false },
};
const SIZE = TARGETS.guide;

const RPM = { svc: 0xb513, ev: 0x8019, poll: 'poll 0xb513 1 25 1 50 0x8019' };
const DME = { svc: 0xb51f, ev: 0x8010 };

const DEFAULTS = { on: true, start: 4500, flash: 6500, hud: true };

/* settings from the app: known keys of the right kind only */
function mergeSettings(cur, p) {
    const out = Object.assign({}, DEFAULTS, cur);
    delete out.auto;                             // 0.5.x's "follow the engine's limit": gone (a saved one is dropped)
    if (!p || typeof p !== 'object') return out;
    if (typeof p.on === 'boolean') out.on = p.on;
    if (typeof p.hud === 'boolean') out.hud = p.hud;
    const rpm = (v) => Number.isInteger(v) && v >= 1000 && v <= 10000;
    if (rpm(p.start)) out.start = p.start;
    if (rpm(p.flash)) out.flash = p.flash;
    if (out.start > out.flash - 500) out.start = out.flash - 500;
    return out;
}
/* payloads (hex) -> values; null: not usable */
const rpmOf = (hex) => (hex && hex.length >= 4 ? parseInt(hex.slice(0, 4), 16) * 0.25 : null);
function dmeOf(hex) {
    if (!hex || hex.length < 4) return null;
    const seg = parseInt(hex.slice(0, 2), 16), fl = parseInt(hex.slice(2, 4), 16);
    return seg <= SEGMENTS ? { seg, flash: fl === 1 } : null;
}
/* the start and flash rpm: the settings' */
const thresholds = (set) => ({ start: set.start, flash: set.flash });
/* lit segments and flash at rpm */
function lights(rpm, th) {
    if (!(rpm >= th.start)) return { seg: 0, flash: false };
    if (rpm >= th.flash) return { seg: SEGMENTS, flash: true };
    return { seg: Math.min(SEGMENTS, Math.ceil((rpm - th.start) / (th.flash - th.start) * SEGMENTS)), flash: false };
}
/* shown or not, with a hysteresis so the area isn't offered and released at every blip: shown from start - SHOW_BELOW,
 * hidden once below start - HIDE_BELOW for HIDE_AFTER_MS (st: { shown, lowSince } kept by the caller) */
function visible(st, rpm, th, lit, now) {
    if (lit || rpm >= th.start - SHOW_BELOW) { st.lowSince = 0; st.shown = true; return true; }
    if (!st.shown) return false;
    if (rpm >= th.start - HIDE_BELOW) { st.lowSince = 0; return true; }
    if (!st.lowSince) st.lowSince = now;
    if (now - st.lowSince >= HIDE_AFTER_MS) st.shown = false;
    return st.shown;
}

/* 8 bars a side lit from the outer edges inward (amber, orange, red), unlit ones dim (where t.dim); at the flash rpm
 * all red, blinking 4 times a second. GLSL ES 1.00 for cluster-render's effect layer (v_uv: 0,0 top-left), for target t
 * of TARGETS. */
const f = (n) => (Number.isInteger(n) ? `${n}.0` : String(n));
const fs = (t) => `#version 100
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform highp float u_time;
uniform float u_seg;
uniform float u_flash;
varying vec2 v_uv;
void main() {
    vec2 p = v_uv * vec2(${f(t.w)}, ${f(t.h)});
    float x = p.x < ${f(t.w / 2)} ? p.x : ${f(t.w)} - p.x;
    if (p.y < ${f(t.top)} || p.y > ${f(t.bottom)}) { gl_FragColor = vec4(0.0); return; }
    float xs = x - ${f(t.inset)} - (${f(t.bottom)} - p.y) * ${f(t.slant)};
    float i = floor(xs / ${f(t.pitch)});
    if (xs < 0.0 || i > 7.0 || mod(xs, ${f(t.pitch)}) > ${f(t.bar)}) { gl_FragColor = vec4(0.0); return; }
    vec3 c = i < 3.0 ? vec3(1.0, 0.72, 0.0) : i < 6.0 ? vec3(1.0, 0.42, 0.0) : vec3(1.0, 0.12, 0.1);
    if (u_flash > 0.5) {
        gl_FragColor = vec4(1.0, 0.12, 0.1, 1.0) * step(0.5, fract(u_time * 4.0));
    } else if (i < u_seg) {
        gl_FragColor = vec4(c, 1.0);
    } else {
        gl_FragColor = ${t.dim ? 'vec4(0.55, 0.58, 0.62, 0.22)' : 'vec4(0.0)'};
    }
}`;
const FS = fs(TARGETS.guide);

function test() {
    const assert = require('assert');
    const set = mergeSettings({}, {});
    assert.deepStrictEqual(set, DEFAULTS);
    assert.deepStrictEqual(mergeSettings(set, { start: 6400, flash: 6500, on: 'x' }), { on: true, start: 6000, flash: 6500, hud: true }, 'start kept 500 below flash');
    assert.deepStrictEqual(mergeSettings({ on: true, auto: true, start: 5000, flash: 7000, hud: false }, { auto: false }),
        { on: true, start: 5000, flash: 7000, hud: false }, 'the auto of 0.5.x dropped, the set rpm kept');
    assert.strictEqual(rpmOf('3840'), 3600);                         // 0x3840 = 14400 * 0.25
    assert.deepStrictEqual([dmeOf('0502'), dmeOf('0801'), dmeOf('0f03')], [{ seg: 5, flash: false }, { seg: 8, flash: true }, null]);
    assert.deepStrictEqual(thresholds(mergeSettings(set, { start: 5200, flash: 6800 })), { start: 5200, flash: 6800 }, 'the set rpm, always');
    const th = { start: 4500, flash: 6500 };
    assert.deepStrictEqual([4000, 4500, 4501, 5500, 6499, 6500, 7200].map((r) => lights(r, th).seg), [0, 0, 1, 4, 8, 8, 8]);
    assert.deepStrictEqual([lights(6499, th).flash, lights(6500, th).flash], [false, true]);
    const v = { shown: false, lowSince: 0 };
    assert.deepStrictEqual([visible(v, 3000, th, 0, 0), visible(v, 3600, th, 0, 10), visible(v, 3100, th, 0, 20),
        visible(v, 2900, th, 0, 30), visible(v, 2900, th, 0, 3029), visible(v, 2900, th, 0, 3030)], [false, true, true, true, true, false]);
    assert(/uniform float u_seg;/.test(FS) && !/\$\{/.test(FS));
    const hud = fs(TARGETS.hud);
    assert(/vec2\(353\.0, 203\.0\)/.test(hud) && /x - 8\.0 - \(190\.0 - p\.y\) \* 0\.35/.test(hud) && !/0\.22\)/.test(hud), 'the HUD: its size, no dim bars');
    assert(/0\.22\)/.test(FS), 'the cluster: dim unlit bars');
    console.log('shiftlights self-check ok');
}

module.exports = { SEGMENTS, SIZE, TARGETS, fs, RPM, DME, DEFAULTS, FS, mergeSettings, rpmOf, dmeOf,
    thresholds, lights, visible, test };
