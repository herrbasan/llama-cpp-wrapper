/**
 * process.js — llama-server process lifecycle manager.
 *
 * Core design:
 *   Map<modelKey, Instance> tracks running processes.
 *   ensureModel() → single-flight spawn with health polling.
 *   In-flight tracking per instance → drain before kill/evict/swap.
 *   Stderr ring buffer → crash diagnostics on failed startup.
 *   Windows-accurate shutdown: child.kill → exit wait → taskkill /T /F.
 *
 * No state.json. No detach mode. Manager quits → all processes die.
 */

import { spawn, spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import config from './config.js';
import { createLogger } from './modules/nLogger/src/logger.js';

const log = createLogger();

// --- Instance registry ---
// Map<modelKey, Instance>
const instances = new Map();

const STDERR_RING_SIZE = 100;

// --- Port pool (fixed range, freed on kill) ---
const portPool = [];
const maxPorts = (config.maxPerCategory.chat + config.maxPerCategory.embedding) || 4;
for (let p = config.serverPort; p < config.serverPort + maxPorts; p++) {
    portPool.push(p);
}

function allocatePort() {
    const port = portPool.shift();
    if (!port) throw new Error('Port pool exhausted — too many concurrent instances');
    return port;
}

function freePort(port) {
    if (!portPool.includes(port)) {
        portPool.push(port);
    }
}

// --- Decision mutex ---
// Serializes the check → evict → spawn-dispatch section of ensureModel.
// Prevents two concurrent requests from both passing the limit checks.
let decisionChain = Promise.resolve();

function withDecisionLock(fn) {
    const result = decisionChain.then(fn, fn);
    decisionChain = result.then(() => undefined, () => undefined);
    return result;
}

// --- Health check helper ---
function fetchHealth(port) {
    const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    return new Promise((resolve) => {
        const req = http.get(`http://${host}:${port}/health`, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    resolve({ ok: res.statusCode === 200, data: JSON.parse(body) });
                } catch {
                    resolve({ ok: res.statusCode === 200, data: null });
                }
            });
        });
        req.on('error', () => resolve({ ok: false, data: null }));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve({ ok: false, data: null });
        });
    });
}

// --- Build llama-server CLI args from resolved config ---

function buildArgs(ggufPath, options, port) {
    const args = [
        '-m', ggufPath,
        '--host', config.host,
        '--port', port.toString(),
        '-c', options.ctxSize.toString(),
        '-ngl', options.gpuLayers.toString(),
        '--parallel', options.parallelSlots.toString(),
        '-t', options.threads.toString(),
    ];

    // Flash attention
    if (options.flashAttention === true) {
        args.push('--flash-attn', 'on');
    } else {
        args.push('--flash-attn', 'off');
    }

    // Batch sizes
    args.push('--batch-size', options.batchSize.toString());
    args.push('--ubatch-size', options.ubatchSize.toString());

    // Embedding-specific
    if (options.embedding) {
        args.push('--embedding');
        if (options.pooling) {
            args.push('--pooling', options.pooling);
        }
    }

    // Vision projector
    if (options.mmprojPath) {
        args.push('--mmproj', options.mmprojPath);
    }

    // Memory lock
    if (options.mlock) {
        args.push('--mlock');
    }

    // Chat template override (for models with outdated embedded templates)
    if (options.chatTemplateFile) {
        args.push('--jinja', '--chat-template-file', options.chatTemplateFile);
    }

    return args;
}

// --- Config comparison (for restart-on-mismatch) ---

function configsMatch(a, b) {
    return a.ctxSize === b.ctxSize &&
        a.gpuLayers === b.gpuLayers &&
        a.threads === b.threads &&
        a.flashAttention === b.flashAttention &&
        a.parallelSlots === b.parallelSlots &&
        a.batchSize === b.batchSize &&
        a.ubatchSize === b.ubatchSize &&
        a.embedding === b.embedding &&
        a.pooling === b.pooling &&
        a.mlock === b.mlock &&
        a.mmprojPath === b.mmprojPath &&
        a.chatTemplateFile === b.chatTemplateFile;
}

// --- Category helper ---

function getCategory(modelConfig) {
    return modelConfig.embedding ? 'embedding' : 'chat';
}

function countByCategory(category) {
    let count = 0;
    for (const inst of instances.values()) {
        if (inst.state === 'running' || inst.state === 'starting') {
            if (getCategory(inst.config) === category) count++;
        }
    }
    return count;
}

// --- Single-flight model loading ---
//
// ensureModel returns a promise. The decision section (check → evict → spawn-dispatch)
// is serialized through a promise-chain mutex to prevent races.
//
// States: 'starting' | 'running' | 'draining' | 'error'
// 'draining' = marked for death, never hand out to new requests.

export async function ensureModel(modelKey, ggufPath, modelConfig) {
    return withDecisionLock(() => ensureModelInner(modelKey, ggufPath, modelConfig));
}

async function ensureModelInner(modelKey, ggufPath, modelConfig) {
    const existing = instances.get(modelKey);
    const category = getCategory(modelConfig);

    // Already running with matching config → reuse
    if (existing && existing.state === 'running') {
        if (configsMatch(existing.config, modelConfig)) {
            return existing;
        }
        // Config mismatch → drain, kill, respawn
        log.info(`Config mismatch for ${modelKey}, restarting...`);
        existing.state = 'draining';
        await killInstance(modelKey);
    }

    // Already loading → await the same promise (single-flight)
    if (existing && existing.state === 'starting' && existing.readyPromise) {
        if (configsMatch(existing.config, modelConfig)) {
            return existing.readyPromise;
        }
        // Config mismatch during load → kill and respawn
        log.info(`Config mismatch during load for ${modelKey}, restarting...`);
        existing.state = 'draining';
        await killInstance(modelKey);
    }

    // If this exact model is draining, wait for it to die before respawning
    if (existing && existing.state === 'draining') {
        const drainDeadline = Date.now() + config.drainTimeoutMs + 10000;
        while (instances.has(modelKey) && Date.now() < drainDeadline) {
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // Category-based limit check
    const categoryLimit = config.maxPerCategory[category];
    const categoryCount = countByCategory(category);

    if (categoryCount >= categoryLimit) {
        // Find the LRU instance of the same category to evict
        const candidates = [...instances.values()]
            .filter(i => getCategory(i.config) === category &&
                         (i.state === 'running' || i.state === 'starting') &&
                         i.modelKey !== modelKey)
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

        if (candidates.length === 0) {
            throw new Error(`Category "${category}" limit reached (${categoryLimit}) and no evictable instance. Retry later.`);
        }

        const victim = candidates[0];
        log.info(`Category "${category}" limit reached, evicting: ${victim.modelKey}`);
        victim.state = 'draining';
        await killInstance(victim.modelKey);
    }

    // Spawn new instance
    return spawnInstance(modelKey, ggufPath, modelConfig);
}

// --- Spawn a new llama-server instance ---

function spawnInstance(modelKey, ggufPath, modelConfig) {
    const port = allocatePort();
    const args = buildArgs(ggufPath, modelConfig, port);
    const category = getCategory(modelConfig);
    const fileSizeGB = (fs.statSync(ggufPath).size / 1024 / 1024 / 1024).toFixed(2);

    log.info(`Spawning llama-server: ${path.basename(ggufPath)} on port ${port} [${category}]`);
    log.info(`Category: ${category} | ctxSize: ${modelConfig.ctxSize} | weights: ${fileSizeGB} GB`);
    log.info(`Args: ${args.join(' ')}`);

    const instance = {
        modelKey,
        ggufPath,
        port,
        state: 'starting',     // 'starting' | 'running' | 'draining' | 'error'
        config: modelConfig,
        process: null,
        pid: null,
        inFlight: 0,           // active proxied requests
        lastUsedAt: Date.now(),
        stderrRing: [],        // last N stderr lines for crash diagnostics
        readyPromise: null,    // resolves to instance when healthy, rejects on failure
        readyResolve: null,
        readyReject: null,
    };

    const child = spawn(config.llamaServerPath, args, {
        cwd: path.dirname(config.llamaServerPath),
        detached: false,
        windowsHide: true,
    });

    instance.process = child;
    instance.pid = child.pid;

    // Capture stdout/stderr into ring buffer
    child.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
            if (line) log.info(`[llama:${port}] ${line}`);
        }
    });

    child.stderr.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
            if (!line) continue;
            log.info(`[llama:${port}] ${line}`);
            instance.stderrRing.push(line);
            if (instance.stderrRing.length > STDERR_RING_SIZE) {
                instance.stderrRing.shift();
            }
        }
    });

    // Handle spawn error
    child.on('error', (err) => {
        log.error(`Failed to start llama-server (${port}): ${err.message}`);
        instance.state = 'error';
        if (instance.readyReject) {
            instance.readyReject(new Error(`Failed to spawn llama-server: ${err.message}`));
        }
        freePort(port);
    });

    // Handle exit (unexpected or during startup)
    child.on('exit', (code, signal) => {
        log.info(`llama-server exited (${port}): code=${code}, signal=${signal}`);
        // Reject the single-flight readyPromise whenever the child dies before
        // becoming healthy — 'starting' (crash) OR 'draining' (killed mid-load
        // by config mismatch / category eviction). If we skip 'draining', every
        // request awaiting the load hangs forever on a promise that never
        // settles (the kill path sets state='draining' before rawKill).
        if (instance.state === 'starting' || instance.state === 'draining') {
            instance.state = 'error';
            const stderrTail = instance.stderrRing.slice(-20).join('\n');
            if (instance.readyReject) {
                instance.readyReject(
                    new Error(`llama-server exited during startup (code=${code}). Stderr tail:\n${stderrTail}`)
                );
            }
        }
        instances.delete(modelKey);
        freePort(port);
    });

    instances.set(modelKey, instance);

    // Health poll until running or timeout
    instance.readyPromise = new Promise((resolve, reject) => {
        instance.readyResolve = resolve;
        instance.readyReject = reject;
        pollUntilHealthy(instance).then(resolve, reject);
    });

    return instance.readyPromise;
}

// --- Health polling ---
// Polls /health every 1s. Resolves when status is "ok".
// Rejects on: child exit during startup, or 120s timeout.

async function pollUntilHealthy(instance) {
    const maxWait = 120_000;
    const pollMs = 1000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
        // Check if child died
        if (instance.state === 'error') {
            const stderrTail = instance.stderrRing.slice(-20).join('\n');
            throw new Error(`llama-server crashed during startup. Stderr tail:\n${stderrTail}`);
        }

        const health = await fetchHealth(instance.port);
        if (health.ok && health.data?.status === 'ok') {
            instance.state = 'running';
            log.info(`llama-server healthy on port ${instance.port}: ${path.basename(instance.ggufPath)}`);
            return instance;
        }

        await new Promise(r => setTimeout(r, pollMs));
    }

    // Timeout — kill the child and fail
    instance.state = 'error';
    const stderrTail = instance.stderrRing.slice(-20).join('\n');
    await rawKill(instance);
    instances.delete(instance.modelKey);
    freePort(instance.port);
    throw new Error(`llama-server did not become healthy within ${maxWait / 1000}s. Stderr tail:\n${stderrTail}`);
}

// --- Raw kill: child.kill → wait exit → taskkill /T /F fallback ---

async function rawKill(instance) {
    if (!instance.process || instance.state === 'dead') return;

    const pid = instance.pid;
    if (!pid) return;

    // Step 1: SIGINT (graceful)
    try {
        instance.process.kill('SIGINT');
    } catch {
        // Process may already be dead
    }

    // Step 2: Wait up to 5s for exit
    const exited = await waitForExit(instance.process, 5000);
    if (exited) {
        instance.state = 'dead';
        return;
    }

    // Step 3: taskkill /PID /T /F (tree kill — Windows-accurate)
    log.warn(`Process ${pid} did not exit after SIGINT, using taskkill /T /F`);
    try {
        spawnSync('taskkill', ['/PID', pid.toString(), '/T', '/F'], { windowsHide: true });
    } catch (err) {
        log.error(`taskkill failed for PID ${pid}: ${err.message}`);
    }

    instance.state = 'dead';
}

function waitForExit(child, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

// --- Public kill: drain in-flight, then raw kill ---

export async function killInstance(modelKey) {
    const instance = instances.get(modelKey);
    if (!instance) return;

    // Mark as draining immediately — ensureModel must never hand this out
    instance.state = 'draining';

    // Drain in-flight requests (bounded by drainTimeoutMs)
    if (instance.inFlight > 0) {
        log.info(`Draining ${instance.inFlight} in-flight request(s) for ${modelKey} (timeout: ${config.drainTimeoutMs}ms)`);
        const drainStart = Date.now();
        while (instance.inFlight > 0 && (Date.now() - drainStart) < config.drainTimeoutMs) {
            await new Promise(r => setTimeout(r, 200));
        }
        if (instance.inFlight > 0) {
            log.warn(`Drain timeout for ${modelKey}, killing with ${instance.inFlight} request(s) still in-flight`);
        }
    }

    await rawKill(instance);
    instances.delete(modelKey);
    freePort(instance.port);
}

// --- Kill all instances (graceful shutdown) ---

export async function killAll() {
    const keys = [...instances.keys()];
    for (const key of keys) {
        await killInstance(key);
    }
}

// --- Synchronous last-resort kill on process.exit ---
// Node's 'exit' handler must be synchronous. Use spawnSync.

export function killAllSync() {
    for (const instance of instances.values()) {
        if (!instance.pid || instance.state === 'dead') continue;
        try {
            spawnSync('taskkill', ['/PID', instance.pid.toString(), '/T', '/F'], { windowsHide: true });
        } catch {
            // Best effort
        }
        instance.state = 'dead';
    }
}

// --- In-flight tracking ---

export function trackRequest(modelKey) {
    const instance = instances.get(modelKey);
    if (!instance) return;
    instance.inFlight++;
    instance.lastUsedAt = Date.now();
}

export function untrackRequest(modelKey) {
    const instance = instances.get(modelKey);
    if (!instance) return;
    instance.inFlight = Math.max(0, instance.inFlight - 1);
}

// --- Getters ---

export function getInstance(modelKey) {
    return instances.get(modelKey) || null;
}

export function getAllInstances() {
    return [...instances.values()].map(i => ({
        modelKey: i.modelKey,
        port: i.port,
        pid: i.pid,
        state: i.state,
        inFlight: i.inFlight,
        category: getCategory(i.config),
        config: i.config,
    }));
}

// --- Startup orphan sweep ---
// Probe every port in the port pool. Kill orphans by PID (not by image name).

export async function sweepOrphans() {
    const orphans = [];
    for (const port of portPool) {
        const health = await fetchHealth(port);
        if (health.ok) {
            orphans.push(port);
        }
    }

    for (const port of orphans) {
        log.warn(`Orphan llama-server found on port ${port}, killing by PID...`);
        const pid = getPidByPort(port);
        if (pid) {
            try {
                spawnSync('taskkill', ['/PID', pid.toString(), '/T', '/F'], { windowsHide: true });
                log.info(`Killed orphan PID ${pid} on port ${port}`);
            } catch (err) {
                log.error(`Failed to kill orphan PID ${pid}: ${err.message}`);
            }
        } else {
            log.warn(`Could not determine PID for orphan on port ${port}`);
        }
    }

    return orphans.length;
}

// --- Resolve PID from port ownership (Windows) ---

function getPidByPort(port) {
    try {
        const out = execSync(
            `powershell -NoProfile -c "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`,
            { encoding: 'utf-8', timeout: 5000 }
        ).trim();
        const pid = parseInt(out, 10);
        return pid > 0 ? pid : null;
    } catch {
        return null;
    }
}
