# Handover (received 2026-09-18) — multi-instance llama.cpp + resident classifier

> Received from a session in the LLM-Gateway project. Stored verbatim.
> **See the correction notice at the bottom before acting on §"The change".**

## Goal

Give the gateway the ability to run **more than one llama.cpp model at once**, each in its own isolated process, and route requests to the right one by model ID. The immediate use case is adding a tiny always-warm "fast-path" model (`badkid-classifier`) alongside the existing heavyweight (`badkid-llama-chat` / Gemma 4 12B).

## Why

A small CPU model that does one-shot *decisions* (turn-taking, intent routing, barge-in, canned replies) needs to be **resident** — already loaded — so a call returns in ~30–150ms with zero cold start. It must **not** share a process with Gemma: a long generation on the big model would stall the classifier, and vice versa.

## Architecture

```
gateway
├── adapter: llama.cpp   (ONE copy of code — not forked)
├── instance A → Gemma 4 12B   (badkid-llama-chat, heavyweight, full threads)
└── instance B → tiny model     (badkid-classifier, low thread cap, pinned warm)
```

**One adapter, N instances behind it.** Same HTTP surface and chat-completion contract; the only new behavior is *routing*.

## Key decisions

- **Instance = one process, one model, one ID.** llama.cpp *can* load multiple models per process — we deliberately don't, because that's exactly the contention we're avoiding.
- **Isolation comes from processes, not runtimes.** No new runtime, no forked wrapper code. Two llama.cpp processes are siblings that share a binary but not a fate.
- **The classifier stays on CPU.** It's a short one-shot inference dominated by fixed overhead; GPU buys nothing and risks scheduling jitter on the STT engine's lane.
- **Model registration is config, not code.** Adding a future third model should be a config entry, not a code change.
- **Classification should be a router with a bias to escalate.** The tiny model handles the easy 80% and hands off the other 20% to the big model. Never approximate on 100% — a wrong fast answer beats a slow right one for nothing.

## The change (small refactor, not a rewrite)

1. **Config**: replace single `{endpoint, model}` with a **list** of instances, each carrying model ID, endpoint/port, and thread cap.
2. **Routing**: on request, look up which instance owns the named model, send there.
3. **Load-balancing (later, optional)**: two copies of the *same* model for throughput → round-robin across instances sharing an ID. The list shape makes this trivial; not needed for the classifier-vs-Gemma case.

## The classifier model (fast-path citizen)

- **Runtime**: GGUF through llama.cpp (reuse existing wrapper — no new integration).
- **Contract**: dual — expose as both a chat model (short canned replies) *and* a classifier endpoint (one-shot labels). Registering only one of the two makes the other awkward later.
- **Sizing**: start small (~0.6B-class). Verify it's actually needed vs. a heuristic baseline before locking in — the heuristic is the thing you benchmark the model against.
- **Concurrency**: cap intra-op threads low (1–2). At ~30–50ms per call it'll never saturate a core; oversubscription (too many threads) is the only real failure mode.

## Out of scope (for now)

- Turn-taking state machine and heuristic intent detector — this is a *separate* track, built in nVoice first (no model needed).
- Echo cancellation / barge-in audio handling — the genuinely hard audio problem, decided separately.

## Order of work

1. Refactor adapter: single endpoint → instance list + routing.
2. Register `badkid-classifier` as a second instance, pinned warm, low thread cap.
3. Build the heuristic intent detector in nVoice (independent, can run in parallel).
4. Swap heuristic → model, benchmark the two.

---

## Correction notice (added 2026-09-18, llama-cpp-wrapper session)

§"The change" describes work in the wrong repo. Verified against both sides:

- **Gateway side (D:\DEV\LLM Gateway\config.json)** — model entries are literally
  `{ "adapter": "openai", "endpoint": "http://localhost:4080/v1", "adapterModel": "publisher/model" }`.
  The gateway already runs N model entries against one endpoint (it points three
  entries at Fatten's 4080 today). Adding `badkid-classifier` = **one config entry**,
  no adapter refactor, no routing code.
- **Wrapper side (this repo)** — `src/process.js` already keeps `Map<modelKey, Instance>`,
  allocates a port per instance from a pool, and routes by resolved model key. Instances
  are one process, one model, one ID — exactly the target architecture. It already *is*
  the "instance list + routing" the handover asks for.

The only actual blocker in this repo:

- `config.json → maxPerCategory: { "chat": 1, "embedding": 0 }` — a second chat model
  **evicts** the first (LRU drain + kill in `ensureModelInner`).
- The port pool size is derived (`chat + embedding` = 1), so a second concurrent chat
  instance needs that number raised too — the pool is `[4081]` today.

Genuine gaps worth deciding on (not covered by the handover):

- **"Pinned warm" does not exist.** Nothing preloads the classifier at startup, and
  LRU eviction can evict it under a third-model request. Needs either a preload list in
  `config.json` or a `pinned: true` per-model flag exempting it from eviction.
- **CPU-only classifier** needs `gpuLayers: 0` + a low `threads` in `models.json`;
  wrapper defaults are `gpuLayers: 99`, `threads: 8`.

---

## Status — both gaps closed and verified 2026-09-18

Implemented as a `"pinned": true` per-model flag in `models.json` (not a count bump —
`maxPerCategory` is the VRAM guard and stays at `chat: 1`). A pinned model is preloaded
at startup, exempt from the category limit, never an eviction candidate, and holds one
reserved port. `tests/test-pinned.js` covers the registry and resolution.

Runtime-verified after restart:

```
PID 32956  port 4081  Qwen3-0.6B  -t 2  -ngl 0  --reasoning off   (pinned, resident)
PID 33600  port 4082  Gemma 4 12B -t 8  -ngl 99                    (evictable)
```

Warm latency through the wrapper: ~24.5 ms prefill + ~25 ms for a 2-token label ≈ 50 ms.
First call after load is ~420 ms (weight page-in, not prefill).

**Also required:** `--reasoning off` (exposed as `reasoning` in `models.json`). Qwen3-0.6B
is a thinking model — with a small `max_tokens` the whole budget goes into
`reasoning_content` and `content` returns empty. Measured: 16/16 tokens consumed, empty
content, before the flag.

Not yet closed: model *quality*. On the probe prompt, "hey, what time is it?" classified
as `command` rather than `question`. The handover's step 3–4 (heuristic baseline, then
benchmark against it) is still the open question — the plumbing is done, the model's
judgement on a crude prompt is not yet good.
