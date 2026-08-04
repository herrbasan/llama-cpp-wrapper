# Local llama.cpp Embedding Degradation — Investigation Notes

**Date:** 2026-07-05/06  
**System:** MCP Server VDB → LLM Gateway → fatten llama.cpp wrapper/server (`192.168.0.145:4080`)  
**Model:** Qwen3-Embedding-4B-GGUF (`Qwen3-Embedding-4B-Q4_K_M.gguf`)

> **Terminology:** "LLM Gateway" is the router on port 3400. "fatten llama.cpp wrapper" (or "local server") is the llama.cpp instance at `192.168.0.145:4080` that the LLM Gateway calls.

---

## 1. Symptom

Embeddings produced by the local `fatten-llama-embed` endpoint are degraded compared to the same model hosted remotely:

- **Cosine similarities cluster in a narrow band** (mostly 0.65–0.80), making it hard to distinguish related from unrelated content.
- **Repeated calls to the local endpoint produce different embeddings** for the same text, while the remote endpoint is stable.
- **Semantic search quality is poor** for associative queries (e.g., "dog that solves puzzles" fails to surface the Balu file).

Switching the LLM Gateway `embed` task from `fatten-llama-embed` to `or-qwen-embed` (OpenRouter) immediately fixes all symptoms.

---

## 2. Evidence

### 2.1 Controlled phrase-pair comparison

| Query pair | Local `fatten-llama-embed` | Remote `or-qwen-embed` |
|---|---|---|
| `"a dog"` ↔ `"a cat"` | 0.71 | 0.80 |
| `"pizza"` ↔ `"quantum physics"` (unrelated) | **0.74** | **0.42** |
| `"AI"` ↔ `"machine learning"` (related) | 0.75 | 0.85 |
| `"animals are smart"` ↔ `"dog solved puzzles"` | 0.71 | 0.59 |
| `"i like animals..."` ↔ Balu sentence | 0.67 | 0.55 |

The local endpoint gives **unrelated pairs almost the same score as related pairs**.

### 2.2 Instability across repeated calls

Same query/text pair embedded twice through the LLM Gateway default `embed` task route:

| Run | `"Dana load-bearing architecture"` vs memory text |
|---|---|
| Run 1 | 0.9562 |
| Run 2 | 0.5822 |

This suggests the LLM Gateway's default `embed` task was falling back between two different embedding backends (local fatten llama.cpp wrapper and remote OpenRouter). After pinning the LLM Gateway `embed` task to `or-qwen-embed`, the scores became identical across calls.

### 2.3 Real search impact

With local embeddings:
- `"i like animals, they are really smart"` did **not** return `wolfgang-and-balu.md`.
- `"Balu the intelligent dog puzzle solving"` returned unrelated project memories.

With remote embeddings (same dimension, 2560):
- `"dog that solves puzzles"` returns `wolfgang-and-balu.md` at rank 1.
- `"Balu the intelligent dog puzzle solving"` returns it at ranks 1–2.

### 2.4 Direct fatten server behavior

Direct HTTP calls to `http://192.168.0.145:4080/v1/embeddings` and `/embedding` returned:

```json
{"error":"Bad Request","details":"Missing X-Model-Path header. The Gateway must send model config via headers."}
```

The local server requires a custom `X-Model-Path` header that the LLM Gateway presumably supplies. Without the gateway, we could not call the local server directly.

---

## 3. Current Gateway Configuration

From `D:\DEV\LLM Gateway\config.json`:

```json
"fatten-llama-embed": {
  "type": "embedding",
  "adapter": "llamacpp",
  "disabled": false,
  "endpoint": "http://192.168.0.145:4080",
  "capabilities": {
    "contextWindow": 32000,
    "dimensions": 4096
  },
  "localInference": {
    "enabled": true,
    "modelPath": "E:\\LM Studio Models\\Qwen\\Qwen3-Embedding-4B-GGUF\\Qwen3-Embedding-4B-Q4_K_M.gguf",
    "contextSize": 32000,
    "gpuLayers": 99,
    "embedding": true,
    "pooling": "mean",
    "mlock": true
  }
}
```

Notable:
- Config says `dimensions: 4096`, but actual responses are **2560-dim**.
- Model file is `Qwen3-Embedding-4B-Q4_K_M.gguf`.
- `pooling: "mean"` is set.
- `contextSize: 32000`.

The dimension mismatch (`4096` configured vs `2560` returned) is suspicious. The actual Qwen3-Embedding-4B model may have a 3584 hidden size and a 2560 projection head, so 2560 could be correct — but the gateway adapter may be doing something with the configured 4096 that corrupts the output.

---

## 4. Hypotheses

### 4.1 Wrong pooling or mean layer

The gateway's llama.cpp adapter may not be sending the `pooling` parameter correctly, or llama.cpp may be using a default that differs from the model's intended pooling. Qwen3-Embedding-4B is trained with **mean pooling**; if the server uses last-token pooling, the vectors will be wrong.

### 4.2 Quantization damage

The local model is `Q4_K_M`. OpenRouter almost certainly uses a higher-precision (FP16 or Q8_0) deployment. Qwen3-Embedding-4B may be particularly sensitive to quantization because the embedding layer is a small projection on top of a 4B model.

### 4.3 Context / prompt wrapping

Embedding models often expect a special prefix like `"Represent this sentence for searching relevant passages: "`. If the gateway wraps the input differently than OpenRouter, the vector space shifts. Qwen3-Embedding-4B does not strictly require a task prefix, but inconsistency could matter.

### 4.4 Batch handling bug

VDB sends batches of up to 32 texts. The local llama.cpp server may handle batches differently than single texts, or the gateway adapter may split/merge batches in a way that changes the output. Our direct single-text tests also showed the problem, but batch behavior could still be a factor.

### 4.5 Adapter sends wrong `X-Model-Path`

The direct-call error shows the server uses `X-Model-Path` to select the model. If the gateway sends the wrong path, a different model (or a chat model) might be producing the embeddings. The 2560-dim output suggests an embedding model is loaded, but it could be a different GGUF than intended.

### 4.6 Model file mismatch

The file `Qwen3-Embedding-4B-Q4_K_M.gguf` may be a bad conversion, an unofficial quant, or a chat-tuned variant mislabeled as an embedding model.

---

## 5. Recommended Debugging Steps

### 5.1 Verify the exact request the gateway sends to fatten

Add logging in the LLM Gateway's llama.cpp adapter (the client that talks to the fatten llama.cpp wrapper) to print:
- Full URL
- Headers (especially `X-Model-Path`)
- Request body (`input`, `model`, `encoding_format`, `dimensions`)
- Response status and first bytes

Compare this with a working direct call to the same server (if one can be constructed).

### 5.2 Call the local server directly with the correct header

Figure out the exact `X-Model-Path` value the server expects. It may be the full model path, the model filename, or an alias configured at server startup. Then run:

```bash
curl -X POST http://192.168.0.145:4080/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "X-Model-Path: <correct-path>" \
  -d '{"input": "the dog solved puzzles", "model": "qwen3-embedding-4b"}'
```

Compare the resulting vector with OpenRouter for the same text.

### 5.3 Test different GGUF quantizations

Download or generate alternative versions of Qwen3-Embedding-4B:
- FP16 / BF16
- Q8_0
- Q6_K

Test each on the local server and compare cosine-similarity separation. If Q8_0 matches OpenRouter but Q4_K_M does not, the quantization is the issue.

### 5.4 Test with and without mean pooling

Run the local server with explicit pooling flags:
- `--pooling mean`
- `--pooling none` (last token)
- `--pooling cls`

Compare the vectors. Mean pooling should match the intended model behavior.

### 5.5 Check llama.cpp server version and embedding support

Ensure the llama.cpp server build supports embedding mode and the specific model. Older builds or builds compiled without embedding support can silently produce garbage.

### 5.6 Verify no chat template is applied

Some llama.cpp server builds apply the model's chat template even to embedding requests. For an embedding model, this could prepend/append tokens that shift the vector. Check server logs for the tokenized prompt.

### 5.7 Compare single vs batch embedding

Embed the same text once and in a batch of 32 through the local server. If results differ, there's a batching bug in llama.cpp or the gateway adapter.

---

## 6. Quick Win: Pin Remote Embeddings

Until the local issue is fixed, the safest operational setup is:

1. LLM Gateway `tasks.embed.model = "or-qwen-embed"` (or a future DashScope model).
2. No fallback to `fatten-llama-embed`.
3. Keep `embeddingDim: 2560` so existing indexes stay compatible.

This has been deployed and verified to fix search quality.

---

## 7. Follow-up Investigation — Direct Wrapper Tests (2026-07-06)

To isolate the cause, we called the fatten and badkid llama.cpp wrappers directly via `POST /v1/embeddings` with the correct `X-Model-Path` and `X-Model-Embedding` headers. We compared the same controlled phrase pairs against OpenRouter `or-qwen-embed`.

### 7.1 Available models on fatten

`GET http://192.168.0.145:4080/models` returned ~25 GGUFs. Embedding-capable models included:

- `Qwen3-Embedding-4B-Q4_K_M.gguf`
- `Qwen3-Embedding-4B-f16.gguf`
- `Qwen3-Embedding-0.6B-f16.gguf`
- `Qwen3-Embedding-8B-Q4_K_M.gguf`
- `nomic-embed-text-v2-moe.Q8_0.gguf`
- `jina-embeddings-v5-text-*-retrieval-Q8_0.gguf`
- `embeddinggemma-300M-*`

### 7.2 Quantization is not the cause

| Model | unrelated `pizza ↔ quantum physics` | related `AI ↔ machine learning` |
|---|---|---|
| OpenRouter `or-qwen-embed` | **0.42** | 0.79 |
| fatten Qwen3-Embedding-4B-Q4_K_M | 0.61 | 0.84 |
| fatten Qwen3-Embedding-4B-f16 | 0.61 | 0.84 |
| badkid 4090 Qwen3-Embedding-4B-Q4_K_M | 0.61 | 0.84 |

The Q4_K_M and FP16 versions produced nearly identical scores. The degradation also reproduced on a local RTX 4090 (CUDA). This rules out:

- Quantization damage (Q4 vs FP16 unchanged).
- Fatten’s specific GPU architecture / wrapper code.

### 7.3 Pooling header has no effect

Setting `X-Model-Pooling` to `mean`, `cls`, `last`, or `none` produced **identical** vectors. The wrapper or llama.cpp backend appears to ignore the pooling parameter for this model.

### 7.4 Instruction prefixing shifts scores toward OpenRouter

Qwen3-Embedding is instruction-aware. Prefixing queries with:

```
Instruct: Given a web search query, retrieve relevant passages that answer the query
Query:<text>
```

changed scores dramatically:

| Pair | raw local | with query instruction |
|---|---|---|
| `pizza ↔ quantum physics` | 0.61 | 0.56 |
| `AI ↔ machine learning` | 0.84 | 0.62 |

This suggests OpenRouter likely applies instruction-aware encoding, while our local calls do not.

### 7.5 Ranking is still correct locally

Even with compressed absolute similarity, a small synthetic retrieval test ranked the Balu sentence at #1 for queries like `"dog that solves puzzles"`. The original VDB failure is best explained by the LLM Gateway mixing fatten and OpenRouter embeddings in the same index.

---

## 8. Revised Conclusions

1. The wrapper on fatten and the local CUDA wrapper on badkid behave the same way.
2. The GGUF file and/or llama.cpp inference path produces a different vector distribution than OpenRouter.
3. The most likely root cause is **missing instruction prefixing** for Qwen3-Embedding queries, possibly combined with different post-processing (normalization, pooling defaults) on OpenRouter’s side.
4. Quantization, pooling header, and GPU architecture have been ruled out.

---

## 9. Open Questions / Next Steps

- Does applying the official Qwen3 query instruction prefix to VDB searches make local embeddings competitive with OpenRouter?
- Can the LLM Gateway llama.cpp adapter be configured to prefix queries and not documents?
- Does a newer llama.cpp build or different GGUF source (official Qwen HF conversion) change the output?
- What instruction / pooling pipeline does OpenRouter actually use for `qwen/qwen3-embedding-4b`?

---

## 10. Appendix: Test Scripts

The following scripts were used during this investigation and remain in `tests/`:

- `test-embeddings-direct.js` — compares `task:'embed'` vs explicit model routes.
- `test-fatten-direct.js` — attempts direct calls to the fatten server.
- `test-memory-embedding-strategy.js` — compares task/model routes on a real memory.
- `test-dashscope-embeddings.js` — evaluates DashScope `text-embedding-v4/v3`.
- `test-token-plan-chat.js` — verifies token-plan chat endpoint.
- `benchmark-fatten-embeddings.js` — compares multiple fatten GGUFs vs OpenRouter.
- `benchmark-local-wrapper.js` — compares local badkid wrapper vs OpenRouter.

---

## 11. Bottom Line

The degradation is not specific to fatten or to the wrapper. The same GGUF on a local RTX 4090 produces the same compressed similarity distribution. The likely fix is instruction-aware embedding (query prefixing) or switching to a serving stack that applies the same post-processing as OpenRouter. Until then, pinning the LLM Gateway `embed` task to `or-qwen-embed` remains the safest operational setup.
