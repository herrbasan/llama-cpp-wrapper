# AGENTS.md — llama-cpp-wrapper

> **LLM briefing:** Read this first. It contains the project intent, architecture, and key constraints.

## What This Is

A zero-dependency Node.js process manager for `llama-server`. It presents itself as a standard OpenAI-compatible API endpoint. Clients send standard OpenAI requests; the manager spawns/swaps `llama-server` processes and proxies requests/responses raw — zero payload transformation.

## Why It Exists

The v1 (`llama-cpp-gateway`) had two conflicting architectures bolted together: a header-driven proxy and an adapter layer. The adapter duplicated what `llama-server` already does natively (OpenAI API). Embedding degradation was never root-caused because direct testing was impossible (custom header protocol). See `docs/_Archive/local-llama-embedding-degradation.md` for the historical investigation.

V2 eliminates the adapter entirely. The manager IS the OpenAI API.

## Architecture

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

### Hot Path Contract

1. **Buffer once, forward original bytes.** Never `JSON.stringify` a re-parsed object.
2. **Response is a raw pipe.** No SSE reassembly, no buffering.
3. **Client abort propagates upstream.** Cancelled requests stop burning GPU.
4. **Single-flight model loading.** Concurrent requests for a loading model share one spawn promise.
5. **In-flight tracking.** Kill/evict/swap drains first (bounded by `drainTimeoutMs`).
6. **First-byte timeout only.** No total timeout on streams.

## Source Files

| File | Responsibility | Key constraint |
|------|---------------|----------------|
| `src/config.js` | Load + validate config.json | Required fields crash at startup if missing |
| `src/models.js` | Model discovery, resolution, GGUF metadata | LM Studio key convention (`publisher/model@quant`) |
| `src/process.js` | Process lifecycle: spawn, health, kill | Windows-accurate shutdown (`taskkill /T /F`), stderr ring buffer |
| `src/server.js` | HTTP server, routing, raw proxy | ≤200 lines target, zero payload transformation |
| `bin/init.js` | `npm run init -- <modelsDir>` — fetch build + create config.json | |
| `bin/fetch-build.js` | Download + hash-verify a llama-cpp-builds release | Tag optional — latest release via GitHub API |
| `src/modules/nLogger/` | Git submodule — rolling JSON Lines logger | Process Manager reads these logs |

## Endpoint Scope

The wrapper proxies **3 inference endpoints** only:
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/embeddings`

Plus 4 management endpoints:
- `GET /v1/models` (wrapper's own discovery)
- `GET /health` (manager health)
- `GET /status` (instance details)
- `POST /v1/models/:model/unload` (explicit unload)

**Not proxied:** llama-server's other endpoints (`/tokenize`, `/detokenize`, `/slots`, `/metrics`, `/reranking`, `/v1/messages`, etc.). Token counting belongs in the LLM Gateway, not here. The wrapper stays focused on OpenAI-compatible inference.

## Model Key Convention

Keys follow the LM Studio folder layout (`modelsDir/publisher/model/file.gguf`):

- **Canonical:** `"qwen/qwen3-embedding-4b-gguf"` (relative folder path)
- **Quant variant:** `"qwen/qwen3-32b@q4_k_m"` (`@quant` suffix parsed from filename)
- **Short form:** `"qwen3-32b"` (resolves if unambiguous; ambiguous → 400)
- **Absolute path:** `"D:\\models\\custom.gguf"` (used directly)
- Matching is case-insensitive.

## Config

All defaults in `config.json`. Per-model overrides in optional `models.json` (keyed by canonical model key). See `documentation/llama-cpp-wrapper-api.md` for the full config schema.

**VRAM management:** `maxPerCategory: { chat: 1, embedding: 0 }` in `config.json` (Badkid: TTS + STT own the remaining VRAM, no local embedding slot). Chat slot: requesting a different chat model auto-unloads the previous one (drain + kill). Embedding requests fail loudly (`Category "embedding" limit reached (0)`). This prevents VRAM overfill on single-GPU systems.

**Chat templates:** Models use their own embedded chat template by default. Set `"jinja": true` in a `models.json` entry when the embedded template needs the Jinja engine (Gemma 4's macro-heavy template requires it). Add `"chatTemplateFile": "templates/<model>.jinja"` only when a model genuinely ships a broken template — it overrides the embedded template at spawn via `--chat-template-file`. Do not add a hand-written template just to "fix" tool calling; a template that omits the model's tool sections breaks tool calling (the 2026-08-26 Gemma incident — the embedded template was already correct and tool-capable).

**MTP speculative decoding:** Models shipping an MTP draft head (`mtp*.gguf` / `*-mtp-*.gguf` in the model dir) get automatic speculative decoding (`--spec-type draft-mtp --spec-draft-model --spec-draft-n-max N`, default 4). The draft file is excluded from quant variants. Requires `llamaBuild >= b10499` (Gemma4 MTP, upstream #23398). Dense models: ~2x tok/s, quality unchanged.

## Binaries (llama-cpp-builds)

Prebuilt universal binaries (CUDA + Vulkan + CPU variants) come from the
[llama-cpp-builds](https://github.com/herrbasan/llama-cpp-builds) releases.
`config.json → llamaBuild` pins the release tag (e.g. `"b9986"`); startup resolves it to
`builds/<tag>/llama-server.exe` and **crashes with a clear message if missing** — run
`npm run fetch-build -- <tag>` to download + hash-verify into `builds/<tag>/`.
Rollback = change `llamaBuild` back + restart (old versions stay cached in `builds/`).

New builds are produced in the llama-cpp-builds repo (`build.ps1 -Tag bXXXX -Publish`),
never in this repo. Legacy `llamaServerPath` (direct exe path) still works but logs a
deprecation warning.

**Critical: spawn cwd must be the binary's directory.** `GGML_BACKEND_DL=ON` builds use
`LoadLibrary` to dynamically load `ggml-cuda.dll`/`ggml-vulkan.dll`. This searches CWD,
not the exe's directory. The manager sets `cwd: path.dirname(config.llamaServerPath)`
when spawning llama-server. Without this, CUDA silently falls back to CPU. The release
zips are flat (exe + DLLs together) for exactly this reason.

**`--load-mode`:** since b10499, `--mlock`/`--mmap`/`--direct-io` are deprecated in favor
of `--load-mode auto|mmap|mlock|mmap+mlock|direct-io` (default `auto`). The wrapper passes
`--load-mode mlock` when a model sets `mlock: true` in models.json. Do not run builds
older than b10499's flag set assumptions — b9986 does not support `--load-mode`; only
enable `mlock` on models when `llamaBuild >= b10499`.

## Embedding Acceptance Gates

Embeddings are not "done" until all five pass (see docs/_Archive/dev-plan-v2.md):
1. **Determinism** — same text 20× → bit-identical
2. **Dimension** — matches GGUF metadata
3. **Pooling** — verified at spawn, logged
4. **Discrimination** — phrase-pair sanity vs remote reference
5. **Quantization isolation** — compare Q8_0 vs Q4_K_M before blaming code

## Coding Rules

- **Zero dependencies** — Node.js standard library only.
- **Fail fast** — missing required config crashes at startup. No `||` defaults for required values.
- **No defensive code** — no try/catch that swallows errors, no fallback defaults for invariants.
- **No state.json** — no detach mode. Manager quits → all processes die.
- **Native IDE tools** — use `replace_string_in_file`, not terminal scripts, for edits.

## Running

```bash
npm start                    # Start the manager
node tests/comprehensive.js  # Full test suite (88 tests, manager must be running)
node tests/smoke.js          # Quick smoke test
node tests/test-shutdown.js  # Clean shutdown test
```
