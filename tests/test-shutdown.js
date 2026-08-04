/**
 * test-shutdown.js — Verify clean shutdown kills all child processes.
 *
 * 1. Starts a streaming request against the manager.
 * 2. After 2s, records running llama-server PIDs.
 * 3. Sends SIGINT to the manager process.
 * 4. Waits 3s, then checks for orphaned llama-server processes.
 *
 * Usage: node tests/test-shutdown.js [managerPid]
 * If managerPid is omitted, finds it from the manager port (4090).
 */

import { execSync } from 'node:child_process';

const MANAGER_URL = process.env.MANAGER_URL || 'http://127.0.0.1:4080';

function getLlamaPids() {
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq llama-server.exe" /NH /FO CSV', { encoding: 'utf-8' });
        return out.trim().split('\n')
            .filter(l => l.includes('llama-server'))
            .map(l => l.match(/"(\d+)"/)?.[1])
            .filter(Boolean);
    } catch {
        return [];
    }
}

// Get llama-server PIDs that belong to our manager (via /status endpoint)
async function getOurLlamaPids() {
    try {
        const res = await fetch(`${MANAGER_URL}/status`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.instances
            .filter(i => i.pid)
            .map(i => i.pid.toString());
    } catch {
        return [];
    }
}

async function main() {
    const managerPid = process.argv[2] || execSync(
        `powershell -NoProfile -c "(Get-NetTCPConnection -LocalPort 4080 -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`,
        { encoding: 'utf-8' }
    ).trim();

    if (!managerPid || managerPid === '0') {
        console.error('Could not find manager PID on port 4090');
        process.exit(1);
    }

    console.log(`Manager PID: ${managerPid}`);

    // 1. Start a streaming request (fire and forget — it will be cut short)
    console.log('Starting streaming request...');
    fetch(`${MANAGER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'Qwen/Qwen3-Embedding-4B-GGUF',
            messages: [{ role: 'user', content: 'Write a very long story about a dog' }],
            max_tokens: 500,
            stream: true,
        }),
    }).then(async res => {
        const reader = res.body.getReader();
        let chunks = 0;
        try {
            while (true) {
                const { done } = await reader.read();
                if (done) break;
                chunks++;
            }
        } catch {
            // Expected — connection drops during shutdown
        }
        console.log(`Stream ended after ${chunks} chunks (expected: cut short)`);
    }).catch(err => {
        console.log(`Stream error (expected during shutdown): ${err.message}`);
    });

    // 2. Wait 5s for stream to start and model to load
    await new Promise(r => setTimeout(r, 5000));

    // Record our manager's llama-server children (via /status endpoint)
    const ourChildrenBefore = await getOurLlamaPids();
    const allBefore = getLlamaPids();
    console.log(`Our manager's llama-server PIDs: ${ourChildrenBefore.join(', ') || 'none'}`);
    console.log(`All llama-server on machine: ${allBefore.join(', ') || 'none'}`);

    // 3. Kill the manager (SIGINT = Ctrl+C)
    console.log(`Sending SIGINT to manager (PID ${managerPid})...`);
    try {
        process.kill(parseInt(managerPid), 'SIGINT');
    } catch (err) {
        console.error(`Failed to signal manager: ${err.message}`);
        process.exit(1);
    }

    // 4. Wait for shutdown sequence (drain + kill — may take up to drainTimeoutMs + 5s)
    await new Promise(r => setTimeout(r, 10000));

    // 5. Check for orphans — only our children matter
    const allAfter = getLlamaPids();
    const survived = allAfter.filter(pid => ourChildrenBefore.includes(pid));

    console.log(`All llama-server after kill: ${allAfter.join(', ') || 'none'}`);
    console.log(`Our children that survived: ${survived.join(', ') || 'none'}`);

    if (survived.length === 0) {
        console.log('\n✓ PASS: Clean shutdown — all manager children killed, no orphans');
        process.exit(0);
    } else {
        console.log(`\n✗ FAIL: ${survived.length} orphaned llama-server process(es) from our manager remain!`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Test crashed:', err);
    process.exit(1);
});
