# llama-cpp-wrapper API Reference

> Zero-dependency Node.js process manager for `llama-server`. Presents a standard OpenAI-compatible API. Clients send standard OpenAI requests; the manager spawns/swaps `llama-server` processes and proxies requests/responses raw — zero payload transformation.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Configuration](#configuration)
  - [config.json — Required Fields](#configjson--required-fields)
  - [config.json — Optional Defaults](#configjson--optional-defaults)
  - [models.json — Per-Model Overrides](#modelsjson--per-model-overrides)
- [Model Key Convention](#model-key-convention)
  - [Canonical Key](#canonical-key)
  - [Quant Variant Suffix](#quant-variant-suffix)
  - [Short Form](#short-form)
  - [Absolute Path](#absolute-path)
- [HTTP API Endpoints](#http-api-endpoints)
  - [POST /v1/chat/completions](#post-v1chatcompletions)
  - [POST /v1/completions](#post-v1completions)
  - [POST /v1/embeddings](#post-v1embeddings)
  - [GET /v1/models](#get-v1models)
  - [GET /health](#get-health)
  - [GET /status](#get-status)
  - [POST /v1/models/:model/unload](#post-v1modelsmodelunload)
- [Error Responses](#error-responses)
- [Process Lifecycle](#process-lifecycle)
  - [Instance States](#instance-states)
  - [Single-Flight Loading](#single-flight-loading)
  - [Category-Based VRAM Management](#category-based-vram-management)
  - [Drain & Eviction](#drain--eviction)
  - [Shutdown Behavior](#shutdown-behavior)
- [Hot Path Contract](#hot-path-contract)
- [GGUF Metadata Extraction](#gguf-metadata-extraction)
- [Chat Templates](#chat-templates)
- [Vision / Multimodal Support](#vision--multimodal-support)
- [Running](#running)

---

## Architecture Overview

```
Client (OpenAI SDK, curl, LLM Gateway)
  │  POST /v1/chat/completions  { "model": "qwen/qwen3-32b", ... }
  ▼
Manager (Node.js, port 4080)
  1. Buffer body, parse "model" field only
  2. Resolve model key → .gguf path
  3. ensureModel() — spawn or reuse llama-server
  4. Forward original body bytes (byte-identical)
  5. Pipe response raw back to client
  ▼
llama-server (port 4081+) — native OpenAI API
```

The manager listens on a configurable port (default `4080`). Each `llama-server` instance is assigned a port from a pool starting at `serverPort` (default `4081`). The pool size equals `maxPerCategory.chat + maxPerCategory.embedding`.

---

## Configuration

### config.json — Required Fields

All required fields crash at startup if missing. No fallback defaults.

| Field | Type | Description |
|-------|------|-------------|
| `host` | string | Bind address for the manager (e.g. `"0.0.0.0"`, `"127.0.0.1"`) |
| `port` | number | Manager listen port (client-facing) |
| `serverPort` | number | Start of the port pool for llama-server instances |
| `maxPerCategory` | object | `{ "chat": N, "embedding": N }` — max concurrent instances per category |
| `llamaBuild` | string | Release tag from [llama-cpp-builds](https://github.com/herrbasan/llama-cpp-builds/releases) (e.g. `"b10499"`). Resolved to `builds/<tag>/llama-server.exe`; startup crashes with fetch instructions if missing |
| `modelsDir` | string | Root directory for model discovery (LM Studio folder layout) |

Exactly one of `llamaBuild` or the legacy `llamaServerPath` (direct exe path, deprecated — logs a warning) must be set.

Fetching a build: `npm run fetch-build -- <tag>` downloads the release zip, verifies every file against its sha256 manifest, and extracts to `builds/<tag>/`. Idempotent — re-running verifies the local copy and exits. Old tags stay cached; switching versions is a config change + restart.

### config.json — Optional Defaults

These have explicit defaults if omitted. All can be overridden per-model in `models.json`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultCtxSize` | number | `8192` | Context window size (`-c`) |
| `defaultGpuLayers` | number | `99` | GPU layers to offload (`-ngl`) |
| `defaultThreads` | number | `8` | CPU threads (`-t`) |
| `flashAttention` | boolean | `true` | Enable flash attention (`--flash-attn`) |
| `defaultParallelSlots` | number | `1` | Parallel decode slots (`--parallel`) |
| `defaultBatchSize` | number | `2048` | Batch size (`--batch-size`) |
| `defaultUbatchSize` | number | `512` | Micro batch size (`--ubatch-size`) |
| `firstByteTimeoutMs` | number | `300000` | Max wait for first response byte (5 min). No total timeout on streams. |
| `drainTimeoutMs` | number | `30000` | Max time to wait for in-flight requests before killing an instance |
| `modelScanTtlMs` | number | `60000` | Cache TTL for model directory scans (1 min) |

### models.json — Per-Model Overrides

Optional file at project root. Keys are canonical model keys (case-insensitive match). Any field present overrides the config default for that model.

```json
{
  "qwen/qwen3-embedding-4b-gguf": {
    "ctxSize": 8192,
    "gpuLayers": 99,
    "embedding": true,
    "pooling": "mean",
    "flashAttention": false
  },
  "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive": {
    "ctxSize": 128000,
    "gpuLayers": 99,
    "flashAttention": true,
    "jinja": true
  }
}
```

**Override fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ctxSize` | number | from config | Context window size |
| `gpuLayers` | number | from config | GPU layers to offload |
| `threads` | number | from config | CPU threads |
| `flashAttention` | boolean | from config | Flash attention toggle |
| `parallelSlots` | number | from config | Parallel decode slots |
| `batchSize` | number | from config | Batch size |
| `ubatchSize` | number | from config | Micro batch size |
| `embedding` | boolean | `false` | Enable embedding mode (`--embedding` flag) |
| `pooling` | string \| null | `null` | Pooling type for embeddings (`--pooling`, e.g. `"mean"`, `"cls"`) |
| `mlock` | boolean | `false` | Lock memory (`--load-mode mlock`; requires build ≥ b10499) |
| `mmprojPath` | string \| null | `null` | Vision projector path (auto-detected if `.mmproj` file exists alongside model) |
| `mtpPath` | string \| null | `null` | MTP draft head path for speculative decoding (`--spec-type draft-mtp --spec-draft-model`; auto-detected if `mtp*.gguf` / `*-mtp-*.gguf` file exists alongside model). Requires build ≥ b10499 (Gemma4 MTP, upstream #23398) |
| `specDraftNMax` | number | `4` | Max draft tokens per step when MTP is active (`--spec-draft-n-max`) |
| `jinja` | boolean | `false` | Render the embedded chat template with the Jinja engine (`--jinja`). Required for Gemma 4's macro-heavy template |
| `chatTemplateFile` | string \| null | `null` | Override the embedded template with a file (relative to project root). Implies `--jinja --chat-template-file` |

---

## Model Key Convention

Keys follow the LM Studio folder layout: `modelsDir/publisher/model/file.gguf`.

### Canonical Key

The relative folder path under `modelsDir`:

```
"qwen/qwen3-embedding-4b-gguf"
```

This is the primary identifier. Collisions are impossible by construction since the publisher namespace is part of the key.

### Quant Variant Suffix

Append `@quant` to select a specific quantization level:

```
"qwen/qwen3-32b@q4_k_m"
```

Quant tags are extracted from filenames (e.g. `Qwen3-32B-Q4_K_M.gguf` → `q4_k_m`). If no `@quant` is specified, the **largest** quant (by file size) is used as the default.

### Short Form

A bare model name without the publisher prefix:

```
"qwen3-32b"
```

Resolves only if **unambiguous** — exactly one model across all publishers matches. If multiple publishers have a model with that leaf name, returns `400` listing all matching full keys.

### Absolute Path

A full filesystem path to a `.gguf` file:

```
"D:\\models\\custom.gguf"
```

Used directly without discovery. The containing directory is scanned for `.mmproj` files.

**All matching is case-insensitive** (Windows filesystem semantics).

---

## HTTP API Endpoints

The wrapper exposes 7 endpoints: 3 inference proxies, 3 management endpoints, and 1 model management endpoint. The wrapper does **not** proxy other llama-server endpoints (tokenize, detokenize, slots, metrics, etc.) — it is focused on OpenAI-compatible inference only.

### POST /v1/chat/completions

Standard OpenAI chat completions. The request body is buffered once, the `model` field is extracted, and the original bytes are forwarded byte-identical to the target `llama-server` instance.

**The wrapper is a transparent proxy** — all standard OpenAI parameters are supported (as implemented by `llama-server`): `messages`, `stream`, `temperature`, `top_p`, `max_tokens`, `tools`, `tool_choice`, `response_format`, `seed`, `stop`, `logprobs`, etc. See the [OpenAI Chat Completions API spec](https://developers.openai.com/api/reference/resources/chat) for the full parameter reference.

**Request:**
```json
{
  "model": "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive",
  "messages": [
    { "role": "user", "content": "What is the capital of France?" }
  ],
  "max_tokens": 200,
  "temperature": 0.7,
  "stream": true
}
```

**Behavior:**
1. Buffer body (max 100MB)
2. Parse JSON to extract `model` — this is the **only** field the wrapper inspects
3. Resolve model key → `.gguf` path
4. `ensureModel()` — spawn or reuse `llama-server`
5. Forward original body bytes to llama-server (byte-identical, no transformation)
6. Pipe response raw back to client (supports streaming SSE)

**Response:** Raw passthrough from `llama-server` — standard OpenAI format including `id`, `object`, `created`, `model`, `choices`, `usage`, and streaming SSE chunks with `data: [DONE]` terminator.

**What the wrapper does NOT touch:**
- No payload transformation — request body is forwarded as-received
- No response parsing — SSE chunks flow directly to client
- No parameter validation beyond extracting `model` — llama-server handles all OpenAI parameter semantics
- No tool call interception — tool calls pass through raw

---

### POST /v1/completions

Standard OpenAI text completions (legacy endpoint). Same proxy behavior as chat completions — the request body is forwarded byte-identical to llama-server.

**Note:** This is the legacy completions endpoint (single `prompt` string, not `messages`). For modern chat interactions, use `/v1/chat/completions`.

**Request:**
```json
{
  "model": "publisher/model-name",
  "prompt": "Once upon a time",
  "max_tokens": 100,
  "temperature": 0.8,
  "stream": false
}
```

**Response:** Raw passthrough from llama-server (standard OpenAI completions format).

---

### POST /v1/embeddings

Standard OpenAI embeddings endpoint. The target model must have `"embedding": true` in its `models.json` config.

**Request:**
```json
{
  "model": "qwen/qwen3-embedding-4b-gguf",
  "input": "The capital of France is Paris"
}
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0123, -0.0456, ...]
    }
  ],
  "model": "qwen/qwen3-embedding-4b-gguf",
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

The embedding dimension is determined by the model's GGUF metadata (e.g. 2560 for Qwen3-Embedding-4B), not by any declared value.

---

### GET /v1/models

Lists all discovered models in the `modelsDir` tree. Results are cached for `modelScanTtlMs` (default 60s).

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen/qwen3-embedding-4b-gguf",
      "object": "model",
      "owned_by": "qwen",
      "quants": ["q8_0", "q4_k_m"]
    },
    {
      "id": "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive",
      "object": "model",
      "owned_by": "HauhauCS",
      "quants": ["q4_k_m", "q4_k_s"]
    }
  ]
}
```

**Fields:**
- `id` — canonical model key (publisher/model folder path)
- `owned_by` — publisher (first path segment)
- `quants` — available quantization tags, sorted largest-first

---

### GET /health

Manager-level health check. Reports whether the manager is alive and how many models are currently loaded.

**Response (no models loaded):**
```json
{
  "status": "ok",
  "models_loaded": 0
}
```

**Response (models loaded):**
```json
{
  "status": "ok",
  "models_loaded": 2,
  "instances": [
    { "model": "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive", "port": 4081, "pid": 12345 },
    { "model": "qwen/qwen3-embedding-4b-gguf", "port": 4082, "pid": 12346 }
  ]
}
```

---

### GET /status

Detailed status of all instances and effective configuration.

**Response:**
```json
{
  "instances": [
    {
      "modelKey": "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive",
      "port": 4081,
      "pid": 12345,
      "state": "running",
      "inFlight": 0,
      "category": "chat",
      "config": {
        "ctxSize": 128000,
        "gpuLayers": 99,
        "threads": 8,
        "flashAttention": true,
        "parallelSlots": 1,
        "batchSize": 2048,
        "ubatchSize": 512,
        "embedding": false,
        "pooling": null,
        "mlock": false,
        "mmprojPath": null,
        "jinja": true,
        "chatTemplateFile": null
      }
    }
  ],
  "config": {
    "host": "0.0.0.0",
    "port": 4080,
    "maxPerCategory": { "chat": 1, "embedding": 1 },
    "modelsDir": "D:\\# AI Stuff\\LMStudio_Models",
    "llamaBuild": "b10499"
  }
}
```

**Instance fields:**
- `modelKey` — canonical model key
- `port` — llama-server port
- `pid` — process ID
- `state` — `starting` | `running` | `draining` | `error`
- `inFlight` — number of active proxied requests
- `category` — `chat` or `embedding`
- `config` — effective configuration (defaults + models.json override)

---

### POST /v1/models/:model/unload

Explicitly unload a running model. The model key in the URL must be URI-encoded if it contains special characters (e.g. slashes).

**Request:**
```
POST /v1/models/HauhauCS%2FGemma-4-E4B-Uncensored-HauhauCS-Aggressive/unload
```

**Response (success):**
```json
{
  "message": "Model \"HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive\" unloaded"
}
```

**Response (not loaded):**
```json
{
  "error": "Not Found",
  "details": "Model \"HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive\" is not loaded"
}
```

**Behavior:** Drains in-flight requests (bounded by `drainTimeoutMs`), then kills the `llama-server` process and frees the port.

---

## Error Responses

All errors follow a consistent JSON structure:

```json
{
  "error": "Error Title",
  "details": "Human-readable description of what went wrong"
}
```

| HTTP Status | Error | Cause |
|-------------|-------|-------|
| `400` | `Bad Request` | Empty body, invalid JSON, missing `model` field, body exceeds 100MB |
| `400` | `Model Resolution Failed` | Model key not found, ambiguous short key, quant variant not found |
| `404` | `Not Found` | Unload requested for a model that isn't loaded |
| `500` | `Failed to start model` | llama-server spawn failed, port pool exhausted, category limit with no evictable instance |
| `502` | `Bad Gateway` | llama-server connection refused, proxy request/response error |
| `504` | `Gateway Timeout` | No first byte from llama-server within `firstByteTimeoutMs` |

---

## Process Lifecycle

### Instance States

```
starting → running → draining → (removed)
    ↓
  error → (removed)
```

| State | Meaning |
|-------|---------|
| `starting` | llama-server spawned, health polling in progress |
| `running` | Health check passed, accepting requests |
| `draining` | Marked for death — never handed to new requests. Waiting for in-flight to complete. |
| `error` | Startup failed or crashed |

### Single-Flight Loading

Concurrent requests for the same model share a single spawn promise. If model X is already starting, the second request awaits the same `readyPromise` rather than spawning a duplicate process.

If a concurrent request arrives with **different config** (e.g. different `ctxSize`) while the model is starting, the starting instance is killed and respawned with the new config.

### Category-Based VRAM Management

`maxPerCategory` in `config.json` defines independent limits per category:

```json
{ "chat": 1, "embedding": 1 }
```

- **Chat** and **embedding** slots are independent.
- Requesting a different chat model auto-unloads the previous one (drain + kill). The embedding instance stays untouched.
- Category is determined by the `embedding` boolean in the effective model config.

### Drain & Eviction

When a category limit is reached:

1. The **LRU** (least recently used) instance of the same category is selected as the eviction victim.
2. Its state is set to `draining` — no new requests are routed to it.
3. In-flight requests are given `drainTimeoutMs` (default 30s) to complete.
4. After drain completes (or timeout), the process is killed: `SIGINT` → 5s grace → `taskkill /PID /T /F` (Windows tree kill).
5. Port is returned to the pool.

### Shutdown Behavior

The manager has no detach mode. No `state.json`. When the manager process exits:

1. `SIGINT` handler triggers `killAll()` — drains and kills all instances sequentially.
2. `process.on('exit')` triggers `killAllSync()` — synchronous `taskkill /PID /T /F` for each remaining instance as a last resort.

**Result:** Manager quits → all llama-server processes die. Zero orphans.

---

## Hot Path Contract

The proxy path has strict invariants:

1. **Buffer once, forward original bytes.** The request body is buffered exactly once. The original `Buffer` is sent to llama-server — never `JSON.stringify` of a re-parsed object.
2. **Response is a raw pipe.** No SSE reassembly, no buffering, no parsing. Chunks flow directly from llama-server response to client response.
3. **Client abort propagates upstream.** `req.on('aborted')` → `proxyReq.destroy()` → llama-server cancels the task and releases the slot.
4. **Single-flight model loading.** Concurrent requests for a loading model share one spawn promise.
5. **In-flight tracking.** Every proxied request increments `instance.inFlight`. Kill/evict/swap drains first (bounded by `drainTimeoutMs`).
6. **First-byte timeout only.** A timeout catches hung llama-server instances before headers arrive. No total timeout on streaming responses.

---

## GGUF Metadata Extraction

On model discovery, the first 4MB of each primary `.gguf` file is read and the KV metadata block is parsed. Extracted fields:

| GGUF Key | Extracted As |
|----------|-------------|
| `general.architecture` | `architecture` |
| `general.name` | `general_name` |
| `general.parameter_count` | `parameter_count` |
| `general.file_type` | `file_type` |
| `<arch>.context_length` | `context_length` |
| `<arch>.block_count` | `block_count` |
| `<arch>.embedding_length` | `embedding_dim` |
| `<arch>.pooling_type` | `pooling_type` |

The parser handles all GGUF value types (UINT8 through FLOAT64, STRING, ARRAY) with bounds checking at every step. If the buffer is exhausted mid-parse, parsing stops gracefully — partial metadata is returned.

---

## Chat Templates

Models use their own embedded chat template by default. Two `models.json` flags control template handling:

- **`jinja: true`** — render the embedded template with the Jinja engine (`--jinja`). Gemma 4's macro-heavy embedded template requires this.
- **`chatTemplateFile`** — replace the embedded template with a file (for models that genuinely ship a broken template). Implies `--jinja --chat-template-file`.

```json
{
  "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive": {
    "jinja": true
  }
}
```

Do not add a hand-written `chatTemplateFile` just to "fix" tool calling — a template that omits the model's tool sections breaks tool calling.

---

## Vision / Multimodal Support

The manager auto-detects `.mmproj` (vision projector) files during model discovery. If a `.mmproj` file exists in the same directory as the model `.gguf`, its path is automatically passed to llama-server via `--mmproj`.

The `mmprojPath` can also be set explicitly in `models.json` to override auto-detection.

---

## MTP Speculative Decoding

Models that ship an MTP (multi-token prediction) draft head get automatic speculative
decoding. Discovery: any `mtp*.gguf` / `*-mtp-*.gguf` file in the model directory is
excluded from quant variants and wired via `--spec-type draft-mtp --spec-draft-model`.
Requires build ≥ b10499 (Gemma4 MTP landed upstream 2026-06-07, #23398). Dense models
see ~2x tok/s; output is probabilistically identical (verification keeps quality).

The `mtpPath` can also be set explicitly in `models.json` to override auto-detection;
`specDraftNMax` (default 4) controls draft length.

---

## Running

```bash
npm start                    # Start the manager
node tests/smoke.js          # Quick smoke test
node tests/comprehensive.js  # Full test suite (88 tests, manager must be running)
node tests/test-shutdown.js  # Clean shutdown test
```

**Critical: spawn cwd must be the binary's directory.** `GGML_BACKEND_DL=ON` builds use `LoadLibrary` to dynamically load `ggml-cuda.dll`. This searches CWD, not the exe's directory. The manager sets `cwd: path.dirname(config.llamaServerPath)` when spawning llama-server. Without this, CUDA silently falls back to CPU.
