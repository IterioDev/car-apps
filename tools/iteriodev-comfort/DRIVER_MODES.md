# Driver easy entry and exit

This proposal carries the existing functional settings screen from a private Comfort 0.6.5 / Seats 1.6.9 build into the original Seats design. It does not include the separate visual redesign or private recording code. Proposed public versions are Comfort 0.7.0 and Seats 1.7.0; these are review versions, not a released or installed update.

## Settings and targets

The settings page has Driver and Passenger halves. Driver has Easy exit Off/On, separate Drive and Exit Adaptive/Fixed selections, and a relative-distance minus/number/plus control. The main seat-control layout, memories, Save, manual Exit, Make room, controller navigation and author credits are retained.

| Setting | Fixed | Adaptive |
| --- | --- | --- |
| Drive | App Memory 1, including the stored column target when present | Position captured before this exit; retain upstream 32-count recognition of the last actual exit position |
| Exit | User-saved Exit position | Fore/aft-only relative retreat of 75, 150 or 225 sensor counts, capped by explicit vehicle calibration |

These are app memories, not BMW factory M1/M2. Counts are not millimetres. A relative cycle captures its anchor once: repeated exit triggers reuse its destination instead of retreating again. Successful return or mode/distance/calibration changes clear the cycle. Adaptive return remains suppressed after manual movement outside upstream's recognition tolerance; coupe fold-lever detection is not implemented.

Settings are confirmed by the service state stream. Actual mode/distance/calibration changes are rejected while control work is active, including STOP cleanup; Easy exit may still be switched off. Turning it off cancels automatic work and queued movement permissions, not ordinary manual jog/memory control. Missing new fields migrate to Adaptive Drive, Fixed Exit and level 2; saved memories, ambient data and existing per-seat Exit/pre/out data survive migration.

## Explicit relative calibration

There is deliberately no default rear count or count direction for other vehicles. `settings.driverRelativeLimit` is null until an operator supplies a verified object containing exactly `rear` (an integer hall count within 8192..57344) and `direction` (-1 or +1, the confirmed rearward count direction). A syntactically valid number does not prove it is physically safe. Select a reachable, buffered rear target for that vehicle; never use another car's count as calibration.

This is an advanced service setting, not a new calibration GUI. The existing `{op:"set", settings:{...}}` protocol accepts `driverRelativeLimit`; valid values are persisted, copied and rechecked before dispatch. This document intentionally supplies no vehicle command or sample calibrated count. Back up settings and perform any calibration separately with the seat stationary, parked, its travel clear and a physical interruption available. Calibration cannot be changed during a seat job.

Without calibration the service rejects relative Exit, including manual relative requests; Fixed Exit remains available. The distance control is shaded/disabled and the settings explain that calibration is required. Clearing calibration while Adaptive Exit is selected is rejected; select Fixed Exit first. Calibration changes invalidate any captured cycle. No polling, automatic learning, end-stop probing or extra diagnostic read is added for calibration. Native travel limits and obstruction detection are not replaced or proven by this software cap.

## Triggers and guards

- A complete VehicleCondition notification with qualifier 2 establishes the baseline. Only a subsequent transition to condition 10 requests Drive, with a 500 ms startup settle. Condition 8 alone does not request it.
- A validated 10 to 12 transition requests Exit. It may finish through a temporary unavailable-qualified interval, but a new valid state or helper reset cancels it. Shutdown Exit does not depend on shifter P.
- While condition 10 is known, the driver door opening requests Exit only with fresh gear-display P and standing evidence. P is read from the existing gear-display event stream (one-byte value 3, two-second freshness), not a verified mechanical park-lock sensor. Missing/stale P cancels only a door-exit action.
- Door close requests Drive only when condition 10 and the driver door closed are known. Fixed Drive is the saved driving destination and is allowed to complete after leaving P/standstill. Adaptive Drive retains the standing guard. The steering column retains its separate standing/calibration guards in both modes; the Fixed seat exemption does not exempt the column.
- First notifications, duplicates and reconnection baselines do not trigger movement. Source loss resets the policy, clears cached P and rejects queued old helper traffic. Cancellation is checked after awaited reads, between axes, at the diagnostic queue and immediately before helper dispatch. STOP writes bypass these movement permissions.
- Existing driver occupancy policy is retained; no new occupancy decoder is claimed.

The smoother owner-observed control is not a separate new motor algorithm: transport reliability is PR38 and STOP cleanup is PR44. This PR contributes cancellation/permission checks, not precision tuning.

The existing speed/RPM thresholds and motor PWM, payloads, tolerances, correction strategy and sequential axis order remain unchanged. The permission callback is an optional transport/mover extension; normal manual controls retain their existing permissions. The public stationary-state and shutdown reliability fixes are separate PRs #45 and #44 and must be reviewed together before release.

## Passenger automation intentionally deferred

Unlike upstream 0.6.0, this proposal disables automatic passenger Exit and return. The owner's tested iDrive 7 car did not publish usable occupancy on the existing SeatInformation source; its fallback can therefore act from door/car state without positive passenger occupancy. A different candidate source has promising local observations but no validated cross-vehicle decoder. Keeping that fallback while presenting independent driver-only settings would imply protection we cannot establish. This is an intentional behavior change requiring maintainer review, not a claim that upstream occupancy fails on every car.

Passenger hold controls, app memories, Save, manual Exit and Make room remain available. Settings says passenger automation is coming soon. No passenger automation or new occupancy subscription/decoder is introduced here.

## Validation and limits

Run `node tools/iteriodev-comfort/test-driver-access.js`, `node tools/iteriodev-comfort/test-independent-modes.js`, and `node apps/iteriodev_seats/source/test-settings-ui.js`. These use fake transport, filesystem, timers and movement dependencies; they never start hmictl or contact a vehicle. Existing UDS, ambient and module self-checks also apply.

Owner observations on one 2021 G22/iDrive 7 support the larger 0.6.4 reliability build and 0.6.5 Fixed Drive plus relative Exit at all three distance levels. The generic calibration gate and this isolated public extraction have not been installed or car-tested. All four Drive/Exit combinations are simulated, not all hardware-validated. Electric steering-column hardware, other cars, iDrive 8 and differing signal availability require testing. Remote start did not reach condition 10 in that owner's observed runs; this is not a universal remote-start discriminator.

Keep release deployment gated on stationary acceptance, manual stop/physical-control checks, known recovery and the dependency reviews above. No installer or installed build is changed by preparing this PR.

### Known upstream real-time test limitation

The inherited `seat.js --test` passed on Node 8.9.4 but failed one wall-clock precision assertion on Node 8.16.2 during this extraction: outward residual -11.85 counts against TOL 8, return residual -4.35. The self-test block and movement algorithm are unchanged; the deterministic virtual-gateway matrix gives identical upstream/candidate writes, results and residuals for RTT 80/300 ms with four jitter settings. This does not make the real-time failure a pass or establish car precision. Preserve it as a known limitation for maintainer review rather than changing the motor algorithm inside this feature PR.

Integration with PR44/45 is not an automatic clean merge. A disposable combined snapshot was manually resolved and exercised locally. A release must explicitly retain both shutdown cleanup and the standing guard while preserving the permission callback; do not resolve their overlapping service/queue hunks by choosing one file wholesale.
