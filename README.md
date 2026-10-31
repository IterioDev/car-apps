# car-apps

> [!WARNING]
> **Do not install any app from this repository yet.** The apps are being tested on a car with the new setup
> described below. This notice will be removed once that testing is done and this README is updated.

Apps by IterioDev for BMW head units with iDrive 8 (MGU). They run in the head unit's own app platform and
show up in *All apps* like BMW's apps.

## The apps

| App | Package id | What it does |
|---|---|---|
| Car Data | `iteriodev_cardash` | Live engine data: engine speed, boost, power and torque bars with peak hold, oil, coolant and intake temperatures. |
| Drag Timer | `iteriodev_draggy` | Acceleration timer: stand still, launch, and it times the run with splits and a speed-over-time chart. Keeps your best times; km/h or mph. |
| Fault Codes | `iteriodev_dtcscan` | Reads the fault memory of every control unit in the car, shows each fault with its text and clears it when you ask. Also lists the car's Check Control messages. |

All three draw their screens through the GPU renderer `mgu-render`.

## Installing

1. Install the Store from [robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) first,
   following its README: its updater, deploy tool, GPU renderer (`mgu-render`) and internet uplink (`mgu-uplink`)
   are the base these apps run on.
2. In the Store, add this repository as a GitHub source: `IterioDev/car-apps`, channel **Tags**.
3. Install an app, then restart the head unit once: on iDrive 8 an app installs at the next start.

Coming from IterioDev's earlier App Manager? Your Store has a source named `car-apps` (the old `index.json` link).
That link is gone: remove that source, then add `IterioDev/car-apps` as above. It then updates the apps you have.

## What is in this repository

- `apps/<id>/`: one folder per app with its package `<id>@<version>.tgz`, ready to install, its `app.json`
  (version, title, description, what it needs) and `icon.png`.
- `mgu-repo.json`: what mgu-store reads. Every folder under `apps/` is an app; its build step, `tools/prebuilt.js`,
  does nothing because the package is already here.

Each release is a tag `x.y.z`. The apps' sources are not published here.

## Disclaimer

Use at your own risk. These apps are not made or endorsed by BMW. Fault Codes can clear fault memories (only
when you ask); the other apps only read from the car.
