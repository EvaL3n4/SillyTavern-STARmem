# Phase 12 Task 6 — Fireworks Batch Warmup

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task. Companion to `phase-12-task-6-extraction-cost-decision.md`; read that first for the "why" (100× wall-clock miss, four candidate directions, correctness contract).

**Goal:** Warm the LongMemEval-S and LoCoMo extraction caches via Fireworks Batch Inference with Llama 3.3 70B Instruct, then resume Task 6's unchanged 4-retriever baselines dispatch against the warm cache.

**Architecture:** Fireworks Batch API consumes a JSONL dataset (one OpenAI-shape chat request per line) and emits a JSONL results dataset 2–4 hours later at 50% off serverless pricing with automatic prompt-cache credit on top. We refactor the per-batch enumeration already baked into `bench/harness/_modal-warmup-point.js` (Design A, parallel-HTTP-on-Modal) into a pure function, then a new Node CLI uses that function to enumerate the full cache-miss set for both corpora, uploads once, polls, and ingests results back into the same on-disk cache directory `wrapWithCache` writes to. `custom_id = extractionCache._cacheKey(...)` so the ingest step is a trivial rename. Design A remains alive as a regression check (after ingest, a `--corpus-size 1 --warmup-concurrency 1` Modal dispatch must report `misses=0`).

**Tech Stack:** Node 22 ES2022 modules (harness), Fireworks Batch Inference API (HTTP + JSONL), existing `extractionCache` / `renderExtractionPrompt` / `CorpusAdapter` infrastructure. No Modal involvement on the critical path; Modal stays as the dispatch substrate for Task 7 baselines.

---

**Decisions locked before writing this plan (see conversation 2026-04-23):**

1. **Extractor model.** `accounts/fireworks/models/llama-v3p3-70b-instruct`. Non-reasoning instruct model — no reasoning-tokens budget trap (unlike the gpt-oss-20b partition poisoning that cost ~$1.90 on 2026-04-23). Generally-available on Fireworks, 70B class gives extraction quality headroom vs Gemma 2 9B, and Eva has vetted it in the router stack. Cache key is `sha256(model, messages, maxTokens)` so this lands as a fresh partition alongside any pre-existing entries without touching them.
2. **Corpora scope.** Warm **both** LongMemEval-S (500 items) and LoCoMo (10 conversations) in the same submission. LoCoMo re-warm is ~$1 and ensures apples-to-apples in Task 7's per-corpus comparison — without it, LoCoMo baselines would confound extractor flavor (Gemma 2 9B) with LongMemEval-S's (Llama 3.3 70B). Existing Gemma LoCoMo cache entries remain on disk as a separate partition; the downstream baselines lookup picks whichever partition matches `STARMEM_BENCH_LLM_MODEL`.
3. **Orchestration runtime.** Node (consistent with warmup harness and the rest of `bench/harness/`). Trivial HTTP surface; Python would duplicate extraction-cache and enumerator logic that already lives in JS.
4. **Fireworks auth surface.** `FIREWORKS_API_KEY` env var + `FIREWORKS_ACCOUNT_ID` env var (both required). Re-uses the credential already in Eva's `.env.bench` (Fireworks key was one of the routes for live extraction). Plan explicitly forbids hardcoding either value in any file under source control; CLI fails fast if either is unset.
5. **Retry and resumability.** Job state is persisted to `bench/.cache/fireworks-warmup/<submission-id>/manifest.json` after each state transition (dataset created, file uploaded, job created, job completed). A second invocation of the CLI with `--resume <submission-id>` picks up from the latest persisted state. No in-flight state held only in memory — matches the Design A checkpoint-every-60s pattern from the five bundled fixes in commit `45ee9be`.
6. **Timeout / job expiry posture.** Fireworks batch jobs have a 24h ceiling with completed rows saved on expiry. `--continue-from <original-job-id>` job-creation support is **in scope** for this plan, not deferred — this is the batching sub-phase, so partial-recovery belongs here. Task 4's CLI gains a `continue <submission-id>` subcommand that creates a new job (+ output dataset) referencing the prior one; the ingest step walks every output dataset in the submission's job chain, not just the most recent. Expectations at plan draft: 50–100k batch lines, 2–6h expected turnaround well under ceiling — continue-from is failsafe, not primary path. Fireworks Llama 3.3 70B has a throughput-based soft rate limit (per Hindsight memory), so if a submission throttles into expiry, continue-from is our friend rather than a manual re-enumeration.
7. **Reasoning-token trap audit.** Llama 3.3 70B Instruct is a completion-only model (no `thinking`/harmony channel). Still-mandatory 1-item smoke spot-check per `plan-preflight-audit` §Reasoning-model cost-shape: read one cached response body and confirm `entries: [...]` is populated, not `[]`.
8. **Cost-model topology.** Per `plan-preflight-audit` §Cost-model topology transfer: budget is re-derived from Llama 3.3 70B on LongMemEval-S's own flattened-item topology, not ported from earlier Gemma+LoCoMo numbers. Inline arithmetic in §Cost envelope below; pre-submission audit step in Task 5 re-computes from the live enumerator output.
9. **Design A's continued existence.** `_modal-warmup-point.js` stays checked in. It becomes the primary regression check post-ingest: a Modal dispatch with `--corpus-size N --warmup-concurrency 1` must report `misses=0` on sampled items, confirming every cache file written by Fireworks ingest is byte-compatible with what `wrapWithCache` would produce on a live hit. If that check fails, the ingest is wrong — bail before Task 7 dispatches anything.
10. **Task 6 completion semantics.** Task 6 in `phase-12-multi-corpus.md` is "First live 4-retriever baselines on both corpora." This plan's Tasks 1–6 produce the warm cache; Task 7 (aliased 12.6.7 to avoid collision with Phase 12 Task 7 λ₁ tripwire) is the baselines dispatch itself. Phase-12 Task 6's Done-when checklist carries over unchanged.

---

## Execution status (2026-04-23 preflight)

Plan drafted + preflight-audited on 2026-04-23 against HEAD `aea1105`. Plan file had not previously landed; per `plan-preflight-audit` §"Exception — plan never committed yet," preflight findings are folded into the initial plan commit rather than a separate patch commit, with enumeration here for paper trail.

**Pre-dispatch fixes folded into Task 0:**

1. **Cost-model topology re-derivation.** Decision doc's 2026-04-23 numbers cited "7s per item, ~4–5 min full warmup" ported from LoCoMo. Re-derived from LongMemEval-S's 500 items × ~500–800 turns ÷ BATCH_SIZE=5 → ~50k–80k batches total. Matches the `4909-batch` figure the decision doc mentions from a prior partial run at reduced corpus. Plan's cost envelope (§below) now uses this range, not ported numbers.

2. **Reasoning-model trap pre-register.** gpt-oss-20b partition poisoning on 2026-04-23 (cached ~$1.90 in empty-content responses) is the cautionary tale. Llama 3.3 70B is non-reasoning, but Task 5's smoke checklist still includes a `jq '.response | fromjson | .entries | length'` spot-check on one ingested file to be sure. Cost to the plan: zero. Cost of skipping: ~$60 of silent empty partitions on the full submission.

3. **Cache-key model-string canonicalization.** Fireworks requires `accounts/fireworks/models/llama-v3p3-70b-instruct` as the model path. `extractionCache._cacheKey` hashes the model string as-is, so `STARMEM_BENCH_LLM_MODEL` during Task 7 baselines MUST use the same canonical string, not a shortened alias. Plan mandates the canonical form everywhere; Task 0 verification greps that no `llama-3.3-70b` (or similar informal spellings) appears in any CLI fixture.

4. **Already-shipped audit.** `ls bench/harness/fireworks-*` at HEAD: none. `ls bench/harness/warmup/` at HEAD: directory does not exist. All Tasks 1–4 targets are greenfield. `bench/harness/_modal-warmup-point.js` is the refactor source; confirmed at HEAD `aea1105` with `jq '.model'`-compatible cache format already in use.

5. **Task-type propagation unaffected.** Task 4 of Phase 12 already shipped `qa.taskType` / `qa.abstention` threading through `runHarness`. This plan's Tasks 1–7 don't touch metrics / runner / seeder — they only populate the extraction cache a consolidation step reads. No interaction with downstream baselines code.

6. **Test-count baseline pinned.** HEAD `aea1105` = 82 suites / 865 tests green (jest) + 25 tests (pytest). Plan's per-task test arithmetic is relative to 865/82 at plan commit.

7. **LoCoMo existing-baselines re-label.** `docs/bench/baselines/2026-04-23-locomo-live.md` (commit `0e9c17d`) was produced against Gemma 2 9B IT. Task 7 dispatch here will write a sibling report against Llama 3.3 70B. The original report keeps its filename; new report at `2026-04-XX-locomo-llama33-live.md` with cross-reference. `baseline.json` gains per-extractor nesting under `perCorpus.locomo` — reserved for a small Task 7 schema migration, documented inline.

8. **Design A regression-check semantics.** Post-ingest, `modal run bench/modal/sweep_app.py --mode run-longmemeval-warmup --corpus-size 3 --warmup-concurrency 1 --extractor-model accounts/fireworks/models/llama-v3p3-70b-instruct` is expected to report `hits=M, misses=0` on 3 sampled items. If any `misses > 0` on a warmup invocation over already-ingested items, the ingest step has drifted from `wrapWithCache`'s on-disk schema — STOP before Task 7.

9. **Plan-length guardrail.** Target ≥1500 lines given 8 tasks + cost model + error playbook. Draft lands at ~1600.

**Design-call annotations (not bugs, noted for retro clarity):**

- Batch API `inferenceParameters` vs per-row `body.max_tokens`. Fireworks docs show both: job-level defaults via `inferenceParameters.maxTokens`, per-row overrides in each JSONL `body`. Plan puts the authoritative value per-row so every request matches `EXTRACT_MAX_TOKENS` exactly (no chance of a job-level default drifting from source). Prompt caching doesn't require anything specific on our side — Fireworks applies it automatically when identical prefix content repeats across requests (which the system prompt will).

- LoCoMo re-warm creates a *second* LoCoMo cache partition (Gemma entries untouched). Two extractor partitions living side-by-side on disk is fine for now (cache keys partition cleanly on model string); Phase 13 cleanup may consolidate if we pick a canonical extractor.

---

## Cost envelope (re-derived 2026-04-23)

| Corpus | Items | Median turns/item | Batches/item (BATCH_SIZE=5) | Total batches |
|---|---|---|---|---|
| LongMemEval-S | 500 | ~100 (trimmed haystack + single-session flatten) | ~20 | ~10,000 |
| LoCoMo | 10 | ~400 | ~80 | ~800 |
| **Total** | | | | **~10,800** |

Per-batch envelope (system prompt + 5 turns):

- Input tokens: ~1,200 (system prompt ~400 + transcript ~800 avg for 5 turns)
- Output tokens: ≤ `EXTRACT_MAX_TOKENS` (source of truth `src/consolidation/extractFacts.js`), typical ~200–400

Llama 3.3 70B Instruct batch pricing (Fireworks serverless $0.90/M in + $0.90/M out, batch = 50%):

- **Input base:** ~$0.45/M × 10,800 × 1,200 = ~$5.83
- **Output base:** ~$0.45/M × 10,800 × 400 (cap-conservative) = ~$1.94
- **Prompt-cache discount:** system prompt (~400 tok) identical across all ~10,800 requests. ~50% cache credit on those tokens for all but the first. Effective: input drops to ~$3.20.
- **Estimated total:** ~$5–8 for the full submission.

Decision doc cited $56 budget; we're comfortably under that with room for a re-run if ingest drifts. If the pre-submission audit in Task 5 reveals total batches materially higher (e.g. >30k), escalate to Eva before clicking create — the disease is in the enumerator or BATCH_SIZE, not the submission.

**Wall-clock:** Fireworks doesn't publish batch SLAs, but empirically 2–4h for this volume. Job-expiry ceiling is 24h; `--continue-from` resumption is available if we hit it. Not a design concern at 10k batches.

---

## 0. Scope and non-goals

**In scope:**
- Pure-function batch enumerator at `bench/harness/warmup/enumerate.js` (refactored from `_modal-warmup-point.js`)
- Fireworks Batch API HTTP client at `bench/harness/warmup/fireworks-batch.js`
- Cache-ingest writer at `bench/harness/warmup/cache-ingest.js`
- CLI entry + resume manifest at `bench/harness/fireworks-warmup.js`
- Local 1-item smoke producing a cache file byte-compatible with Design A
- Full submission (LongMemEval-S 500 + LoCoMo 10) + poll + ingest
- Task 7 baselines dispatch on both corpora against the warm cache
- Retro + `plan-preflight-audit` skill patch documenting Fireworks Batch as a production-proven substrate for cache warmup

**Out of scope (explicit):**
- Any Modal changes on the critical path (Modal remains unchanged as the baselines substrate)
- Per-batch cost instrumentation beyond what `usage` fields in the result JSONL give us (we budget offline from the dashboard, not inline)
- Re-warming the existing Gemma LoCoMo cache — that stays on disk as a separate partition
- Fine-tuning / distillation use cases of Fireworks batch — we only use the inference mode
- Extracting the warmup entry-point abstraction further (e.g. pluggable backends Modal-live / Fireworks-batch) — YAGNI, both substrates exist side-by-side but nothing demands a common abstraction yet

---

## 1. Architecture

### 1.1 Data flow

```
[corpora/*.js adapters]                               [Fireworks Batch API]
        │                                                   │
        ▼                                                   │
  enumerate.js ─── (custom_id, model, messages, ...)        │
        │                                                   │
        ▼                                                   │
  JSONL file ───────────────────────────►  dataset upload   │
        │                                                   │
        ▼                                                   │
  manifest.json                                             │
        │                                                   │
        ▼                                                   │
  job create ─────────────────────────────► RUNNING ────────┤
                                                            │
                          [results.jsonl] ◄─────────────────┘
                                │
                                ▼
                        cache-ingest.js
                                │
                                ▼
                  bench/.cache/extractions/<hash>.json
                       (byte-compatible with wrapWithCache)
```

### 1.2 Key-compat invariant

For every batch `(messages, maxTokens)` produced by `enumerate.js`, the on-disk cache path must be:

```
bench/.cache/extractions/<sha256(model + "\0" + JSON.stringify(messages) + "\0" + String(maxTokens))>.json
```

Content:

```json
{
  "model": "accounts/fireworks/models/llama-v3p3-70b-instruct",
  "maxTokens": <EXTRACT_MAX_TOKENS>,
  "response": "<string from Fireworks result .choices[0].message.content>",
  "at": "<ISO timestamp at ingest time>"
}
```

This exactly matches `wrapWithCache`'s write side (verified: `bench/harness/extractionCache.js:92–102`). On a subsequent live-extractor call with the same model + messages + maxTokens, `wrapWithCache`'s read side hits this file and returns `parsed.response` directly.

**Regression gate:** a unit test in `tests/unit/bench/warmup/cache-ingest.test.js` round-trips one ingest → `wrapWithCache(null).hit` pattern and asserts the cached `response` comes back verbatim. Zero byte drift tolerated.

### 1.3 File layout after this plan

```
bench/
├── harness/
│   ├── fireworks-warmup.js              # NEW  CLI entrypoint
│   ├── _modal-warmup-point.js            # MODIFIED  imports from warmup/
│   ├── warmup/                           # NEW directory
│   │   ├── enumerate.js                  # NEW  pure-function batch enumerator
│   │   ├── fireworks-batch.js            # NEW  HTTP client for Fireworks Batch API
│   │   └── cache-ingest.js               # NEW  results JSONL → cache files
│   ├── extractionCache.js                # unchanged
│   ├── llmExtractor.js                   # unchanged
│   └── seeder.js                         # unchanged
└── .cache/
    ├── extractions/                      # existing — target for ingest
    └── fireworks-warmup/                 # NEW — submission manifests
        └── <submission-id>/
            ├── manifest.json
            ├── input.jsonl               # what we uploaded
            └── results.jsonl             # what Fireworks returned (downloaded)
```

Tests:

```
tests/
└── unit/
    └── bench/
        └── warmup/
            ├── enumerate.test.js         # NEW   ~8 assertions
            ├── fireworks-batch.test.js   # NEW  ~10 assertions (fetch-mocked)
            └── cache-ingest.test.js      # NEW   ~6 assertions (fs-fixtured)
```

### 1.4 Contracts (locked)

```typescript
// enumerate.js
type WarmupBatch = {
    customId: string;        // = extractionCache._cacheKey(model, messages, maxTokens)
    model: string;           // canonical Fireworks path
    messages: ChatMessage[];
    maxTokens: number;
};

function enumerateWarmupBatches(
    items: CorpusConversation[],
    opts: { model: string; extractMaxTokens: number; batchSize: number },
): WarmupBatch[];

// fireworks-batch.js
type FireworksAuth = { accountId: string; apiKey: string };
function createDataset(auth, datasetId): Promise<void>;
function uploadJsonl(auth, datasetId, localPath): Promise<void>;
function createJob(auth, jobId, opts: { model, inputDatasetId, outputDatasetId, inferenceParameters }): Promise<void>;
function getJob(auth, jobId): Promise<{ state, ...rest }>;
function downloadResults(auth, datasetId, destDir): Promise<{ resultsPath, errorsPath | null }>;

// cache-ingest.js
function ingestResults(
    resultsJsonlPath: string,
    opts: { cacheDir: string; model: string; maxTokens: number },
): Promise<{ written: number; skipped: number; errors: Array<{ customId, reason }> }>;
```

### 1.5 Sibling-pattern inheritance

`bench/harness/fireworks-warmup.js` (new CLI) mirrors the conventions of `bench/harness/_modal-warmup-point.js`:

- Top-of-file: env validation with explicit error messages and `process.exit(2)`
- stderr for human progress, stdout reserved for JSON payload
- `console.log` remapped to stderr at top of file so downstream code can't accidentally pollute stdout
- No process-level state across function boundaries — everything flows through explicit params
- Each file `import`s exactly what it uses from the shared warmup modules, no barrel files

---

## 2. Execution mode

**Controller owns:**
- Task 0 (plan commit + preflight re-verify)
- Task 5 (1-item smoke + verification)
- Task 6 (full submission dispatch — it's mostly waiting; no subagent value)
- Task 7 (baselines synthesis from Eva's Modal dispatch)
- Task 8 (retro + skill patch)

**Subagent (Fireworks / GLM-5 via delegate_task) owns:**
- Task 1 (enumerator refactor + unit tests)
- Task 2 (Fireworks HTTP client + fetch-mocked unit tests)
- Task 3 (cache-ingest writer + round-trip unit test)
- Task 4 (CLI entry + manifest persistence + integration smoke)

**Parallel dispatch opportunities:**
- Task 2 ∥ Task 3 after Task 1 lands. Disjoint file sets; both depend only on enumerator types from Task 1.

**Sequential dependencies:**
- 0 → 1 → {2 ∥ 3} → 4 → 5 → 6 → 7 → 8

---

## Overview of tasks

| # | Task | Primary files | Owner | Est. LOC | Est. tests added |
|---|------|---|---|---|---|
| 0 | Plan commit + preflight re-verify | this plan | Controller | plan only | 0 |
| 1 | Enumerator refactor + regression | `bench/harness/warmup/enumerate.js`, `_modal-warmup-point.js`, test | Subagent | ~200 | +8 |
| 2 | Fireworks Batch HTTP client | `bench/harness/warmup/fireworks-batch.js`, test | Subagent | ~300 | +10 |
| 3 | Cache-ingest writer | `bench/harness/warmup/cache-ingest.js`, test | Subagent | ~150 | +6 |
| 4 | CLI + manifest persistence | `bench/harness/fireworks-warmup.js`, test | Subagent | ~250 | +5 |
| 5 | 1-item smoke + ingest verification | manifest + cache files | Controller | artifacts | 0 |
| 6 | Full submission dispatch + poll | manifest + results JSONL + cache | Controller + Eva | artifacts | 0 |
| 7 | Baselines dispatch on both corpora | `docs/bench/baselines/2026-04-XX-*-llama33-live.md`, `baseline.json` | Controller + Eva Modal | artifacts | 0 |
| 8 | Retro + skill patch | `docs/plans/phase-12-task-6-fireworks-retro.md`, `plan-preflight-audit/SKILL.md` | Controller | retro | 0 |

**Total runtime/test code:** ~900 LOC + 29 tests → target jest 894 / 85 suites after Task 4.

---

## Task 0: Plan commit + preflight re-verify

**Objective:** Land this plan, re-verify jcm index freshness, confirm baseline test counts, re-confirm no pre-shipped files exist.

**Files:**
- Create: `docs/plans/phase-12-task-6-fireworks-batch.md` (this file)

**Step 1: Verify plan file shape**

```bash
wc -l docs/plans/phase-12-task-6-fireworks-batch.md
# Expected: ≥1500

grep -c "^## Task " docs/plans/phase-12-task-6-fireworks-batch.md
# Expected: 9 (Tasks 0-8)

grep -n '=\s*\*\*\*\|=\*\*\*' docs/plans/phase-12-task-6-fireworks-batch.md
# Expected: empty output (no secrets-guard redactions)
```

**Step 2: Re-run preflight checks**

```bash
# Already-shipped audit on all Task 1-4 targets
ls bench/harness/fireworks-warmup.js bench/harness/warmup/ 2>&1
# Expected: "No such file or directory" on both — greenfield

# Test-count baseline
npm test 2>&1 | tail -5
# Expected: Test Suites: 82 passed, 82 total / Tests: 865 passed, 865 total

cd bench/modal && python3 -m pytest -q 2>&1 | tail -3 && cd ../..
# Expected: 25 passed
```

Any failure here blocks Task 1; fix must land in its own commit.

**Step 3: Re-index with jcm**

```
mcp_jcodemunch_index_folder(
    path="/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem",
    incremental=true,
    use_ai_summaries=false
)
```

**Step 4: Verify env has Fireworks credentials ready (does not block commit, but blocks Task 5)**

```bash
grep -E "^(FIREWORKS_API_KEY|FIREWORKS_ACCOUNT_ID)" .env.bench 2>/dev/null | wc -l
# Expected: 2 — both present. If not, add before Task 5 dispatches.
# The plan never reads them from source control; operator adds locally.
```

**Step 5: Commit**

```bash
git add docs/plans/phase-12-task-6-fireworks-batch.md
git commit -m "docs(plans): phase 12 task 6 fireworks-batch warmup plan"
```

Expected range: 1 commit.

**Done-when:**
- [ ] Plan file lands, `grep -c "^## Task "` = 9
- [ ] Preflight audit confirms no pre-shipped files
- [ ] jcm index fresh
- [ ] npm test 82/865 green, pytest 25 green
- [ ] Plan commit landed

---

## Task 1: Enumerator refactor

**Objective:** Extract the per-item per-batch enumeration currently embedded in `_modal-warmup-point.js` into a pure function `enumerateWarmupBatches(items, opts)`. Refactor the Modal warmup point to import from the new module. Keep the byte-for-byte cache-key-compatibility contract intact.

**Owner:** Subagent.

**Files:**
- Create: `bench/harness/warmup/enumerate.js` (~100 LOC pure function + JSDoc)
- Create: `tests/unit/bench/warmup/enumerate.test.js` (~100 LOC, 8 assertions)
- Modify: `bench/harness/_modal-warmup-point.js` (replace inline enumeration with import + call; preserve all logging, concurrency, and stats behavior)

**Preflight for subagent:**

```
Read these files in full before touching anything:
1. bench/harness/_modal-warmup-point.js — lines 108-162 are the enumeration + extraction loop to factor out
2. bench/harness/extractionCache.js — _cacheKey is what we replicate for custom_id
3. src/consolidation/extractFacts.js — renderExtractionPrompt + EXTRACT_MAX_TOKENS
4. src/core/constants.js — CONSOLIDATION.BATCH_SIZE
5. bench/harness/seeder.js:221-226 — the empty-turn filter predicate (non-empty-trim)

The refactored enumerator must produce the IDENTICAL hash for each (model, messages, maxTokens) triple that the Modal warmup point currently produces. Any deviation = cache drift = wasted spend.
```

**Step 1: Write failing test at `tests/unit/bench/warmup/enumerate.test.js`**

```javascript
import { enumerateWarmupBatches } from '../../../../bench/harness/warmup/enumerate.js';
import { _cacheKey } from '../../../../bench/harness/extractionCache.js';
import { renderExtractionPrompt, EXTRACT_MAX_TOKENS } from '../../../../src/consolidation/extractFacts.js';

describe('enumerateWarmupBatches', () => {
    const MODEL = 'accounts/fireworks/models/llama-v3p3-70b-instruct';

    const mkItem = (id, turnTexts) => ({
        id,
        turns: turnTexts.map((text, idx) => ({
            speaker: idx % 2 === 0 ? 'user' : 'assistant',
            text,
            sessionId: 0,
            turnIndex: idx,
        })),
        qa: [],
    });

    test('produces one batch per BATCH_SIZE window', () => {
        const items = [mkItem('x', Array.from({ length: 12 }, (_, i) => `turn-${i}`))];
        const batches = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        expect(batches).toHaveLength(3); // ceil(12/5)
    });

    test('filters empty-trim turns (matches seeder.js)', () => {
        const items = [mkItem('e', ['hello', '', '   ', 'world'])];
        const batches = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        // 2 non-empty turns → 1 batch
        expect(batches).toHaveLength(1);
        expect(batches[0].messages.some(m => m.content.includes('hello'))).toBe(true);
        expect(batches[0].messages.some(m => m.content.includes('world'))).toBe(true);
    });

    test('customId matches extractionCache._cacheKey byte-for-byte', () => {
        const items = [mkItem('y', ['foo', 'bar', 'baz'])];
        const [batch] = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        const expected = _cacheKey(MODEL, batch.messages, batch.maxTokens);
        expect(batch.customId).toBe(expected);
    });

    test('messages shape matches renderExtractionPrompt output', () => {
        const items = [mkItem('z', ['alpha', 'beta'])];
        const [batch] = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        const expected = renderExtractionPrompt([
            { role: 'user', content: 'alpha' },
            { role: 'user', content: 'beta' },
        ]);
        expect(batch.messages).toEqual(expected);
    });

    test('maxTokens is EXTRACT_MAX_TOKENS by default', () => {
        const items = [mkItem('m', ['a', 'b'])];
        const [batch] = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        expect(batch.maxTokens).toBe(EXTRACT_MAX_TOKENS);
    });

    test('empty items array produces no batches', () => {
        expect(enumerateWarmupBatches([], {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        })).toEqual([]);
    });

    test('multi-item: customIds are unique across items with disjoint content', () => {
        const items = [
            mkItem('a', ['one', 'two', 'three']),
            mkItem('b', ['four', 'five', 'six']),
        ];
        const batches = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        const ids = new Set(batches.map(b => b.customId));
        expect(ids.size).toBe(batches.length);
    });

    test('all batches carry the provided model verbatim', () => {
        const items = [mkItem('m', ['foo', 'bar'])];
        const batches = enumerateWarmupBatches(items, {
            model: MODEL,
            extractMaxTokens: EXTRACT_MAX_TOKENS,
            batchSize: 5,
        });
        expect(batches.every(b => b.model === MODEL)).toBe(true);
    });
});
```

Run it:

```bash
npx jest tests/unit/bench/warmup/enumerate.test.js
```

Expected: FAIL — "Cannot find module ... warmup/enumerate.js".

**Step 2: Create `bench/harness/warmup/enumerate.js`**

```javascript
/**
 * Pure-function batch enumerator for warmup workflows.
 *
 * Reproduces the exact (model, messages, maxTokens) triples that STARmem's
 * consolidate() pipeline produces given a list of corpus items. Consumers
 * route the batches to either live extraction (Modal warmup) or batch-mode
 * submission (Fireworks Batch Inference) — the enumerator is substrate-
 * agnostic.
 *
 * Invariants preserved from bench/harness/_modal-warmup-point.js:
 *   1. Empty-turn filter matches seeder.js: !turn.text || turn.text.trim().length === 0
 *   2. BATCH_SIZE reads from CONSOLIDATION.BATCH_SIZE at call time (not destructured)
 *   3. messages shape matches renderExtractionPrompt({role: 'user', content: turn.text})
 *   4. customId equals extractionCache._cacheKey(model, messages, maxTokens)
 *
 * @module bench/harness/warmup/enumerate
 * @see docs/plans/phase-12-task-6-fireworks-batch.md Task 1
 */

import { renderExtractionPrompt } from '../../../src/consolidation/extractFacts.js';
import { _cacheKey } from '../extractionCache.js';

/**
 * @typedef {object} WarmupBatch
 * @property {string} customId
 * @property {string} model
 * @property {Array<{role: string, content: string}>} messages
 * @property {number} maxTokens
 * @property {string} itemId          - For diagnostics only; not part of the cache key.
 * @property {number} batchIdxInItem  - Index within the item's batch stream.
 */

/**
 * @typedef {object} EnumerateOptions
 * @property {string} model              - Canonical model string; hashed into customId.
 * @property {number} extractMaxTokens   - Max output tokens; hashed into customId.
 * @property {number} batchSize          - Turns per batch; e.g. CONSOLIDATION.BATCH_SIZE.
 */

/**
 * @param {Array<{id: string, turns: Array<{text: string}>}>} items
 * @param {EnumerateOptions} opts
 * @returns {WarmupBatch[]}
 */
export function enumerateWarmupBatches(items, opts) {
    if (!Array.isArray(items)) {
        throw new Error('enumerateWarmupBatches: items must be an array');
    }
    if (!opts || typeof opts !== 'object') {
        throw new Error('enumerateWarmupBatches: opts required');
    }
    const { model, extractMaxTokens, batchSize } = opts;
    if (typeof model !== 'string' || model.length === 0) {
        throw new Error('enumerateWarmupBatches: opts.model must be a non-empty string');
    }
    if (!Number.isInteger(extractMaxTokens) || extractMaxTokens <= 0) {
        throw new Error('enumerateWarmupBatches: opts.extractMaxTokens must be a positive integer');
    }
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error('enumerateWarmupBatches: opts.batchSize must be a positive integer');
    }

    /** @type {WarmupBatch[]} */
    const out = [];

    for (const item of items) {
        const nonEmpty = item.turns.filter(t => t.text && t.text.trim().length > 0);
        for (let i = 0; i < nonEmpty.length; i += batchSize) {
            const slice = nonEmpty.slice(i, i + batchSize);
            const messages = renderExtractionPrompt(
                slice.map(t => ({ role: 'user', content: t.text })),
            );
            const customId = _cacheKey(model, messages, extractMaxTokens);
            out.push({
                customId,
                model,
                messages,
                maxTokens: extractMaxTokens,
                itemId: item.id,
                batchIdxInItem: Math.floor(i / batchSize),
            });
        }
    }
    return out;
}
```

**Step 3: Run test, expect pass**

```bash
npx jest tests/unit/bench/warmup/enumerate.test.js
```

Expected: 8 passed.

**Step 4: Modify `_modal-warmup-point.js` to delegate to the enumerator**

Replace lines 108–162 (the inline filter + batch + extract loop) with:

```javascript
// After the existing adapter load + env checks:
const { enumerateWarmupBatches } = await import('./warmup/enumerate.js');
const { BATCH_SIZE } = CONSOLIDATION;
const batches = enumerateWarmupBatches([item], {
    model,
    extractMaxTokens: EXTRACT_MAX_TOKENS,
    batchSize: BATCH_SIZE,
});
console.error(`[warmup item=${itemIdx}] ${new Date().toISOString()} enumerated ${batches.length} batches (BATCH_SIZE=${BATCH_SIZE})`);
```

Then in the Promise.all loop, replace the `renderExtractionPrompt(...)` call with `batch.messages` — the enumerator already rendered them:

```javascript
await Promise.all(batches.map((batch, bIdx) => limit(async () => {
    try {
        await cachedExtractor('warmup', batch.messages, batch.maxTokens);
    } catch (err) {
        // ... existing error-handling block unchanged ...
    }
})));
```

Remove the now-unused imports at the top of `_modal-warmup-point.js`: `renderExtractionPrompt`, `EXTRACT_MAX_TOKENS` (`EXTRACT_MAX_TOKENS` stays if still used in the fallback; check after edit). The `CONSOLIDATION` and `extractionCache` imports remain.

**Step 5: Sanity-check: re-run the full test suite**

```bash
npm test 2>&1 | tail -5
# Expected: Test Suites: 83 passed, 83 total / Tests: 873 passed, 873 total
# (82 + 1 new suite = 83; 865 + 8 new assertions = 873)
```

**Step 6: Commit**

```bash
git add bench/harness/warmup/enumerate.js tests/unit/bench/warmup/enumerate.test.js bench/harness/_modal-warmup-point.js
git commit -m "feat(bench): extract enumerateWarmupBatches (Phase 12 Task 6 Fireworks)"
```

**Done-when:**
- [ ] `bench/harness/warmup/enumerate.js` created
- [ ] 8 new tests pass
- [ ] `_modal-warmup-point.js` imports the enumerator; behavior preserved
- [ ] Full suite green at 83/873

---

## Task 2: Fireworks Batch HTTP client

**Objective:** Thin, fetch-mocked HTTP client for the five operations needed: create dataset, upload JSONL, create batch job, poll job, download results. All operations retry 5xx + network errors; 4xx fails fast.

**Owner:** Subagent (parallel with Task 3).

**Files:**
- Create: `bench/harness/warmup/fireworks-batch.js`
- Create: `tests/unit/bench/warmup/fireworks-batch.test.js`

**Preflight for subagent:**

```
Fireworks Batch API reference: https://fireworks.ai/docs/guides/batch-inference
- Base URL: https://api.fireworks.ai/v1
- Auth: Authorization: Bearer <FIREWORKS_API_KEY>
- Dataset create:  POST /v1/accounts/{account_id}/datasets
                   body {"datasetId": "...", "dataset": {"userUploaded": {}}}
- Dataset upload:  POST /v1/accounts/{account_id}/datasets/{id}:upload
                   multipart/form-data with file field
- Job create:      POST /v1/accounts/{account_id}/batchInferenceJobs?batchInferenceJobId={jobId}
                   body {"model": "accounts/fireworks/models/llama-v3p3-70b-instruct",
                         "inputDatasetId": "accounts/{accountId}/datasets/{id}",
                         "outputDatasetId": "accounts/{accountId}/datasets/{id}"}
- Job get:         GET  /v1/accounts/{account_id}/batchInferenceJobs/{jobId}
                   → {"state": "PENDING|RUNNING|COMPLETED|FAILED|EXPIRED|VALIDATING"}
- Results fetch:   GET  /v1/accounts/{account_id}/datasets/{id}:getDownloadEndpoint
                   → {"filenameToSignedUrls": {"results.jsonl": "<signed>", ...}}

Follow the existing llmExtractor.js retry pattern:
- 4xx → fail fast (throw with retryable=false)
- 5xx / network → retry up to maxRetries with exponential backoff (200ms × 2^n, cap 5s)
- Report final error with attempt count

Do NOT use any external npm package (fireworks-ai, openai, etc.) — stick to fetch + FormData.
```

**Step 1: Write failing tests at `tests/unit/bench/warmup/fireworks-batch.test.js`**

Write 11 tests covering:

1. `createDataset` sends POST to correct URL with correct body
2. `createDataset` throws retryable=false on 4xx
3. `createDataset` retries on 5xx up to maxRetries (mock fetch rejecting twice then succeeding)
4. `uploadJsonl` sends multipart/form-data with file field
5. `createJob` constructs the input/output dataset fully-qualified refs correctly
6. `createJob` with `continueFromJobId` includes the fully-qualified `continueFrom` ref in the request body
7. `getJob` returns the parsed JSON on 200
8. `getJob` recognizes all six documented job states (VALIDATING, PENDING, RUNNING, COMPLETED, FAILED, EXPIRED)
9. `downloadResults` hits the getDownloadEndpoint route, then fetches signed URLs
10. Network-error retry budget exhaustion produces a final error naming `maxRetries + 1` attempts
11. Auth header is bearer-formatted on every call (`Authorization: Bearer <key>`)

Use `jest.fn()` to mock `global.fetch`. Install it in `beforeEach`, restore in `afterEach`.

```javascript
// Sketch — subagent implements full suite
import { jest } from '@jest/globals';
import {
    createDataset, uploadJsonl, createJob, getJob, downloadResults,
} from '../../../../bench/harness/warmup/fireworks-batch.js';

describe('fireworks-batch client', () => {
    const AUTH = { accountId: 'test-account', apiKey: 'test-key' };
    let originalFetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('createDataset posts correct body to accounts/test-account/datasets', async () => {
        const calls = [];
        global.fetch = jest.fn(async (url, opts) => {
            calls.push({ url, opts });
            return { ok: true, status: 200, json: async () => ({}) };
        });
        await createDataset(AUTH, 'my-dataset');
        expect(calls[0].url).toBe('https://api.fireworks.ai/v1/accounts/test-account/datasets');
        expect(calls[0].opts.method).toBe('POST');
        expect(calls[0].opts.headers.Authorization).toBe('Bearer test-key');
        const body = JSON.parse(calls[0].opts.body);
        expect(body.datasetId).toBe('my-dataset');
        expect(body.dataset).toEqual({ userUploaded: {} });
    });

    // ... remaining 9 tests
});
```

Run it:

```bash
npx jest tests/unit/bench/warmup/fireworks-batch.test.js
```

Expected: FAIL — module doesn't exist.

**Step 2: Create `bench/harness/warmup/fireworks-batch.js`**

Implement all five functions. Use a shared private helper for retry + auth + URL:

```javascript
const FIREWORKS_BASE = 'https://api.fireworks.ai/v1';

async function _request(auth, path, opts = {}) {
    const { method = 'GET', body, headers = {}, maxRetries = 3 } = opts;
    const url = `${FIREWORKS_BASE}${path}`;
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${auth.apiKey}`,
                    ...headers,
                },
                body,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                const err = new Error(`fireworks-batch: ${method} ${path} → ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
                if (res.status >= 400 && res.status < 500) {
                    err.retryable = false;
                    throw err;
                }
                lastError = err;
            } else {
                const ct = res.headers.get('content-type') || '';
                return ct.includes('application/json') ? await res.json() : await res.text();
            }
        } catch (err) {
            if (err?.retryable === false) throw err;
            lastError = err;
        }
        if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, Math.min(5000, 200 * 2 ** attempt)));
        }
    }
    throw new Error(`fireworks-batch: failed after ${maxRetries + 1} attempts — ${lastError?.message ?? 'unknown'}`);
}

export async function createDataset(auth, datasetId) {
    return _request(auth, `/accounts/${auth.accountId}/datasets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetId, dataset: { userUploaded: {} } }),
    });
}

// ... uploadJsonl, createJob, getJob, downloadResults
```

**Details per function:**

- `uploadJsonl(auth, datasetId, localPath)` — reads file as Buffer via `node:fs/promises`, wraps in a `FormData` with `file` field, POSTs to `/accounts/{a}/datasets/{d}:upload`. Do NOT set `Content-Type` header — `fetch` derives the multipart boundary automatically.

- `createJob(auth, jobId, { model, inputDatasetId, outputDatasetId, inferenceParameters, continueFromJobId })` — constructs the fully-qualified dataset refs as `accounts/{a}/datasets/{inputDatasetId}` (not raw id). POSTs to `/accounts/{a}/batchInferenceJobs?batchInferenceJobId={jobId}`. `inferenceParameters` is optional; when omitted, per-row `body.max_tokens` controls. `continueFromJobId` is optional; when set, body includes `"continueFrom": "accounts/{a}/batchInferenceJobs/{continueFromJobId}"` so Fireworks processes only unfinished/failed rows from the referenced job (used by the `continue` subcommand after an EXPIRED transition).

- `getJob(auth, jobId)` — GET, returns parsed JSON.

- `downloadResults(auth, datasetId, destDir)` — GET to `{datasetId}:getDownloadEndpoint`, parses `filenameToSignedUrls`, fetches each signed URL into `destDir`, returns `{ resultsPath, errorsPath }` (errorsPath is null if no errors file was produced). Signed URLs don't need the Authorization header; only the initial endpoint request does.

**Step 3: Run tests, expect pass**

```bash
npx jest tests/unit/bench/warmup/fireworks-batch.test.js
# Expected: 10 passed
```

**Step 4: Commit**

```bash
git add bench/harness/warmup/fireworks-batch.js tests/unit/bench/warmup/fireworks-batch.test.js
git commit -m "feat(bench): fireworks batch inference HTTP client (Phase 12 Task 6)"
```

**Done-when:**
- [ ] All 5 functions implemented with retry logic matching llmExtractor pattern
- [ ] 10 tests pass, mocking `global.fetch`
- [ ] No external npm deps added
- [ ] Auth key never logged; header is the only touch point

---

## Task 3: Cache-ingest writer

**Objective:** Given a Fireworks results JSONL file and the submission's `(model, maxTokens)` tuple, write one cache file per successful row under `bench/.cache/extractions/<customId>.json` byte-compatible with `wrapWithCache`'s output. Errors logged; partial ingest permitted.

**Owner:** Subagent (parallel with Task 2).

**Files:**
- Create: `bench/harness/warmup/cache-ingest.js`
- Create: `tests/unit/bench/warmup/cache-ingest.test.js`

**Preflight for subagent:**

```
Read bench/harness/extractionCache.js lines 90-107 — this is the write side we're reproducing.
The written JSON must have keys {model, maxTokens, response, at} in exactly this order (the
wrapWithCache JSON.stringify call uses key-insertion order). `at` is an ISO timestamp from ingest
time, not from when Fireworks produced the result.

The Fireworks results JSONL file has one object per row with shape:
{
  "custom_id": "<sha256 hex>",
  "response": {
    "status_code": 200,
    "request_id": "...",
    "body": {
      "id": "chatcmpl-...",
      "choices": [{
        "message": {"role": "assistant", "content": "<the extraction>"},
        "finish_reason": "stop"
      }],
      "usage": {...}
    }
  }
}

Successful rows have status_code=200 and choices[0].message.content as a string. Rows where
content is null/empty OR status_code != 200 go to errors[], not to cache writes. Missing
finish_reason="stop" (e.g. "length" for truncation) is a cache-skip reason too — downstream
consolidate() would get a malformed response anyway.
```

**Step 1: Write failing tests at `tests/unit/bench/warmup/cache-ingest.test.js`**

```javascript
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestResults } from '../../../../bench/harness/warmup/cache-ingest.js';

describe('ingestResults', () => {
    let tmp;

    beforeEach(async () => {
        tmp = await mkdtemp(path.join(tmpdir(), 'starmem-ingest-'));
    });

    test('writes one cache file per 200-status row', async () => {
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, [
            JSON.stringify({
                custom_id: 'aaa',
                response: {
                    status_code: 200,
                    body: { choices: [{ message: { content: '{"entries":[]}' }, finish_reason: 'stop' }] },
                },
            }),
            JSON.stringify({
                custom_id: 'bbb',
                response: {
                    status_code: 200,
                    body: { choices: [{ message: { content: '{"entries":[{"content":"x","subject":"X"}]}' }, finish_reason: 'stop' }] },
                },
            }),
        ].join('\n'));

        const stats = await ingestResults(results, {
            cacheDir,
            model: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
            maxTokens: 2048,
        });

        expect(stats.written).toBe(2);
        expect(stats.skipped).toBe(0);
        expect(stats.errors).toEqual([]);

        const files = await readdir(cacheDir);
        expect(files.sort()).toEqual(['aaa.json', 'bbb.json']);
    });

    test('written file round-trips through wrapWithCache read path', async () => {
        // Ingest, then use _cacheKey + file read to verify byte-compat.
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, JSON.stringify({
            custom_id: 'zzz',
            response: {
                status_code: 200,
                body: { choices: [{ message: { content: 'HELLO' }, finish_reason: 'stop' }] },
            },
        }));
        await ingestResults(results, {
            cacheDir,
            model: 'some-model',
            maxTokens: 1024,
        });
        const raw = await readFile(path.join(cacheDir, 'zzz.json'), 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.response).toBe('HELLO');
        expect(parsed.model).toBe('some-model');
        expect(parsed.maxTokens).toBe(1024);
        expect(typeof parsed.at).toBe('string');
    });

    test('skips rows with non-200 status_code', async () => {
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, JSON.stringify({
            custom_id: 'fail',
            response: { status_code: 500, body: { error: 'upstream' } },
        }));
        const stats = await ingestResults(results, {
            cacheDir,
            model: 'm',
            maxTokens: 512,
        });
        expect(stats.written).toBe(0);
        expect(stats.skipped).toBe(1);
        expect(stats.errors).toHaveLength(1);
        expect(stats.errors[0].customId).toBe('fail');
    });

    test('skips rows with null/empty content', async () => {
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, [
            JSON.stringify({
                custom_id: 'empty',
                response: {
                    status_code: 200,
                    body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
                },
            }),
            JSON.stringify({
                custom_id: 'null',
                response: {
                    status_code: 200,
                    body: { choices: [{ message: { content: null }, finish_reason: 'stop' }] },
                },
            }),
        ].join('\n'));
        const stats = await ingestResults(results, {
            cacheDir,
            model: 'm',
            maxTokens: 512,
        });
        expect(stats.written).toBe(0);
        expect(stats.skipped).toBe(2);
    });

    test('skips rows with finish_reason != stop', async () => {
        const results = path.join(tmp, 'results.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, JSON.stringify({
            custom_id: 'trunc',
            response: {
                status_code: 200,
                body: { choices: [{ message: { content: '{"entries":...' }, finish_reason: 'length' }] },
            },
        }));
        const stats = await ingestResults(results, {
            cacheDir,
            model: 'm',
            maxTokens: 512,
        });
        expect(stats.written).toBe(0);
        expect(stats.skipped).toBe(1);
        expect(stats.errors[0].reason).toMatch(/finish_reason/i);
    });

    test('tolerates empty JSONL file (zero rows, zero writes, zero errors)', async () => {
        const results = path.join(tmp, 'empty.jsonl');
        const cacheDir = path.join(tmp, 'cache');
        await writeFile(results, '');
        const stats = await ingestResults(results, {
            cacheDir,
            model: 'm',
            maxTokens: 512,
        });
        expect(stats).toEqual({ written: 0, skipped: 0, errors: [] });
    });
});
```

**Step 2: Create `bench/harness/warmup/cache-ingest.js`**

```javascript
/**
 * Ingest Fireworks Batch results JSONL → extractionCache-compatible files.
 *
 * Byte-compatibility contract with bench/harness/extractionCache.js:
 *   - filename is `${customId}.json` under opts.cacheDir
 *   - content is JSON.stringify({model, maxTokens, response, at}, null, 2) + '\n'
 *     where keys appear in that exact insertion order
 *
 * @module bench/harness/warmup/cache-ingest
 * @see docs/plans/phase-12-task-6-fireworks-batch.md Task 3
 */

import { createReadStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

/**
 * @param {string} resultsJsonlPath
 * @param {object} opts
 * @param {string} opts.cacheDir
 * @param {string} opts.model
 * @param {number} opts.maxTokens
 * @returns {Promise<{written: number, skipped: number, errors: Array<{customId: string, reason: string}>}>}
 */
export async function ingestResults(resultsJsonlPath, opts) {
    const { cacheDir, model, maxTokens } = opts;
    if (typeof cacheDir !== 'string' || cacheDir.length === 0) {
        throw new Error('ingestResults: opts.cacheDir required');
    }
    if (typeof model !== 'string' || model.length === 0) {
        throw new Error('ingestResults: opts.model required');
    }
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
        throw new Error('ingestResults: opts.maxTokens must be a positive integer');
    }

    await mkdir(cacheDir, { recursive: true });

    let written = 0;
    let skipped = 0;
    /** @type {Array<{customId: string, reason: string}>} */
    const errors = [];

    const stream = createReadStream(resultsJsonlPath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
        if (line.trim().length === 0) continue;
        /** @type {{custom_id?: string, response?: {status_code?: number, body?: {choices?: Array<{message?: {content?: string | null}, finish_reason?: string}>}}}} */
        let row;
        try {
            row = JSON.parse(line);
        } catch (err) {
            skipped++;
            errors.push({ customId: '(unparseable)', reason: `JSON parse: ${err.message.slice(0, 120)}` });
            continue;
        }
        const customId = row?.custom_id;
        if (typeof customId !== 'string' || customId.length === 0) {
            skipped++;
            errors.push({ customId: '(missing)', reason: 'row missing custom_id' });
            continue;
        }
        const status = row?.response?.status_code;
        if (status !== 200) {
            skipped++;
            errors.push({ customId, reason: `status_code=${status}` });
            continue;
        }
        const choice = row?.response?.body?.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== 'string' || content.length === 0) {
            skipped++;
            errors.push({ customId, reason: 'message.content missing or empty' });
            continue;
        }
        const finish = choice?.finish_reason;
        if (finish !== 'stop') {
            skipped++;
            errors.push({ customId, reason: `finish_reason=${finish}` });
            continue;
        }

        const file = path.join(cacheDir, `${customId}.json`);
        const body = JSON.stringify(
            { model, maxTokens, response: content, at: new Date().toISOString() },
            null,
            2,
        );
        try {
            await writeFile(file, body, 'utf8');
            written++;
        } catch (err) {
            skipped++;
            errors.push({ customId, reason: `write failed: ${err.message.slice(0, 120)}` });
        }
    }

    return { written, skipped, errors };
}
```

**Step 3: Run tests, expect pass**

```bash
npx jest tests/unit/bench/warmup/cache-ingest.test.js
# Expected: 6 passed
```

**Step 4: Commit**

```bash
git add bench/harness/warmup/cache-ingest.js tests/unit/bench/warmup/cache-ingest.test.js
git commit -m "feat(bench): fireworks batch results → extractionCache ingest (Phase 12 Task 6)"
```

**Done-when:**
- [ ] `ingestResults` writes files with wrapWithCache-byte-compatible JSON
- [ ] Non-200 rows, empty content, truncation skipped with reasons
- [ ] 6 tests pass
- [ ] Round-trip test verifies `wrapWithCache` could read the ingested file

---

## Task 4: CLI entry + manifest persistence

**Objective:** User-facing Node CLI that orchestrates the full flow: enumerate → write JSONL → create dataset → upload → create job → poll → download → ingest. Persists state after every transition so a resume is zero-touch.

**Owner:** Subagent.

**Files:**
- Create: `bench/harness/fireworks-warmup.js`
- Create: `tests/unit/bench/warmup/fireworks-warmup-cli.test.js` (unit tests for the argv parser + manifest state machine only; the end-to-end is Task 5)

**Preflight for subagent:**

```
Read these files in full before touching:
1. bench/harness/_modal-warmup-point.js — conventions for env validation, exit codes, stderr routing
2. bench/harness/warmup/enumerate.js — the pure function we drive
3. bench/harness/warmup/fireworks-batch.js — the HTTP surface
4. bench/harness/warmup/cache-ingest.js — the final write step

The CLI uses process.argv directly (no yargs/commander). Keep the arg surface minimal.
```

**CLI surface:**

```
Usage:
  node bench/harness/fireworks-warmup.js submit \
    --corpora locomo,longmemeval-s \
    [--model accounts/fireworks/models/llama-v3p3-70b-instruct] \
    [--submission-id auto]

  node bench/harness/fireworks-warmup.js resume <submission-id>

  node bench/harness/fireworks-warmup.js continue <submission-id>
    # Use when a prior job expired (state=expired) or partially failed.
    # Reads manifest, creates a NEW output dataset + NEW job with
    # inferenceParameters.continueFrom = <previous jobId>. Fireworks processes
    # only unfinished / failed rows from the original. Appended to jobChain[]
    # in the manifest.

Env (required for submit/resume/continue):
  FIREWORKS_API_KEY
  FIREWORKS_ACCOUNT_ID

Env (required for submit, optional for resume/continue since model is persisted):
  — none beyond auth; model comes from --model flag with default above
```

**Manifest shape (`bench/.cache/fireworks-warmup/<submission-id>/manifest.json`):**

```json
{
  "submissionId": "starmem-20260423-abc123",
  "model": "accounts/fireworks/models/llama-v3p3-70b-instruct",
  "corpora": ["locomo", "longmemeval-s"],
  "maxTokens": 2048,
  "batchSize": 5,
  "createdAt": "2026-04-23T18:42:00Z",
  "state": "enumerated | uploaded | submitted | polling | completed | ingested | expired | failed",
  "inputDatasetId": "starmem-20260423-abc123-in",
  "jobChain": [
    {
      "jobId": "starmem-20260423-abc123",
      "outputDatasetId": "starmem-20260423-abc123-out",
      "state": "EXPIRED | COMPLETED | FAILED",
      "continueFrom": null,
      "submittedAt": "2026-04-23T18:43:00Z",
      "terminalAt": "2026-04-24T18:43:00Z"
    },
    {
      "jobId": "starmem-20260423-abc123-c1",
      "outputDatasetId": "starmem-20260423-abc123-out-c1",
      "state": "COMPLETED",
      "continueFrom": "starmem-20260423-abc123",
      "submittedAt": "2026-04-24T19:00:00Z",
      "terminalAt": "2026-04-24T22:30:00Z"
    }
  ],
  "batchCount": 10800,
  "lastPolledAt": "2026-04-23T20:00:00Z",
  "lastPolledState": "RUNNING",
  "ingestStats": { "written": 0, "skipped": 0, "errors": [] }
}
```

`jobChain[0]` is the original submission; index ≥1 are continue-from extensions. The active job the poller watches is always `jobChain[jobChain.length - 1]`. Ingest (Step 5 of `main`) walks *every* output dataset in the chain, downloading and ingesting each — this way expiry-partial rows from the first job plus continuation rows from the second both land in the extraction cache.

**State machine:**

```
(new) ──submit──► enumerated (JSONL written to disk)
enumerated ──► uploaded (dataset created + file uploaded)
uploaded ──► submitted (job created, jobChain=[{jobId, outputDatasetId}])
submitted ──► polling (first poll saw RUNNING or PENDING)
polling ──► completed (poll saw COMPLETED on active job)
polling ──► expired (poll saw EXPIRED on active job — partial rows saved)
completed ──► ingested (results downloaded for every jobChain entry + cache files written)
expired ──(continue subcommand)──► submitted (new job appended to jobChain, state reset)
expired ──(continue subcommand, eventual)──► completed ──► ingested

Any transition failure → failed with error message.

Resume logic (`resume <submission-id>`):
- load manifest.json
- if state == ingested → print "already done" and exit 0
- if state == completed → skip to download + ingest (walks ALL jobChain[].outputDatasetId)
- if state == polling → skip to next poll on jobChain[-1]
- if state == submitted → skip to polling loop on jobChain[-1]
- if state == uploaded → skip to job create (first entry of jobChain)
- if state == enumerated → skip to dataset create + upload
- if state == expired → print message directing operator to `continue` subcommand; exit 5
- if state == failed → fail fast with the recorded error; operator must rm -rf and resubmit

Continue logic (`continue <submission-id>`):
- load manifest.json; state must be `expired` or `failed` on jobChain[-1] with recoverable=true
- generate new jobId = `${submissionId}-c${jobChain.length}` and new outputDatasetId
- createDataset(auth, newOutputDatasetId)
- createJob(auth, newJobId, { model, inputDatasetId: unchanged, outputDatasetId: new,
    inferenceParameters: { continueFrom: jobChain[-1].jobId } })
- append {jobId, outputDatasetId, continueFrom: prev, submittedAt} to jobChain
- set state=submitted, persist
- enter polling loop for the new job
```

**Step 1: Write failing tests for the argv parser + state machine**

```javascript
import { parseArgv, nextState } from '../../../../bench/harness/fireworks-warmup.js';

describe('fireworks-warmup CLI', () => {
    test('parseArgv submit with defaults', () => {
        const parsed = parseArgv(['submit', '--corpora', 'locomo']);
        expect(parsed.command).toBe('submit');
        expect(parsed.corpora).toEqual(['locomo']);
        expect(parsed.model).toBe('accounts/fireworks/models/llama-v3p3-70b-instruct');
    });

    test('parseArgv submit with multi-corpus + model override', () => {
        const parsed = parseArgv(['submit', '--corpora', 'locomo,longmemeval-s', '--model', 'accounts/fireworks/models/foo']);
        expect(parsed.corpora).toEqual(['locomo', 'longmemeval-s']);
        expect(parsed.model).toBe('accounts/fireworks/models/foo');
    });

    test('parseArgv resume', () => {
        const parsed = parseArgv(['resume', 'starmem-20260423-abc']);
        expect(parsed.command).toBe('resume');
        expect(parsed.submissionId).toBe('starmem-20260423-abc');
    });

    test('parseArgv rejects unknown command', () => {
        expect(() => parseArgv(['delete', 'x'])).toThrow(/unknown command/i);
    });

    test('nextState is a total function for every documented transition', () => {
        expect(nextState('enumerated')).toBe('uploaded');
        expect(nextState('uploaded')).toBe('submitted');
        expect(nextState('submitted')).toBe('polling');
        expect(nextState('polling', { jobState: 'COMPLETED' })).toBe('completed');
        expect(nextState('polling', { jobState: 'RUNNING' })).toBe('polling');
        expect(nextState('polling', { jobState: 'FAILED' })).toBe('failed');
        expect(nextState('completed')).toBe('ingested');
    });
});
```

Run: `npx jest tests/unit/bench/warmup/fireworks-warmup-cli.test.js` — expect FAIL.

**Step 2: Create `bench/harness/fireworks-warmup.js`**

Layout:

```javascript
// Export parseArgv + nextState for unit testing
export function parseArgv(argv) { /* ... */ }
export function nextState(state, extras) { /* ... */ }

// Default export / side-effectful main() only runs under `import.meta.url === process.argv[1]`
async function main() {
    const parsed = parseArgv(process.argv.slice(2));
    // ... enumerator → fireworks-batch → cache-ingest orchestration
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
```

**Inside `main()`:**

1. Validate env: `FIREWORKS_API_KEY`, `FIREWORKS_ACCOUNT_ID`. Exit 2 with clear message if missing.
2. `submit` branch:
   a. Generate `submissionId = "starmem-${YYYYMMDD}-${rand6hex}"` unless provided.
   b. Create manifest directory, write initial manifest with state `(null)`.
   c. For each corpus in `parsed.corpora`, import its adapter from `bench/corpora/index.js` via `getAdapter(name)`, load conversations (`{ offline: true }` — adapter is expected to have been pre-downloaded locally).
   d. Call `enumerateWarmupBatches(allItems, { model, extractMaxTokens: EXTRACT_MAX_TOKENS, batchSize: CONSOLIDATION.BATCH_SIZE })`.
   e. Write the JSONL: each line is `{ custom_id, body: { messages, max_tokens, temperature: 0 } }`. (No `model` field in per-row body — it's set at job creation time. Per-row override would require passing to job; Fireworks uses job-level model.)
   f. Update manifest `state=enumerated`, persist.
   g. `createDataset(auth, inputDatasetId)`, `uploadJsonl(auth, inputDatasetId, localJsonlPath)`. Update manifest `state=uploaded`, persist.
   h. `createDataset(auth, outputDatasetId)`. (Fireworks requires the output dataset to pre-exist.)
   i. `createJob(auth, jobId, { model, inputDatasetId: fullyQualified, outputDatasetId: fullyQualified })`. Update manifest `state=submitted`, persist.
   j. Enter polling loop (step 3 below).
3. `resume` branch:
   a. Load manifest from `bench/.cache/fireworks-warmup/<id>/manifest.json`. If missing, exit 3.
   b. Dispatch on `state`: jump to appropriate step from submit flow.
4. Polling loop:
   a. Every 60 seconds: `getJob(auth, jobId)`.
   b. If `state === 'RUNNING' || 'PENDING' || 'VALIDATING'`: update manifest `lastPolledAt`/`lastPolledState`, persist, sleep, loop.
   c. If `state === 'COMPLETED'`: update manifest `state=completed`, persist, break.
   d. If `state === 'FAILED' || 'EXPIRED'`: update manifest `state=failed`, persist, exit 4 with the Fireworks error message in stderr.
   e. Log one line per poll to stderr: `[poll] <jobState> elapsed=<mm:ss>`.
5. Download + ingest:
   a. `downloadResults(auth, outputDatasetId, submissionDir)`.
   b. `ingestResults(resultsPath, { cacheDir: DEFAULT_CACHE_DIR, model, maxTokens })`.
   c. Update manifest `state=ingested`, `ingestStats`, persist.
   d. Print final summary to stdout: `{ submissionId, batchCount, written, skipped, errors: errors.length }`.

**Exit codes:**
- 0: success (state=ingested)
- 1: unhandled error
- 2: missing env or invalid args
- 3: submission not found for resume
- 4: job failed or expired

**Step 3: Run tests, expect pass**

```bash
npx jest tests/unit/bench/warmup/fireworks-warmup-cli.test.js
# Expected: 5 passed (parseArgv ×4 + nextState ×1)
```

**Step 4: Self-check full suite**

```bash
npm test 2>&1 | tail -5
# Expected: 86 suites / 894 tests green
# (83 → 86 = +3 suites; 873 → 894 = +21 new assertions across Tasks 2-4)
```

**Step 5: Commit**

```bash
git add bench/harness/fireworks-warmup.js tests/unit/bench/warmup/fireworks-warmup-cli.test.js
git commit -m "feat(bench): fireworks-warmup CLI + manifest state machine (Phase 12 Task 6)"
```

**Done-when:**
- [ ] CLI exports `parseArgv` and `nextState` for testing
- [ ] Manifest persists after every state transition
- [ ] `resume` picks up from the latest persisted state
- [ ] 5 new tests pass; suite green at 86/894
- [ ] No external npm deps

---

## Task 5: 1-item smoke + verification

**Objective:** Run the CLI against a single-item corpus subset with Llama 3.3 70B, verify one cache file lands with a non-empty `entries: [...]` JSON response, then run Design A regression check to confirm byte-compat with `wrapWithCache`.

**Owner:** Controller.

**Preflight:**

```bash
# Confirm creds
grep -E "^(FIREWORKS_API_KEY|FIREWORKS_ACCOUNT_ID)" .env.bench | wc -l
# Expected: 2

# Confirm corpora are cached locally (adapter offline-mode requirement)
ls bench/.cache/corpora/longmemeval-s*.json 2>/dev/null && echo "longmemeval cached" || echo "need to fetch first"
ls bench/.cache/corpora/locomo*.json 2>/dev/null && echo "locomo cached" || echo "need to fetch first"
```

If either corpus is not cached, run its adapter's online fetch once before the smoke (doesn't touch Fireworks; just pre-populates the HuggingFace download).

**Step 1: Create a smoke-only fixture**

Temporarily invoke the CLI with a `--limit 1 --corpora longmemeval-s` flag. If the CLI doesn't have `--limit`, add it in this task as a ~10-LOC argv extension: `--limit <n>` takes the first N items from each corpus after enumeration.

Alternative (if --limit is out of scope): set `STARMEM_FIREWORKS_SMOKE_LIMIT=1` env var, honored inside `main()` to truncate enumerated batches to the first N.

Decision: prefer the env var — it stays out of the CLI's documented surface for the full submission.

Patch `fireworks-warmup.js`:

```javascript
const smokeLimit = Number(process.env.STARMEM_FIREWORKS_SMOKE_LIMIT);
let batches = enumerateWarmupBatches(allItems, { model, extractMaxTokens, batchSize });
if (Number.isInteger(smokeLimit) && smokeLimit > 0) {
    batches = batches.slice(0, smokeLimit);
    console.error(`[smoke] truncated batches to ${batches.length} (STARMEM_FIREWORKS_SMOKE_LIMIT=${smokeLimit})`);
}
```

Commit the patch:

```bash
git add bench/harness/fireworks-warmup.js
git commit -m "feat(bench): STARMEM_FIREWORKS_SMOKE_LIMIT env gate (Phase 12 Task 6 smoke)"
```

**Step 2: Run the smoke submission**

```bash
STARMEM_FIREWORKS_SMOKE_LIMIT=1 node bench/harness/fireworks-warmup.js submit --corpora longmemeval-s
```

Expected stderr progression:

```
[smoke] truncated batches to 1
[submit] submissionId=starmem-20260423-abc123
[submit] state=enumerated → uploaded → submitted
[poll] VALIDATING elapsed=0:00
[poll] PENDING elapsed=1:00
[poll] RUNNING elapsed=2:00
[poll] COMPLETED elapsed=3:30
[ingest] written=1 skipped=0 errors=0
```

Expected stdout: one JSON line summarizing the submission.

**Step 3: Content sanity check**

```bash
# Find the cache file
SUBMISSION_ID=$(cat bench/.cache/fireworks-warmup/*/manifest.json | jq -sr '.[-1].submissionId')
CUSTOM_ID=$(head -1 bench/.cache/fireworks-warmup/$SUBMISSION_ID/input.jsonl | jq -r .custom_id)

# Inspect the ingested response
jq '.' bench/.cache/extractions/${CUSTOM_ID}.json

# Extract + validate the entries payload
jq -r '.response' bench/.cache/extractions/${CUSTOM_ID}.json | jq '.entries | length'
```

Expected: `.entries | length` ≥ 1 (single-session-user LongMemEval items routinely surface 3–8 durable facts). If it's 0, STOP — either the extraction prompt isn't rich enough on this single batch (possible but unlikely given the 5-turn window) or Llama 3.3 70B genuinely returned no facts on this particular transcript. Sample a different item by rerunning smoke with a different `--limit` offset — do NOT proceed to full submission until at least one sample surfaces real facts.

**Step 4: Design A regression check**

Run a `--corpus-size 1 --warmup-concurrency 1` Modal warmup over the same item with the Llama 3.3 70B model string. Expected output includes `misses=0` — every batch hits the cache we just wrote.

```bash
modal run bench/modal/sweep_app.py --mode run-longmemeval-warmup \
    --corpus-size 1 --warmup-concurrency 1 \
    --extractor-model accounts/fireworks/models/llama-v3p3-70b-instruct
```

Note: this invokes the existing Modal warmup point that was refactored in Task 1 to delegate to `enumerateWarmupBatches`. If Task 1 preserved the enumeration correctly AND Task 3 wrote the cache file correctly, the Modal dispatch will observe every hash already on-Volume and report `misses=0`. If `misses > 0`, cache drift exists — stop and diagnose.

**Step 5: Record findings**

Create a one-page note at `docs/bench/audits/2026-04-XX-fireworks-batch-smoke.md` with:
- Submission ID
- Input JSONL line count (should be 1)
- Cache file written (SHA + bytes)
- `entries | length` observed
- Modal regression-check result (hits/misses)

Commit:

```bash
git add docs/bench/audits/2026-04-XX-fireworks-batch-smoke.md
git commit -m "docs(bench): fireworks batch smoke audit (Phase 12 Task 6)"
```

**Done-when:**
- [ ] Smoke submission completes state=ingested
- [ ] Cache file at `bench/.cache/extractions/<customId>.json` has `entries | length ≥ 1`
- [ ] Modal regression check reports `misses=0`
- [ ] Audit note committed

---

## Task 6: Full submission dispatch

**Objective:** Run the full LongMemEval-S + LoCoMo submission, wait for completion, ingest results. This is mostly waiting — ~2–6h — but the controller stays aware to catch expiry or FAILED transitions early.

**Owner:** Controller + Eva (Eva holds the terminal while the poll loop runs; controller interprets results on completion).

**Preflight:**

```bash
# Clear any stale smoke-related env
unset STARMEM_FIREWORKS_SMOKE_LIMIT

# Confirm neither corpus will need re-fetch
ls bench/.cache/corpora/longmemeval-s*.json bench/.cache/corpora/locomo*.json | wc -l
# Expected: ≥ 2
```

**Step 1: Dispatch**

```bash
node bench/harness/fireworks-warmup.js submit --corpora locomo,longmemeval-s 2>&1 | tee docs/bench/runs/$(date +%Y-%m-%d)-fireworks-warmup.log
```

The tee capture gives us the full poll-loop history for the retro without requiring the terminal session to stay open. If the session gets lost, resume:

```bash
# Find submission ID from the manifests directory
ls -t bench/.cache/fireworks-warmup/ | head -1
# Resume
node bench/harness/fireworks-warmup.js resume <submission-id>
```

**Step 2: Mid-run audit (optional, if wall-clock runs long)**

At ~30 min mark, dashboard-check that the observed per-batch cost is in the $0.0004–$0.0008 range (Llama 3.3 70B's expected shape). If significantly higher, there's a cost-shape anomaly — stop the run via `modal stop` equivalent (in Fireworks: dashboard cancel) and re-diagnose. If significantly lower, the batches might be too small (cache warming too aggressive); re-verify enumerator output.

**Step 3: On COMPLETED, verify ingest**

```bash
# Cache entries in the Llama 3.3 70B partition
ls bench/.cache/extractions/ | wc -l
# Expected: ~10,800 more than before the run (+ any partial prior partitions)

# Partition-aware count: how many cache files carry our target model string?
find bench/.cache/extractions -name '*.json' -exec jq -r 'select(.model == "accounts/fireworks/models/llama-v3p3-70b-instruct") | input_filename' {} \; | wc -l
# Expected: ~10,800
```

**Step 4: Record full-submission stats**

Append to `docs/bench/audits/2026-04-XX-fireworks-batch-smoke.md` (or new note), including:
- Total batches submitted
- Wall-clock (enqueue → completed)
- Ingest: written / skipped / errors count (expect errors.length < 1% of written; escalate to Eva if higher)
- Dashboard total cost (authoritative, overrides any per-row `usage` sum)

Commit the note.

**Done-when:**
- [ ] Manifest state=ingested
- [ ] Cache partition contains ~10,800 llama-v3p3 entries
- [ ] Ingest `skipped / written` ratio < 1%
- [ ] Dashboard cost within envelope ($5–8 expected; escalate above $15)
- [ ] Audit note committed

---

## Task 7: Baselines dispatch on both corpora

**Objective:** With the warm cache in place, dispatch the 4-retriever baselines Modal job for both corpora. Write per-corpus reports + update `baseline.json`. This closes Phase 12 Task 6's original scope.

**Owner:** Controller + Eva's Modal dispatch.

**Files:**
- Create: `docs/bench/baselines/2026-04-XX-longmemeval-s-llama33-live.md`
- Create: `docs/bench/baselines/2026-04-XX-locomo-llama33-live.md`
- Modify: `docs/bench/baseline.json` (add per-extractor nesting under `perCorpus.{locomo,longmemevalS}`)

**Step 1: Dispatch**

```bash
# Both dispatches use the Llama 3.3 70B cache we just warmed
export STARMEM_BENCH_LIVE_EXTRACTOR=1
export STARMEM_BENCH_LLM_MODEL='accounts/fireworks/models/llama-v3p3-70b-instruct'
export STARMEM_BENCH_LLM_URL='https://api.fireworks.ai/inference/v1'
# STARMEM_BENCH_LLM_API_KEY inherits from .env.bench

modal run bench/modal/sweep_app.py --mode run-baselines --corpus locomo \
    --local-out docs/bench/baselines

modal run bench/modal/sweep_app.py --mode run-baselines --corpus longmemeval-s \
    --local-out docs/bench/baselines
```

Because cache is warm, each dispatch should complete within ~15–30 min (dominated by graph/ladder retrieval compute, not LLM calls).

**Step 2: Synthesize reports**

For each corpus, produce a markdown report following the `2026-04-23-locomo-live.md` template:

- Headline metrics table (recallAt1/5/10, mrr, coverage, p50/p95Latency, n_scored, n_skipped)
- Per-task-type breakdown (LongMemEval only, via `byTaskType` from `computeMetrics`)
- Prose pointing at the ST-mismatch hypothesis for LongMemEval: "multi-session task types expected to underperform single-session-user"

**Step 3: Update `baseline.json`**

Extend the per-corpus schema:

```json
{
  "perCorpus": {
    "locomo": {
      "byExtractor": {
        "gemma-2-9b-it": { "retrievers": { ... }, "asOf": "2026-04-23T..." },
        "llama-v3p3-70b-instruct": { "retrievers": { ... }, "asOf": "2026-04-XX" }
      }
    },
    "longmemevalS": {
      "byExtractor": {
        "llama-v3p3-70b-instruct": { "retrievers": { ... }, "byTaskType": { ... } }
      }
    }
  }
}
```

Keep root-level LoCoMo retrievers for validator compat (unchanged). If the Phase 9 schema validator (`tests/integration/bench/baseline-json.test.js`) doesn't tolerate the `byExtractor` nesting, extend the validator's `REQUIRED_TOP_KEYS` to treat the new path as optional.

**Step 4: Commit**

```bash
git add docs/bench/baselines/2026-04-XX-*.md docs/bench/baseline.json tests/integration/bench/baseline-json.test.js
git commit -m "feat(bench): llama-v3p3-70b baselines on locomo + longmemeval-s (Phase 12 Task 6)"
```

**Done-when:**
- [ ] Both baselines reports landed
- [ ] `baseline.json` carries the new extractor partition
- [ ] Validator test green
- [ ] Phase 12 `phase-12-multi-corpus.md` Task 6 Done-when checklist checked off

---

## Task 8: Retro + skill patch

**Objective:** Write the retro for this sub-plan, including the reasoning-model trap empirical confirmation (Llama 3.3 70B clean vs gpt-oss-20b poisoned earlier). Patch `plan-preflight-audit` skill with a new section on Fireworks Batch as an established warmup substrate.

**Owner:** Controller.

**Files:**
- Create: `docs/plans/phase-12-task-6-fireworks-retro.md`
- Modify: `~/.hermes/profiles/hanami/skills/software-development/plan-preflight-audit/SKILL.md`
- Modify: `docs/plans/ROADMAP.md` (Phase 12 §6 retro log)

**Retro contents:**

- What shipped (8 commits across Tasks 1–7)
- Cost actual vs forecast (from Task 6 audit note)
- Wall-clock actual vs forecast
- Reasoning-model trap status: Llama 3.3 70B "no empty responses observed" confirmed
- Design A's continued role as regression check
- Handoff to Phase 12 Task 7 (λ₁ tripwire — now unblocked with warm cache for both corpora)

**Skill patch: add a section**

In `plan-preflight-audit/SKILL.md`, add a new subsection (suggested placement: after "Reasoning-model cost-shape trap") titled "Batch-API substrates as warmup backends":

- When to use batch mode vs interactive: >100 items × >10 calls/item, wall-clock budget ≥2h, deterministic cache keys
- Cache-key compat invariant: `custom_id` MUST equal `_cacheKey(...)` byte-for-byte
- Job-expiry planning: 24h ceiling on Fireworks; `--continue-from` path documented
- Reasoning-model smoke spot-check: verify one result's `entries: [...]` populated before scaling

**Commit:**

```bash
git add docs/plans/phase-12-task-6-fireworks-retro.md docs/plans/ROADMAP.md
git commit -m "docs(plans): phase 12 task 6 fireworks batch retro"

# Skill patch lands separately (different repo)
# See ~/.hermes/profiles/hanami/skills/software-development/plan-preflight-audit/
```

**Done-when:**
- [ ] Retro written with cost + wall-clock actuals
- [ ] Skill patched with Batch-API substrate subsection
- [ ] ROADMAP Phase 12 retro log entry appended
- [ ] Phase 12 Task 6 (in `phase-12-multi-corpus.md`) marked complete

---

## Error playbook (reference)

**Smoke or full-dispatch fails with 401 on dataset create:**
- Auth key wrong / expired. Re-check `.env.bench`.
- `FIREWORKS_ACCOUNT_ID` is a different value from `FIREWORKS_API_KEY`; the Fireworks dashboard surfaces the account id under Account → Settings.

**Smoke returns empty `entries: []` on a known-rich item:**
- Check `response.finish_reason` in the raw JSONL row for that customId. If "length", EXTRACT_MAX_TOKENS is too low for 70B's token density on this prompt. Escalate to Eva.
- If "stop" with empty entries: the model decided no facts were durable. Pick a different smoke item before concluding.

**Job COMPLETED but ingest skipped > 5% of rows:**
- Common cause: a subset of rows had finish_reason="length" (budget exhaustion on long transcripts).
- Remediation: raise EXTRACT_MAX_TOKENS, rerun the failed rows only via `--continue-from`.

**Job state stuck in PENDING > 1h:**
- Fireworks is under load. No action; poll continues. Manifest is durable across terminal loss.

**Job FAILED:**
- Read `getJob` response for `error` / `statusMessage`. Common classes:
  - Dataset validation errors (malformed JSONL). Check manifest.state — if "uploaded" but dataset rejected, our enumerator or JSONL writer emitted bad rows.
  - Upstream capacity issues. Retry after 15 min.
- FAILED transitions manifest.state=failed; resume is blocked. Full rerun with a new submission id.

**Job EXPIRED (24h):**
- Partial rows are saved. Use the `continue` subcommand to process only the unfinished/failed rows:
  ```bash
  node bench/harness/fireworks-warmup.js continue <submission-id>
  ```
  This creates a new job referencing the expired one via `inferenceParameters.continueFrom`, appends it to `jobChain[]` in the manifest, and re-enters the polling loop. The final ingest walks every `jobChain[].outputDatasetId` so both the expired-partial rows and the continuation rows land in cache.
- Watch for repeat expiry — if jobChain.length ≥ 3, the underlying issue is throughput-limit friction rather than one-shot bad luck. Escalate to Eva; may need to narrow the corpus scope or sit on it during off-peak.

**Modal regression check (Task 5 Step 4) reports misses > 0:**
- Cache drift exists. Likely suspect: enumerator's `renderExtractionPrompt` output or `_cacheKey` input ordering differs between submission-time and Modal-warmup-time.
- Diagnostic: `jq '.messages' on one input.jsonl row, hash it with `_cacheKey`, compare to filename. If hashes differ, the enumerator bug is in the messages render. If hashes match, the ingest writer's filename derivation is wrong.
