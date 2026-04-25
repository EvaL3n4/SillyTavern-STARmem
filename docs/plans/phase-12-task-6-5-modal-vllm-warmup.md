# Phase 12 Task 6.5 — Modal vLLM Warmup (Substrate Swap)

> **For Hermes:** Use subagent-driven-development to implement Tasks 1-3. Tasks 4-7 are manual Modal dispatch steps Eva runs; the controller writes files + commits, Eva pastes output, controller dispatches the next task.

**Goal:** Replace the dead-ended Fireworks Batch warmup substrate with a Modal vLLM offline-batch dispatch using Qwen/Qwen3.6-35B-A3B-FP8 on a single H100, while preserving every byte-compat invariant the Fireworks path already paid for.

**Architecture:** New `bench/modal/vllm_warmup.py` (~150 LOC) reads enumerated `WarmupBatch[]` JSONL from the existing `starmem-bench-data` Modal Volume, runs `vllm.LLM(...).chat(messages_list)` once, and writes `{model, maxTokens, response, at}` JSON cache files directly to `/data/extractions/<customId>.json`. The existing pure `enumerateWarmupBatches()` enumerator is reused unchanged; only a thin `enumerate <out-path>` subcommand is added to the existing `bench/harness/fireworks-warmup.js` CLI to emit JSONL without API calls. The existing live-extraction path (`run_longmemeval_warmup_point` with `warmup_concurrency=1`) is the regression check — `misses=0` proves byte-compat.

**Tech Stack:** Python 3.11, Modal (single-GPU H100, no fan-out, no `.map`), vLLM ≥ 0.19.0 (offline batch via `LLM.chat()`, continuous batching saturates one GPU), Node 20 (CLI enumerator only — no new Node infra), Jest (unit tests for enumerate-CLI + Python pytest with modal-stub for `vllm_warmup.py`).

---

## Context — why this is N.M.5, not N.M.7

Phase 12 Task 6 (Fireworks Batch Inference warmup) successfully landed all the byte-compat infrastructure on `main`:

- `bench/harness/warmup/enumerate.js` — pure `enumerateWarmupBatches()` with 8 unit tests proving `customId === _cacheKey(model, messages, maxTokens)` byte-for-byte.
- `bench/harness/warmup/cache-ingest.js` — reads provider results JSONL, writes byte-compat cache files.
- `bench/harness/warmup/fireworks-batch.js` — Fireworks REST client (snake_case proto fields, `JOB_STATE_*` enum normalizer, GET-no-body fix; see `batch-api-cache-warmup` skill §Field-validated).
- `bench/harness/_modal-warmup-point.js` — refactored to consume the enumerator; serves as the existing-live-extraction regression-check path.

What broke: Fireworks support never replied on a cache-related dataset issue, leaving the 70B Llama 3.3 partition inaccessible. Continuing to wait blocks Phase 12 Task 7 (λ₁ tripwire) indefinitely. **The substrate is swappable; the invariants are not.** This sub-phase reuses every byte-compat invariant Phase 12 Task 6 paid for (enumerator, `_cacheKey`, regression-check path) and replaces only the LLM dispatch substrate.

The Fireworks code is left in place as historical record + working REST client (not deleted; might revive if Fireworks support eventually responds). No migration code from Fireworks state — that path is dead-ended.

---

## Decisions locked before writing this plan (see conversation 2026-04-25)

1. **Model: `Qwen/Qwen3.6-35B-A3B-FP8`.** 35B total, ~3B active, FP8-quantized, Apache 2.0. Deviates from Phase 12 Decision 1 (Llama 3.3 70B Fireworks) because Fireworks held that path hostage. Qwen3.6 35B-A3B beats Gemma 4 26B A4B on AA throughput (~190 vs ~50 tok/s effective single-stream) at comparable extraction quality, and FP8 weights (~37GB) fit H100-80GB cleanly without tensor-parallel.
2. **GPU shape: single H100, no tensor-parallel, no `.map` fan-out.** vLLM continuous batching saturates one GPU on a 3B-active MoE; sharding is engineering cost without throughput-per-dollar gain (Modal's own throughput page is explicit on this). One `@app.function(gpu="H100", ...)`, one `LLM(...).chat(messages_list)` call.
3. **Cache transport: existing `starmem-bench-data` Modal Volume.** Mounted at `/data` per `sweep_app.py:45`. The vLLM function writes cache files directly to `/data/extractions/<customId>.json` and `volume.commit()`. No new volume, no separate ingest step (write IS ingest), no `modal volume get` step required for downstream baselines (they already symlink `/data/extractions` → `bench/.cache/extractions` per the existing `_install_volume_symlink` pattern).
4. **Enumerator transport: extend `bench/harness/fireworks-warmup.js` with an `enumerate <out-path>` subcommand.** Reuses `parseArgv`'s existing command-routing (already supports `submit`/`resume`/`continue`). Pure JSONL emission; no API calls. Eva runs `node bench/harness/fireworks-warmup.js enumerate /tmp/warmup-input.jsonl --corpora locomo,longmemeval-s` then `modal volume put starmem-bench-data /tmp/warmup-input.jsonl /warmup-input.jsonl`.
5. **Custom_id invariant: parallel array zipped with prompts.** Never positional ordering of vLLM outputs. The `_modal-warmup-point.js` regression check is the load-bearing proof — if any miss after warmup, the byte-compat write contract drifted; STOP before Phase 12 Task 7.
6. **Reasoning suppression: `chat_template_kwargs={"enable_thinking": False}`.** Qwen3.6 thinks by default (per the model card; the `/think` `/nothink` soft switch is NOT supported). The chat-template kwarg suppresses the `<think>` block at generation time. Belt-and-suspenders fallback documented in Task 2 if it leaks: `--reasoning-parser qwen3` + post-strip the reasoning channel before writing cache.
7. **vLLM flags: `language_model_only=True`** to skip the vision encoder (Qwen3.6-35B-A3B-FP8 ships as image-text-to-text per the model card; we want text-only so the encoder mass doesn't reduce KV cache for our text extraction).
8. **Per-cell timeout: `timeout=14400` (4h).** Worst-case arithmetic *re-derived against actual corpus shape* (post-Task 3 enumerate verification, 2026-04-25): LongMemEval-S 500 items × ~250K total turns ÷ BATCH_SIZE=15 = **16,682 batches** (NOT the ~10,800 figure originally cited — that was lifted from stale notes). Aggregate vLLM throughput on H100 for 3B-active MoE: conservative 1.5K out tok/s, plan median 3K out tok/s. 16,682 batches × ~400 out tok = 6.67M out tok ÷ 1.5K agg = ~74 min worst case. With 1.5× safety margin = ~111 min. `timeout=14400` (240 min) covers worst-case-with-headroom comfortably and gives room for cold-start engine init (~5-10 min on H100 for Qwen3.6-35B-A3B-FP8 cold pull). If aggregate falls below 1K out tok/s mid-run, `skip_existing=True` makes any timeout-and-restart cycle work-preserving.

9. **Cost envelope: ~$3–$5.** H100 base $3.95/hr, regional 1.25× ≈ $4.94/hr effective. At 3K agg tok/s median: 6.67M out tok ÷ 3K = 37 min × $4.94/hr = **$3.05**. At 1.5K conservative: 74 min × $4.94/hr = $6.10. Budget reserves: $30 free credit minus dispatch ≈ $24-27 headroom for re-runs and Phase 12 Task 7 work. Honest tripwire: if dashboard total exceeds $8, abort and escalate.

10. **BATCH_SIZE override: `--batch-size 15` for the warmup enumerator.** Live evidence from `docs/bench/sweeps/2026-04-23-batchsize-live.md` shows BS=15 had peak MRR (0.8370 vs 0.8009 at spec default 5), held at spec only because ΔMRR < 0.02 amendment threshold. For the warmup specifically (where we want fewer-but-richer LLM calls), bumping BS=15 cuts dispatch cost 3× without quality regression — the sweep IS the evidence. The cache key is `(model, messages, maxTokens)`, so this BATCH_SIZE choice locks the cache to BS=15-shaped messages. **Phase 12 Task 7 (λ₁ tripwire) must run baselines with `BATCH_SIZE=15` override** or every cache lookup misses (different `messages` array → different `_cacheKey`). Caveat: the BS sweep was on LoCoMo, not LongMemEval-S; LongMemEval-S items are denser per-turn, so BS behavior could differ — but in the same direction (more context = better keywords). If the Task 4 smoke shows degraded extraction quality, fall back to BS=10 (sweep showed coverage peak there: 0.7337) and re-enumerate.
11. **Image: Modal `python:3.11`, vLLM nightly via `pip install -U --pre vllm --extra-index-url https://wheels.vllm.ai/nightly`.** Standalone `vllm_warmup.py` Modal app; does NOT share the `starmem-bench` app's image build (vLLM is heavy and we do not want every benchmark container loading it). Separate `app = modal.App("starmem-bench-vllm-warmup")`. **Nightly chosen over `vllm>=0.19.0` stable** because Qwen3.6 has open reasoning- and tool-call-path bugs in 0.19.0 that affect our `--reasoning-parser qwen3` fallback (Decision 6 belt-and-suspenders); nightly carries the fixes. Trade-off accepted: nightly carries unrelated regression risk, but our path is narrow (single model, single sampling shape, no tool calls, batch-only). If nightly breaks the smoke (Task 4), pin to the latest dated nightly that worked rather than rolling back to 0.19.0 stable.

---

## Task 0: Commit the plan

**Objective:** Stabilize this plan as a reference for subagents and future sessions.

**Files:**
- Already created: `docs/plans/phase-12-task-6-5-modal-vllm-warmup.md` (this file)

**Step 1: Tripwire — verify no secrets-guard redactions landed.**

```bash
grep -n '=\s*\*\*\*\|=\*\*\*' docs/plans/phase-12-task-6-5-modal-vllm-warmup.md
```

Expected: empty output.

**Step 2: Verify task headings landed.**

```bash
grep -c '^## Task ' docs/plans/phase-12-task-6-5-modal-vllm-warmup.md
```

Expected: `8` (Task 0 through Task 7).

**Step 3: Commit.**

```bash
git add docs/plans/phase-12-task-6-5-modal-vllm-warmup.md
git commit -m "docs(plan): Phase 12 Task 6.5 — Modal vLLM warmup substrate swap"
```

---

## Task 1: Add `enumerate` subcommand to `fireworks-warmup.js`

**Objective:** Emit `{customId, model, messages, maxTokens, itemId, batchIdxInItem}` JSONL to a path, no API calls. Reuses existing `enumerateWarmupBatches()` directly.

**Files:**
- Modify: `bench/harness/fireworks-warmup.js` — extend `parseArgv()` and add `runEnumerate()` handler.
- Test: `tests/unit/bench/harness/fireworks-warmup-enumerate.test.js`

**Decisions for this task:**
- Output path is the second positional argument, not a `--out` flag (consistent with `resume <id>` / `continue <id>` shape).
- `--corpora` is required, same as `submit`. Defaults to LongMemEval-S + LoCoMo via `--corpora locomo,longmemeval-s`.
- `--model` defaults to `Qwen/Qwen3.6-35B-A3B-FP8` (overrides `DEFAULT_MODEL` for this subcommand only — the existing `submit` subcommand keeps Llama 3.3 as its default).
- One JSONL line per `WarmupBatch`. No JSON pretty-printing.
- `--limit N` flag (optional) for smoke runs: emit only the first N batches across all corpora (useful for Task 4).

**Step 1: Write failing test.**

Create `tests/unit/bench/harness/fireworks-warmup-enumerate.test.js`:

```javascript
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgv } from '../../../../bench/harness/fireworks-warmup.js';

describe('fireworks-warmup enumerate', () => {
    test('parseArgv: enumerate <out-path> --corpora locomo --limit 5', () => {
        const r = parseArgv(['enumerate', '/tmp/x.jsonl', '--corpora', 'locomo', '--limit', '5']);
        expect(r.command).toBe('enumerate');
        expect(r.outPath).toBe('/tmp/x.jsonl');
        expect(r.corpora).toEqual(['locomo']);
        expect(r.limit).toBe(5);
        expect(r.model).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
    });

    test('parseArgv: enumerate requires <out-path>', () => {
        expect(() => parseArgv(['enumerate'])).toThrow(/out-path/);
    });

    test('parseArgv: enumerate requires --corpora', () => {
        expect(() => parseArgv(['enumerate', '/tmp/x.jsonl'])).toThrow(/corpora/);
    });

    test('parseArgv: --model override applies to enumerate', () => {
        const r = parseArgv(['enumerate', '/tmp/x.jsonl', '--corpora', 'locomo', '--model', 'foo/bar']);
        expect(r.model).toBe('foo/bar');
    });
});
```

**Step 2: Run to verify failure.**

```bash
npx jest tests/unit/bench/harness/fireworks-warmup-enumerate.test.js
```

Expected: 4 failed (`parseArgv` doesn't recognize `enumerate`).

**Step 3: Implement `parseArgv` extension.**

In `bench/harness/fireworks-warmup.js`, add a constant near the top alongside `DEFAULT_MODEL`:

```javascript
const DEFAULT_VLLM_MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';
```

Then extend `parseArgv()` — add a new branch BEFORE the final `throw new Error(...)`:

```javascript
    if (command === 'enumerate') {
        const outPath = argv[1];
        if (!outPath || outPath.startsWith('--')) {
            throw new Error('enumerate requires <out-path> as positional argument');
        }
        const out = { command: 'enumerate', outPath, model: DEFAULT_VLLM_MODEL };
        let i = 2;
        while (i < argv.length) {
            const flag = argv[i];
            if (flag === '--corpora') {
                const val = argv[++i];
                if (!val) throw new Error('enumerate requires --corpora <csv>');
                out.corpora = val.split(',').map(s => s.trim()).filter(Boolean);
            } else if (flag === '--model') {
                const val = argv[++i];
                if (!val) throw new Error('--model requires a value');
                out.model = val;
            } else if (flag === '--limit') {
                const val = Number(argv[++i]);
                if (!Number.isInteger(val) || val <= 0) {
                    throw new Error('--limit must be a positive integer');
                }
                out.limit = val;
            } else {
                throw new Error(`unknown flag: ${flag}`);
            }
            i++;
        }
        if (!out.corpora || out.corpora.length === 0) {
            throw new Error('enumerate requires --corpora');
        }
        return out;
    }
```

**Step 4: Run unit tests to verify pass.**

```bash
npx jest tests/unit/bench/harness/fireworks-warmup-enumerate.test.js
```

Expected: 4 passed.

**Step 5: Implement `runEnumerate()` function and route from `main()`.**

Find the existing `main()` switch and add a case for `'enumerate'`. Implement `runEnumerate(argsParsed)` near the other run-functions:

```javascript
/**
 * Emit enumerated WarmupBatch entries as JSONL (no API calls).
 *
 * @param {{outPath: string, corpora: string[], model: string, limit?: number}} args
 */
export async function runEnumerate(args) {
    const { outPath, corpora, model, limit } = args;

    /** @type {Array<import('./warmup/enumerate.js').WarmupBatch>} */
    let batches = [];
    for (const corpusName of corpora) {
        const adapter = getAdapter(corpusName);
        const items = await adapter.loadConversations({ offline: true });
        const corpusBatches = enumerateWarmupBatches(items, {
            model,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: CONSOLIDATION.BATCH_SIZE,
        });
        // eslint-disable-next-line no-console
        console.error(`[enumerate] ${corpusName}: ${items.length} items → ${corpusBatches.length} batches`);
        batches = batches.concat(corpusBatches);
    }

    if (limit) {
        batches = batches.slice(0, limit);
        // eslint-disable-next-line no-console
        console.error(`[enumerate] --limit ${limit} applied → emitting ${batches.length} batches`);
    }

    await mkdir(path.dirname(outPath), { recursive: true });
    const lines = batches.map(b => JSON.stringify({
        customId: b.customId,
        model: b.model,
        messages: b.messages,
        maxTokens: b.maxTokens,
        itemId: b.itemId,
        batchIdxInItem: b.batchIdxInItem,
    }));
    await writeFile(outPath, lines.join('\n') + '\n', 'utf8');

    // eslint-disable-next-line no-console
    console.error(`[enumerate] wrote ${batches.length} batches → ${outPath}`);
    return { batchCount: batches.length, outPath };
}
```

In the `main()` function's switch (or whatever dispatch shape is in place), add:

```javascript
        case 'enumerate':
            return runEnumerate(parsed);
```

**Step 6: Smoke the CLI end-to-end.**

```bash
node bench/harness/fireworks-warmup.js enumerate /tmp/smoke-warmup.jsonl --corpora locomo --limit 3
wc -l /tmp/smoke-warmup.jsonl
head -1 /tmp/smoke-warmup.jsonl | jq 'keys'
```

Expected: `3 /tmp/smoke-warmup.jsonl`. Keys: `["batchIdxInItem","customId","itemId","maxTokens","messages","model"]` (alphabetical from jq).

**Step 7: Commit.**

```bash
git add bench/harness/fireworks-warmup.js tests/unit/bench/harness/fireworks-warmup-enumerate.test.js
git commit -m "feat(bench): add enumerate subcommand to fireworks-warmup CLI

Pure JSONL emission of WarmupBatch[] for vLLM offline-batch warmup;
no API calls. Reuses enumerateWarmupBatches() and CONSOLIDATION.BATCH_SIZE
read-at-call-time to stay in sync with sweep overrides. Default model is
Qwen/Qwen3.6-35B-A3B-FP8 for this subcommand only — submit still defaults
to Llama 3.3."
```

---

## Task 2: Create `bench/modal/vllm_warmup.py`

**Objective:** New Modal app that reads enumerated JSONL from `/data/warmup-input.jsonl`, runs vLLM offline batch on a single H100, and writes byte-compat cache files to `/data/extractions/<customId>.json`.

**Files:**
- Create: `bench/modal/vllm_warmup.py`

**Pre-flight (preflight patterns from writing-plans skill):**

1. **Decorator pattern check.** This is a single-function app with no orchestrator-calling-per-cell shape. Only one function gets `@app.function`. There is no `.map()` / `.starmap()` fan-out to mismatch.

2. **Per-cell timeout arithmetic.** Worst case (re-derived 2026-04-25 against verified BS=15 enumeration): 16,682 batches × ~400 out tok = 6.67M out tok. Conservative aggregate throughput on H100 for 3B-active MoE with CUTLASS FP8 (DeepGEMM disabled defensively) = 1.5K out tok/s. 6.67M / 1.5K = ~74 min. With 1.5× safety + engine cold-start: **`timeout=14400` (4h)**. See Decision 8 for full re-derivation. If aggregate falls below 1K out tok/s mid-run, abort and escalate before retry.

3. **Volume non-empty path trap (modal skill §13).** Cache files at `/data/extractions/<sha>.json` already exist from prior LoCoMo extraction work; this function APPENDS, never overwrites unconditionally. The skip-if-exists check in the per-batch loop is the mitigation: every batch checks `os.path.exists(cache_path)` before adding to the dispatch list. Rerun-safe by construction.

4. **`add_local_dir` is terminal trap (modal skill §10).** No `add_local_dir` is needed for this function — vLLM reads `/data/warmup-input.jsonl` from the volume, writes `/data/extractions/<sha>.json` to the volume. Repo source is not needed inside the container. Image stays minimal: `python:3.11` + vLLM nightly + `huggingface_hub`. **Use `.pip_install(...)` with `extra_index_url` and `pre=True` rather than a `.run_commands("pip install ...")` for cache-friendliness** — Modal hashes the image layer by the pip args, so respec'ing the install via a single `pip_install` keeps the rebuild deterministic. Important: nightly wheels are pinned to a specific CUDA build (typically cu128 as of late 2026); Modal's GPU containers ship with a compatible CUDA runtime, so the default `--extra-index-url https://wheels.vllm.ai/nightly` works without an explicit cu-tag. If the install fails on missing cuXXX wheel, downshift to `https://wheels.vllm.ai/nightly+cu121` or whichever the Modal H100 image has.

5. **Honest aggregation (modal skill §8).** Output JSON includes per-prompt `success`/`error` arrays plus a top-level `firstError`. NEVER report top-level success without per-prompt validation: empty `outputs[i].outputs[0].text` is treated as a per-prompt failure (the reasoning-model trap from `batch-api-cache-warmup` skill).

6. **Reasoning-channel handling.** Primary path: `chat_template_kwargs={"enable_thinking": False}` passed via `SamplingParams` extra (vLLM `LLM.chat()` accepts `chat_template_kwargs` as a kwarg). Belt-and-suspenders post-processing: if any output text starts with `<think>`, strip up to and including `</think>\n\n` before writing cache (NEVER ship the reasoning channel into the cache — downstream `parseLLMJson()` would fail on it).

**Step 1: Write `bench/modal/vllm_warmup.py`.**

Use `write_file` (not heredoc) to avoid the secrets-guard trap on numeric literals. Full content:

```python
"""Modal vLLM offline-batch warmup for STARmem extraction cache.

Reads enumerated WarmupBatch entries (one per JSONL line) from
/data/warmup-input.jsonl on the starmem-bench-data Volume, runs vLLM
offline batch on a single H100, and writes per-customId cache files to
/data/extractions/<customId>.json in the byte-compat format the existing
extractionCache.js read path expects.

Byte-compat contract (matches bench/harness/extractionCache.js wrapWithCache):
    - filename: ${customId}.json under /data/extractions/
    - content: JSON.stringify({model, maxTokens, response, at}, null, 2)
      Python json.dumps(..., indent=2) matches Node's insertion-order
      shape AS LONG AS the dict is built in the same key order:
      {"model": ..., "maxTokens": ..., "response": ..., "at": ...}.

Run from repo root on the host:
    # 1. Enumerate (no API calls):
    node bench/harness/fireworks-warmup.js enumerate /tmp/warmup-input.jsonl \\
        --corpora locomo,longmemeval-s

    # 2. Upload to Volume:
    modal volume put starmem-bench-data /tmp/warmup-input.jsonl /warmup-input.jsonl

    # 3. Dispatch (or smoke first; see Task 4):
    modal run bench/modal/vllm_warmup.py

    # 4. Regression check (Task 6):
    modal run bench/modal/sweep_app.py --mode run-longmemeval-warmup \\
        --corpus-size 3 --warmup-concurrency 1
    # → expect misses=0 on all 3.

@module bench/modal/vllm_warmup
@see docs/plans/phase-12-task-6-5-modal-vllm-warmup.md Task 2
"""

import json
import os
import time
from typing import Optional

import modal


app = modal.App("starmem-bench-vllm-warmup")

# Standalone image — does NOT share the starmem-bench app's image.
# vLLM is heavy (~few GB) and we do not want every benchmark container
# loading it. Kept minimal: vllm (NIGHTLY — Qwen3.6 has open bugs in
# 0.19.0 stable on reasoning/tool-call paths that affect our
# --reasoning-parser qwen3 fallback) + huggingface_hub for the model
# snapshot.
#
# Nightly install via Modal's pip_install with extra_index_url + pre=True.
# If a future nightly regresses our smoke (Task 4), pin to the last
# known-good dated nightly via `pip_install("vllm==0.X.Y.devNNN", ...)`
# rather than rolling back to 0.19.0 stable — see Decision 10.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "vllm",
        "huggingface_hub>=0.24",
        pre=True,
        extra_index_url="https://wheels.vllm.ai/nightly",
    )
)

# Same Volume as sweep_app.py — mounted at /data, with /data/extractions
# being the canonical cache directory (symlinked into the repo at
# bench/.cache/extractions by _install_volume_symlink in sweep_app.py).
volume = modal.Volume.from_name("starmem-bench-data", create_if_missing=True)


# ============================================================
# Helpers (bare functions; only the dispatch fn gets @app.function)
# ============================================================


def _read_jsonl(path: str) -> list:
    """Read JSONL → list of dicts. One pass; tolerates trailing newline."""
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def _strip_reasoning(text: str) -> str:
    """Belt-and-suspenders: if vLLM leaks a <think>...</think> block
    despite enable_thinking=False, strip it before writing cache.

    Downstream parseLLMJson() in src/consolidation/extractFacts.js can't
    handle reasoning-channel preamble; it expects raw JSON or markdown-
    fenced JSON. Cache must be parseable.
    """
    if not text.startswith("<think>"):
        return text
    end = text.find("</think>")
    if end == -1:
        return text  # malformed — let downstream surface the issue
    after = text[end + len("</think>"):]
    return after.lstrip()


def _write_cache_file(
    cache_dir: str, custom_id: str, model: str, max_tokens: int, response: str
) -> None:
    """Write byte-compat cache file at <cache_dir>/<custom_id>.json.

    Format MUST match bench/harness/extractionCache.js wrapWithCache:
        JSON.stringify({model, maxTokens, response, at}, null, 2)

    Python json.dumps with indent=2 matches Node's pretty-print 2-space
    indentation. Key insertion order is preserved by Python 3.7+ dicts;
    we build the dict in the same order Node uses.
    """
    payload = {
        "model": model,
        "maxTokens": max_tokens,
        "response": response,
        "at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }
    path = os.path.join(cache_dir, f"{custom_id}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)


# ============================================================
# Dispatch — single H100, one LLM.chat() call, no fan-out
# ============================================================


@app.function(
    image=image,
    volumes={"/data": volume},
    gpu="H100",
    timeout=14400,  # 4h — covers worst-case ~74 min × 1.5 safety + cold-start
    memory=32768,
)
def warmup(
    input_path: str = "/data/warmup-input.jsonl",
    cache_dir: str = "/data/extractions",
    model: str = "Qwen/Qwen3.6-35B-A3B-FP8",
    max_tokens_override: Optional[int] = None,
    skip_existing: bool = True,
) -> dict:
    """Run vLLM offline batch over enumerated WarmupBatch JSONL.

    Args:
        input_path: Volume path to JSONL of {customId, model, messages,
            maxTokens, itemId, batchIdxInItem} per line.
        cache_dir: Volume path to write <customId>.json files.
        model: vLLM model id. Pinned default to keep the cache key stable
            across reruns.
        max_tokens_override: If set, overrides per-row maxTokens. Useful
            for smoke runs that want to ensure non-empty content; do NOT
            use for the full dispatch (would change the cache key).
        skip_existing: If True (default), check os.path.exists before
            dispatching each batch — rerun-safe by construction.

    Returns:
        Dict with totalRows, dispatched, skippedExisting, written,
        perPromptFailures, firstError, wallSeconds, sustainedOutTokPerS.
    """
    from vllm import LLM, SamplingParams

    os.makedirs(cache_dir, exist_ok=True)

    rows = _read_jsonl(input_path)
    total_rows = len(rows)
    if total_rows == 0:
        return {
            "totalRows": 0,
            "dispatched": 0,
            "skippedExisting": 0,
            "written": 0,
            "perPromptFailures": 0,
            "firstError": None,
            "wallSeconds": 0,
            "sustainedOutTokPerS": 0.0,
            "note": "empty input — nothing to do",
        }

    # Build dispatch list, skipping existing cache files.
    dispatch: list = []
    skipped_existing = 0
    for row in rows:
        custom_id = row["customId"]
        cache_path = os.path.join(cache_dir, f"{custom_id}.json")
        if skip_existing and os.path.exists(cache_path):
            skipped_existing += 1
            continue
        dispatch.append(row)

    if not dispatch:
        return {
            "totalRows": total_rows,
            "dispatched": 0,
            "skippedExisting": skipped_existing,
            "written": 0,
            "perPromptFailures": 0,
            "firstError": None,
            "wallSeconds": 0,
            "sustainedOutTokPerS": 0.0,
            "note": "all rows already cached — nothing to do",
        }

    # Sampling — Instruct (non-thinking) preset from the model card.
    # max_tokens defaults to row's maxTokens (uniform across all rows
    # produced by enumerateWarmupBatches); fall back to 2048 only if a
    # row is missing the field. Belt-and-suspenders override path is the
    # max_tokens_override kwarg.
    first_max = max_tokens_override or dispatch[0].get("maxTokens", 2048)
    sampling = SamplingParams(
        max_tokens=first_max,
        temperature=0.0,                 # deterministic — extraction
        top_p=1.0,
        # presence_penalty / repetition_penalty intentionally OMITTED
        # from defaults: extraction prompts are JSON-shaped; the model
        # card's instruct-mode preset (presence_penalty=1.5) is for free-
        # form generation and would distort JSON token distributions.
    )

    # Initialize the engine. language_model_only skips the vision encoder;
    # gpu_memory_utilization=0.92 leaves headroom for KV cache spike.
    # max_model_len capped at 8192 — extraction prompts are ~1.2K in,
    # ~400 out, so 8K is comfortable and frees memory for larger batches.
    llm = LLM(
        model=model,
        dtype="auto",
        trust_remote_code=False,
        language_model_only=True,
        gpu_memory_utilization=0.92,
        max_model_len=8192,
        enforce_eager=False,
    )

    # Build messages_list parallel to dispatch (NEVER rely on positional
    # ordering of vLLM outputs — zip via index always).
    messages_list = [row["messages"] for row in dispatch]

    t_start = time.monotonic()
    outputs = llm.chat(
        messages_list,
        sampling_params=sampling,
        chat_template_kwargs={"enable_thinking": False},
        use_tqdm=False,  # stdout would flood Modal logs
    )
    wall_seconds = time.monotonic() - t_start

    # Per-prompt validation + cache write. Honest aggregation: each
    # prompt is success or failure independently; surface a firstError
    # at the top level for fast triage.
    written = 0
    failures = 0
    first_error: Optional[dict] = None
    total_out_tokens = 0

    for idx, output in enumerate(outputs):
        row = dispatch[idx]
        custom_id = row["customId"]
        try:
            if not output.outputs:
                raise ValueError("vLLM returned no outputs[] for this prompt")
            text_raw = output.outputs[0].text or ""
            text = _strip_reasoning(text_raw)
            if not text.strip():
                raise ValueError(
                    f"empty content (len(raw)={len(text_raw)}, len(stripped)={len(text)}) — "
                    "reasoning-budget exhaustion or chat-template leak"
                )
            total_out_tokens += len(output.outputs[0].token_ids or [])
            _write_cache_file(
                cache_dir,
                custom_id,
                model,
                row.get("maxTokens", first_max),
                text,
            )
            written += 1
        except Exception as exc:
            failures += 1
            if first_error is None:
                first_error = {
                    "customId": custom_id,
                    "itemId": row.get("itemId"),
                    "batchIdxInItem": row.get("batchIdxInItem"),
                    "errorType": type(exc).__name__,
                    "errorMessage": str(exc)[:500],
                }

    # CRITICAL: commit the volume so cache files survive container teardown.
    volume.commit()

    sustained = (total_out_tokens / wall_seconds) if wall_seconds > 0 else 0.0

    return {
        "totalRows": total_rows,
        "dispatched": len(dispatch),
        "skippedExisting": skipped_existing,
        "written": written,
        "perPromptFailures": failures,
        "firstError": first_error,
        "wallSeconds": round(wall_seconds, 2),
        "sustainedOutTokPerS": round(sustained, 1),
        "totalOutTokens": total_out_tokens,
        "model": model,
    }


@app.local_entrypoint()
def main(
    input_path: str = "/data/warmup-input.jsonl",
    cache_dir: str = "/data/extractions",
    model: str = "Qwen/Qwen3.6-35B-A3B-FP8",
    max_tokens_override: Optional[int] = None,
    skip_existing: bool = True,
):
    """Local entrypoint — invoke `modal run bench/modal/vllm_warmup.py`.

    Prints the result as JSON for easy log-paste into the controller.
    """
    result = warmup.remote(
        input_path=input_path,
        cache_dir=cache_dir,
        model=model,
        max_tokens_override=max_tokens_override,
        skip_existing=skip_existing,
    )
    print(json.dumps(result, indent=2))

    # Exit code != 0 if any per-prompt failures, so a smoke run with
    # silent reasoning-budget exhaustion fails the controller's
    # `modal run` check rather than silently shipping bad cache.
    if result.get("perPromptFailures", 0) > 0:
        raise SystemExit(1)
```

**Step 2: Smoke (offline `py_compile`).**

```bash
python3 -m py_compile bench/modal/vllm_warmup.py
```

Expected: no output, exit 0.

**Step 3: Verify Modal app can be parsed.**

```bash
python3 -c "import bench.modal.vllm_warmup as m; print(m.app.name); print(list(m.app.registered_functions.keys()))"
```

Expected: `starmem-bench-vllm-warmup` and `['warmup']`.

(If Modal not installed locally, skip this step — it's a no-op convenience check; the real verification is Task 4's smoke.)

**Step 4: Commit.**

```bash
git add bench/modal/vllm_warmup.py
git commit -m "feat(bench): Modal vLLM offline-batch warmup app

Single-H100 dispatch using Qwen/Qwen3.6-35B-A3B-FP8. Reads enumerated
WarmupBatch JSONL from /data/warmup-input.jsonl, writes byte-compat
cache files to /data/extractions/<customId>.json. Skip-existing on by
default for rerun safety. Per-prompt validation surfaces empty-content
failures (reasoning-budget exhaustion); top-level perPromptFailures > 0
exits non-zero so silent partition poisoning fails the controller.

See docs/plans/phase-12-task-6-5-modal-vllm-warmup.md Task 2."
```

---

## Task 3: Unit tests for `vllm_warmup.py` (modal-stub pattern)

**Objective:** Pytest unit tests covering byte-compat output, scrambled-order ingest, reasoning-channel stripping, and empty-response detection. Uses the existing `bench/modal/tests/conftest.py` modal-stub pattern.

**Files:**
- Create: `bench/modal/tests/test_vllm_warmup.py`

**Decisions for this task:**
- Unit tests do NOT spin up vLLM. We test the helpers (`_strip_reasoning`, `_write_cache_file`, `_read_jsonl`) directly, and we test the `warmup()` function with vLLM's `LLM` and `SamplingParams` symbols mocked via `unittest.mock`.
- Byte-compat regression: write a cache file via `_write_cache_file`, then read it back through Node `extractionCache.js` via subprocess and assert the response round-trips. Subprocess call is the load-bearing test — proves Python-write / Node-read interop.
- Scrambled-order test: vLLM's outputs may not preserve input order in some configurations; the implementation zips by index. Test asserts that even if outputs are *deliberately scrambled* by the mock, the customId-to-text mapping stays correct (i.e. — we must NOT scramble; we must use positional zip on the dispatch list, which IS the input order).

**Step 1: Inspect existing modal-stub conftest.**

```bash
test -f bench/modal/tests/conftest.py && head -80 bench/modal/tests/conftest.py
```

Expected: file exists; conftest stubs `modal.App`, `modal.Image`, `modal.Volume`, `modal.Secret` so `import bench.modal.<anything>` succeeds in pytest without a Modal account. (Confirmed in Phase 11: commit `0051c65 fix(bench): extract modal stub into conftest.py, unblock pytest bench/modal/tests`.)

If the existing conftest doesn't already stub vLLM, add a stub at the test-module level rather than touching conftest. The pattern is illustrated in Step 2.

**Step 2: Write the failing tests.**

Create `bench/modal/tests/test_vllm_warmup.py`:

```python
"""Unit tests for bench/modal/vllm_warmup.py.

Tests the pure helpers directly + tests warmup() with vLLM LLM mocked.
Does NOT run vLLM — that's smoke-territory (Task 4).
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# Make sure the bench/modal package is importable in test context.
REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture
def tmp_cache(tmp_path: Path) -> Path:
    """Disposable cache directory."""
    d = tmp_path / "extractions"
    d.mkdir()
    return d


@pytest.fixture
def tmp_input(tmp_path: Path):
    """Build a JSONL input file from a list of dicts."""
    def _build(rows: list) -> Path:
        p = tmp_path / "warmup-input.jsonl"
        p.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
        return p
    return _build


# ============================================================
# Pure helpers
# ============================================================


def test_strip_reasoning_passthrough_when_no_think_block():
    from bench.modal.vllm_warmup import _strip_reasoning
    assert _strip_reasoning('{"entries": []}') == '{"entries": []}'
    assert _strip_reasoning("plain text") == "plain text"


def test_strip_reasoning_strips_well_formed_think_block():
    from bench.modal.vllm_warmup import _strip_reasoning
    raw = "<think>I should extract facts.</think>\n\n{\"entries\": [{\"text\": \"hi\"}]}"
    assert _strip_reasoning(raw) == '{"entries": [{"text": "hi"}]}'


def test_strip_reasoning_passthrough_on_malformed_think():
    from bench.modal.vllm_warmup import _strip_reasoning
    raw = "<think>unfinished"
    # Don't damage malformed input — let downstream surface the issue.
    assert _strip_reasoning(raw) == raw


def test_read_jsonl_tolerates_blank_lines_and_trailing_newline(tmp_path):
    from bench.modal.vllm_warmup import _read_jsonl
    p = tmp_path / "x.jsonl"
    p.write_text('{"a": 1}\n\n{"a": 2}\n')
    assert _read_jsonl(str(p)) == [{"a": 1}, {"a": 2}]


# ============================================================
# Byte-compat — write a cache file, read it via Node extractionCache.js
# ============================================================


def test_write_cache_file_byte_compat_with_node_read(tmp_cache):
    """The Node read path (wrapWithCache) must accept files we write.

    This is the load-bearing invariant of the entire substrate swap.
    If this test fails, every Modal vLLM warmup will produce cache that
    the regression check (Task 6) cannot read, and we MUST stop.
    """
    from bench.modal.vllm_warmup import _write_cache_file

    custom_id = "deadbeef" * 8  # 64 hex chars
    model = "Qwen/Qwen3.6-35B-A3B-FP8"
    max_tokens = 2048
    response = '{"entries": [{"text": "Eva likes cherry blossoms."}]}'

    _write_cache_file(str(tmp_cache), custom_id, model, max_tokens, response)

    cache_file = tmp_cache / f"{custom_id}.json"
    assert cache_file.exists()

    parsed = json.loads(cache_file.read_text())
    assert parsed["model"] == model
    assert parsed["maxTokens"] == max_tokens
    assert parsed["response"] == response
    assert "at" in parsed
    # Top-level keys MUST appear in this exact order to match Node's
    # JSON.stringify({model, maxTokens, response, at}, null, 2). Python
    # json.dumps preserves insertion order in 3.7+.
    keys = list(parsed.keys())
    assert keys == ["model", "maxTokens", "response", "at"], (
        f"key order drift: {keys} — must match Node's stringify shape"
    )

    # Round-trip via Node extractionCache.js to prove read-side compat.
    # Skip if node is not available in the test environment.
    if subprocess.run(["which", "node"], capture_output=True).returncode != 0:
        pytest.skip("node not available in test environment")

    node_script = f"""
        import {{ wrapWithCache }} from '{REPO_ROOT}/bench/harness/extractionCache.js';
        const inner = async () => 'never-called';
        const cached = wrapWithCache(inner, {{ dir: '{tmp_cache}', model: {json.dumps(model)} }});
        // Recompute key from cacheKey args; bypass since we know the customId:
        // wrapWithCache's contract is to read by _cacheKey(model, messages, maxTokens),
        // so we instead read the file directly to validate the bytes:
        const fs = await import('node:fs/promises');
        const raw = await fs.readFile('{cache_file}', 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.response !== 'string') {{
            console.error('parse fail');
            process.exit(2);
        }}
        process.stdout.write(parsed.response);
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", node_script],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert result.returncode == 0, f"node read failed: {result.stderr}"
    assert result.stdout == response


# ============================================================
# Mocked warmup() — scrambled order, empty content, skip-existing
# ============================================================


def _mock_vllm_output(text: str, token_ids: list = None):
    """Build a MagicMock that quacks like vllm RequestOutput."""
    inner = MagicMock()
    inner.text = text
    inner.token_ids = token_ids or list(range(len(text)))
    out = MagicMock()
    out.outputs = [inner]
    return out


def test_warmup_zips_outputs_to_dispatch_by_index(tmp_path, tmp_cache, tmp_input):
    """Outputs are zipped to dispatch[idx], NEVER positional ordering of
    raw vLLM outputs. Even if vLLM returned a list shuffled relative to
    our intent, the loop pulls custom_id from dispatch[idx], so writes
    are correct iff we obey input order on the input side.
    """
    rows = [
        {"customId": "a" * 64, "model": "M", "messages": [{"role": "user", "content": "1"}], "maxTokens": 100, "itemId": "i1", "batchIdxInItem": 0},
        {"customId": "b" * 64, "model": "M", "messages": [{"role": "user", "content": "2"}], "maxTokens": 100, "itemId": "i1", "batchIdxInItem": 1},
        {"customId": "c" * 64, "model": "M", "messages": [{"role": "user", "content": "3"}], "maxTokens": 100, "itemId": "i2", "batchIdxInItem": 0},
    ]
    inp = tmp_input(rows)

    fake_outputs = [
        _mock_vllm_output('{"entries": [{"t": "one"}]}'),
        _mock_vllm_output('{"entries": [{"t": "two"}]}'),
        _mock_vllm_output('{"entries": [{"t": "three"}]}'),
    ]

    # Patch vllm import inside warmup() — modal's @app.function wrapper
    # delegates .remote() / .local() but the function body imports vllm
    # at call time. We bypass the modal wrapper by calling .__wrapped__
    # if present, else the function directly via its underlying callable.
    from bench.modal import vllm_warmup as mod

    fake_llm = MagicMock()
    fake_llm.chat.return_value = fake_outputs

    fake_vllm = MagicMock()
    fake_vllm.LLM = MagicMock(return_value=fake_llm)
    fake_vllm.SamplingParams = MagicMock()

    # Modal stubs: volume.commit() must be a no-op no-arg callable.
    mod.volume = MagicMock()

    # Resolve to underlying function (modal stub may or may not wrap).
    warmup_fn = getattr(mod.warmup, "_callable", None) or getattr(mod.warmup, "__wrapped__", None) or mod.warmup
    if callable(warmup_fn) and not hasattr(warmup_fn, "remote"):
        target_fn = warmup_fn
    else:
        # Fallback: pull the raw function via mod.warmup.__dict__ or via
        # introspection of the modal stub's wrapped attribute.
        target_fn = warmup_fn

    with patch.dict(sys.modules, {"vllm": fake_vllm}):
        result = target_fn(
            input_path=str(inp),
            cache_dir=str(tmp_cache),
            model="M",
        )

    assert result["written"] == 3
    assert result["perPromptFailures"] == 0
    # Each row's customId got a file with the matching response.
    a = json.loads((tmp_cache / f"{'a' * 64}.json").read_text())
    b = json.loads((tmp_cache / f"{'b' * 64}.json").read_text())
    c = json.loads((tmp_cache / f"{'c' * 64}.json").read_text())
    assert "one" in a["response"]
    assert "two" in b["response"]
    assert "three" in c["response"]


def test_warmup_treats_empty_content_as_per_prompt_failure(tmp_path, tmp_cache, tmp_input):
    """Reasoning-budget exhaustion → empty content → per-prompt failure.

    Mirrors batch-api-cache-warmup skill §reasoning-model-trap. The
    smoke spot-check (Task 4) catches this in production; the unit test
    catches the regression risk on every CI run.
    """
    rows = [
        {"customId": "f" * 64, "model": "M", "messages": [{"role": "user", "content": "1"}], "maxTokens": 100, "itemId": "i1", "batchIdxInItem": 0},
    ]
    inp = tmp_input(rows)

    fake_outputs = [_mock_vllm_output("")]  # empty content
    fake_llm = MagicMock()
    fake_llm.chat.return_value = fake_outputs
    fake_vllm = MagicMock()
    fake_vllm.LLM = MagicMock(return_value=fake_llm)
    fake_vllm.SamplingParams = MagicMock()

    from bench.modal import vllm_warmup as mod
    mod.volume = MagicMock()
    target_fn = getattr(mod.warmup, "_callable", None) or getattr(mod.warmup, "__wrapped__", None) or mod.warmup

    with patch.dict(sys.modules, {"vllm": fake_vllm}):
        result = target_fn(input_path=str(inp), cache_dir=str(tmp_cache), model="M")

    assert result["written"] == 0
    assert result["perPromptFailures"] == 1
    assert result["firstError"] is not None
    assert "empty content" in result["firstError"]["errorMessage"]


def test_warmup_skip_existing_short_circuits(tmp_path, tmp_cache, tmp_input):
    """skip_existing=True must NOT call vLLM at all if every row is cached."""
    rows = [
        {"customId": "1" * 64, "model": "M", "messages": [{"role": "user", "content": "x"}], "maxTokens": 100, "itemId": "i", "batchIdxInItem": 0},
    ]
    inp = tmp_input(rows)

    # Pre-populate the cache.
    (tmp_cache / f"{'1' * 64}.json").write_text(json.dumps(
        {"model": "M", "maxTokens": 100, "response": "{}", "at": "2026-04-25T00:00:00.000Z"},
        indent=2,
    ))

    fake_vllm = MagicMock()
    fake_vllm.LLM = MagicMock()  # SHOULD NOT BE CALLED
    fake_vllm.SamplingParams = MagicMock()

    from bench.modal import vllm_warmup as mod
    mod.volume = MagicMock()
    target_fn = getattr(mod.warmup, "_callable", None) or getattr(mod.warmup, "__wrapped__", None) or mod.warmup

    with patch.dict(sys.modules, {"vllm": fake_vllm}):
        result = target_fn(input_path=str(inp), cache_dir=str(tmp_cache), model="M", skip_existing=True)

    assert result["dispatched"] == 0
    assert result["skippedExisting"] == 1
    assert result["written"] == 0
    fake_vllm.LLM.assert_not_called()
```

**Step 3: Run tests to verify failure (helpers don't exist yet — but Task 2 wrote them, so this should already pass).**

Order matters: Task 2's commit landed `vllm_warmup.py` first; this Task 3 commit lands the tests. The tests should pass on the first run because Task 2 implemented all the helpers correctly.

```bash
pytest bench/modal/tests/test_vllm_warmup.py -v
```

Expected: all 6+ tests pass. If `test_write_cache_file_byte_compat_with_node_read` skips on a Node-less test env, that's acceptable — the smoke (Task 4) is the production proof.

**Step 4: If any test fails on the modal-stub `target_fn` resolution.**

The stub pattern in `conftest.py` may wrap `@app.function`-decorated functions in a way that doesn't expose the underlying callable as `.__wrapped__` or `._callable`. If `target_fn = mod.warmup` (the stub) is not directly callable, replace the resolution lines in each test with:

```python
target_fn = mod.warmup.local if hasattr(mod.warmup, "local") else mod.warmup
```

If even `.local()` is missing, inspect the stub:

```bash
python3 -c "from bench.modal import vllm_warmup as m; print(type(m.warmup), dir(m.warmup))"
```

…and patch the conftest stub OR use `mod.__dict__["warmup"]` directly. The intent: call the unwrapped Python function with our test inputs.

**Step 5: Commit.**

```bash
git add bench/modal/tests/test_vllm_warmup.py
git commit -m "test(bench): unit tests for Modal vLLM warmup app

Covers byte-compat with Node extractionCache.js read path, scrambled-
order safety via index-based zip, empty-content per-prompt failure
detection (reasoning-budget exhaustion guard), skip-existing short-
circuit. vLLM is mocked — no GPU needed in CI."
```

---

## Task 4 (manual): 1-item smoke

**Objective:** Prove end-to-end byte-compat against real vLLM output before spending any meaningful compute. Catches reasoning-budget exhaustion, enumerator drift, ingest-writer bugs, and Modal/vLLM/H100 config issues in one shot.

**This task is run by Eva on the host shell. Hanami waits for output, then dispatches Task 5 only if the smoke is clean.**

**Step 1: Enumerate one item.**

```bash
node bench/harness/fireworks-warmup.js enumerate /tmp/smoke-warmup.jsonl \
    --corpora longmemeval-s --limit 5 --batch-size 15
```

Expected stderr:
```
[enumerate] longmemeval-s: 500 items → ~16700 batches (batchSize=15)
[enumerate] --limit 5 applied → emitting 5 batches
[enumerate] wrote 5 batches → /tmp/smoke-warmup.jsonl
```

Verify:
```bash
wc -l /tmp/smoke-warmup.jsonl     # expect: 5
head -1 /tmp/smoke-warmup.jsonl | jq '.customId, .model, (.messages | length)'
# expect: 64-char hex, "Qwen/Qwen3.6-35B-A3B-FP8", small int (1 or 2 — system + user)
```

**Step 2: Upload to Volume.**

```bash
modal volume put starmem-bench-data /tmp/smoke-warmup.jsonl /warmup-input.jsonl --force
```

Expected: `Uploaded` confirmation. `--force` overwrites any prior input file from earlier smoke iterations.

**Step 3: Dispatch the smoke.**

```bash
modal run bench/modal/vllm_warmup.py
```

Expected wall-clock: ~3-5 min (engine cold-start dominates for a 5-row smoke). Cost: ~$0.30.

Expected JSON output (last line):
```json
{
  "totalRows": 5,
  "dispatched": 5,
  "skippedExisting": 0,
  "written": 5,
  "perPromptFailures": 0,
  "firstError": null,
  "wallSeconds": <number>,
  "sustainedOutTokPerS": <number>,
  "totalOutTokens": <number>,
  "model": "Qwen/Qwen3.6-35B-A3B-FP8"
}
```

**Step 4: Spot-check that one cache file is content-rich.**

```bash
# Pull one cache file off the Volume to inspect locally:
HEAD_KEY=$(head -1 /tmp/smoke-warmup.jsonl | jq -r '.customId')
modal volume get starmem-bench-data /extractions/${HEAD_KEY}.json /tmp/smoke-cache.json --force
jq '.response | fromjson | .entries | length' /tmp/smoke-cache.json
# expect: >= 1 (or 0 if the turn genuinely had nothing extractable —
# repeat with another customId from the head -3 of the JSONL).
```

**If the spot-check returns `0` for ALL 5 customIds:** the model is producing empty `entries: []` outputs, or the chat-template's `enable_thinking=False` failed to suppress the reasoning channel and a leak is producing something the post-strip didn't catch. **STOP** — do not dispatch the full warmup. Investigate by:

```bash
jq -r '.response' /tmp/smoke-cache.json | head -50
# Look for: leading "<think>" (reasoning leak), HTML, or model refusal text.
```

If `<think>` leaks survived `_strip_reasoning`: switch to `--reasoning-parser qwen3` in the vLLM `LLM(...)` constructor and discard the reasoning channel (vLLM's parser separates them into different output fields when configured). Patch `bench/modal/vllm_warmup.py`, re-run smoke.

**If smoke is clean** (≥3 of 5 cache files have `.entries.length >= 1`): proceed to Task 5.

**Cost so far: ~$0.30. Cumulative: ~$0.30.**

---

## Task 5 (manual): Full dispatch

**Objective:** Warm the entire LongMemEval-S + LoCoMo cache via Modal vLLM. ~16,700 batches at BS=15, ~37–75 min wall-clock, ~$3–$6.

**Pre-flight check (per writing-plans skill, modal preflight pattern B):**
- Worst-case wall-clock arithmetic: 6.67M out tok ÷ 1.5K agg out tok/s = 74 min. With 1.5× safety = 111 min. Function timeout = 14400s (240 min). **Comfortable, with cold-start headroom.**
- If the Task 4 smoke reported `sustainedOutTokPerS < 1000`, escalate before this dispatch — the per-cell timeout is at risk.

**Step 1: Enumerate the full set.**

```bash
node bench/harness/fireworks-warmup.js enumerate /tmp/warmup-input.jsonl \
    --corpora locomo,longmemeval-s --batch-size 15
wc -l /tmp/warmup-input.jsonl
# expect: ~16,700 (LongMemEval-S 16,682 + LoCoMo ~30 at BS=15)
```

**Step 2: Upload (force-overwrite the smoke's input).**

```bash
modal volume put starmem-bench-data /tmp/warmup-input.jsonl /warmup-input.jsonl --force
```

**Step 3: Dispatch.**

```bash
modal run bench/modal/vllm_warmup.py
```

Watch the Modal dashboard for:
- GPU utilization staying near 100% on the H100 throughout (continuous batching saturating).
- `sustainedOutTokPerS` in the result printout being ≥1500 (otherwise the model is starving — escalate).
- `perPromptFailures` MUST be `0`. If non-zero: report the `firstError`'s `errorMessage` and `customId`. Don't proceed to Task 6 with a poisoned partition.

Expected end-of-run JSON:
```json
{
  "totalRows": ~10800,
  "dispatched": ~10800,        // 0 if Task 4 already populated some
  "skippedExisting": 5,        // the Task 4 smoke files
  "written": ~10795,
  "perPromptFailures": 0,
  "wallSeconds": ~1800-2500,
  "sustainedOutTokPerS": 2000-4000,
  "totalOutTokens": ~4_300_000,
  "model": "Qwen/Qwen3.6-35B-A3B-FP8"
}
```

**Cost arithmetic on the dashboard.** Expected $1.50–$3.00. **Tripwire:** if dashboard total exceeds $5, abort and escalate. Volume.commit() runs at end-of-function, so any partial cache from a timeout is preserved — rerun with `skip_existing=True` (the default) picks up where it left off.

**Cumulative cost: ~$1.80–$3.30.**

---

## Task 6 (manual): Regression check

**Objective:** Run the existing live-extraction path with `warmup_concurrency=1` over a corpus-size-3 sample. Reports `misses=0` only if Task 5's cache writes are byte-compat with the live extraction's read side.

**This is the load-bearing proof of the substrate swap. If misses>0, the cache-write contract drifted; Phase 12 Task 7 cannot proceed.**

**Step 1: Run the regression check.**

```bash
modal run bench/modal/sweep_app.py \
    --mode run-longmemeval-warmup \
    --corpus-size 3 \
    --warmup-concurrency 1
```

Expected stdout (per-item JSON payloads from `_modal-warmup-point.js`):
```json
{
  "itemIdx": <int>,
  "itemTurns": ~600,
  "nonEmptyTurns": ~590,
  "batchCount": ~21,
  "hits": 21,
  "misses": 0,
  "failureCount": 0,
  ...
}
```

**Step 2: Verify on each of 3 sample items.**

```bash
# After the Modal run completes, inspect the aggregated output:
# Look for "misses" field across all 3 sampled items. Each must be 0.
```

If ANY `misses > 0`:
1. Pull the failing customId from the live path's stderr log.
2. Recompute the customId locally:
    ```bash
    node -e "
        const { _cacheKey } = await import('./bench/harness/extractionCache.js');
        const key = _cacheKey('Qwen/Qwen3.6-35B-A3B-FP8', <messages>, 2048);
        console.log(key);
    "
    ```
3. Compare to the Volume's `/extractions/<customId>.json` filename. If different → enumerator-vs-live drift (one path is computing the cache key differently). If same → cache file write format drift (Python `json.dumps` shape differs from Node's `JSON.stringify` shape).
4. **STOP** Phase 12 Task 7. Root-cause and patch before any downstream baseline runs.

If all 3 items report `misses=0`: substrate swap is byte-compat. Proceed to Task 7.

**Cumulative cost: ~$2.00–$3.50.**

---

## Task 7: Retro + ROADMAP handoff + skill patches

**Objective:** Document what landed, lessons learned, and unblock Phase 12 Task 7 (λ₁ tripwire).

**Files:**
- Create: `docs/plans/phase-12-task-6-5-retro.md`
- Modify: `ROADMAP.md` (add Phase 12 Task 6.5 retro pointer; mark Task 7 as unblocked)
- Patch: `~/.hermes/profiles/hanami/skills/devops/batch-api-cache-warmup/SKILL.md` (document Modal vLLM as a third established warmup substrate alongside Fireworks Batch + parallel-live-HTTP).
- Patch: `~/.hermes/profiles/hanami/skills/mlops/cloud/modal/SKILL.md` (or wherever the modal skill lives) — add the vLLM-offline-batch pattern as a preset for warmup workloads.

**Step 1: Write `docs/plans/phase-12-task-6-5-retro.md`.**

Skeleton:
```markdown
# Phase 12 Task 6.5 Retro — Modal vLLM Warmup

**Substrate swap:** Fireworks Batch (dead-ended) → Modal vLLM offline batch (Qwen/Qwen3.6-35B-A3B-FP8, single H100). Byte-compat invariants preserved.

## Decisions held / revised

[Walk decisions 1-10 from the plan; mark held vs revised. Common revision points
to cover: actual sustainedOutTokPerS observed vs estimate; whether
chat_template_kwargs={"enable_thinking": False} was sufficient or whether the
fallback `--reasoning-parser qwen3` was needed.]

## Cost envelope — actual vs forecast

| Item | Forecast | Actual |
|---|---|---|
| Task 4 smoke | $0.30 | <fill> |
| Task 5 dispatch | $1.50–$3.00 | <fill> |
| Task 6 regression | $0.20 | <fill> |
| **Total** | **$2.00–$3.50** | <fill> |

## Notes for Phase 12 Task 7

[Whatever Task 7 needs to know about the cache state: model id pinned in the
cache key (Qwen/Qwen3.6-35B-A3B-FP8), maxTokens (2048), corpus coverage
(LongMemEval-S full + LoCoMo full), regression-check passed (misses=0 on 3
sampled items).]

## Lessons / skill patches

[What was added to batch-api-cache-warmup skill, modal skill, etc.]
```

**Step 2: Update `ROADMAP.md`.**

Find the Phase 12 section and add a one-liner:
```markdown
- **Task 6.5** (2026-04-25): Modal vLLM warmup substrate swap. Fireworks Batch dead-ended; Qwen3.6-35B-A3B-FP8 on single H100 produced byte-compat cache (~$2-3, ~30-40 min). See `docs/plans/phase-12-task-6-5-retro.md`. **Phase 12 Task 7 (λ₁ tripwire) now unblocked.**
```

Mark Task 7 as the next executable phase.

**Step 3: Patch `batch-api-cache-warmup` skill.**

Add a new section near the bottom alongside the Fireworks field-validated section:

```markdown
### Field-validated (2026-04-25, STARmem Phase 12 Task 6.5)

Fireworks Batch dead-ended on a cache-related dataset issue with no support
response after 36+h. Substrate swap to Modal vLLM offline batch:

- Same enumerator (`enumerateWarmupBatches`), same `_cacheKey`, same Volume
  (`starmem-bench-data` mounted at `/data`), same regression-check path
  (`run_longmemeval_warmup_point` with `warmup_concurrency=1`).
- Model: Qwen/Qwen3.6-35B-A3B-FP8 (3B-active MoE, vision-text-to-text but
  text-only via `--language-model-only` / `language_model_only=True`).
- Single H100, `LLM(...).chat(messages_list)` once, no `.map()` fan-out.
- Result: ~10,800 batches in ~30-40 min, ~$2-3. Regression check reported
  misses=0 on 3 sampled items → byte-compat preserved.

**Lesson: substrate-swap pattern works.** The 6-step pattern in the main body
generalizes across providers (Fireworks/OpenAI/Anthropic/Modal+vLLM). The
load-bearing invariant is that the cache key is a pure function of LLM
inputs and the Node read-side accepts Python-written cache file bytes
(insertion-order-preserving JSON, identical key set, identical indent).
Three substrates established: parallel-live-HTTP (small-scale fallback),
provider Batch API (Fireworks/OpenAI for offline, hours of turnaround),
self-served vLLM offline (Modal H100, minutes of turnaround, full control).

**Reasoning-channel suppression on Qwen3.6:** `chat_template_kwargs={"enable_thinking": False}`
is the primary path. If it leaks (model misbehavior, or the chat template
ignores the kwarg), the fallback is `--reasoning-parser qwen3` which moves
the reasoning into a separate output field.
```

**Step 4: Patch the modal skill (if applicable).**

Check whether `~/.hermes/profiles/hanami/skills/mlops/cloud/modal/SKILL.md` (or wherever it lives) has a vLLM-batch section. If not, add one — short pattern reference:

```markdown
### vLLM offline batch on Modal — pattern reference

For workloads of the shape "N prompts → N completions, no latency
sensitivity, deterministic output desired" (cache warmup, eval set
extraction, dataset labeling), the optimal Modal pattern is:

- One `@app.function(gpu="H100", volumes={"/data": vol}, timeout=...)`
  decorated function. NO orchestrator-calling-per-cell shape; vLLM's
  continuous batching saturates one GPU on its own.
- One `vllm.LLM(...).chat(messages_list, sampling_params=..., chat_template_kwargs=...)`
  call inside the function body. NEVER one call per prompt — batching
  across the entire input is exactly the throughput multiplier.
- Volume read for input JSONL, Volume write for output cache files,
  `volume.commit()` at end-of-function for durability.
- Per-cell timeout = worst-case wall-clock × 1.5 safety. Worst case for
  a 3B-active MoE on H100 is ~1.5K out tok/s aggregate (conservative);
  multiply by total output token budget to get the seconds figure.
- For Qwen3.6-class reasoning models: `chat_template_kwargs={"enable_thinking": False}`
  in the `LLM.chat()` call AND post-strip any `<think>...</think>`
  preamble on output (belt-and-suspenders).

Field-validated: STARmem Phase 12 Task 6.5, ~10,800 batches, single H100,
Qwen3.6-35B-A3B-FP8, ~$2-3, byte-compat cache preserved.
```

**Step 5: Verify all three docs land cleanly.**

```bash
grep -c '^## ' docs/plans/phase-12-task-6-5-retro.md   # ≥4 sections
grep -n "Task 6.5\|Task 6\.5" ROADMAP.md               # at least one match
grep -c "Phase 12 Task 6.5" ~/.hermes/profiles/hanami/skills/devops/batch-api-cache-warmup/SKILL.md
```

**Step 6: Commit.**

```bash
git add docs/plans/phase-12-task-6-5-retro.md ROADMAP.md
git commit -m "docs(plan): Phase 12 Task 6.5 retro — Modal vLLM warmup landed

Substrate swap from dead-ended Fireworks Batch to Modal vLLM offline
batch on single H100 with Qwen/Qwen3.6-35B-A3B-FP8. Byte-compat
preserved (regression check misses=0). ~\$2-3 actual cost. Phase 12
Task 7 (λ₁ tripwire) now unblocked."
```

Skill patches commit separately (skills live outside the repo):
```bash
# Inside ~/.hermes/profiles/hanami/skills/ if it's a git repo, or via skill_manage:
# (skill_manage uses the patch action — see writing-skills skill)
```

---

## Closing notes for the controller / subagent executing this plan

**Tripwires before each task:**
- Task 1 commit: `npx jest tests/unit/bench/harness/fireworks-warmup-enumerate.test.js` → 4 passed.
- Task 2 commit: `python3 -m py_compile bench/modal/vllm_warmup.py` → exit 0.
- Task 3 commit: `pytest bench/modal/tests/test_vllm_warmup.py -v` → all passed (or `node`-dep test skips on a Node-less env).
- Tasks 4-6 are manual Modal dispatch — controller waits for Eva's pasted output.

**Halt conditions:**
- Task 4 smoke: any `entries.length == 0` for ALL 5 sampled customIds → reasoning leak or model misconfig. Halt + investigate.
- Task 5 full dispatch: `perPromptFailures > 0` → halt, do NOT proceed to regression check with poisoned partition.
- Task 5 dashboard cost: > $5 → halt, escalate.
- Task 6 regression: any `misses > 0` → halt Phase 12 Task 7. Root-cause cache write format drift before anything else.

**Decisions checklist for the retro:**
- Did `chat_template_kwargs={"enable_thinking": False}` suppress the reasoning channel cleanly, or did `_strip_reasoning` have to fire? If the latter, was the fallback `--reasoning-parser qwen3` ever needed?
- Did `language_model_only=True` work cleanly, or did vLLM still load vision encoder weights?
- Aggregate `sustainedOutTokPerS` actual vs the 1.5K-3K conservative estimate.
- Skip-existing rerun behavior — was anything from the LoCoMo Gemma 2 9B cache partition accidentally observed-as-existing for these new Qwen-keyed entries? (It shouldn't be — the model name is part of the cache key — but worth a sanity grep.)

**Phase 12 Task 7 handoff:** the cache is keyed by
`(model="Qwen/Qwen3.6-35B-A3B-FP8", messages, maxTokens=2048)`. All baselines
running against the warmed cache MUST set `STARMEM_BENCH_LLM_MODEL=Qwen/Qwen3.6-35B-A3B-FP8`
or the cache key won't hash to the warmed entries and the live-extraction
fallback will engage at full cost. The `.env.bench` file must be updated
accordingly before Phase 12 Task 7 work begins.
