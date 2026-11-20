'use strict';
/*
 * nv.js - iteriodev-turnview 0.10.0 (user 2026-11-20): Night Vision from the head unit's own analog video chip, the
 * picture BMW's Night Vision screen shows. mgu-nvcap (apps/nvcap, a child from the tool's start) takes the chip before
 * BMW's screen ever asks for it and holds it from then on - BMW's Night Vision screen stays black (the user's choice;
 * no crash, car-tested on a G12) - and reads it only while asked (`on` / `off` on its stdin), writing the picture to
 * the file camcluster --nv takes it from. Its lines: "nv holding | streaming | nosignal | busy | none".
 *   const nv = createNv({ log, child, backoff, now, bin, file, data });
 *   nv.start(); nv.stream(on); nv.state(); nv.on('change', (state) => ...); nv.stop()
 *   state: starting | holding | streaming | nosignal | busy (someone else has the chip: BMW's screen came first) |
 *          none (no Night Vision chip in this head unit: not started again) | missing (no binary) | restarting |
 *          disabled (crashed twice)
 * A native child's core dump restarts the head unit: a mgu-nvcap killed by a crash signal twice in a row is not
 * started again (data/nv-crashed counts them; a run of CLEAN_MS clears it), so a crash can never loop the head unit.
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const CLEAN_MS = 10 * 60 * 1000, MAX_CRASHES = 2, LINE_MAX = 4096;
const CRASH = /SIG(SEGV|ABRT|BUS|ILL|FPE|SYS|TRAP)/;

function createNv(o) {
    const ev = new EventEmitter(), log = o.log, file = path.join(o.data, 'nv-crashed');
    const st = { startedAt: 0, delay: 0 };
    let c = null, out = '', state = 'starting', want = false, stopped = false, cleanTimer = null;
    const crashes = () => { try { return parseInt(fs.readFileSync(file, 'utf8'), 10) || 0; } catch (e) { return 0; } };
    function set(s) {
        if (s === state) return;
        state = s;
        log(`night vision: ${s}`);
        ev.emit('change', s);
    }
    function start() {
        if (stopped || c) return;
        if (!fs.existsSync(o.bin)) { set('missing'); return; }
        if (crashes() >= MAX_CRASHES) { log(`night vision: mgu-nvcap crashed ${crashes()} times: not started (${file})`); set('disabled'); return; }
        st.startedAt = o.now();
        const p = o.child(o.bin, ['--control', 'stdin', '--out', o.file], log, (why) => {
            if (c === p) { c = null; out = ''; }
            clearTimeout(cleanTimer);
            log(`mgu-nvcap ended (${why})`);
            if (/^exit 3\b/.test(why)) { set('none'); return; }       // no chip: nothing to come back for
            if (CRASH.test(why)) { try { fs.writeFileSync(file, `${crashes() + 1}\n`); } catch (e) { log(`night vision: ${e.message}`); } }
            if (stopped) return;
            set('restarting');
            setTimeout(start, o.backoff(st, o.now()));
        });
        if (!p) return;
        c = p;
        p.stdout.on('data', (d) => {
            out += d;
            if (out.length > LINE_MAX && out.indexOf('\n') < 0) out = '';
            for (let n; (n = out.indexOf('\n')) >= 0; out = out.slice(n + 1)) {
                const m = /^nv (holding|streaming|nosignal|busy|none)$/.exec(out.slice(0, n).replace(/\r$/, ''));
                if (m) set(m[1]);
            }
        });
        if (want) p.stdin.write('on\n');
        cleanTimer = setTimeout(() => { try { fs.unlinkSync(file); } catch (e) { /* none */ } }, CLEAN_MS);
    }
    ev.start = start;
    ev.state = () => state;
    ev.stream = (on) => {
        if (on === want) return;
        want = on;
        log(`night vision stream ${on ? 'on' : 'off'}`);
        if (c) c.stdin.write(on ? 'on\n' : 'off\n');
    };
    ev.stop = () => { stopped = true; clearTimeout(cleanTimer); if (c) { try { c.stdin.end(); } catch (e) { /* gone */ } } };
    return ev;
}

module.exports = { createNv, CLEAN_MS, MAX_CRASHES };
