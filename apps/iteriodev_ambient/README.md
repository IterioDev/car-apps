# Ambient Light

Any colour on the interior ambient light, not only the car's own presets, on one screen: your car's zones in a list (dash, doors, footwell, console, seats, roof: the ones it has), a colour bar for any shade, brightness (or follow the car's, dimmer at night), the car's colours as starting points and six presets of your own that keep every zone's colour. Each zone can follow the main colour, have its own, or keep the car's. A zone with two kinds of light (an X6's dash: a line above, decor below) shows as two rows, each with its own colour. Drive modes: a colour for each drive mode (Sport, Comfort, Eco Pro, their Plus and Individual, Adaptive) that the light switches to with the mode. Works while the car's own ambient light is switched on. Needs the Comfort tool (the Store installs it with the app).

Version 1.4.0 · iDrive 7 and 8 · package `iteriodev_ambient` · [all apps and how to install](../../README.md)

> [!NOTE]
> The colour route is run on a car (an M4, BDC_G05: custom colours on all eight light modules, Comfort 0.1.3). Comfort 0.1.4 runs on that car and finds its lights and zones. The 1.1.1 screen is not run on a car yet. iDrive 7 (1.2.0): not run on an iDrive 7 car yet. Drive modes (1.3.0): not run on a car yet; Sport Plus is the car's "Sport expert" mode, a guess. The iDrive controller (1.4.0): not run on a car yet.

## Screens

Screens from the app's offline test against a simulated car, so the values are made up.

### Colour

![Colour](screenshots/colour.png)

All zones picked: the colour bars and the car's colours set the main colour.

![Colour picked](screenshots/colour-picked.png)

Drag the colour bars; the lights follow (at most four updates a second reach the car).

### Zones

![Zones](screenshots/colour-zones.png)

Tap a zone's name to colour it with the bars; its All / Own / Car buttons give it the main colour, its own, or the car's.

![Two-line dash](screenshots/colour-x6.png)

A dash with a line and decor: two rows, each its own colour.

### Presets

![Presets](screenshots/colour-presets.png)

Save preset keeps the whole look: the main colour and every zone's (six at most, the oldest goes). Tap one to bring it all back.

### Drive modes

![Drive modes](screenshots/modes.png)

A colour for each drive mode: tap a mode, then set its colour with the bars or the car's colours, or None to leave the light as the Colour page has it. With *Colour by drive mode* on, switching the mode (the car's own drive mode switch) turns every zone to that mode's colour; a mode without one goes back to the Colour page's colours. The ringed swatch is the mode the car is in now. Brightness stays as on the Colour page.

### iDrive controller

![iDrive controller](screenshots/colour-controller.png)

For cars without a touchscreen: turn the controller and a white ring goes from control to control (the zone list, then the middle, then the car's colours and presets); push it up, down or right to jump that way. Press to tap the ringed control. On a colour bar or the brightness slider, press once (the ring turns amber), turn to change it, press again when done. The first turn only shows the ring; touching the screen hides it. Push left or BACK leaves the page as usual.

### iDrive 7

![iDrive 7](screenshots/colour-id7.png)

The same page on iDrive 7's smaller screen: each zone shows All / Own / Car as text; tap one, then set it with the buttons in the middle.

![iDrive 7 drive modes](screenshots/modes-id7.png)
