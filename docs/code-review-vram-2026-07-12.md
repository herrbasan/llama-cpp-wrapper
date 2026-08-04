# Code Review — VRAM Management & Category Limits

**Date:** 2026-07-12
**Reviewer:** Claude (dev-plan author) — review of GLM's implementation
**Scope:** `src/process.js`, `src/server.js`, `src/config.js`, `models.json`, VRAM coexistence planning

---

## Verdict Summary

| Question | Answer |
|---|---|
| Q1 Category-based limits? | **Yes.** Derive category from existing `embedding` flag. Replace `maxInstances` entirely. |
| Q2 VRAM-aware eviction (nvidia-smi)? | **No.** Racy, CUDA-only (breaks Vulkan/Arc target), unestimatable. |
| Q3 Auto-swap vs explicit unload? | **Auto-swap.** Matches existing semantics. Keep `/unload` as manual override. |
| Q4 Code issues? | 1 real race (A), 5 smaller issues (B–F) below. |
| Q5 Missed anything? | **Yes — the arithmetic.** 1 chat + 1 embedding at original configs = 32 GB > 24 GB. Config changes required (done, see VRAM section). |

**Priority order:** VRAM config fix (done) → A (swap race) → category limits → B/C (port pool, PID-scoped sweep) → E/F/D polish.

---

## Q1: Category-Based Limits — Design

The category signal already exists: `modelConfig.embedding === true`. No new metadata.

```json
// config.json — replaces "maxInstances"
"maxPerCategory": { "chat": 1, "embedding": 1 }
```

- `category = modelConfig.embedding ? 'embedding' : 'chat'`
- **Delete** `maxInstances`. Two overlapping limit mechanisms = ambiguous interactions. One eviction rule, one code path.
- Eviction rule: when spawning category X at its limit → drain + kill the LRU instance *of category X*. Deterministic; two chat models coexisting becomes structurally impossible.
- This is "design failures away": VRAM overcommit for the known model set is prevented by construction, not detected at runtime.

## Q2: VRAM-Aware Eviction — Rejected

1. **TOCTOU race** — free VRAM at check time ≠ free VRAM during llama-server's gradual allocation.
2. **`nvidia-smi` does not exist on the Vulkan target** (Fatten, Intel Arc A770). A CUDA-only mechanism forks the code path per backend.
3. **Required-VRAM estimation is genuinely hard** (weights + KV + compute buffers + fragmentation).

If a budget is ever needed: declared `vramEstimate` per model in `models.json` summed against a configured budget — declarative, backend-agnostic. Not needed with 1+1 category limits.

## Q3: Auto-Swap — Confirmed

Auto-swap is already the system's semantics (config mismatch auto-restarts; LRU auto-evicts). Explicit unload would force clients to understand manager internals, breaking the core promise: *any OpenAI client works unmodified*. Keep `POST /v1/models/:model/unload` as manual override only.

---

## Q4: Code Findings

### A. Swap race — requests routed to a dying instance (MUST FIX)

`killInstance()` drains up to 30s (`drainTimeoutMs`). During that await, a new request for the same model enters `ensureModel()`, sees `state === 'running'` + matching config, and is handed the instance being killed. Under steady traffic, new requests keep incrementing `inFlight` → **drain never reaches 0** → timeout → kill mid-request → 502s.

**Fix:**
1. Add `'draining'` state, set at the top of `killInstance()`. `ensureModel()` must never return a draining instance — await its death, then proceed to spawn.
2. Serialize `ensureModel`'s decision section (check → evict → spawn-dispatch) through a promise-chain mutex. The decision is cheap; only the decision holds the lock. Health-waiting stays on `readyPromise` (single-flight unchanged). Without this, two concurrent requests for cold model B while A drains can both pass the checks.

### B. Port allocation vs orphan sweep mismatch

`nextPort` increments forever; `sweepOrphans()` only probes `serverPort .. serverPort + maxInstances`. After a few swaps an instance lives on e.g. port 4093 — a crash + restart misses it.

**Fix:** allocate from a fixed pool of N ports, freed on kill. Sweep range becomes exact by construction.

### C. `taskkill /IM llama-server.exe /F` is machine-wide

Kills every llama-server on the machine, including manually launched or foreign instances. Out of project scope.

**Fix:** resolve PID from port ownership (`Get-NetTCPConnection -LocalPort X → OwningProcess`), kill by PID. Remove the decorative `/slots` DELETE attempt.

### D. `readyReject` is dead code

The child exit handler calls `instance.readyReject(...)` but nothing ever assigns it. Crash-during-startup detection actually works via `pollUntilHealthy` noticing `state === 'error'` on its next 1s tick — correct but up to 1s slower than the plan's "fail immediately". Wire it properly or delete the branch.

### E. Wrong exit code on crash

`uncaughtException → gracefulShutdown()` → `process.exit(0)`. A crash exits with success. Give `gracefulShutdown(signal, exitCode)` a code parameter.

### F. Response-leg header forwarding + missing setNoDelay

`res.writeHead(proxyRes.statusCode, proxyRes.headers)` forwards hop-by-hop headers (`connection`, `transfer-encoding`, `keep-alive`). Node de-chunks the upstream body; re-declaring `transfer-encoding: chunked` relies on Node re-framing behavior. **Strip the RFC 7230 hop-by-hop set** before `writeHead`. Also: the dev plan's hot-path contract specifies `socket.setNoDelay(true)` on both legs (per-token SSE latency) — missing from the implementation.

### Confirmed correct

- Single-flight cold loads (map entry set synchronously in `spawnInstance`)
- Drain-before-kill ordering
- Buffer-once / forward-original-bytes (byte-identical)
- Client abort propagation (`aborted` + `res close` both covered)

---

## VRAM Budget — Measured Weights & Coexistence Math

**Hardware:** RTX 4090, 24 GB VRAM. Weights measured from disk 2026-07-12.

| Model | Weights | Est. total VRAM @ configured ctx |
|---|---|---|
| HauhauCS/Gemma-4-E4B-Uncensored | 4.97 GB | **~10–12 GB @ 128K** ← the "~12 GB" chat model |
| HauhauCS/Qwen3.6-27B-Uncensored | 10.73 GB | ~15–17 GB @ 128K |
| llmfan46/gemma-4-26B-A4B-heretic | 14.40 GB | ~21 GB @ 128K |
| llmfan46/Qwen3.6-27B-heretic-v2 | 14.52 GB | ~21 GB @ 128K |
| groxaxo/Huihui-gemma-4-26B-A4B | 15.27 GB | ~21.5 GB @ 128K |
| Qwen/Qwen3-Embedding-4B | 2.33 GB | ~8–9 GB @ 32K → **~4.5 GB @ 8K** |
| Qwen/Qwen3-Embedding-8B | 4.36 GB | ~11 GB @ 32K → ~6.5 GB @ 8K |

**Config change applied (2026-07-12):** both embedding models `ctxSize: 32000 → 8192` in `models.json`. Embedding inputs are chunks, not conversations — 32K ctx bought nothing and cost ~4–5 GB.

### Coexistence scenarios (1 chat + 1 embedding)

| Chat model | Embedding | Total | Fits 24 GB? |
|---|---|---|---|
| Gemma-4-E4B @ 128K | Embed-4B @ 8K | ~15–16 GB | ✅ comfortable |
| Qwen3.6-27B (HauhauCS) @ 128K | Embed-4B @ 8K | ~20–21 GB | ✅ tight-ok |
| gemma-4-26B-A4B @ 128K | Embed-4B @ 8K | ~26 GB | ❌ |
| gemma-4-26B-A4B @ ~64K | Embed-4B @ 8K | ~23 GB | ⚠️ borderline |
| Any 26B @ 128K, embedding swapped out | — | ~21.5 GB | ✅ (swap on demand) |

### Recommended test setup

- **Chat:** `HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive` @ 128K — the coexistence-friendly option
- **Embedding:** `qwen/qwen3-embedding-4b-gguf` @ 8192
- Verify with `nvidia-smi --query-gpu=memory.used --format=csv,noheader` after both are loaded: expect ~15–16 GB.
- Then test category auto-swap: request `llmfan46/gemma-4-26B-A4B-heretic` → E4B drains + unloads, 26B loads, embedding instance stays untouched.

### Long-term plan

Embeddings move to **Fatten (Intel Arc A770, Vulkan build)**. The 4090 then serves chat exclusively — 26B models run at full 128K ctx uncontested. This is what the `-Backend vulkan` path in `build/build.ps1` exists for. The category-limit design carries over unchanged: each machine's manager enforces its own limits.

### Spawn-time transparency (recommended)

The manager stays out of VRAM estimation (Q2), but must not be silent: log one line per spawn stating **category, effective ctxSize, and weights file size**. VRAM fit is the operator's responsibility — the log gives the operator what they need.
