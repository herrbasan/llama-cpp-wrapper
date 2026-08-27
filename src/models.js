/**
 * models.js — Model discovery, resolution, and GGUF metadata extraction.
 *
 * Model keys follow the LM Studio convention:
 *   - Canonical: "publisher/model" (relative folder path under modelsDir)
 *   - Quant variant: "publisher/model@q4_k_m" (parsed from filename)
 *   - Short form: "model-name" (resolves if unambiguous across publishers)
 *   - Absolute .gguf path: used directly
 *
 * Matching is case-insensitive (Windows filesystem semantics).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';
import { createLogger } from './modules/nLogger/src/logger.js';

const log = createLogger();

// --- State ---
let scanCache = null;          // { models: ModelEntry[], scannedAt: number }
const resolveCache = new Map(); // modelKey → resolved path (per-request cache)

// --- GGUF metadata extraction ---
// Reads the first 2MB and parses the GGUF KV metadata block.
// Returns: { architecture, context_length, parameter_count, file_type,
//            embedding_dim, pooling_type, general_name }

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

// GGUF metadata value types
const GGUF_TYPE_UINT8 = 0;
const GGUF_TYPE_INT8 = 1;
const GGUF_TYPE_UINT16 = 2;
const GGUF_TYPE_INT16 = 3;
const GGUF_TYPE_UINT32 = 4;
const GGUF_TYPE_INT32 = 5;
const GGUF_TYPE_FLOAT32 = 6;
const GGUF_TYPE_BOOL = 7;
const GGUF_TYPE_STRING = 8;
const GGUF_TYPE_ARRAY = 9;
const GGUF_TYPE_UINT64 = 10;
const GGUF_TYPE_INT64 = 11;
const GGUF_TYPE_FLOAT64 = 12;

async function extractGgufMetadata(filePath) {
    let fd;
    const metadata = {};
    try {
        fd = await fs.open(filePath, 'r');
        const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB — larger models have extensive metadata
        const buf = Buffer.alloc(CHUNK_SIZE);
        const { bytesRead } = await fd.read(buf, 0, CHUNK_SIZE, 0);

        if (bytesRead < 24) {
            throw new Error(`File too small to be valid GGUF: ${filePath}`);
        }

        const magic = buf.readUInt32LE(0);
        if (magic !== GGUF_MAGIC) {
            throw new Error(`Not a GGUF file (bad magic): ${filePath}`);
        }

        const kvCount = Number(buf.readBigUInt64LE(16));
        let offset = 24;

        for (let i = 0; i < kvCount; i++) {
            if (offset + 8 > bytesRead) break;

            // Read key string
            const keyLen = Number(buf.readBigUInt64LE(offset));
            offset += 8;
            if (offset + keyLen > bytesRead) break;
            const key = buf.toString('utf8', offset, offset + keyLen);
            offset += keyLen;

            // Read value type
            if (offset + 4 > bytesRead) break;
            const valType = buf.readUInt32LE(offset);
            offset += 4;

            // Parse value (recursive for arrays)
            const value = parseGgufValue(buf, offset, bytesRead, valType);
            offset = value.nextOffset;

            // Extract known fields
            if (key === 'general.architecture') metadata.architecture = value.value;
            if (key === 'general.name') metadata.general_name = value.value;
            if (key === 'general.parameter_count') metadata.parameter_count = value.value;
            if (key === 'general.file_type') metadata.file_type = value.value;
            if (key.endsWith('.context_length')) metadata.context_length = value.value;
            if (key.endsWith('.block_count')) metadata.block_count = value.value;
            if (key.endsWith('.embedding_length')) metadata.embedding_dim = value.value;
            if (key.endsWith('.pooling_type')) metadata.pooling_type = value.value;
        }
    } catch (err) {
        log.warn(`Failed to parse GGUF metadata for ${path.basename(filePath)}: ${err.message}`);
    } finally {
        if (fd) await fd.close();
    }
    return metadata;
}

function parseGgufValue(buf, offset, limit, type) {
    let value = null;

    // Bounds check — stop parsing if we're past the buffer
    if (offset >= limit) {
        return { value: null, nextOffset: limit };
    }

    switch (type) {
        case GGUF_TYPE_UINT8:
        case GGUF_TYPE_INT8:
        case GGUF_TYPE_BOOL:
            value = buf[offset];
            offset += 1;
            break;
        case GGUF_TYPE_UINT16:
        case GGUF_TYPE_INT16:
            if (offset + 2 > limit) return { value: null, nextOffset: limit };
            value = type === GGUF_TYPE_INT16 ? buf.readInt16LE(offset) : buf.readUInt16LE(offset);
            offset += 2;
            break;
        case GGUF_TYPE_UINT32:
            if (offset + 4 > limit) return { value: null, nextOffset: limit };
            value = buf.readUInt32LE(offset);
            offset += 4;
            break;
        case GGUF_TYPE_INT32:
            if (offset + 4 > limit) return { value: null, nextOffset: limit };
            value = buf.readInt32LE(offset);
            offset += 4;
            break;
        case GGUF_TYPE_FLOAT32:
            if (offset + 4 > limit) return { value: null, nextOffset: limit };
            value = buf.readFloatLE(offset);
            offset += 4;
            break;
        case GGUF_TYPE_UINT64:
            if (offset + 8 > limit) return { value: null, nextOffset: limit };
            value = Number(buf.readBigUInt64LE(offset));
            offset += 8;
            break;
        case GGUF_TYPE_INT64:
            if (offset + 8 > limit) return { value: null, nextOffset: limit };
            value = Number(buf.readBigInt64LE(offset));
            offset += 8;
            break;
        case GGUF_TYPE_FLOAT64:
            if (offset + 8 > limit) return { value: null, nextOffset: limit };
            value = buf.readDoubleLE(offset);
            offset += 8;
            break;
        case GGUF_TYPE_STRING: {
            if (offset + 8 > limit) return { value: null, nextOffset: limit };
            const strLen = Number(buf.readBigUInt64LE(offset));
            offset += 8;
            if (offset + strLen <= limit) {
                value = buf.toString('utf8', offset, offset + strLen);
            }
            offset += strLen;
            break;
        }
        case GGUF_TYPE_ARRAY: {
            if (offset + 12 > limit) return { value: null, nextOffset: limit };
            const arrType = buf.readUInt32LE(offset);
            offset += 4;
            const arrLen = Number(buf.readBigUInt64LE(offset));
            offset += 8;
            // Skip array elements — we don't need them for metadata
            for (let j = 0; j < arrLen; j++) {
                const elem = parseGgufValue(buf, offset, limit, arrType);
                offset = elem.nextOffset;
            }
            value = null; // Arrays not extracted
            break;
        }
        default:
            // Unknown type — can't skip, stop parsing
            value = null;
            offset = limit;
            break;
    }

    return { value, nextOffset: offset };
}

// --- Quant tag extraction ---
// "Qwen3-32B-Q4_K_M.gguf" → "q4_k_m"
// "model.f16.gguf" → "f16"
// "model.gguf" → null (no quant tag)
function extractQuantTag(filename) {
    const base = filename.replace(/\.gguf$/i, '');
    // Match common quant patterns: Q4_K_M, Q8_0, F16, F32, IQ3_XXS, etc.
    const match = base.match(/[._-]?(q\d[\w_]*|f\d+|iq\d[\w_]*|bf\d+)\s*$/i);
    if (!match) return null;
    return match[1].toLowerCase();
}

// --- Model discovery ---
// Recursively scans modelsDir for .gguf files, groups them by publisher/model folder,
// extracts metadata. Results cached with TTL.

async function discoverModels() {
    const now = Date.now();
    if (scanCache && (now - scanCache.scannedAt) < config.modelScanTtlMs) {
        return scanCache.models;
    }

    const models = [];
    await scanDir(config.modelsDir, '', models);

    scanCache = { models, scannedAt: now };
    log.info(`Model scan complete: ${models.length} model(s) found in ${config.modelsDir}`);
    return models;
}

async function scanDir(dirPath, relativePath, results) {
    let entries;
    try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
        return; // Directory doesn't exist or not accessible
    }

    // Projector files: .mmproj, mmproj-*.gguf, or *vision*.gguf (publisher naming varies)
    const isProjector = (name) => {
        const n = name.toLowerCase();
        return n.endsWith('.mmproj') ||
            (n.startsWith('mmproj') && n.endsWith('.gguf')) ||
            (n.includes('vision') && n.endsWith('.gguf'));
    };

    // MTP draft module (multi-token prediction, e.g. "mtp-gemma-4-12B-it.gguf").
    // Auxiliary speculative-decoding file — not a quant variant of the model.
    const isMtpDraft = (n) => {
        return n.endsWith('.gguf') && (n.startsWith('mtp') || n.includes('-mtp-'));
    };

    // Find .gguf files in this directory (excluding vision projectors and MTP drafts)
    const ggufFiles = entries.filter(e =>
        e.isFile() && e.name.toLowerCase().endsWith('.gguf') &&
        !isProjector(e.name) && !isMtpDraft(e.name)
    );

    // Find projector and MTP draft files
    const mmprojFiles = entries.filter(e => e.isFile() && isProjector(e.name));
    const mtpFiles = entries.filter(e => e.isFile() && isMtpDraft(e.name));

    if (ggufFiles.length > 0) {
        const mmprojPath = mmprojFiles.length > 0
            ? path.join(dirPath, mmprojFiles[0].name)
            : null;
        const mtpPath = mtpFiles.length > 0
            ? path.join(dirPath, mtpFiles[0].name)
            : null;

        // Sort gguf files by size descending (largest first = default quant)
        const ggufsWithStats = [];
        for (const entry of ggufFiles) {
            const fullPath = path.join(dirPath, entry.name);
            const stat = await fs.stat(fullPath);
            ggufsWithStats.push({ entry, fullPath, size: stat.size });
        }
        ggufsWithStats.sort((a, b) => b.size - a.size);

        // Extract metadata from the largest file (representative for the model)
        const primary = ggufsWithStats[0];
        const meta = await extractGgufMetadata(primary.fullPath);

        // Build model key from relative path: "publisher/model"
        const modelKey = relativePath.replace(/\\/g, '/').replace(/^\//, '');

        results.push({
            key: modelKey,
            name: meta.general_name || path.basename(relativePath || dirPath),
            dir: dirPath,
            mmprojPath,
            mtpPath,
            quants: ggufsWithStats.map(g => ({
                filename: g.entry.name,
                path: g.fullPath,
                sizeBytes: g.size,
                quantTag: extractQuantTag(g.entry.name),
            })),
            defaultQuant: {
                filename: primary.entry.name,
                path: primary.fullPath,
                sizeBytes: primary.size,
                quantTag: extractQuantTag(primary.entry.name),
            },
            metadata: meta,
        });
    }

    // Recurse into subdirectories
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip hidden directories
        if (entry.name.startsWith('.')) continue;
        const childPath = path.join(dirPath, entry.name);
        const childRelative = path.join(relativePath, entry.name);
        await scanDir(childPath, childRelative, results);
    }
}

// --- Model resolution ---
// Resolves a model key from the request body "model" field to a .gguf file path.
//
// Accepted forms:
//   "publisher/model"           → exact folder match
//   "publisher/model@q4_k_m"   → specific quant variant
//   "model-name"               → short form, must be unambiguous
//   "D:\path\to\model.gguf"    → absolute path, used directly

export async function resolveModel(modelKey) {
    if (!modelKey || typeof modelKey !== 'string') {
        throw new Error('resolveModel: model field is required');
    }

    const cacheKey = modelKey.toLowerCase();
    if (resolveCache.has(cacheKey)) {
        return resolveCache.get(cacheKey);
    }

    let result;

    // Absolute .gguf path — use directly
    if (modelKey.toLowerCase().endsWith('.gguf') && path.isAbsolute(modelKey)) {
        const ggufPath = path.resolve(modelKey);
        try {
            await fs.access(ggufPath);
        } catch {
            throw new Error(`Model file not found: ${ggufPath}`);
        }
        const modelDir = path.dirname(ggufPath);
        const mmprojPath = await findMmproj(modelDir);
        const mtpPath = await findMtpDraft(modelDir);
        result = { ggufPath, mmprojPath, mtpPath, quantTag: extractQuantTag(path.basename(ggufPath)) };
        resolveCache.set(cacheKey, result);
        return result;
    }

    // Parse @quant suffix if present
    let baseKey = modelKey;
    let requestedQuant = null;
    const atIndex = modelKey.lastIndexOf('@');
    if (atIndex > 0) {
        baseKey = modelKey.substring(0, atIndex);
        requestedQuant = modelKey.substring(atIndex + 1).toLowerCase();
    }

    // Discover models and find matches
    const models = await discoverModels();
    const baseKeyLower = baseKey.toLowerCase();

    // Try exact key match first
    let matches = models.filter(m => m.key.toLowerCase() === baseKeyLower);

    // If no exact match, try leaf-name match (short form)
    if (matches.length === 0) {
        matches = models.filter(m => {
            const leafName = m.key.split('/').pop().toLowerCase();
            return leafName === baseKeyLower;
        });
    }

    if (matches.length === 0) {
        throw new Error(`Model not found: "${modelKey}". Use GET /v1/models to list available models.`);
    }

    if (matches.length > 1) {
        const keys = matches.map(m => m.key).join(', ');
        throw new Error(`Ambiguous model key "${modelKey}". Matches: ${keys}. Use the full "publisher/model" key.`);
    }

    const model = matches[0];

    // Select quant variant
    let selectedQuant;
    if (requestedQuant) {
        selectedQuant = model.quants.find(q => q.quantTag === requestedQuant);
        if (!selectedQuant) {
            const available = model.quants.map(q => q.quantTag).filter(Boolean).join(', ');
            throw new Error(`Quant "@${requestedQuant}" not found for "${model.key}". Available: ${available}`);
        }
    } else {
        // Default: largest quant (already sorted)
        selectedQuant = model.defaultQuant;
        if (model.quants.length > 1) {
            log.info(`Multiple quants for "${model.key}", using default (largest): ${selectedQuant.filename}`);
        }
    }

    result = {
        ggufPath: selectedQuant.path,
        mmprojPath: model.mmprojPath,
        mtpPath: model.mtpPath,
        quantTag: selectedQuant.quantTag,
        modelKey: model.key,
        metadata: model.metadata,
    };

    resolveCache.set(cacheKey, result);
    return result;
}

async function findMmproj(dir) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const mmproj = entries.find(e => {
            if (!e.isFile()) return false;
            const n = e.name.toLowerCase();
            return n.endsWith('.mmproj') ||
                (n.startsWith('mmproj') && n.endsWith('.gguf')) ||
                (n.includes('vision') && n.endsWith('.gguf'));
        });
        return mmproj ? path.join(dir, mmproj.name) : null;
    } catch {
        return null;
    }
}

async function findMtpDraft(dir) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const mtp = entries.find(e => {
            if (!e.isFile()) return false;
            const n = e.name.toLowerCase();
            return n.endsWith('.gguf') && (n.startsWith('mtp') || n.includes('-mtp-'));
        });
        return mtp ? path.join(dir, mtp.name) : null;
    } catch {
        return null;
    }
}

// --- Load optional models.json overrides ---

async function loadModelOverrides() {
    const overridesPath = path.join(config.projectRoot, 'models.json');
    try {
        const raw = await fs.readFile(overridesPath, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return {}; // models.json is optional
    }
}

// Get effective config for a model: defaults overridden by models.json entry
export async function getModelConfig(modelKey) {
    const overrides = await loadModelOverrides();

    // Case-insensitive key match in overrides
    const keyLower = modelKey.toLowerCase();
    const overrideKey = Object.keys(overrides).find(k => k.toLowerCase() === keyLower);
    const override = overrideKey ? overrides[overrideKey] : null;
    if (override) {
        return {
            ctxSize: override.ctxSize ?? config.defaultCtxSize,
            gpuLayers: override.gpuLayers ?? config.defaultGpuLayers,
            threads: override.threads ?? config.defaultThreads,
            flashAttention: override.flashAttention ?? config.flashAttention,
            parallelSlots: override.parallelSlots ?? config.defaultParallelSlots,
            batchSize: override.batchSize ?? config.defaultBatchSize,
            ubatchSize: override.ubatchSize ?? config.defaultUbatchSize,
            embedding: override.embedding ?? false,
            pooling: override.pooling ?? null,
            mlock: override.mlock ?? false,
            mmprojPath: override.mmprojPath ?? null,
            mtpPath: override.mtpPath ?? null,
            specDraftNMax: override.specDraftNMax ?? 4,
            jinja: override.jinja ?? false,
            chatTemplateFile: override.chatTemplateFile ?? null,
        };
    }

    // No override — use defaults
    return {
        ctxSize: config.defaultCtxSize,
        gpuLayers: config.defaultGpuLayers,
        threads: config.defaultThreads,
        flashAttention: config.flashAttention,
        parallelSlots: config.defaultParallelSlots,
        batchSize: config.defaultBatchSize,
        ubatchSize: config.defaultUbatchSize,
        embedding: false,
        pooling: null,
        mlock: false,
        mmprojPath: null,
        mtpPath: null,
        specDraftNMax: 4,
        jinja: false,
        chatTemplateFile: null,
    };
}

export { discoverModels, extractGgufMetadata };
