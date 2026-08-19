# Dev Plan v2 — llama-cpp-wrapper Rewrite

**Date:** 2026-07-12  
**Status:** Planning

---

## Goal

A reliable, performant local inference gateway that:

1. Runs a **recent llama.cpp** build (easy to update)
2. Exposes a **strictly OpenAI-spec-compliant API** (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`)
3. Supports **CUDA, CPU, and Vulkan** backends (Vulkan for Intel Arc A770)
4. Manages multiple model instances with automatic lifecycle (load, swap, health-check)
5. Is **zero-dependency Node.js** — standard library only

---

## What Went Wrong (v1 Postmortem)

### Architecture confusion
The project ended up with **two conflicting architectures** bolted together:
- A **header-driven proxy** (`server.js` + `process.js`) where the upstream LLM Gateway sends `X-Model-*` headers and the manager spawns/swaps `llama-server` processes transparently.
- An **adapter layer** (`src/adapters/llamacpp.js`) designed for the LLM Gateway's old provider-adapter pattern, with its own payload construction, `<think>` tag parsing, token counting, and streaming logic.

These two never cleanly separated. The adapter constructs OpenAI payloads and adds headers, then the manager proxies the raw body to `llama-server` — which already speaks OpenAI natively. The adapter is an unnecessary transformation layer that duplicates what `llama-server` already does.

### Embedding problems were never root-caused
The embedding degradation investigation (`docs/local-llama-embedding-degradation.md`) documented 6 hypotheses but verified none. The real issue was likely a combination of:
- The adapter and manager disagreeing on pooling/batch parameters
- Config dimension mismatch (4096 declared vs 2560 actual)
- No way to call the server directly for controlled testing (the `X-Model-Path` header requirement made direct curl impossible without the manager in the middle)

### Defensive code accumulation
`server.js` grew to 640+ lines with embedding circuit breakers, trace logging, body shape summaries, concurrency gates, and failure state maps — all layered on top of what should be a simple proxy. These were band-aids for instability that originated in the adapter/process mismatch.

### Build system is fragile
The single `build-universal.ps1` hardcodes VS paths, always does a clean build (slow), and has no way to selectively build for CPU-only, CUDA-only, or Vulkan-only. Updating llama.cpp requires manual submodule updates and hand-verification.

---

## What's Worth Keeping

### 1. Core process lifecycle design (`process.js`)
The fundamental design is sound:
- `Map<modelPath, instance>` for tracking running processes
- `ensureModel()` → check existing → validate config match → spawn if needed
- Health poll loop (1s interval, 120s timeout) waiting for `starting` → `running`
- `configsMatch()` compares all options — config change triggers restart
- Port allocation counter (monotonic, avoids conflicts)
- Detach/reattach for surviving manager restarts

**Keep this pattern.** It's the right abstraction.

### 2. Model resolution (`models.js`)
The resolution logic is well-designed:
- Short name → recursive folder search
- Relative path → resolve under `modelsDir`
- Auto-detect `.mmproj` in model folder
- GGUF metadata extraction from first 2MB (architecture, context_length, parameter_count)
- Cache resolution results

**Keep this.** Maybe simplify the tune-results enrichment.

### 3. Zero-proxy principle
The insight that `llama-server` already speaks OpenAI natively is correct. The manager should be a **thin transparent proxy** — pipe the request body raw to `llama-server`, pipe the response back. Zero parsing, zero transformation. The `proxyToInstance()` function with its `completed` flag for exactly-once response is the right pattern.

### 4. Config-driven everything
All defaults in `config.json`, overridable per-request via headers. The `normalizeConfig()` → `buildArgs()` → `configsMatch()` pipeline is the right structure.

### 5. Build approach (not the script itself)
Using a `llama.cpp` git submodule + CMake + Ninja is correct. The build script needs restructuring (below), but the approach is sound.

### 6. Conservative stability defaults
- `parallelSlots: 1` (sequential, no races)
- `kvUnified: false`
- `ctxCheckpoints: 0`
- `flashAttention: true` for chat, `false` for embeddings

These were hard-won. Keep them.

---

## New Architecture

### Design principle: The manager IS the OpenAI API

No adapter layer. No payload transformation. The manager presents itself as a standard OpenAI-compatible endpoint. Clients send standard OpenAI requests. The manager:

1. Reads the `model` field from the request body to select which model to load
2. Spawns/swaps `llama-server` processes as needed
3. Proxies the request body raw to `llama-server`
4. Proxies the response raw back to the client

```
Client (OpenAI SDK, curl, anything)
  │
  │  POST /v1/chat/completions
  │  { "model": "qwen3-32b", "messages": [...], "stream": true }
  │
  ▼
┌──────────────────────────────────┐
│  Gateway Manager (Node.js)       │
│                                  │
│  1. Parse `model` from body      │
│  2. Resolve to .gguf path        │
│  3. ensureModel() — spawn/swap   │
│  4. Proxy request raw → backend  │
│  5. Proxy response raw → client  │
│                                  │
│  Zero payload transformation     │
└──────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────┐
│  llama-server (port 4081+)       │
│  Native OpenAI API               │
└──────────────────────────────────┘
```

### Hot path contract

Reading `model` from the body means the request body **must be buffered** — pure stream-through of the request is impossible. Resolve the apparent contradiction with "zero transformation" explicitly:

1. **Buffer once, parse once, forward original bytes.** Read the full request body into one Buffer. `JSON.parse` it *only* to extract `model` (missing/unknown `model` → 400, fail loud). Then forward the **original buffer** unchanged — never `JSON.stringify` a re-parsed object. Byte-identical forwarding preserves `Content-Length` and makes transformation bugs impossible by construction.
2. **Response is a raw pipe.** llama-server's response streams straight to the client. No parsing, no SSE reassembly, no buffering. `socket.setNoDelay(true)` on both legs — per-token SSE latency matters.
3. **Client abort propagates upstream.** Client disconnects mid-stream → abort the upstream request immediately so llama-server stops generating. A cancelled request that keeps burning GPU for minutes is a performance bug.
4. **Single-flight model loading.** Concurrent requests for a model that is still loading await the *same* spawn/health promise. Never two spawns for one model, never one poll loop per request.
5. **In-flight tracking per instance.** Each instance counts active proxied requests. Swap, evict, and shutdown drain first (wait for count → 0, bounded by `drainTimeoutMs`) before killing. Killing an instance mid-request is the exception path, never routine.
6. **Timeout policy:** no total timeout on streaming responses (long generations are legitimate). A first-byte timeout (`firstByteTimeoutMs`, default 300s) catches a hung llama-server.

### Model selection: body `model` field, not headers

v1 used `X-Model-Path` headers (which the LLM Gateway supplied). v2 uses the standard OpenAI `model` field from the request body. This means **any OpenAI-compatible client works without modification**.

**Model keys follow the LM Studio convention** — the key is the relative folder path, not the leaf folder name:

- Canonical key: `publisher/model` (e.g. `"qwen/qwen3-embedding-4b-gguf"`), derived from `modelsDir/<publisher>/<model>/*.gguf`. Collisions are impossible by construction — the publisher namespace is part of the identity.
- Quant disambiguation: multiple `.gguf` files in one folder are **quant variants of the same model**, not separate models. Select one with an `@quant` suffix: `"qwen/qwen3-32b@q4_k_m"` (quant tag parsed from the filename). Without a suffix: if one file, use it; if several, pick the largest quant and log the choice.
- Convenience short form: a bare leaf name (`"qwen3-32b"`) resolves if it's unambiguous across publishers; ambiguous → 400 listing the matching full keys. Fail loud, never guess.
- Absolute `.gguf` path (`"D:\\models\\custom.gguf"`) → used directly.
- Matching is case-insensitive (Windows filesystem semantics).

Per-model config overrides come from a `models.json` registry (not headers), keyed by the same `publisher/model` key:
```json
{
  "qwen/qwen3-embedding-4b-gguf": {
    "ctxSize": 32000,
    "gpuLayers": 99,
    "embedding": true,
    "pooling": "mean",
    "flashAttention": false
  }
}
```

### Endpoints

| Method | Path | Behavior |
|--------|------|----------|
| `POST` | `/v1/chat/completions` | Proxy to `llama-server` (streaming supported) |
| `POST` | `/v1/completions` | Proxy to `llama-server` |
| `POST` | `/v1/embeddings` | Proxy to `llama-server` |
| `GET` | `/v1/models` | List discovered models from `modelsDir` |
| `GET` | `/health` | Manager + instance health |
| `GET` | `/status` | Running instances, ports, metrics |
| `POST` | `/v1/models/{model}/unload` | Explicit model unload |

### File structure

```
llama-cpp-wrapper/
├── config.json                  # All defaults
├── models.json                  # Per-model overrides (OPTIONAL — auto-scan is the default)
├── package.json                 # type: module, zero deps
├── AGENTS.md
├── README.md
│
├── src/
│   ├── server.js                # HTTP server, routing, proxy (≤200 lines)
│   ├── process.js               # Process lifecycle: spawn, health, kill (NO state.json)
│   ├── models.js                # Discovery, resolution, GGUF metadata
│   ├── config.js                # Config loading + defaults
│   └── modules/
│       └── nLogger/             # Git submodule — Process Manager reads these logs
│
├── build/
│   ├── build.ps1                # Unified build script (see below)
│   └── README.md
│
├── llama.cpp/                   # Git submodule (pinned)
│
├── dist/                        # Built binaries (gitignored or LFS)
│   └── universal/
│       ├── llama-server.exe
│       └── *.dll
│
├── scripts/
│   └── tune.js                  # Model benchmarking (optional)
│
├── docs/
│   └── dev-plan-v2.md           # This file
│
└── tests/
    └── smoke.js                 # End-to-end: load model, chat, embed
```

**No `state.json`.** No `src/adapters/`.

**Key simplification:** No `src/adapters/` — deleted entirely. No `state.json` complexity unless detach is needed.

**Logging stays on nLogger** (git submodule at `src/modules/nLogger/`): the Process Manager reads its rolling JSON Lines files in `logs/` for a live overview of running services. This ecosystem integration outweighs the submodule cost. Clone step: `git submodule update --init --recursive`. Per-instance llama-server stderr feeds into nLogger so crashes are visible in the Process Manager too.

---

## Build System

### Problem with v1
- Single monolithic script, always clean build (10+ min)
- Hardcoded VS paths
- No way to build CPU-only or Vulkan-only
- Updating llama.cpp requires manual git operations

### v2 Build design

**`build/build.ps1`** with parameters:

```powershell
# Full build (CUDA + Vulkan + CPU) — default
.\build\build.ps1

# CPU only (fastest, for testing)
.\build\build.ps1 -Backend cpu

# CUDA only
.\build\build.ps1 -Backend cuda

# Vulkan only (Intel Arc)
.\build\build.ps1 -Backend vulkan

# Update llama.cpp to latest release, then build
.\build\build.ps1 -Update

# Pin to specific tag
.\build\build.ps1 -Tag b9119

# Incremental build (no clean)
.\build\build.ps1 -Incremental
```

**Backend matrix:**

| Backend | CMake Flags | Use Case |
|---------|-------------|----------|
| `cpu` | `GGML_NATIVE=ON` | Local dev/test builds only — **never distributed** |
| `cuda` | `GGML_CUDA=ON GGML_NATIVE=OFF` | NVIDIA GPUs |
| `vulkan` | `GGML_VULKAN=ON GGML_NATIVE=OFF` | Intel Arc A770, AMD GPUs |
| `universal` | `GGML_CUDA=ON GGML_VULKAN=ON GGML_NATIVE=OFF GGML_BACKEND_DL=ON GGML_CPU_ALL_VARIANTS=ON` | All backends, runtime selection |

**Portability constraint:** the universal binary is built on Badkid and copied to Fatten — different CPUs. `GGML_NATIVE=ON` bakes in `-march=native` for the build machine and can hit illegal instructions on the target. Universal builds use `GGML_BACKEND_DL=ON` + `GGML_CPU_ALL_VARIANTS=ON` so CPU kernel variants are selected at runtime. Only the local `cpu` dev build may use `GGML_NATIVE=ON`.

**VS detection:** locate the toolchain via `vswhere.exe` (`${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`). Never hardcode edition paths (v1 hardcoded Professional with a BuildTools fallback — breaks on Community).

**Post-build verification (mandatory):**
1. Run `dist/<backend>/llama-server.exe --version` — catches missing DLLs at build time, not first request.
2. Write `dist/<backend>/build-info.json`: `{ tag, commit, backends, builtAt, machine }`. The manager's `/status` endpoint reports it, so it's always known which binary is serving.

**Update workflow:**
```powershell
# Update to latest release tag
.\build\build.ps1 -Update

# This internally runs:
# 1. cd llama.cpp && git fetch --tags
# 2. git checkout $(latest tag)
# 3. git submodule update --init --recursive
# 4. Build
# 5. Post-build verification: llama-server --version + write build-info.json
# 6. Report new version
```

**Output:** Always `dist/universal/` (or `dist/cuda/`, `dist/vulkan/`, `dist/cpu/` for single-backend builds). The `config.json` `llamaServerPath` points to whichever build you want to use.

---

## Implementation Phases

### Phase 1: Skeleton (Day 1)
- [ ] New `config.js` — load config.json, define defaults
- [ ] Carry over `nLogger` submodule (`src/modules/nLogger/`) — session-based log files the Process Manager reads
- [ ] New `server.js` — HTTP server with routing, model field extraction, raw proxy
- [ ] New `process.js` — port from v1 with simplifications (remove embedding circuit breaker complexity)
- [ ] New `models.js` — port from v1, keep resolution + metadata, drop tune enrichment
- [ ] Basic `config.json` and `models.json`
- [ ] Startup fail-fast validation: binary exists + `--version` runs, `modelsDir` exists, port bindable, orphan sweep
- [ ] Smoke test: start manager, send curl chat completion, verify response

### Phase 2: Build System (Day 1-2)
- [ ] `build/build.ps1` with `-Backend`, `-Update`, `-Tag`, `-Incremental` parameters
- [ ] Auto-detect VS install path (don't hardcode)
- [ ] Verify CUDA + Vulkan build works
- [ ] Verify CPU-only build works
- [ ] Document update workflow

### Phase 3: OpenAI Compliance (Day 2-3)
- [ ] Verify `/v1/chat/completions` streaming works with OpenAI Python SDK
- [ ] Verify `/v1/embeddings` returns correct format
- [ ] Verify `/v1/models` listing
- [ ] Test with a real client (the LLM Gateway, or direct SDK calls)
- [ ] Embedding acceptance gates 1–5 (see "Embedding Correctness" section) — determinism, dimension, pooling, discrimination, quantization
- [ ] Client abort propagation: cancel a streaming request mid-generation, verify llama-server stops (GPU load drops)

### Phase 4: Reliability (Day 3)
- [ ] **Clean shutdown is the #1 priority:** drain → kill → verify exit → `taskkill /T /F` fallback → verify ports freed. No orphans, no zombies. Test by killing the manager mid-request. (See Decision 1 for the Windows-accurate sequence.)
- [ ] Process crash detection and cleanup (child exit handler)
- [ ] Per-instance stderr ring buffer (last ~100 lines): on crash (e.g. exit code 3221226505), the failing request's error response and the log carry the stderr tail
- [ ] Crash during startup poll fails pending requests **immediately** with the stderr tail — never wait out the 120s health timeout on a dead child
- [ ] Single-flight loading: N concurrent requests for a cold model → exactly 1 spawn
- [ ] Health check endpoint
- [ ] Config mismatch → automatic restart (with in-flight drain first)
- [ ] Max instances enforcement + LRU eviction (with in-flight drain first)

### Phase 5: Polish (Day 4+)
- [ ] `README.md` — setup, build, usage
- [ ] `AGENTS.md` — architecture briefing
- [ ] Optional: detach/reattach (only if needed)
- [ ] Optional: model benchmarking script
- [ ] Optional: web UI for status

---

## Embedding Correctness — Acceptance Gates

The v1 embedding degradation (`docs/local-llama-embedding-degradation.md`) was never root-caused because nothing was verifiable: direct curl was impossible (header protocol), dimensions were declared not measured, pooling was assumed not confirmed. v2 makes correctness testable. **Embeddings are not "done" until all five gates pass:**

1. **Determinism.** Same text embedded 20× against the llama-server port *directly* → bit-identical vectors (cosine = 1.0000). Then the same 20× through the manager → identical again. Any variance is a bug; stop and root-cause before proceeding.
2. **Dimension check.** Response vector length must equal the embedding dimension read from GGUF metadata. Mismatch → startup error, not a silent 4096-declared-vs-2560-actual confusion.
3. **Pooling verification.** Spawn args must carry the correct `--pooling` — from `models.json` override, or GGUF `pooling_type` metadata when present. Log the effective pooling at spawn. An embedding model with unknown pooling is a startup error, not a guess.
4. **Discrimination sanity.** Reuse the v1 phrase-pair table: `"pizza"`↔`"quantum physics"` must score well below `"AI"`↔`"machine learning"`. Record expected bands from a remote reference (`or-qwen-embed`) once, assert against them in `tests/smoke.js`.
5. **Quantization isolation.** If quality is still off after gates 1–4 pass, compare Q8_0 vs Q4_K_M of the same model *before* blaming gateway code.

**Throughput note:** llama-server historically decodes embedding prompts inefficiently, and `--parallel` only adds completion slots — it does not batch a single request. Prefer batching many inputs into one request (OpenAI `input: [...]` array form, which llama-server supports). Benchmark `--parallel > 1` for *embedding-only* instances separately — it was a crash source for chat in v1 (`0xC0000005`), but embedding instances may tolerate it. Chat stays at `parallelSlots: 1`.

---

## Config Schema (v2)

```json
{
  "host": "0.0.0.0",
  "port": 4080,
  "serverPort": 4081,
  "maxInstances": 4,

  "llamaServerPath": "dist/universal/llama-server.exe",
  "modelsDir": "D:\\AI\\Models",

  "defaultCtxSize": 8192,
  "defaultGpuLayers": 99,
  "defaultThreads": 8,
  "flashAttention": true,

  "defaultParallelSlots": 1,
  "defaultBatchSize": 2048,
  "defaultUbatchSize": 512,

  "firstByteTimeoutMs": 300000,
  "drainTimeoutMs": 30000,
  "modelScanTtlMs": 60000
}
```

**Startup fail-fast checks** (before the server listens — any failure crashes with the specific missing thing, no `||` defaults for required fields):

1. `config.json` parses; all required fields present.
2. `llamaServerPath` exists **and** `llama-server --version` executes successfully — catches missing DLLs immediately, not on first request.
3. `modelsDir` exists and contains ≥1 `.gguf`.
4. Manager port bindable; instance port range swept for orphans.

**No `detachOnShutdown`.** No embedding-specific circuit breakers, crash cooldowns, trace flags, or body shape logging. If the server crashes, we surface the error. If embedding quality is bad, we fix the root cause (pooling, quantization, model config) — not paper over it with retry logic.

---

## What Gets Deleted

| Component | Why |
|-----------|-----|
| `src/adapters/llamacpp.js` | Unnecessary transformation layer. `llama-server` speaks OpenAI natively. |
| Embedding circuit breaker (`server.js` lines 1-100) | Band-aid for instability. Fix root cause instead. |
| Embedding trace/body shape logging | Debugging scaffolding that became permanent. |
| `X-Model-*` header protocol | Replaced by standard `model` field in request body. |
| `benchmark-embed.js` (root) | Ad-hoc script, rewrite as proper test if needed. |
| `start-llama.bat` | Manual launcher, replaced by proper config-driven startup. |
| `state.json` + `restoreState()` | No detach mode. Manager quits → all processes die. |
| `detachOnShutdown` config | Same reason. |
| `_Archive/` | Historical artifacts. |
| `HANDOVER.md` | Build handover — replaced by better build docs. |

---

## Decisions (Resolved)

### 1. No detach/reattach — clean shutdown is mandatory

Manager quits → all `llama-server` processes die. No `state.json`, no detach mode, no reattach. This must be **reliable** — no orphaned processes, no zombie ports. The shutdown path is a first-class concern:

Windows reality check: Node's signals to children are **simulated** — `child.kill('SIGINT')` on a `windowsHide` child is effectively a hard terminate, and grandchildren are not covered. The sequence that actually works:

- Manager receives `SIGINT`/`SIGTERM` → drain in-flight requests (bounded by `drainTimeoutMs`) → `child.kill()` each instance → wait for the `exit` event (~5s timeout) → if still alive, `taskkill /PID <pid> /T /F` (tree kill) → confirm PID gone.
- `process.on('exit')` last resort: synchronous `spawnSync('taskkill', ...)` for any PID still tracked.
- Uncaught exception → same shutdown sequence, then re-throw.
- **Startup orphan sweep:** on manager start, probe every port in the instance range (`serverPort` … `serverPort + maxInstances`). Anything responding to `/health` is an orphan from a previous crash → kill it (or refuse to start with a clear error). Never silently allocate around occupied ports.
- Test cases: kill manager mid-request; kill while a model is still loading; Ctrl+C twice in rapid succession. After each: zero `llama-server.exe` processes, all ports free.

**Delete from v1:** `detachOnShutdown`, `state.json`, `restoreState()`, `killInstance({ detached: true })` path.

### 2. LLM Gateway is the only client

This gateway lives behind the LLM Gateway as a provider endpoint. No direct calls from end users. The LLM Gateway sends standard OpenAI requests to `http://localhost:4080` — no special headers, no `X-Model-*` protocol. The `model` field in the request body selects the model.

The LLM Gateway's provider config for this endpoint becomes simply:
```json
{
  "type": "openai-compatible",
  "endpoint": "http://localhost:4080",
  "apiKey": "not-needed"
}
```

No adapter code needed on either side. The LLM Gateway already knows how to talk to OpenAI-compatible endpoints.

### 3. Model registry: auto-parse LM Studio folder structure

Keep the LM Studio-style folder layout support (`modelsDir/Publisher/Model/Model-Q4_K_M.gguf`), but **no hand-maintained `models.json`**. Instead:

- On startup and on `/v1/models` requests: scan `modelsDir` recursively for `.gguf` files. Scan results are cached with a TTL (`modelScanTtlMs`, default 60s) — a recursive directory walk must never sit on the inference hot path. Model-name → path resolution stays cached per name, as in v1.
- Parse GGUF metadata (architecture, context_length, parameter_count, embedding flag, embedding dimension, pooling_type if present).
- Auto-generate the model registry in memory from the scan.
- Model key for the `model` field = **relative path `publisher/model`** (LM Studio convention, e.g. `qwen/qwen3-embedding-4b-gguf`). `/v1/models` lists these keys. No collision handling needed — the publisher namespace makes keys unique by construction.
- Multiple `.gguf` files in one folder = quant variants of one model, selectable via `@quant` suffix (`qwen/qwen3-32b@q4_k_m`, LM Studio's `lms` convention). Default without suffix: largest quant, logged.

Optional: a `models.json` override file for per-model config that can't be auto-detected (e.g., `pooling: mean`, custom `ctxSize`). If a model appears in both, the override wins. This file is **optional** — everything works without it.

### 4. Build on Badkid (RTX 4090), test on Fatten (Intel Arc A770)

Build machine: **Badkid** — has CUDA toolkit, Vulkan SDK, VS 2022. Builds all backends into `dist/universal/`.

Test machine: **Fatten** — Intel Arc A770. Tests Vulkan backend specifically.

The build script should:
- Build the universal binary (CUDA + Vulkan + CPU) on Badkid.
- The same binary runs on Fatten — `llama-server` selects the backend at runtime via `--n-gpu-layers` and available drivers.
- No separate build needed on Fatten. Just copy `dist/universal/` and run.

Vulkan verification happens in Phase 3 (OpenAI compliance testing) — run on Fatten after deploying the built binary there.
