'use strict';
/*
 * shaders.js - iteriodev-turnview: the cluster-render shaders (GLSL ES 1.00, PROTOCOL.md "Shaders") and geometry, and
 * JS copies of the vertex shader's placement and of the renderer's camera for the tests (spec 5.1, 7).
 * Road: plane y = 0, metres, x right, forward = -z (the mesh camera looks down its -z).
 * Turn sign (user 2026-11-16, replaces the road chevrons: "3 arrows side by side like the turn signs ... blue and only
 * show arrows for turns, not when driving straight", picked B = chevrons only, no board): three blue chevrons standing
 * AHEAD m past the turn point (L = u_l0 - u_travel ahead), facing the car, pointing u_side. A bumper camera sees ~100°
 * across, so the true size is a speck: drawn at the size it has NEAR + GROW * D m away (D its real distance), it grows
 * as the turn nears. Fades in from FADE_FAR to FADE_FAR - FADE_M m before the turn. Its top is held at u_top (NDC y,
 * scene.js: under the turn card) so on both HMIs' rects (iDrive 8 widget 1320x640, iDrive 7 map 1088x480 with the
 * card lower) it never runs into the card; sizes are fractions of the rect's height, so they scale with it.
 */
const CH = 0.95, CT = 0.5, CP = 1.05, FOOT = 0.5, AHEAD = 8, NEAR = 4, GROW = 0.12, FADE_FAR = 80, FADE_M = 20, OPACITY = 0.85;
const SPAN = 2 * CP + CT + CH / 2;      // the three chevrons' width (sign space x -SPAN/2 .. SPAN/2)

const CHEVRON_VS = `#version 100
attribute vec3 a_position;
uniform mat4 u_mvp;
uniform highp float u_travel;
uniform highp float u_l0;
uniform float u_side;
uniform float u_alpha;
uniform float u_top;
uniform float u_k1;
uniform float u_aspect;
varying float v_a;
void main() {
    highp float L = u_l0 - u_travel;
    float D = max(L + ${AHEAD.toFixed(1)}, 1.0);
    float k = D / (${NEAR.toFixed(1)} + ${GROW.toFixed(2)} * D);
    vec4 clip = u_mvp * vec4(u_side * a_position.x * k, (${FOOT.toFixed(2)} + a_position.y) * k, -D, 1.0);
    vec4 top = u_mvp * vec4(0.0, ${(FOOT + CH).toFixed(2)} * k, -D, 1.0);
    if (top.w > 0.0) clip.y -= max(top.y / top.w - u_top, 0.0) * clip.w;
    if (u_k1 != 0.0 && clip.w > 0.0) {
        vec2 n = clip.xy / clip.w;
        float r2 = n.x * n.x * u_aspect * u_aspect + n.y * n.y;
        clip.xy = n * (1.0 + u_k1 * r2) * clip.w;
    }
    gl_Position = clip;
    v_a = u_alpha * clamp((${FADE_FAR.toFixed(1)} - L) / ${FADE_M.toFixed(1)}, 0.0, 1.0);
}`;

const CHEVRON_FS = `#version 100
precision mediump float;
varying float v_a;
void main() { gl_FragColor = vec4(0.0, 0.43, 1.0, v_a * ${OPACITY.toFixed(2)}); }`;

const MARKS_VS = `#version 100
attribute vec3 a_position;
attribute vec4 a_color;
uniform mat4 u_mvp;
varying vec4 v_color;
void main() {
    gl_Position = u_mvp * vec4(a_position.x, 0.0, -a_position.z, 1.0);
    v_color = a_color;
}`;

const MARKS_FS = `#version 100
precision mediump float;
varying vec4 v_color;
void main() { gl_FragColor = v_color; }`;

// the shade: a dark rounded fill with soft edges over the camera's rect (effect layer, v_uv 0,0 top-left)
const SHADE_FS = `#version 100
precision mediump float;
uniform vec2 u_size;
varying vec2 v_uv;
void main() {
    vec2 p = v_uv * u_size, h = u_size * 0.5;
    vec2 q = abs(p - h) - (h - vec2(24.0 + 12.0));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 12.0;
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.78 * (1.0 - smoothstep(-24.0, 0.0, d)));
}`;

/* the sign: three chevrons pointing +x, each two arms (quads) from the foot / top (x0, 0 / CH) to the tip row (x0 + CH/2,
 * CH/2), CT wide, CP apart; positions [x, y, 0] in sign space (metres, y up from the foot) */
function signGeometry() {
    const positions = [], indices = [], ym = CH / 2;
    const quad = (pts) => { const b = positions.length / 3; pts.forEach(([x, y]) => positions.push(x, y, 0)); indices.push(b, b + 1, b + 2, b, b + 2, b + 3); };
    for (let i = 0; i < 3; i++) {
        const x0 = -SPAN / 2 + i * CP;
        quad([[x0, CH], [x0 + CT, CH], [x0 + CT + ym, ym], [x0 + ym, ym]]);
        quad([[x0 + ym, ym], [x0 + CT + ym, ym], [x0 + CT, 0], [x0, 0]]);
    }
    return { positions, indices };
}

/* the calibration marks: 2 m wide lines at 5 m (red), 10 m (amber), 20 m (green); positions [x, 0, forward] */
const MARKS = [[5, [1, 0.23, 0.19, 0.9]], [10, [1, 0.69, 0.13, 0.9]], [20, [0.36, 0.84, 0.54, 0.9]]];
function marksGeometry() {
    const positions = [], colors = [], indices = [];
    MARKS.forEach(([d, c], i) => {
        [[-1, d - 0.08], [1, d - 0.08], [-1, d + 0.08], [1, d + 0.08]].forEach(([x, z]) => { positions.push(x, 0, z); colors.push.apply(colors, c); });
        const b = i * 4;
        indices.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
    });
    return { positions, colors, indices };
}

/* the vertex shader in JS: sign vertex (x, y) -> NDC { x, y } and alpha; u: travel, l0, side, alpha, top; null behind */
function signPoint(x, y, u, cal, aspect) {
    const L = u.l0 - u.travel, D = Math.max(L + AHEAD, 1), k = D / (NEAR + GROW * D);
    const p = project({ x: u.side * x * k, y: (FOOT + y) * k, z: -D }, cal, aspect), t = project({ x: 0, y: (FOOT + CH) * k, z: -D }, cal, aspect);
    if (!p) return null;
    const a = (u.alpha === undefined ? 1 : u.alpha) * Math.min(1, Math.max(0, (FADE_FAR - L) / FADE_M));
    return { x: p.x, y: p.y - (t ? Math.max(t.y - u.top, 0) : 0), a, k };
}

/* the renderer's camera (graph_ramses27: setTranslation + setRotation of the negated right-handed angles, frustum
 * from fov and the rect's aspect) applied to a world point: model = T * Ry * Rx (pitch about the camera's own x, then
 * the yaw about world y), which is RAMSES 27's legacy ZYX setRotation for those angles (Matrix33f::RotationEuler,
 * checked in test_scene.js). -> NDC { x, y } (y up), null behind the camera */
function project(p, cal, aspect) {
    const rx = -cal.pitch * Math.PI / 180, ry = -cal.yaw * Math.PI / 180;
    // world -> camera: inverse(T * Ry * Rx) = Rx^-1 * Ry^-1 * T^-1
    let x = p.x - cal.x, y = (p.y || 0) - cal.h, z = p.z;
    const cy = Math.cos(-ry), sy = Math.sin(-ry);
    const x1 = cy * x + sy * z, z1 = -sy * x + cy * z;
    const cx = Math.cos(-rx), sx = Math.sin(-rx);
    const y2 = cx * y - sx * z1, z2 = sx * y + cx * z1;
    x = x1; y = y2; z = z2;
    if (z >= 0) return null;
    const f = 1 / Math.tan(cal.fov * Math.PI / 360);
    return { x: (f / aspect) * x / -z, y: f * y / -z };
}

module.exports = { CHEVRON_VS, CHEVRON_FS, MARKS_VS, MARKS_FS, SHADE_FS, signGeometry, marksGeometry, signPoint, project, SPAN, CH, AHEAD, NEAR, GROW, FADE_FAR, FADE_M };
