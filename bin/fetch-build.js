#!/usr/bin/env node
/**
 * fetch-build.js — Download and verify a llama-server build from llama-cpp-builds releases.
 *
 * Usage: node bin/fetch-build.js [tag]        e.g. node bin/fetch-build.js b10499
 *         Omit <tag> to fetch the latest release from llama-cpp-builds.
 *
 * Downloads llama-server-<tag>-windows-universal.zip + .sha256.txt from
 * github.com/herrbasan/llama-cpp-builds releases, verifies every file's hash,
 * extracts to builds/<tag>/. Idempotent: if builds/<tag>/ exists and verifies
 * against its local sha256.txt, does nothing.
 *
 * Also importable: `import { fetchBuild } from './fetch-build.js'` — returns the tag.
 *
 * Zero dependencies — Node 18+ (fetch, web streams). Fails loud on any mismatch.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const RELEASES = 'https://github.com/herrbasan/llama-cpp-builds/releases/download';
const API_LATEST = 'https://api.github.com/repos/herrbasan/llama-cpp-builds/releases/latest';

function fail(msg) {
    console.error(`fetch-build: ${msg}`);
    process.exit(1);
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function parseManifest(text) {
    const entries = new Map();
    for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
        if (m) entries.set(m[2], m[1]);
    }
    if (entries.size === 0) fail('manifest is empty or malformed');
    return entries;
}

function verifyDir(dir, manifestText) {
    const entries = parseManifest(manifestText);
    for (const [name, hash] of entries) {
        const p = path.join(dir, name);
        if (!fs.existsSync(p)) fail(`manifest file missing: ${name}`);
        const actual = sha256(p);
        if (actual !== hash) fail(`hash mismatch: ${name}\n  expected ${hash}\n  actual   ${actual}`);
    }
    return entries;
}

function updateConfig(tag, { quiet = false } = {}) {
    const configPath = path.join(projectRoot, 'config.json');
    if (!fs.existsSync(configPath)) {
        if (!quiet) console.log(`fetch-build: no config.json — set "llamaBuild": "${tag}" in config.json to use it`);
        return;
    }
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg.llamaBuild === tag) return;
    cfg.llamaBuild = tag;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4) + '\n');
    console.log(`fetch-build: config.json updated — "llamaBuild": "${tag}"`);
}

export async function fetchBuild(tag, { quiet = false } = {}) {
    if (tag && !/^b\d+$/.test(tag)) fail('usage: node bin/fetch-build.js [tag]  (e.g. b10499, or omit for latest)');

    if (!tag) {
        const res = await fetch(API_LATEST, { headers: { 'User-Agent': 'llama-cpp-wrapper-fetch-build' } });
        if (!res.ok) fail(`latest release lookup failed: HTTP ${res.status}`);
        const release = await res.json();
        tag = release.tag_name;
        if (!tag || !/^b\d+$/.test(tag)) fail(`unexpected latest release tag: ${tag}`);
        console.log(`fetch-build: latest release is ${tag}`);
    }

    const zipName = `llama-server-${tag}-windows-universal`;
    const targetDir = path.join(projectRoot, 'builds', tag);
    const manifestPath = path.join(targetDir, 'sha256.txt');

    // --- Already fetched? Verify against local manifest and exit. ---
    if (fs.existsSync(manifestPath)) {
        verifyDir(targetDir, fs.readFileSync(manifestPath, 'utf-8'));
        console.log(`fetch-build: ${tag} already present and verified (${targetDir})`);
        updateConfig(tag, { quiet });
        return tag;
    }
    if (fs.existsSync(targetDir)) {
        fail(`${targetDir} exists but has no sha256.txt — delete it and re-run (refusing to trust unverifiable files)`);
    }

    // --- Download manifest first ---
    const manifestUrl = `${RELEASES}/${tag}/${zipName}.sha256.txt`;
    const zipUrl = `${RELEASES}/${tag}/${zipName}.zip`;

    console.log(`fetch-build: fetching manifest ${manifestUrl}`);
    const mRes = await fetch(manifestUrl);
    if (!mRes.ok) fail(`manifest download failed: HTTP ${mRes.status} (does release ${tag} exist?)`);
    const manifestText = await mRes.text();
    const entries = parseManifest(manifestText);

    // --- Download zip ---
    const tmpDir = path.join(projectRoot, 'builds', `.tmp-${tag}`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, `${zipName}.zip`);

    console.log(`fetch-build: downloading ${zipUrl}`);
    const zRes = await fetch(zipUrl);
    if (!zRes.ok) fail(`zip download failed: HTTP ${zRes.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await zRes.arrayBuffer()));
    console.log(`fetch-build: downloaded ${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB`);

    // --- Extract (Windows: tar ships with the OS and handles zips) ---
    execFileSync('tar', ['-xf', zipPath, '-C', tmpDir], { stdio: 'inherit' });
    fs.unlinkSync(zipPath);

    // --- Verify every extracted file against the manifest ---
    verifyDir(tmpDir, manifestText);
    console.log(`fetch-build: ${entries.size} files verified`);

    // --- Atomic-ish move into place ---
    fs.mkdirSync(path.join(projectRoot, 'builds'), { recursive: true });
    fs.renameSync(tmpDir, targetDir);

    console.log(`fetch-build: ${tag} ready at ${targetDir}`);
    updateConfig(tag, { quiet });
    return tag;
}

// CLI entry: only run when invoked directly, not when imported.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await fetchBuild(process.argv[2]);
}
