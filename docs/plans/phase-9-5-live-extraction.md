# Sub-phase 9.5 — Live-LLM Extraction

> **For Hermes:** Use `subagent-driven-development` skill to implement this plan task-by-task. Spec compliance review after each task, code quality review after spec passes. Proceed only when both reviews approve.

**Goal:** Swap the rule-based fact extractor in `bench/harness/seeder.js` for a real LLM client (env-gated), re-run all four knob sweeps and the baseline comparison on full LoCoMo, populate `docs/bench/baseline.json` with measured values, and honestly report the results — elbows or flat.

**Architecture:** Phase 9 shipped the entire bench infrastructure (runner, seeder, 4 sweep drivers, 3 baselines, CLI). The seeder installs `ruleBasedExtractor` via `_setLLMClientForTests`, producing regex-over-capitalized-word facts that don't differentiate knob values — hence flat sweep surfaces. 9.5 introduces a Node-native OpenAI-compatible HTTP client that plugs into the same `_setLLMClientForTests` seam, an on-disk deterministic cache, and env-gated activation (`STARMEM_BENCH_LIVE_EXTRACTOR=1`). CI stays on the rule-based path by default so the existing 734 tests remain untouched.

**Tech Stack:** Node 25, ESM modules, vanilla `fetch`, `node:crypto` for cache keys, `node:fs/promises` for cache I/O. No runtime deps added.

---

## Decisions locked before writing this plan (conversation 2026-04-21)

1. **Plan filename.** `docs/plans/phase-9-5-live-extraction.md`. Sub-phase in filename, not phase-10.
2. **LLM transport.** Node-native OpenAI-compatible HTTP via `fetch`. Config via `STARMEM_BENCH_LLM_URL`, `STARMEM_BENCH_LLM_API_KEY`, `STARMEM_BENCH_LLM_MODEL`.
3. **Extraction cache.** On by default, `--no-cache` flag to force live calls. Keyed by sha256 of `(modelId, messages, maxTokens, temperature)`.
4. **Determinism gate.** `STARMEM_BENCH_LIVE_EXTRACTOR=1` opts in. Unset = rule-based (preserves all 734 tests).
5. **Model choice.** Gemma 4 26B A4B via LiteLLM (Eva's calibration for speed+quality). Templated through env vars so any model works.
6. **Corpus.** Full LoCoMo (10 conversations) by default. `--conversations N` flag retained for dry runs.
7. **Temperature.** `0.0` hard-locked in the HTTP client. Non-negotiable for reproducibility.
8. **Baseline-comparison gate.** Structural invariant: `ladder_mrr ≥ bm25only_mrr − 0.02` on full LoCoMo. If inverted, 9.5 DOES NOT fix it — files Phase 11 follow-up and closes with honest retro.
9. **New sweeps.** `TIER3_MAX_HOPS` + `EXPLICIT_RELATION_WEIGHT` added as Task 10 unconditionally (in `_SWEPT_RETRIEVAL_KEYS` but uncovered in Phase 9).
10. **`EXTRACT_MAX_TOKENS` tuning.** Folded into Task 7 (consolidation sweep) — observes real token-output distributions per batch.
11. **Retro framing.** If sweeps still show flat elbows on live LLM, 9.5 retro says so honestly and proposes Phase 11 (scorer chain, gold-match criterion, corpus expansion). No forcing elbows that aren't there.

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
            url: 'http://litellm:8686/v1',
            apiKey: 'sk-test',
            model: 'gemma4-26b-a4b',
        });

        const result = await ext('profile-id', [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'user' },
        ], 2048);

        expect(result).toBe('{"entries":[]}');
        expect(global.fetch).toHaveBeenCalledWith(
            'http://litellm:8686/v1/chat/completions',
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
        expect(body.model).toBe('gemma4-26b-a4b');
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

Expected: 70 suites / 740 tests green (Phase 9 close 734 + 6 new).

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

Expected: 71 suites / 746 tests green, lint/typecheck green.

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
        process.env.STARMEM_BENCH_LLM_URL = 'http://litellm:8686/v1';
        process.env.STARMEM_BENCH_LLM_API_KEY = 'sk-test';
        process.env.STARMEM_BENCH_LLM_MODEL = 'gemma4-26b-a4b';

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

Expected: 72 suites / 750 tests green. All existing seeder-calling tests continue on the rule-based path because env is unset.

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

## Task 4: Smoke verification on 1 conversation

**Objective:** Run live extraction on a single LoCoMo conversation and confirm (a) the cache populates, (b) extracted facts differ structurally from rule-based, (c) no crashes. No metrics yet — just "live path works end-to-end."

**Files:**
- Artifact (untracked): `docs/bench/sweeps/YYYY-MM-DD-smoke-live.md`
- Optional modification: `.gitignore` adds `bench/.cache/` and `.env.bench`.

**Pre-flight:**
```bash
# Confirm the LiteLLM endpoint is reachable and the target model is registered.
curl -sS "$STARMEM_BENCH_LLM_URL/models" \
  -H "Authorization: Bearer $STARMEM_BENCH_LLM_API_KEY" | jq '.data[] | .id' | head
```
Expected: list includes `gemma4-26b-a4b` (or whatever `STARMEM_BENCH_LLM_MODEL` is set to).

**Step 1: Gitignore + env file**

```bash
grep -qxF "bench/.cache/" .gitignore || echo "bench/.cache/" >> .gitignore
grep -qxF ".env.bench" .gitignore || echo ".env.bench" >> .gitignore

cat > .env.bench << 'ENV_EOF'
export STARMEM_BENCH_LIVE_EXTRACTOR=1
export STARMEM_BENCH_LLM_URL=http://litellm:8686/v1
export STARMEM_BENCH_LLM_API_KEY=sk-YOUR-KEY
export STARMEM_BENCH_LLM_MODEL=gemma4-26b-a4b
ENV_EOF
```

(Edit `.env.bench` with the real API key before sourcing. Do not commit.)

If `.gitignore` changed, commit:
```bash
git add .gitignore
git commit -m "chore(bench): gitignore .env.bench and extraction cache"
```

**Step 2: Rule-based reference run**

```bash
unset STARMEM_BENCH_LIVE_EXTRACTOR
npm run bench:smoke 2>&1 | tee /tmp/smoke-rulebased.log
```

Capture `factCount`, `stateHash` from the CLI output for comparison.

**Step 3: Live run (cold cache)**

```bash
source .env.bench
npm run bench:smoke 2>&1 | tee /tmp/smoke-live.log
```

Expected: non-zero `factCount`, `stateHash` differs from rule-based, wall time a few minutes per conversation.

**Step 4: Verify cache populated**

```bash
ls bench/.cache/extractions/ | wc -l
```

Expected: >0 JSON files. Each file ~2KB.

**Step 5: Second live run — cache hit**

```bash
time npm run bench:smoke 2>&1 | tee /tmp/smoke-live-cached.log
```

Expected: wall time ≤10% of Step 3 (cache hit on every call). `factCount` + `stateHash` identical to Step 3.

**Step 6: Write smoke writeup**

Create `docs/bench/sweeps/YYYY-MM-DD-smoke-live.md` (substitute today's date):

```markdown
# Live-extractor smoke — YYYY-MM-DD

**Corpus:** LoCoMo conv 1 only (1 conversation, ~N QA items)
**Model:** gemma4-26b-a4b @ LiteLLM
**Purpose:** End-to-end sanity check; no metrics claims.

## Rule-based baseline (reference)
- factCount: R
- stateHash (first 12 chars): XXXXXXXXXXXX
- Wall time: T_r seconds

## Live run (cold)
- factCount: L
- stateHash (first 12 chars): YYYYYYYYYYYY
- Wall time: T_l_cold seconds
- Cache files written: N

## Live run (warm)
- factCount: L (identical)
- stateHash: YYYYYYYYYYYY (identical)
- Wall time: T_l_warm seconds
- Cache hit rate: 100%

## Sample extracted facts (live, first 5)
1. ...

## Sample extracted facts (rule-based, first 5) for contrast
1. ...

## Verdict
- ✅ Live extraction runs end-to-end without crashes.
- ✅ Cache produces deterministic replay.
- ✅ Live facts are structurally distinct from rule-based (narrative vs pronoun-matches).
- [If any check fails: blocker for Tasks 5–10. Report to controller.]
```

**Step 7: Leave artifact untracked**

Phase 9 convention: smoke + sweep writeups stay untracked for controller review before the Task 11 batch-commit.

```bash
git status --short docs/bench/sweeps/
```

Expected: `?? docs/bench/sweeps/YYYY-MM-DD-smoke-live.md`.

**No code commit at Task 4** — execution-only task. If Step 5 reveals a bug in Task 1/2/3, patch and commit separately.

---

## Task 5: Full-LoCoMo τ sweep (re-run)

**Objective:** Re-run the τ sweep (TIER2_TAU_CONFIDENCE × TIER2_TAU_GAP) on full LoCoMo with live extraction. Produce `docs/bench/sweeps/YYYY-MM-DD-tau-live.md`.

**Pre-flight:**
```bash
grep -n "TIER2_TAU_CONFIDENCE" bench/sweeps/tau.js
```
Expected: sweep grid present (6 × 8 = 48 points from Phase 9).

**Step 1: Source env**

```bash
source .env.bench
echo "STARMEM_BENCH_LIVE_EXTRACTOR=$STARMEM_BENCH_LIVE_EXTRACTOR (should be 1)"
```

**Step 2: Run the sweep on full LoCoMo**

```bash
node bench/sweeps/tau.js --conversations 10 2>&1 | tee /tmp/tau-live.log
```

Wall time: extraction runs once per `(conv, batch)` cache-miss then replays for every τ point. First conversation dominates; subsequent sweeps reuse cache.

**Step 3: Inspect results for elbow**

```bash
head -60 docs/bench/sweeps/YYYY-MM-DD-tau-live.md
```

- `max(mrr) − min(mrr) > 0.05` → elbow exists; recommend (τ_conf, τ_gap) corner.
- Surface still flat → report for retro; specDefaults hold.

**Step 4: Leave artifact untracked, summarize to controller**

Report:
- Total points, cache-hit rate after Task 4's warm-up.
- Elbow location (if any) or "flat surface" verdict.
- Any crashes, OOMs, extreme latencies.

---

## Task 6: Full-LoCoMo graph sweep (re-run)

**Objective:** Re-run the graph sweep (5 rounds: TIER3_LAMBDA_1, TIER3_LAMBDA_2, TIER3_BEAM_WIDTH, EDGE_CAP_PER_ENTRY, COOCCURRENCE_WEIGHT) on full LoCoMo. Produce `docs/bench/sweeps/YYYY-MM-DD-graph-live.md`.

**Pre-flight:**
```bash
grep -n "TIER3_LAMBDA_1\|BEAM_WIDTH\|EDGE_CAP" bench/sweeps/graph.js | head
```
Expected: all 5 round configurations present.

**Step 1: Run**

```bash
source .env.bench
node bench/sweeps/graph.js --conversations 10 2>&1 | tee /tmp/graph-live.log
```

Cache is warm from Task 5 — extraction keys don't depend on retrieval knobs, so every Task-5 miss becomes a Task-6 hit.

**Step 2: Inspect per-round elbows**

For each of the 5 knobs, check Δmrr vs round baseline:
- Δmrr ≥ 0.05 on any value → knob has signal; recommend value.
- Δmrr < 0.05 everywhere → round is flat; specDefault holds.

**Step 3: Report + leave untracked**

---

## Task 7: Full-LoCoMo consolidation sweep + EXTRACT_MAX_TOKENS observation

**Objective:** Re-run DEDUP_JACCARD_THRESHOLD sweep on full LoCoMo. Additionally, measure real token-output distributions per batch to inform `EXTRACT_MAX_TOKENS`. Produce `docs/bench/sweeps/YYYY-MM-DD-consolidation-live.md`.

**Pre-flight:**
```bash
grep -n "DEDUP_JACCARD_THRESHOLD\|factLengths" bench/sweeps/consolidation.js bench/harness/seeder.js
```
Expected: threshold sweep grid + `factLengths` collection in seeder already present from Phase 9 Task 6.

**Step 1: Run the sweep**

```bash
source .env.bench
node bench/sweeps/consolidation.js --conversations 10 2>&1 | tee /tmp/consolidation-live.log
```

**Step 2: Post-process cache for token observation**

After the sweep, examine cached responses for a token-proxy distribution:

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

Append the result as an "EXTRACT_MAX_TOKENS observation" section to `docs/bench/sweeps/YYYY-MM-DD-consolidation-live.md`.

**Note on token truth-source:** `chars/4` is a rough proxy. If the LLM's raw response body carries `usage.completion_tokens` (OpenAI format), extend `extractionCache.js` in a follow-up to persist it and rerun this step for truth numbers. For Task 7, char-proxy is sufficient — the aim is an order-of-magnitude decision (raise/hold/lower), not a precise value.

**Step 3: Inspect update-rate band**

Phase 6 retro band rule: `updateRate ∈ [0.2, 0.4]` is healthy. Outside = flag (not fix). `updateRate ≈ 0` = extractor still too thin; `updateRate > 0.5` = dedup too lax.

**Step 4: Report + leave untracked**

Recommendations to surface:
- `DEDUP_JACCARD_THRESHOLD` action (raise/lower/hold specDefault 0.7).
- `EXTRACT_MAX_TOKENS` action (raise/lower/hold specDefault 2048) with p95 observed.

---

## Task 8: Full-LoCoMo bm25 sweep (re-run)

**Objective:** Re-run TAG_BOOST × SUBJECT_BOOST sweep on full LoCoMo. Produce `docs/bench/sweeps/YYYY-MM-DD-bm25-live.md`.

**Key expectation:** Phase 9 reported `tags-populated-rate = 0%` because rule-based emitted `tags: []` on short content. Live extractor should populate tags (system prompt demands them). If tags-rate stays <5%, the sweep remains structurally blind — flag.

**Pre-flight:**
```bash
grep -n "TAG_BOOST\|tags-populated" bench/sweeps/bm25.js
```
Expected: TAG × SUBJECT grid + tags-populated-rate reporting present from Phase 9 Task 7.

**Step 1: Run**

```bash
source .env.bench
node bench/sweeps/bm25.js --conversations 10 2>&1 | tee /tmp/bm25-live.log
```

**Step 2: Inspect heatmap**

- `max(mrr) − min(mrr) > 0.05` → real signal; recommend (TAG_BOOST, SUBJECT_BOOST) corner.
- Flat + tags-populated-rate > 50% → scorer genuinely doesn't care on this corpus.
- Flat + tags-populated-rate < 5% → extractor still not tagging; inspect sample extractions and file Phase 11 item.

**Step 3: Report + leave untracked**

---

## Task 9: Full-LoCoMo baseline comparison

**Objective:** Run the 4-retriever baseline on full LoCoMo. Enforce the structural invariant (decision 8): `ladder_mrr ≥ bm25only_mrr − 0.02`. If inverted, do NOT investigate here — file Phase 11.

**Pre-flight:**
```bash
grep -n "ladderVsBm25Only\|structuralInvariants" bench/baselines.js
```
Expected: invariant-check logic present from Phase 9 Task 8.

**Step 1: Run**

```bash
source .env.bench
npm run bench:baselines -- --conversations 10 2>&1 | tee /tmp/baselines-live.log
```

**Step 2: Inspect the structural verdict**

`bench/baselines.js` lines 221–228 emit one of four verdicts:
- ✅ `ladder > bm25only > recency > random` → structural signal; scorer chain earns its keep.
- ⚠️ `ladder ≈ bm25only` (|Δmrr| ≤ 0.02) → scorer chain not earning its keep. DO NOT investigate; file Phase 11 in Task 11 retro.
- ❌ `ladder ≈ random` → structural bug. STOP; escalate to controller.
- ⚠️ Mixed signal → review corpus size + extraction quality, file Phase 11.

**Step 3: Record verdict for retro**

Feeds directly into Task 11's retro narrative.

**Step 4: Leave artifact untracked, report to controller**

---

## Task 10: New sweeps — TIER3_MAX_HOPS and EXPLICIT_RELATION_WEIGHT

**Objective:** Sweep the two remaining keys in `_SWEPT_RETRIEVAL_KEYS` that Phase 9 didn't cover. Produce two writeups under `docs/bench/sweeps/`.

**Files:**
- Create: `bench/sweeps/hops.js`
- Create: `bench/sweeps/relw.js`
- Modify: `package.json` (add `bench:sweep:hops` and `bench:sweep:relw` scripts)
- Artifacts: `docs/bench/sweeps/YYYY-MM-DD-hops-live.md`, `docs/bench/sweeps/YYYY-MM-DD-relw-live.md`

**Pre-flight:**
```bash
# Confirm both keys are in _SWEPT_RETRIEVAL_KEYS and readable via RETRIEVAL.*
grep -A 15 "_SWEPT_RETRIEVAL_KEYS = Object.freeze" src/core/constants.js
grep -n "TIER3_MAX_HOPS\|EXPLICIT_RELATION_WEIGHT" src/core/constants.js
```
Expected: both keys listed; specDefaults present (check values before drafting the sweep grid).

**Step 1: Read the existing tau.js sweep as template**

```bash
sed -n '1,80p' bench/sweeps/tau.js
```

`hops.js` and `relw.js` are thin clones of `tau.js` — same `parseArgs`, same `synthesizeSyntheticCorpus`, same `_driver.sweep` call, different `knobs`.

**Step 2: Create `bench/sweeps/hops.js`**

Full file (copy-paste — substitute the `knobs` block):

```javascript
#!/usr/bin/env node
/**
 * TIER3_MAX_HOPS sweep.
 *
 * Usage:
 *   node bench/sweeps/hops.js [--conversations N] [--primary NAME] [--synthetic]
 *
 * @see docs/plans/phase-9-5-live-extraction.md Task 10
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sweep, METRIC_ACCESSORS } from './_driver.js';
import { loadLocomo } from '../loaders/index.js';
import { _resetLLMClientForTests } from '../../src/consolidation/llmClient.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) { opts[key] = next; i++; }
            else { opts[key] = 'true'; }
        }
    }
    return opts;
}

async function main() {
    const args = parseArgs();
    const primary = args.primary || 'mrr';
    const useSynthetic = args.synthetic === 'true';

    const corpus = useSynthetic
        ? (await import('./tau.js')).synthesizeSyntheticCorpus?.() ?? []
        : await loadLocomo({ maxConversations: args.conversations ? Number(args.conversations) : undefined });

    const knobs = {
        TIER3_MAX_HOPS: [1, 2, 3, 4],
    };

    const result = await sweep({
        corpus,
        knobs,
        primaryMetric: primary,
        metricAccessor: METRIC_ACCESSORS[primary],
        sweepName: 'hops',
    });

    _resetLLMClientForTests();

    const dir = path.resolve('docs/bench/sweeps');
    await mkdir(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const out = path.join(dir, `${date}-hops-live.md`);
    await writeFile(out, result.writeup, 'utf8');
    console.log(`\nWriteup: ${out}`);
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
```

**Step 3: Create `bench/sweeps/relw.js`**

Identical structure; change only the `knobs` block and the sweepName/filename:

```javascript
    const knobs = {
        EXPLICIT_RELATION_WEIGHT: [0.5, 1.0, 1.5, 2.0, 3.0],
    };
    // ...
    sweepName: 'relw',
    // ...
    const out = path.join(dir, `${date}-relw-live.md`);
```

**Step 4: Add package.json scripts**

Use `patch` to add two entries to the `"scripts"` block in `package.json`:

```json
"bench:sweep:hops": "node bench/sweeps/hops.js",
"bench:sweep:relw": "node bench/sweeps/relw.js",
```

(Place after the existing `"bench:sweep:bm25"` line, comma-separated.)

**Step 5: Smoke-test the drivers on synthetic**

Before full LoCoMo runs, smoke each on synthetic to confirm they don't crash:

```bash
unset STARMEM_BENCH_LIVE_EXTRACTOR
node bench/sweeps/hops.js --synthetic --conversations 2 2>&1 | tail -30
node bench/sweeps/relw.js --synthetic --conversations 2 2>&1 | tail -30
```

Expected: each completes without error and emits a writeup file (flat metrics are fine at this stage — we're checking the driver wires up).

**Step 6: Lint + typecheck**

```bash
npm run lint && npm run typecheck
```

Expected: green.

**Step 7: Commit the drivers (code only — writeups follow in Step 8)**

```bash
git add bench/sweeps/hops.js bench/sweeps/relw.js package.json
git commit -m "feat(bench): TIER3_MAX_HOPS and EXPLICIT_RELATION_WEIGHT sweep drivers (Task 10)"
```

**Step 8: Run the live sweeps**

```bash
source .env.bench
node bench/sweeps/hops.js --conversations 10 2>&1 | tee /tmp/hops-live.log
node bench/sweeps/relw.js --conversations 10 2>&1 | tee /tmp/relw-live.log
```

Cache is warm from Tasks 5–9; both sweeps should run entirely on cache hits (zero LLM calls).

**Step 9: Inspect elbows**

Same rule as Tasks 5, 7, 8: `max(mrr) − min(mrr) > 0.05` = signal; flat = specDefault holds.

**Step 10: Leave artifacts untracked**

Both `hops-live.md` and `relw-live.md` join the untracked artifact pile for Task 11's batch commit.

**Step 11: Report to controller**

Per-knob recommendation (raise/lower/hold) for `TIER3_MAX_HOPS` and `EXPLICIT_RELATION_WEIGHT`.

---

## Task 11: Populate baseline.json + write retro

**Objective:** Update `docs/bench/baseline.json` with all measured values from Tasks 5–10, transitioning `status` from `"deferred"` to `"measured"`. Write `docs/plans/phase-9-5-retro.md` with an honest narrative: what moved, what didn't, what we're filing to Phase 11. Batch-commit all sweep/baseline writeups alongside.

**Files:**
- Modify: `docs/bench/baseline.json`
- Create: `docs/plans/phase-9-5-retro.md`
- Commit (all at once): every untracked file under `docs/bench/sweeps/*-live.md` and `docs/bench/baselines/*-live.md`

**Pre-flight:**
```bash
git status --short docs/bench/
```
Expected: one `?? *-smoke-live.md`, four `?? *-{tau,graph,consolidation,bm25}-live.md`, one `?? *-comparison-live.md`, two `?? *-{hops,relw}-live.md` — 8 untracked writeups. Confirm before editing `baseline.json`.

**Step 1: Update baseline.json**

For each of the 10 tuned keys (and the new 2 from Task 10, added to the `"tuned"` object), replace:

```json
{ "specDefault": X, "measured": null, "source": "sweeps/2026-04-21-*.md", "note": "..." }
```

with:

```json
{ "specDefault": X, "measured": Y, "source": "sweeps/YYYY-MM-DD-*-live.md", "note": "<elbow | flat; recommendation>" }
```

If a sweep was flat, `measured` stays equal to `specDefault` and the note records "flat surface on full LoCoMo with live extractor — specDefault retained".

Top-level fields to update:
- `"asOf"`: today's date
- `"gitSha"`: current HEAD (record after the Task 11 commit)
- `"corpus"`: `"locomo10-full"`
- `"status"`: `"measured"`
- `"statusReason"`: e.g. `"All 4 Phase 9 sweeps + 2 new sweeps (hops, relw) re-run with live Gemma 4 26B A4B extractor on full LoCoMo. [N] elbows found, [N] knobs flat. See per-sweep notes and phase-9-5-retro.md."`
- `"headlineMetrics"`: replace synthetic-corpus row with full-LoCoMo numbers from Task 9's comparison writeup. Include the new `"corpus"` subfield: `"locomo10-full (10 convs, ~2000 QA items)"`.
- `"structuralInvariants.ladderVsBm25Only"`: update `measuredMrrDelta` and `status` from Task 9 verdict.

**Step 2: Run the baseline-json schema validator**

```bash
npm test -- tests/integration/bench/baseline-json.test.js
```

Expected: green. The Phase 9 Task 9 validator asserts the JSON schema (top-level fields, per-knob shape). If it fails, the edit broke the schema.

**Step 3: Write `docs/plans/phase-9-5-retro.md`**

Template (follow Phase 9 retro's shape — Objective, Decisions Held/Revised table, Surprises, Notes for Phase 10/11):

```markdown
# Sub-phase 9.5 Retro

**Plan:** docs/plans/phase-9-5-live-extraction.md
**Shipped:** YYYY-MM-DD at commit XXXXXXX
**Corpus:** LoCoMo 10 conversations (~2000 QA items)
**Extractor:** gemma4-26b-a4b via LiteLLM, temperature=0, cached

## 1. What shipped

- Node-native LLM extractor (`bench/harness/llmExtractor.js`) with temperature=0.
- On-disk sha256-keyed extraction cache (`bench/harness/extractionCache.js`).
- Env-gated live/rule-based switch in the seeder.
- Two new sweep drivers (hops, relw).
- 7 full-LoCoMo sweep writeups + 1 baseline comparison.
- Measured `baseline.json` (status: measured).

**Test counts:**
- Phase 9 close: 70 suites / 734 tests.
- Sub-phase 9.5 close: [N] suites / [N] tests (+M from Tasks 1-3 + smoke).

## 2. Decisions held / revised

| Decision (from plan header) | Verdict | Rationale |
|---|---|---|
| 1. Plan filename | Held | ... |
| 2. LLM transport (OpenAI-compatible) | Held | ... |
| 3. Extraction cache on by default | Held | ... |
| ... (all 11) ... |

## 3. What the sweeps found

Per-knob summary (one line each):
- `TIER2_TAU_CONFIDENCE`: [elbow at X | flat — held 2.0]
- `TIER2_TAU_GAP`: ...
- `TIER3_LAMBDA_1` ... 2 ... MAX_HOPS ... BEAM_WIDTH ... EDGE_CAP_PER_ENTRY ... COOCCURRENCE_WEIGHT ... EXPLICIT_RELATION_WEIGHT: ...
- `DEDUP_JACCARD_THRESHOLD`: ...
- `TAG_BOOST` / `SUBJECT_BOOST`: ...
- `EXTRACT_MAX_TOKENS`: char-proxy p95 = [N]; recommend [raise/lower/hold].

Structural invariant (ladder vs bm25only MRR): [PASS: ladder ≥ bm25only − 0.02 | FLAG: ladder < bm25only − 0.02 on full LoCoMo].

## 4. Surprises

1. ...

## 5. Notes for Phase 10 (Playwright harness) and Phase 11 (scorer-chain investigation)

### Phase 11 scope (conditional on Task 9 verdict)

[If ladder < bm25only]: File scorer-chain investigation. Candidate hypotheses: importance × recency × maturity multiplicative chain introduces small perturbations that dominate the BM25 signal on corpora where extraction is clean (tags populated, subjects sharp). Approaches: (a) fusion scorer (RRF) instead of multiplicative; (b) tune weight per factor; (c) skip scorer chain for tier-2 returns when Tier 2 MRR > threshold.

### Phase 10 scope (unchanged)

- Playwright smoke harness (live ST integration end-to-end).
- UX polish (deferred from Phase 8).
- External memory-system baselines (Zep, Mem0) per Phase 9 Decision 5 footnote.

### Token-usage truth source (follow-up)

If Task 7's char-proxy EXTRACT_MAX_TOKENS recommendation is ambiguous, extend `extractionCache.js` to persist `usage.completion_tokens` from the OpenAI response body; re-run the post-process script for true token counts.
```

Fill in the table, narrative, and bullet lists with actual Task 5–10 results.

**Step 4: Verify no plan-redaction residue**

```bash
grep -n '=\s*\*\*\*\|=\*\*\*' docs/plans/phase-9-5-retro.md docs/plans/phase-9-5-live-extraction.md
```
Expected: empty (writing-plans skill's secrets-guard trap check).

**Step 5: Batch-commit all untracked artifacts + baseline.json + retro**

```bash
git add docs/bench/sweeps/*-live.md \
        docs/bench/baselines/*-live.md \
        docs/bench/baseline.json \
        docs/plans/phase-9-5-retro.md
git commit -m "docs(bench): sub-phase 9.5 measured baseline + retro (Task 11)"
```

**Step 6: Final suite + lint + typecheck**

```bash
npm test && npm run lint && npm run typecheck
```

Expected: all green. No regressions from 9.5 code.

**Step 7: Update memory**

Use `memory` or `hindsight_retain` to record:
- Sub-phase 9.5 shipped at commit [sha] with [N] tests across [N] suites.
- Which knobs had signal, which were flat.
- Phase 11 follow-up filed (if applicable).

---

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
- [ ] No tests regress from Phase 9 close (734 tests green minimum).
- [ ] No secrets-guard redactions in plan or retro.
- [ ] Phase 11 scope documented if scorer-chain investigation is warranted.
