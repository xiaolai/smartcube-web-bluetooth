# Contributing

## Setup

```bash
npm ci
npm test              # vitest
npx tsc --noEmit      # type-check (includes tests)
npm run lint          # eslint
npm run build         # rollup bundles + type declarations + Node ESM/CJS load check
npm run test:coverage
```

CI runs all of the above on every push and pull request (Node 22 and 24) plus
`npm audit --audit-level=high`.

## The verification gates

The decoded behaviour of every supported cube is pinned by **full-field snapshots**
(`src/smartcube/__snapshots__/fixture-events/`): every event a captured session decodes to, in
order, with all fields, plus the state snapshot. The working rule for changes:

- A **behaviour-preserving** change (refactor, performance) must leave every snapshot
  byte-identical. Don't regenerate them to make a refactor pass — that deletes the evidence.
- A **behaviour-changing** fix regenerates with `vitest -u`, and the snapshot diff must show
  exactly the fields the fix claims to change, nothing else. Audit the diff before committing.

For bug fixes, write the failing test first and keep its failure output in the PR description.

## Test layout

- `src/test/unit/*.unit.test.ts` — unit tests for helpers and attachment modules.
- `src/smartcube/protocols/*.replay.test.ts` — fixture replays per driver.
- `src/smartcube/*.test.ts` — connect-level and snapshot tests.
- Recording new fixtures: see `docs/FIXTURES.md`. Gen3 and gen1 have synthetic tests instead
  of captures; prefer a real capture when you have the hardware.

## Adding a driver

1. Implement `SmartCubeProtocol` (`src/smartcube/protocol.ts`): `nameFilters`,
   `optionalServices`, `gattAffinity` (score the GATT profile; 0 when it isn't yours),
   `needsMac` if you derive keys from the address, and `connect`.
2. Derive `matchesDevice` with `deviceNameMatchesFilters(yourFilters)`.
3. Extend `GattSmartCubeConnection` (`src/smartcube/gatt-connection.ts`): it owns the
   `SmartCubeEventBus` (`this.bus.emit()` for events, `bus.emitBattery()` for battery with
   dedupe, `bus.setCapabilities()` for lazy capability detection), exposes `events$`, `state$`
   and `getSnapshot()`, and runs one teardown order for remote and explicit disconnects. You
   implement `releaseResources()` (drop your listeners/refs), `notifyingCharacteristics()`
   (what `disconnect()` must stop), `sendCommand()`, and an `init()` built on `initialize()`.
   Put your UUIDs in `src/smartcube/gatt-uuids.ts`.
4. Resolve the MAC (if needed) with `resolveCubeMac` (`src/smartcube/attachment/resolve-mac.ts`).
5. Register with `registerProtocol()` via a side-effect import in `src/smartcube/index.ts`.
6. Record a fixture, add it to `FIXTURES` and the snapshot cases, and add a replay test.

## Style

ESLint enforces the essentials (`no-floating-promises`, `eqeqeq`, `no-var`, `prefer-const`).
There is no auto-formatter; match the surrounding code (4-space indent in `src/`, 2-space in
tests). Keep commits atomic — one logical change each, green on the full gate.
