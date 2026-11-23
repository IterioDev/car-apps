'use strict';
// iteriodev-screencast-menu: the viewer's MENU button, as root = the controller's MENU key, the HMI's Home screen.
// The screen share runs as os_7011 (the grabber's user) and the car's vsomeip policy gives that user nothing, while
// uid 0 may call any service (etc/vsomeip/0_0: deny {}). So this does the one call for it: each connection to its
// socket = one press = HMIControl2 0xB0A5 requestGraphicalContext(Home) by hmictl (the Overlays / Comfort binary), the
// way Overlays' strip opens BMW screens; hmictl's "ok" / "error ..." line is the answer.
// The HMI's own request path, no faked key: Hmi8 brings Home to the front, and full-screen CarPlay (an Hmi8 activity,
// ST_CarPlay) goes to the background, which stops the projection and asks the phone for the native screen (Hmi8:
// CCarPlayActivity onBackground "CarPlay UI projection stop", CCarPlayService "Requesting native screen").
// iDrive 8 only: iDrive 7's HMI has the older HMIControl 0xB039 (another context type), there hmictl says error.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const env = (n, d) => process.env[n] || d;
const SOCK = env('SCREENCAST_MENU_SOCK', '/run/iteriodev-screencast-menu/menu.sock');
const HMICTL = env('SCREENCAST_HMICTL', path.join(__dirname, 'hmictl'));
// StateID AppletID of Home (Overlays' "Home": the VM, and the car's own HMIContext2 answer "ok 20000 4 ...")
const HOME = env('SCREENCAST_MENU', '20000 4').split(' ');
const USER = 'os_7011';   // the screen share's user (its unit): the only one that may connect
const log = (m) => console.error(`[screencast-menu] ${m}`);

let busy = false;
const server = net.createServer((c) => {
    c.on('error', () => {});
    if (busy) return c.end('error busy\n');          // one press at a time
    busy = true;
    execFile(HMICTL, ['open'].concat(HOME), { timeout: 12000 }, (e, out) => {
        busy = false;
        // vsomeip may log into hmictl's stdout: only its answer line counts
        const a = String(out).split('\n').filter((l) => /^(ok|error)\b/.test(l)).pop() ||
            `error ${e ? (e.killed ? 'timeout' : e.message) : 'no answer'}`;
        log(`MENU: ${a}`);
        c.end(`${a}\n`);
    });
});

// a stopped service restarts the head unit: log a bug and keep serving; listen failed: try again
process.on('uncaughtException', (e) => log(`bug: ${e.stack}`));
server.on('error', (e) => { log(`listen: ${e.message}, again in 10 s`); setTimeout(listen, 10000); });
const listen = () => { try { fs.unlinkSync(SOCK); } catch (e) {} server.listen(SOCK); };   // the last run's socket
server.on('listening', () => {
    // 0600 first: if the owner can't be set, it stays root's only
    try {
        fs.chmodSync(SOCK, 0o600);
        const pw = new RegExp(`^${USER}:[^:]*:(\\d+):(\\d+):`, 'm').exec(fs.readFileSync('/etc/passwd', 'utf8'));
        if (!pw) throw new Error(`no user ${USER}`);
        fs.chownSync(SOCK, +pw[1], +pw[2]);
    } catch (e) { log(`socket owner: ${e.message} (root only)`); }
    log(`${SOCK}: a connection = MENU (hmictl open ${HOME.join(' ')})`);
});
listen();
