/**
 * test-pinned.js — resident (pinned) model registry + shared model resolution.
 *
 * Imports the modules directly; does NOT start the HTTP server and does NOT
 * spawn llama-server, so it is safe to run against a live wrapper.
 *
 * Run: node tests/test-pinned.js
 */

import { pinnedModelKeys, isPinned, resolveLoadableModel } from '../src/models.js';
// Importing process.js proves the module graph still loads — it builds the port
// pool at import time from maxPerCategory + the pinned set. Nothing spawns here.
import '../src/process.js';

let failures = 0;

function check(name, condition, detail) {
    if (condition) {
        console.log(`  ok   ${name}`);
    } else {
        failures++;
        console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

console.log('pinned registry');

const keys = pinnedModelKeys();
check('pinnedModelKeys() returns an array', Array.isArray(keys), typeof keys);
check('at least one resident model is declared', keys.length > 0, 'no "pinned": true entry in models.json');
check('isPinned() agrees for every declared key', keys.every(k => isPinned(k)));
check('isPinned() is case-insensitive', keys.every(k => isPinned(k.toLowerCase())));
check('isPinned() is false for an unknown key', isPinned('nobody/this-model') === false);
check('isPinned() tolerates non-string input', isPinned(undefined) === false);

// NOTE: preloadPinnedModels() is deliberately NOT called here — it spawns real
// llama-server processes. That path is covered by wrapper startup.

console.log('pinned specs resolve');

for (const key of keys) {
    const pinnedSpec = await resolveLoadableModel(key);
    check(`${key} → .gguf`, typeof pinnedSpec.ggufPath === 'string' && pinnedSpec.ggufPath.endsWith('.gguf'), pinnedSpec.ggufPath);
    check(`${key} → instanceKey is the canonical key`, pinnedSpec.instanceKey.toLowerCase() === key.toLowerCase(), pinnedSpec.instanceKey);
    check(`${key} → reasoning mode is a valid value`, [null, 'on', 'off', 'auto'].includes(pinnedSpec.modelConfig.reasoning), String(pinnedSpec.modelConfig.reasoning));
}

console.log('shared resolution (models.json overrides still applied)');

const SPEC_KEY = 'HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced';
const spec = await resolveLoadableModel(SPEC_KEY);
check('instanceKey is the canonical model key', spec.instanceKey === SPEC_KEY, spec.instanceKey);
check('ggufPath resolved', typeof spec.ggufPath === 'string' && spec.ggufPath.endsWith('.gguf'), spec.ggufPath);
check('ctxSize override applied (262144)', spec.modelConfig.ctxSize === 262144, String(spec.modelConfig.ctxSize));
check('jinja flag applied', spec.modelConfig.jinja === true);
check('mmproj auto-detected', typeof spec.modelConfig.mmprojPath === 'string', String(spec.modelConfig.mmprojPath));
check('MTP draft auto-detected', typeof spec.modelConfig.mtpPath === 'string', String(spec.modelConfig.mtpPath));

const threw = await resolveLoadableModel('nope/nope').then(() => false, () => true);
check('unknown model throws', threw);

console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
