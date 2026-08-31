// Verifies the built bundles load in Node as both ESM and CommonJS and expose the same public API.
// Run as the last step of `npm run build`; a CommonJS-only dependency imported by name would fail here.
// Loads via package self-reference so the package.json `exports` map itself is what gets validated,
// not hardcoded bundle paths.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const esm = await import('smartcube-web-bluetooth');
const cjs = require('smartcube-web-bluetooth');

// The complete public runtime API. A symbol missing from BOTH bundles is caught here;
// a symbol missing from one of them is caught by the set comparison below.
const mustExport = [
    'GanTimerState',
    'connectGanCube',
    'connectGanTimer',
    'connectSmartCube',
    'cubeTimestampCalcSkew',
    'cubeTimestampLinearFit',
    'getCachedMacForDevice',
    'getRegisteredProtocols',
    'makeTime',
    'makeTimeFromTimestamp',
    'now',
    'registerProtocol',
    'removeCachedMacForDevice',
    'toKociembaFacelets',
    'unregisterProtocol',
];

const bundles = [
    { label: 'esm (import "smartcube-web-bluetooth")', module: esm, ignored: [] },
    // `default` is compared like any other export; only CJS interop metadata is ignored.
    { label: 'cjs (require "smartcube-web-bluetooth")', module: cjs, ignored: ['__esModule'] },
];

for (const { label, module, ignored } of bundles) {
    for (const name of mustExport) {
        if (typeof module[name] === 'undefined') {
            throw new Error(`${label}: missing export ${name}`);
        }
    }
    const unexpected = Object.keys(module).filter((k) => !ignored.includes(k) && !mustExport.includes(k));
    if (unexpected.length > 0) {
        throw new Error(
            `${label}: unexpected exports not in the manifest (add them to scripts/check-dist.mjs deliberately): ${unexpected.join(', ')}`,
        );
    }
}

const keySets = bundles.map(({ module, ignored }) =>
    Object.keys(module).filter((k) => !ignored.includes(k)).sort().join(','),
);
if (keySets[0] !== keySets[1]) {
    throw new Error(`export mismatch between bundles\n  esm: ${keySets[0]}\n  cjs: ${keySets[1]}`);
}

console.log(`dist OK: ${mustExport.length} exports available from both dist/esm and dist/cjs`);
