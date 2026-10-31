# car-apps

> [!WARNING]
> **Not tested on iDrive 7.** These apps and tools have been tested only on iDrive 8, in the emulator and on a real
> car.

Apps and tools by IterioDev for BMW head units with iDrive 8 (MGU). The apps run in the head unit's own app platform
and show up in *All apps* like BMW's apps. Live Adjustments and Tailscale (app and tool) also install on iDrive 7;
the others are for iDrive 8 only.

## The apps

| App | Package id | What it does |
|---|---|---|
| Car Data | `iteriodev_cardash` | Live engine data: engine speed, boost, power and torque bars with peak hold, oil, coolant and intake temperatures. |
| Drag Timer | `iteriodev_draggy` | Acceleration timer: stand still, launch, and it times the run with splits and a speed-over-time chart. Keeps your best times; km/h or mph. |
| Fault Codes | `iteriodev_dtcscan` | Reads the fault memory of every control unit in the car, shows each fault with its text and clears it when you ask. Also lists the car's Check Control messages. |
| Live Adjustments | `iteriodev_liveadjust` | For an MHD-tuned DME: engine map 1-4 and MHD Max Cooling, plus the exhaust flap (open, close, back to the DME). See below. |
| Tailscale | `iteriodev_tailscale` | The head unit's Tailscale state and login: the login link as a QR code to scan with your phone, then the head unit's tailnet name, address and account, Rename (default `mgu`) and Log out. Needs the Tailscale tool below (the Store installs it with the app). |

All of them draw their screens through the GPU renderer `mgu-render`. On iDrive 7 the screens are scaled down to fit
right of the HMI's back arrow, under its title strip.

**Live Adjustments** (one screen, sends a command only when you tap a button). Car-tested: the engine map switch
works (1.0.1, MHD). Max Cooling and the exhaust flap are not car-tested yet.

- **Engine map 1-4** (MHD): only with the car standing still. The DME has to echo the request back, or the screen
  says why it wasn't switched. MHD reports no active map, so the screen shows the map the DME accepted, not one it
  read back. The engine light may flash while the map changes; MHD does that.
- **Max Cooling** (MHD): at any speed, accepted the same way. *On* only with the engine running (over 500 rpm);
  *Off* any time, and shown until you switch it on.
- **Exhaust flap**: BMW's own DME job (DID 60FD), at any speed. *Open* / *Close* hold for about 20 s; then the DME
  controls the flap again (*OEM* hands it back at once). The flap position is read from the DME every 2 s while the
  screen shows. A DME without an electric flap shows *NONE*.
- A DME without MHD refuses map and cooling: the screen says *Not available on this car*.

## Installing

1. Install the Store from [robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) first,
   following its README: its updater, deploy tool, GPU renderer (`mgu-render`) and internet uplink (`mgu-uplink`)
   are the base these apps run on.
2. In the Store, add this repository as a GitHub source: `IterioDev/car-apps`, channel **Tags**.
3. Install an app (or a tool under *Tools*), then restart the head unit once: on iDrive 8 an app installs at the
   next start.

Coming from IterioDev's earlier App Manager? Your Store has a source named `car-apps` (the old `index.json` link).
That link is gone: remove that source, then add `IterioDev/car-apps` as above. It then updates the apps you have.

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
> that part is not car-tested yet.

The head unit's centre display in a browser on your computer, over your tailnet. Clicks and drags on the picture
become touches on the screen. Needs the Tailscale tool above (logged in) and a browser: Chrome, Edge, Firefox,
Safari, or on an iPhone / iPad iOS 17.1 or newer (any browser there).

- **Picture:** the head unit's own screen grabber (`winston-grabber`) encodes the screen as H.264 in hardware:
  1440x480 at 10 fps, about 1 Mbit/s (about 450 MB an hour on a SIM uplink). It runs only while a browser has the
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

- `apps/<id>/`: one folder per app with its package `<id>@<version>.tgz`, ready to install, its `app.json`
  (version, title, description, the head units it is for, what it needs and requires) and `icon.png`.
- `tools/<id>/`: one folder per tool with its prebuilt files and `component.json`.
- `mgu-repo.json`: what mgu-store reads. Every folder under `apps/` is an app and the tools are listed; the apps'
  build step, `tools/prebuilt.js`, does nothing because the package is already here.

Each release is a tag `x.y.z`. The apps' sources are not published here.

## Disclaimer

Use at your own risk. These apps are not made or endorsed by BMW. Fault Codes can clear fault memories (only
when you ask); Live Adjustments switches MHD maps and drives the exhaust flap (not affiliated with MHD); the other
apps only read from the car.
