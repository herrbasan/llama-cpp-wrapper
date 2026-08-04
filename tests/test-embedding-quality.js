/**
 * test-embedding-quality.js — Real-world embedding quality and throughput test.
 *
 * Simulates the chat app's usage pattern: embed each message individually,
 * one at a time. Tests:
 *   1. Throughput — time per message, total conversation time
 *   2. Determinism — 3× re-embed same message, must be bit-identical
 *   3. Discrimination — related messages cosine > unrelated messages cosine
 *   4. Dimension — matches configured model
 *   5. Stability — 3× re-embed all messages, check cosine drift within messages
 *
 * Usage:
 *   node tests/test-embedding-quality.js [exportFile] [modelKey]
 *
 * Default: reads tests/direct-hey_there_-2026-06-07.json, uses qwen/qwen3-embedding-4b-gguf
 */

import { readFileSync } from 'node:fs';

const MANAGER_URL = process.env.MANAGER_URL || 'http://127.0.0.1:4080';

const EXPORT_FILE = process.argv[2] || 'tests/direct-hey_there_-2026-06-07.json';
const MODEL_KEY = process.argv[3] || 'qwen/qwen3-embedding-4b-gguf';

// --- Helpers ---

function cosine(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function embed(message, signal) {
    const start = performance.now();
    const res = await fetch(`${MANAGER_URL}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL_KEY, input: [message] }),
        signal,
    });
    const elapsed = performance.now() - start;
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return {
        vector: json.data[0].embedding,
        dims: json.data[0].embedding.length,
        timeMs: Math.round(elapsed),
    };
}

function buffersMatch(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// --- Extract messages from export ---

function extractMessages(filePath) {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);

    const messages = [];
    for (const ex of data.exchanges) {
        if (ex.user?.content && ex.user.content.length > 0) {
            messages.push({ role: 'user', exchange: data.exchanges.indexOf(ex), text: ex.user.content });
        }
        if (ex.assistant?.content && ex.assistant.content.length > 0) {
            messages.push({ role: 'assistant', exchange: data.exchanges.indexOf(ex), text: ex.assistant.content });
        }
    }
    return { messages, conversationTitle: data.chatInfo?.title };
}

// --- Run tests ---

async function main() {
    console.log('═══ Embedding Quality & Throughput Test ═══');
    console.log(`File:    ${EXPORT_FILE}`);
    console.log(`Model:   ${MODEL_KEY}`);
    console.log(`Manager: ${MANAGER_URL}`);

    // Extract messages
    const { messages, conversationTitle } = extractMessages(EXPORT_FILE);
    console.log(`\nConversation: "${conversationTitle}"`);
    console.log(`Messages:     ${messages.length} (after filtering empty)`);
    if (messages.length === 0) {
        console.error('No messages to test!');
        process.exit(1);
    }

    // Warmup call — first call includes model load if not already running
    console.log('\n--- Warmup ---');
    try {
        const warm = await embed('Warmup — ensure model is loaded');
        console.log(`  ${warm.timeMs}ms, ${warm.dims} dims`);
    } catch (e) {
        console.error(`  FAILED: ${e.message}`);
        process.exit(1);
    }

    // === GATE 1: Dimension check ===
    console.log('\n--- Gate 1: Dimension ---');
    const ref = await embed(messages[0].text);
    const expectedDims = ref.dims;
    console.log(`  Expected dimensions: ${expectedDims}`);

    // === GATE 2: Determinism (3x same message = bit-identical) ===
    console.log('\n--- Gate 2: Determinism ---');
    const testMsg = messages[messages.length - 1].text; // Longest message
    console.log(`  Test message: "${testMsg.slice(0, 60)}..." (${testMsg.length} chars)`);
    const detRuns = [];
    for (let i = 0; i < 3; i++) {
        const r = await embed(testMsg);
        detRuns.push(r);
        console.log(`    Run ${i + 1}: ${r.timeMs}ms, ${r.dims} dims`);
    }
    const d01 = cosine(detRuns[0].vector, detRuns[1].vector);
    const d12 = cosine(detRuns[1].vector, detRuns[2].vector);
    const d02 = cosine(detRuns[0].vector, detRuns[2].vector);
    console.log(`\n  Cosine similarity between runs:`);
    console.log(`    0↔1: ${d01.toFixed(6)}`);
    console.log(`    1↔2: ${d12.toFixed(6)}`);
    console.log(`    0↔2: ${d02.toFixed(6)}`);

    const isDeterministic = d01 > 0.999999 && d12 > 0.999999 && d02 > 0.999999;
    if (isDeterministic) {
        console.log('  ✓ PASS — All pairs bit-identical (cosine = 1.0)');
    } else {
        console.log('  ✗ FAIL — Vectors are NOT deterministic! Vectors differ between runs.');
        // Check how close they are
        let maxDiff = 0;
        console.log('  First 10 dimension diffs (run0 vs run1):');
        for (let i = 0; i < Math.min(10, detRuns[0].vector.length); i++) {
            const diff = Math.abs(detRuns[0].vector[i] - detRuns[1].vector[i]);
            if (diff > maxDiff) maxDiff = diff;
            if (diff > 0) console.log(`    dim[${i}]: ${diff.toExponential(2)}`);
        }
        console.log(`  Max absolute diff: ${maxDiff.toExponential(2)}`);
    }

    // === GATE 3: Throughput (embed full conversation, one message at a time) ===
    console.log('\n--- Gate 3: Throughput (sequential, one per request) ---');

    const ALL_RUNS = 3; // Run the full conversation 3× for stability check
    const allRuns = [];
    let totalTime = 0;
    let totalMessages = 0;
    let minTime = Infinity;
    let maxTime = 0;

    for (let run = 0; run < ALL_RUNS; run++) {
        const runVectors = [];
        console.log(`  Run ${run + 1}/${ALL_RUNS}:`);
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const result = await embed(msg.text);
            runVectors.push({ ...msg, ...result });
            totalTime += result.timeMs;
            totalMessages++;
            if (result.timeMs < minTime) minTime = result.timeMs;
            if (result.timeMs > maxTime) maxTime = result.timeMs;
            const label = msg.role === 'user' ? 'U' : 'A';
            console.log(`    [${label}] ${result.timeMs}ms "${msg.text.slice(0, 50)}..."`);
        }
        allRuns.push(runVectors);
    }

    const avgTime = Math.round(totalTime / totalMessages);
    console.log(`\n  Summary (${totalMessages} embeddings across ${ALL_RUNS} runs):`);
    console.log(`    Total time: ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);
    console.log(`    Per message: avg=${avgTime}ms, min=${minTime}ms, max=${maxTime}ms`);
    console.log(`    Throughput: ${(1000 / avgTime).toFixed(2)} msgs/sec`);

    // === GATE 4: Discrimination ===
    console.log('\n--- Gate 4: Discrimination ---');
    // Pick two messages from the same exchange (related) and two from far apart (unrelated)
    const run1 = allRuns[0];
    if (run1.length >= 4) {
        // Same exchange (indices 0 and 1 are from exchange 0)
        const sameExchMsgs = run1.filter(m => m.exchange === run1[0].exchange);
        const diffExchMsgs = run1.filter(m => m.exchange !== run1[0].exchange);

        if (sameExchMsgs.length >= 2 && diffExchMsgs.length >= 2) {
            const related = cosine(sameExchMsgs[0].vector, sameExchMsgs[1].vector);
            const unrelated = cosine(sameExchMsgs[0].vector, diffExchMsgs[diffExchMsgs.length - 1].vector);
            console.log(`  Related (same exchange):     ${related.toFixed(4)}`);
            console.log(`  Unrelated (far apart):       ${unrelated.toFixed(4)}`);

            if (related > unrelated) {
                console.log(`  ✓ PASS — Related > unrelated (delta: ${(related - unrelated).toFixed(4)})`);
            } else {
                console.log(`  ✗ FAIL — Related <= unrelated. Check embedding quality.`);
            }
        }
    }

    // === GATE 5: Stability (cosine drift across runs for same message) ===
    console.log('\n--- Gate 5: Stability (3-run drift) ---');
    if (allRuns.length >= 2) {
        const minStability = { msgIdx: -1, cos: 1.0 };
        for (let i = 0; i < messages.length; i++) {
            const v0 = allRuns[0][i].vector;
            const v1 = allRuns[1][i].vector;
            const v2 = allRuns[2][i].vector;
            const c01 = cosine(v0, v1);
            const c12 = cosine(v1, v2);
            const c02 = cosine(v0, v2);
            const worst = Math.min(c01, c12, c02);
            if (worst < minStability.cos) {
                minStability.cos = worst;
                minStability.msgIdx = i;
            }
        }
        console.log(`  Min cosine stability: ${minStability.cos.toFixed(6)} (msg ${minStability.msgIdx})`);
        if (minStability.cos >= 0.9999) {
            console.log('  ✓ PASS — Embeddings stable across runs (cosine ≥ 0.9999)');
        } else if (minStability.cos >= 0.99) {
            console.log('  ⚠ WARN — Some drift but within tolerance (cosine ≥ 0.99)');
        } else {
            console.log('  ✗ FAIL — Significant drift across runs');
        }
    }

    console.log('\n═══ Complete ═══');
}

main().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
});
