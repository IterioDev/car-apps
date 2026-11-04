# car-apps

> [!WARNING]
> **Not tested on iDrive 7.** These apps and tools have been tested only on iDrive 8, in the emulator and on a real
> car. Car Data also installs on iDrive 7 (its version before the Telemetry redesign); there it is checked only as far
> as building against iDrive 7's app SDK. Drag Timer, Fault Codes, Live Adjustments, Overlays and Tailscale are
> iDrive 8 only.

Apps and tools by IterioDev for BMW head units with iDrive 7 and iDrive 8 (MGU). The apps run in the head unit's own
app platform and show up in *All apps* like BMW's apps.

## The apps

| App | Package id | What it does |
|---|---|---|
| Car Data | `iteriodev_cardash` | Live engine data: engine speed, boost, power and torque bars with peak hold, oil, coolant and intake temperatures. |
| Drag Timer | `iteriodev_draggy` | **iDrive 8 only** from 1.2.0 (iDrive 7 cars that have 1.1.8 keep it). Acceleration timer: stand still, launch, and it times the run with splits and a speed-over-time chart. Power run: floor it in one gear for power and torque over rpm, with a baseline to compare (from cauliflowermossgrape's idrive7-apps). Keeps your best times; km/h or mph. |
| Fault Codes | `iteriodev_dtcscan` | **iDrive 8 only** (from 1.2.0; iDrive 7 cars keep the version they have). Reads the fault memory of every control unit in the car, shows each fault with its text and clears it when you ask. Also lists the car's Check Control messages. |
| Live Adjustments | `iteriodev_liveadjust` | **iDrive 8 only** (from 1.1.0; iDrive 7 cars keep 1.0.7). For an MHD-tuned DME: engine map 1-4 and MHD Max Cooling, plus the exhaust flap (open, close, back to the DME). See below. |
| Overlays | `iteriodev_overlays` | **iDrive 8 only.** Sets up the Overlays strip in the climate bar: four shortcuts to BMW screens or apps, seat heating / ventilation and steering wheel heating buttons, shift lights on the cluster (any car), and on M cars the M Mode that M1 / M2 switch to. Needs the Overlays tool below (the Store installs it with the app). |
| Tailscale | `iteriodev_tailscale` | **iDrive 8 only** (iDrive 7 cars keep 1.0.4). The head unit's Tailscale state and login: the login link as a QR code to scan with your phone, then the head unit's tailnet name, address and account, Rename (default `mgu`) and Log out. Needs the Tailscale tool below (the Store installs it with the app). |

All of them draw their screens through the GPU renderer `mgu-render`. On iDrive 7 the screens are scaled down to fit
right of the HMI's back arrow, under its title strip.

**Live Adjustments** (one screen, sends a command only when you tap a choice). Car-tested: the engine map switch
works (1.0.1, MHD). BMW's regulated flap job opens and closes the flap on a G80 S58 MHD, but the DME drops it once
the car moves (issue #3). Max Cooling and MHD's own flap control (1.0.7) are not car-tested yet.

- **Engine map 1-4** (MHD): only with the car standing still. The DME has to echo the request back, or the screen
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
> lights, TRACK, *Start in M SPORT* (0.3.3), other flash colours, and the app's picker and settings pages.

An iDrive 8.5-style strip drawn over the climate bar, always there (also over the reversing camera):

- **Shortcuts:** two left and two right of *CLIMATE MENU*. A tap opens the slot's screen; holding one for 1 s saves
  the screen you are on into it (any BMW screen or app). The app picks them from a list too.
- **Seat heating / ventilation** in the HMI's own spots and with its own icons: ventilation left of each
  temperature, heating right of it. A tap steps the level (1 -> 2 -> 3 -> off, or 3 -> 2 -> 1 -> off); on, the icon
  turns red / blue and the line under it shows the level (three segments). What it shows is always the car's live
  status, also when changed in the climate menu. Only what the car has is shown.
- **Steering wheel heating** at the bar's far left, one tap on / off.
- **Ambient light flash** (on unless switched off in the app): when seat or steering wheel heating goes on, the
  ambient light turns red for 5 s, for ventilation blue, then back to your colour; from the strip, the climate menu
  or the seat buttons alike. The colours are picked in the app by their number in the car's ambient light menu
  (default 3 and 9: Coral and Azure). Cars with the 12-colour ambient light (G8x); nothing while it is off.
- **M1 / M2** (M cars): switching an M setup on also switches the M Mode (cluster and head-up display, as the M Mode
  button), switching it off goes back; which mode for M1, M2 and off is set in the app. Only M1 / M2 switch it: a
  mode picked with the M Mode button stays. The app's M Mode page shows once the car has reported an M setup.
- **Start in M SPORT** (M cars, off unless set in the app): after a start, once the cluster is up (it reports its
  view; the head unit wakes before it), the M Mode goes to SPORT if the cluster shows its standard view.
- **Shift lights** on the instrument cluster, for any car (iDrive 8): 8 bars a side at the top centre of the
  cluster, over the map, lit from the outside in and flashing at the shift point; on cars without their own (not
  M) also in the head-up display above the speed. Lit from the engine speed against a start and a flash rpm (set in
  the app, or following the engine's current limit, lower while it is cold), or from an M car's own shift-light
  signal. Needs **Cluster renderer (`cluster-render`) 0.3.6 or newer** from
  [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps); without it the rest works as before.

The tool runs as the root service `iteriodev-overlays.service` and asks the HMI and the car over SOME/IP through its
helper `hmictl`. It needs **Renderer (`mgu-render`) 0.6.10 or newer**, which can draw it as an overlay: the tool adds
the drop-in `mgu-render.service.d/iteriodev-overlays.conf` that lists it (`overlay_apps`), read when the renderer
next starts, so restart the head unit once after installing. The deploy tool puts `hmictl` and the service on the
head unit's crash and restart whitelists (`crashNames`, `recmgr`) and limits its core dumps, so a crash of either
never restarts the head unit. The app talks to the tool over `/run/iteriodev-overlays/ctl.sock`; settings and
slots are kept in `/var/opt/iteriodev-overlays/slots.json`.

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
  the features the head unit needs); `runas/` drops the service from root to uid 3910.

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
when you ask); Live Adjustments switches MHD maps and drives the exhaust flap (not affiliated with MHD); the other
apps only read from the car.

## License

PolyForm Strict License 1.0.0 with an additional permission for paid installation (see [LICENSE.md](LICENSE.md)):
install the apps and tools as they are and use them on your own car for noncommercial purposes. You may charge for
installing them on someone's car, but not for the apps or tools themselves. No selling them, no redistribution, no
changes or new works based on them. Never remove the credits, put your own logo or name on them, or pass them off
as yours. Third-party parts keep their own licenses (listed in LICENSE.md).
