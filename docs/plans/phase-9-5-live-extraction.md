# Sub-phase 9.5 — Live-LLM Extraction

> **For Hermes:** Use `subagent-driven-development` skill to implement this plan task-by-task. Spec compliance review after each task, code quality review after spec passes. Proceed only when both reviews approve.

**Goal:** Swap the rule-based fact extractor in `bench/harness/seeder.js` for a real LLM client (env-gated), re-run all four knob sweeps on the 9.4.8/9.4.9 Modal substrate with the full grids restored, populate the new `TIER3_MAX_HOPS` / `EXPLICIT_RELATION_WEIGHT` sweeps (plus a `BATCH_SIZE` consolidation round deferred from 9.4.9), refresh `docs/bench/baseline.json` with live-extraction numbers, and honestly report the results — elbows, flat, or re-located.

**Architecture:** Phase 9 shipped the bench infrastructure; 9.4.8 shipped the Modal substrate (`bench/modal/sweep_app.py`, `SWEEP_CONFIGS` registry, Python renderers) and warmed an on-Volume extraction cache (`google/gemma-4-26b-a4b-it`, 1182 entries, 4.7 MB). 9.5 adds a Node-native OpenAI-compatible HTTP client that plugs into `_setLLMClientForTests`, an on-disk deterministic cache mirroring the Modal Volume layout, env-gated activation (`STARMEM_BENCH_LIVE_EXTRACTOR=1`), and new `SWEEP_CONFIGS` entries for the two uncovered knobs + a BATCH_SIZE round. CI stays on the rule-based path by default (determinism gate unset) so the existing 816 tests remain untouched.

**Cache re-use:** The warm cache from 9.4.8 already holds every extraction for `google/gemma-4-26b-a4b-it` against full LoCoMo. As long as message shape and batch composition are preserved, Tasks 5/6/8/10 run on pure cache hits — zero new LLM calls. Task 7's new BATCH_SIZE round intentionally invalidates the cache (Pattern 2 per `sweep-cache-invalidation-audit`) and regenerates missing entries on demand via live Nano-GPT.

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

**Step 3: Modal smoke on 1 real LoCoMo conversation**

```bash
modal run bench/modal/sweep_app.py --mode run-point --overrides-json '{}' \
    --local-out docs/bench/runs
```

Expected: single warm-cache run on full LoCoMo (post-run_point default). Wall-clock dominated by Modal cold start (~30s) + single retrieval pass (~10s); no LLM calls if cache is intact.

**Step 4: Verify cache intact on Volume after run**

```bash
modal run bench/modal/upload_cache.py
```

Expected: `cacheFiles: 1182` (unchanged). Any delta means the model/message/maxTokens shape drifted and new entries were written — check extraction cache keys via `modal volume ls starmem-bench-data /extractions/` and diff against 9.4.9's snapshot if needed.

**Step 5: Write smoke writeup**

Append a verdict section to the auto-generated writeup (Modal's `--local-out` already produced the data):

```markdown
## Live-extractor smoke verdict

- ✅ Modal Volume cache intact at 1182 entries post-run.
- ✅ Synthetic sweep completed without crashes.
- ✅ run_point on LoCoMo-1 produced facts; stateHash differs from rule-based reference (capture from a prior 9.4.x run).
- [If any check fails: blocker for Tasks 5–10. Report to controller.]
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
modal run bench/modal/sweep_app.py --mode run-graph-sweep --local-out docs/bench/runs
```

Cache warm from Task 5; 22 points × 6 rounds, coordinate descent. Wall-clock: ~8 min (one wave per round under the 32-cap).

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
modal run bench/modal/sweep_app.py --mode run-consolidation-sweep --local-out docs/bench/runs
```

`DEDUP_JACCARD_THRESHOLD`: 5 points, warm cache → ~90s wall-clock.
`BATCH_SIZE`: 5 points, cache-key invalidation → ~2.5 min wall-clock for live regeneration (~500 Nano-GPT calls per 9.4.9 retro's budget estimate).

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

## Done-when checklist

- [ ] Task 0: Plan file committed.
- [ ] Task 1: `llmExtractor.js` + tests green.
- [ ] Task 2: `extractionCache.js` + tests green.
- [ ] Task 3: Seeder env-gated switch + tests green; all prior tests still green.
- [ ] Task 4: Smoke writeup confirms cold/warm/rule-based comparison.
- [ ] Task 5: τ sweep live writeup produced, flat/elbow verdict recorded.
- [ ] Task 6: Graph sweep (5 rounds) live writeup, per-round verdicts.
- [ ] Task 7: Consolidation sweep + EXTRACT_MAX_TOKENS observation.
- [ ] Task 8: BM25 sweep with tags-populated-rate reported.
- [ ] Task 9: Baseline comparison with structural invariant verdict.
- [ ] Task 10: New hops + relw sweep drivers + writeups.
- [ ] Task 11: `baseline.json` status=measured, retro written, all artifacts committed.
- [ ] No tests regress from 9.4.9 close (816 tests green minimum).
- [ ] No secrets-guard redactions in plan or retro.
- [ ] Phase 11 scope documented if scorer-chain investigation is warranted.
