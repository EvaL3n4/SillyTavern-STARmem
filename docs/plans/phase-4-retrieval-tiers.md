# Phase 4—Retrieval Tiers: Implementation Plan

> **For Hermes:** Execute via `subagent-driven-development` with the Sandbox Path Hygiene + Summary Verification protocols from that skill. Absolute paths only; verify each commit in the controller via `git log -1` after every delegation. Reviews can be skipped per the skill's criteria (verbatim code + static checks per task); one exception noted in Task 8 (ladder integration).

**Goal:** Assemble the Phase 3 primitives into the deterministic retrieval ladder. By the end of this phase, `retrieve(state, query)` returns a ranked entry list with a replayable trace in `state.runtime.traces`, via Tier 0 exact cache → Tier 1 Jaccard fuzzy → Tier 2 BM25 → Tier 3 stub → Floor fallback, with the working buffer prepended unconditionally. Tier 3 ships as an identity passthrough until Phase 5.

**Architecture:** Six small modules under `src/retrieval/` plus a ladder orchestrator and a trace logger. Each tier is a pure function over `(state, query, context) → ScoredEntry[]` with a `{ hit: boolean }` companion, except Floor which always hits. The ladder threads them in order, short-circuiting on first hit, and emits exactly one trace per call. `applyAccessEvent` is called on returned entries only, not candidates, and lives at the ladder level. Tier 0's cache lives in `state.tierCaches.exact`; the module exposes `invalidateTier0Cache(state)` for Phase 6's consolidation write lock to call on long-term writes. Working-buffer appends do NOT invalidate (the cache is pre-prepend).

**Tech Stack:** Same as Phase 3—Node 20+, ESM, jest, ESLint 9, tsc JSDoc check-only. No new devDependencies. No runtime deps.

**Spec references:** §5 (ladder), §5.2 (score), §7 (access-event lifecycle), §9.1 (trace logger), §9.2 (scorer identity in traces).

**Inter-phase contract Phase 5 inherits:**

```typescript
// ladder.js
retrieve(state: State, query: string, opts?: RetrieveOptions): RetrieveResult
type RetrieveOptions = { now?: Date; k?: number }
type RetrieveResult = {
  entries: Entry[];              // final ranked list, working-prepended
  tierResolved: 0 | 1 | 2 | 3 | 'floor';
  trace: Trace;                  // also pushed to state.runtime.traces
  state: State;                  // updated state (cache writes + access events + trace)
}

// trace.js
logTrace(state: State, trace: Trace): State    // ring-buffer append, cap TRACE_BUFFER_CAP
type Trace = {
  timestamp: string;             // ISO
  query: string;
  classifier: 'factual' | 'relational' | 'temporal';
  tierResolved: 0 | 1 | 2 | 3 | 'floor';
  perTier: { [k in '0'|'1'|'2'|'3']?: { id: string; bm25: number; score: number }[] | null };
  finalRanking: string[];        // entry ids
  scorerId: string;              // from scorer registry
}

// tier0-exact.js
tier0(state: State, query: string): Tier0Result
invalidateTier0Cache(state: State): State      // called by Phase 6's consolidate()
type Tier0Result = { hit: boolean; entries: Entry[]; state: State }

// tier1-fuzzy.js
tier1(state: State, query: string): Tier1Result
type Tier1Result = { hit: boolean; entries: Entry[]; state: State }

// tier2-bm25.js
tier2(state: State, query: string, ctx: { now: Date; intent: Intent; k?: number }):
  { hit: boolean; scored: ScoredEntry[] }

// floor.js
floor(state: State, ctx: { now: Date; k?: number }): ScoredEntry[]
```

**Decisions locked before writing this plan (see conversation 2026-04-20):**

1. **Tier 2 thresholds** — `TIER2_TAU_CONFIDENCE = 2.0`, `TIER2_TAU_GAP = 0.5`. Opening values; Phase 9 benchmarking will tune. Added to `RETRIEVAL` in `constants.js` as task 0.
2. **Traces ring buffer size** — `TRACE_BUFFER_CAP` bumped from 100 to 128. Spec §12.4 resolution was "make configurable"; we keep the constant and add a settings hook later. 128 is a decent benchmarking window and stays under 50KB of chatMetadata at spec §9.1's trace shape.
3. **Scorer identity in traces** — registry (string id) not `.name`. Function `.name` is lossy across arrow-assignment, minifiers, and re-exports; the registry survives JSONL serialization and replay.
4. **Tier 0 cache invalidation scope** — long-term mutations from `consolidate()` only. Working-buffer appends do NOT invalidate (the prepend happens downstream of the cache).
5. **Tier 0 key normalization** — trim + lowercase before hashing.
6. **Tier 1 candidate source** — compare query token sets against **recent cached queries** (the `tierCaches.fuzzy` shape in spec §3.2), not raw entry tokens. Matches spec §5's "near-duplicate queries" wording and earns the <5ms budget.
7. **Tier 2 score===0 filter** — exclude zero-scored candidates at Tier 2 output, before Floor check.
8. **Floor semantics** — pure fallback. Runs only when Tiers 0–3 all return empty.
9. **Scorer signature** — already `(entry, query, { now, bm25, intent? })` from Phase 3. No change needed.
10. **applyAccessEvent placement** — ladder level, called once per entry in the final returned list (not per candidate scored).

---

## Task 0: Pre-flight + constants delta

**Objective:** Confirm clean Phase 3 baseline and land the new retrieval + trace constants in a single small commit before any tier code.

**Files:**
- Modify: `src/core/constants.js`
- Modify: `tests/unit/core/constants.test.js`

**Step 1:** `cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem && git log -1 --oneline`. Expected: `269506d docs(plans): Phase 3 retro`.

**Step 2:** `git status` → clean. `npm run test --silent 2>&1 | tail -3` → 144 tests pass.

**Step 3:** Commit this plan:
```bash
git add docs/plans/phase-4-retrieval-tiers.md
git commit -m "docs(plans): add phase-4 retrieval tiers plan"
```

**Step 4:** Add constants. In `src/core/constants.js`, extend `RETRIEVAL` with:

```javascript
    /** Tier 2 exit: minimum top score required to shortcut the ladder. Spec §5; opening value, Phase 9 tunes. */
    TIER2_TAU_CONFIDENCE: 2.0,
    /** Tier 2 exit: minimum (top − #2) score gap required to shortcut. Spec §5; opening value, Phase 9 tunes. */
    TIER2_TAU_GAP: 0.5,
```

Change `TRACE_BUFFER_CAP` from `100` to `128`. Update the comment to read: `/** Trace ring buffer cap. Spec §9.1; resolution of §12.4 "make configurable"—default 128, settings hook deferred to Phase 8. */`

**Step 5:** Extend `tests/unit/core/constants.test.js`:

```javascript
test('RETRIEVAL Tier 2 exit thresholds', () => {
    expect(RETRIEVAL.TIER2_TAU_CONFIDENCE).toBe(2.0);
    expect(RETRIEVAL.TIER2_TAU_GAP).toBe(0.5);
});
```

And update the TRACE_BUFFER_CAP assertion:
```javascript
test('TRACE_BUFFER_CAP matches Phase 4 decision (spec §12.4 resolution)', () => {
    expect(TRACE_BUFFER_CAP).toBe(128);
});
```

**Step 6:** `npm run test`, `npm run lint`, `npm run typecheck` → all green.

**Step 7:** Commit:
```bash
git add src/core/constants.js tests/unit/core/constants.test.js
git commit -m "feat(core): add Tier 2 thresholds and bump trace cap to 128"
```

Expected: 2 new tests, 146 total.

---

## Task 1: Scorer registry

**Objective:** Retro-flagged requirement: traces record scorer identity (spec §9.1), and `.name` on arrow-assigned scorers is lossy. Refactor `src/retrieval/scorer.js` to use a string-keyed registry, leaving the existing `(entry, query, context) → number` signature untouched.

**Files:**
- Modify: `src/retrieval/scorer.js`
- Modify: `tests/unit/retrieval/scorer.test.js`

### Behavior

Module state becomes two items:
- A `Map<string, Scorer>` called `scorers`, seeded with `'default' → defaultScorer`.
- A string `currentId`, seeded with `'default'`.

Public API:
- `registerScorer(id: string, fn: Scorer): void` — adds to the map. Throws on non-string id, non-function fn, or id collision unless `id === 'default'` (reserved for the built-in).
- `setScorer(id: string): void` — sets `currentId`. Throws if id not registered.
- `getScorer(): Scorer` — unchanged return type; returns `scorers.get(currentId)`.
- `getScorerId(): string` — NEW; returns `currentId` for trace labeling.
- `_resetScorerForTests(): void` — resets map to `{ default: defaultScorer }` and `currentId = 'default'`.
- `defaultScorer` — unchanged export.

**Breaking change vs Phase 3:** `setScorer(fn)` (function arg) becomes `setScorer(id)` (string arg). Phase 3 had no external callers yet — safe.

### Test

Append to `tests/unit/retrieval/scorer.test.js` (keep all existing tests; replace the `setScorer replaces the active scorer` and `setScorer rejects non-functions` tests with the registry equivalents below):

```javascript
describe('scorer registry', () => {
    afterEach(() => _resetScorerForTests());

    test('getScorer returns defaultScorer initially', () => {
        expect(getScorer()).toBe(defaultScorer);
    });

    test('getScorerId returns "default" initially', () => {
        expect(getScorerId()).toBe('default');
    });

    test('registerScorer + setScorer switches the active scorer by id', () => {
        const constant = () => 42;
        registerScorer('constant-42', constant);
        setScorer('constant-42');
        expect(getScorer()).toBe(constant);
        expect(getScorerId()).toBe('constant-42');
    });

    test('setScorer throws on unregistered id', () => {
        expect(() => setScorer('nope')).toThrow(/registered/);
    });

    test('registerScorer rejects non-string id', () => {
        expect(() => registerScorer(/** @type {any} */ (42), () => 0)).toThrow(/id/);
    });

    test('registerScorer rejects non-function fn', () => {
        expect(() => registerScorer('x', /** @type {any} */ (null))).toThrow(/function/);
    });

    test('registerScorer rejects collision with existing non-default id', () => {
        registerScorer('x', () => 1);
        expect(() => registerScorer('x', () => 2)).toThrow(/already/);
    });

    test('registerScorer permits re-registering "default" (idempotent)', () => {
        // Default always maps to defaultScorer; re-registering same fn is a no-op.
        expect(() => registerScorer('default', defaultScorer)).not.toThrow();
    });

    test('_resetScorerForTests restores default registry and active id', () => {
        registerScorer('x', () => 1);
        setScorer('x');
        _resetScorerForTests();
        expect(getScorer()).toBe(defaultScorer);
        expect(getScorerId()).toBe('default');
        expect(() => setScorer('x')).toThrow(/registered/);
    });
});
```

Import line at the top gains `registerScorer, getScorerId`.

### Implementation

Replace the module state + setters in `src/retrieval/scorer.js` (below the `defaultScorer` definition) with:

```javascript
/** @type {Map<string, Scorer>} */
const scorers = new Map([['default', defaultScorer]]);

/** @type {string} */
let currentId = 'default';

/**
 * Register a scorer under a string id. Traces record the id, so pick a stable
 * symbolic name. Re-registering the literal `defaultScorer` under 'default' is
 * a no-op; any other collision throws.
 *
 * @param {string} id
 * @param {Scorer} fn
 */
export function registerScorer(id, fn) {
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`registerScorer: id must be a non-empty string, got ${typeof id}`);
    }
    if (typeof fn !== 'function') {
        throw new Error(`registerScorer: fn must be a function, got ${typeof fn}`);
    }
    if (id === 'default' && fn === defaultScorer) return;
    if (scorers.has(id)) {
        throw new Error(`registerScorer: id '${id}' is already registered`);
    }
    scorers.set(id, fn);
}

/**
 * Activate a registered scorer by id. Phase 8's settings UI calls this when
 * the user switches scorer in A/B mode.
 *
 * @param {string} id
 */
export function setScorer(id) {
    if (!scorers.has(id)) {
        throw new Error(`setScorer: id '${id}' is not registered`);
    }
    currentId = id;
}

/** @returns {Scorer} */
export function getScorer() {
    return /** @type {Scorer} */ (scorers.get(currentId));
}

/** @returns {string} */
export function getScorerId() {
    return currentId;
}

/** Test-only escape hatch. Clears the registry back to the default-only state. */
export function _resetScorerForTests() {
    scorers.clear();
    scorers.set('default', defaultScorer);
    currentId = 'default';
}
```

### Steps

1. Update test file with new cases (TDD — write failing first).
2. `npm run test tests/unit/retrieval/scorer.test.js` → expected failures on registry tests.
3. Apply implementation.
4. Run all tests → green.
5. Lint, typecheck green.
6. Update `src/retrieval/index.js` barrel to export `registerScorer, getScorerId`:
   ```javascript
   export {
       defaultScorer, setScorer, getScorer, getScorerId,
       registerScorer, _resetScorerForTests,
   } from './scorer.js';
   ```
   and add assertions to `tests/unit/retrieval/index.test.js` for the two new exports.
7. Full `npm run test` → green.
8. Commit: `feat(retrieval): convert scorer to string-keyed registry for trace identity`.

Expected test count: ~10 scorer tests + 2 barrel tests = ~12 total in this file pair, net +3–5 over Phase 3.

---

## Task 2: Tier 0 — exact query cache

**Objective:** Land `src/retrieval/tier0-exact.js`. Hash the normalized query, look up `state.tierCaches.exact`, return cached entries on hit. Cache writes happen at ladder level; this module exports both the lookup and the write helpers. Expose `invalidateTier0Cache(state)` for Phase 6's consolidation write lock to call on long-term writes.

**Files:**
- Create: `src/retrieval/tier0-exact.js`
- Create: `tests/unit/retrieval/tier0-exact.test.js`

### Behavior

Key construction: `normalizeQuery(q)` → trim + lowercase. Hash: simple FNV-1a 32-bit over the normalized string. (Any deterministic hash works; FNV-1a is 8 lines and collision-safe enough for a per-chat cache.) Hash output: lowercase hex string.

```javascript
normalizeQuery("  Hello WORLD  ") === "hello world"
hashQuery("hello world") === "2b053b1f"  // example
```

API:
- `tier0(state, query) → { hit: boolean, entries: Entry[], state: State }` — on hit, returns entries dereferenced from `state.entries` via the cached id list (ids whose entries no longer exist are skipped, not errors). On miss, `entries: []`, `state` unchanged.
- `recordTier0(state, query, entries) → State` — write helper, called by the ladder only when a downstream tier resolves. Stores the entry ids under the hash key.
- `invalidateTier0Cache(state) → State` — clears the entire exact cache. Returns a new state; does NOT mutate input. Called by Phase 6's consolidate().
- `normalizeQuery(q)` and `hashQuery(s)` exported for tests and Tier 1's recency hook (Tier 1 also wants the normalized query for set comparison).

### Test

```javascript
import {
    tier0,
    recordTier0,
    invalidateTier0Cache,
    normalizeQuery,
    hashQuery,
} from '../../../src/retrieval/tier0-exact.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function seedState(entries = []) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    return s;
}

function ep(id, content) {
    const e = createEntry({
        scope: 'episodic', content, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...e, id };
}

describe('normalizeQuery', () => {
    test('trims and lowercases', () => {
        expect(normalizeQuery('  Hello WORLD  ')).toBe('hello world');
    });

    test('preserves internal whitespace (Tier 1 tokenizes)', () => {
        expect(normalizeQuery('Alice  and   Bob')).toBe('alice  and   bob');
    });

    test('rejects non-strings', () => {
        expect(() => normalizeQuery(/** @type {any} */ (null))).toThrow(/string/);
    });
});

describe('hashQuery', () => {
    test('is deterministic', () => {
        expect(hashQuery('hello')).toBe(hashQuery('hello'));
    });

    test('differs for different inputs', () => {
        expect(hashQuery('hello')).not.toBe(hashQuery('world'));
    });

    test('produces 8-char lowercase hex', () => {
        expect(hashQuery('hello')).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe('tier0', () => {
    const a = ep('a1', 'alice in marseille');
    const b = ep('b2', 'bob in paris');

    test('miss on empty cache returns hit=false', () => {
        const s = seedState([a, b]);
        const r = tier0(s, 'alice');
        expect(r.hit).toBe(false);
        expect(r.entries).toEqual([]);
        expect(r.state).toBe(s);
    });

    test('hit after recordTier0 returns cached entries', () => {
        let s = seedState([a, b]);
        s = recordTier0(s, 'Alice', [a]);
        const r = tier0(s, 'alice');
        expect(r.hit).toBe(true);
        expect(r.entries).toHaveLength(1);
        expect(r.entries[0].id).toBe('a1');
    });

    test('hit is case- and trim-insensitive', () => {
        let s = seedState([a]);
        s = recordTier0(s, '  ALICE  ', [a]);
        expect(tier0(s, 'alice').hit).toBe(true);
        expect(tier0(s, 'Alice').hit).toBe(true);
        expect(tier0(s, 'ALICE ').hit).toBe(true);
    });

    test('cached ids whose entries are missing are silently skipped', () => {
        let s = seedState([a, b]);
        s = recordTier0(s, 'pair', [a, b]);
        delete s.entries['b2'];
        const r = tier0(s, 'pair');
        expect(r.hit).toBe(true);
        expect(r.entries.map(e => e.id)).toEqual(['a1']);
    });

    test('cache hit preserves entry order from recordTier0', () => {
        let s = seedState([a, b]);
        s = recordTier0(s, 'both', [b, a]);
        expect(tier0(s, 'both').entries.map(e => e.id)).toEqual(['b2', 'a1']);
    });
});

describe('recordTier0', () => {
    test('is pure (returns new state, does not mutate input)', () => {
        const s = seedState([ep('a1', 'alice')]);
        const before = structuredClone(s);
        const after = recordTier0(s, 'alice', [s.entries['a1']]);
        expect(s).toEqual(before);
        expect(after).not.toBe(s);
        expect(after.tierCaches.exact).not.toBe(s.tierCaches.exact);
    });
});

describe('invalidateTier0Cache', () => {
    test('clears all exact cache entries, returns new state', () => {
        let s = seedState([ep('a1', 'alice')]);
        s = recordTier0(s, 'q1', [s.entries['a1']]);
        s = recordTier0(s, 'q2', [s.entries['a1']]);
        const cleared = invalidateTier0Cache(s);
        expect(Object.keys(cleared.tierCaches.exact)).toHaveLength(0);
        expect(cleared).not.toBe(s);
        // Other state untouched
        expect(cleared.entries).toEqual(s.entries);
        expect(cleared.tierCaches.fuzzy).toEqual(s.tierCaches.fuzzy);
    });

    test('no-op (new object) on already-empty cache', () => {
        const s = seedState([]);
        const cleared = invalidateTier0Cache(s);
        expect(cleared.tierCaches.exact).toEqual({});
    });
});
```

### Implementation

```javascript
/**
 * Tier 0 — exact query cache. Hash of normalized (trim+lowercase) query →
 * entry id list. Hit returns in <1ms (single Map lookup + deref). Invalidated
 * on long-term writes from Phase 6's consolidate(); NOT invalidated on
 * working-buffer appends (the prepend runs downstream of this cache).
 *
 * @module retrieval/tier0-exact
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

/**
 * @typedef {{
 *   hit: boolean,
 *   entries: import('../core/schema.js').Entry[],
 *   state: import('../core/schema.js').State,
 * }} Tier0Result
 */

/**
 * Normalize a query for cache keying. Trim + lowercase. Internal whitespace
 * is preserved so Tier 1's token-set construction sees the same shape.
 *
 * @param {string} q
 * @returns {string}
 */
export function normalizeQuery(q) {
    if (typeof q !== 'string') {
        throw new Error(`normalizeQuery: q must be a string, got ${typeof q}`);
    }
    return q.trim().toLowerCase();
}

/**
 * FNV-1a 32-bit hash of a string. 8-char lowercase hex. Collision-safe
 * enough for a per-chat cache; not cryptographic.
 *
 * @param {string} s
 * @returns {string}
 */
export function hashQuery(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** @param {string} q */
function keyFor(q) {
    return hashQuery(normalizeQuery(q));
}

/**
 * Look up a query in the exact cache.
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @returns {Tier0Result}
 */
export function tier0(state, query) {
    const key = keyFor(query);
    const ids = state.tierCaches.exact[key];
    if (!ids || ids.length === 0) {
        return { hit: false, entries: [], state };
    }
    const entries = [];
    for (const id of ids) {
        const e = state.entries[id];
        if (e) entries.push(e);
    }
    return { hit: true, entries, state };
}

/**
 * Record a resolved query's id list in the exact cache. Called by the ladder
 * when any tier 1+ resolves. Pure—returns a new state.
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @param {import('../core/schema.js').Entry[]} entries
 * @returns {import('../core/schema.js').State}
 */
export function recordTier0(state, query, entries) {
    const key = keyFor(query);
    return {
        ...state,
        tierCaches: {
            ...state.tierCaches,
            exact: {
                ...state.tierCaches.exact,
                [key]: entries.map(e => e.id),
            },
        },
    };
}

/**
 * Drop the entire exact cache. Phase 6's consolidate() calls this inside
 * the write lock after any long-term mutation (new episodic entry, edge
 * write, importance bump). Pure—returns a new state.
 *
 * @param {import('../core/schema.js').State} state
 * @returns {import('../core/schema.js').State}
 */
export function invalidateTier0Cache(state) {
    return {
        ...state,
        tierCaches: {
            ...state.tierCaches,
            exact: {},
        },
    };
}
```

### Steps

1. Write test file (TDD).
2. Run — all fail with module-not-found.
3. Implement `tier0-exact.js`.
4. Tests pass.
5. Lint, typecheck green.
6. Commit: `feat(retrieval): add Tier 0 exact-query cache with invalidation hook`.

Expected: ~15 new tests.

---

## Task 3: Tier 1 — Jaccard fuzzy over recent queries

**Objective:** Land `src/retrieval/tier1-fuzzy.js`. Compare the incoming query's token set against cached recent-query token sets in `state.tierCaches.fuzzy`; on any match ≥ `FUZZY_JACCARD_THRESHOLD` (0.6), return the cached entries for the closest match. This is the "near-duplicate query" path — spec §5.

**Files:**
- Create: `src/retrieval/tier1-fuzzy.js`
- Create: `tests/unit/retrieval/tier1-fuzzy.test.js`

### Behavior

Cache shape in `state.tierCaches.fuzzy`: `{ [tokenSetKey: string]: string[] /* entry ids */ }`. Key construction: sort unique tokens, join with ` `. Example: query `"alice and bob"` → tokens `['alice', 'bob']` (tokenizer drops "and" as <2 chars? no, "and" is 3 chars — kept) → `['alice', 'and', 'bob']` → sorted → key `"alice and bob"`. (Internal whitespace in keys is fine; the key is a Map/object lookup, not parsed.)

Wait — tokenizer keeps ≥2-char tokens per Phase 3 `bm25.tokenize`. "and" survives. That's fine: we want Jaccard to reflect every content word the tokenizer considers meaningful.

API:
- `tier1(state, query) → { hit: boolean, entries: Entry[], state: State }` — on hit, dereferences ids from `state.entries` (missing ids skipped). On miss, `entries: []`.
- `recordTier1(state, query, entries) → State` — pure; stores the sorted-token-set key.
- Uses `tokenize` from `./bm25.js`.

### Algorithm

```
tokens = sort(unique(tokenize(query)))
if tokens.length === 0: return miss

bestJaccard = 0
bestIds = null
for each [cachedKey, cachedIds] in state.tierCaches.fuzzy:
    cachedTokens = cachedKey.split(' ')
    j = jaccard(tokens, cachedTokens)
    if j > bestJaccard:
        bestJaccard = j
        bestIds = cachedIds

if bestJaccard >= FUZZY_JACCARD_THRESHOLD:
    return { hit: true, entries: deref(bestIds) }
return miss
```

Jaccard: `|A ∩ B| / |A ∪ B|` over token sets. O(n+m) via Set.

### Test

```javascript
import {
    tier1,
    recordTier1,
    jaccard,
    tokenSetKey,
} from '../../../src/retrieval/tier1-fuzzy.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function seedState(entries = []) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    return s;
}

function ep(id, content) {
    const e = createEntry({
        scope: 'episodic', content, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...e, id };
}

describe('jaccard', () => {
    test('identical sets → 1.0', () => {
        expect(jaccard(['a', 'b'], ['a', 'b'])).toBeCloseTo(1.0, 6);
    });

    test('disjoint sets → 0.0', () => {
        expect(jaccard(['a'], ['b'])).toBe(0);
    });

    test('half overlap → 1/3', () => {
        // {a,b} ∩ {b,c} = {b}; ∪ = {a,b,c}; 1/3
        expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 6);
    });

    test('empty sets → 0.0 (not NaN)', () => {
        expect(jaccard([], [])).toBe(0);
        expect(jaccard(['a'], [])).toBe(0);
    });

    test('duplicates in input treated as set members', () => {
        expect(jaccard(['a', 'a', 'b'], ['a', 'b'])).toBeCloseTo(1.0, 6);
    });
});

describe('tokenSetKey', () => {
    test('deduplicates and sorts tokens', () => {
        expect(tokenSetKey('Alice and Bob and Alice')).toBe('alice and bob');
    });

    test('drops <2-char tokens (tokenizer contract)', () => {
        expect(tokenSetKey('a bc d ef')).toBe('bc ef');
    });

    test('empty/whitespace query → empty string', () => {
        expect(tokenSetKey('')).toBe('');
        expect(tokenSetKey('   ')).toBe('');
    });
});

describe('tier1', () => {
    const a = ep('a1', 'Alice lives in Marseille');
    const b = ep('b2', 'Bob works in Paris');

    test('miss when cache empty', () => {
        const s = seedState([a, b]);
        const r = tier1(s, 'Alice in Marseille');
        expect(r.hit).toBe(false);
    });

    test('hit on identical token set (Jaccard 1.0)', () => {
        let s = seedState([a, b]);
        s = recordTier1(s, 'alice marseille location', [a]);
        const r = tier1(s, 'location of alice in marseille');
        // tokens: {alice, marseille, location} == {location, alice, marseille, in, of} ?
        // Actually: first has {alice, marseille, location}; second has {alice, marseille, location, in, of}
        // Wait "in" and "of" are 2 chars — kept. Jaccard = 3/5 = 0.6 — exactly at threshold.
        expect(r.hit).toBe(true);
        expect(r.entries[0].id).toBe('a1');
    });

    test('hit on token set above threshold', () => {
        let s = seedState([a]);
        s = recordTier1(s, 'alice marseille', [a]);
        // Query tokens: {alice, marseille} — Jaccard 1.0 with cache
        const r = tier1(s, 'Alice Marseille');
        expect(r.hit).toBe(true);
    });

    test('miss on token set below threshold', () => {
        let s = seedState([a, b]);
        s = recordTier1(s, 'alice marseille', [a]);
        // Query: {bob, paris} — disjoint — Jaccard 0
        const r = tier1(s, 'bob paris');
        expect(r.hit).toBe(false);
    });

    test('picks the highest-Jaccard cache entry', () => {
        let s = seedState([a, b]);
        s = recordTier1(s, 'alice paris', [b]);          // partial
        s = recordTier1(s, 'alice marseille', [a]);      // exact for our query
        const r = tier1(s, 'alice marseille');
        expect(r.hit).toBe(true);
        expect(r.entries[0].id).toBe('a1');
    });

    test('empty-tokens query → miss (no false positive against empty cached entries)', () => {
        let s = seedState([a]);
        s = recordTier1(s, '', [a]);
        const r = tier1(s, '');
        expect(r.hit).toBe(false);
    });

    test('missing entry ids in cache are silently skipped', () => {
        let s = seedState([a, b]);
        s = recordTier1(s, 'alice bob', [a, b]);
        delete s.entries['b2'];
        const r = tier1(s, 'alice bob');
        expect(r.hit).toBe(true);
        expect(r.entries.map(e => e.id)).toEqual(['a1']);
    });
});

describe('recordTier1', () => {
    test('is pure', () => {
        const s = seedState([ep('a1', 'x')]);
        const before = structuredClone(s);
        const after = recordTier1(s, 'x', [s.entries['a1']]);
        expect(s).toEqual(before);
        expect(after.tierCaches.fuzzy).not.toBe(s.tierCaches.fuzzy);
    });

    test('empty-token query is not recorded (no-op, returns new state for consistency)', () => {
        const s = seedState([]);
        const after = recordTier1(s, '', []);
        expect(Object.keys(after.tierCaches.fuzzy)).toHaveLength(0);
    });
});
```

### Implementation

```javascript
/**
 * Tier 1 — Jaccard fuzzy over recent query token sets. Catches near-
 * duplicate queries ("where does alice live" ≈ "alice's location") without
 * re-running BM25. <5ms: O(cacheSize × avgTokens).
 *
 * @module retrieval/tier1-fuzzy
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

import { RETRIEVAL } from '../core/constants.js';
import { tokenize } from './bm25.js';

const { FUZZY_JACCARD_THRESHOLD } = RETRIEVAL;

/**
 * Jaccard similarity over token sets. Duplicates are ignored (set semantics).
 * Both empty → 0 (not NaN).
 *
 * @param {string[]} aTokens
 * @param {string[]} bTokens
 * @returns {number} in [0, 1]
 */
export function jaccard(aTokens, bTokens) {
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Canonical cache key for a query: sorted unique tokens joined by single
 * spaces. Round-trips via `key.split(' ')` back to the token set.
 *
 * @param {string} query
 * @returns {string}
 */
export function tokenSetKey(query) {
    const toks = Array.from(new Set(tokenize(query))).sort();
    return toks.join(' ');
}

/**
 * @typedef {{
 *   hit: boolean,
 *   entries: import('../core/schema.js').Entry[],
 *   state: import('../core/schema.js').State,
 * }} Tier1Result
 */

/**
 * Look up the query's token set against cached recent queries. Returns the
 * highest-Jaccard match's entries if Jaccard ≥ threshold, otherwise miss.
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @returns {Tier1Result}
 */
export function tier1(state, query) {
    const qTokens = Array.from(new Set(tokenize(query)));
    if (qTokens.length === 0) {
        return { hit: false, entries: [], state };
    }

    /** @type {string[] | null} */
    let bestIds = null;
    let bestJ = 0;
    for (const [cachedKey, ids] of Object.entries(state.tierCaches.fuzzy)) {
        if (cachedKey.length === 0) continue;   // don't match against recorded empties
        const cachedTokens = cachedKey.split(' ');
        const j = jaccard(qTokens, cachedTokens);
        if (j > bestJ) {
            bestJ = j;
            bestIds = ids;
        }
    }

    if (bestJ < FUZZY_JACCARD_THRESHOLD || !bestIds) {
        return { hit: false, entries: [], state };
    }

    const entries = [];
    for (const id of bestIds) {
        const e = state.entries[id];
        if (e) entries.push(e);
    }
    return { hit: true, entries, state };
}

/**
 * Record a resolved query's entries under its token-set key. Empty-token
 * queries are a no-op (returns a new state object for API consistency).
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} query
 * @param {import('../core/schema.js').Entry[]} entries
 * @returns {import('../core/schema.js').State}
 */
export function recordTier1(state, query, entries) {
    const key = tokenSetKey(query);
    if (key.length === 0) {
        return { ...state };
    }
    return {
        ...state,
        tierCaches: {
            ...state.tierCaches,
            fuzzy: {
                ...state.tierCaches.fuzzy,
                [key]: entries.map(e => e.id),
            },
        },
    };
}
```

### Steps

1. Write test file (TDD).
2. Run — fail with module-not-found.
3. **Sanity check the threshold-boundary test first.** The "exactly at threshold" case in test 2 relies on 3/5 = 0.6 = threshold. Verify the tokens ARE what we expect (`tokenize('location of alice in marseille')` → `['location', 'of', 'alice', 'in', 'marseille']`, 5 distinct tokens; `tokenize('alice marseille location')` → `['alice', 'marseille', 'location']`, 3). `>= 0.6` passes; if we wrote `> 0.6` in the threshold check it'd fail. Keep `>=`.
4. Implement.
5. All tests pass.
6. Lint, typecheck green.
7. Commit: `feat(retrieval): add Tier 1 Jaccard fuzzy over recent queries`.

Expected: ~17 new tests.

---

## Task 4: Tier 2 — BM25 wrapper with exit condition

**Objective:** Land `src/retrieval/tier2-bm25.js`. Thin orchestration around the Phase 3 primitives: rebuild index, query BM25, score under the active scorer, check exit condition (`top ≥ τ_confidence AND (top − #2) ≥ τ_gap`), filter zero-scored candidates. Returns `{ hit, scored }` — the ladder decides what to do with a non-hit (pass through to Tier 3 stub).

**Files:**
- Create: `src/retrieval/tier2-bm25.js`
- Create: `tests/unit/retrieval/tier2-bm25.test.js`

### Behavior

```
tier2(state, query, { now, intent, k = 10 }):
  entries = non-working entries from state.entries
  index = buildIndex(entries)
  raw = query(index, query, k)                   # [{entry, bm25}]
  scorer = getScorer()
  scored = raw
    .map(r => ({ entry: r.entry, bm25: r.bm25, score: scorer(r.entry, query, {now, bm25: r.bm25, intent}) }))
    .filter(r => r.score > 0)                    # drop zero-scored per decision 7
    .sort((a, b) => b.score - a.score)           # defensive re-sort; scorer may reorder vs bm25

  if scored.length === 0: return { hit: false, scored: [] }

  top = scored[0].score
  second = scored[1]?.score ?? 0
  gap = top - second
  hit = top >= TIER2_TAU_CONFIDENCE && gap >= TIER2_TAU_GAP

  return { hit, scored }
```

**Index rebuild cost**: rebuilt every call. Spec §12.1 flagged this as "need to measure at 1K / 10K entries; if unacceptable, cache." Phase 9 benchmarking will measure. For v2.0 we rebuild — simpler, correct, and the ladder short-circuits at Tier 0/1 on repeat queries anyway.

**Working buffer exclusion**: Tier 2 indexes only `scope !== 'working'`. Working entries are prepended by the ladder via `prependWorking`, not scored.

### Test

```javascript
import { tier2 } from '../../../src/retrieval/tier2-bm25.js';
import { _resetScorerForTests, registerScorer, setScorer } from '../../../src/retrieval/scorer.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function ep(id, content, subject = null, tags = [], overrides = {}) {
    const e = createEntry({
        scope: 'episodic', content, subject, tags,
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...e, id, ...overrides };
}

function state(entries) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    return s;
}

const now = new Date('2026-04-20T12:00:00Z');

describe('tier2', () => {
    afterEach(() => _resetScorerForTests());

    test('empty corpus → no hit, empty scored', () => {
        const r = tier2(state([]), 'anything', { now, intent: 'factual' });
        expect(r.hit).toBe(false);
        expect(r.scored).toEqual([]);
    });

    test('scored results are sorted by score descending', () => {
        const s = state([
            ep('a', 'alice lives in marseille', 'alice', ['location']),
            ep('b', 'bob lives in paris', 'bob', ['location']),
            ep('c', 'cats are cute'),
        ]);
        const r = tier2(s, 'alice marseille', { now, intent: 'factual' });
        expect(r.scored.length).toBeGreaterThan(0);
        expect(r.scored[0].entry.id).toBe('a');
        for (let i = 1; i < r.scored.length; i++) {
            expect(r.scored[i - 1].score).toBeGreaterThanOrEqual(r.scored[i].score);
        }
    });

    test('hit=true when top score ≥ τ_conf AND gap ≥ τ_gap', () => {
        // Force hit via a custom scorer that produces wide separation.
        registerScorer('wide', () => 0); // placeholder — replaced below
        const widerScorer = (entry) => entry.id === 'a' ? 10.0 : 0.5;
        _resetScorerForTests();
        registerScorer('wide', widerScorer);
        setScorer('wide');

        const s = state([
            ep('a', 'alice marseille', 'alice', ['location']),
            ep('b', 'unrelated content'),
        ]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.hit).toBe(true);
        expect(r.scored[0].entry.id).toBe('a');
    });

    test('hit=false when top score below τ_confidence', () => {
        const lowScorer = () => 0.5; // flat, all below τ_conf=2.0
        registerScorer('low', lowScorer);
        setScorer('low');
        const s = state([
            ep('a', 'alice marseille'),
            ep('b', 'bob paris'),
        ]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.hit).toBe(false);
        // Non-hit still returns scored list (ladder may still use it as Tier 3 seeds)
        expect(r.scored.length).toBeGreaterThan(0);
    });

    test('hit=false when gap below τ_gap', () => {
        const flatScorer = () => 5.0; // all 5.0 — above τ_conf but gap=0
        registerScorer('flat', flatScorer);
        setScorer('flat');
        const s = state([
            ep('a', 'alice'),
            ep('b', 'alice'),
        ]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.hit).toBe(false);
    });

    test('hit=true with a single result (no #2 to gap against)', () => {
        const highScorer = () => 10.0;
        registerScorer('high', highScorer);
        setScorer('high');
        const s = state([ep('a', 'alice marseille')]);
        const r = tier2(s, 'nothing-in-corpus', { now, intent: 'factual' });
        // If BM25 returns a hit, single result → gap = top - 0 = 10.0 ≥ 0.5 — hit
        // If BM25 returns nothing, no hit. Accept either but document in comment.
        if (r.scored.length === 1) {
            expect(r.hit).toBe(true);
        } else {
            expect(r.hit).toBe(false);
        }
    });

    test('zero-scored candidates are filtered out before gap check', () => {
        // Custom scorer that zeros entry 'a'
        const zeroForA = (entry) => entry.id === 'a' ? 0 : 3.0;
        registerScorer('zeroForA', zeroForA);
        setScorer('zeroForA');
        const s = state([
            ep('a', 'alice marseille'),
            ep('b', 'alice marseille'),
        ]);
        const r = tier2(s, 'alice marseille', { now, intent: 'factual' });
        expect(r.scored.find(s => s.entry.id === 'a')).toBeUndefined();
    });

    test('working-scope entries are NOT indexed by Tier 2', () => {
        const working = ep('w', 'alice marseille');
        working.scope = 'working';
        const s = state([working, ep('a', 'alice marseille')]);
        const r = tier2(s, 'alice', { now, intent: 'factual' });
        expect(r.scored.every(s => s.entry.id !== 'w')).toBe(true);
    });
});
```

### Implementation

```javascript
/**
 * Tier 2 — BM25 over all non-working entries, rescored under the active
 * scorer. Returns { hit, scored }. The ladder decides what to do on miss
 * (pass scored as Tier 3 seeds when Phase 5 lands, or fall through to Floor).
 *
 * @module retrieval/tier2-bm25
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

import { RETRIEVAL } from '../core/constants.js';
import { buildIndex, query as bm25Query } from './bm25.js';
import { getScorer } from './scorer.js';

const { TIER2_TAU_CONFIDENCE, TIER2_TAU_GAP } = RETRIEVAL;

/**
 * @typedef {{
 *   entry: import('../core/schema.js').Entry,
 *   bm25: number,
 *   score: number,
 * }} ScoredEntry
 */

/**
 * @typedef {{ hit: boolean, scored: ScoredEntry[] }} Tier2Result
 */

/**
 * @param {import('../core/schema.js').State} state
 * @param {string} queryStr
 * @param {{ now: Date, intent: 'factual'|'relational'|'temporal', k?: number }} ctx
 * @returns {Tier2Result}
 */
export function tier2(state, queryStr, ctx) {
    const { now, intent, k = 10 } = ctx;

    /** @type {import('../core/schema.js').Entry[]} */
    const entries = [];
    for (const e of Object.values(state.entries)) {
        if (e.scope !== 'working') entries.push(e);
    }
    if (entries.length === 0) {
        return { hit: false, scored: [] };
    }

    const index = buildIndex(entries);
    const raw = bm25Query(index, queryStr, k);
    if (raw.length === 0) {
        return { hit: false, scored: [] };
    }

    const scorer = getScorer();
    const scored = raw
        .map(r => ({
            entry: r.entry,
            bm25: r.bm25,
            score: scorer(r.entry, queryStr, { now, bm25: r.bm25, intent }),
        }))
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
        return { hit: false, scored: [] };
    }

    const top = scored[0].score;
    const second = scored[1]?.score ?? 0;
    const gap = top - second;
    const hit = top >= TIER2_TAU_CONFIDENCE && gap >= TIER2_TAU_GAP;

    return { hit, scored };
}
```

### Steps

1. Write tests.
2. Run — fail.
3. Implement.
4. Tests pass.
5. Lint, typecheck green.
6. Commit: `feat(retrieval): add Tier 2 BM25 wrapper with exit condition per spec §5`.

Expected: ~7 new tests.

---

## Task 5: Floor — pure fallback

**Objective:** Land `src/retrieval/floor.js`. Top-K entries by `recency × importance × maturity_boost` (no BM25). Runs only when all tiers above yield empty.

**Files:**
- Create: `src/retrieval/floor.js`
- Create: `tests/unit/retrieval/floor.test.js`

### Behavior

```
floor(state, { now, k = 5 }):
  candidates = non-working entries
  if candidates.length === 0: return []
  for each entry: score = recencyAt(now, createdAt) × (1 + importance/100) × maturityBoost(maturity)
  sort descending, take top k
  return ScoredEntry[] with { entry, bm25: 0, score }
```

No BM25 factor — Floor's job is "something reasonable when search failed." Fresh, important, mature entries surface.

Floor returns `ScoredEntry[]` for uniform shape with Tier 2's output — the ladder can merge/prepend uniformly.

### Test

```javascript
import { floor } from '../../../src/retrieval/floor.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function ep(id, overrides = {}) {
    const base = createEntry({
        scope: 'episodic', content: id, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...base, id, ...overrides };
}

function state(entries) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    return s;
}

const now = new Date('2026-04-20T12:00:00Z');

describe('floor', () => {
    test('empty state → empty array', () => {
        expect(floor(state([]), { now })).toEqual([]);
    });

    test('sorts by recency × importance × maturity_boost descending', () => {
        const fresh = ep('fresh', {
            lifecycle: { importance: 50, maturity: 'draft', createdAt: '2026-04-20T12:00:00Z', updatedAt: '2026-04-20T12:00:00Z', accessCount: 0, updateCount: 0 },
        });
        const old = ep('old', {
            lifecycle: { importance: 50, maturity: 'draft', createdAt: '2025-04-20T12:00:00Z', updatedAt: '2025-04-20T12:00:00Z', accessCount: 0, updateCount: 0 },
        });
        const result = floor(state([old, fresh]), { now });
        expect(result[0].entry.id).toBe('fresh');
        expect(result[1].entry.id).toBe('old');
    });

    test('core maturity outranks draft at equal importance + age', () => {
        const core = ep('c', {
            lifecycle: { importance: 50, maturity: 'core', createdAt: '2026-04-20T12:00:00Z', updatedAt: '2026-04-20T12:00:00Z', accessCount: 0, updateCount: 0 },
        });
        const draft = ep('d', {
            lifecycle: { importance: 50, maturity: 'draft', createdAt: '2026-04-20T12:00:00Z', updatedAt: '2026-04-20T12:00:00Z', accessCount: 0, updateCount: 0 },
        });
        expect(floor(state([draft, core]), { now })[0].entry.id).toBe('c');
    });

    test('respects k parameter (truncates to top k)', () => {
        const entries = Array.from({ length: 10 }, (_, i) => ep(`e${i}`));
        const result = floor(state(entries), { now, k: 3 });
        expect(result).toHaveLength(3);
    });

    test('defaults k to 5', () => {
        const entries = Array.from({ length: 10 }, (_, i) => ep(`e${i}`));
        expect(floor(state(entries), { now })).toHaveLength(5);
    });

    test('excludes working-scope entries', () => {
        const w = ep('w'); w.scope = 'working';
        const e = ep('e');
        const result = floor(state([w, e]), { now });
        expect(result.every(r => r.entry.id !== 'w')).toBe(true);
    });

    test('ScoredEntry shape has bm25=0 (Floor has no BM25 factor)', () => {
        const result = floor(state([ep('a')]), { now });
        expect(result[0].bm25).toBe(0);
        expect(result[0].score).toBeGreaterThan(0);
    });
});
```

### Implementation

```javascript
/**
 * Floor — pure fallback. Returns top-K entries by
 * recency × (1 + importance/100) × maturity_boost when all tiers above
 * yielded empty results. No BM25 factor; this is "the last thing we can
 * still say something sensible about."
 *
 * @module retrieval/floor
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

import { recencyAt, maturityBoost } from '../lifecycle/index.js';

/**
 * @param {import('../core/schema.js').State} state
 * @param {{ now: Date, k?: number }} ctx
 * @returns {import('./tier2-bm25.js').ScoredEntry[]}
 */
export function floor(state, ctx) {
    const { now, k = 5 } = ctx;
    const scored = [];
    for (const entry of Object.values(state.entries)) {
        if (entry.scope === 'working') continue;
        const { importance, maturity, createdAt } = entry.lifecycle;
        const score = recencyAt(now, createdAt)
            * (1 + importance / 100)
            * maturityBoost(maturity);
        scored.push({ entry, bm25: 0, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}
```

### Steps

1. Tests → fail.
2. Implement.
3. Tests pass.
4. Lint, typecheck green.
5. Commit: `feat(retrieval): add Floor fallback tier per spec §5`.

Expected: ~7 new tests.

---

## Task 6: Trace logger

**Objective:** Land `src/retrieval/trace.js`. Pure ring-buffer append into `state.runtime.traces`, capped at `TRACE_BUFFER_CAP = 128`. Shape per spec §9.1, extended with `scorerId` from the Task 1 registry.

**Files:**
- Create: `src/retrieval/trace.js`
- Create: `tests/unit/retrieval/trace.test.js`

### Shape

```typescript
type Trace = {
    timestamp: string;             // ISO 8601
    query: string;                 // raw (not normalized) query
    classifier: 'factual' | 'relational' | 'temporal';
    tierResolved: 0 | 1 | 2 | 3 | 'floor';
    perTier: {
        '0'?: { id: string }[] | null;          // Tier 0 returns ids only; no scores
        '1'?: { id: string }[] | null;          // Tier 1 ditto
        '2'?: { id: string, bm25: number, score: number }[] | null;
        '3'?: { id: string, bm25: number, score: number }[] | null;  // Phase 5
    };
    finalRanking: string[];        // entry ids, working-prepended order
    scorerId: string;
};
```

### API

```
logTrace(state, trace) → state   // pure, returns new state with trace appended to ring
buildTrace(opts)       → Trace   // helper, used by ladder.js to construct traces
```

### Test

```javascript
import { logTrace, buildTrace } from '../../../src/retrieval/trace.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { TRACE_BUFFER_CAP } from '../../../src/core/constants.js';

describe('buildTrace', () => {
    test('assembles a well-formed trace', () => {
        const t = buildTrace({
            timestamp: '2026-04-20T12:00:00.000Z',
            query: 'alice',
            classifier: 'factual',
            tierResolved: 2,
            perTier: { '2': [{ id: 'a1', bm25: 0.8, score: 1.2 }] },
            finalRanking: ['a1'],
            scorerId: 'default',
        });
        expect(t).toEqual({
            timestamp: '2026-04-20T12:00:00.000Z',
            query: 'alice',
            classifier: 'factual',
            tierResolved: 2,
            perTier: { '2': [{ id: 'a1', bm25: 0.8, score: 1.2 }] },
            finalRanking: ['a1'],
            scorerId: 'default',
        });
    });
});

describe('logTrace', () => {
    function trace(ix = 0) {
        return buildTrace({
            timestamp: `2026-04-20T12:00:${String(ix).padStart(2, '0')}.000Z`,
            query: `q${ix}`,
            classifier: 'factual',
            tierResolved: 'floor',
            perTier: {},
            finalRanking: [],
            scorerId: 'default',
        });
    }

    test('appends to empty ring', () => {
        const s = createEmptyState();
        const next = logTrace(s, trace(1));
        expect(next.runtime.traces).toHaveLength(1);
        expect(next.runtime.traces[0].query).toBe('q1');
    });

    test('is pure (returns new state)', () => {
        const s = createEmptyState();
        const before = structuredClone(s);
        logTrace(s, trace(1));
        expect(s).toEqual(before);
    });

    test('evicts oldest when at cap', () => {
        let s = createEmptyState();
        for (let i = 0; i < TRACE_BUFFER_CAP + 5; i++) {
            s = logTrace(s, trace(i));
        }
        expect(s.runtime.traces).toHaveLength(TRACE_BUFFER_CAP);
        // Oldest should be i=5; newest i = CAP+4
        expect(s.runtime.traces[0].query).toBe('q5');
        expect(s.runtime.traces[TRACE_BUFFER_CAP - 1].query).toBe(`q${TRACE_BUFFER_CAP + 4}`);
    });

    test('preserves FIFO order', () => {
        let s = createEmptyState();
        for (let i = 0; i < 3; i++) s = logTrace(s, trace(i));
        expect(s.runtime.traces.map(t => t.query)).toEqual(['q0', 'q1', 'q2']);
    });
});
```

### Implementation

```javascript
/**
 * Retrieval trace logger. Pure ring-buffer append into state.runtime.traces.
 * Cap = TRACE_BUFFER_CAP (128). Each retrieval writes exactly one trace;
 * exportable as JSONL from the Memory Viewer Traces tab (Phase 8).
 *
 * @module retrieval/trace
 * @see docs/specs/2026-04-20-starmem-v2-design.md §9.1
 */

import { TRACE_BUFFER_CAP } from '../core/constants.js';

/**
 * @typedef {{
 *   timestamp: string,
 *   query: string,
 *   classifier: 'factual' | 'relational' | 'temporal',
 *   tierResolved: 0 | 1 | 2 | 3 | 'floor',
 *   perTier: Record<string, unknown>,
 *   finalRanking: string[],
 *   scorerId: string,
 * }} Trace
 */

/**
 * Identity-style helper for type-safe trace construction. Zero runtime cost;
 * its job is to give callers a stable call site for future shape evolution.
 *
 * @param {Trace} t
 * @returns {Trace}
 */
export function buildTrace(t) {
    return t;
}

/**
 * Append a trace to state.runtime.traces, evicting the oldest when at cap.
 * Pure—returns a new state.
 *
 * @param {import('../core/schema.js').State} state
 * @param {Trace} trace
 * @returns {import('../core/schema.js').State}
 */
export function logTrace(state, trace) {
    const next = [...state.runtime.traces, trace];
    while (next.length > TRACE_BUFFER_CAP) {
        next.shift();
    }
    return {
        ...state,
        runtime: {
            ...state.runtime,
            traces: next,
        },
    };
}
```

### Steps

1. Tests → fail.
2. Implement.
3. Pass.
4. Lint, typecheck green.
5. Commit: `feat(retrieval): add trace logger with 128-cap ring buffer per spec §9.1`.

Expected: ~5 new tests.

---

## Task 7: Ladder orchestrator

**Objective:** Land `src/retrieval/ladder.js`. Compose everything: classify, try tiers in order with short-circuit, call `applyAccessEvent` on final returned entries, prepend working buffer, emit a trace. Tier 3 is an identity stub.

**Files:**
- Create: `src/retrieval/ladder.js`
- Create: `tests/integration/retrieval/ladder.test.js`

### Algorithm

```
retrieve(state, queryStr, { now = new Date(), k = 5 } = {}):
    classifier = classify(queryStr)

    // Tier 0 — exact cache
    t0 = tier0(state, queryStr)
    if t0.hit:
        final = applyAccessEventsToReturned(state, t0.entries)
        prepended = prependWorking(wrapZero(final.entries), workingEntriesOf(state), now)
        trace = buildTrace({
            timestamp: now.toISOString(), query: queryStr, classifier,
            tierResolved: 0,
            perTier: { '0': t0.entries.map(e => ({ id: e.id })) },
            finalRanking: prepended.map(r => r.entry.id),
            scorerId: getScorerId(),
        })
        return { entries: prepended.map(r => r.entry), tierResolved: 0, trace, state: logTrace(final.state, trace) }

    // Tier 1 — Jaccard fuzzy
    t1 = tier1(state, queryStr)
    if t1.hit:
        // Record into Tier 0 cache so next call hits Tier 0
        let s2 = recordTier0(state, queryStr, t1.entries)
        final = applyAccessEventsToReturned(s2, t1.entries)
        prepended = prependWorking(wrapZero(final.entries), workingEntriesOf(state), now)
        trace = buildTrace({... tierResolved: 1, perTier: { '1': ids }, ...})
        return { entries: prepended..., tierResolved: 1, trace, state: logTrace(final.state, trace) }

    // Tier 2 — BM25
    t2 = tier2(state, queryStr, { now, intent: classifier, k: 10 })
    if t2.hit:
        topK = t2.scored.slice(0, k)
        // Tier 3 stub: passthrough
        t3 = tier3Stub(state, topK.map(r => r.entry), queryStr, classifier)
        // Record caches for next call
        let s2 = recordTier0(state, queryStr, topK.map(r => r.entry))
        s2 = recordTier1(s2, queryStr, topK.map(r => r.entry))
        final = applyAccessEventsToReturned(s2, topK.map(r => r.entry))
        prepended = prependWorking(topK, workingEntriesOf(state), now)
        trace = buildTrace({... tierResolved: 2, perTier: { '2': scoredDetails, '3': null }, ...})
        return {..., tierResolved: 2, ..., state: logTrace(final.state, trace)}

    // Tier 2 ran but no hit → fall through with Tier 2's scored as seeds for Tier 3
    // Tier 3 stub returns its input unchanged; treat Tier 2's scored[] as the answer if non-empty
    if t2.scored.length > 0:
        topK = t2.scored.slice(0, k)
        let s2 = recordTier0(state, queryStr, topK.map(r => r.entry))
        s2 = recordTier1(s2, queryStr, topK.map(r => r.entry))
        final = applyAccessEventsToReturned(s2, topK.map(r => r.entry))
        prepended = prependWorking(topK, workingEntriesOf(state), now)
        trace = buildTrace({... tierResolved: 3, perTier: { '2': scoredDetails, '3': sameAs2 }, ...})
        return {..., tierResolved: 3, ..., state: logTrace(final.state, trace)}

    // Floor — pure fallback
    floorResults = floor(state, { now, k })
    // Don't record empty floor results into caches (they're not "answers," they're "the best we could do")
    // BUT: do apply access events if any entries surface, per decision 10
    let s2 = state
    if floorResults.length > 0:
        final = applyAccessEventsToReturned(s2, floorResults.map(r => r.entry))
        s2 = final.state
    prepended = prependWorking(floorResults, workingEntriesOf(state), now)
    trace = buildTrace({... tierResolved: 'floor', perTier: {}, finalRanking: prepended.map(r => r.entry.id) ...})
    return { entries: prepended.map(r => r.entry), tierResolved: 'floor', trace, state: logTrace(s2, trace) }
```

### Helpers

- `tier3Stub(state, seeds, query, intent)` — returns `seeds` unchanged. Phase 5 replaces.
- `applyAccessEventsToReturned(state, entries) → { state, entries }` — per decision 10. Bumps `entry.lifecycle` via `applyAccessEvent`. Returns updated entries and state. **Only called on entries we actually return**, not candidates.
- `workingEntriesOf(state)` — dereferences `state.workingBuffer` ids to `Entry[]`, filters missing.
- `wrapZero(entries)` — maps `Entry[] → ScoredEntry[]` with `bm25: 0, score: 0`. Used for Tier 0/1 hits where we stored ids, not scores.

### Test (integration — runs full ladder)

```javascript
import { retrieve } from '../../../src/retrieval/ladder.js';
import { _resetScorerForTests, registerScorer, setScorer } from '../../../src/retrieval/scorer.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function ep(id, content, subject = null, tags = [], overrides = {}) {
    const base = createEntry({
        scope: 'episodic', content, subject, tags,
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...base, id, ...overrides };
}

function seed(entries, working = []) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    for (const w of working) {
        s.entries[w.id] = { ...w, scope: 'working' };
        s.workingBuffer.push(w.id);
    }
    return s;
}

const now = new Date('2026-04-20T12:00:00Z');

describe('retrieve (ladder integration)', () => {
    afterEach(() => _resetScorerForTests());

    test('fresh chat with empty state → floor returns []', () => {
        const s = createEmptyState();
        const r = retrieve(s, 'anything', { now });
        expect(r.tierResolved).toBe('floor');
        expect(r.entries).toEqual([]);
        expect(r.trace.classifier).toBe('factual');
    });

    test('floor returns top-K by lifecycle when BM25 zeros out', () => {
        const s = seed([ep('a', 'alice')]);
        const r = retrieve(s, 'zzz-not-in-corpus', { now, k: 3 });
        // BM25 returns nothing for 'zzz'; ladder falls to floor
        expect(r.tierResolved).toBe('floor');
        expect(r.entries).toHaveLength(1);
    });

    test('novel query hits Tier 2 or Tier 3 (depending on exit condition)', () => {
        // Force a wide-margin scorer so Tier 2 hit condition is met
        registerScorer('wide', (entry) => entry.id === 'a' ? 10.0 : 0.5);
        setScorer('wide');
        const s = seed([
            ep('a', 'alice lives in marseille', 'alice', ['location']),
            ep('b', 'bob lives in paris', 'bob', ['location']),
        ]);
        const r = retrieve(s, 'alice marseille', { now });
        expect([2, 3]).toContain(r.tierResolved);
        expect(r.entries[0].id).toBe('a');
    });

    test('identical consecutive query hits Tier 0 on second call', () => {
        registerScorer('wide', (entry) => entry.id === 'a' ? 10.0 : 0.5);
        setScorer('wide');
        const s = seed([
            ep('a', 'alice marseille', 'alice', ['location']),
            ep('b', 'bob paris', 'bob', ['location']),
        ]);
        const first = retrieve(s, 'alice marseille', { now });
        const second = retrieve(first.state, 'alice marseille', { now });
        expect(second.tierResolved).toBe(0);
        expect(second.entries[0].id).toBe('a');
    });

    test('near-duplicate query hits Tier 1 on second call', () => {
        registerScorer('wide', (entry) => entry.id === 'a' ? 10.0 : 0.5);
        setScorer('wide');
        const s = seed([
            ep('a', 'alice marseille location', 'alice', ['location']),
            ep('b', 'bob paris', 'bob', ['location']),
        ]);
        const first = retrieve(s, 'alice marseille location', { now });
        // Different token order, same set → Tier 1 Jaccard=1.0
        const second = retrieve(first.state, 'marseille alice location', { now });
        expect(second.tierResolved).toBe(1);
    });

    test('working-buffer entries are prepended to every result', () => {
        registerScorer('wide', () => 10.0);
        setScorer('wide');
        const w = ep('w1', 'working entry content');
        const s = seed([ep('a', 'alice marseille')], [w]);
        const r = retrieve(s, 'alice', { now });
        expect(r.entries[0].id).toBe('w1');
    });

    test('trace is emitted and appended to state.runtime.traces', () => {
        const s = seed([ep('a', 'alice marseille')]);
        const r = retrieve(s, 'alice', { now });
        expect(r.trace).toBeDefined();
        expect(r.trace.scorerId).toBe('default');
        expect(r.state.runtime.traces).toHaveLength(1);
        expect(r.state.runtime.traces[0]).toBe(r.trace);
    });

    test('applyAccessEvent fires for returned entries only', () => {
        registerScorer('wide', (entry) => entry.id === 'a' ? 10.0 : 0.5);
        setScorer('wide');
        const s = seed([
            ep('a', 'alice marseille'),
            ep('b', 'bob paris'),
            ep('c', 'cats'),
        ]);
        const r = retrieve(s, 'alice marseille', { now, k: 1 });
        // 'a' returned; its accessCount bumped. 'b' and 'c' were scored but not returned.
        const returnedId = r.entries[0].id;  // skip working prepend (none here)
        expect(r.state.entries[returnedId].lifecycle.accessCount).toBe(1);
        // Others untouched
        const others = ['a', 'b', 'c'].filter(id => id !== returnedId);
        for (const id of others) {
            expect(r.state.entries[id].lifecycle.accessCount).toBe(0);
        }
    });

    test('Tier 3 stub: when Tier 2 misses exit condition but has results, ladder resolves at Tier 3', () => {
        // Flat scorer — all 1.0, below τ_conf=2.0 and gap=0
        registerScorer('flat', () => 1.0);
        setScorer('flat');
        const s = seed([
            ep('a', 'alice marseille'),
            ep('b', 'alice paris'),
        ]);
        const r = retrieve(s, 'alice', { now });
        expect(r.tierResolved).toBe(3);
        expect(r.entries.length).toBeGreaterThan(0);
    });
});
```

### Steps

1. Write integration test (TDD).
2. Run — fail.
3. Implement `ladder.js` following the algorithm above.
4. Tests pass. This is the phase's integration surface — expect the first pass to fail on at least one test; iterate.
5. Lint, typecheck green.
6. **Review gate:** This is the one task in Phase 4 where `subagent-driven-development`'s review stages should NOT be skipped. Have the reviewer verify (a) `applyAccessEvent` is called at most once per returned entry, (b) Tier 0 records only happen on Tier 1+ hits (not on Floor or initial Tier 0 hits), (c) trace's `perTier` shape matches spec §9.1, (d) working buffer is prepended exactly once, at the end.
7. Commit: `feat(retrieval): add ladder orchestrator with Tier 3 stub per spec §5`.

Expected: ~8 integration tests.

---

## Task 8: Barrel export + Phase 4 retro

**Objective:** Update `src/retrieval/index.js` to re-export the new modules, and append the Phase 4 retro to `ROADMAP.md`.

**Files:**
- Modify: `src/retrieval/index.js`
- Modify: `tests/unit/retrieval/index.test.js`
- Modify: `docs/plans/ROADMAP.md`

### Barrel additions

```javascript
export { tier0, recordTier0, invalidateTier0Cache, normalizeQuery, hashQuery } from './tier0-exact.js';
export { tier1, recordTier1, jaccard, tokenSetKey } from './tier1-fuzzy.js';
export { tier2 } from './tier2-bm25.js';
export { floor } from './floor.js';
export { logTrace, buildTrace } from './trace.js';
export { retrieve } from './ladder.js';
```

Add assertions in `tests/unit/retrieval/index.test.js` for each new export being a function.

### Retro content (append to `docs/plans/ROADMAP.md`)

```markdown
## Phase 4—YYYY-MM-DD

**What shipped:** Tier 0 exact cache (`src/retrieval/tier0-exact.js`, FNV-1a hash of normalized query), Tier 1 Jaccard fuzzy over recent query token sets (`src/retrieval/tier1-fuzzy.js`, θ=0.6), Tier 2 BM25 wrapper with exit condition (`src/retrieval/tier2-bm25.js`, τ_conf=2.0/τ_gap=0.5), Floor fallback (`src/retrieval/floor.js`), trace logger (`src/retrieval/trace.js`, 128-cap ring), scorer registry refactor (`src/retrieval/scorer.js`, string-keyed), ladder orchestrator (`src/retrieval/ladder.js`, Tier 3 stub until Phase 5). N commits this phase plus plan + retro. [TEST COUNT] tests passing across [SUITE COUNT] suites.

**Decisions baked in from 2026-04-20 planning conversation:**

1. τ_confidence=2.0, τ_gap=0.5 — opening values. Phase 9 will tune.
2. TRACE_BUFFER_CAP bumped 100 → 128. Spec §12.4 "make configurable" deferred to Phase 8 settings.
3. Scorer identity via string registry (`registerScorer('id', fn)`), not `.name`. Survives minification and JSONL roundtrip.
4. Tier 0 invalidation: long-term writes only (Phase 6's `consolidate()`). Working-buffer appends do NOT invalidate.
5. Tier 0 keys: FNV-1a of trim+lowercase query.
6. Tier 1 candidate source: recent query token sets, not entry tokens. Spec §5's "near-duplicate queries" reading.
7. Tier 2: zero-scored candidates filtered before gap check.
8. Floor: pure fallback. Runs only when all tiers above yield [].
9. applyAccessEvent: called at ladder level, once per entry in the final returned list.
10. Tier 3 stub: identity passthrough. Phase 5 replaces.

**Surprises:** [fill in live]

**Notes for Phase 5 (Graph + Tier 3):**

- `tier3Stub` in `ladder.js` is the replacement site. Signature: `(state, seeds, queryStr, intent) → ScoredEntry[]`. Phase 5's real `tier3` adopts this signature.
- The ladder currently resolves at Tier 3 when Tier 2 has scored results but misses the exit condition. Phase 5's real Tier 3 should produce reranked results that DO change the ordering vs Tier 2 seeds, otherwise the integration test "Tier 3 changes ordering" will need to be added.
- Traces' `perTier['3']` is currently populated with Tier 2's scored list as a placeholder. Phase 5 should emit its own Tier 3 scored list with different content (beam-search outputs + reranked).
- `recordTier0`/`recordTier1` run on every Tier 2+ hit. Phase 5's Tier 3 results go through the same cache — no new cache layer for graph-expanded results (they'd share the same query key).
- `invalidateTier0Cache` is Phase 6's to call. If Phase 5 mutates state (it shouldn't — graph building is Phase 6's responsibility), it must also call `invalidateTier0Cache`.

**Notes for Phase 6 (Consolidation):**

- `invalidateTier0Cache(state)` is the hook. Call it inside the write lock, after any mutation that could change Tier 2's answer: new episodic entry, edge write, importance update.
- Tier 1's fuzzy cache is not invalidated on writes. Decision: fuzzy matches return IDs and we deref through `state.entries` at read time, so stale ids get skipped silently. If a skipped-id rate > some threshold shows up in traces, add fuzzy invalidation. Defer.
- The scorer registry is module-level global. Phase 8's settings UI calls `registerScorer(id, fn)` on startup for each alternate; `setScorer(id)` when the user switches.

**Notes for Phase 9 (Benchmarking):**

- τ_confidence and τ_gap are the first knobs. Expect movement based on actual BM25 score distributions on LoCoMo/LongMemEval.
- FNV-1a collision rate over a 1000-query session: should be essentially zero at 32 bits, but worth a smoke test in the eval harness.
- Trace shape is JSONL-ready. Memory Viewer Traces tab (Phase 8) exports; Phase 9's harness reads the same JSONL.
```

### Steps

1. Update barrel.
2. Update barrel test (add assertions per new export).
3. `npm run test`, `npm run lint`, `npm run typecheck` → green.
4. Commit: `feat(retrieval): extend barrel with Phase 4 exports`.
5. Append retro to `ROADMAP.md` with live test counts and any surprises filled in.
6. Commit: `docs(plans): Phase 4 retro`.

---

## Phase-boundary checklist

- [ ] `retrieve(state, query)` composes all primitives from Phase 3 — no logic duplicated.
- [ ] No LLM calls anywhere in `src/retrieval/` (spec §2 principle 1 — grep verify).
- [ ] No long-term state writes outside `recordTier0`/`recordTier1`/`applyAccessEvent` path — and those are ALL called from `ladder.js`, not elsewhere (spec §2 principle 2 — the "one path per responsibility" rule; the write lock proper is Phase 6).
- [ ] Every `retrieve()` call emits exactly one trace with the active scorer's id.
- [ ] Tier 0 invalidation hook (`invalidateTier0Cache`) is exported and documented for Phase 6.
- [ ] Working buffer is prepended exactly once per `retrieve()` call.
- [ ] All tests green, lint green, typecheck green.
- [ ] Each task committed separately; linear history.
- [ ] Spec §5, §5.2, §7, §9.1 invariants satisfied.

---

## What this phase deliberately does NOT do

- **No graph expansion.** Tier 3 is an identity stub. Phase 5 replaces.
- **No consolidation.** `consolidate()` and write lock are Phase 6. This phase reads state; the only writes are lifecycle bumps (`applyAccessEvent`), cache records, and trace logging — none of which require a lock because `retrieve()` is single-threaded per call.
- **No interceptor.** `retrieve()` is called by Phase 8's `STARmemInterceptor`. Phase 4 has no SillyTavern touchpoints.
- **No benchmark harness.** Phase 9. But τ_conf/τ_gap are the knobs Phase 9 tunes first; don't hardcode them in tier2-bm25.js, read from `constants.js`.
- **No memory viewer.** Phase 8. Traces tab consumes `state.runtime.traces` — this phase produces, Phase 8 renders.
- **No adaptive threshold tuning.** If Phase 9 benchmarks show τ values need to be query-length-aware or intent-aware, that's a v2.1 feature. v2.0 uses fixed constants.

If any creep in during implementation, stop and defer to the phase that owns it.
