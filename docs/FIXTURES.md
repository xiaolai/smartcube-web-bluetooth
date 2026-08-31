# Capture fixtures

`captures/*.json` are recordings of real cube sessions. Tests replay them through a mock
`navigator.bluetooth` (`src/test/bluetooth-mock/`): reads and writes must match the recording
byte-for-byte, notifications are re-delivered in order, and the decoded output is pinned by
the full-field snapshots in `src/smartcube/__snapshots__/fixture-events/`.

## Format (`smartcube-fixture`, version 1)

```jsonc
{
  "format": "smartcube-fixture",
  "version": 1,
  "capturedAt": "2026-04-14T11:40:51.360Z",
  "device": { "name": "GAN12ui--B3C", "id": "", "mac": "E4:E0:99:D4:EB:3C" },
  "protocol": { "id": "gan-gen2", "name": "GAN Gen2" },
  "services": [],
  "traffic": [
    { "t": 7280, "op": "discover-service", "service": "..." },
    { "t": 7289, "op": "discover-char", "service": "...", "characteristic": "..." },
    { "t": 7370, "op": "write",  "service": "...", "characteristic": "...", "data": "B86320..." },
    { "t": 7400, "op": "notify", "service": "...", "characteristic": "...", "data": "0A6698..." },
    { "t": 7401, "op": "marker", "service": "marker", "data": "connected" }
  ],
  "events": [ { "t": 7420, "event": { "type": "FACELETS", "facelets": "UUU..." } } ]
}
```

- `data` is uppercase hex without a prefix. `t` is milliseconds from recording start.
- `device.mac` is required for encrypted protocols (GAN gen2-4, MoYu WCU, QiYi) — the replayed
  writes only match when the same key is derived. `device.id` should be blanked (it is an
  origin-scoped browser identifier).
- `events` is the expected decoded output; replay tests compare against it.

## Recording a new fixture

1. Load `tools/fixture-recorder.js` in your app **before** connecting (paste it into the
   DevTools console, or import it in a dev build). It patches the Web Bluetooth prototypes to
   record discovery, reads, writes and notifications while the library runs normally.
2. Connect the cube through the library, perform a short scripted session (a known scramble
   such as two sexy-moves works well: decoded moves are easy to eyeball), request battery and
   hardware, then disconnect.
3. In the console:
   ```js
   __fixtureRecorder.download('fixture_<name>_<protocol>.json', {
     name: '<advertised name>', id: '', mac: '<cube MAC or omit>',
   }, { id: '<protocol id>', name: '<protocol name>' });
   ```
4. Copy the file into `captures/`, add it to `FIXTURES` in `src/test/fixtures/load-fixture.ts`
   and to the cases in `src/smartcube/fixture-events.snap.test.ts`, run
   `npx vitest run src/smartcube/fixture-events.snap.test.ts -u`, and review the generated
   snapshot: the decoded moves and facelets must match what you actually did.

The recorder is a manual tool; it is not exercised by CI. The validation that matters is step
4 — a fixture that replays green with a sensible snapshot is correct by construction.

Note: fixtures necessarily contain the recorded cube's Bluetooth MAC (the key depends on it)
and are published in this repository. That is the cube's address, not yours, but record with
your own devices.
