/**
 * bench-cpu-threads.js — measure CPU-only llama-server throughput vs -t.
 *
 * Spawns THROWAWAY llama-server instances on a scratch port (never the wrapper's
 * port pool, never a production service), sends a short fixed chat request, and
 * reads the `timings` block llama-server returns on non-streaming responses.
 *
 * Run: node tests/bench-cpu-threads.js [threadCounts...]
 *   node tests/bench-cpu-threads.js              → 1 2 3 4 6 8 12 16
 *   node tests/bench-cpu-threads.js 2 4 8        → specific counts
 *
 * Env:
 *   BENCH_MODEL  override the model key (default Qwen/Qwen3-0.6B-GGUF)
 *   BENCH_EXTRA  extra llama-server args as a JSON array, e.g.
 *                $env:BENCH_EXTRA='["--reasoning","off"]'
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import config from '../src/config.js';
import { resolveLoadableModel } from '../src/models.js';

const SCRATCH_PORT = 4099;
const MODEL_KEY = process.env.BENCH_MODEL || 'Qwen/Qwen3-0.6B-GGUF';
const MEASURED_RUNS = 3;

const threadCounts = process.argv.slice(2).length
    ? process.argv.slice(2).map(Number)
    : [1, 2, 3, 4, 6, 8, 12, 16];

const extraArgs = process.env.BENCH_EXTRA ? JSON.parse(process.env.BENCH_EXTRA) : [];

const PROMPT = 'Classify the intent of this utterance as one of: greet, question, command, farewell.\nUtterance: "hey, what time is it?"\nLabel:';

function request(port, payload) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(payload));
        const req = http.request(
            { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
            (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
                    resolve(JSON.parse(data));
                });
            }
        );
        req.on('error', reject);
        req.setTimeout(120_000, () => { req.destroy(new Error('request timeout')); });
        req.end(body);
    });
}

async function waitHealthy(port, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise((resolve) => {
            const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    try { resolve(res.statusCode === 200 && JSON.parse(body).status === 'ok'); }
                    catch { resolve(false); }
                });
            });
            req.on('error', () => resolve(false));
            req.setTimeout(2000, () => { req.destroy(); resolve(false); });
        });
        if (ok) return;
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`llama-server on ${port} never became healthy`);
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

async function bench(threads, spec) {
    const args = [
        '-m', spec.ggufPath,
        '--host', '127.0.0.1',
        '--port', String(SCRATCH_PORT),
        '-c', spec.modelConfig.ctxSize.toString(),
        '-ngl', '0',                        // CPU only — this is a CPU benchmark
        '--parallel', '1',
        '-t', String(threads),
        '--flash-attn', 'off',
        '--batch-size', spec.modelConfig.batchSize.toString(),
        '--ubatch-size', spec.modelConfig.ubatchSize.toString(),
        '--jinja',
        ...extraArgs,
    ];

    const child = spawn(config.llamaServerPath, args, {
        cwd: path.dirname(config.llamaServerPath),
        windowsHide: true,
        stdio: 'ignore',
    });

    try {
        await waitHealthy(SCRATCH_PORT);

        const payload = {
            model: MODEL_KEY,
            messages: [{ role: 'user', content: PROMPT }],
            max_tokens: 16,
            temperature: 0,
            stream: false,
        };

        await request(SCRATCH_PORT, payload); // warm-up (page the weights in)

        const promptMs = [];
        const predictedMs = [];
        const predictedN = [];
        let sample = null;
        for (let i = 0; i < MEASURED_RUNS; i++) {
            const res = await request(SCRATCH_PORT, payload);
            const t = res.timings;
            if (!t) throw new Error('response had no timings block');
            promptMs.push(t.prompt_ms);
            predictedMs.push(t.predicted_ms);
            predictedN.push(t.predicted_n);
            sample = res.choices?.[0]?.message ?? null;
        }

        return {
            threads,
            promptMs: median(promptMs),
            predictedMs: median(predictedMs),
            predictedN: median(predictedN),
            predictedPerSec: median(predictedMs) > 0 ? (median(predictedN) * 1000) / median(predictedMs) : 0,
            sample,
        };
    } finally {
        if (child.pid) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
    }
}

const spec = await resolveLoadableModel(MODEL_KEY);
console.log(`model:   ${MODEL_KEY}`);
console.log(`gguf:    ${spec.ggufPath}`);
console.log(`threads to test: ${threadCounts.join(', ')}  (${MEASURED_RUNS} measured runs each, median)`);
console.log(`extra args:      ${extraArgs.length ? extraArgs.join(' ') : '(none)'}\n`);

const results = [];
for (const threads of threadCounts) {
    const r = await bench(threads, spec);
    results.push(r);
    console.log(`  -t ${String(r.threads).padStart(2)}  prompt ${r.promptMs.toFixed(1).padStart(7)} ms   gen ${r.predictedN} tok in ${r.predictedMs.toFixed(1).padStart(7)} ms  (${r.predictedPerSec.toFixed(1)} tok/s)`);
}

const best = results.reduce((a, b) => (b.promptMs < a.promptMs ? b : a));
console.log(`\nfastest prompt processing: -t ${best.threads} at ${best.promptMs.toFixed(1)} ms`);
console.log('raw response message (last run):');
console.log(JSON.stringify(results[results.length - 1].sample, null, 2));
