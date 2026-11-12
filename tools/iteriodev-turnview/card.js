'use strict';
/*
 * card.js - iteriodev-turnview: the turn card (icon + distance, 360x150) and the notices (640x120) as RGBA for
 * cluster-render image layers (straight alpha), drawn with the renderer kit's canvas (kit/: pure JS, the HMI's BMW
 * fonts), so any text the navigation sends draws.
 *   card(icon, text, opts) -> { w, h, rgba }   opts.exit: a roundabout's exit number; opts.dim: recalculating
 *   notice('none' | 'busy' | 'nocam' | 'nofront') -> { w, h, rgba }
 */
const { Canvas } = require('./kit/canvas');

const CARD = { w: 360, h: 150 }, NOTICE = { w: 640, h: 120 };
const WHITE = [255, 255, 255, 255], DIMTXT = [139, 144, 153, 255], ICON_BOX = { x: 24, y: 27, s: 96 };
const ICONS = ['straight', 'slight-left', 'slight-right', 'left', 'right', 'hard-left', 'hard-right', 'uturn-left', 'uturn-right',
    'roundabout-left', 'roundabout-right', 'destination', 'tunnel'];
const TURN = { straight: 0, slight: 30, '': 90, hard: 135 };
const NOTICES = {
    none: ['Turn View · no route', 'Start a route in Navigation, CarPlay or Android Auto'],
    busy: ['Camera busy', 'A parking view has the cameras'],
    nocam: ['No camera', 'The camera did not answer'],
    nofront: ['No front camera', 'Turn View needs the car\'s front camera'],
};

/* an arrow head at (x, y) pointing along unit (dx, dy) */
function head(cv, x, y, dx, dy, size, c) {
    const nx = -dy, ny = dx;
    cv.convex([[x + dx * size * 0.9, y + dy * size * 0.9], [x + nx * size * 0.75, y + ny * size * 0.75], [x - nx * size * 0.75, y - ny * size * 0.75]], c);
}

/* icon name -> drawn into the box (bx, by) of size s (96 px design units scaled by k = s / 96) */
function drawIcon(cv, name, bx, by, s, c, exit) {
    const k = s / 96, P = (x, y) => [bx + x * k, by + y * k], W = 13 * k;
    const m = /^(slight|hard|uturn|roundabout)?-?(left|right)?$/.exec(name === 'straight' ? '' : name);
    if (name === 'destination') {
        cv.line(...P(34, 90), ...P(34, 12), 8 * k, c);
        cv.convex([P(36, 12), P(80, 26), P(36, 42)], c);
        return true;
    }
    if (name === 'tunnel') {
        cv.arc(...P(48, 62), 30 * k, 42 * k, -90, 90, c);
        cv.line(...P(12, 62), ...P(12, 92), 12 * k, c);
        cv.line(...P(84, 62), ...P(84, 92), 12 * k, c);
        return true;
    }
    if (!m) return false;
    const kind = m[1] || '', sd = m[2] === 'left' ? -1 : 1;
    if (kind === 'uturn') {                           // up, over the top, back down on the turn's side
        const x0 = 48 - sd * 16, x1 = 48 + sd * 16;
        cv.line(...P(x0, 92), ...P(x0, 40), W, c);
        cv.arc(...P(48, 40), 16 * k - W / 2, 16 * k + W / 2, -90, 90, c);
        cv.line(...P(x1, 40), ...P(x1, 58), W, c);
        head(cv, ...P(x1, 60), 0, 1, 20 * k, c);
        return true;
    }
    if (kind === 'roundabout') {                      // the ring, the way in from below, the exit on the driving side
        cv.arc(...P(48, 44), 18 * k, 28 * k, 0, 360, c);
        cv.line(...P(48, 92), ...P(48, 72), W, c);
        const ex = 48 + sd * 23 * 0.7071, ey = 44 - 23 * 0.7071;
        cv.line(...P(ex, ey), ...P(ex + sd * 14, ey - 14), W, c);
        head(cv, ...P(ex + sd * 16, ey - 16), sd * 0.7071, -0.7071, 18 * k, c);
        if (exit) cv.text(String(exit), ...P(48, 56), 32 * k, c, { font: 'bold', align: 'center' });
        return true;
    }
    if (!(kind in TURN)) return false;
    const a = (m[2] ? TURN[kind] : 0) * Math.PI / 180, dx = sd * Math.sin(a), dy = -Math.cos(a);
    const len = 22, jx = 48, jy = kind === 'hard' ? 36 : a ? 54 : 50, ex = jx + dx * len, ey = jy + dy * len;
    cv.line(...P(48, 88), ...P(jx, jy), W, c);
    cv.line(...P(jx, jy), ...P(ex, ey), W, c);
    head(cv, ...P(ex + dx * 2, ey + dy * 2), dx, dy, 22 * k, c);
    return true;
}

function rgbaOf(cv) { return Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length); }

function card(icon, text, opts) {
    const o = opts || {}, cv = new Canvas(CARD.w, CARD.h).clear();
    cv.roundRect(0, 0, CARD.w, CARD.h, 16, [0, 0, 0, 184]);
    cv.strokeRoundRect(1, 1, CARD.w - 2, CARD.h - 2, 15, 2, [34, 39, 47, 255]);
    const c = o.dim ? DIMTXT : WHITE;
    drawIcon(cv, icon, ICON_BOX.x, ICON_BOX.y, ICON_BOX.s, c, o.exit);
    const t = String(text || ''), max = CARD.w - 140 - 20;
    let size = 72;
    while (size > 36 && cv.textWidth(t, size, { font: 'num' }) > max) size -= 4;
    cv.text(t, 140, 75 + size * 0.36, size, c, { font: 'num' });
    return { w: CARD.w, h: CARD.h, rgba: rgbaOf(cv) };
}

function notice(which) {
    const n = NOTICES[which] || NOTICES.none, cv = new Canvas(NOTICE.w, NOTICE.h).clear();
    cv.text(n[0], NOTICE.w / 2, 58, 44, WHITE, { font: 'bold', align: 'center' });
    cv.text(n[1], NOTICE.w / 2, 98, 26, DIMTXT, { font: 'label', align: 'center' });
    return { w: NOTICE.w, h: NOTICE.h, rgba: rgbaOf(cv) };
}

module.exports = { card, notice, drawIcon, ICONS, CARD, NOTICE, ICON_BOX, NOTICES };
