# Reviewable Seats settings sources

`src/main.js` and `renderer/settings.json` overlay the existing upstream source package; unchanged runtime/assets remain in that package and keep their original notices. The main seat-control screen is identical to upstream. The settings screen adds independent driver Drive/Exit modes and distance controls, with passenger automation deferred. See [driver behavior](../../../tools/iteriodev-comfort/DRIVER_MODES.md).

Rebuild with `python apps/iteriodev_seats/source/build-source.py`, or add `--check` to compare the committed archive without writing. The builder reads the pinned original package from local Git history; it makes no network requests. An unchanged local archive may instead be supplied with `--base-package PATH`. No firmware-derived SDK, newly copied library or runtime dependency is added.

Run `node apps/iteriodev_seats/source/test-settings-ui.js` for fake-socket settings and confirmation checks. Rendering/controller/touch QA is separate from real head-unit validation.
