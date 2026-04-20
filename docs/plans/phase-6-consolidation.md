# Phase 6—Consolidation Implementation Plan

> **For Hermes:** Use `subagent-driven-development` skill to implement this plan task-by-task. Reviews MAY be skipped per that skill's criteria (verbatim code in plan + static checks per task + additive changes), with the standard sandbox-path / tripwire-hash / post-delegation `git log -1` verification after each subagent. Tasks 5 and 7 are flagged for controller-side eyeball verification even when review is skipped.

**Goal:** Ship Phase 6—consolidation. The one long-term mutator that drains the working buffer, calls the user's configured LLM for fact extraction, dedupes, writes Episodic, builds edges, invalidates the Tier 0 cache, and fires on buffer-≥-10 or idle-≥-60s.

**Architecture:** One function `consolidate(chatId)` inside `withWriteLock`. One function `extractFacts(batch, context)` wrapping the SillyTavern `ConnectionManagerRequestService`. Trigger plumbing lives in `src/consolidation/triggers.js`. Dedup uses Jaccard over BM25 tokenization. `maybeConsolidate` reads `state.runtime.consolidating` to avoid piling up runs. The "only consolidate mutates long-term" invariant is enforced by a grep-based test in `tests/unit/consolidation/no-other-mutators.test.js`.

**Tech Stack:** Vanilla ES2022 modules, jest for tests, tsc for JSDoc typecheck, eslint 9. No new runtime dependencies. `SillyTavern.getContext().ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens, custom, overridePayload)` is the LLM call surface (documented in ST at `public/scripts/extensions/shared.js:411`).

**Spec:** [§6 Write Path](../specs/2026-04-20-starmem-v2-design.md#6-write-path), [§2 principle 2 (one-path)](../specs/2026-04-20-starmem-v2-design.md#2-principles).

**Phase 5 handoff (from ROADMAP retro):** `buildEdges(entry, allEntries, state) → { newEdges, evicted }` is the pure contract. Inside the write lock: iterate `newEdges` → `addEdge`, iterate `evicted` → `removeEdge(state, e.from, e.to, e.type)`, then `invalidateTier0Cache(state)` once at end of batch.

---

## Decisions locked before writing this plan (see conversation 2026-04-20)

1. **Dedup criterion.** Same `subject` (exact string, null≠null per spec) AND Jaccard over `tokenize` ≥ 0.7. Higher than Tier 1's 0.6 — we want "same fact reworded," not "near-duplicate query."
2. **Dedup update semantics.** Option A: keep older content, only bump lifecycle via `applyUpdateEvent`. No edge rebuild on update (redundant — the entities are already mapped).
3. **LLM client.** `SillyTavern.getContext().ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens)` with user-selected profile. Matches v1's behavior per Eva. Phase 8 wires settings UI; Phase 6 ships the client behind an injectable interface (`_setLLMClientForTests`) so consolidate tests can mock.
4. **JSON parse/validate strategy.** Prompt includes schema inline. On LLM call failure, parse failure, or `isValidEntry` failure: log error, release lock, leave working buffer intact. Natural retry on next trigger. No partial state.
5. **In-flight concurrency guard.** `state.runtime.consolidating: boolean`. `maybeConsolidate` checks it *before* acquiring the write lock; bails if true. Set true inside the lock (first mutation), cleared in `finally`.
6. **New runtime fields.** `runtime.consolidating: boolean` (#5), `runtime.episodicCountSinceLastRebuild: number` (spec §6.4 — flips `pendingPersonaRebuild` at 100). Both added to `createEmptyState` and `looksLikeState`.
7. **Idle timer.** Module-level timer in `triggers.js` — NOT persisted (cross-session state, not memory). `resetIdleTimer(chatId)` called from the interceptor on any user activity; fires `maybeConsolidate(chatId, 'idle')` after `CONSOLIDATION.IDLE_TRIGGER_SECONDS`. `_resetTimersForTests` escape hatch.
8. **"Only consolidate mutates long-term" enforcement.** Grep-based test scans `src/` for mutation patterns (`state.entries[...] =`, `state.graph.edges.push`, direct `addEdge` calls outside consolidation, direct `applyUpdateEvent` outside consolidation). Whitelists: `src/consolidation/*`, the working-buffer append path (test fixture at `tests/integration/storage-roundtrip.test.js`).
9. **Batch size r = 5.** Spec §6.3 verbatim. Already in `CONSOLIDATION.BATCH_SIZE`. Phase 9 tunes.

---

## Cross-task conventions (inherited from Phases 1–5)

**Runtime dependency policy.** No new `dependencies`. Runtime code imports only from relative paths inside this repo and SillyTavern's exposed modules.

**Tokenize reuse.** `tokenize` is already exported from `src/retrieval/bm25.js`. Dedup imports from there, not from a new module.

**Fresh-fixture typedef pattern.** Every test fixture that constructs an `Entry` or `State` literal annotates with `/** @type {import('../../../src/core/schema.js').Entry} */` to prevent tsc literal widening. This has been load-bearing since Phase 1.

**ISO timestamps** via `new Date(now).toISOString()` everywhere; inject `now` into any function whose output depends on wall-clock time (per writing-plans skill's "Audit Spec Signatures" section).

**Commit format.** `<type>(<scope>): <summary>`. Scope is usually `consolidation` or a spec section like `§6.2`. Example: `feat(consolidation): add extractFacts with JSON-schema-constrained prompt per spec §6.1`.

---

## Sandbox-path protocol (every subagent task)

Every `delegate_task` context block must include:

```
ABSOLUTE REPO PATH (use this exactly — never `~`):
/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem

CRITICAL: A v1 copy of STARmem lives at /home/opus/SillyTavern/... — DO NOT TOUCH IT.
Verify with `git log -1 --oneline` showing `abc557d docs(plans): Phase 5 retro` (or any
descendant of that commit once Phase 6 begins). If the commit is different or working tree
is on v1, STOP and report.

DO NOT:
- Use `~` or `cd ~` anywhere — always use the absolute path above.
- Run `git add -A` — use explicit file paths only.
- Use `git stash --include-untracked` — report back and wait instead.
```

After each delegation the controller runs `cd <abs path> && git log -1 --oneline && npm run test --silent 2>&1 | tail -3` to verify the subagent's reported hash and test count.

---

## Task 0: Constants delta + new runtime fields

**Objective:** Add `DEDUP_JACCARD_THRESHOLD` to `CONSOLIDATION` in `constants.js` and extend `Runtime` typedef + `createEmptyState` + `looksLikeState` in `schema.js`/`state.js` with the two new fields.

**Owner:** Controller (mechanical, no subagent).

**Files:**
- Modify: `src/core/constants.js`
- Modify: `src/core/schema.js`
- Modify: `src/core/state.js`
- Modify: `tests/unit/core/constants.test.js` (add DEDUP_JACCARD_THRESHOLD test)
- Modify: `tests/unit/core/schema.test.js` (add runtime fields test)
- Modify: `tests/unit/core/state.test.js` (add looksLikeState acceptance of new fields)

**Step 1: Patch `src/core/constants.js`**

Add inside the `CONSOLIDATION = Object.freeze({...})` block, after `PERSONA_REBUILD_SUGGESTION_THRESHOLD: 100,` and before the closing `});`:

```js
    /** Dedup Jaccard threshold for same-subject merge. Spec §6.3; opening value, Phase 9 tunes. */
    DEDUP_JACCARD_THRESHOLD: 0.7,
```

**Step 2: Patch `src/core/schema.js`**

Extend the `Runtime` typedef (currently lines 68–73):

```js
/**
 * @typedef {object} Runtime
 * @property {string | null} lastConsolidation   - ISO timestamp or null.
 * @property {boolean} pendingPersonaRebuild
 * @property {boolean} consolidating              - True while consolidate() holds the write lock.
 * @property {number} episodicCountSinceLastRebuild - Increments per new Episodic entry; flips pendingPersonaRebuild at threshold.
 * @property {object[]} traces                    - Ring buffer, cap TRACE_BUFFER_CAP.
 */
```

Extend `createEmptyState`'s `runtime` block to include the two new fields with zero values:

```js
        runtime: {
            lastConsolidation: null,
            pendingPersonaRebuild: false,
            consolidating: false,
            episodicCountSinceLastRebuild: 0,
            traces: [],
        },
```

**Step 3: Patch `src/core/state.js` `looksLikeState`**

The existing check is loose (just checks top-level key types). Don't tighten it — stored states from before Phase 6 must still load. The Runtime fields are accessed defensively at use sites (`state.runtime?.consolidating ?? false`). No change needed here *if* the existing `typeof s.runtime === 'object' && s.runtime !== null` check passes.

**Verify no change needed:** read `src/core/state.js:102-112`, confirm the check is on `runtime`'s *existence* only, not its internal shape. If so, skip step 3. If the existing check tightens in Phase N>6, add optional-chaining defenses at Phase 6 use sites, never tighten the loader.

**Step 4: Patch constants test**

Add after the last assertion inside the `CONSOLIDATION constants` describe block in `tests/unit/core/constants.test.js`:

```js
    test('DEDUP_JACCARD_THRESHOLD is 0.7', () => {
        expect(CONSOLIDATION.DEDUP_JACCARD_THRESHOLD).toBe(0.7);
    });
```

**Step 5: Patch schema test**

Add inside the `createEmptyState` describe block in `tests/unit/core/schema.test.js`:

```js
    test('runtime includes consolidating=false and episodicCountSinceLastRebuild=0', () => {
        const s = createEmptyState();
        expect(s.runtime.consolidating).toBe(false);
        expect(s.runtime.episodicCountSinceLastRebuild).toBe(0);
    });
```

**Step 6: Run static checks + commit**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run typecheck && npm run lint && npm run test --silent 2>&1 | tail -5
git add src/core/constants.js src/core/schema.js tests/unit/core/constants.test.js tests/unit/core/schema.test.js
git commit -m "feat(§6): constants + runtime fields for consolidation"
```

**Expected:** all tests pass (262 Phase 5 baseline + 2 new = 264). Lint + typecheck green.

**Done-when:**
- `CONSOLIDATION.DEDUP_JACCARD_THRESHOLD === 0.7` exported
- `createEmptyState()` returns `runtime.consolidating === false` and `runtime.episodicCountSinceLastRebuild === 0`
- 264 tests green
- Commit landed, single commit, touches only the 4 files above

---

## Task 1: Dedup — `findDuplicate`

**Objective:** Pure function that returns the first existing Episodic entry whose `subject` matches and whose content Jaccard similarity ≥ `DEDUP_JACCARD_THRESHOLD`. Returns `null` when no match.

**Owner:** Subagent (TDD, verbatim code below).

**Files:**
- Create: `src/consolidation/dedup.js`
- Create: `tests/unit/consolidation/dedup.test.js`

**Step 1: Create `src/consolidation/dedup.js`**

```js
/**
 * Consolidation dedup — same-subject, near-duplicate-content collapse.
 *
 * Called by consolidate() for each newly-extracted Entry: if a prior Episodic
 * entry has the same subject (exact string, null≠null per spec §6.3) AND the
 * content Jaccard similarity is ≥ DEDUP_JACCARD_THRESHOLD, it is returned and
 * the caller bumps its lifecycle via applyUpdateEvent instead of adding a new
 * Entry. Working and Persona entries are not dedup candidates.
 *
 * Jaccard uses the same tokenize() as BM25 for consistency with retrieval.
 *
 * @module consolidation/dedup
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.3
 */

import { CONSOLIDATION } from '../core/constants.js';
import { tokenize } from '../retrieval/bm25.js';

const { DEDUP_JACCARD_THRESHOLD } = CONSOLIDATION;

/**
 * Jaccard similarity over two token arrays. Empty-over-empty returns 0 (not 1)
 * — zero-content entries should never dedup against each other.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccard(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    if (A.size === 0 && B.size === 0) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Return the first Episodic entry in `allEntries` that is a duplicate of
 * `candidate` under spec §6.3 rules, or null. Subject must match exactly
 * (strings or both null→no; null matches produce no candidates). Tokenization
 * shares the BM25 tokenize() function for consistency.
 *
 * @param {import('../core/schema.js').Entry} candidate
 * @param {import('../core/schema.js').Entry[]} allEntries
 * @returns {import('../core/schema.js').Entry | null}
 */
export function findDuplicate(candidate, allEntries) {
    // Spec §6.3: "duplicate_subject" — null subject never dedups.
    if (candidate.subject === null) return null;
    const candTokens = tokenize(candidate.content);
    for (const e of allEntries) {
        if (e.scope !== 'episodic') continue;
        if (e.subject !== candidate.subject) continue;
        const sim = jaccard(candTokens, tokenize(e.content));
        if (sim >= DEDUP_JACCARD_THRESHOLD) return e;
    }
    return null;
}
```

**Step 2: Create `tests/unit/consolidation/dedup.test.js`**

```js
import { describe, test, expect } from '@jest/globals';
import { findDuplicate, jaccard } from '../../../src/consolidation/dedup.js';
import { createEntry } from '../../../src/memory/entry.js';

const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

/** @param {Partial<Parameters<typeof createEntry>[0]>} over */
function ep(over) {
    return createEntry({
        scope: 'episodic',
        content: over.content ?? 'alice traveled to marseille',
        subject: over.subject ?? 'alice',
        tags: over.tags ?? [],
        relations: over.relations ?? [],
        provenance: over.provenance ?? { sourceMessages: [], extractor: 'test' },
        now: over.now ?? FIXED_NOW,
    });
}

describe('jaccard', () => {
    test('disjoint sets → 0', () => {
        expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
    });
    test('identical sets → 1', () => {
        expect(jaccard(['a', 'b'], ['b', 'a'])).toBe(1);
    });
    test('half overlap → 1/3', () => {
        expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 6);
    });
    test('empty-over-empty → 0 (not 1, by spec)', () => {
        expect(jaccard([], [])).toBe(0);
    });
    test('duplicates in input do not inflate', () => {
        expect(jaccard(['a', 'a', 'b'], ['a', 'b'])).toBe(1);
    });
});

describe('findDuplicate', () => {
    test('returns null for candidate with null subject', () => {
        const candidate = createEntry({
            scope: 'episodic', content: 'x', subject: null, tags: [], relations: [],
            provenance: { sourceMessages: [], extractor: 'test' }, now: FIXED_NOW,
        });
        const existing = ep({ subject: null, content: 'x' });
        expect(findDuplicate(candidate, [existing])).toBeNull();
    });

    test('returns null when no subject matches', () => {
        const candidate = ep({ subject: 'alice', content: 'alice went to paris' });
        const existing = ep({ subject: 'bob', content: 'alice went to paris' });
        expect(findDuplicate(candidate, [existing])).toBeNull();
    });

    test('returns null when subject matches but Jaccard below threshold', () => {
        const candidate = ep({ subject: 'alice', content: 'alice ate breakfast' });
        const existing = ep({ subject: 'alice', content: 'alice went to marseille' });
        // Jaccard(["alice","ate","breakfast"], ["alice","went","to","marseille"]) = 1/6 ≈ 0.17
        expect(findDuplicate(candidate, [existing])).toBeNull();
    });

    test('returns match when subject matches and Jaccard ≥ 0.7', () => {
        const candidate = ep({ subject: 'alice', content: 'alice traveled to marseille by train' });
        const existing = ep({ subject: 'alice', content: 'alice traveled to marseille' });
        const found = findDuplicate(candidate, [existing]);
        expect(found).not.toBeNull();
        expect(found?.id).toBe(existing.id);
    });

    test('skips non-episodic entries', () => {
        const candidate = ep({ subject: 'alice', content: 'alice traveled to marseille' });
        const workingDup = createEntry({
            scope: 'working', content: 'alice traveled to marseille',
            subject: 'alice', tags: [], relations: [],
            provenance: { sourceMessages: [], extractor: 'test' }, now: FIXED_NOW,
        });
        expect(findDuplicate(candidate, [workingDup])).toBeNull();
    });

    test('returns the FIRST match when multiple candidates qualify', () => {
        const candidate = ep({ subject: 'alice', content: 'alice traveled to marseille' });
        const first = ep({ subject: 'alice', content: 'alice traveled to marseille once' });
        const second = ep({ subject: 'alice', content: 'alice traveled to marseille twice' });
        const found = findDuplicate(candidate, [first, second]);
        expect(found?.id).toBe(first.id);
    });

    test('empty corpus → null', () => {
        const candidate = ep({ subject: 'alice' });
        expect(findDuplicate(candidate, [])).toBeNull();
    });
});
```

**Step 3: Run, commit**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run test -- tests/unit/consolidation/dedup.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/dedup.js tests/unit/consolidation/dedup.test.js
git commit -m "feat(consolidation): findDuplicate by subject + Jaccard ≥ 0.7 per spec §6.3"
```

**Expected:** 12 new tests pass (5 jaccard + 7 findDuplicate). No regressions elsewhere.

**Done-when:**
- `findDuplicate(candidate, [])` → null
- Same-subject, Jaccard-above-threshold → returns the existing entry
- Non-episodic existing entries are ignored
- Null subject never dedups
- 276 tests green (264 + 12)

**Subagent note:** This is pure TDD on a pure function. The tests above are verbatim — do not alter them. `tokenize` is already exported from `src/retrieval/bm25.js` (verified, line 22). Do not re-implement or vendor a tokenizer.

---

## Task 2: LLM client wrapper — `llmClient.js`

**Objective:** Thin injectable wrapper over `SillyTavern.getContext().ConnectionManagerRequestService.sendRequest`. Production client resolves ST context lazily (same pattern as `state.js:getSTContext`), test harness injects a fake. One function: `callLLM(profileId, messages, maxTokens) → Promise<string>` returning raw content.

**Owner:** Subagent (TDD with mocked ST context).

**Files:**
- Create: `src/consolidation/llmClient.js`
- Create: `tests/unit/consolidation/llmClient.test.js`

**Step 1: Create `src/consolidation/llmClient.js`**

```js
/**
 * LLM client for consolidation. Single surface: callLLM(profileId, messages, maxTokens).
 *
 * Resolves SillyTavern.getContext().ConnectionManagerRequestService at call
 * time — ST swaps the service object during lifecycle events, so caching a
 * reference is fragile (same reasoning as core/state.js:getSTContext).
 *
 * The service returns either ExtractedData (non-streaming, extractData=true)
 * or a stream function; we always call non-streaming with extractData=true,
 * so the return shape is ExtractedData. We read `.content` and nothing else.
 *
 * Test harness: call `_setLLMClientForTests(fakeCallLLM)` to override the
 * production resolver with a mock; `_resetLLMClientForTests()` restores.
 *
 * @module consolidation/llmClient
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.1
 * @see public/scripts/extensions/shared.js:411 (ConnectionManagerRequestService.sendRequest)
 */

/** @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} ChatMessage */
/** @typedef {(profileId: string, messages: ChatMessage[], maxTokens: number) => Promise<string>} LLMClient */

/**
 * Default production client. Resolves ST context lazily, throws a descriptive
 * error if ST is not available.
 *
 * @type {LLMClient}
 */
async function defaultCallLLM(profileId, messages, maxTokens) {
    const g = /** @type {any} */ (globalThis);
    const api = g.SillyTavern;
    if (!api || typeof api.getContext !== 'function') {
        throw new Error('llmClient: SillyTavern.getContext is unavailable');
    }
    const ctx = api.getContext();
    const svc = ctx?.ConnectionManagerRequestService;
    if (!svc || typeof svc.sendRequest !== 'function') {
        throw new Error('llmClient: ConnectionManagerRequestService.sendRequest is unavailable');
    }
    const response = await svc.sendRequest(profileId, messages, maxTokens);
    // extractData=true (default) → ExtractedData shape, which exposes .content
    const content = /** @type {any} */ (response)?.content;
    if (typeof content !== 'string') {
        throw new Error('llmClient: LLM response missing string .content');
    }
    return content;
}

/** @type {LLMClient} */
let client = defaultCallLLM;

/**
 * Call the user's configured LLM via a named connection profile. Returns the
 * raw string content of the response.
 *
 * @param {string} profileId
 * @param {ChatMessage[]} messages
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
export function callLLM(profileId, messages, maxTokens) {
    if (typeof profileId !== 'string' || profileId.length === 0) {
        return Promise.reject(new Error('callLLM: profileId must be a non-empty string'));
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        return Promise.reject(new Error('callLLM: messages must be a non-empty array'));
    }
    if (typeof maxTokens !== 'number' || maxTokens <= 0) {
        return Promise.reject(new Error('callLLM: maxTokens must be a positive number'));
    }
    return client(profileId, messages, maxTokens);
}

/**
 * Test-only: swap the client implementation for a mock.
 * @param {LLMClient} fn
 */
export function _setLLMClientForTests(fn) {
    if (typeof fn !== 'function') {
        throw new Error('_setLLMClientForTests: fn must be a function');
    }
    client = fn;
}

/** Test-only: restore the default (ST-backed) client. */
export function _resetLLMClientForTests() {
    client = defaultCallLLM;
}
```

**Step 2: Create `tests/unit/consolidation/llmClient.test.js`**

```js
import { describe, test, expect, afterEach } from '@jest/globals';
import {
    callLLM, _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

afterEach(() => _resetLLMClientForTests());

describe('callLLM (argument guards)', () => {
    test('rejects empty profileId', async () => {
        await expect(callLLM('', [{ role: 'user', content: 'hi' }], 100)).rejects.toThrow(/profileId/);
    });
    test('rejects empty messages', async () => {
        await expect(callLLM('p', [], 100)).rejects.toThrow(/messages/);
    });
    test('rejects non-positive maxTokens', async () => {
        await expect(callLLM('p', [{ role: 'user', content: 'x' }], 0)).rejects.toThrow(/maxTokens/);
    });
});

describe('callLLM (default client, no ST)', () => {
    test('throws when SillyTavern is unavailable', async () => {
        // Default globalThis.SillyTavern is undefined in jest env — this hits the guard.
        await expect(
            callLLM('p', [{ role: 'user', content: 'x' }], 100),
        ).rejects.toThrow(/SillyTavern\.getContext is unavailable/);
    });
});

describe('callLLM (injected test client)', () => {
    test('forwards (profileId, messages, maxTokens) to the injected fn', async () => {
        /** @type {any[]} */
        const calls = [];
        _setLLMClientForTests(async (pid, msgs, mt) => {
            calls.push({ pid, msgs, mt });
            return 'hello';
        });
        const out = await callLLM('profile-1', [{ role: 'user', content: 'ping' }], 42);
        expect(out).toBe('hello');
        expect(calls).toHaveLength(1);
        expect(calls[0].pid).toBe('profile-1');
        expect(calls[0].mt).toBe(42);
        expect(calls[0].msgs).toEqual([{ role: 'user', content: 'ping' }]);
    });

    test('propagates errors from the injected client', async () => {
        _setLLMClientForTests(async () => { throw new Error('LLM down'); });
        await expect(callLLM('p', [{ role: 'user', content: 'x' }], 10)).rejects.toThrow(/LLM down/);
    });

    test('_resetLLMClientForTests restores default behavior', async () => {
        _setLLMClientForTests(async () => 'ok');
        expect(await callLLM('p', [{ role: 'user', content: 'x' }], 10)).toBe('ok');
        _resetLLMClientForTests();
        await expect(
            callLLM('p', [{ role: 'user', content: 'x' }], 10),
        ).rejects.toThrow(/SillyTavern\.getContext is unavailable/);
    });
});
```

**Step 3: Run, commit**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run test -- tests/unit/consolidation/llmClient.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/llmClient.js tests/unit/consolidation/llmClient.test.js
git commit -m "feat(consolidation): LLM client wrapper over ConnectionManagerRequestService"
```

**Expected:** 7 new tests pass (3 guards + 1 no-ST + 3 injected). 283 tests total (276 + 7).

**Done-when:**
- `callLLM` rejects bad args with descriptive messages
- Default path throws "SillyTavern.getContext is unavailable" under jest (no ST global)
- `_setLLMClientForTests` + `_resetLLMClientForTests` round-trip cleanly
- All 283 tests green

**Subagent note:** `ConnectionManagerRequestService` is ST's canonical extension-LLM API; the signature is `sendRequest(profileId, prompt, maxTokens, custom = defaults, overridePayload = {})` and `prompt` accepts either a string or a `ChatCompletionMessage[]`. We always pass the array form. Do NOT try to import the ST class at runtime — extensions resolve it through `SillyTavern.getContext()` at call time.

---

## Task 3: Fact extraction — `extractFacts`

**Objective:** Build the LLM prompt, call `callLLM`, parse the JSON response, validate against entry shape, and return an `Entry[]` staged as `scope: 'episodic'`. On any failure — LLM error, parse failure, validation failure — throw with a descriptive message. Caller (consolidate) catches and aborts the batch without draining.

**Owner:** Subagent (TDD with mocked `callLLM`).

**Files:**
- Create: `src/consolidation/extractFacts.js`
- Create: `tests/unit/consolidation/extractFacts.test.js`

**Step 1: Create `src/consolidation/extractFacts.js`**

```js
/**
 * Fact extraction. Single function `extractFacts(batch, context)` — called
 * only from consolidate(), never on the retrieval hot path.
 *
 * Pipeline:
 *   1. Render the messages batch + system prompt.
 *   2. Call callLLM(profileId, messages, maxTokens).
 *   3. Parse JSON from the response (strip fences if present).
 *   4. Validate against the entry-extraction schema:
 *       { entries: [{ content, subject, tags?, relations? }, ...] }
 *   5. Return an Entry[] with scope='episodic', provenance set from context,
 *      relations defaulted to []. Caller runs dedup + edge building.
 *
 * Errors abort the batch. consolidate() catches and releases the write lock
 * without draining the working buffer — natural retry on next trigger.
 *
 * @module consolidation/extractFacts
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.1, §6.3
 */

import { callLLM } from './llmClient.js';
import { createEntry } from '../memory/entry.js';
import { ALL_EDGE_TYPES } from '../core/schema.js';

const EXTRACT_MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `You extract durable facts from a transcript of chat messages.

Output STRICT JSON, no prose, no markdown fences, matching this schema:
{
  "entries": [
    {
      "content": "<one factual statement, 1-2 sentences, third person>",
      "subject": "<canonical subject name or null if none>",
      "tags": ["<short topical tags>", ...],
      "relations": [
        { "type": "<mentions|supports|same_topic|temporal_next>", "target": "<other entry id or stable subject string>" }
      ]
    }
  ]
}

Rules:
- Only extract facts durably relevant to the character or world. Skip pleasantries, acknowledgments, and filler.
- If nothing durable, return {"entries": []}.
- "subject" is the character, place, or entity the fact is ABOUT.
- "tags" are lowercase single words or short multi-word strings.
- Relations are optional; omit the field entirely if none.
- Do not emit "contradicts" relations; that type is reserved.`;

/**
 * @typedef {object} ExtractContext
 * @property {string} profileId        - ST connection profile id for the extractor LLM.
 * @property {string} extractorLabel   - Human-readable extractor identifier for provenance.
 * @property {number[]} sourceMessageIndices - ST chat array indices the batch was drawn from.
 * @property {Date} [now]              - Injectable clock; defaults to new Date() at call time.
 */

/**
 * @typedef {object} BatchMessage
 * @property {string} role             - 'user' | 'assistant' | 'system'
 * @property {string} content
 */

/**
 * Try to extract a JSON object from a model response. Strips ```json ... ```
 * fences if present, trims whitespace. Does NOT attempt to repair invalid JSON.
 *
 * @param {string} raw
 * @returns {unknown}
 */
export function parseLLMJson(raw) {
    if (typeof raw !== 'string') {
        throw new Error('parseLLMJson: expected a string');
    }
    let s = raw.trim();
    // Strip ```json ... ``` or ``` ... ``` fences
    const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenced) s = fenced[1].trim();
    return JSON.parse(s);
}

/**
 * Validate the parsed-JSON shape. Returns the entries array on success;
 * throws on any structural problem.
 *
 * @param {unknown} parsed
 * @returns {Array<{content: string, subject: string | null, tags: string[], relations: Array<{type: string, target: string}>}>}
 */
export function validateExtractionShape(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('extractFacts: response must be a JSON object');
    }
    const root = /** @type {Record<string, unknown>} */ (parsed);
    if (!Array.isArray(root.entries)) {
        throw new Error('extractFacts: response.entries must be an array');
    }
    /** @type {Array<{content: string, subject: string | null, tags: string[], relations: Array<{type: string, target: string}>}>} */
    const out = [];
    for (let i = 0; i < root.entries.length; i++) {
        const raw = root.entries[i];
        if (!raw || typeof raw !== 'object') {
            throw new Error(`extractFacts: entries[${i}] must be an object`);
        }
        const e = /** @type {Record<string, unknown>} */ (raw);
        if (typeof e.content !== 'string' || e.content.length === 0) {
            throw new Error(`extractFacts: entries[${i}].content must be a non-empty string`);
        }
        const subject = e.subject === null || e.subject === undefined
            ? null
            : typeof e.subject === 'string'
                ? e.subject
                : null;
        if (e.subject !== null && e.subject !== undefined && typeof e.subject !== 'string') {
            throw new Error(`extractFacts: entries[${i}].subject must be string or null`);
        }
        const tagsRaw = e.tags ?? [];
        if (!Array.isArray(tagsRaw) || !tagsRaw.every(t => typeof t === 'string')) {
            throw new Error(`extractFacts: entries[${i}].tags must be string[]`);
        }
        const relsRaw = e.relations ?? [];
        if (!Array.isArray(relsRaw)) {
            throw new Error(`extractFacts: entries[${i}].relations must be an array`);
        }
        /** @type {Array<{type: string, target: string}>} */
        const rels = [];
        for (let j = 0; j < relsRaw.length; j++) {
            const r = /** @type {Record<string, unknown>} */ (relsRaw[j]);
            if (!r || typeof r !== 'object'
                || typeof r.type !== 'string'
                || typeof r.target !== 'string'
                || r.target.length === 0) {
                throw new Error(`extractFacts: entries[${i}].relations[${j}] must be { type, target }`);
            }
            if (!ALL_EDGE_TYPES.includes(/** @type {any} */ (r.type))) {
                throw new Error(`extractFacts: entries[${i}].relations[${j}].type invalid: ${r.type}`);
            }
            if (r.type === 'contradicts') {
                // Reserved per spec §4. Drop silently rather than fail — drift
                // detection is a v2.1 concern; permissive here means a
                // forward-compatible model doesn't break v2.0.
                continue;
            }
            rels.push({ type: r.type, target: r.target });
        }
        out.push({ content: e.content, subject, tags: [...tagsRaw], relations: rels });
    }
    return out;
}

/**
 * Render the batch + system prompt into chat-completion messages.
 *
 * @param {BatchMessage[]} batch
 * @returns {import('./llmClient.js').ChatMessage[]}
 */
export function renderExtractionPrompt(batch) {
    const transcript = batch
        .map(m => `[${m.role}] ${m.content}`)
        .join('\n');
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Transcript:\n${transcript}\n\nReturn the JSON now.` },
    ];
}

/**
 * Extract facts from a batch. Returns newly-built Episodic Entry objects,
 * ready for dedup + addEdge. Throws on LLM/parse/validation failure.
 *
 * @param {BatchMessage[]} batch
 * @param {ExtractContext} context
 * @returns {Promise<import('../core/schema.js').Entry[]>}
 */
export async function extractFacts(batch, context) {
    if (!Array.isArray(batch) || batch.length === 0) {
        throw new Error('extractFacts: batch must be a non-empty array');
    }
    if (!context || typeof context !== 'object') {
        throw new Error('extractFacts: context required');
    }
    const { profileId, extractorLabel, sourceMessageIndices, now } = context;
    if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new Error('extractFacts: context.profileId required');
    }
    if (typeof extractorLabel !== 'string' || extractorLabel.length === 0) {
        throw new Error('extractFacts: context.extractorLabel required');
    }
    if (!Array.isArray(sourceMessageIndices)) {
        throw new Error('extractFacts: context.sourceMessageIndices must be an array');
    }

    const messages = renderExtractionPrompt(batch);
    const raw = await callLLM(profileId, messages, EXTRACT_MAX_TOKENS);
    const parsed = parseLLMJson(raw);
    const specs = validateExtractionShape(parsed);

    const clock = now ?? new Date();
    return specs.map(s => createEntry({
        scope: 'episodic',
        content: s.content,
        subject: s.subject,
        tags: s.tags,
        relations: /** @type {any} */ (s.relations),  // validated types narrowed to ALL_EDGE_TYPES above
        provenance: {
            sourceMessages: [...sourceMessageIndices],
            extractor: extractorLabel,
        },
        now: clock,
    }));
}
```

**Step 2: Create `tests/unit/consolidation/extractFacts.test.js`**

```js
import { describe, test, expect, afterEach } from '@jest/globals';
import {
    extractFacts, parseLLMJson, validateExtractionShape, renderExtractionPrompt,
} from '../../../src/consolidation/extractFacts.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

const FIXED_NOW = new Date('2026-04-20T10:00:00Z');
const CTX = {
    profileId: 'gemma-4-31b',
    extractorLabel: 'gemma-4-31b@consolidation-v1',
    sourceMessageIndices: [0, 1, 2],
    now: FIXED_NOW,
};

afterEach(() => _resetLLMClientForTests());

describe('parseLLMJson', () => {
    test('parses a plain JSON object', () => {
        expect(parseLLMJson('{"a":1}')).toEqual({ a: 1 });
    });
    test('strips ```json fences', () => {
        expect(parseLLMJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });
    test('strips plain ``` fences', () => {
        expect(parseLLMJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    });
    test('throws on non-JSON', () => {
        expect(() => parseLLMJson('not json')).toThrow();
    });
});

describe('validateExtractionShape', () => {
    test('accepts empty entries list', () => {
        expect(validateExtractionShape({ entries: [] })).toEqual([]);
    });
    test('rejects non-object root', () => {
        expect(() => validateExtractionShape([])).toThrow(/JSON object/);
    });
    test('rejects missing entries field', () => {
        expect(() => validateExtractionShape({})).toThrow(/entries must be an array/);
    });
    test('accepts minimal entry (content + subject only)', () => {
        const out = validateExtractionShape({ entries: [{ content: 'x', subject: 'alice' }] });
        expect(out).toEqual([{ content: 'x', subject: 'alice', tags: [], relations: [] }]);
    });
    test('accepts null subject', () => {
        const out = validateExtractionShape({ entries: [{ content: 'x', subject: null }] });
        expect(out[0].subject).toBeNull();
    });
    test('rejects empty content', () => {
        expect(() => validateExtractionShape({ entries: [{ content: '', subject: 'a' }] })).toThrow(/content/);
    });
    test('rejects invalid edge type', () => {
        expect(() => validateExtractionShape({
            entries: [{
                content: 'x', subject: 'a',
                relations: [{ type: 'bogus', target: 't' }],
            }],
        })).toThrow(/relations\[0\]\.type invalid/);
    });
    test('silently drops contradicts relations (reserved per spec §4)', () => {
        const out = validateExtractionShape({
            entries: [{
                content: 'x', subject: 'a',
                relations: [
                    { type: 'mentions', target: 'ep_1' },
                    { type: 'contradicts', target: 'ep_2' },
                ],
            }],
        });
        expect(out[0].relations).toEqual([{ type: 'mentions', target: 'ep_1' }]);
    });
});

describe('renderExtractionPrompt', () => {
    test('prepends system prompt and formats transcript', () => {
        const msgs = renderExtractionPrompt([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
        ]);
        expect(msgs).toHaveLength(2);
        expect(msgs[0].role).toBe('system');
        expect(msgs[1].role).toBe('user');
        expect(msgs[1].content).toContain('[user] hello');
        expect(msgs[1].content).toContain('[assistant] hi there');
    });
});

describe('extractFacts (end-to-end with mocked LLM)', () => {
    test('produces Entry objects with correct shape', async () => {
        _setLLMClientForTests(async () => JSON.stringify({
            entries: [
                { content: 'alice traveled to marseille', subject: 'alice', tags: ['travel'] },
            ],
        }));
        const out = await extractFacts(
            [{ role: 'user', content: 'i went to marseille' }],
            CTX,
        );
        expect(out).toHaveLength(1);
        expect(out[0].scope).toBe('episodic');
        expect(out[0].content).toBe('alice traveled to marseille');
        expect(out[0].subject).toBe('alice');
        expect(out[0].tags).toEqual(['travel']);
        expect(out[0].relations).toEqual([]);
        expect(out[0].provenance.sourceMessages).toEqual([0, 1, 2]);
        expect(out[0].provenance.extractor).toBe('gemma-4-31b@consolidation-v1');
        expect(out[0].lifecycle.importance).toBe(50);
        expect(out[0].lifecycle.maturity).toBe('draft');
    });

    test('propagates LLM errors', async () => {
        _setLLMClientForTests(async () => { throw new Error('upstream 500'); });
        await expect(extractFacts([{ role: 'user', content: 'x' }], CTX))
            .rejects.toThrow(/upstream 500/);
    });

    test('throws on non-JSON response', async () => {
        _setLLMClientForTests(async () => 'sure, here are the facts: ...');
        await expect(extractFacts([{ role: 'user', content: 'x' }], CTX))
            .rejects.toThrow(/JSON/i);
    });

    test('throws on shape-mismatch response', async () => {
        _setLLMClientForTests(async () => JSON.stringify({ wrong: 'shape' }));
        await expect(extractFacts([{ role: 'user', content: 'x' }], CTX))
            .rejects.toThrow(/entries must be an array/);
    });

    test('handles empty-entries response (nothing durable)', async () => {
        _setLLMClientForTests(async () => '{"entries":[]}');
        const out = await extractFacts([{ role: 'user', content: 'lol' }], CTX);
        expect(out).toEqual([]);
    });

    test('rejects bad context (missing profileId)', async () => {
        await expect(extractFacts(
            [{ role: 'user', content: 'x' }],
            /** @type {any} */ ({ extractorLabel: 'x', sourceMessageIndices: [] }),
        )).rejects.toThrow(/profileId/);
    });

    test('rejects empty batch', async () => {
        await expect(extractFacts([], CTX)).rejects.toThrow(/batch/);
    });
});
```

**Step 3: Run, commit**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run test -- tests/unit/consolidation/extractFacts.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/extractFacts.js tests/unit/consolidation/extractFacts.test.js
git commit -m "feat(consolidation): extractFacts with JSON-schema-constrained prompt per spec §6.1"
```

**Expected:** 22 new tests pass (4 parseLLMJson + 8 validate + 1 renderPrompt + 9 extractFacts). 305 tests total (283 + 22).

**Done-when:**
- LLM errors propagate
- Parse failures throw with `/JSON/i`
- Shape-mismatch throws with spec-sensible field paths in the message
- Empty-entries response returns `[]` cleanly
- Contradicts relations silently filtered (spec §4 reserved)
- Produced entries have `scope: 'episodic'`, `lifecycle.importance: 50`, `maturity: 'draft'`, `provenance.sourceMessages` preserved
- All 305 tests green

**Subagent note:** The shape validator is permissive where spec allows (optional `tags`, optional `relations`) and strict where correctness matters (content type, edge-type membership, target non-empty). Do NOT add retry logic or prompt variants — one call, one result, one abort on failure. Retry is the caller's job (happens naturally on the next trigger).

---

## Task 4: The pipeline — `consolidate`

**Objective:** Ship the singular mutator. Holds the write lock, drains `BATCH_SIZE` working-buffer ids, extracts facts, dedupes, adds/updates, builds edges for *new* entries only, invalidates Tier 0 cache, increments `episodicCountSinceLastRebuild` (flipping `pendingPersonaRebuild` at threshold), persists. Errors roll back — working buffer untouched, caches untouched, new-entry writes discarded.

**Owner:** Subagent (TDD with mocked LLM). **Flagged for controller eyeball verification** — this is the one function the entire "one-path discipline" hinges on.

**Files:**
- Create: `src/consolidation/consolidate.js`
- Create: `tests/unit/consolidation/consolidate.test.js`

**Step 1: Create `src/consolidation/consolidate.js`**

```js
/**
 * consolidate() — the ONE function that mutates long-term storage.
 *
 * Per spec §2 principle 2: "One path per responsibility. ... Many readers,
 * single mutator." This is that single mutator. Any other code that writes
 * to state.entries (beyond the working-buffer append path) or state.graph
 * is a spec violation.
 *
 * Pipeline (spec §6.3):
 *   acquire write_lock
 *   mark state.runtime.consolidating = true
 *   take batch = workingBuffer[0:r] (r = CONSOLIDATION.BATCH_SIZE)
 *   entries = extractFacts(batch-as-messages, context)
 *   for each extracted entry:
 *     if findDuplicate in episodic corpus:
 *       applyUpdateEvent on the existing entry (importance += 5, updateCount += 1)
 *     else:
 *       add entry (scope already 'episodic' from extractFacts)
 *       buildEdges → apply newEdges + evicted inside the lock
 *       increment episodicCountSinceLastRebuild; flip pendingPersonaRebuild at threshold
 *   splice workingBuffer[0:r]
 *   invalidateTier0Cache(state)  (ONCE at end of batch per §5 cache rules)
 *   persistState
 *   clear consolidating flag, release lock
 *
 * Error handling: any exception (LLM call, parse, validate) releases the lock
 * *without* draining the buffer or persisting any changes. Natural retry on
 * the next trigger. No partial state.
 *
 * @module consolidation/consolidate
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.3, §2 principle 2
 */

import { withWriteLock } from '../core/lock.js';
import { loadState, persistState } from '../core/state.js';
import { CONSOLIDATION } from '../core/constants.js';
import { addEdge, removeEdge, buildEdges } from '../memory/index.js';
import { applyUpdateEvent } from '../lifecycle/index.js';
import { invalidateTier0Cache } from '../retrieval/tier0-exact.js';
import { extractFacts } from './extractFacts.js';
import { findDuplicate } from './dedup.js';
import { makeLogger } from '../core/logger.js';

const log = makeLogger('consolidation');

const {
    BATCH_SIZE,
    PERSONA_REBUILD_SUGGESTION_THRESHOLD,
} = CONSOLIDATION;

/**
 * @typedef {object} ConsolidateOptions
 * @property {string} profileId          - ST connection profile for extractor.
 * @property {string} extractorLabel     - Human-readable extractor identifier.
 * @property {(entry: import('../core/schema.js').Entry) => {role: string, content: string}} messageOf
 *            - Maps a Working entry to a batch message for the extractor prompt.
 * @property {Date} [now]                - Injectable clock for deterministic tests.
 */

/**
 * Consolidate the working buffer into Episodic. Idempotent when run on an
 * empty buffer (no-op fast path). At most one run per chatId concurrently
 * (guarded by state.runtime.consolidating + withWriteLock).
 *
 * @param {string} chatId
 * @param {ConsolidateOptions} opts
 * @returns {Promise<{ added: number, updated: number, drained: number } | { skipped: true }>}
 */
export async function consolidate(chatId, opts) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('consolidate: chatId required');
    }
    if (!opts || typeof opts !== 'object') {
        throw new Error('consolidate: options required');
    }
    const { profileId, extractorLabel, messageOf, now } = opts;
    if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new Error('consolidate: opts.profileId required');
    }
    if (typeof extractorLabel !== 'string' || extractorLabel.length === 0) {
        throw new Error('consolidate: opts.extractorLabel required');
    }
    if (typeof messageOf !== 'function') {
        throw new Error('consolidate: opts.messageOf required');
    }

    return withWriteLock(chatId, async () => {
        const state = await loadState(chatId);

        // In-flight guard: if another consolidation is mid-run (shouldn't happen
        // given withWriteLock, but defensive against persisted stuck-flag on
        // crash recovery).
        if (state.runtime.consolidating === true) {
            log.info('consolidate: already consolidating for this chat, skipping');
            return /** @type {const} */ ({ skipped: true });
        }

        // Empty-buffer fast path
        if (state.workingBuffer.length === 0) {
            return { added: 0, updated: 0, drained: 0 };
        }

        // Capture the batch *before* any mutation — if extract fails, we never
        // touch the buffer.
        const r = Math.min(BATCH_SIZE, state.workingBuffer.length);
        const batchIds = state.workingBuffer.slice(0, r);
        /** @type {import('../core/schema.js').Entry[]} */
        const batchEntries = [];
        for (const id of batchIds) {
            const e = state.entries[id];
            if (e) batchEntries.push(e);
        }
        if (batchEntries.length === 0) {
            // Buffer references missing ids — drop the stale references and
            // continue. This is the one case where we WRITE on an empty batch,
            // but it's a cleanup, not a long-term mutation.
            log.warn('consolidate: working buffer references missing entries; cleaning stale ids');
            let s1 = { ...state, workingBuffer: state.workingBuffer.slice(r) };
            await persistState(chatId, s1);
            return { added: 0, updated: 0, drained: r };
        }

        // Build the LLM prompt messages from batch entries
        const batchMessages = batchEntries.map(messageOf);
        const sourceMessageIndices = batchEntries.flatMap(e => e.provenance.sourceMessages);

        // Mark in-flight BEFORE calling the LLM so the flag is persisted even
        // if the process crashes mid-extraction. We only persist at the end,
        // so the flag is actually carried by the next mutation — but since we
        // hold the write lock throughout, no reader can observe a half-written
        // state.
        let work = { ...state, runtime: { ...state.runtime, consolidating: true } };

        /** @type {import('../core/schema.js').Entry[]} */
        let extracted;
        try {
            extracted = await extractFacts(batchMessages, {
                profileId,
                extractorLabel,
                sourceMessageIndices,
                now,
            });
        } catch (err) {
            // Abort: release lock, no mutation persisted. Buffer intact.
            log.error('consolidate: extraction failed, aborting batch', /** @type {any} */(err));
            // Clear the consolidating flag on disk in case a prior run left
            // it set. Cheap, idempotent.
            if (state.runtime.consolidating) {
                const cleared = { ...state, runtime: { ...state.runtime, consolidating: false } };
                await persistState(chatId, cleared);
            }
            throw err;
        }

        let added = 0;
        let updated = 0;
        const clock = now ?? new Date();

        for (const newEntry of extracted) {
            const allExisting = Object.values(work.entries);
            const dup = findDuplicate(newEntry, allExisting);
            if (dup) {
                // Update path: bump lifecycle only. Keep existing content, tags,
                // relations, id, provenance. Spec §6.3 option A.
                const bumped = {
                    ...dup,
                    lifecycle: applyUpdateEvent(dup.lifecycle, clock),
                };
                work = {
                    ...work,
                    entries: { ...work.entries, [dup.id]: bumped },
                };
                updated++;
            } else {
                // Add path. newEntry is already scope='episodic' from extractFacts.
                work = {
                    ...work,
                    entries: { ...work.entries, [newEntry.id]: newEntry },
                };
                // Build edges using the post-add state + full Entry[] corpus
                const corpus = Object.values(work.entries);
                const { newEdges, evicted } = buildEdges(newEntry, corpus, work);
                for (const e of newEdges) work = addEdge(work, e);
                for (const e of evicted) work = removeEdge(work, e.from, e.to, e.type);

                added++;
            }
        }

        // Counter + Persona rebuild flag
        if (added > 0) {
            const nextCount = (work.runtime.episodicCountSinceLastRebuild ?? 0) + added;
            const nextPending = work.runtime.pendingPersonaRebuild
                || nextCount >= PERSONA_REBUILD_SUGGESTION_THRESHOLD;
            work = {
                ...work,
                runtime: {
                    ...work.runtime,
                    episodicCountSinceLastRebuild: nextCount,
                    pendingPersonaRebuild: nextPending,
                },
            };
        }

        // Drain batch from working buffer
        work = { ...work, workingBuffer: work.workingBuffer.slice(r) };

        // Invalidate Tier 0 cache once at end of batch (spec §5)
        work = invalidateTier0Cache(work);

        // Close the run
        work = {
            ...work,
            runtime: {
                ...work.runtime,
                consolidating: false,
                lastConsolidation: clock.toISOString(),
            },
        };

        await persistState(chatId, work);
        return { added, updated, drained: r };
    });
}
```

**Step 2: Create `tests/unit/consolidation/consolidate.test.js`**

```js
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { consolidate } from '../../../src/consolidation/consolidate.js';
import { loadState, persistState, setBackend, _resetBackendForTests }
    from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

const CHAT = 'chat-1';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

const OPTS = {
    profileId: 'gemma-4-31b',
    extractorLabel: 'gemma-4-31b@v1',
    messageOf: (/** @type {import('../../../src/core/schema.js').Entry} */ e) =>
        ({ role: /** @type {const} */ ('user'), content: e.content }),
    now: FIXED_NOW,
};

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({
        read: (id) => store.get(id),
        write: (id, v) => { store.set(id, v); },
    });
    _resetLocksForTests();
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetLLMClientForTests();
});

/** @param {Partial<import('../../../src/core/schema.js').State>} [over] */
async function seed(over) {
    const s = { ...createEmptyState(), ...(over ?? {}) };
    store.set(CHAT, s);
    return s;
}

/** Helper: build a Working entry and register it in state.entries + workingBuffer. */
function workingEntry(content) {
    return createEntry({
        scope: 'working', content, subject: null, tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 'test-interceptor' },
        now: FIXED_NOW,
    });
}

describe('consolidate', () => {
    test('no-op on empty buffer', async () => {
        await seed();
        _setLLMClientForTests(async () => { throw new Error('should not be called'); });
        const result = await consolidate(CHAT, OPTS);
        expect(result).toEqual({ added: 0, updated: 0, drained: 0 });
    });

    test('drains up to BATCH_SIZE (5) and adds extracted facts', async () => {
        const w = Array.from({ length: 7 }, (_, i) => workingEntry(`turn ${i}`));
        const state = await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        expect(state.workingBuffer).toHaveLength(7);

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [
                { content: 'alice traveled to marseille', subject: 'alice', tags: ['travel'] },
                { content: 'alice met bob there', subject: 'alice' },
            ],
        }));

        const r = await consolidate(CHAT, OPTS);
        expect(r).toEqual({ added: 2, updated: 0, drained: 5 });

        const after = await loadState(CHAT);
        expect(after.workingBuffer).toHaveLength(2);  // 7 - 5 = 2
        const episodicCount = Object.values(after.entries).filter(e => e.scope === 'episodic').length;
        expect(episodicCount).toBe(2);
        expect(after.runtime.consolidating).toBe(false);
        expect(after.runtime.lastConsolidation).toBe(FIXED_NOW.toISOString());
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(2);
    });

    test('dedup path: same subject + similar content bumps existing importance', async () => {
        // Pre-seed an Episodic entry
        const existing = createEntry({
            scope: 'episodic', content: 'alice traveled to marseille',
            subject: 'alice', tags: [], relations: [],
            provenance: { sourceMessages: [], extractor: 'prior' },
            now: new Date('2026-04-19T10:00:00Z'),
        });
        const w = [workingEntry('user talks about alice trip')];
        await seed({
            entries: { [existing.id]: existing, [w[0].id]: w[0] },
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [
                // Near-duplicate content of existing
                { content: 'alice traveled to marseille by train', subject: 'alice' },
            ],
        }));

        const r = await consolidate(CHAT, OPTS);
        expect(r).toEqual({ added: 0, updated: 1, drained: 1 });

        const after = await loadState(CHAT);
        // Existing entry's importance should have bumped from 50 → 55 (applyUpdateEvent adds UPDATE_BONUS=5)
        expect(after.entries[existing.id].lifecycle.importance).toBe(55);
        expect(after.entries[existing.id].lifecycle.updateCount).toBe(1);
        // No new episodic entry
        const episodicCount = Object.values(after.entries).filter(e => e.scope === 'episodic').length;
        expect(episodicCount).toBe(1);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(0);  // updates don't count
    });

    test('LLM failure leaves working buffer intact and flag cleared', async () => {
        const w = [workingEntry('a'), workingEntry('b')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => { throw new Error('LLM down'); });

        await expect(consolidate(CHAT, OPTS)).rejects.toThrow(/LLM down/);

        const after = await loadState(CHAT);
        expect(after.workingBuffer).toHaveLength(2);  // unchanged
        expect(after.runtime.consolidating).toBe(false);  // not stuck
        expect(after.runtime.lastConsolidation).toBeNull();  // never succeeded
    });

    test('parse failure leaves state intact', async () => {
        const w = [workingEntry('a')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => 'not valid json at all');

        await expect(consolidate(CHAT, OPTS)).rejects.toThrow();

        const after = await loadState(CHAT);
        expect(after.workingBuffer).toHaveLength(1);
    });

    test('invalidates Tier 0 cache after a successful run', async () => {
        const w = [workingEntry('x')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
            tierCaches: { exact: { 'abcd1234': ['some-id'] }, fuzzy: {} },
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [{ content: 'alice did a thing', subject: 'alice' }],
        }));

        await consolidate(CHAT, OPTS);

        const after = await loadState(CHAT);
        expect(after.tierCaches.exact).toEqual({});
    });

    test('builds edges for newly-added entries (mentions co-occurrence)', async () => {
        // Pre-seed an Episodic entry with a distinct capitalized entity "Marseille"
        const existing = createEntry({
            scope: 'episodic', content: 'Alice visited Marseille last week',
            subject: 'Alice', tags: [], relations: [],
            provenance: { sourceMessages: [], extractor: 'prior' },
            now: new Date('2026-04-19T10:00:00Z'),
        });
        const w = [workingEntry('x')];
        await seed({
            entries: { [existing.id]: existing, [w[0].id]: w[0] },
            workingBuffer: w.map(e => e.id),
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [{ content: 'Alice ate croissants in Marseille', subject: 'Alice' }],
        }));

        const r = await consolidate(CHAT, OPTS);
        expect(r.added).toBe(1);

        const after = await loadState(CHAT);
        expect(after.graph.edges.length).toBeGreaterThan(0);
        // At least one mentions edge from the new entry back to `existing`
        const newEntryId = Object.keys(after.entries).find(id => id !== existing.id && id !== w[0].id);
        expect(newEntryId).toBeDefined();
        const hasMentions = after.graph.edges.some(
            e => e.from === newEntryId && e.to === existing.id && e.type === 'mentions',
        );
        expect(hasMentions).toBe(true);
    });

    test('flips pendingPersonaRebuild when episodicCountSinceLastRebuild crosses threshold', async () => {
        const w = [workingEntry('x')];
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
            runtime: {
                lastConsolidation: null,
                pendingPersonaRebuild: false,
                consolidating: false,
                episodicCountSinceLastRebuild: 99,
                traces: [],
            },
        });

        _setLLMClientForTests(async () => JSON.stringify({
            entries: [{ content: 'a new fact', subject: 'alice' }],
        }));

        await consolidate(CHAT, OPTS);

        const after = await loadState(CHAT);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(100);
        expect(after.runtime.pendingPersonaRebuild).toBe(true);
    });

    test('concurrent calls serialize via write lock (no duplicated drain)', async () => {
        const w = Array.from({ length: 7 }, (_, i) => workingEntry(`t${i}`));
        await seed({
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });

        /** @type {number} */
        let calls = 0;
        _setLLMClientForTests(async () => {
            calls++;
            // Return a single fact per call so we can count drains
            return JSON.stringify({ entries: [{ content: `fact ${calls}`, subject: 'alice' }] });
        });

        const [r1, r2] = await Promise.all([
            consolidate(CHAT, OPTS),
            consolidate(CHAT, OPTS),
        ]);

        // Two runs: first drains 5, second drains 2
        const drained = [r1, r2].map(r => /** @type {any} */ (r).drained).sort();
        expect(drained).toEqual([2, 5]);
        const after = await loadState(CHAT);
        expect(after.workingBuffer).toHaveLength(0);
    });

    test('propagates through bad options', async () => {
        await expect(consolidate('', OPTS)).rejects.toThrow(/chatId/);
        await expect(consolidate(CHAT, /** @type {any} */ ({}))).rejects.toThrow(/profileId/);
    });
});
```

**Step 3: Run, commit**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run test -- tests/unit/consolidation/consolidate.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/consolidate.js tests/unit/consolidation/consolidate.test.js
git commit -m "feat(consolidation): consolidate() pipeline per spec §6.3"
```

**Expected:** 10 new tests pass. 315 tests total (305 + 10).

**Done-when:**
- Empty buffer → no-op
- 7-entry buffer → drains 5, leaves 2
- Dedup path bumps importance, does NOT add new entry, does NOT increment `episodicCountSinceLastRebuild`
- LLM failure: buffer intact, `consolidating` flag false, `lastConsolidation` still null
- Parse failure: same
- Tier 0 cache cleared on success
- Mentions edges built for co-occurring capitalized entities
- `pendingPersonaRebuild` flips when count crosses threshold
- Concurrent calls serialize — `Promise.all([consolidate, consolidate])` drains 5+2 not 5+5
- All 315 tests green

**Controller-side verification after subagent (required, not skipped):**

```bash
cd <abs path>
# Invariant audit — grep for every mutation of state.entries or state.graph.edges
# in src/ outside src/consolidation/:
grep -rn "state\.entries\[" src/ | grep -v "src/consolidation/"
grep -rn "state\.graph\.edges" src/ | grep -v "src/consolidation/" | grep -v "src/memory/graph.js" | grep -v "src/memory/edgeBuilder.js"
# Expect: no output (any output is a spec violation — report and stop)
```

**Subagent note:** buildEdges + addEdge + removeEdge are the entry point to graph mutation and are whitelisted — they are called *from* consolidate.js. The grep above specifically excludes their definitions. If a hit appears outside `src/consolidation/` and outside the whitelist, that's the bug to find before moving on. Also note: the `{ skipped: true }` return path is defensive — `withWriteLock` should prevent concurrent runs, so `state.runtime.consolidating === true` inside the lock indicates crash recovery (stale flag from a prior interrupted run); we log and skip rather than repair automatically.

---

## Task 5: Triggers — `maybeConsolidate` + idle timer

**Objective:** Debounced trigger surface. `maybeConsolidate(chatId, reason, opts)` fires `consolidate()` when either the working buffer is ≥ `WORKING_BUFFER_THRESHOLD` (buffer reason) or the user has been idle ≥ `IDLE_TRIGGER_SECONDS` (idle reason). Idle timer is a per-chat module-level `setTimeout`; `resetIdleTimer(chatId, opts)` is called from the interceptor on activity.

**Owner:** Subagent (TDD with `jest.useFakeTimers()`).

**Files:**
- Create: `src/consolidation/triggers.js`
- Create: `tests/unit/consolidation/triggers.test.js`

**Step 1: Create `src/consolidation/triggers.js`**

```js
/**
 * Consolidation triggers. Two rules (spec §6.2, collapsed from v1's four):
 *   1. Working buffer size ≥ WORKING_BUFFER_THRESHOLD  → 'buffer' reason
 *   2. User idle ≥ IDLE_TRIGGER_SECONDS                → 'idle' reason
 *
 * Idle timer is a per-chat module-level setTimeout; the interceptor (Phase 8)
 * calls resetIdleTimer(chatId, opts) on any user activity. Timers are NOT
 * persisted — they're process state, not memory.
 *
 * maybeConsolidate checks state.runtime.consolidating before acquiring the
 * write lock to avoid queueing up runs behind one another; this is a
 * best-effort guard (the lock itself is the authority).
 *
 * @module consolidation/triggers
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.2
 */

import { loadState } from '../core/state.js';
import { CONSOLIDATION } from '../core/constants.js';
import { consolidate } from './consolidate.js';
import { makeLogger } from '../core/logger.js';

const log = makeLogger('triggers');
const { WORKING_BUFFER_THRESHOLD, IDLE_TRIGGER_SECONDS } = CONSOLIDATION;

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const idleTimers = new Map();

/**
 * Fire consolidation iff the trigger condition holds and no run is already
 * in flight. Idempotent on false triggers (returns `{ skipped: true }`).
 *
 * @param {string} chatId
 * @param {'buffer' | 'idle'} reason
 * @param {import('./consolidate.js').ConsolidateOptions} opts
 * @returns {Promise<Awaited<ReturnType<typeof consolidate>> | { skipped: true, why: string }>}
 */
export async function maybeConsolidate(chatId, reason, opts) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('maybeConsolidate: chatId required');
    }
    if (reason !== 'buffer' && reason !== 'idle') {
        throw new Error(`maybeConsolidate: reason must be 'buffer' or 'idle', got ${reason}`);
    }

    const state = await loadState(chatId);

    if (state.runtime.consolidating === true) {
        return { skipped: true, why: 'already-running' };
    }
    if (state.workingBuffer.length === 0) {
        return { skipped: true, why: 'empty-buffer' };
    }

    if (reason === 'buffer' && state.workingBuffer.length < WORKING_BUFFER_THRESHOLD) {
        return { skipped: true, why: 'below-threshold' };
    }
    // 'idle' reason has no buffer-size precondition beyond non-empty (above).

    log.info(`maybeConsolidate: firing (${reason}, buffer=${state.workingBuffer.length})`);
    return consolidate(chatId, opts);
}

/**
 * (Re)start the idle timer for a chat. Clears any existing timer first.
 * When the timer elapses, fires maybeConsolidate(chatId, 'idle', opts).
 *
 * @param {string} chatId
 * @param {import('./consolidate.js').ConsolidateOptions} opts
 */
export function resetIdleTimer(chatId, opts) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('resetIdleTimer: chatId required');
    }
    const prev = idleTimers.get(chatId);
    if (prev) clearTimeout(prev);

    const timer = setTimeout(() => {
        idleTimers.delete(chatId);
        maybeConsolidate(chatId, 'idle', opts).catch(err => {
            log.error('idle maybeConsolidate failed', /** @type {any} */ (err));
        });
    }, IDLE_TRIGGER_SECONDS * 1000);

    idleTimers.set(chatId, timer);
}

/**
 * Cancel the idle timer for a chat, if any. Used by the interceptor on chat
 * switch or extension teardown.
 *
 * @param {string} chatId
 */
export function cancelIdleTimer(chatId) {
    const prev = idleTimers.get(chatId);
    if (prev) {
        clearTimeout(prev);
        idleTimers.delete(chatId);
    }
}

/** Test-only: drop all outstanding idle timers. */
export function _resetTimersForTests() {
    for (const t of idleTimers.values()) clearTimeout(t);
    idleTimers.clear();
}
```

**Step 2: Create `tests/unit/consolidation/triggers.test.js`**

```js
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    maybeConsolidate, resetIdleTimer, cancelIdleTimer, _resetTimersForTests,
} from '../../../src/consolidation/triggers.js';
import { setBackend, _resetBackendForTests } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

const CHAT = 'chat-1';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');
const OPTS = {
    profileId: 'p', extractorLabel: 'x@v1',
    messageOf: (e) => ({ role: 'user', content: e.content }),
    now: FIXED_NOW,
};

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
    _resetTimersForTests();
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetTimersForTests();
    _resetLLMClientForTests();
});

function we(content) {
    return createEntry({
        scope: 'working', content, subject: null, tags: [], relations: [],
        provenance: { sourceMessages: [0], extractor: 'test' }, now: FIXED_NOW,
    });
}

describe('maybeConsolidate gates', () => {
    test("'buffer' reason: skips when buffer < 10", async () => {
        const w = Array.from({ length: 5 }, (_, i) => we(`t${i}`));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        _setLLMClientForTests(async () => { throw new Error('should not be called'); });

        const r = await maybeConsolidate(CHAT, 'buffer', OPTS);
        expect(r).toEqual({ skipped: true, why: 'below-threshold' });
    });

    test("'buffer' reason: fires at threshold", async () => {
        const w = Array.from({ length: 10 }, (_, i) => we(`t${i}`));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        _setLLMClientForTests(async () =>
            JSON.stringify({ entries: [{ content: 'f', subject: 'alice' }] }),
        );
        const r = /** @type {any} */ (await maybeConsolidate(CHAT, 'buffer', OPTS));
        expect(r.drained).toBe(5);
    });

    test("'idle' reason: fires on non-empty buffer regardless of size", async () => {
        const w = [we('one')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        _setLLMClientForTests(async () =>
            JSON.stringify({ entries: [{ content: 'f', subject: 'alice' }] }),
        );
        const r = /** @type {any} */ (await maybeConsolidate(CHAT, 'idle', OPTS));
        expect(r.drained).toBe(1);
    });

    test('skips on empty buffer regardless of reason', async () => {
        store.set(CHAT, createEmptyState());
        const r1 = await maybeConsolidate(CHAT, 'buffer', OPTS);
        expect(r1).toEqual({ skipped: true, why: 'empty-buffer' });
        const r2 = await maybeConsolidate(CHAT, 'idle', OPTS);
        expect(r2).toEqual({ skipped: true, why: 'empty-buffer' });
    });

    test('skips when runtime.consolidating === true', async () => {
        const w = Array.from({ length: 10 }, (_, i) => we(`t${i}`));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
            runtime: {
                lastConsolidation: null, pendingPersonaRebuild: false,
                consolidating: true, episodicCountSinceLastRebuild: 0, traces: [],
            },
        });
        _setLLMClientForTests(async () => { throw new Error('should not be called'); });
        const r = await maybeConsolidate(CHAT, 'buffer', OPTS);
        expect(r).toEqual({ skipped: true, why: 'already-running' });
    });

    test('throws on bad inputs', async () => {
        await expect(maybeConsolidate('', 'buffer', OPTS)).rejects.toThrow(/chatId/);
        await expect(maybeConsolidate(CHAT, /** @type {any} */ ('bogus'), OPTS))
            .rejects.toThrow(/reason/);
    });
});

describe('idle timer', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('fires maybeConsolidate(idle) after 60s of inactivity', async () => {
        const w = [we('hello')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        let llmCalls = 0;
        _setLLMClientForTests(async () => {
            llmCalls++;
            return JSON.stringify({ entries: [{ content: 'f', subject: 'alice' }] });
        });

        resetIdleTimer(CHAT, OPTS);
        // Advance to 59s — should not have fired
        jest.advanceTimersByTime(59_000);
        expect(llmCalls).toBe(0);

        // Cross the 60s boundary
        jest.advanceTimersByTime(2_000);
        // Drain microtasks / pending async
        await Promise.resolve();
        await Promise.resolve();
        // The LLM call may still be pending here because consolidate awaits loadState → lock → extractFacts.
        // Flush any pending promises.
        await jest.runAllTimersAsync();
        expect(llmCalls).toBeGreaterThanOrEqual(1);
    });

    test('resetIdleTimer debounces — repeated resets delay the firing', async () => {
        const w = [we('hello')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        let llmCalls = 0;
        _setLLMClientForTests(async () => {
            llmCalls++;
            return '{"entries":[]}';
        });

        resetIdleTimer(CHAT, OPTS);
        jest.advanceTimersByTime(30_000);
        resetIdleTimer(CHAT, OPTS);      // reset at 30s
        jest.advanceTimersByTime(30_000); // total 60s, but reset at 30s → not yet
        await Promise.resolve();
        expect(llmCalls).toBe(0);

        jest.advanceTimersByTime(31_000); // now 61s since last reset
        await jest.runAllTimersAsync();
        expect(llmCalls).toBeGreaterThanOrEqual(1);
    });

    test('cancelIdleTimer prevents firing', async () => {
        const w = [we('hello')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(w.map(e => [e.id, e])),
            workingBuffer: w.map(e => e.id),
        });
        let llmCalls = 0;
        _setLLMClientForTests(async () => {
            llmCalls++; return '{"entries":[]}';
        });

        resetIdleTimer(CHAT, OPTS);
        cancelIdleTimer(CHAT);
        jest.advanceTimersByTime(120_000);
        await jest.runAllTimersAsync();
        expect(llmCalls).toBe(0);
    });
});
```

**Step 3: Run, commit**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run test -- tests/unit/consolidation/triggers.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/triggers.js tests/unit/consolidation/triggers.test.js
git commit -m "feat(consolidation): triggers + idle timer per spec §6.2"
```

**Expected:** 9 new tests pass (6 maybeConsolidate + 3 idle timer). 324 tests total (315 + 9).

**Done-when:**
- `buffer` reason gated at WORKING_BUFFER_THRESHOLD
- `idle` reason fires on non-empty buffer regardless of size
- `consolidating === true` short-circuits both reasons
- Idle timer fires at 60s and debounces correctly
- `cancelIdleTimer` stops a pending firing
- All 324 tests green

**Subagent note:** `jest.useFakeTimers()` + `jest.runAllTimersAsync()` is the idiom for async-timer testing in jest 30+. If the test harness runs an older jest, the fallback is `jest.useFakeTimers({ legacyFakeTimers: true })` — but check `package.json` first, this repo is on jest 30. Do NOT introduce real `setTimeout` sleeps; fake timers are mandatory for determinism.

---

## Task 6: Barrel + one-path invariant test + integration test + retro

**Objective:** Close the phase. Export the public surface from `src/consolidation/index.js`, add the one-path invariant test (Decision 8), run a full 12-turn integration test with a mock LLM, append the Phase 6 retro to ROADMAP.md.

**Owner:** Controller (barrel + retro are trivial; invariant test + integration test delegated to subagent together).

**Files:**
- Create: `src/consolidation/index.js`
- Create: `tests/unit/consolidation/no-other-mutators.test.js`
- Create: `tests/integration/consolidation/pipeline.test.js`
- Modify: `docs/plans/ROADMAP.md` (append Phase 6 retro)

**Step 1: Create `src/consolidation/index.js`** (controller)

```js
/**
 * Consolidation barrel. Phase 8's interceptor and settings UI import from here.
 *
 * @module consolidation
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6
 */

export { consolidate } from './consolidate.js';
export { extractFacts } from './extractFacts.js';
export { findDuplicate, jaccard } from './dedup.js';
export { callLLM } from './llmClient.js';
export {
    maybeConsolidate, resetIdleTimer, cancelIdleTimer,
} from './triggers.js';
```

Commit:
```bash
git add src/consolidation/index.js
git commit -m "feat(consolidation): barrel export for Phase 8 consumers"
```

**Step 2: Create the one-path invariant test** (subagent)

`tests/unit/consolidation/no-other-mutators.test.js`:

```js
/**
 * Spec §2 principle 2 enforcement: consolidate() is the ONLY function that
 * mutates long-term storage. This test greps src/ for mutation patterns and
 * fails if any appear outside the consolidation module + whitelisted graph
 * primitives.
 *
 * NOTE: this is a heuristic. It catches common patterns but a determined
 * author could still bypass via dynamic property access. The real enforcement
 * is code review + this repo's discipline — this test is a tripwire.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const SRC = join(REPO_ROOT, 'src');

/** @type {string[]} */
function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...walk(full));
        else if (full.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * Files that legitimately mutate the persisted state tree.
 * Everything else should be read-only.
 */
const WHITELIST_PREFIXES = [
    'src/consolidation/',
    // Graph primitives — called FROM consolidate, not direct mutators
    'src/memory/graph.js',
    'src/memory/edgeBuilder.js',
    // State I/O — serializes the tree; doesn't mutate semantically
    'src/core/state.js',
    // Retrieval cache helpers — tierCaches, not entries/graph
    'src/retrieval/tier0-exact.js',
    'src/retrieval/tier1-fuzzy.js',
    'src/retrieval/trace.js',
    // Ladder calls applyAccessEvent on returned entries — lifecycle bump,
    // same kind of long-term mutation consolidate does on dedup-update.
    // Whitelisted for Phase 4's Decision 9 ("applyAccessEvent called at
    // ladder level, once per entry in the final returned list").
    'src/retrieval/ladder.js',
];

function isWhitelisted(relPath) {
    return WHITELIST_PREFIXES.some(p => relPath === p || relPath.startsWith(p));
}

/** Patterns that signal long-term mutation */
const MUTATION_PATTERNS = [
    // Direct entry-map writes
    /state\.entries\[/,
    // Direct graph-edges-list mutations
    /state\.graph\.edges\.push\b/,
    /state\.graph\.edges\.splice\b/,
    // Lifecycle writes
    /applyUpdateEvent\s*\(/,
    // addEdge / removeEdge invocations (as opposed to definitions)
    /\baddEdge\s*\(/,
    /\bremoveEdge\s*\(/,
];

describe('one-path invariant — only consolidate mutates long-term state', () => {
    const files = walk(SRC);

    for (const file of files) {
        const rel = relative(REPO_ROOT, file);
        if (isWhitelisted(rel)) continue;

        test(`${rel} contains no long-term mutation patterns`, () => {
            const src = readFileSync(file, 'utf8');
            const hits = [];
            const lines = src.split('\n');
            for (let i = 0; i < lines.length; i++) {
                for (const pat of MUTATION_PATTERNS) {
                    if (pat.test(lines[i])) {
                        hits.push(`${rel}:${i + 1}: ${lines[i].trim()}  (matches ${pat})`);
                    }
                }
            }
            if (hits.length > 0) {
                throw new Error(
                    'Spec §2 principle 2 violation — long-term mutation outside consolidation:\n'
                    + hits.join('\n')
                    + '\n\nFix: route this change through consolidate() or add the file to '
                    + 'WHITELIST_PREFIXES with a comment explaining why.',
                );
            }
            expect(hits).toEqual([]);
        });
    }

    test('whitelist has at least one consolidation file', () => {
        expect(WHITELIST_PREFIXES).toContain('src/consolidation/');
    });
});
```

**Step 3: Create the integration test** (subagent)

`tests/integration/consolidation/pipeline.test.js`:

```js
/**
 * Phase 6 integration test: 12-turn conversation, mock LLM, verify:
 *   1. First 10 turns don't trigger
 *   2. Turn 10 (buffer reaches threshold) triggers; drains 5
 *   3. After drain, buffer has 5 entries, 2 new Episodic facts exist,
 *      edges built, Tier 0 cache cleared
 *   4. Running again on the same state is a no-op (below threshold after drain)
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { maybeConsolidate } from '../../../src/consolidation/index.js';
import { loadState, persistState, setBackend, _resetBackendForTests }
    from '../../../src/core/state.js';
import { _resetLocksForTests, withWriteLock } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';

const CHAT = 'chat-pipeline';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetLLMClientForTests();
});

/** Push a working-scope entry into state, through the write lock. */
async function pushWorking(content, msgIdx) {
    await withWriteLock(CHAT, async () => {
        const s = await loadState(CHAT);
        const e = createEntry({
            scope: 'working', content, subject: null, tags: [], relations: [],
            provenance: { sourceMessages: [msgIdx], extractor: 'test-interceptor' },
            now: new Date(FIXED_NOW.getTime() + msgIdx * 1000),
        });
        const next = {
            ...s,
            entries: { ...s.entries, [e.id]: e },
            workingBuffer: [...s.workingBuffer, e.id],
        };
        await persistState(CHAT, next);
    });
}

describe('consolidation pipeline end-to-end', () => {
    test('12 turns: triggers at 10, drains 5, leaves 5, adds Episodic facts', async () => {
        store.set(CHAT, createEmptyState());

        // Simulate 12 turns of user activity through the interceptor pattern
        for (let i = 0; i < 12; i++) {
            await pushWorking(`turn ${i} content about Alice and Marseille`, i);

            // After each turn, interceptor would call maybeConsolidate('buffer').
            // Simulate the mock LLM returning 2 facts the first time it fires.
            _setLLMClientForTests(async () => JSON.stringify({
                entries: [
                    { content: 'Alice traveled to Marseille', subject: 'Alice', tags: ['travel'] },
                    { content: 'Alice is a traveler', subject: 'Alice', tags: ['character'] },
                ],
            }));

            const r = await maybeConsolidate(CHAT, 'buffer', {
                profileId: 'test',
                extractorLabel: 'mock@v1',
                messageOf: (e) => ({ role: 'user', content: e.content }),
                now: FIXED_NOW,
            });

            // Turns 0-8: below threshold, skipped
            if (i < 9) {
                expect(r).toEqual({ skipped: true, why: 'below-threshold' });
            }
            // Turn 9 pushes buffer to 10 → fires
            if (i === 9) {
                expect(/** @type {any} */ (r).drained).toBe(5);
                expect(/** @type {any} */ (r).added).toBe(2);
            }
            // Turns 10, 11: buffer is now 5 then 6 — below threshold again
            if (i >= 10) {
                expect(r).toEqual({ skipped: true, why: 'below-threshold' });
            }
        }

        const after = await loadState(CHAT);
        // 12 appended - 5 drained = 7 remaining
        expect(after.workingBuffer).toHaveLength(7);
        const episodic = Object.values(after.entries).filter(e => e.scope === 'episodic');
        expect(episodic).toHaveLength(2);

        // Edges exist (co-occurrence between the two episodic entries on "Alice" / "Marseille")
        expect(after.graph.edges.length).toBeGreaterThan(0);

        // Cache cleared
        expect(after.tierCaches.exact).toEqual({});

        // Runtime updated
        expect(after.runtime.consolidating).toBe(false);
        expect(after.runtime.lastConsolidation).toBe(FIXED_NOW.toISOString());
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(2);
        expect(after.runtime.pendingPersonaRebuild).toBe(false);  // 2 < 100
    });

    test('consecutive maybeConsolidate calls with empty buffer short-circuit', async () => {
        store.set(CHAT, createEmptyState());
        _setLLMClientForTests(async () => { throw new Error('should not be called'); });

        const r1 = await maybeConsolidate(CHAT, 'buffer', {
            profileId: 'test', extractorLabel: 'x@v1',
            messageOf: (e) => ({ role: 'user', content: e.content }),
            now: FIXED_NOW,
        });
        const r2 = await maybeConsolidate(CHAT, 'idle', {
            profileId: 'test', extractorLabel: 'x@v1',
            messageOf: (e) => ({ role: 'user', content: e.content }),
            now: FIXED_NOW,
        });

        expect(r1).toEqual({ skipped: true, why: 'empty-buffer' });
        expect(r2).toEqual({ skipped: true, why: 'empty-buffer' });
    });
});
```

**Step 4: Run, commit both test files + full suite**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run test --silent 2>&1 | tail -10
npm run typecheck && npm run lint
git add tests/unit/consolidation/no-other-mutators.test.js tests/integration/consolidation/pipeline.test.js
git commit -m "test(consolidation): one-path invariant + 12-turn integration"
```

**Expected:** Full suite passes. Count: roughly 324 + N (no-other-mutators creates one test per non-whitelisted src file — count depends on tree) + 2 integration = ~340+ tests. Final number recorded in the retro.

**Step 5: Append Phase 6 retro** (controller, after all tasks ship)

Append to `docs/plans/ROADMAP.md` BEFORE the existing `## Phase 5—2026-04-20` block. The retro log reads newest-first. Template:

```markdown
## Phase 6—2026-04-20

**What shipped:** Consolidation pipeline — `src/consolidation/consolidate.js` (single long-term mutator, holds write lock, drains BATCH_SIZE, extracts via LLM, dedupes same-subject + Jaccard≥0.7, adds/updates, builds edges, invalidates Tier 0, flips `pendingPersonaRebuild` at 100 new episodics), `src/consolidation/extractFacts.js` (JSON-schema-constrained prompt + permissive-where-spec-allows validator; silently drops reserved `contradicts` relations per spec §4), `src/consolidation/dedup.js` (`findDuplicate` + exported `jaccard` helper), `src/consolidation/llmClient.js` (injectable wrapper over ST's `ConnectionManagerRequestService.sendRequest`), `src/consolidation/triggers.js` (`maybeConsolidate` + per-chat idle timer, module-level `setTimeout` map, not persisted). 7 commits this phase plus plan + retro. **<N> tests passing across <M> suites** (262 Phase 5 baseline + <delta> new).

**Execution mode:** <brief — subagent-driven with reviews skipped per skill, except Task 4 (consolidate) and Task 6 (barrel/integration) which got controller-side invariant audits>.

**Decisions locked in the planning conversation (all held / list deviations):**

1. Dedup criterion: same subject + Jaccard ≥ 0.7.
2. Dedup update semantics: keep older content, bump lifecycle only.
3. LLM client: `ConnectionManagerRequestService.sendRequest` with user-selected profile, injectable for tests.
4. JSON parse/validate: fail-closed, no retry, no partial state.
5. In-flight guard: `runtime.consolidating` flag, checked before write-lock, set inside.
6. New runtime fields: `consolidating`, `episodicCountSinceLastRebuild`.
7. Idle timer: module-level per-chat `setTimeout`, not persisted.
8. One-path invariant: grep-based test in `tests/unit/consolidation/no-other-mutators.test.js`.
9. Batch size r = 5 verbatim from spec §6.3.

**Surprises:** <fill in during implementation>

**Notes for Phase 7 (Persona Rebuild):**

- `runtime.pendingPersonaRebuild` flips at `PERSONA_REBUILD_SUGGESTION_THRESHOLD=100` cumulative new episodic entries. Phase 7's rebuild pipeline should clear the flag on completion and reset `runtime.episodicCountSinceLastRebuild` to 0.
- `consolidate()` owns the write lock during its run. Persona rebuild will need its own lock slot (separate chatId-suffixed key? or a second lock primitive?) so a rebuild can't deadlock against consolidation.
- The extractor-label pattern (`"gemma-4-31b@consolidation-v1"`) is the template for persona-rebuild provenance too. Phase 7 entries produced by rebuild should carry `extractor: "<model>@persona-rebuild-v1"`.

**Notes for Phase 8 (ST Integration):**

- `ConsolidateOptions.messageOf` is the hook for the interceptor. The interceptor maps a Working entry back to a `{ role, content }` batch message — this is where roleplay-specific formatting lives (system/assistant role preservation, author notes stripped, etc.).
- Settings UI needs a connection-profile dropdown for `profileId`. Default: whatever ST reports as the active profile at install time.
- Idle timer in `triggers.js` requires the interceptor to call `resetIdleTimer(chatId, opts)` on every user activity event. Call `cancelIdleTimer(chatId)` on chat switch or extension teardown.
- The consolidation indicator (spec §8) can key off `state.runtime.consolidating` — Phase 8 polls or subscribes.

**Notes for Phase 9 (Benchmarking):**

- `DEDUP_JACCARD_THRESHOLD=0.7` is an opening value. If benchmarks show too-aggressive dedup (facts merged that shouldn't be) bump to 0.8; if too-little (near-duplicate facts both persisted) drop to 0.6.
- The fact-extraction prompt is in `src/consolidation/extractFacts.js` as `SYSTEM_PROMPT`. Treat it as a tunable — Phase 9 may need prompt variants per corpus (LoCoMo style vs LongMemEval style).
- The `{ added, updated, drained }` return from `consolidate` is the natural place to hang a consolidation trace for the benchmarking harness. Shape TBD.
```

Fill in the blanks from the actual shipped numbers, commit:

```bash
git add docs/plans/ROADMAP.md
git commit -m "docs(plans): Phase 6 retro"
```

**Done-when:**
- `src/consolidation/index.js` exports all public symbols
- `no-other-mutators.test.js` passes (one test per non-whitelisted src file, zero violations)
- Integration test passes (12 turns → drain at turn 9, 2 episodics, 7 left in buffer)
- Full suite green
- ROADMAP retro appended
- All commits landed (7 feature + 1 barrel + 1 invariant/integration + 1 retro = 10 commits in the phase; number may vary)

---

## Verification checklist after all tasks land

- [ ] `npm run test --silent` all green, no flakes
- [ ] `npm run typecheck` green
- [ ] `npm run lint` green
- [ ] `git log --oneline abc557d..HEAD` shows one commit per task + retro, no "fix up" noise
- [ ] `grep -rn "state\.entries\[" src/ | grep -v "src/consolidation/" | grep -v "src/core/state.js"` — empty
- [ ] `grep -rn "state\.graph\.edges\." src/ | grep -v "src/consolidation/" | grep -v "src/memory/graph.js" | grep -v "src/memory/edgeBuilder.js"` — empty
- [ ] `src/consolidation/` contains exactly: consolidate.js, extractFacts.js, dedup.js, llmClient.js, triggers.js, index.js
- [ ] ROADMAP Phase 6 retro filled in with final numbers and actual surprises, not the template

## Spec-compliance checklist

- [ ] Every function introduced is referenced in spec §6 (extractFacts, consolidate, maybeConsolidate, findDuplicate implicit in §6.3 dedup rule)
- [ ] No out-of-scope creep: no drift detection, no influence propagation, no embeddings, no v1 migration
- [ ] `contradicts` edges still reserved — never emitted by extractFacts (validator drops them)
- [ ] `consolidate` is the only long-term mutator — invariant test passing
- [ ] Inter-phase contract from ROADMAP.md §3 Phase 6 matches what shipped:
  ```
  extractFacts(batch, context) → Promise<Entry[]>
  consolidate(chatId, opts) → Promise<{added, updated, drained} | {skipped}>
  maybeConsolidate(chatId, reason, opts) → Promise<ConsolidateResult | {skipped, why}>
  ```
  (Note: the spec contract showed 3 args for `maybeConsolidate`; the ROADMAP listed 2. We shipped 3 — `opts` is required because the trigger needs to know which LLM profile to use. Update the ROADMAP contract string if it contradicts.)
