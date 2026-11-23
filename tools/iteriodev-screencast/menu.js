'use strict';
// iteriodev-screencast-menu: the viewer's MENU button, as root = the controller's MENU key, the HMI's Home screen.
// The screen share runs as os_7011 (the grabber's user) and the car's vsomeip policy gives that user nothing, while
// uid 0 may call any service (etc/vsomeip/0_0: deny {}). So this does the one call for it: each connection to its
// socket = one press = a requestGraphicalContext by hmictl (the Overlays / Comfort binary), the way Overlays' strip
// opens BMW screens; the answer goes back as one "ok" / "error ..." line.
// iDrive 8 (Hmi8): HMIControl2 0xB0A5 requestGraphicalContext(Home 20000 4). The HMI's own request path, no faked key:
// Hmi8 brings Home to the front, and full-screen CarPlay (an Hmi8 activity, ST_CarPlay) goes to the background, which
// stops the projection and asks the phone for the native screen (Hmi8: CCarPlayActivity onBackground "CarPlay UI
// projection stop", CCarPlayService "Requesting native screen").
// iDrive 7 (1.0.12; /usr/bin/HmiMain3D there, MGU_ID7_2311): no HMIControl2. HMIControl 0xB039 v2 instance 1 (HMI_CID)
// requestGraphicalContext (method 5): RequestInitiator u8 + GraphicalContext {focusIndex u32, listIndex i32,
// visibleContext u32} -> ErrorCode u8. 20000 = ST_Start_Main_Menu (HmiMain3D's use-case table pairs that name with
// 20000), what the MENU key opens: CHmiHomeApplication::processHardKey(key 1) -> IHmiStateManager::userRequestState(
// 20000, 0); the stub's requestGraphicalContext -> CHmiStateManager::setGraphicalContext -> the same userRequestState.
// The stub takes initiators 1..7 (TESTING 8 -> 9 UNSUPPORTED_PARAMETER): HMI_HU 3; it answers 0 OK or 7 NOT_POSSIBLE.
// Full-screen CarPlay: leaving its state stops CHmiCarPlayActivity, whose onStop asks the phone for the native screen
// while projected (CHmiCarPlayService::requestNativeMode, as the MENU key's own projected path) - not car-tested.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const env = (n, d) => process.env[n] || d;
const SOCK = env('SCREENCAST_MENU_SOCK', '/run/iteriodev-screencast-menu/menu.sock');
const HMICTL = env('SCREENCAST_HMICTL', path.join(__dirname, 'hmictl'));
const ID7 = fs.existsSync(env('SCREENCAST_HMI7', '/usr/bin/HmiMain3D'));   // iDrive 7's HMI binary (iDrive 8: Hmi8)
// iDrive 8: StateID AppletID of Home (Overlays' "Home": the VM, and the car's own HMIContext2 answer "ok 20000 4 ...")
const HOME = env('SCREENCAST_MENU', '20000 4').split(' ');
// iDrive 7: initiator 03, focusIndex 0 (no focus change), listIndex -1, visibleContext = the state
const u32 = (n) => (n >>> 0).toString(16).padStart(8, '0');
const ARGS = ID7 ? ['call', '0xb039', '1', '5', '2', `03${u32(0)}${u32(-1)}${u32(+env('SCREENCAST_MENU7', '20000'))}`]
    : ['open'].concat(HOME);
const USER = 'os_7011';   // the screen share's user (its unit): the only one that may connect
const log = (m) => console.error(`[screencast-menu] ${m}`);

// iDrive 7: hmictl call says "ok EE" (the reply payload): ErrorCode 0 OK, 3 NO_CHANGE (there already) are fine
const answer = (a) => {
    const m = ID7 && /^ok(?: ([0-9a-f]*))?$/.exec(a);
    if (!m) return a;
    const code = parseInt((m[1] || '').slice(0, 2), 16);
    return code === 0 || code === 3 ? 'ok' : `error code ${isNaN(code) ? 'none' : code}`;
};

let busy = false;
const server = net.createServer((c) => {
    c.on('error', () => {});
    if (busy) return c.end('error busy\n');          // one press at a time
    busy = true;
    execFile(HMICTL, ARGS, { timeout: 12000 }, (e, out) => {
        busy = false;
        // vsomeip may log into hmictl's stdout: only its answer line counts
        const a = answer(String(out).split('\n').filter((l) => /^(ok|error)\b/.test(l)).pop() ||
            `error ${e ? (e.killed ? 'timeout' : e.message) : 'no answer'}`);
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
    log(`${SOCK}: a connection = MENU (${ID7 ? 'iDrive 7: ' : ''}hmictl ${ARGS.join(' ')})`);
});
listen();
