/**
 * config.js — Load config.json, validate required fields, define defaults.
 *
 * Fail-fast: missing required fields crash at startup with the specific field name.
 * No || or ?? fallbacks for required values. Optional values get explicit defaults.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const configFile = path.join(projectRoot, 'config.json');

// --- Load and validate config.json exists ---
if (!fs.existsSync(configFile)) {
    throw new Error(`config.js: config.json not found at ${configFile}`);
}

let cfg;
try {
    cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
} catch (err) {
    throw new Error(`config.js: Failed to parse config.json: ${err.message}`);
}

// --- Required fields — missing any is a fatal startup error ---
const required = ['host', 'port', 'serverPort', 'maxPerCategory', 'llamaServerPath', 'modelsDir'];
for (const field of required) {
    if (cfg[field] === undefined || cfg[field] === null) {
        throw new Error(`config.js: Required field "${field}" missing from config.json`);
    }
}

// --- Export resolved config ---
export default {
    // Network
    host: cfg.host,
    port: cfg.port,
    serverPort: cfg.serverPort,
    maxPerCategory: cfg.maxPerCategory,

    // Binary + models
    llamaServerPath: path.resolve(projectRoot, cfg.llamaServerPath),
    modelsDir: cfg.modelsDir,

    // Defaults (overridable per-model via models.json)
    defaultCtxSize: cfg.defaultCtxSize ?? 8192,
    defaultGpuLayers: cfg.defaultGpuLayers ?? 99,
    defaultThreads: cfg.defaultThreads ?? 8,
    flashAttention: cfg.flashAttention ?? true,

    defaultParallelSlots: cfg.defaultParallelSlots ?? 1,
    defaultBatchSize: cfg.defaultBatchSize ?? 2048,
    defaultUbatchSize: cfg.defaultUbatchSize ?? 512,

    // Timeouts
    firstByteTimeoutMs: cfg.firstByteTimeoutMs ?? 60000,
    drainTimeoutMs: cfg.drainTimeoutMs ?? 30000,
    modelScanTtlMs: cfg.modelScanTtlMs ?? 60000,

    // Total request timeout � kills stuck slots even after first byte arrives
    requestTimeoutMs: cfg.requestTimeoutMs ?? 120000,

    // Paths
    projectRoot,
};
