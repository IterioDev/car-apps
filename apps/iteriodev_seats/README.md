# Seats

Move the driver and passenger seats from the central display, also while driving (as with the seats' own switches, for a passenger who can't reach theirs), both on one page: each seat seen from the side with its controls round it (fore / aft, height, backrest, tilt and headrest, while you hold them), three memories per seat under it (for cars without memory buttons too), the Gentleman button (parked only) that moves the passenger seat out of the way and back, and Easy exit for both front seats: the seat (and on the driver's side an electric steering column) moves to your own getting-out position when its door opens with the car standing, and back once the door is shut (the driver's with the car on, the passenger's with someone seated). The seat's own switches always win. Needs the Comfort tool (the Store installs it with the app).

Version 1.5.0 · iDrive 7 and 8 · package `iteriodev_seats` · [all apps and how to install](../../README.md)

> [!NOTE]
> Run on a car (an M4, seat modules FAS_G11 / BFS_G11): hold-to-move and memory recall work, parked. Not run on a car yet: the 1.1.0 page, Make room, and moving while driving (1.1.1; whether the seat modules take it at speed is not known yet). iDrive 7 (1.2.0): not run on an iDrive 7 car yet. Easy exit and the electric steering column (1.4.0): not run on a car yet. The passenger's Easy exit with the seat sensor and motor-only seats (1.5.0): not run on a car yet.

### While driving

![While driving](screenshots/seats-driving.png)

Everything works but Make room, which needs the car parked.

## Screens

Screens from the app's offline test against a simulated car, so the values are made up.

### Both seats

![Both seats](screenshots/seats.png)

Hold a control: the seat moves while you hold it. Only the controls a seat has are shown. A seat whose motors have no position sensors (often the passenger's, on cars with memory on the driver's side only) gets the hold controls only: no memories, Easy exit or Make room.

### Moving

![Moving](screenshots/seats-moving.png)

The control held turns amber; the line at the top says what moves.

### Memories

![Memory](screenshots/seats-memory.png)

M1 - M3: tap to recall. While the seat moves to it, the button is lit: tap it (or any control) to stop.

![Save](screenshots/seats-save.png)

Save, then M1, M2 or M3 keeps the seat as it is. On a car with an electric steering column, the driver's memories keep the wheel's place too.

### Easy exit

![Easy exit](screenshots/seats-exit.png)

Each seat has its own Easy exit: Save, then Easy exit keeps that seat's getting-out position (on the driver's side with an electric steering column too). With the car standing (under 2 km/h, the engine may run), the driver door opening moves the column, then the seat there; the driver door shut with the ignition or the engine on (whichever comes last) puts both back where you sat. The passenger seat moves out when its door opens with a person in it (by the car's seat occupancy sensor; never with a child seat, nor with the seat empty), and back once someone sits in it with the door shut; on a car whose sensor reports nothing, it goes back like the driver's (door shut, car on). Both doors at once: the seats move one after the other. A move that stops short (the module pausing, say while the engine starts) is tried again. Tap Easy exit to go there by hand, or to stop a move. The column moves only while the car stands and stops at its own soft end stops. Settings has an *Easy exit* Off / On switch.

### Make room

![Make room](screenshots/seats-gentleman.png)

Moves the passenger seat all the way forward and tips the backrest; the button shows Stop while it runs, then Move back puts it where it was.

### Right-hand drive

![Settings](screenshots/settings-rhd.png)

Settings, *Steering wheel on the Right*: the driver's seat moves to the right half, the passenger's (with Make room) to the left.

![Right-hand drive](screenshots/seats-rhd.png)

### iDrive 7

![iDrive 7](screenshots/seats-id7.png)

The same page on iDrive 7's smaller screen; Make room sits bottom left of the passenger's half.
