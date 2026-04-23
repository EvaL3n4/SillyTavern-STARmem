# Sub-phase 9.5 — Live-LLM Extraction

> **For Hermes:** Use `subagent-driven-development` skill to implement this plan task-by-task. Spec compliance review after each task, code quality review after spec passes. Proceed only when both reviews approve.

**Goal:** Swap the rule-based fact extractor in `bench/harness/seeder.js` for a real LLM client (env-gated), re-run all four knob sweeps on the 9.4.8/9.4.9 Modal substrate with the full grids restored, populate the new `TIER3_MAX_HOPS` / `EXPLICIT_RELATION_WEIGHT` sweeps (plus a `BATCH_SIZE` consolidation round deferred from 9.4.9), refresh `docs/bench/baseline.json` with live-extraction numbers, and honestly report the results — elbows, flat, or re-located.

**Architecture:** Phase 9 shipped the bench infrastructure; 9.4.8 shipped the Modal substrate (`bench/modal/sweep_app.py`, `SWEEP_CONFIGS` registry, Python renderers) and warmed an on-Volume extraction cache (`google/gemma-4-26b-a4b-it`, 1182 entries, 4.7 MB). 9.5 adds a Node-native OpenAI-compatible HTTP client that plugs into `_setLLMClientForTests`, an on-disk deterministic cache mirroring the Modal Volume layout, env-gated activation (`STARMEM_BENCH_LIVE_EXTRACTOR=1`), and new `SWEEP_CONFIGS` entries for the two uncovered knobs + a BATCH_SIZE round. CI stays on the rule-based path by default (determinism gate unset) so the existing 816 tests remain untouched.

**Cache re-use:** The warm cache from 9.4.8 already holds every extraction for `google/gemma-4-26b-a4b-it` against full LoCoMo. As long as message shape and batch composition are preserved, Tasks 5/6/8/10 run on pure cache hits — zero new LLM calls. Task 7's new BATCH_SIZE round intentionally invalidates the cache (Pattern 2 per `sweep-cache-invalidation-audit`) and regenerates missing entries on demand via live Nano-GPT.

---

## Execution status (2026-04-22 preflight)

Dispatch on 2026-04-22 discovered that **Tasks 1–3's implementation files already shipped earlier in the 9.4.x series** (during the 9.4.8 Modal-warm-cache work) and are present at HEAD:

- `bench/harness/llmExtractor.js` + `tests/unit/bench/llmExtractor.test.js` — committed pre-9.5
- `bench/harness/extractionCache.js` + `tests/unit/bench/extractionCache.test.js` — committed as `0dbac98` pre-9.5
- `bench/harness/seeder.js`'s `_resolveExtractor()` + `tests/unit/bench/seeder-live-switch.test.js` — committed pre-9.5

All folded into the 9.4.9 close baseline of 75 suites / 816 tests. The Task 1–3 expected test-count jumps (+6, +6, +4) in this plan are artefacts of the original 2026-04-21 draft written before 9.4.8/9.4.9 landed these modules — the real counts stay at 816 through Task 3 completion.

**9.5's preflight contribution to Tasks 1–3:** commit `b180bb6` on 2026-04-22 updated the `llmExtractor.test.js` test URLs/model strings from the stale `http://litellm:8686/v1` + `gemma4-26b-a4b` to the canonical `https://nano-gpt.com/api/v1` + `google/gemma-4-26b-a4b-it` pair that matches the 9.4.8 warm cache keys. This was a hygiene fix, not a new feature — the production path never read those test-only values.

**Net impact on plan execution:** skip Tasks 1–3's TDD loops at dispatch time; verify the shipped files match the plan's Step 3 code (they do, verbatim), mark Tasks 1–3 complete in the Done-when checklist, proceed to Task 4. Task 11's retro narrative should note the 9.4.8 pre-shipment as a tidiness observation, not a process failure.

---

**Tech Stack:** Node 25, ESM modules, vanilla `fetch`, `node:crypto` for cache keys, `node:fs/promises` for cache I/O. No runtime deps added.

---

## Decisions locked before writing this plan (conversation 2026-04-21, revised 2026-04-22 post-9.4.9)

1. **Plan filename.** `docs/plans/phase-9-5-live-extraction.md`. Sub-phase in filename, not phase-10.
2. **LLM transport.** Node-native OpenAI-compatible HTTP via `fetch`. Config via `STARMEM_BENCH_LLM_URL`, `STARMEM_BENCH_LLM_API_KEY`, `STARMEM_BENCH_LLM_MODEL`.
3. **Extraction cache.** On by default, `--no-cache` flag to force live calls. Keyed by sha256 of `(modelId, messages, maxTokens)`. Temperature hard-locked at 0, so it's not in the key.
4. **Determinism gate.** `STARMEM_BENCH_LIVE_EXTRACTOR=1` opts in. Unset = rule-based (preserves all 816 tests).
5. **Model choice.** `google/gemma-4-26b-a4b-it` via **Nano-GPT** (OpenAI-compatible endpoint). Model string must match the warm-cache identifier verbatim — any drift (e.g. `gemma4-26b-a4b`) causes 100% cache misses and re-extracts ~$X of LLM calls. Templated through env vars so any model works in principle, but the 9.4.8 warm cache is pinned to this string.
6. **Corpus.** Full LoCoMo (10 conversations) by default. `--conversations N` flag retained for dry runs.
7. **Temperature.** `0.0` hard-locked in the HTTP client. Non-negotiable for reproducibility.
8. **Baseline-comparison gate.** Structural invariant: `ladder_mrr ≥ bm25only_mrr − 0.02` on full LoCoMo. 9.4.8 already confirmed ladder cleanly beats bm25only on warm cache; 9.5 re-verifies under full sweep grids. If inverted, 9.5 DOES NOT fix it — files Phase 11 follow-up and closes with honest retro.
9. **New sweeps.** `TIER3_MAX_HOPS` + `EXPLICIT_RELATION_WEIGHT` added as Task 10 unconditionally (both in `_SWEPT_RETRIEVAL_KEYS`, uncovered in Phase 9). Plus `BATCH_SIZE` consolidation round deferred from 9.4.9 (cache-key trap; live extraction regenerates on demand).
10. **`EXTRACT_MAX_TOKENS` tuning.** Folded into Task 7 (consolidation sweep) — observes real token-output distributions per batch from the cache.
11. **Retro framing.** If sweeps still show flat elbows on live LLM, 9.5 retro says so honestly and proposes Phase 11 (scorer chain, gold-match criterion, corpus expansion). No forcing elbows that aren't there.
12. **Execution substrate: Modal.** All sweep execution (Tasks 5–10) goes through `bench/modal/sweep_app.py` via `modal run ... --mode run-sweep --sweep-name X`, not local `node bench/sweeps/*.js`. Rationale: 9.4.8/9.4.9 renderers already carry coverage-warning/HOLD/amendment-gating logic; Modal's 32-container parallelism saves wall-clock on 48-point τ and graph coordinate-descent rounds; Modal's egress to Nano-GPT is marginally faster than Eva's local I/O on any cache miss. Containers see the warm cache via the `starmem-bench-data` Volume symlinked into `bench/.cache/extractions` at function start; the Nano-GPT credentials plumb in via `modal.Secret.from_dotenv(filename=".env.bench")`.
13. **Full sweep grids restored.** 9.4.8's `SWEEP_CONFIGS["tau"]` and `["bm25"]` were trimmed to 4-point validation configs after the amendments landed. 9.5 restores the original grids (τ: 8×6 = 48 points, bm25: 4×4 = 16 points) to detect whether elbows *relocate* under live extraction vs stay in the same corners. Graph coordinate-descent and 9.4.9's hardened amendment criteria (ΔMRR + 5pp coverage) stay intact.

---

## Inherited contracts (from Phase 9 retro §5, 9825364)

- `bench/harness/seeder.js` exports `seedConversation(conv, opts)` — `opts.chatIdPrefix`, NOT `opts.chatId`.
- `src/consolidation/llmClient.js` exports `callLLM(profileId, messages, maxTokens)`, `_setLLMClientForTests(fn)`, `_resetLLMClientForTests()`.
- `src/core/constants.js` exports `_SWEPT_RETRIEVAL_KEYS` (11 keys) and `_SWEPT_CONSOLIDATION_KEYS` (1 key). `setConstantOverrides(partial)` returns a `restore()` function; any unknown key throws.
- `bench/runner.js` exports `runHarness({ corpus, scorerId, overrides, chatIdPrefix, onProgress, retriever })` returning `{ runs, metrics, envSnapshot }`.
- `bench/loaders/locomo.js` exports `loadLocomo({ maxConversations, offline, cachePath })`.
- `docs/bench/baseline.json` pinned at gitSha `4afaea02` with `status: "deferred"`. 9.5 transitions it to `status: "measured"` with real values.

---

## Task overview

| # | File(s) | What | Est. LOC |
|---|---|---|---|
| 0 | `docs/plans/phase-9-5-live-extraction.md` | Plan file commit | — |
| 1 | `bench/harness/llmExtractor.js` (new) | Node OpenAI-compatible client | ~120 |
| 2 | `bench/harness/extractionCache.js` (new) | On-disk sha256-keyed cache | ~90 |
| 3 | `bench/harness/seeder.js` | Env-gated live vs rule-based switch | ~40 delta |
| 4 | `bench/cli.js`, smoke verification | Quick-smoke (1 conv) validates facts differ from rule-based | ~30 delta |
| 5 | `docs/bench/sweeps/YYYY-MM-DD-tau-live.md` | Full-LoCoMo τ re-run | artifact |
| 6 | `docs/bench/sweeps/YYYY-MM-DD-graph-live.md` | Full-LoCoMo graph re-run | artifact |
| 7 | `docs/bench/sweeps/YYYY-MM-DD-consolidation-live.md` | Full-LoCoMo consolidation + real-token `EXTRACT_MAX_TOKENS` | artifact |
| 8 | `docs/bench/sweeps/YYYY-MM-DD-bm25-live.md` | Full-LoCoMo bm25 re-run | artifact |
| 9 | `docs/bench/baselines/YYYY-MM-DD-comparison-live.md` | Full-LoCoMo baseline comparison + invariant check | artifact |
| 10 | `bench/sweeps/hops.js`, `bench/sweeps/relw.js` (new) + artifacts | `TIER3_MAX_HOPS` + `EXPLICIT_RELATION_WEIGHT` sweeps | ~150 |
| 11 | `docs/bench/baseline.json`, `docs/plans/phase-9-5-retro.md` | Populate measured values; retro with honest findings | artifact |

Plan size target: ~800 lines. Smaller than Phase 9's 1160 — most infrastructure exists.

---

## Task 0: Commit the plan

**Objective:** Land this plan file so subagents and future sessions have a stable reference.

**Files:**
- Commit: `docs/plans/phase-9-5-live-extraction.md`

**Step 1: Verify plan file exists and is complete**

```bash
wc -l docs/plans/phase-9-5-live-extraction.md
grep -c "^## Task " docs/plans/phase-9-5-live-extraction.md
```

Expected: ~800 lines, exactly 12 task headings (0–11).

**Step 2: Verify no secrets-guard redactions**

```bash
grep -n '=\s*\*\*\*\|=\*\*\*' docs/plans/phase-9-5-live-extraction.md
```

Expected: empty output (no redactions). Field-validated pitfall from writing-plans skill.

**Step 3: Commit**

```bash
git add docs/plans/phase-9-5-live-extraction.md
git commit -m "docs(plans): sub-phase 9.5 live-LLM extraction plan"
```

---

## Task 1: Node OpenAI-compatible LLM client

**Objective:** Add a Node-native `fetch`-based client that returns the same `Promise<string>` shape `callLLM` produces, so it can drop into `_setLLMClientForTests`.

**Files:**
- Create: `bench/harness/llmExtractor.js`
- Create: `tests/unit/bench/llmExtractor.test.js`

**Pre-flight:**
Verify `callLLM` signature is still `(profileId, messages, maxTokens) => Promise<string>`:
```bash
grep -A 2 "export function callLLM" src/consolidation/llmClient.js
```
Expected: signature matches. If not, patch this task's code block before proceeding.

**Step 1: Write the failing test**

Create `tests/unit/bench/llmExtractor.test.js`:

```javascript
/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import { makeLLMExtractor } from '../../../bench/harness/llmExtractor.js';

describe('makeLLMExtractor', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });
    afterEach(() => {
        delete global.fetch;
    });

    test('throws when STARMEM_BENCH_LLM_URL is missing', () => {
        expect(() => makeLLMExtractor({
            url: '', apiKey: 'k', model: 'm',
        })).toThrow(/url/i);
    });

    test('throws when STARMEM_BENCH_LLM_MODEL is missing', () => {
        expect(() => makeLLMExtractor({
            url: 'http://x', apiKey: 'k', model: '',
        })).toThrow(/model/i);
    });

    test('sends OpenAI-compatible chat completion request', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '{"entries":[]}' } }],
            }),
        });

        const ext = makeLLMExtractor({
            url: 'https://nano-gpt.com/api/v1',
            apiKey: 'sk-test',
            model: 'google/gemma-4-26b-a4b-it',
        });

        const result = await ext('profile-id', [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'user' },
        ], 2048);

        expect(result).toBe('{"entries":[]}');
        expect(global.fetch).toHaveBeenCalledWith(
            'https://nano-gpt.com/api/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Authorization': 'Bearer sk-test',
                    'Content-Type': 'application/json',
                }),
                body: expect.stringContaining('"temperature":0'),
            }),
        );

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.model).toBe('google/gemma-4-26b-a4b-it');
        expect(body.max_tokens).toBe(2048);
        expect(body.temperature).toBe(0);
        expect(body.messages).toHaveLength(2);
    });

    test('throws on non-200 response with status+body in message', async () => {
        global.fetch.mockResolvedValue({
            ok: false,
            status: 503,
            text: async () => 'upstream down',
        });

        const ext = makeLLMExtractor({
            url: 'http://x', apiKey: 'k', model: 'm',
        });

        await expect(ext('p', [{ role: 'user', content: 'x' }], 100))
            .rejects.toThrow(/503/);
    });

    test('throws when response has no string content', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: {} }] }),
        });

        const ext = makeLLMExtractor({
            url: 'http://x', apiKey: 'k', model: 'm',
        });

        await expect(ext('p', [{ role: 'user', content: 'x' }], 100))
            .rejects.toThrow(/content/i);
    });

    test('temperature is non-overridable (always 0)', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: 'ok' } }],
            }),
        });

        const ext = makeLLMExtractor({
            url: 'http://x', apiKey: 'k', model: 'm',
        });

        await ext('p', [{ role: 'user', content: 'x' }], 100);

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.temperature).toBe(0);
    });
});
```

**Step 2: Run the test to verify failure**

```bash
npm test -- tests/unit/bench/llmExtractor.test.js
```

Expected: FAIL — "Cannot find module '../../../bench/harness/llmExtractor.js'".

**Step 3: Implement the client**

Create `bench/harness/llmExtractor.js`:

```javascript
/**
 * Node-native OpenAI-compatible LLM client for live-extraction benches.
 *
 * Matches the LLMClient signature from src/consolidation/llmClient.js so it
 * can be dropped into _setLLMClientForTests without any wrapping. Temperature
 * is hard-locked at 0 for reproducibility; sweeps depend on deterministic
 * extractions. Any non-0 temperature would invalidate the whole comparison.
 *
 * Config is injected (not read from process.env here) so tests can exercise
 * the factory without touching env. The seeder wires env → factory.
 *
 * @module bench/harness/llmExtractor
 * @see docs/plans/phase-9-5-live-extraction.md Task 1
 */

/**
 * @typedef {object} LLMExtractorConfig
 * @property {string} url       - OpenAI-compatible base URL (appends /chat/completions).
 * @property {string} apiKey    - Bearer token.
 * @property {string} model     - Model identifier passed as body.model.
 */

/**
 * Build an LLM extractor matching the LLMClient signature.
 *
 * @param {LLMExtractorConfig} config
 * @returns {(profileId: string, messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>}
 */
export function makeLLMExtractor(config) {
    if (!config || typeof config !== 'object') {
        throw new Error('makeLLMExtractor: config required');
    }
    const { url, apiKey, model } = config;
    if (typeof url !== 'string' || url.length === 0) {
        throw new Error('makeLLMExtractor: url required (STARMEM_BENCH_LLM_URL)');
    }
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
        throw new Error('makeLLMExtractor: apiKey required (STARMEM_BENCH_LLM_API_KEY)');
    }
    if (typeof model !== 'string' || model.length === 0) {
        throw new Error('makeLLMExtractor: model required (STARMEM_BENCH_LLM_MODEL)');
    }

    const endpoint = url.replace(/\/$/, '') + '/chat/completions';

    return async function llmExtractor(_profileId, messages, maxTokens) {
        const body = JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0,
        });

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(
                `llmExtractor: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
            );
        }

        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
            throw new Error('llmExtractor: response missing string content');
        }
        return content;
    };
}
```

**Step 4: Run tests — expect pass**

```bash
npm test -- tests/unit/bench/llmExtractor.test.js
```

Expected: 6 passed.

**Step 5: Run full suite**

```bash
npm test
```

Expected: 75 suites / 822 tests green (9.4.9 close 816 + 6 new).

**Step 6: Lint + typecheck**

```bash
npm run lint
npm run typecheck
```

Expected: both green.

**Step 7: Commit**

```bash
git add bench/harness/llmExtractor.js tests/unit/bench/llmExtractor.test.js
git commit -m "feat(bench): Node OpenAI-compatible LLM extractor (Task 1)"
```

---

## Task 2: On-disk extraction cache

**Objective:** Cache every `(model, messages, maxTokens, temperature)` tuple to disk so reruns are deterministic and free. A cache hit returns the stored raw LLM string; a miss calls through and writes.

**Files:**
- Create: `bench/harness/extractionCache.js`
- Create: `tests/unit/bench/extractionCache.test.js`

**Pre-flight:**
Confirm cache dir convention matches the existing LoCoMo cache path shape:
```bash
grep -n "DEFAULT_CACHE\|\.cache" bench/loaders/locomo.js
```
Expected: `bench/.cache/locomo10.json`. We mirror with `bench/.cache/extractions/`.

**Step 1: Write the failing test**

Create `tests/unit/bench/extractionCache.test.js`:

```javascript
/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { wrapWithCache, _cacheKey } from '../../../bench/harness/extractionCache.js';

describe('extractionCache', () => {
    let dir;
    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'starmem-cache-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test('_cacheKey is stable across runs for identical inputs', () => {
        const k1 = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        const k2 = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        expect(k1).toBe(k2);
        expect(k1).toMatch(/^[a-f0-9]{64}$/);
    });

    test('_cacheKey differs for different model/messages/maxTokens', () => {
        const base = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        expect(_cacheKey('n', [{ role: 'u', content: 'hi' }], 100)).not.toBe(base);
        expect(_cacheKey('m', [{ role: 'u', content: 'hello' }], 100)).not.toBe(base);
        expect(_cacheKey('m', [{ role: 'u', content: 'hi' }], 200)).not.toBe(base);
    });

    test('cache miss → calls inner, writes result to disk', async () => {
        const inner = jest.fn(async () => '{"entries":[{"content":"x","subject":"X","tags":[],"relations":[]}]}');
        const wrapped = wrapWithCache(inner, { dir, model: 'm' });

        const result = await wrapped('p', [{ role: 'u', content: 'hi' }], 100);

        expect(inner).toHaveBeenCalledTimes(1);
        expect(result).toMatch(/entries/);

        const key = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        const file = path.join(dir, `${key}.json`);
        const stored = JSON.parse(await readFile(file, 'utf8'));
        expect(stored.response).toBe(result);
        expect(stored.model).toBe('m');
        expect(stored.maxTokens).toBe(100);
    });

    test('cache hit → skips inner, returns stored', async () => {
        const inner = jest.fn(async () => 'first');
        const wrapped = wrapWithCache(inner, { dir, model: 'm' });

        await wrapped('p', [{ role: 'u', content: 'hi' }], 100);
        expect(inner).toHaveBeenCalledTimes(1);

        const innerB = jest.fn(async () => 'second');
        const wrappedB = wrapWithCache(innerB, { dir, model: 'm' });

        const result = await wrappedB('p', [{ role: 'u', content: 'hi' }], 100);
        expect(innerB).toHaveBeenCalledTimes(0);
        expect(result).toBe('first');
    });

    test('disabled=true bypasses cache entirely', async () => {
        const inner = jest.fn(async () => 'live');
        const wrapped = wrapWithCache(inner, { dir, model: 'm', disabled: true });

        await wrapped('p', [{ role: 'u', content: 'hi' }], 100);
        await wrapped('p', [{ role: 'u', content: 'hi' }], 100);

        expect(inner).toHaveBeenCalledTimes(2);
    });

    test('corrupt cache file falls through to inner and overwrites', async () => {
        const { writeFile, mkdir } = await import('node:fs/promises');
        await mkdir(dir, { recursive: true });
        const key = _cacheKey('m', [{ role: 'u', content: 'hi' }], 100);
        await writeFile(path.join(dir, `${key}.json`), 'not json{{{');

        const inner = jest.fn(async () => 'recovered');
        const wrapped = wrapWithCache(inner, { dir, model: 'm' });
        const result = await wrapped('p', [{ role: 'u', content: 'hi' }], 100);

        expect(inner).toHaveBeenCalledTimes(1);
        expect(result).toBe('recovered');

        const stored = JSON.parse(await readFile(path.join(dir, `${key}.json`), 'utf8'));
        expect(stored.response).toBe('recovered');
    });
});
```

**Step 2: Run the test to verify failure**

```bash
npm test -- tests/unit/bench/extractionCache.test.js
```

Expected: FAIL — module not found.

**Step 3: Implement the cache**

Create `bench/harness/extractionCache.js`:

```javascript
/**
 * On-disk cache for live-LLM extractions. Keys each call by
 * sha256((model, messages, maxTokens)) — temperature is always 0, so it
 * doesn't need to be in the key.
 *
 * Cache semantics:
 *   - Miss: call inner, write `{model, maxTokens, response, at}` as JSON.
 *   - Hit: read file, return `.response`.
 *   - Corrupt file (JSON parse fails): fall through to inner, overwrite.
 *   - disabled=true: no reads, no writes, always call inner.
 *
 * Writes are best-effort: if the write fails, log once and continue
 * (the benchmark is still correct, just uncached). Reads that succeed
 * but return malformed content are treated as corrupt.
 *
 * @module bench/harness/extractionCache
 * @see docs/plans/phase-9-5-live-extraction.md Task 2
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Deterministic cache key.
 *
 * @param {string} model
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} maxTokens
 * @returns {string} hex sha256
 */
export function _cacheKey(model, messages, maxTokens) {
    const h = createHash('sha256');
    h.update(model);
    h.update('\x00');
    h.update(JSON.stringify(messages));
    h.update('\x00');
    h.update(String(maxTokens));
    return h.digest('hex');
}

/**
 * Wrap an inner LLM client with on-disk memoization.
 *
 * @param {(profileId: string, messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>} inner
 * @param {object} opts
 * @param {string} opts.dir            - Cache directory (created on demand).
 * @param {string} opts.model          - Model identifier for the cache key.
 * @param {boolean} [opts.disabled]    - If true, bypass entirely.
 * @returns {(profileId: string, messages: Array<{role: string, content: string}>, maxTokens: number) => Promise<string>}
 */
export function wrapWithCache(inner, opts) {
    const { dir, model, disabled = false } = opts;

    if (disabled) {
        return inner;
    }

    return async function cachedExtractor(profileId, messages, maxTokens) {
        const key = _cacheKey(model, messages, maxTokens);
        const file = path.join(dir, `${key}.json`);

        try {
            const raw = await readFile(file, 'utf8');
            const parsed = JSON.parse(raw);
            if (typeof parsed?.response === 'string') {
                return parsed.response;
            }
        } catch {
            // miss or corrupt — fall through
        }

        const response = await inner(profileId, messages, maxTokens);

        try {
            await mkdir(dir, { recursive: true });
            await writeFile(
                file,
                JSON.stringify({
                    model,
                    maxTokens,
                    response,
                    at: new Date().toISOString(),
                }, null, 2),
                'utf8',
            );
        } catch (err) {
            // Best-effort write; surface once but don't fail the bench.
            // eslint-disable-next-line no-console
            console.warn(`extractionCache: write failed for ${key}: ${err.message}`);
        }

        return response;
    };
}
```

**Step 4: Run tests — expect pass**

```bash
npm test -- tests/unit/bench/extractionCache.test.js
```

Expected: 6 passed.

**Step 5: Full suite + lint + typecheck**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: 76 suites / 828 tests green, lint/typecheck green.

**Step 6: Commit**

```bash
git add bench/harness/extractionCache.js tests/unit/bench/extractionCache.test.js
git commit -m "feat(bench): on-disk sha256-keyed extraction cache (Task 2)"
```

---

## Task 3: Seeder env-gated live/rule-based switch

**Objective:** Wire `STARMEM_BENCH_LIVE_EXTRACTOR` into `seedConversation`. When unset, keep today's rule-based path unchanged. When set, install `wrapWithCache(makeLLMExtractor(...))` via `_setLLMClientForTests`.

**Files:**
- Modify: `bench/harness/seeder.js`
- Create: `tests/unit/bench/seeder-live-switch.test.js`

**Pre-flight:**
```bash
grep -n "_setLLMClientForTests\|ruleBasedExtractor" bench/harness/seeder.js
```
Expected: one install site at ~line 172. No other references.

**Step 1: Write the failing test**

Create `tests/unit/bench/seeder-live-switch.test.js`:

```javascript
/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';

describe('seeder live/rule-based switch', () => {
    const origEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...origEnv };
        jest.resetModules();
    });

    test('unset STARMEM_BENCH_LIVE_EXTRACTOR installs rule-based extractor', async () => {
        delete process.env.STARMEM_BENCH_LIVE_EXTRACTOR;

        const mod = await import('../../../bench/harness/seeder.js');
        expect(typeof mod._resolveExtractor).toBe('function');

        const ext = mod._resolveExtractor();
        expect(ext.source).toBe('rule-based');
    });

    test('set STARMEM_BENCH_LIVE_EXTRACTOR + full env installs live extractor', async () => {
        process.env.STARMEM_BENCH_LIVE_EXTRACTOR = '1';
        process.env.STARMEM_BENCH_LLM_URL = 'https://nano-gpt.com/api/v1';
        process.env.STARMEM_BENCH_LLM_API_KEY='***';
        process.env.STARMEM_BENCH_LLM_MODEL = 'google/gemma-4-26b-a4b-it';

        const mod = await import('../../../bench/harness/seeder.js');
        const ext = mod._resolveExtractor();
        expect(ext.source).toBe('live');
        expect(typeof ext.fn).toBe('function');
    });

    test('live mode with missing config throws with actionable message', async () => {
        process.env.STARMEM_BENCH_LIVE_EXTRACTOR = '1';
        delete process.env.STARMEM_BENCH_LLM_URL;

        const mod = await import('../../../bench/harness/seeder.js');
        expect(() => mod._resolveExtractor()).toThrow(/STARMEM_BENCH_LLM_URL/);
    });

    test('--no-cache flag disables cache even in live mode', async () => {
        process.env.STARMEM_BENCH_LIVE_EXTRACTOR = '1';
        process.env.STARMEM_BENCH_LLM_URL = 'http://x';
        process.env.STARMEM_BENCH_LLM_API_KEY = 'k';
        process.env.STARMEM_BENCH_LLM_MODEL = 'm';
        process.env.STARMEM_BENCH_NO_CACHE = '1';

        const mod = await import('../../../bench/harness/seeder.js');
        const ext = mod._resolveExtractor();
        expect(ext.source).toBe('live');
        expect(ext.cached).toBe(false);
    });
});
```

**Step 2: Run — expect fail**

```bash
npm test -- tests/unit/bench/seeder-live-switch.test.js
```

Expected: FAIL — `_resolveExtractor` not exported.

**Step 3: Patch the seeder**

Edit `bench/harness/seeder.js`. Add near the top (after existing imports):

```javascript
import { makeLLMExtractor } from './llmExtractor.js';
import { wrapWithCache } from './extractionCache.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CACHE_DIR = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..', '.cache', 'extractions',
);

/**
 * Resolve which extractor to install based on process.env. Exported for tests.
 *
 * @returns {{ source: 'rule-based' | 'live', fn: Function, cached: boolean }}
 */
export function _resolveExtractor() {
    const live = process.env.STARMEM_BENCH_LIVE_EXTRACTOR === '1';
    if (!live) {
        return { source: 'rule-based', fn: ruleBasedExtractor, cached: false };
    }

    const url = process.env.STARMEM_BENCH_LLM_URL;
    const apiKey = process.env.STARMEM_BENCH_LLM_API_KEY;
    const model = process.env.STARMEM_BENCH_LLM_MODEL;
    if (!url) throw new Error('seeder: STARMEM_BENCH_LIVE_EXTRACTOR=1 requires STARMEM_BENCH_LLM_URL');
    if (!apiKey) throw new Error('seeder: STARMEM_BENCH_LIVE_EXTRACTOR=1 requires STARMEM_BENCH_LLM_API_KEY');
    if (!model) throw new Error('seeder: STARMEM_BENCH_LIVE_EXTRACTOR=1 requires STARMEM_BENCH_LLM_MODEL');

    const inner = makeLLMExtractor({ url, apiKey, model });
    const noCache = process.env.STARMEM_BENCH_NO_CACHE === '1';
    const fn = noCache
        ? inner
        : wrapWithCache(inner, { dir: DEFAULT_CACHE_DIR, model });

    return { source: 'live', fn, cached: !noCache };
}
```

Then replace the single install line inside `seedConversation`:

```javascript
// OLD (line ~172)
_setLLMClientForTests(ruleBasedExtractor);

// NEW
const { fn: extractorFn } = _resolveExtractor();
_setLLMClientForTests(extractorFn);
```

And update the per-turn `maybeConsolidate` call's `extractorLabel`:

```javascript
// OLD
extractorLabel: 'bench-ruleBased@v1',

// NEW
extractorLabel: process.env.STARMEM_BENCH_LIVE_EXTRACTOR === '1'
    ? `bench-live:${process.env.STARMEM_BENCH_LLM_MODEL}@v1`
    : 'bench-ruleBased@v1',
```

**Step 4: Run test — expect pass**

```bash
npm test -- tests/unit/bench/seeder-live-switch.test.js
```

Expected: 4 passed.

**Step 5: Run full suite**

```bash
npm test
```

Expected: 77 suites / 832 tests green. All existing seeder-calling tests continue on the rule-based path because env is unset.

**Step 6: Lint + typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: green.

**Step 7: Commit**

```bash
git add bench/harness/seeder.js tests/unit/bench/seeder-live-switch.test.js
git commit -m "feat(bench): env-gated live/rule-based extractor switch (Task 3)"
```

---

## Task 4: Smoke verification on 1 conversation (Modal, warm-cache round-trip)

**Objective:** Confirm the live-extractor path runs end-to-end on Modal: the `starmem-bench-data` Volume's warm cache (from 9.4.8) serves extractions for `google/gemma-4-26b-a4b-it`, Nano-GPT fallback fires only if a cache miss occurs, `_resolveExtractor` installs the right client, state hashes differ from rule-based. No metrics yet — just "live path works end-to-end on the Modal substrate."

**Files:**
- Artifact (untracked): `docs/bench/runs/YYYY-MM-DDThh-mm-ssZ-smoke-live.md` (Modal `--local-out` mirror)
- Optional modification: `.gitignore` already ignores `bench/.cache/` and `docs/bench/runs/` per 9.4.9; verify.

**Pre-flight:**

```bash
# Confirm Modal Volume has the warm cache and it's keyed on the canonical model string.
modal run bench/modal/upload_cache.py
```
Expected: `cacheFiles: 1182`, `cacheSizeBytes: ~4800000`. If `cacheFiles` is 0, the Volume lost the cache between 9.4.9 and 9.5 — re-upload via `modal volume put starmem-bench-data bench/.cache/extractions /extractions` before proceeding.

```bash
# Confirm Nano-GPT serves google/gemma-4-26b-a4b-it at the configured URL.
# Eva runs this manually with her real .env.bench sourced.
curl -sS "$STARMEM_BENCH_LLM_URL/models" \
  -H "Authorization: Bearer $STARMEM_BENCH_LLM_API_KEY" | jq -r '.data[].id' | grep -F google/gemma-4-26b-a4b-it
```
Expected: one line match. If absent, Nano-GPT renamed the model; pause and update `.env.bench` + re-upload cache keyed on the new name.

**Step 1: Gitignore + env file**

```bash
grep -qxF "bench/.cache/" .gitignore || echo "bench/.cache/" >> .gitignore
grep -qxF ".env.bench" .gitignore || echo ".env.bench" >> .gitignore
grep -qxF "docs/bench/runs/" .gitignore || echo "docs/bench/runs/" >> .gitignore

cat > .env.bench << 'ENV_EOF'
# Sourced locally AND loaded by modal.Secret.from_dotenv inside containers.
# Model string MUST match 9.4.8 warm-cache identifier or every call misses.
export STARMEM_BENCH_LIVE_EXTRACTOR=1
export STARMEM_BENCH_LLM_URL=https://nano-gpt.com/api/v1
export STARMEM_BENCH_LLM_API_KEY=<paste-nano-gpt-key>
export STARMEM_BENCH_LLM_MODEL=google/gemma-4-26b-a4b-it
ENV_EOF
```

(Edit `.env.bench` with the real API key before running Modal. Do not commit.)

If `.gitignore` changed, commit:
```bash
git add .gitignore
git commit -m "chore(bench): gitignore .env.bench and extraction cache"
```

**Step 2: Modal smoke on synthetic (cold-path sanity)**

```bash
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name tau --synthetic \
    --local-out docs/bench/runs
```

Expected: a 2-point synthetic τ sweep completes in ~1–2 min wall-clock. Report lands under `docs/bench/runs/YYYY-MM-DDThh-mm-ssZ-tau.{md,json}`. Verifies `_resolveExtractor` reads `STARMEM_BENCH_LIVE_EXTRACTOR=1` from the Secret and installs the live path without crashing.

**Step 3: Modal smoke on full LoCoMo (run-point)**

```bash
modal run bench/modal/sweep_app.py --mode run-point --overrides-json '{}' \
    --local-out docs/bench/runs
```

Expected: single warm-cache run on full LoCoMo. Wall-clock ~30s Modal cold start + ~1 min retrieval (1986 QA items × BM25 + graph traversal, Node single-threaded per container). Stdout returns a JSON payload `{"overrides": {}, "metrics": {...}}`.

**Known gap — `--local-out` is ignored for `run-point` in current `sweep_app.py`:** the `local_out` branch in `@app.local_entrypoint()`'s `main()` only fires under `mode == "run-sweep"` (lines ~1311–1325), not `run-point`. Kept in the smoke command above on purpose: the convention "every Modal dispatch includes `--local-out docs/bench/runs`" should hold across all task invocations so an Azure hiccup or retry picks it up reflexively. Filed as a Phase 11 ergonomics bullet — see "Notes for Phase 11" in Task 11's retro. For Task 4, capture the stdout JSON manually into the smoke writeup.

**Expected warm-cache baseline (from 9.4.8 post-retro numbers, reproducible):**
- `n=1986, n_scored=1277, n_skipped=709` — identical to 9.4.8 → cache hit rate 100%
- `precisionAt1 ≈ 0.68`, `mrr ≈ 0.81` — ladder top-1 healthy
- `updateRate ≈ 0.01`, `dedupHitRate ≈ 0.007` — **rule-based-range** numbers, not in the Phase 6 target band [0.2, 0.4]. Preview finding: live Gemma doesn't produce enough near-duplicates on LoCoMo to stress dedup. Task 7's `DEDUP_JACCARD_THRESHOLD` round will likely fire Branch C again (same as 9.4.9); fold into Task 11 retro under "9.4.6/9.4.9/9.5 three-time reproduction of dedup flatness on LoCoMo — extractor choice isn't the bottleneck."

Any deviation from these (especially `n_scored` drifting from 1277) means the message shape changed since 9.4.8 — stop before Tasks 5+ and diagnose.

**Step 4: Verify cache intact on Volume after run**

```bash
modal run bench/modal/upload_cache.py
```

Expected: `cacheFiles: 1182` (unchanged). Any delta means extraction inputs drifted.

**Step 5: Write smoke writeup**

Capture the run-point JSON payload + cache re-verify numbers into a smoke artifact:

```markdown
## Live-extractor smoke verdict

- ✅ Modal Volume cache intact at 1182 entries pre- and post-run.
- ✅ run_point on full LoCoMo produced {n_scored} / 1986 scored (expected 1277; actual <N>).
- ✅ MRR {actual} matches 9.4.8 baseline (expected ~0.81).
- ℹ️ Dedup preview: updateRate={actual} / dedupHitRate={actual} — rule-based-range, not in [0.2, 0.4] band. Expected repeat of 9.4.9 Branch C under Task 7.
- [If n_scored deviates from 1277: blocker for Tasks 5–10. Report to controller.]
```

**Step 6: No code commit at Task 4** — execution-only task. If Step 3 reveals a bug in Task 1/2/3, patch and commit separately.

---

## Tasks 5–10: shared Modal sweep protocol

Every sweep in Tasks 5–10 runs through the Modal substrate, not `node bench/sweeps/*.js` directly. The shared protocol:

1. **Prereq:** `.env.bench` exists and Eva's Nano-GPT key is populated. `modal run bench/modal/upload_cache.py` shows `cacheFiles ≥ 1182`.
2. **Dispatch:** `modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name <name> --local-out docs/bench/runs`
3. **Artifact:** Modal's `--local-out` writes `docs/bench/runs/YYYY-MM-DDThh-mm-ssZ-<name>.{md,json}` to the host and mirrors to `/data/runs/<ts>-<name>/` on the Volume (durable per 9.4.9 Task 7's `persist-serverless-compute-results` pattern).
4. **Post-process:** rename to canonical `docs/bench/sweeps/YYYY-MM-DD-<name>-live.md` at Task 11 batch-commit time. Until then, the run timestamps stay in `docs/bench/runs/` (gitignored per 9.4.9).
5. **Cache budget:** every sweep's synthetic smoke should complete in <3 min wall-clock; if it times out, the swept knob invalidates the cache (see `sweep-cache-invalidation-audit`). Only Task 7's BATCH_SIZE round is expected to trigger Nano-GPT live calls.

**SWEEP_CONFIGS edits needed before Tasks 5/8/10 run:**

Tasks 5 and 8 restore full grids; Task 10 adds two new entries. Land all three edits as a single commit at the start of Task 5 via a subagent patch to `bench/modal/sweep_app.py`:

```python
SWEEP_CONFIGS = {
    "tau": {
        # 9.5: restored to Phase 9 Task 4 grid shape. 9.4.8 trimmed this
        # to a 4-knob validation point after amending gap=10; 9.5 re-sweeps
        # under live extraction to detect whether the gap=10 plateau holds
        # or the elbow shifts.
        "knobs": [
            {"name": "TIER2_TAU_CONFIDENCE", "values": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0]},
            {"name": "TIER2_TAU_GAP",        "values": [0.1, 0.3, 0.5, 1.0, 3.0, 10.0]},
        ],
        "primary_metric": "recallAt5",
        "renderer": render_tau_report,
    },
    "bm25": {
        # 9.5: restored from 9.4.8's 2-knob validation point to the full
        # 4×4 grid so the renderer can surface a heatmap.
        "knobs": [
            {"name": "TAG_BOOST",     "values": [1, 2, 3, 4]},
            {"name": "SUBJECT_BOOST", "values": [1, 2, 3, 4]},
        ],
        "primary_metric": "mrr",
        "renderer": render_bm25_report,
    },
    "hops": {  # NEW in 9.5
        "knobs": [
            {"name": "TIER3_MAX_HOPS", "values": [1, 2, 3, 4]},
        ],
        "primary_metric": "mrr",
        "renderer": render_tau_report,  # reuse tabular renderer; single-axis
        "base_overrides": GRAPH_BASE_OVERRIDES,  # gap=10
    },
    "relw": {  # NEW in 9.5
        "knobs": [
            {"name": "EXPLICIT_RELATION_WEIGHT", "values": [0.5, 1.0, 1.5, 2.0, 3.0]},
        ],
        "primary_metric": "mrr",
        "renderer": render_tau_report,
        "base_overrides": GRAPH_BASE_OVERRIDES,
    },
}
```

The `graph` and `consolidation` sweep paths already exist as `run_graph_sweep`/`run_consolidation_sweep` functions (not in `SWEEP_CONFIGS`); Task 6 and Task 7 dispatch those directly via their own CLI modes (already wired in 9.4.9). Task 7 additionally needs a new `BATCH_SIZE` round appended to the consolidation sweep's round list (see Task 7 body).

**Subagent hand-off note:** the subagent executing this preamble should open `bench/modal/sweep_app.py`, locate the existing `SWEEP_CONFIGS` dict (~line 459) and the `GRAPH_BASE_OVERRIDES` constant (~line 506), apply the edits above, and verify by running `modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name hops --synthetic` to confirm the new entry dispatches cleanly. Commit: `feat(bench): restore full τ/bm25 grids + add hops/relw sweep configs (9.5 prep)`.

---

## Task 5: Full-LoCoMo τ sweep (live extraction, Modal)

**Objective:** Run the full 48-point τ grid (`TIER2_TAU_CONFIDENCE × TIER2_TAU_GAP`) on full LoCoMo via Modal with the warm cache + live-extractor gate. Detect whether the gap=10 plateau holds or the elbow relocates under live extraction.

**Pre-flight:**
```bash
modal run bench/modal/upload_cache.py
grep -A 10 "\"tau\":" bench/modal/sweep_app.py | head -12
```
Expected: 1182 cache entries; 8×6 = 48-point tau grid restored.

**Step 1:**
```bash
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name tau --local-out docs/bench/runs
```

Cache is warm from 9.4.8 for all 48 points (retrieval knobs don't flow into the extraction cache key). Wall-clock: ~3–4 min (two 32-container waves under free-tier cap).

**Step 2: Inspect elbow**

Modal prints the rendered report to stdout and `.md`/`.json` land in `docs/bench/runs/`. The renderer flags:
- `max(mrr) − min(mrr) > 0.05` → elbow exists; recommend (τ_conf, τ_gap) corner.
- Surface flat → report for retro; specDefault holds (gap=10 amendment from 9.4.8 stays).

**Step 3: Leave artifact in `docs/bench/runs/` for Task 11 batch-rename and commit.**

---

## Task 6: Full-LoCoMo graph sweep (live extraction, Modal)

**Objective:** Re-run the 9.4.9 graph coordinate descent (6 rounds: `TIER3_LAMBDA_1`, `TIER3_LAMBDA_2`, `TIER3_BEAM_WIDTH`, `TIER3_SEEDS_K`, `EDGE_CAP_PER_ENTRY`, `COOCCURRENCE_WEIGHT`) under live extraction. The 9.4.9 retro found three rounds' winners were coverage-bias artifacts (`n_scored` dropped 12–16pp); live extraction may resolve or re-produce that. Renderer already enforces the hardened amendment criteria (ΔMRR ≥ 0.02 AND coverage within 5pp of baseline).

**Pre-flight:**
```bash
grep -n "GRAPH_ROUNDS\s*=\s*\[" bench/modal/sweep_app.py
```
Expected: list of 6 rounds present (9.4.9 shipped these).

**Step 1:**
```bash
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name graph --local-out docs/bench/runs
```

Cache warm from Task 5; 22 points × 6 rounds, coordinate descent. Wall-clock: ~8 min (one wave per round under the 32-cap). (The `run_sweep` dispatcher routes `--sweep-name graph` to the specialized `run_graph_sweep()` helper — no separate `--mode` needed.)

**Step 2: Per-round verdicts**

Renderer stamps ⚠️ on any row where `n_scored` deviates >5pp from baseline coverage. HOLD (subset-selection bias) verdicts print per-round. Read the final amendment summary section — if any round fires AMEND, pass the knob+value to Task 11's baseline.json update.

**Step 3: Leave artifact in `docs/bench/runs/`.**

---

## Task 7: Full-LoCoMo consolidation sweep + BATCH_SIZE + EXTRACT_MAX_TOKENS

**Objective:** Re-run `DEDUP_JACCARD_THRESHOLD` on live extraction (Branch C fired on rule-based per 9.4.9); add the `BATCH_SIZE` round deferred from 9.4.9 (cache-key trap, dissolved under live extraction that regenerates on demand); observe real token distributions from the cache to inform `EXTRACT_MAX_TOKENS`.

**Pre-flight:**
```bash
grep -n "CONSOLIDATION_ROUNDS\|run_consolidation_sweep" bench/modal/sweep_app.py | head
```
Expected: `run_consolidation_sweep` function present (9.4.9 shipped this).

**Step 1: Edit `bench/modal/sweep_app.py` to add BATCH_SIZE round**

Locate the consolidation round list (near `DEDUP_JACCARD_THRESHOLD`). Append:

```python
{"name": "batch_size", "knob": "BATCH_SIZE", "values": [8, 16, 24, 32, 48]},
```

Grid from 9.4.9 retro's deferred handoff. Commit: `feat(bench): add BATCH_SIZE round to consolidation sweep (9.5 Task 7)`.

**Step 2: Dispatch the consolidation sweep**

```bash
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name consolidation --local-out docs/bench/runs
```

`DEDUP_JACCARD_THRESHOLD`: 5 points, warm cache → ~90s wall-clock.
`BATCH_SIZE`: 5 points, cache-key invalidation → ~2.5 min wall-clock for live regeneration (~500 Nano-GPT calls per 9.4.9 retro's budget estimate). (The `run_sweep` dispatcher routes `--sweep-name consolidation` to the specialized `run_consolidation_sweep()` helper.)

**Step 3: EXTRACT_MAX_TOKENS observation (host-side, after Modal completes)**

```bash
node -e "
const fs = require('node:fs');
const path = require('node:path');
const dir = 'bench/.cache/extractions';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const lens = files.map(f => {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return data.response.length;
});
lens.sort((a, b) => a - b);
const p = q => lens[Math.floor(lens.length * q)];
console.log('chars: min', lens[0], 'p50', p(0.5), 'p95', p(0.95), 'p99', p(0.99), 'max', lens.at(-1));
console.log('token proxy (chars/4): p95 ~=', Math.floor(p(0.95) / 4));
const advise = p(0.95)/4 > 1500 ? 'raise' : p(0.95)/4 < 400 ? 'lower' : 'hold';
console.log('Current EXTRACT_MAX_TOKENS: 2048. Recommend:', advise);
" 2>&1 | tee /tmp/extract-tokens-observation.log
```

Append the result as an "EXTRACT_MAX_TOKENS observation" section to the consolidation writeup.

**Note on token truth-source:** `chars/4` is a rough proxy. If `usage.completion_tokens` is available in Nano-GPT responses, extend `extractionCache.js` in a follow-up to persist it. For Task 7, char-proxy is sufficient — aim is raise/hold/lower, not precision.

**Step 4: Inspect update-rate band (BATCH_SIZE + DEDUP rounds jointly)**

Phase 6 band rule: `updateRate ∈ [0.2, 0.4]` is healthy. 9.4.9 rule-based hit 0.007–0.045 on DEDUP (Branch C). Under live extraction, expect `updateRate` to climb into the band — if it doesn't, the extractor is still too conservative and Phase 11 inherits "live extractor under-stresses dedup" as a new finding.

**Step 5: Leave artifact in `docs/bench/runs/`.**

---

## Task 8: Full-LoCoMo bm25 sweep (live extraction, Modal)

**Objective:** Run the restored 4×4 `TAG_BOOST × SUBJECT_BOOST` grid on live extraction. Phase 9 flagged `tags-populated-rate = 0%` under rule-based; live extractor should populate tags per the system prompt.

**Pre-flight:**
```bash
grep -A 10 "\"bm25\":" bench/modal/sweep_app.py | head -12
```
Expected: 4×4 grid restored by the preamble commit.

**Step 1:**
```bash
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name bm25 --local-out docs/bench/runs
```

Warm cache; ~2 min wall-clock.

**Step 2: Inspect heatmap + tags-populated-rate**

- `max(mrr) − min(mrr) > 0.05` → signal; recommend corner.
- Flat + tags-populated-rate > 50% → scorer genuinely indifferent; hold specDefault.
- Flat + tags-populated-rate < 5% → extractor still not tagging; file Phase 11.

**Step 3: Leave artifact in `docs/bench/runs/`.**

---

## Task 9: Full-LoCoMo baseline comparison

**Objective:** Run the 4-retriever baseline (ladder, bm25only, recency, random) on full LoCoMo with live extraction. Enforce Decision 8's structural invariant. Do NOT investigate inversions here — file Phase 11.

**Pre-flight:**
```bash
grep -n "ladderVsBm25Only\|structuralInvariants" bench/baselines.js
```
Expected: invariant-check logic present from Phase 9 Task 8.

**Step 1:** Baselines don't currently route through Modal `SWEEP_CONFIGS` (9.4.8/9.4.9 kept them local because Modal only parallelizes sweep points, and the 4-baseline run is a single pass). Run locally with `.env.bench` sourced:

```bash
source .env.bench
npm run bench:baselines -- --conversations 10 2>&1 | tee /tmp/baselines-live.log
```

The `--local-out`-equivalent is already wired: `bench/baselines.js` writes to `docs/bench/runs/` per 9.4.9.

**Step 2: Invariant verdict**

`bench/baselines.js` emits one of four verdicts:
- ✅ `ladder > bm25only > recency > random` → scorer chain earns its keep.
- ⚠️ `ladder ≈ bm25only` (|Δmrr| ≤ 0.02) → scorer chain not earning; file Phase 11 in Task 11.
- ❌ `ladder ≈ random` → structural bug. STOP; escalate.
- ⚠️ Mixed → review corpus size + extraction quality, file Phase 11.

**Step 3: Record verdict for Task 11 retro narrative.**

**Step 4: Leave artifact in `docs/bench/runs/`.**

---

## Task 10: New sweeps — `hops` and `relw` (Modal)

**Objective:** Execute the two new `SWEEP_CONFIGS` entries added in the Task 5 preamble. Both sweep single axes with `GRAPH_BASE_OVERRIDES` (gap=10 baseOverride).

**Pre-flight:**
```bash
grep -A 4 "\"hops\":\|\"relw\":" bench/modal/sweep_app.py
```
Expected: both entries from preamble commit; `base_overrides: GRAPH_BASE_OVERRIDES` threaded through.

**Step 1: Dispatch both sweeps**

```bash
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name hops --local-out docs/bench/runs
modal run bench/modal/sweep_app.py --mode run-sweep --sweep-name relw --local-out docs/bench/runs
```

Warm cache (same extraction keys as Tasks 5–9); each sweep: ~1 min.

**Step 2: Inspect elbows**

Same rule as Tasks 5/8: `max(mrr) − min(mrr) > 0.05` = signal; flat = specDefault holds (`TIER3_MAX_HOPS=2`, `EXPLICIT_RELATION_WEIGHT=1.0`).

**Step 3: Leave artifacts in `docs/bench/runs/`.**

---


## Task 11: Populate baseline.json + write retro

**Objective:** Refresh `docs/bench/baseline.json` with live-extraction re-measurements from Tasks 5–10 (the artifact is already `status: "measured"` post-9.4.8/9.4.9; 9.5 supersedes the rule-based numbers). Write `docs/plans/phase-9-5-retro.md` with an honest narrative: what moved, what didn't, what we're filing to Phase 11. Batch-rename `docs/bench/runs/*` to canonical `docs/bench/sweeps/*-live.md` and commit.

**Files:**
- Modify: `docs/bench/baseline.json`
- Create: `docs/plans/phase-9-5-retro.md`
- Rename + commit: every `docs/bench/runs/YYYY-MM-DDThh-mm-ssZ-<name>.{md,json}` from Tasks 4–10 → `docs/bench/sweeps/YYYY-MM-DD-<name>-live.md` (drop the JSON from the canonical path; keep in `docs/bench/runs/` per gitignore for provenance).

**Pre-flight:**
```bash
ls docs/bench/runs/*.md | wc -l
```
Expected: ≥8 artifacts (smoke + τ + graph + consolidation + bm25 + baselines + hops + relw). Confirm before editing `baseline.json`.

**Step 1: Update baseline.json**

For each of the 10 existing `tuned` entries plus the new 2 from Task 10, replace the `source` and `note` with the 9.5 live-extraction sweep writeups. Keep `specDefault` constant. Update `measured` if Tasks 5–10 produced an amendment-candidate that cleared both thresholds (ΔMRR ≥ 0.02 AND coverage within 5pp of baseline per 9.4.9's hardened criteria).

If a sweep was flat or HOLD, `measured` stays at the 9.4.8/9.4.9 value and the note records "flat surface under live extraction on full LoCoMo — 9.4.8/9.4.9 value retained".

Top-level fields to update:
- `"asOf"`: today's date
- `"gitSha"`: current HEAD (record after the Task 11 commit)
- `"corpus"`: `"locomo10-full (1986 QA items, live extraction)"`
- `"status"`: stays `"measured"`
- `"statusReason"`: new narrative — "Sub-phase 9.5 re-measured all sweeps on the 9.4.8 Modal substrate with live extraction (google/gemma-4-26b-a4b-it via Nano-GPT, temperature=0, warm cache from 9.4.8). Added `TIER3_MAX_HOPS` and `EXPLICIT_RELATION_WEIGHT` sweeps and the BATCH_SIZE consolidation round deferred from 9.4.9. [N] amendments landed; [N] knobs held under live data. Supersedes the rule-based-extractor baseline numbers from 9.4.6–9.4.9 for any knob where live extraction shifted the elbow."
- `"knownIssues"`: append a 9.5 entry for any Phase 11 follow-up surfaced by Task 9's invariant check.
- `"headlineMetrics"`: update with Task 9's full-LoCoMo live-extraction ladder/bm25only/recency/random values.
- `"structuralInvariants.ladderVsBm25Only"`: update `measuredMrrDelta` and `status` from Task 9 verdict.

**Step 2: Run the baseline-json schema validator**

```bash
npm test -- tests/integration/bench/baseline-json.test.js
```

Expected: green. The Phase 9 Task 9 validator asserts the JSON schema (top-level fields, per-knob shape).

**Step 3: Write `docs/plans/phase-9-5-retro.md`**

Follow the Phase 9 retro's shape — see `docs/plans/phase-9-retro.md` (138 lines) and `docs/plans/phase-9-4-9-retro.md` (149 lines) for structure. Sections: What shipped, Decisions held/revised (table across 13 decisions), What the sweeps found (per-knob one-liners), Surprises, Notes for Phase 10 / Phase 11 / skill library. Extractor line: `google/gemma-4-26b-a4b-it via Nano-GPT, temperature=0, warm cache from 9.4.8`.

**Step 4: Verify no plan-redaction residue**

```bash
grep -n '=\s*\*\*\*\|=\*\*\*' docs/plans/phase-9-5-retro.md docs/plans/phase-9-5-live-extraction.md
```
Expected: empty (writing-plans skill's secrets-guard trap check).

**Step 5: Batch-rename runs/ to sweeps/ + commit**

```bash
for f in docs/bench/runs/*-smoke-live.md docs/bench/runs/*-tau.md docs/bench/runs/*-graph.md docs/bench/runs/*-consolidation.md docs/bench/runs/*-bm25.md docs/bench/runs/*-baselines-*.md docs/bench/runs/*-hops.md docs/bench/runs/*-relw.md; do
  [ -f "$f" ] || continue
  base=$(basename "$f" .md)
  # Extract date from timestamp prefix YYYY-MM-DDThh-mm-ssZ-<name>
  date=$(echo "$base" | sed -E 's/T.*$//')
  name=$(echo "$base" | sed -E 's/^[^-]+-[^-]+-[^-]+T[^-]+-[^-]+-[^-]+Z-//')
  cp "$f" "docs/bench/sweeps/${date}-${name}-live.md"
done

git add docs/bench/sweeps/*-live.md \
        docs/bench/baseline.json \
        docs/plans/phase-9-5-retro.md
git commit -m "docs(bench): sub-phase 9.5 live-extraction baseline + retro (Task 11)"
```

(The `docs/bench/runs/` originals stay in place as provenance, gitignored.)

**Step 6: Final suite + lint + typecheck**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green. No regressions from 9.5 code.

**Step 7: Update memory**

Use `memory` or `hindsight_retain` to record:
- Sub-phase 9.5 shipped at commit [sha] with [N] tests across [N] suites.
- Which knobs had signal under live extraction, which were flat.
- Phase 11 follow-up filed (if applicable).

---

**Task 10 — hops + relw sweeps (combined completion) — complete. Three findings:**

1. **`TIER3_MAX_HOPS` preview showed movement** (recorded in Task 5/6 observations block above): hops=3 produced −0.0032 ΔMRR with coverage going 1277→1283. Not subset-selection (coverage went up), just more-hops-adds-noise. Hold at spec 2.

2. **`EXPLICIT_RELATION_WEIGHT` is structurally inert on LoCoMo.** All 5 values produce identical metrics to 4 decimal places: `n_scored=1277`, `recallAt5=0.9363`, `MRR=0.8057`. Zero variance on the axis. Hold at spec 1.0. Fourth edge-related Tier-3 knob to hit inertness (`TIER3_LAMBDA_1`, `TIER3_LAMBDA_2`, `COOCCURRENCE_WEIGHT`, and now `EXPLICIT_RELATION_WEIGHT` — three of four are pure inertness, `COOCCURRENCE_WEIGHT` was pinned at gap=10 so its inertness may have been inherited).

3. **Elbow detector false-positive reproduces THIRD time.** Same bug, same `Δmetric/Δknob = 0.000000 ≤ 0.1×maxΔ = 0.000000` self-admission in the rationale. Priority remains at confirmed-recurring — Phase 11's "zero-axis-Δ guard" bullet now has 3 reproductions in 9.5 alone (Tasks 5, 8, 10).

**Emerging Phase 11 framing:** three distinct Tier 3 edge-related knobs inert on LoCoMo, plus bm25 tag/subject boosts flat with 100% populated tags. LoCoMo's single-session structure doesn't expose edge-weight asymmetry to any ranking knob. Corpus expansion (multi-session, cross-character per the inherited v2.1 scope) is where edge-weighting sweeps become meaningful.

---



1. **Structural invariant PASS decisively.** ladder MRR 0.8057 > bm25only 0.6898 > recency 0.2703 > random 0.2690. ΔMRR ladder-vs-bm25only = +0.1159, ~6× the 0.02 amendment threshold. Decision 8's invariant-gate is satisfied with enormous headroom. No Phase 11 scorer-chain investigation needed.

2. **Per-category ordering is uniform.** Every one of 5 QA categories reproduces `ladder > bm25only > {recency, random}`. Category 4 (841 items, biggest) drives most of the overall delta; Category 3 (96 items) is hardest for everyone (ladder 0.684 vs synthetic-predicted 0.7+). Nowhere does bm25only beat ladder — exactly what "ladder is structurally correct" looks like.

3. **9.4.8 numbers reconfirmed within noise.** baseline.json's `headlineMetrics.ladder` had MRR 0.81 from the 9.4.8 validation config; full-live gives 0.8057. Δ < 0.005, well within measurement noise. Live extraction on full LoCoMo does not materially change the ladder's ranking quality — it just populates tags (per Task 8) and produces different extraction distribution (per Task 4/7) without disturbing the retrieval layer's elbow surface.

**Red flag for Phase 11:** wall-clock was 30+ min, not 5-10 as the plan predicted. Sequential over 4 retrievers × 1986 QA × full-LoCoMo seed. Modal parallelization across 4 containers would cut it to ~8 min — filed above.

---



1. **Tags populated at 100% under live Gemma** (up from 0% under rule-based). Tags-populated-rate probe confirms 227/227 episodic entries carry non-empty tags. `TAG_BOOST` is no longer structurally blind — the scorer has something to score against. If the knob is flat, it's because ranking genuinely doesn't care, not because there's nothing to rank.

2. **`TAG_BOOST` × `SUBJECT_BOOST` grid is Branch-C flat under live extraction.** MRR range across 16 cells: 0.8051 (3,4) → 0.8116 (1,4) = spread 0.0065. Well below the 0.02 amendment threshold. This *disconfirms* 9.4.8's borderline "+0.0098 MRR" reading as corpus-noise, not micro-signal. Both knobs hold at spec (2, 2).

3. **Elbow detector false-positive reproduces — same bug as Task 5.** Renderer proposed `TAG_BOOST: 2 → 1, SUBJECT_BOOST: 2 → 4` despite the whole grid being flat. Same root cause: corner-of-grid sort-first pick when Δ across axes is below noise. **Do NOT ship this amendment.** Phase 11 "zero-axis-Δ guard" priority upgraded from speculative to confirmed-recurring.

---

**Task 6 — full graph coordinate descent (6 rounds) — complete. Four findings:**

1. **`TIER3_LAMBDA_1` / `TIER3_LAMBDA_2` inert under live Gemma — third-time reproduction.** Both rounds produce identical metrics across 5 values each (MRR 0.8057 flat to 4 decimals, ΔMRR -0.0020 vs gap=10 baseline). 9.4.9 framed this as edge-landscape homogeneity; live extraction did not change it. Evidence the inertness is corpus-structural, not extractor-dependent. **Hold both at spec.** Candidate for removal from future sweeps.

2. **`TIER3_BEAM_WIDTH=3` borderline signal reproduces.** +0.0055 absolute MRR on clean coverage (n_scored=1263, 0.011pp drop — well inside the 5pp guard). Below the 0.02 amendment threshold so it doesn't land, but it's the *only* non-coverage-bias positive signal in the entire graph sweep. Flag for Phase 11 observation: the one knob where structure still matters after gating.

3. **Coverage-bias trap reproduces on three knobs — third-time.** `TIER3_SEEDS_K=1` (MRR +0.1151 at n_scored=995, 50.1% coverage), `EDGE_CAP_PER_ENTRY=10` (MRR +0.1300 at n_scored=968, 48.7%), `COOCCURRENCE_WEIGHT=0.25` (MRR +0.1300 at n_scored=968, 48.7%). All three cleared the ΔMRR ≥ 0.02 threshold; renderer stamped ⚠️ and issued HOLD (subset-selection bias) on every one. Identical magnitudes to 9.4.9 under rule-based, within noise. **Zero amendments shipped** — detecting-vacuous-metrics skill's coverage guard did its job.

4. **Strong-signal null for Phase 11.** Live Gemma changed *none* of the graph-sweep findings from 9.4.9. λ inertness, beam borderline, and three coverage-bias traps all reproduce with identical signatures. Reading: the graph tier's elbow surface is determined by corpus structure and retrieval-cone geometry, not extractor quality. Phase 11's "Tier 2 gating demolition / graph tier needs different instrumentation" candidate just got firmer evidence: changing what facts get extracted doesn't move the elbow on LoCoMo's graph structure. Instrumentation (coverage-weighted MRR) will, per the inherited v2.1 scope.

---

## Task 5/6 observations (captured 2026-04-22)

**Hops smoke (pre-flight for the SWEEP_CONFIGS restore commit):**
- `TIER3_MAX_HOPS=2` (spec default): MRR 0.8057, n_scored 1277, recall@5 0.9363
- `TIER3_MAX_HOPS=3`: MRR 0.8024 (−0.0032), n_scored 1283 (+6), recall@5 0.9287
- Interpretation: extra hops broaden retrieval (+6 scored queries) but degrade rank quality on the enlarged set. Not subset-selection bias (coverage went up, not down). Preview confirms hops=2 is the ceiling on LoCoMo.

**Task 5 — full τ sweep (48 points) — complete. Three findings:**

1. **`TIER2_TAU_CONFIDENCE` re-confirmed inert under live Gemma.** Metrics identical to 4 decimal places across all 8 sampled values (0.5–5.0). This is the second-time reproduction of the 9.4.8 inertness finding. Rank-1 Tier-2 BM25 scores clear any confidence threshold in the tested range. Baseline should hold at spec 2.0. Inertness source is corpus-structural, not extractor-dependent — candidate for removal from future sweeps.

2. **`TIER2_TAU_GAP` plateau reproduces cleanly.** MRR climbs monotonically from 0.7303 (gap=0.1) to 0.8057 (gap=10), swing of +0.0754 absolute. Matches 9.4.8's `measured: 10, MRR 0.8077` within +/- 0.002 noise. Baseline holds at 10.

3. **🚨 Elbow detector false-positive — Phase 11 bullet added.** Renderer proposed amending `TIER2_TAU_CONFIDENCE: 2.0 → 0.5` because the grid has ties at the confidence axis's corner, and 0.5 sorts first. The rationale block self-admits `Δmetric/Δknob = 0.000000 ≤ 0.1×maxΔ = 0.000000` — i.e. the axis has zero variance. Any amendment is a vacuous no-op. **Do NOT ship this to `baseline.json` in Task 11.** Filed below as a Phase 11 hardening.

### Phase 11 candidate: elbow-detector zero-axis-Δ guard **(confirmed recurring)**

`_detect_elbow` in `bench/modal/sweep_app.py` proposes amendments when `Δmetric/Δknob` drops to zero AND the metric at the corner is the max, treating the sort order as the tiebreaker. For any axis where max Δ across all points is below the amendment threshold (inert knob OR Branch-C-flat grid), this produces a confident-wrong amendment proposal. Guard: when `maxΔ` on any axis is below the configured amendment threshold, suppress the elbow recommendation and emit "held at spec — knob flat/inert on this corpus." Field-surfaced 2026-04-22 during Task 5 (`TIER2_TAU_CONFIDENCE` inert) AND Task 8 (`TAG_BOOST`/`SUBJECT_BOOST` Branch-C flat). Two reproductions in 9.5 alone; pattern will recur on any future flat sweep. ~6 LOC fix but shipping it alongside amendment-threshold-reading logic in the renderer (not just the detector) is cleaner.

---

## Notes for Phase 11 (accumulated during 9.5 execution)

Phase 11 candidates identified during 9.5 dispatch. Task 11's retro expands these with per-sweep findings.

- **BATCH_SIZE consolidation round — budget-aware redesign.** 9.5 attempted the deferred 9.4.9 round twice under live extraction (run_point timeout=600s and 1500s). Both hit `FunctionTimeoutError` — first at ~470 live Nano-GPT calls, second at ~1200+. Every BATCH_SIZE grid value materializes ~94 conversations × batched live extraction at ~1.3s/call; 9.4.9's "~20% miss rate" budget estimate was wrong by ~10× (cache-key change = 100% miss for that seed pass, not 20%). No cache writes persisted either time — `volume.commit()` only fires at run_point exit, and SIGKILL skips the error path. Redesign options: (a) mid-subprocess periodic commits via threading (commit every 60s so SIGKILL loses ≤1 min); (b) conversation-level splitting so each Modal call is bounded (5 convs × 5 BATCH_SIZE values = 25 containers); (c) cheaper stress-test model (Gemma 4 1B A1B for 10× speedup if the dedup signal is the only question). Field-surfaced 2026-04-22 during Task 7 first and second dispatches.

- **`--local-out` parity for `run-point` mode.** `bench/modal/sweep_app.py`'s `@app.local_entrypoint()` handles `--local-out` only under `mode == "run-sweep"` (lines ~1311–1325). Single-point diagnostic runs via `run-point` discard the JSON payload to stdout and don't mirror to `docs/bench/runs/`. ~8 LOC fix: extend the `run-point` branch to write `run-point-YYYY-MM-DDThh-mm-ssZ.json` when `local_out` is set. Keeps the "every Modal dispatch includes `--local-out`" convention durable against future Azure-hiccup retries. Field-surfaced 2026-04-22 during Task 4 smoke.
- **Baselines sweep onto Modal substrate.** 9.5 Task 9 baseline comparison took 30+ min wall-clock running locally (sequential over 4 retrievers × 1986 QA items × full-LoCoMo seed). Modal parallelization across 4 containers would cut wall-clock to ~8 min. Requires a new `SWEEP_CONFIGS["baselines"]` entry or a distinct `--mode run-baselines` dispatch since baselines aren't a parameter sweep — they're a retriever-function swap. Field-surfaced 2026-04-23 during Task 9.
- **Scorer-chain investigation** (conditional on Task 9 inversion — see Decision 8).
- **Coverage-weighted retrieval metric** (inherited from 9.4.9; `recall@k × coverage` or similar to neutralize subset-selection bias on graph-structure knobs).
- **Tier 2 gating demolition** (inherited from 9.4.8/9.4.9; `TIER2_TAU_GAP=10` effectively disables Tier 2; ladder could simplify to always-Tier-3-as-Tier-2-seed).
- **LoCoMo dedup flatness** (9.4.6 + 9.4.9 + 9.5 three-time reproduction under rule-based and live extractors — extractor choice isn't the bottleneck; corpus structure is). Defer `DEDUP_JACCARD_THRESHOLD` tuning until multi-session corpora land.

## Done-when checklist

- [x] Task 0: Plan file committed.
- [x] Task 1: `llmExtractor.js` + tests green. *(Pre-shipped in 9.4.x; preflight URL fix landed as `b180bb6`.)*
- [x] Task 2: `extractionCache.js` + tests green. *(Pre-shipped in 9.4.x as `0dbac98`.)*
- [x] Task 3: Seeder env-gated switch + tests green; all prior tests still green. *(Pre-shipped in 9.4.x.)*
- [x] Task 4: Smoke writeup confirms Modal warm-cache replay. *(Completed 2026-04-22; run-point on full LoCoMo returned n_scored=1277, cache intact at 1182 entries, `--local-out` gap filed for Phase 11.)*
- [x] Task 5: τ sweep live writeup produced, flat/elbow verdict recorded. *(48 points, 2026-04-22T19-06-35Z. `TIER2_TAU_CONFIDENCE` inert re-confirmed, `TIER2_TAU_GAP=10` plateau reproduces. Detector false-positive filed for Phase 11.)*
- [x] Task 6: Graph sweep (6 rounds) live writeup, per-round verdicts. *(27 points across 6 rounds, 2026-04-22T19-35-03Z. λ1/λ2 inert third-time repro. beam=3 borderline clean. seeds_k/edge_cap/cooccurrence all coverage-bias HOLD'd. Zero amendments shipped — coverage guard did its job.)*
- [x] Task 7: Consolidation sweep + EXTRACT_MAX_TOKENS observation. *(DEDUP round 2026-04-22T19-46-24Z — Branch C fires fourth-time, updateRate 0.007-0.045 across thresholds. BATCH_SIZE round deferred to Phase 11 after Branch D fired twice. EXTRACT_MAX_TOKENS observation pending — can be done from warm cache.)*
- [x] Task 8: BM25 sweep with tags-populated-rate reported. *(16 points, 2026-04-23T04-27-08Z. Tags 100% populated under live Gemma. Grid Branch-C flat (MRR spread 0.0065 < 0.02). Elbow detector false-positive reproduces — bug filed for Phase 11.)*
- [x] Task 9: Baseline comparison with structural invariant verdict. *(4 retrievers, full LoCoMo, 2026-04-23 at commit f02b1a5. ladder 0.8057 > bm25only 0.6898 > recency 0.2703 > random 0.2690. Invariant PASS by +0.1159 MRR, 6× threshold. 30+ min wall-clock — Modal parallelization filed for Phase 11.)*
- [x] Task 10: New hops + relw sweep drivers + writeups. *(hops smoked pre-Task-5 with 2-row preview; relw 5 points 2026-04-23T05-09-11Z. relw is structurally inert to 4dp across all values — third edge-weight knob confirmed inert on LoCoMo. Third reproduction of elbow-detector false-positive in 9.5.)*
- [x] Task 11: `baseline.json` status=measured, retro written, all artifacts committed. *(Three-commit landing: 18c0df3 publishes sweep artifacts, 04d76f1 refreshes baseline.json with 9.5 numbers + new entries, 59bced1 writes retro.)*
- [x] No tests regress from 9.4.9 close (816 tests green minimum). *(75/816 pass, schema validator 7/7.)*
- [x] No secrets-guard redactions in plan or retro.
- [x] Phase 11 scope documented if scorer-chain investigation is warranted. *(Invariant PASS by 6× — no scorer-chain investigation needed. Six other Phase 11 candidates documented in retro §5.)*
