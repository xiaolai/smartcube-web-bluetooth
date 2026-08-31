# Captured sessions

Recordings of real cube sessions used by the replay tests and the full-field snapshots
(`docs/FIXTURES.md` describes the format and how to record one with `tools/fixture-recorder.js`).

These were recorded from the maintainers' own cubes. They deliberately include each cube's
Bluetooth MAC address — the encrypted protocols derive their AES keys from it, so replaying
the traffic requires it. `device.id` (the origin-scoped browser identifier) is blanked.

The 2026-04-14 `WCU_MY32_A388` capture predates the current MoYu32 init sequence and no longer
replays; it is kept for reference and excluded from the replayable set.
