'use strict';
// iteriodev-screencast: the centre display in a browser over the tailnet, the mouse taps it.
//   GET  /        the viewer (index.html + mux.js: H.264 -> fragmented MP4 -> Media Source Extensions)
//   GET  /info    {width, height, fps} of the stream
//   GET  /video   the live stream, per access unit: u32 length, then its NAL units each u32 length-prefixed
//                 (AVCC). A viewer starts at a keyframe, which always carries SPS + PPS.
//                 Header X-Screencast-Viewer: this viewer's id, for /ack.
//   POST /ack     "<viewer> <frames>": the frames it has received so far -> the delay in ms. Tailscale (userspace
//                 networking) and the kernel buffer seconds of video the uplink hasn't sent yet, out of the server's
//                 sight: the viewer's count says how much is still on the way.
//   POST /touch   "<event> <x> <y>": 1 down, 2 move, 3 up; x, y 0..1 of the picture -> one touch PDU
// The stock winston-grabber grabs and encodes (Intel Media SDK), only while someone watches. Listens on
// 127.0.0.1: tailscaled forwards tailnet connections there, nothing else reaches it.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const { spawn, spawnSync } = require('child_process');

const env = (n, d) => process.env[n] || d;
const size = (s) => { const m = /^(\d+)x(\d+)$/.exec(s); if (!m) throw new Error(`bad size ${s}`); return [+m[1], +m[2]]; };
const PORT = +env('SCREENCAST_PORT', 5880);
const HOST = env('SCREENCAST_HOST', '127.0.0.1');
const GRABBER = env('SCREENCAST_GRABBER', '/usr/bin/winston-grabber');
const [W, H] = size(env('SCREENCAST_SIZE', '1440x480'));
const [SW, SH] = size(env('SCREENCAST_SCREEN', '2880x960'));   // touch coordinates are screen pixels
const FPS = +env('SCREENCAST_FPS', 10);
// gop_ref_dist=1: no B-frames (the viewer's MP4 has no composition offsets, and they'd add delay)
const PIPELINE = env('SCREENCAST_PIPELINE', 'h264_msdk(gop=10,gop_ref_dist=1,cbr=1M)');
// the file plugin open()s its path: a FIFO, not /dev/stdout (node's stdout pipe is a socket: open() -> ENXIO)
const ARGS = ['--screen=center', `--geometry=${W}x${H}`, `--fps=${FPS}`, '--num-frames=0',
    `--pipeline=${PIPELINE},file`];
const LAG = 256 << 10;   // a viewer this far behind (socket buffer) skips to the next keyframe
// ... or with a frame sent this long ago (ms) not yet received: the uplink can't carry the stream
const MAXLAG = +env('SCREENCAST_MAXLAG', 800);
const log = (m) => console.error(`[screencast] ${m}`);
const page = { '/': ['index.html', 'text/html'], '/mux.js': ['mux.js', 'application/javascript'] };
for (const k in page) page[k][0] = fs.readFileSync(path.join(__dirname, page[k][0]));

// ---- grabber Annex B -> access units ----------------------------------------------------------------------
// A NAL ends at the next start code, or when the grabber goes quiet: it writes a frame in one go, so 30 ms of
// silence = the frame is complete (no frame of delay waiting for the next one).
const SC = Buffer.from([0, 0, 1]);
let pend = Buffer.alloc(0), au = [], auVcl = false, quiet = null, sps = null, pps = null;
const type = (n) => n[0] & 0x1f;

function feed(chunk) {
    pend = pend.length ? Buffer.concat([pend, chunk]) : chunk;
    clearTimeout(quiet);
    take(false);
    quiet = setTimeout(take, 30, true);
}

function take(flush) {
    let a = pend.indexOf(SC);
    if (a < 0) return;
    for (let b; (b = pend.indexOf(SC, a + 3)) >= 0; a = b) nal(pend.slice(a + 3, b));
    if (!flush) { pend = pend.slice(a); return; }
    nal(pend.slice(a + 3));
    pend = Buffer.alloc(0);
    endAU();
}

function nal(n) {
    let e = n.length;
    while (e && !n[e - 1]) e--;            // the next 4-byte start code's zero / trailing_zero_8bits
    if (!e) return;
    n = n.slice(0, e);
    const t = type(n), vcl = t === 1 || t === 5;
    if (auVcl && (vcl ? n[1] & 0x80 : t >= 6 && t <= 9)) endAU();   // first_mb_in_slice 0 / SEI, SPS, PPS, AUD
    if (t === 7) sps = n;
    if (t === 8) pps = n;
    au.push(n);
    auVcl = auVcl || vcl;
}

function endAU() {
    if (!auVcl) return;                    // parameter sets wait for their picture
    const has = (t) => au.some((n) => type(n) === t), key = has(5);
    const nals = (key && !has(7) && sps ? [sps] : []).concat(key && !has(8) && pps ? [pps] : [], au);
    au = [];
    auVcl = false;
    const parts = [Buffer.alloc(4)];
    for (const n of nals) { const h = Buffer.alloc(4); h.writeUInt32BE(n.length, 0); parts.push(h, n); }
    const frame = Buffer.concat(parts);
    frame.writeUInt32BE(frame.length - 4, 0);
    stat.in++; stat.keys += key; stat.bytes += frame.length;
    const now = Date.now();
    for (const v of viewers) {
        if (!v.live && !key) { stat.skip++; continue; }
        // in flight: the oldest frame not received yet (once the viewer acks at all: an old page doesn't)
        const late = v.acks && v.sent.length && now - v.sent[0] > MAXLAG;
        if (late || (v.res.socket && v.res.socket.bufferSize > LAG)) {
            if (v.live) stat.behind++;
            v.live = false; stat.skip++; continue;
        }
        v.live = true;
        v.res.write(frame);
        v.sent.push(now);
        stat.out++;
    }
}

function ack(v, n) {
    const k = Math.min(n - v.acked, v.sent.length);
    if (k <= 0) return v.delay;
    v.delay = Date.now() - v.sent[k - 1];   // the newest frame it has: sent this long ago
    v.sent.splice(0, k);
    v.acked += k;
    v.acks++;
    stat.delay = Math.max(stat.delay, v.delay);
    return v.delay;
}

// every 10 s while it runs: what the grabber delivers and what reaches the viewers (frames skipped = a viewer
// too far behind, waiting for the next keyframe)
const fresh = () => ({ in: 0, keys: 0, bytes: 0, out: 0, skip: 0, behind: 0, delay: 0 });
let stat = fresh(), statAt = Date.now();
setInterval(() => {
    const s = (Date.now() - statAt) / 1000;
    if (grab || stat.in) log(`${(stat.in / s).toFixed(1)} fps from the grabber (${stat.keys} keyframes, ` +
        `${Math.round(stat.bytes * 8 / s / 1000)} kbit/s), ${viewers.size} viewer(s): ${stat.out} frames sent, ` +
        `${stat.skip} skipped (${stat.behind} times too far behind), delay up to ${(stat.delay / 1000).toFixed(1)} s`);
    stat = fresh();
    statAt = Date.now();
}, 10000);

// ---- the grabber runs while someone watches ---------------------------------------------------------------
const viewers = new Set(), byId = new Map();
let lastId = 0;
let grab = null, idle = null, backoff = null;

function grabber() {
    clearTimeout(idle);
    if (!viewers.size) { if (grab) idle = setTimeout(stopGrab, 5000); return; }   // a reload is back within 5 s
    if (grab || backoff) return;
    // a FIFO in a fresh private dir; held open read-write, so neither side's open() blocks
    let dir, fifo, src;
    try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iteriodev-screencast-'));
        fifo = path.join(dir, 'video.h264');
        const mk = spawnSync('mkfifo', ['-m', '0600', fifo], { stdio: ['ignore', 'ignore', 'pipe'] });
        if (mk.status !== 0) throw new Error(`mkfifo: ${mk.error ? mk.error.message : String(mk.stderr).trim()}`);
        src = new net.Socket({ fd: fs.openSync(fifo, fs.constants.O_RDWR), readable: true, writable: false });
    } catch (e) {
        if (dir) { try { if (fifo) fs.unlinkSync(fifo); } catch (_) {} try { fs.rmdirSync(dir); } catch (_) {} }
        log(`grabber: ${e.message}, again in 3 s`);
        backoff = setTimeout(() => { backoff = null; grabber(); }, 3000);
        return;
    }
    src.on('data', feed);
    src.on('error', (e) => log(`grabber output: ${e.message}`));
    const g = grab = spawn(GRABBER, ARGS.concat(fifo), { stdio: ['ignore', 'ignore', 'pipe'] });
    log(`grabber started: ${ARGS.concat(fifo).join(' ')}`);
    // its messages, minus libdrm's debug lines (several per buffer it frees)
    require('readline').createInterface({ input: g.stderr }).on('line', (l) => {
        if (!/intel_bufmgr_gem\.c:|^\s*$/.test(l)) console.error(`[grabber] ${l}`);
    });
    const done = (why) => {
        if (g.gone) return;
        g.gone = true;
        grab = null;
        src.destroy();
        try { fs.unlinkSync(fifo); fs.rmdirSync(dir); } catch (e) {}
        clearTimeout(quiet);
        pend = Buffer.alloc(0); au = []; auVcl = false;
        for (const v of viewers) v.live = false;      // the next stream starts at its own keyframe
        log(`grabber ${why}`);
        backoff = setTimeout(() => { backoff = null; grabber(); }, 3000);
    };
    g.on('error', (e) => done(`failed: ${e.message}`));
    g.on('exit', (code, sig) => done(`exited (${sig || code})`));
}

function stopGrab() {
    const g = grab;
    if (!g) return;
    g.kill('SIGTERM');
    setTimeout(() => { if (!g.gone) g.kill('SIGKILL'); }, 5000).unref();
}

// ---- touch: Hmi8's DET PDU (scripts/qemu/guest-src/vminput.c), to the renderer while it routes touch ------
const udp = dgram.createSocket('udp4');
udp.on('error', (e) => log(`touch: ${e.message}`));
const DOWN = 1, UP = 3;
let finger = null;

function pdu(ev, x, y) {
    const b = Buffer.alloc(16 + 96), p = 16;
    b.writeUInt32BE(0xB0048002, 0);
    b.writeUInt32BE(96, 4);
    b[p + 12] = 0x80;                      // word type 8: finger data
    b[p + 37] = 1;                         // finger count
    b.writeUInt16BE(x, p + 38);
    b.writeUInt16BE(y, p + 44);
    b[p + 46] = 50;
    b[p + 47] = ev << 4;
    return b;
}

// a renderer binds its touch port while it runs and hands its apps' taps to them, the rest on to Hmi8's 30567:
// robertnisipeanu's mgu-render 30570, IterioDev's old mgu-renderd 30568. The display's own touches reach it
// through an nft divert that matches only the display's packets (vlan73), so ours must be sent to it directly.
function touchPort() {
    let udp4 = '';
    try { udp4 = fs.readFileSync('/proc/net/udp', 'utf8'); } catch (e) { /* none: Hmi8 */ }
    const bound = (port) => new RegExp(`^\\s*\\d+: [0-9A-F]{8}:${port.toString(16).toUpperCase()} `, 'm').test(udp4);
    return [30570, 30568].find(bound) || 30567;
}

function touch(ev, x, y) {
    if (ev === DOWN) { if (finger) touch(UP, finger.x, finger.y); finger = { port: touchPort() }; }
    else if (!finger) return;
    clearTimeout(finger.guard);
    finger.x = x;
    finger.y = y;
    udp.send(pdu(ev, x, y), finger.port, '127.0.0.1');
    if (ev === UP) finger = null;
    // the viewer repeats the position every 0.5 s while the button is down: silence = it is gone, lift the finger
    else finger.guard = setTimeout(() => touch(UP, finger.x, finger.y), 2000);
}

// ---- http -------------------------------------------------------------------------------------------------
// Host: an address, a bare name or *.ts.net - a page elsewhere can't rebind its own name to this server
const hostOk = (h) => /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\]|[a-z0-9-]+|[a-z0-9.-]+\.ts\.net)(:\d+)?$/i.test(h || '');
const NUM = '(0(?:\\.\\d+)?|1(?:\\.0+)?)';
const TOUCH = new RegExp(`^([123]) ${NUM} ${NUM}$`);

function end(res, code, body, ctype) {
    res.writeHead(code, { 'Content-Type': ctype || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(body);
}

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (!hostOk(req.headers.host)) return end(res, 403, 'host\n');
    if (req.method === 'GET' && page[url]) return end(res, 200, page[url][0], page[url][1]);
    if (req.method === 'GET' && url === '/info') return end(res, 200, JSON.stringify({ width: W, height: H, fps: FPS }), 'application/json');
    if (req.method === 'GET' && url === '/video') {
        const v = { id: String(++lastId), res, live: false, sent: [], acked: 0, acks: 0, delay: 0 };
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
            'X-Screencast-Viewer': v.id });
        res.socket.setNoDelay(true);
        viewers.add(v);
        byId.set(v.id, v);
        res.on('close', () => { viewers.delete(v); byId.delete(v.id); grabber(); });
        return grabber();
    }
    if (req.method === 'POST' && (url === '/touch' || url === '/ack')) {
        // a custom header: a cross-site form/fetch can't send it without a preflight, which this server refuses
        if (req.headers['x-screencast'] !== '1') return end(res, 403, 'header\n');
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => { body += d; if (body.length > 64) req.destroy(); });
        return req.on('end', () => {
            if (url === '/ack') {
                const a = /^(\d+) (\d+)$/.exec(body), v = a && byId.get(a[1]);
                if (!v) return end(res, a ? 404 : 400, 'bad ack\n');
                return end(res, 200, String(ack(v, +a[2])));
            }
            const m = TOUCH.exec(body);
            if (!m) return end(res, 400, 'bad touch\n');
            touch(+m[1], Math.round(m[2] * (SW - 1)), Math.round(m[3] * (SH - 1)));
            end(res, 204);
        });
    }
    end(res, 404, 'not found\n');
});

// a stopped service restarts the head unit: log a bug and keep serving; the port taken: try again
process.on('uncaughtException', (e) => log(`bug: ${e.stack}`));
server.on('error', (e) => { log(`listen: ${e.message}, again in 10 s`); setTimeout(listen, 10000); });
const listen = () => server.listen(PORT, HOST);
server.on('listening', () => log(`http://${HOST}:${PORT}/ (stream ${W}x${H} @ ${FPS} fps, screen ${SW}x${SH})`));
listen();
