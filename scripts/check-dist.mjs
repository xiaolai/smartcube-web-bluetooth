// Verifies the built bundles load in Node as both ESM and CommonJS and expose the same public API.
// Run as the last step of `npm run build`; a CommonJS-only dependency imported by name would fail here.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const esm = await import(new URL('../dist/esm/index.mjs', import.meta.url).href);
const cjs = require('../dist/cjs/index.cjs');

const mustExport = ['connectSmartCube', 'connectGanCube', 'connectGanTimer', 'registerProtocol'];
for (const name of mustExport) {
    if (typeof esm[name] !== 'function') throw new Error(`dist/esm/index.mjs: missing export ${name}`);
    if (typeof cjs[name] !== 'function') throw new Error(`dist/cjs/index.cjs: missing export ${name}`);
}

const esmKeys = Object.keys(esm).filter((k) => k !== 'default').sort();
const cjsKeys = Object.keys(cjs).filter((k) => k !== '__esModule' && k !== 'default').sort();
if (esmKeys.join(',') !== cjsKeys.join(',')) {
    throw new Error(`export mismatch between bundles\n  esm: ${esmKeys.join(', ')}\n  cjs: ${cjsKeys.join(', ')}`);
}

console.log(`dist OK: ${esmKeys.length} exports available from both dist/esm and dist/cjs`);
