# car-apps

> [!WARNING]
> **Not tested on iDrive 7.** These apps and tools have been tested only on iDrive 8, in the emulator and on a real
> car. Drive Recorder (from 2.3.0, with its player) installs on iDrive 7 too; from 2.3.12
> with the player 1.1.4 it records, saves and copies clips there, tested on one G20 (see its section). Ambient Light
> and Seats (with the Comfort tool) install on iDrive 7 too, not run on an iDrive 7 car yet. Every other app is iDrive 8 only; iDrive 7 cars keep the versions they have: Car Data
> 1.1.10, Drag Timer 1.1.8, Fault Codes 1.1.4, Live Adjustments 1.0.7 and Tailscale 1.0.4 (checked there only as far
> as building against iDrive 7's app SDK).

Apps and tools by IterioDev for BMW head units with iDrive 7 and iDrive 8 (MGU). The apps run in the head unit's own
app platform and show up in *All apps* like BMW's apps.

## The apps

| App | Package id | What it does |
|---|---|---|
| Ambient Light | `iteriodev_ambient` | **iDrive 7 and iDrive 8.** Any colour on the interior ambient light (a colour bar, brightness, the car's colours), per zone from a list of the car's zones, presets that keep every zone's colour, and a colour per drive mode that the light switches to with the mode. Needs the Comfort tool below (the Store installs it with the app). |
| Car Data | `iteriodev_cardash` | **iDrive 8 only** (from 1.2.0; iDrive 7 cars keep 1.1.10). Live engine data: engine speed, boost, power and torque with their peaks, oil, coolant and intake temperatures, battery voltage; fuel and air values with their last 5 minutes; a trip computer (distance, fuel, cost); gearbox data (ZF 8HP, read-only); the engine unit's values in groups; on diesel cars the particulate filter (DPF). See below. |
| Drag Timer | `iteriodev_draggy` | **iDrive 8 only** from 1.2.0 (iDrive 7 cars that have 1.1.8 keep it). Acceleration timer: stand still, launch, and it times the run with splits and a speed-over-time chart. Power run: floor it in one gear for power and torque over rpm, with a baseline to compare (from cauliflowermossgrape's idrive7-apps). Keeps your best times; km/h or mph. |
| Drive Recorder | `oap-driverecorder-next` | **iDrive 7 and iDrive 8** (from 2.3.0; on iDrive 7 tested on one car, see below). Keeps the car's cameras recording and saves a clip when you tap *Save clip* (by default the 20 s before and the 10 s after); watch, lock, delete and copy clips to a USB stick while the car stands still. Over 4 GB the oldest unlocked clips are replaced. The car must be coded for the Drive Recorder. Needs the Drive Recorder player below (the Store installs it with the app). |
| eDrive | `iteriodev_edrive` | **iDrive 8 only.** For plug-in hybrids: the real electric range, learned from how the car is driven, the charge level and battery health, live power and cell voltages, and a log of the charges with their cost. Read-only. On a car without a high-voltage battery it says so and shows the 12 V battery; on a 48 V mild hybrid (from 1.1.0) also its 48 V battery (charge, health, power) and DC/DC converter, from jezikk82's patch to cauliflowermossgrape's idrive7-apps. Not tested on a car yet. |
| Fault Codes | `iteriodev_dtcscan` | **iDrive 8 only** (from 1.2.0; iDrive 7 cars keep 1.1.4). Reads the fault memory of every control unit in the car, shows each fault with its text and clears it when you ask. Also lists the car's Check Control messages. |
| Live Adjustments | `iteriodev_liveadjust` | **iDrive 8 only** (from 1.1.0; iDrive 7 cars keep 1.0.7). For an MHD-tuned DME: engine map 1-4 and MHD Max Cooling, plus the exhaust flap (open, close, back to the DME). See below. |
| Overlays | `iteriodev_overlays` | **iDrive 8 only.** Sets up the Overlays strip in the climate bar: four shortcuts to BMW screens or apps, seat heating / ventilation and steering wheel heating buttons, shift lights on the cluster (cars without their own), and on M cars the M Mode that M1 / M2 switch to. Needs the Overlays tool below (the Store installs it with the app). |
| Seats | `iteriodev_seats` | **iDrive 7 and iDrive 8.** Move the front seats from the screen, also while driving, both on one page (hold the controls round each seat), three memories per seat, the Make room button (parked only) for the passenger seat, Easy exit for both front seats (the seat, and on the driver's side an electric steering column, out of the way when its door opens, back once the door is shut: the driver's with the car on, the passenger's with someone seated); a right-hand drive setting. Needs the Comfort tool below (the Store installs it with the app). |
| Service | `iteriodev_service` | **iDrive 8 only.** The car's service requirements as the instrument cluster has them: engine oil, brakes, brake fluid, vehicle check, inspections, each with the distance and date left and whether it is due, and what it is when you tap it. Read-only: a service is reset in the cluster's own menu or at a workshop. Not car-tested yet. |
| Tailscale | `iteriodev_tailscale` | **iDrive 8 only** (iDrive 7 cars keep 1.0.4). The head unit's Tailscale state and login: the login link as a QR code to scan with your phone, then the head unit's tailnet name, address and account, Rename (default `mgu`) and Log out. Needs the Tailscale tool below (the Store installs it with the app). |

All of them draw their screens through the GPU renderer `mgu-render`.

**Car Data** (seven pages; DPF is left out on petrol cars). Fuel & air, Trips, Transmission and the grouped Details come
from cauliflowermossgrape's idrive7-apps (MIT; the package's `renderer/kit/NOTICE`); the DPF page's idea and values from
2bhacker9's DPF Monitor (idrive7-apps issue #88). Not car-tested yet: Trips' fuel figure (the car's fuel signal
is scaled against the engine unit's own figure, learned per car while Car Data is open) and whether trips are counted
while the app's screen is closed; Transmission (marked Experimental, read-only: the ZF 8HP variants 0F25D0 and 0F21E0
only, any other shows "not supported yet"); DPF (marked Experimental, read-only, never run on a diesel).

**Live Adjustments** (one screen, sends a command only when you tap a choice). Car-tested: the engine map switch
works (1.0.1, MHD). BMW's regulated flap job opens and closes the flap on a G80 S58 MHD, but the DME drops it once
the car moves (issue #3). Max Cooling and MHD's own flap control (1.0.7) are not car-tested yet.

- **Engine map 1-4** (MHD): at any time, also while driving (from 1.1.1), as MHD itself switches maps on the fly from
  the cruise control buttons. The DME has to echo the request back, or the screen
  says why it wasn't switched. MHD reports no active map, so the screen shows the map the DME accepted, not one it
  read back. The engine light may flash while the map changes; MHD does that.
- **Max Cooling** (MHD): at any speed, accepted the same way. *On* only with the engine running (over 500 rpm);
  *Off* any time, and shown until you switch it on.
- **Exhaust flap**, at any speed. On an MHD DME through MHD's own flap control: *Open* / *Close* hold while you
  drive, until you tap another button (*OEM* hands it back to the tune). Without MHD, BMW's own DME job: the regulated
  flap (DID 611E, e.g. S58) or the plain one (DID 60FD), picked per car; *Open* / *Close* then hold for about 20 s or
  until the car moves, and the DME controls the flap again. The flap position is read from the DME every 2 s while the
  screen shows. A DME without an electric flap shows *NONE*.
- A DME without MHD refuses map and cooling: after the first refusal the screen shows *MHD not found* and greys both out (the flap still works through BMW's job).

## Installing

1. Install the Store from [robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) first,
   following its README: its updater, deploy tool, GPU renderer (`mgu-render`) and internet uplink (`mgu-uplink`)
   are the base these apps run on.
2. In the Store, add this repository as a GitHub source: `IterioDev/car-apps`, channel **Tags**.
3. Install an app (or a tool under *Tools*), then restart the head unit once: on iDrive 8 an app installs at the
   next start.

Coming from IterioDev's earlier App Manager? Your Store has a source named `car-apps` (the old `index.json` link).
That link is gone: remove that source, then add `IterioDev/car-apps` as above. It then updates the apps you have.

## Overlays (tool `iteriodev-overlays`, iDrive 8 only)

> [!NOTE]
> **Car-tested** (G82): the shortcuts (tap, hold to save), seat heating / ventilation and steering wheel heating in
> the bar's own spots (0.3.1), M1 -> SPORT and back to ROAD as the car reports M setups (0.3.2, only M1 / M2 since
> 0.3.3), the ambient light flash with its default colours (0.3.4). Not car-tested yet: the level segments, the shift
> lights, TRACK, *Start in M SPORT* (0.3.3), other flash colours, the app's picker and settings pages, and 0.3.7's
> fixes (seat heating in the AUTO program, ventilation shown only once seen, M setups ending with the car switched
> off, no shift lights on M cars), 0.3.8 (the HMI's own shortcut icons), 0.3.9 (the strip 15 s after a start, a
> solid phone icon) and 0.4.0 (the right-hand drive setting).

An iDrive 8.5-style strip drawn over the climate bar, there from 15 s after the head unit starts (or wakes) with the HMI up, so
not over the black start screen or the M start animation, and from then on always (also over the reversing camera):

- **Shortcuts:** two left and two right of *CLIMATE MENU*, with the HMI's own icons (Media, Navigation, Phone, All
  apps). A tap opens the slot's screen; holding one for 1 s saves the screen you are on into it (any BMW screen or
  app). The app picks them from a list too.
- **Seat heating / ventilation** in the HMI's own spots and with its own icons: ventilation left of each
  temperature, heating right of it. A tap steps the level (1 -> 2 -> 3 -> off, or 3 -> 2 -> 1 -> off); on, the icon
  turns red / blue and the line under it shows the level (three segments). What it shows is always the car's live
  status, also when changed in the climate menu. Only what the car has is shown (on cars whose climate unit can't
  say, ventilation shows once it has been on: switch it on once from the HMI's own button, or set it ON in the app).
  While a side's climate runs the AUTO program the buttons follow its automatic seat heating / ventilation instead
  (four levels, Low to Very high, set the way the HMI sets them).
- **Steering wheel heating** at the bar's far left, one tap on / off.
- **Right-hand drive:** set *Steering wheel* to *Right* on the app's Climate page (default *Left*): the driver's
  seat buttons move to the right-hand spots, the passenger's to the left, and the wheel button to the bar's far right.
- **Ambient light flash** (on unless switched off in the app): when seat or steering wheel heating goes on, the
  ambient light turns red for 5 s, for ventilation blue, then back to your colour; from the strip, the climate menu
  or the seat buttons alike. The colours are picked in the app by their number in the car's ambient light menu
  (default 3 and 9: Coral and Azure). Cars with the 12-colour ambient light (G8x); nothing while it is off.
- **M1 / M2** (M cars): switching an M setup on also switches the M Mode (cluster and head-up display, as the M Mode
  button), switching it off goes back; which mode for M1, M2 and off is set in the app. Only M1 / M2 switch it: a
  mode picked with the M Mode button stays. Switching the car off ends an M setup (the next press enters it again).
- **Start in M SPORT** (M cars, off unless set in the app): after a start, once the cluster is up (it reports its
  view; the head unit wakes before it), the M Mode goes to SPORT if the cluster shows its standard view.
- **Shift lights** on the instrument cluster, for cars without their own (not M cars: those show theirs, so the
  tool hides its own there; set *M car* to NO in the app to have them anyway): 8 bars a side at the top centre of
  the cluster, over the map, lit from the outside in and flashing at the shift point, also in the head-up display
  above the speed. Lit from the engine speed against a start and a flash rpm (set in the app, or following the
  engine's current limit, lower while it is cold). Needs **Cluster renderer (`cluster-render`) 0.3.6 or newer** from
  [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps); without it the rest works as before.

The tool runs as the root service `iteriodev-overlays.service` and asks the HMI and the car over SOME/IP through its
helper `hmictl`. It needs **Renderer (`mgu-render`) 0.6.10 or newer**, which can draw it as an overlay: the tool adds
the drop-in `mgu-render.service.d/iteriodev-overlays.conf` that lists it (`overlay_apps`), read when the renderer
next starts, so restart the head unit once after installing. The deploy tool puts `hmictl` and the service on the
head unit's crash and restart whitelists (`crashNames`, `recmgr`) and limits its core dumps, so a crash of either
never restarts the head unit. The app talks to the tool over `/run/iteriodev-overlays/ctl.sock`; settings and
slots are kept in `/var/opt/iteriodev-overlays/slots.json`.

## Comfort (tool `iteriodev-comfort`, iDrive 7 and 8)

> [!NOTE]
> **Car-tested** (an M4, BDC_G05, seat modules FAS_G11 / BFS_G11): custom colours on all eight ambient light modules,
> seat hold-to-move and memory recall, parked. Not car-tested yet: Ambient Light 1.1.1's screen and later, Make room,
> moving the seats while driving, iDrive 7, Easy exit and the electric steering column (0.3.0), the passenger's Easy
> exit with the seat sensor and motor-only seats (0.4.0), the colour per drive mode (0.5.0).

The root service behind Ambient Light and Seats (`iteriodev-comfort.service`). It talks to the body controller and
the seat modules through the head unit's own diagnostic gateway, with the car's workshop jobs: the ambient light's RGB
per module (each write lasts 254 s and is renewed; switched off, the car's own colour returns at once; a zone with two
kinds of light, such as a line and decor, is split into parts with a colour each; with the drive modes on, the drive
mode the head unit reports picks the colour), the seat motors and their position
counters, and an electric steering column (through the body controller). Seats move at any speed (as with their own
switches) except Make room and Easy exit, which need the car standing; the steering column moves only while the car
stands, only when calibrated, and stops at its own soft end stops. Easy exit follows each front door, the ignition or
engine and, where the car reports it, the seat occupancy sensor (the passenger seat moves only with a person in it,
never with a child seat). A seat whose motors have no position sensors (often the passenger's, on cars with memory on
the driver's side only) gets hold-to-move only. Seat controls go ahead of the speed and engine reads, so they act at
once also on cars that lack one of those. Every move ends with a stop, and the seat's own switches always win. The apps talk to it over
`/run/iteriodev-comfort/ctl.sock`; the zones' colours and the seat memories are kept in
`/var/opt/iteriodev-comfort/data.json`.

## Tailscale (tool `iteriodev-tailscale`)

Remote access to the head unit over your tailnet. Tailscale 1.104.4 runs as the service
`iteriodev-tailscale.service` in userspace networking (the head unit's kernel has no TUN), as uid 3910, and reaches
the internet through `mgu-uplink` (the Store installs the uplink first). A connection from your tailnet to the
head unit's Tailscale address goes to the same port on the head unit's `127.0.0.1`, so `ssh root@<its tailnet name>`
reaches its own sshd (when the unit's SSH is on).

Log in once: open the **Tailscale** app on the head unit, scan the QR code with your phone and approve the device;
the app turns to *Connected*. Without the app, over SSH as root:

```sh
/var/opt/iteriodev-tailscale/current/ts up
```

prints the same `https://login.tailscale.com/...` link. The daemon's control socket is open to the head unit's apps
(the app logs in and out through it).
The login is kept in `/var/opt/iteriodev-tailscale/state` (removed with the tool). `ts status` shows the tailnet.

**Name on the tailnet:** `mgu` (the head unit's own hostname) unless you change it: *Rename* in the app (a-z, 0-9
and `-`; *Use mgu* goes back to the default), or `ts set --hostname=<name>` over SSH. The name is kept across
restarts and tool updates. `ssh root@<name>` and the Screen share address change with it. A name set for the device
in the Tailscale admin console wins over this one; a name already taken gets a suffix (`mgu-1`).
Consider turning off key expiry for this device in the Tailscale admin console.

- Reachable only while the head unit runs and the uplink is online: while the car sleeps, Linux is suspended.
- No log upload to Tailscale (`--no-logs-no-support`); MagicDNS is not set on the head unit itself.
- `tools/iteriodev-tailscale/build.sh` rebuilds the binary from Tailscale's source (static, the CLI linked in, only
  the features the head unit needs); `runas/` drops the service from root to uid 3910. `test.sh` checks the
  daemon's command line with and without the SOCKS5 setting below (offline, not installed on the head unit).

**SOCKS5 proxy for apps on the head unit (off by default, from 1.104.6):** apps on the head unit can reach your
tailnet through a local SOCKS5 proxy, e.g. a game-streaming app reaching your PC. Turn it on over SSH as root:

```sh
echo 1055 > /var/opt/iteriodev-tailscale/socks5-port
systemctl restart iteriodev-tailscale
```

Turning this on gives every app on the head unit the internet through your uplink, not only your tailnet: the
proxy also dials non-tailnet addresses as uid 3910, which mgu-uplink routes.

Apps then use the proxy at `127.0.0.2:1055` (the port in the file). Remove the file and restart to turn it off. The
file sits beside the tool's versioned folder, like the login state, so updates keep it. A value that is not a port
(1-65535, no leading zero) is ignored; the proxy never listens on anything but `127.0.0.2`. If another program
already listens on the port, tailscaled starts without the proxy and the journal says so.

- Not reachable from the tailnet: it listens on `127.0.0.2`, while incoming tailnet connections go to `127.0.0.1`
  (like ssh).
- **No authentication**, so every app and tool on the head unit (any uid) can use it: the same trust model as the
  daemon's control socket, which is open to all of them (0666). Your tailnet's access controls decide what the car
  can reach through it.

## Screen share (tool `iteriodev-screencast`)

> [!NOTE]
> **Car-tested** (1.0.6): picture and taps on the HMI work. 1.0.7 also hands taps to apps drawn by `mgu-render`;
> that part is not car-tested yet. 1.0.8 is one build for both ID7 and ID8: it auto-detects the panel's own
> resolution (picture shape and touch) with no per-car setting — not car-tested yet.

The head unit's centre display in a browser on your computer, over your tailnet. Clicks and drags on the picture
become touches on the screen. Needs the Tailscale tool above (logged in) and a browser: Chrome, Edge, Firefox,
Safari, or on an iPhone / iPad iOS 17.1 or newer (any browser there).

- **Picture:** the head unit's own screen grabber (`winston-grabber`) encodes the screen as H.264 in hardware:
  at the panel's own resolution (auto-detected, capped to 1600 px wide) at 10 fps, about 1 Mbit/s (about 450 MB an
  hour on a SIM uplink). It runs only while a browser has the
  page open and stops 5 s after the last one closes. Playback stays about 0.2 s behind the screen, plus the network.
  The status line shows the frame rate, the bit rate and how long frames take to arrive; when the uplink can't carry
  the stream, the server skips frames so the picture stays at most about 1 s behind instead of falling further back.
- **Touch:** a click is a tap, a drag is a swipe, sent the way the display sends its own touches (to the GPU
  renderer first while it runs, so renderer apps get their taps). A finger left down (closed tab, lost connection)
  is lifted after 2 s. The HOME/BACK keys and the iDrive controller are not covered.
- **Who can use it:** it answers only through Tailscale (it listens on the head unit's `127.0.0.1:5880`), and
  **anyone on your tailnet can see the screen and tap it**. If you share the tailnet, limit port 5880 with its
  access controls. Taps reach the screen while someone drives; don't use it on a moving car.

**Install:** in the Store, *Tools* -> **Screen share** -> *Install* (it installs the Tailscale tool first if it is
missing), then restart the head unit once: the service (`iteriodev-screencast.service`, user `os_7011` like BMW's
own grabber) starts at the next boot and waits for a browser.

**Use:** open `http://<head unit's tailnet name or address>:5880/`, e.g. `http://mgu:5880/`. The status line
says *live, 10 fps* once the picture runs; *Full screen* fills the monitor.

**If it doesn't work**, run it by hand over SSH as root to see its messages (no service; Ctrl-C stops it and the
grabber):

```sh
cd /var/opt/iteriodev-screencast/current && XDG_RUNTIME_DIR=/run/wayland SCREENCAST_PORT=5881 node screencast.js
```

then open port 5881. Size, frame rate and the encoder settings are the `SCREENCAST_*` environment variables at the
top of `screencast.js`.

## Drive Recorder (tool `iteriodev-drplay`)

> [!NOTE]
> **Car-tested** (2.0.1, G82): recording, saving and watching clips, with all cameras and with front + rear.
> Not car-tested yet: the 2.2.0 screens, Copy to USB, replacing the oldest clips at 4 GB, and the new app host
> (the Store's lifecycle, on iDrive 8 too; 2.3.0 did not start on the car, 2.3.1 fixes that).

> [!NOTE]
> **iDrive 7, car-tested** (a 2021 G20 M340i, MGU18, 360° cameras, no BMW online services; 2.3.5 to 2.3.12, players
> 1.1.2 to 1.1.4): it installs, starts, opens all its pages, finds all four cameras and records them; it saved full 91 s
> clips (all cameras, 60 s + 30 s, 476 MB each) and copied them to a USB stick, as recorded and as one camera's MP4.
> Not tested on iDrive 7 yet: a save after the player raised the clips' storage budget (below; the 91 s saves came
> before the old 1 GB filled), watching clips, a car with BMW's online services (see *BMW's online provisioning*
> below).

The app asks the car's camera unit for its Drive Recorder mode at every start (Settings can switch that off) and
keeps the last 30 s; *Save clip* on the Record page writes the 20 s before and the 10 s after (Settings: *Clip
length*). The cameras offered are the ones the car has: all cameras, front + rear, front or rear (checked at the
first start, asked again while the camera unit is still starting; iDrive 7's takes about 10 s). A car not coded for the
Drive Recorder (seen on a retrofitted rear camera) shows *No drive-recorder cameras found*. While a parking view is
open, also the automatic one some cars show right after the start, the cameras belong to it and nothing is recorded:
a save soon after writes the seconds recorded since then (from 5 s on, *Save clip · N s before*), not a full clip.

The player (`iteriodev-drplay.service`, uid 3912, no internet) plays the clips through the GPU renderer, makes the
thumbnails, locks, deletes and replaces the oldest clips, and copies to a USB stick: a whole clip as recorded, or one
camera as an MP4 with the date, time and speed on it. Clips stay in the car's own Drive Recorder folder; *Lock* moves
one into its `locked/` folder.

**Install:** in the Store, **Drive Recorder** -> *Install* (it installs the player too), then restart the head unit
once. Most cars then need one more restart: the head unit's camera service turns its recording buffer on only with a
second provisioning line (`oap_drive_recorder`, next to the app's own), which the player (1.1.1) adds at its first
start. Until then Diagnostics says *Flag on, but icam2proxy offers no video buffer*. On iDrive 7 the deploy tool
writes no das lines, so the player (from 1.1.2) adds both there, the app's and `oap_drive_recorder` (it keeps each das
file's first copy in `/var/opt/iteriodev-drplay/das-orig/`); until the restart after that, Diagnostics says
*Provisioning flag not set*.

**BMW's online provisioning:** the das lines work only on a car whose provisioning comes from its das files
(Diagnostics: *Provisioning data state: DAS*). A car provisioned online by BMW (data state *OTA*) takes that whole
part from BMW's signed provisioning file, and the head unit reads no app lines from the das files there. Its camera
service turns the recording buffer on only if BMW's provisioning for that car enables the Drive Recorder; there is
no way around that from the app. Diagnostics (2.3.13) then says *Provisioning flag not set by BMW*.

**Storage budget (player 1.1.4):** BMW's `/usr/bin/quotaset.sh` gives the camera service (user `ent_icam2proxy`) and
its group (`mgu_driverec`, which writes the clip folder) 1 GB of `/var/opt` each on an MGU18 (100 MB on some
variants): two clips of all cameras at 60 s + 30 s. Once it is full the camera service's saves end part way or at
once, and the oldest clips are replaced only over 4 GB. The player raises both hard limits to 4.5 GB at its start (the
4 GB of clips it keeps + one being written), only where they are lower and not unlimited, and keeps its own files
(thumbnails, a camera's MP4 before it goes to the stick) in group `mgu_persist`, outside the budget. BMW's 1 GB again,
as root: `setquota -g mgu_driverec 0 1048576 0 0 /var/opt; setquota -u ent_icam2proxy 0 1048576 0 0 /var/opt`.

**USB stick (player 1.1.3):** the car mounts a stick for its media player read-only (udisks, `/media/<label>`), and
the player copies only to a writable one. While the app's *Copy to USB* page is open or a copy runs, the player's
`usb-rw.sh` (root) remounts the stick read-write, and read-only again 20 s after; kept read-only otherwise, as the car
does not unmount a stick before it is pulled. FAT32 and exFAT both work. A slow stick sits at 99 % for a while: the
player has handed over the whole clip and waits until it is on the stick (the G20's stick took about 1 MB/s).

## What is in this repository

- `apps/<id>/`: one folder per app with its package `<id>@<version>.tgz`, its `app.json` (version, title,
  description, the head units it is for, what it needs and requires) and `icon.png`. A package is a source
  package (`mgu-app.json`, as the Store itself ships): the Store's deploy tool builds it on the head unit with that
  unit's own app SDK when it installs it, so one package serves iDrive 7 and iDrive 8.
- `tools/<id>/`: one folder per tool with its prebuilt files and `component.json`.
- `mgu-repo.json`: what mgu-store reads. Every folder under `apps/` is an app and the tools are listed; the apps'
  build step, `tools/prebuilt.js`, does nothing because the package is already here.

Each release is a tag `x.y.z`. The apps need the Store's deploy tool 0.7.5 or newer (the Store installs it first).

## Disclaimer

Use at your own risk. These apps are not made or endorsed by BMW. Fault Codes can clear fault memories (only
when you ask); Live Adjustments switches MHD maps and drives the exhaust flap (not affiliated with MHD); Drive Recorder
puts the cameras into their Drive Recorder mode; Ambient Light sets the interior light's colours and Seats moves the
front seats and an electric steering column (through the Comfort tool); the other apps only read from the car.

## License

PolyForm Strict License 1.0.0 with an additional permission for paid installation (see [LICENSE.md](LICENSE.md)):
install the apps and tools as they are and use them on your own car for noncommercial purposes. You may charge for
installing them on someone's car, but not for the apps or tools themselves. No selling them, no redistribution, no
changes or new works based on them. Never remove the credits, put your own logo or name on them, or pass them off
as yours. Third-party parts keep their own licenses (listed in LICENSE.md).
