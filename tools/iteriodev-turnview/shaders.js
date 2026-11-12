'use strict';
/*
 * shaders.js - iteriodev-turnview: the cluster-render shaders (GLSL ES 1.00, PROTOCOL.md "Shaders") and geometry, and
 * JS copies of the vertex shader's road placement and of the renderer's camera for the tests (spec 5.1, 7).
 * Road: plane y = 0, metres, x right, forward = -z (the mesh camera looks down its -z). Chevrons live in "path space"
 * (s along the route, w lateral): the vertex shader moves them with the car (s' = s + AHEAD - mod(u_travel, PITCH)) and bends
 * the path into the turn L = u_l0 - u_travel ahead (an arc of R metres by u_angle toward u_side, then straight).
 */
const R = 8, PITCH = 3.5, COUNT = 8, AHEAD = 4, OPACITY = 0.55;

const CHEVRON_VS = `#version 100
attribute vec3 a_position;
attribute vec2 a_texcoord;
uniform mat4 u_mvp;
uniform highp float u_travel;
uniform highp float u_l0;
uniform float u_angle;
uniform float u_side;
uniform float u_alpha;
uniform float u_k1;
uniform float u_aspect;
varying vec2 v_tc;
varying float v_a;
const float R = ${R.toFixed(1)};
void main() {
    highp float s = a_position.z + ${AHEAD.toFixed(1)} - mod(u_travel, ${PITCH.toFixed(1)});
    float w = a_position.x;
    highp float L = u_l0 - u_travel;
    float th = radians(u_angle);
    vec2 p = vec2(w, s);
    float a = clamp((s - 3.0) / 1.5, 0.0, 1.0) * (1.0 - clamp((s - 25.0) / 5.0, 0.0, 1.0));
    if (s > L && th > 0.001) {
        float d = s - L;
        float arc = R * th;
        float t = min(d, arc) / R;
        vec2 c = vec2(u_side * R, L);
        vec2 on = c + vec2(-u_side * R * cos(t), R * sin(t));
        vec2 dir = vec2(u_side * sin(t), cos(t));
        vec2 nrm = vec2(cos(t), -u_side * sin(t));
        p = on + nrm * w;
        if (d > arc) {
            p += dir * (d - arc);
            a *= 1.0 - clamp((d - arc) / 6.0, 0.0, 1.0);
        }
    }
    vec4 clip = u_mvp * vec4(p.x, a_position.y, -p.y, 1.0);
    if (u_k1 != 0.0 && clip.w > 0.0) {
        vec2 n = clip.xy / clip.w;
        float r2 = n.x * n.x * u_aspect * u_aspect + n.y * n.y;
        clip.xy = n * (1.0 + u_k1 * r2) * clip.w;
    }
    gl_Position = clip;
    v_tc = a_texcoord;
    v_a = a * u_alpha;
}`;

const CHEVRON_FS = `#version 100
precision mediump float;
varying vec2 v_tc;
varying float v_a;
const float OPACITY = ${OPACITY.toFixed(2)};
void main() {
    // v_tc.x 0 on the road .. 1 the raised edge: deep blue at the foot, bright cyan-white along the top (lit from above);
    // see-through (user 2026-11-07: "should be semi transparent so i can also see stuff in the camera")
    float e = abs(v_tc.x - 0.5) * 2.0;
    vec3 c = mix(vec3(0.0, 0.5, 1.0), vec3(0.75, 0.95, 1.0), smoothstep(0.3, 1.0, v_tc.x));
    gl_FragColor = vec4(c, v_a * OPACITY * (1.0 - smoothstep(0.92, 1.0, e)));
}`;

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

/* COUNT chevrons one every PITCH m from s 0 (seen from AHEAD m on, faded out from 25 m): two arms each from the tip (0, s0 + DEPTH) to the end (±HALF_W, s0), THICK
 * wide, 8 x 2 cells per arm (a lens term can bend them); positions [w, height, s], texcoords (across, along).
 * Raised: each arm leans back from the road at TILT (a low fence of arrows), because a flat one seen from a bumper
 * camera ~0.5 m up foreshortens to a thin line (car 2026-11-07: "very dim, need actual arrows"). */
const HALF_W = 0.65, DEPTH = 0.9, THICK = 0.5, TILT = 20 * Math.PI / 180;
function chevronGeometry() {
    const positions = [], texcoords = [], indices = [], N = 8, M = 2, T = THICK;
    for (let k = 0; k < COUNT; k++) {
        const s0 = PITCH * k;
        [-1, 1].forEach((sd) => {
            const base = positions.length / 3;
            for (let i = 0; i <= N; i++) {
                const f = i / N, w = sd * HALF_W * f, s = s0 + DEPTH - DEPTH * f;
                for (let j = 0; j <= M; j++) {
                    const g = j / M;
                    positions.push(w, T * g * Math.sin(TILT), s - T * g * Math.cos(TILT));
                    texcoords.push(g, f);
                }
            }
            for (let i = 0; i < N; i++) {
                for (let j = 0; j < M; j++) {
                    const a = base + i * (M + 1) + j, b = a + M + 1;
                    indices.push(a, b, a + 1, a + 1, b, b + 1);
                }
            }
        });
    }
    return { positions, texcoords, indices };
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

/* the vertex shader's placement, in JS: path point (s, w) -> road { x, z, a } (z = -forward); u: travel, l0, angle, side */
function pathPoint(s0, w, u) {
    const s = s0 + AHEAD - (((u.travel % PITCH) + PITCH) % PITCH), L = u.l0 - u.travel, th = u.angle * Math.PI / 180;
    let px = w, py = s, a = Math.min(1, Math.max(0, (s - 3) / 1.5)) * (1 - Math.min(1, Math.max(0, (s - 25) / 5)));
    if (s > L && th > 0.001) {
        const d = s - L, arc = R * th, t = Math.min(d, arc) / R;
        px = u.side * R - u.side * R * Math.cos(t) + Math.cos(t) * w;
        py = L + R * Math.sin(t) - u.side * Math.sin(t) * w;
        if (d > arc) {
            px += u.side * Math.sin(t) * (d - arc);
            py += Math.cos(t) * (d - arc);
            a *= 1 - Math.min(1, Math.max(0, (d - arc) / 6));
        }
    }
    return { x: px, z: -py, a };
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

module.exports = { CHEVRON_VS, CHEVRON_FS, MARKS_VS, MARKS_FS, SHADE_FS, chevronGeometry, marksGeometry, pathPoint, project, R, PITCH, AHEAD, COUNT };
