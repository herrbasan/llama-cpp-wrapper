#!/usr/bin/env node
/**
 * init.js — First-time (re)setup: fetch the latest llama-server build and write config.json.
 *
 * Usage: node bin/init.js <modelsDir>        e.g. node bin/init.js "T:\Stuff\LMStudio"
 *
 * 1. Fetches the latest verified build from llama-cpp-builds (via fetch-build.js).
 * 2. config.json missing → copies config.example.json, sets llamaBuild + modelsDir.
 *    config.json present → updates llamaBuild and modelsDir only; everything else untouched.
 *
 * Zero dependencies. Fails loud: missing modelsDir arg or nonexistent directory crashes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBuild } from './fetch-build.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function fail(msg) {
    console.error(`init: ${msg}`);
    process.exit(1);
}

const modelsDir = process.argv[2];
if (!modelsDir) fail('usage: node bin/init.js <modelsDir>  (e.g. "T:\\Stuff\\LMStudio")');
if (!fs.existsSync(modelsDir) || !fs.statSync(modelsDir).isDirectory()) {
    fail(`modelsDir does not exist or is not a directory: ${modelsDir}`);
}

const tag = await fetchBuild(null, { quiet: true });

const configPath = path.join(projectRoot, 'config.json');
let cfg;
if (fs.existsSync(configPath)) {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    console.log('init: config.json exists — updating llamaBuild + modelsDir only');
} else {
    const examplePath = path.join(projectRoot, 'config.example.json');
    if (!fs.existsSync(examplePath)) fail('config.example.json missing — cannot create config.json');
    cfg = JSON.parse(fs.readFileSync(examplePath, 'utf-8'));
    console.log('init: creating config.json from config.example.json');
}

cfg.llamaBuild = tag;
cfg.modelsDir = modelsDir;
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4) + '\n');

console.log(`init: ready — "llamaBuild": "${tag}", "modelsDir": "${modelsDir}"`);
console.log('init: run `npm start` to launch the manager');
