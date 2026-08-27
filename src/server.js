/**
 * server.js — HTTP server, routing, raw proxy.
 *
 * Hot path contract:
 *   1. Buffer request body once (needed to read "model" field).
 *   2. Parse JSON only to extract "model". Forward original bytes unchanged.
 *   3. Response is a raw pipe — no parsing, no SSE reassembly.
 *   4. Client abort propagates upstream immediately.
 *   5. First-byte timeout catches hung llama-server. No total timeout on streams.
 *
 * Endpoints:
 *   POST /v1/chat/completions   — proxy to llama-server
 *   POST /v1/completions        — proxy to llama-server
 *   POST /v1/embeddings         — proxy to llama-server
 *   GET  /v1/models             — list discovered models
 *   GET  /health                — manager + instance health
 *   GET  /status                — running instances, ports, metrics
 *   POST /v1/models/:model/unload — explicit model unload
 */

import http from 'node:http';
import path from 'node:path';
import config from './config.js';
import { createLogger } from './modules/nLogger/src/logger.js';
import { resolveModel, discoverModels, getModelConfig } from './models.js';
import {
    ensureModel,
    killInstance,
    killAll,
    killAllSync,
    getInstance,
    getAllInstances,
    trackRequest,
    untrackRequest,
    sweepOrphans,
    startWatchdog,
} from './process.js';

const log = createLogger();

// --- Helpers ---

function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        const MAX_BODY = 100 * 1024 * 1024; // 100MB safety cap

        req.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_BODY) {
                reject(new Error(`Request body exceeds ${MAX_BODY} bytes`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function getBackendHost() {
    return config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
}

// --- Raw proxy ---
// Forwards the original request body bytes to llama-server, pipes response back.
// Client abort → destroy upstream. First-byte timeout → 504.

function proxyToInstance(req, res, bodyBuffer, instance) {
    return new Promise((resolve) => {
        const targetUrl = `http://${getBackendHost()}:${instance.port}${req.url}`;
        let completed = false;
        let firstByteReceived = false;

        const finish = () => {
            if (completed) return;
            completed = true;
            clearTimeout(totalTimer);
            clearTimeout(firstByteTimer);
            untrackRequest(instance.modelKey);
            resolve();
        };

        // Build forwarding headers — minimal, no transformation
        const headers = {
            'Content-Type': req.headers['content-type'] || 'application/json',
            'Content-Length': bodyBuffer.length,
        };
        if (req.headers['authorization']) {
            headers['Authorization'] = req.headers['authorization'];
        }
        if (req.headers['accept']) {
            headers['Accept'] = req.headers['accept'];
        }

        // Total request timeout � catches stuck slots that produce first byte but never finish
        const totalTimer = setTimeout(() => {
            if (!completed) {
                log.warn(`Request total timeout (${config.requestTimeoutMs}ms) — destroying stuck slot`);
                proxyReq.destroy();
                if (!res.headersSent) {
                    sendJson(res, 504, {
                        error: 'Gateway Timeout',
                        details: `Request exceeded total timeout of ${config.requestTimeoutMs}ms`,
                    });
                }
                finish();
            }
        }, config.requestTimeoutMs);

        // First-byte timeout — catches hung llama-server
        const firstByteTimer = setTimeout(() => {
            if (!firstByteReceived && !completed) {
                proxyReq.destroy();
                if (!res.headersSent) {
                    sendJson(res, 504, {
                        error: 'Gateway Timeout',
                        details: `No response from llama-server within ${config.firstByteTimeoutMs}ms`,
                    });
                }
                finish();
            }
        }, config.firstByteTimeoutMs);

        const proxyReq = http.request(targetUrl, { method: req.method, headers }, (proxyRes) => {
            firstByteReceived = true;
            clearTimeout(firstByteTimer);

            // Strip hop-by-hop headers (RFC 7230) — Node de-chunks upstream,
            // re-declaring transfer-encoding causes framing issues
            const respHeaders = { ...proxyRes.headers };
            delete respHeaders['connection'];
            delete respHeaders['transfer-encoding'];
            delete respHeaders['keep-alive'];
            delete respHeaders['proxy-connection'];
            delete respHeaders['upgrade'];
            delete respHeaders['te'];
            delete respHeaders['trailer'];

            // Enable TCP_NODELAY on both legs for low-latency SSE
            req.socket.setNoDelay(true);
            res.socket.setNoDelay(true);

            res.writeHead(proxyRes.statusCode, respHeaders);

            proxyRes.on('data', (chunk) => {
                res.write(chunk);
            });

            proxyRes.on('end', () => {
                res.end();
                finish();
            });

            proxyRes.on('error', (err) => {
                log.error(`Proxy response error (${instance.port}): ${err.message}`);
                if (!res.headersSent) {
                    sendJson(res, 502, { error: 'Bad Gateway', details: err.message });
                } else {
                    res.end();
                }
                finish();
            });
        });

        // Request error (connection refused, etc.)
        proxyReq.on('error', (err) => {
            clearTimeout(firstByteTimer);
            log.error(`Proxy request error (${instance.port}): ${err.message}`);
            if (!completed) {
                if (!res.headersSent) {
                    sendJson(res, 502, { error: 'Bad Gateway', details: err.message });
                }
                finish();
            }
        });

        // Client abort → propagate upstream
        req.on('aborted', () => {
            clearTimeout(firstByteTimer);
            if (!completed) {
                log.info(`Client aborted request to ${instance.modelKey}, cancelling upstream`);
                proxyReq.destroy();
                finish();
            }
        });

        res.on('close', () => {
            clearTimeout(firstByteTimer);
            if (!completed) {
                proxyReq.destroy();
                finish();
            }
        });

        // Send the original body bytes (original buffer, byte-identical)
        proxyReq.end(bodyBuffer);
    });
}

// --- Inference handler ---
// Buffer body → extract model → resolve → ensureModel → proxy raw

async function handleInference(req, res) {
    // Buffer the request body once
    let bodyBuffer;
    try {
        bodyBuffer = await readBody(req);
    } catch (err) {
        return sendJson(res, 400, { error: 'Bad Request', details: err.message });
    }

    if (bodyBuffer.length === 0) {
        return sendJson(res, 400, { error: 'Bad Request', details: 'Empty request body' });
    }

    // Parse JSON only to extract the model field
    let parsed;
    try {
        parsed = JSON.parse(bodyBuffer);
    } catch {
        return sendJson(res, 400, { error: 'Bad Request', details: 'Invalid JSON in request body' });
    }

    const modelField = parsed.model;
    if (!modelField) {
        return sendJson(res, 400, {
            error: 'Bad Request',
            details: 'Missing "model" field in request body. Use GET /v1/models to list available models.',
        });
    }

    // Resolve model key → gguf path
    let resolved;
    try {
        resolved = await resolveModel(modelField);
    } catch (err) {
        return sendJson(res, 400, { error: 'Model Resolution Failed', details: err.message });
    }

    // Get effective config (defaults + models.json override)
    const modelConfig = await getModelConfig(resolved.modelKey || modelField);

    // Override mmprojPath from resolution if auto-detected
    if (resolved.mmprojPath && !modelConfig.mmprojPath) {
        modelConfig.mmprojPath = resolved.mmprojPath;
    }

    // Override mtpPath from resolution if auto-detected
    if (resolved.mtpPath && !modelConfig.mtpPath) {
        modelConfig.mtpPath = resolved.mtpPath;
    }

    // Resolve chatTemplateFile relative to project root
    if (modelConfig.chatTemplateFile) {
        modelConfig.chatTemplateFile = path.join(config.projectRoot, modelConfig.chatTemplateFile);
    }

    // Use resolved modelKey for instance tracking
    const instanceKey = resolved.modelKey || resolved.ggufPath;

    // Ensure model is loaded (single-flight)
    let instance;
    try {
        instance = await ensureModel(instanceKey, resolved.ggufPath, modelConfig);
    } catch (err) {
        log.error(`Failed to start model ${instanceKey}: ${err.message}`);
        return sendJson(res, 500, { error: 'Failed to start model', details: err.message });
    }

    // Track in-flight, proxy raw
    trackRequest(instanceKey);
    return proxyToInstance(req, res, bodyBuffer, instance);
}

// --- Route handlers ---

async function handleModelsList(res) {
    const models = await discoverModels();
    const data = models.map(m => ({
        id: m.key,
        object: 'model',
        owned_by: m.key.split('/')[0] || 'unknown',
        quants: m.quants.map(q => q.quantTag).filter(Boolean),
    }));
    return sendJson(res, 200, { object: 'list', data });
}

async function handleHealth(res) {
    const insts = getAllInstances();
    const running = insts.filter(i => i.state === 'running');
    if (running.length === 0) {
        return sendJson(res, 200, { status: 'ok', models_loaded: 0 });
    }
    return sendJson(res, 200, {
        status: 'ok',
        models_loaded: running.length,
        instances: running.map(i => ({ model: i.modelKey, port: i.port, pid: i.pid })),
    });
}

async function handleStatus(res) {
    return sendJson(res, 200, {
        instances: getAllInstances(),
        config: {
            host: config.host,
            port: config.port,
            maxPerCategory: config.maxPerCategory,
            modelsDir: config.modelsDir,
            llamaServerPath: config.llamaServerPath,
        },
    });
}

async function handleUnload(req, res) {
    // Extract model key from URL: /v1/models/:model/unload
    // Model key may contain slashes (publisher/model)
    const match = req.url.match(/^\/v1\/models\/(.+)\/unload$/);
    if (!match) {
        return sendJson(res, 400, { error: 'Bad Request', details: 'Invalid unload URL format' });
    }

    const modelKey = decodeURIComponent(match[1]);
    const instance = getInstance(modelKey);
    if (!instance) {
        return sendJson(res, 404, { error: 'Not Found', details: `Model "${modelKey}" is not loaded` });
    }

    await killInstance(modelKey);
    return sendJson(res, 200, { message: `Model "${modelKey}" unloaded` });
}

// --- HTTP server ---

const server = http.createServer(async (req, res) => {
    const method = req.method;
    const url = req.url;

    try {
        // GET routes
        if (method === 'GET' && url === '/v1/models') {
            return await handleModelsList(res);
        }
        if (method === 'GET' && url === '/health') {
            return await handleHealth(res);
        }
        if (method === 'GET' && url === '/status') {
            return await handleStatus(res);
        }

        // POST routes
        if (method === 'POST' && url.match(/^\/v1\/models\/.+\/unload$/)) {
            return await handleUnload(req, res);
        }

        // Inference proxy routes
        if (method === 'POST' && (
            url === '/v1/chat/completions' ||
            url === '/v1/completions' ||
            url === '/v1/embeddings'
        )) {
            return await handleInference(req, res);
        }

        // Unknown route
        return sendJson(res, 404, { error: 'Not Found', details: `Unknown route: ${method} ${url}` });
    } catch (err) {
        log.error(`Unhandled error: ${method} ${url}: ${err.message}`);
        if (!res.headersSent) {
            return sendJson(res, 500, { error: 'Internal Server Error', details: err.message });
        }
    }
});

// --- Startup validation (fail-fast) ---

async function validateStartup() {
    const { existsSync } = await import('node:fs');

    // 1. llama-server binary exists
    if (!existsSync(config.llamaServerPath)) {
        throw new Error(`Startup check failed: llama-server binary not found at ${config.llamaServerPath}`);
    }

    // 2. llama-server --version executes successfully
    const { spawnSync } = await import('node:child_process');
    const versionResult = spawnSync(config.llamaServerPath, ['--version'], {
        windowsHide: true,
        timeout: 10000,
        encoding: 'utf-8',
    });
    if (versionResult.status !== 0) {
        throw new Error(`Startup check failed: llama-server --version exited with code ${versionResult.status}. stderr: ${versionResult.stderr?.slice(0, 500)}`);
    }

    // 3. modelsDir exists and contains at least 1 .gguf file
    try {
        await import('node:fs/promises').then(fs => fs.access(config.modelsDir));
    } catch {
        throw new Error(`Startup check failed: modelsDir does not exist: ${config.modelsDir}`);
    }

    // 4. Sweep orphans from previous crash
    const orphanCount = await sweepOrphans();
    if (orphanCount > 0) {
        log.warn(`Startup orphan sweep: cleaned ${orphanCount} orphaned process(es)`);
    }

    log.info('Startup validation passed');
    log.info(`llama-server: ${versionResult.stdout?.trim() || versionResult.stderr?.trim()}`);
}

// --- Start ---

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`FATAL: Port ${config.port} is already in use.`);
        process.exit(1);
    }
    console.error(`FATAL: Server error: ${err.message}`);
    process.exit(1);
});

server.listen(config.port, config.host, async () => {
    try {
        await validateStartup();
    } catch (err) {
        console.error(`FATAL: ${err.message}`);
        process.exit(1);
    }

    // Slot-health watchdog — recovers wedged embedding slots automatically.
    startWatchdog();

    const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
    log.info(`llama-cpp-wrapper listening on http://${displayHost}:${config.port}`);
    log.info(`Models dir: ${config.modelsDir}`);
    log.info(`Server binary: ${config.llamaServerPath}`);
    log.info(`Max per category: chat=${config.maxPerCategory.chat} embedding=${config.maxPerCategory.embedding}`);
});

// --- Graceful shutdown ---

let shuttingDown = false;

async function gracefulShutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(`Received ${signal}, shutting down...`);

    server.close(() => {
        log.info('HTTP server closed');
    });

    // Drain and kill all instances
    await killAll();
    log.info('All instances stopped');
    process.exit(exitCode);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Last-resort synchronous kill on exit
process.on('exit', () => {
    killAllSync();
});

// Uncaught exceptions → graceful shutdown with error exit code
process.on('uncaughtException', async (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    log.error(err.stack);
    await gracefulShutdown('uncaughtException', 1);
});
