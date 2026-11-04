# Car Data

Live engine data on your iDrive 8 screen: engine speed, boost, power and torque with their peaks, oil, coolant and intake temperatures, battery voltage; fuel and air values with their last 5 minutes; a trip computer with costs; gearbox data (ZF 8HP, read-only, experimental); the engine unit's values in groups. Bar ends, fuel price and currency are set on the Settings page.

Version 1.3.0 · iDrive 8 only · package `iteriodev_cardash` · [all apps and how to install](../../README.md)

> [!NOTE]
> Version 1.3.0 is not tested on a car yet. Open points: the fuel figure on Trips, whether trips are counted while the screen is closed, and Transmission (ZF 8HP variants 0F25D0 and 0F21E0 only).

## Screens

Screens from the app's offline test against a simulated car, so the values are made up. The climate bar along the bottom is the test's stand-in for the car's own.

### Engine

![Engine](screenshots/engine-peaks.png)

Engine speed, boost, power and torque with their peaks, the speed, and oil, coolant, intake air and battery.

### Fuel & air

![Fuel & air](screenshots/fuel.png)

Intake air, fuel pressures, ignition timing and boost (target and actual), each with its last 5 minutes.

### Trips

![Trips](screenshots/trips.png)

The last trip (distance, fuel, consumption, cost, time, average speed) and the totals for today, 7 or 30 days.

### Transmission

![Transmission](screenshots/transmission.png)

ZF 8HP, read-only and experimental: gear, gearbox oil, speeds, converter slip, clutch adaptations and the oil temperature history.

### Details

![Details](screenshots/details.png)

The engine unit's values in groups.

### Settings

![Settings](screenshots/settings.png)

Where each bar turns red, the fuel price and the currency.
