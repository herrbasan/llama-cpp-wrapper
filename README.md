# llama-cpp-wrapper

A zero-dependency Node.js process manager for [`llama-server`](https://github.com/ggml-org/llama.cpp). It exposes a standard OpenAI-compatible API and handles model lifecycle — loading, swapping, health-checking, and clean shutdown.

## What It Does

- Presents itself as an OpenAI API endpoint (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`)
- Spawns `llama-server` processes on demand based on the `model` field in request bodies
- Proxies requests and responses **raw** — zero payload transformation
- Manages process lifecycle: single-flight loading, in-flight tracking, drain-before-kill
- Windows-accurate shutdown: no orphaned processes, no zombie ports

## Quick Start

### Prerequisites

- Node.js 18+ (uses built-in `fetch`)
- A built `llama-server` binary (see `build/build.ps1`)
- GGUF model files in a directory (LM Studio folder layout supported)

### Configuration

Edit `config.json`:

```json
{
  "host": "0.0.0.0",
  "port": 4080,
  "serverPort": 4081,
  "maxInstances": 4,
  "llamaServerPath": "dist/universal/llama-server.exe",
  "modelsDir": "D:\\AI\\Models"
}
```

Optional per-model overrides in `models.json`:

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

### Run

```bash
git submodule update --init --recursive
npm start
```

### Use

```bash
# List available models
curl http://localhost:4080/v1/models

# Chat completion
curl http://localhost:4080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen/qwen3-32b","messages":[{"role":"user","content":"Hello"}]}'

# Embeddings
curl http://localhost:4080/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen/qwen3-embedding-4b-gguf","input":"hello world"}'
```

Any OpenAI-compatible client works — point it at `http://localhost:4080`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (streaming supported) |
| `POST` | `/v1/completions` | Text completions |
| `POST` | `/v1/embeddings` | Embeddings |
| `GET` | `/v1/models` | List discovered models |
| `GET` | `/health` | Manager health |
| `GET` | `/status` | Running instances and config |
| `POST` | `/v1/models/:model/unload` | Unload a model |

## Model Selection

Models are selected by the standard `model` field in the request body. Keys follow the LM Studio folder convention:

- `publisher/model` — canonical key (e.g. `qwen/qwen3-32b`)
- `publisher/model@quant` — specific quant (e.g. `qwen/qwen3-32b@q4_k_m`)
- `model-name` — short form (resolves if unambiguous)

## Testing

```bash
# Start the manager first
npm start

# In another terminal — run smoke tests
npm test

# Or specify models explicitly
node tests/smoke.js qwen/qwen3-32b qwen/qwen3-embedding-4b-gguf
```

The smoke test covers: health check, model listing, chat completion, embedding correctness (dimension, determinism, discrimination).

## Documentation

- `docs/dev-plan-v2.md` — Full development plan with architecture decisions
- `AGENTS.md` — LLM briefing for code generation
