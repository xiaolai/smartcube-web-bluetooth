# Architecture

## Module map

```
src/
  index.ts                  public entry: legacy GAN APIs + generic Smart Cube API
  smartcube/
    connect.ts              connectSmartCube(): picker -> advertisements -> GATT -> driver -> verify
    protocol.ts             SmartCubeProtocol interface + registry (drivers self-register on import)
    types.ts                public event/command/snapshot types
    event-bus.ts            per-connection bus: live events$ + revisioned state snapshot
    cubie-cube.ts           cube math (corner/edge arrays <-> facelet strings, move tables)
    protocols/              one driver per brand (gan, giiker, gocube, moyu-mhc, moyu32, qiyi)
    attachment/             connect-time helpers: advertisements, MAC resolution, GATT snapshot,
                            packet sanity checks, per-brand wire codecs
  gan-*.ts                  GAN specifics: bit reader, per-generation drivers, encrypters,
                            generation selection, gen1 (356i v1), legacy connectGanCube/Timer
```

## Connect pipeline (`connectSmartCube`)

1. **Picker** — `buildRequestDeviceOptions` merges every registered protocol's name filters,
   manufacturer-data company IDs and optional services into one `requestDevice` call.
2. **Advertisements** — if any name-matching protocol declares `needsMac`, wait briefly for
   advertisement manufacturer data (`waitForManufacturerData` merges frames: the first
   advertisement often carries none). Skipped entirely for MAC-less brands.
3. **GATT snapshot** — connect (bounded, retried, abortable) and collect the primary service
   UUIDs, normalised to 128-bit uppercase.
4. **Driver selection** — `resolveProtocolByGatt`: each protocol scores the service set
   (`gattAffinity`); name match breaks ties; name-only fallback when no service matches.
5. **Driver connect** — brand-specific init. Drivers that need the cube's MAC resolve it
   through the shared ladder (`attachment/resolve-mac.ts`): advertisement context -> cached
   MAC -> provider -> fresh advertisements -> name-derived candidates (optionally probed
   cryptographically) -> provider fallback.
6. **Verification** — for MAC-bearing drivers, wait for decrypted traffic that decodes to a
   *legal* cube state before caching the MAC in localStorage (`isMacCacheProofEvent`). A wrong
   key is detected here instead of being persisted.

Every stage honours `ConnectSmartCubeOptions.signal` and reports progress via `onStatus`.

## Events and state

`events$` is deliberately **live-only** (a `Subject`): replaying state into it would change the
meaning of `take(1)`/`firstValueFrom` and event counting for consumers. State that a late
subscriber would otherwise miss — the initial FACELETS/BATTERY/HARDWARE emitted during driver
init — lives in the per-connection `SmartCubeEventBus` snapshot instead, exposed as `state$`
(current snapshot replayed once per subscriber, then changes) and `getSnapshot()` (frozen,
revisioned). The bus updates the snapshot synchronously *before* forwarding each event, owns
the battery dedupe policy, and keeps `capabilities`/`hardware.gyroSupported` consistent when
gyro support is detected lazily.

## GAN specifics

- **Generations**: gen1 (356i v1: `fff0` + Device Information, key derived from firmware +
  hardware bytes, polled); gen2/3/4 (notification-driven, AES-128 salted with the reversed MAC,
  selected by primary service in `gan-driver-select.ts` — shared by the legacy `connectGanCube`
  and the SmartCube driver). MoYu AI 2023 speaks gen2 with its own key.
- **Packet validators** (`gan-gen234-packet-validate.ts`) drop wrong-key decrypts before they
  reach a driver.
- **Move recovery**: gen3/4 share `GanMoveHistoryBuffer` — a FIFO with circular-serial gap
  detection that requests move history and injects recovered moves in order. Notifications are
  processed strictly in arrival order (a per-connection promise chain), because a history
  request awaits a GATT write mid-decode.
- **Init capture**: the legacy connections emit their initial state while `create()` is still
  running; `connectGanDevice` owns the event subject, buffers those emissions and replays them
  into the bus so they reach the snapshot.

## Testing strategy

- **Captured fixtures** (`captures/*.json`) replay real BLE sessions through a mock
  `navigator.bluetooth`; the replayer asserts every write byte-for-byte against the recording.
- **Full-field snapshots** (`src/smartcube/__snapshots__/fixture-events/`) pin every decoded
  event and the state snapshot per fixture. The working rule: a behaviour-preserving change
  leaves them byte-identical; a behaviour-changing fix must change exactly the fields it
  claims to.
- Gen3 has no capture; a synthetic characterisation test pins its decode behaviour, including
  the history-request bytes. GAN gen1 is covered by a synthetic encrypted-GATT test.
