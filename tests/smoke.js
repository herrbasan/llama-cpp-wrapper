/**
 * smoke.js — End-to-end smoke test for llama-cpp-wrapper.
 *
 * Tests:
 *   1. Manager starts and /health responds.
 *   2. /v1/models lists discovered models.
 *   3. A chat completion request loads a model and returns a response.
 *   4. An embedding request returns correct-dimension vectors.
 *   5. Embedding determinism: same text 20x → bit-identical.
 *
 * Usage:
 *   node tests/smoke.js [modelKey] [embedModelKey]
 *
 * Defaults to the first discovered chat model and first embedding model.
 * Requires a built llama-server binary (config.json → llamaServerPath).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const MANAGER_URL = process.env.MANAGER_URL || 'http://127.0.0.1:4080';
const POLL_INTERVAL_MS = 1000;
const MANAGER_STARTUP_MS = 10000;
const MODEL_LOAD_MS = 120000;

// --- Tiny test framework ---

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.error(`  ✗ ${message}`);
        failed++;
    }
}

function assertApprox(actual, expected, tolerance, label) {
    const diff = Math.abs(actual - expected);
    assert(diff <= tolerance, `${label}: ${actual} ≈ ${expected} (±${tolerance})`);
}

async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const body = await res.text();
    if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }
    return JSON.parse(body);
}

async function waitForManager() {
    const deadline = Date.now() + MANAGER_STARTUP_MS;
    while (Date.now() < deadline) {
        try {
            const data = await fetchJson(`${MANAGER_URL}/health`);
            if (data.status === 'ok') return;
        } catch {
            // Manager not ready yet
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Manager did not become healthy within ${MANAGER_STARTUP_MS / 1000}s`);
}

async function waitForModel(modelKey) {
    const deadline = Date.now() + MODEL_LOAD_MS;
    while (Date.now() < deadline) {
        try {
            const data = await fetchJson(`${MANAGER_URL}/status`);
            const inst = data.instances.find(i => i.modelKey === modelKey);
            if (inst && inst.state === 'running') return;
            if (inst && inst.state === 'error') {
                throw new Error(`Model ${modelKey} entered error state`);
            }
        } catch (err) {
            if (err.message.includes('error state')) throw err;
            // Status endpoint might not be ready
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Model ${modelKey} did not become ready within ${MODEL_LOAD_MS / 1000}s`);
}

// --- Tests ---

async function testHealth() {
    console.log('\nTest 1: Manager health');
    const data = await fetchJson(`${MANAGER_URL}/health`);
    assert(data.status === 'ok', 'Manager reports status: ok');
}

async function testModelsList() {
    console.log('\nTest 2: List models');
    const data = await fetchJson(`${MANAGER_URL}/v1/models`);
    assert(data.object === 'list', 'Response is a list');
    assert(Array.isArray(data.data) && data.data.length > 0, `Found ${data.data?.length || 0} models`);
    if (data.data.length > 0) {
        console.log(`    Available: ${data.data.map(m => m.id).slice(0, 5).join(', ')}${data.data.length > 5 ? '...' : ''}`);
    }
    return data.data;
}

async function testChatCompletion(modelKey) {
    console.log(`\nTest 3: Chat completion (${modelKey})`);

    const response = await fetch(`${MANAGER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: modelKey,
            messages: [{ role: 'user', content: 'Say exactly: hello world' }],
            max_tokens: 20,
            temperature: 0,
            stream: false,
        }),
    });

    assert(response.ok, `HTTP ${response.status}`);
    const data = await response.json();
    assert(data.choices && data.choices.length > 0, 'Has choices');
    assert(data.choices[0].message?.content?.length > 0, 'Has content');
    console.log(`    Response: "${data.choices[0].message.content.slice(0, 100)}"`);
}

async function testEmbeddings(modelKey) {
    console.log(`\nTest 4: Embeddings (${modelKey})`);

    const response = await fetch(`${MANAGER_URL}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: modelKey,
            input: 'hello world',
        }),
    });

    assert(response.ok, `HTTP ${response.status}`);
    const data = await response.json();
    assert(data.data && data.data.length > 0, 'Has embedding data');
    const vec = data.data[0].embedding;
    assert(Array.isArray(vec) && vec.length > 0, `Vector is non-empty (${vec?.length} dims)`);
    console.log(`    Dimension: ${vec.length}`);
    return vec;
}

async function testEmbeddingDeterminism(modelKey) {
    console.log(`\nTest 5: Embedding determinism — 20x same text (${modelKey})`);

    const text = 'The quick brown fox jumps over the lazy dog.';
    const vectors = [];

    for (let i = 0; i < 20; i++) {
        const response = await fetch(`${MANAGER_URL}/v1/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelKey, input: text }),
        });
        const data = await response.json();
        vectors.push(data.data[0].embedding);
    }

    // Compare all vectors to the first one — must be bit-identical
    let allIdentical = true;
    const ref = vectors[0];
    for (let i = 1; i < vectors.length; i++) {
        const v = vectors[i];
        if (v.length !== ref.length) {
            allIdentical = false;
            console.error(`    Length mismatch at run ${i}: ${v.length} vs ${ref.length}`);
            break;
        }
        for (let j = 0; j < ref.length; j++) {
            if (v[j] !== ref[j]) {
                allIdentical = false;
                console.error(`    Value diff at run ${i}, dim ${j}: ${v[j]} vs ${ref[j]}`);
                break;
            }
        }
        if (!allIdentical) break;
    }

    assert(allIdentical, 'All 20 embeddings are bit-identical');
}

async function testEmbeddingDiscrimination(modelKey) {
    console.log(`\nTest 6: Embedding discrimination sanity (${modelKey})`);

    async function embed(text) {
        const res = await fetch(`${MANAGER_URL}/v1/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelKey, input: text }),
        });
        const data = await res.json();
        return data.data[0].embedding;
    }

    function cosine(a, b) {
        let dot = 0, magA = 0, magB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            magA += a[i] * a[i];
            magB += b[i] * b[i];
        }
        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    }

    const [pizza, quantum, ai, ml] = await Promise.all([
        embed('pizza'),
        embed('quantum physics'),
        embed('AI'),
        embed('machine learning'),
    ]);

    const unrelated = cosine(pizza, quantum);
    const related = cosine(ai, ml);

    console.log(`    "pizza" ↔ "quantum physics" (unrelated): ${unrelated.toFixed(4)}`);
    console.log(`    "AI" ↔ "machine learning" (related):   ${related.toFixed(4)}`);

    assert(unrelated < related, 'Unrelated pair scores lower than related pair');
    assert(unrelated < 0.6, `Unrelated pair is sufficiently low (< 0.6)`);
    assert(related > 0.7, `Related pair is sufficiently high (> 0.7)`);
}

// --- Main ---

async function main() {
    const chatModel = process.argv[2] || null;
    const embedModel = process.argv[3] || null;

    console.log('=== llama-cpp-wrapper smoke test ===');
    console.log(`Manager: ${MANAGER_URL}`);

    // Wait for manager to be up (assumes manager is already running)
    try {
        await waitForManager();
    } catch (err) {
        console.error(`FATAL: ${err.message}`);
        console.error('Start the manager first: npm start');
        process.exit(1);
    }

    await testHealth();
    const models = await testModelsList();

    // Pick models
    const chatKey = chatModel || models.find(m => !m.id.toLowerCase().includes('embed'))?.id;
    const embedKey = embedModel || models.find(m => m.id.toLowerCase().includes('embed'))?.id;

    if (!chatKey) {
        console.log('\nSkipping chat test — no non-embedding model found');
    } else {
        await testChatCompletion(chatKey);
    }

    if (!embedKey) {
        console.log('\nSkipping embedding tests — no embedding model found');
    } else {
        await testEmbeddings(embedKey);
        await testEmbeddingDeterminism(embedKey);
        await testEmbeddingDiscrimination(embedKey);
    }

    // Summary
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Smoke test crashed:', err);
    process.exit(1);
});
