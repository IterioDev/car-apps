# Turn View

The front camera in the instrument cluster, with a turn card (arrow and distance) and, near each turn, a blue turn sign
(three chevrons pointing the way, like a curve sign; 1.5.1, tool 0.8.0) while a route is running; none while driving
straight. Navigation comes from BMW Maps, CarPlay or Android Auto. Without a route the cluster shows the front camera
alone (1.4.0). No coding needed. The app shows the status and calibrates the camera.

**On the head unit instead (1.6.0, tool 0.9.0):** the app's **Camera** button opens a page with the camera's whole
picture (kerbs near the bumper show too) at up to 30 pictures a second, with the same turn card and turn sign over it.
Pick *Picture on: Head unit* there and the cluster gets no picture (iDrive 8's widget says *Turn View is on the head
unit*, iDrive 7's map area goes back to the map); the camera is used only while the page is open. It works at any
speed, e.g. for kerbs and tight gaps. Calibrating still shows its marks in the cluster. Not car-tested yet.

**Tool 0.9.1:** the turn sign shows at every turn again (on iDrive 7 it showed at the first turn of a drive only).

**iDrive 8:** pick **Turn View AR** in the cluster's widget menu (from the car's next start after installing).

**iDrive 7:** Turn View is **off at every start of the car** (1.5.0, tool 0.7.0; the last setting is not kept): switch it
on in the Turn View app when you want it, and set **Instrument cluster > Central display area** to **Map view**. While
it is on, the camera takes the cluster's central map area. Off, it holds nothing: no camera request (Drive Recorder
keeps the cameras), no video, the map area the car's. The app has its own iDrive 7 screens.

## Waze on cluster

**Do not use Turn View together with Waze on cluster on the cluster. Set Waze on cluster to HUD only.** Both draw
into the cluster's central map area, and the cluster and the HUD together show at most 2 videos: Waze on the cluster
and the HUD takes both, and Turn View's camera then gets no room (the cluster and the app say *Cluster video full*;
Turn View asks again every 5 s). With Waze on the HUD only, Waze stays on the HUD and Turn View has the cluster.

**Needs a front camera:** cars with the 360 cameras (Surround View) or front + rear cameras. When the camera unit
does not give the front camera alone, Turn View asks for front + rear, then all cameras, and shows the front camera
from those. Only a camera unit that gives the rear camera and never the front makes the iDrive 8 widget show *No front
camera* and nothing else. Turn View does not need Drive Recorder: it receives the camera itself.

Version 1.6.0 (tool `iteriodev-turnview` 0.9.0) · iDrive 7 + iDrive 8 · package `iteriodev_turnview` ·
[all apps and how to install](../../README.md)

> [!NOTE]
> Car-tested on iDrive 8 (M4, Apple Maps over CarPlay): the camera and the turn card in the cluster widget. **iDrive 7
> car-tested** (G20 with 360 cameras): the front camera in the cluster's centre without a route, about 15 pictures a
> second. Waze sends no turns to the car (route summary only), so with Waze the camera shows without a turn. BMW Maps
> and Android Auto are not car-tested yet, nor are cars with front + rear cameras only (no 360), nor turns on iDrive 7.

Needs Cluster renderer (`cluster-render`, robertnisipeanu/idrive-apps) 0.5.10 or newer. On iDrive 8, after every
update of the Turn View tool, pick the widget again in the cluster menu.

## Screens

Screens from the app's offline test against a simulated car, so the values are made up.

### Status

![Status](screenshots/home.png)

What the cluster shows: the camera, the route, where the navigation comes from and the next turn.

![Status on iDrive 7](screenshots/home-id7.png)

The same on iDrive 7, with its own layout.

### Calibrate

![Calibrate](screenshots/calib.png)

![Calibrate on iDrive 7](screenshots/calib-id7.png)

Camera height, tilt, field of view, aim and offset, with marks at 5, 10 and 20 m: move the sliders until the marks
lie on the road at those distances.
