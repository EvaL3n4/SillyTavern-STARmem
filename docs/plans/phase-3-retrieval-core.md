# Phase 3—Retrieval Core: Implementation Plan

> **For Hermes:** Execute via `subagent-driven-development` with the Sandbox Path Hygiene + Summary Verification protocols from that skill. Absolute paths only; verify each commit in the controller via `git log -1` after every delegation. Reviews can be skipped per the skill's criteria (verbatim code + static checks per task), with one exception noted in Task 2.

**Goal:** Land the five primitives each retrieval tier composes. No ladder yet—that's Phase 4. By the end, we can build a BM25 index over a corpus of entries, classify a query into one of three intents, score a candidate with the multiplicative formula, swap the scorer at runtime, and prepend working-buffer entries to any result list without duplicates.

**Architecture:** Five modules under `src/retrieval/` plus a barrel. Each file is pure (no state I/O, no LLM calls). BM25 is hand-rolled per spec §4 dep policy—no vendored libraries. The scorer exposes a module-level `setScorer` / `getScorer` pair mirroring Phase 1's backend injection pattern. The classifier is rule-based regex/keyword heuristics—**spec §2 principle 1** (deterministic retrieval) forbids LLM on the query path.

**Tech Stack:** Same as Phase 2—Node 20+, ESM, jest, ESLint 9, tsc JSDoc check-only. No new devDependencies. No runtime deps.

**Spec references:** §5 (ladder overview + classifier), §5.2 (multiplicative score), §9.2 (pluggable scorer).

**Inter-phase contract Phase 4 inherits:**

```typescript
// bm25.js
buildIndex(entries: Entry[]): Index
query(index: Index, q: string, k?: number): { entry: Entry; bm25: number }[]
tokenize(text: string): string[]                    // exported for tier 1 Jaccard reuse

// classifier.js
classify(query: string): 'factual' | 'relational' | 'temporal'

// scorer.js
type ScorerContext = { now: Date; bm25: number; intent?: 'factual' | 'relational' | 'temporal' }
type Scorer = (entry: Entry, query: string, context: ScorerContext) => number
defaultScorer: Scorer                               // multiplicative per §5.2
setScorer(fn: Scorer): void
getScorer(): Scorer
_resetScorerForTests(): void                        // test-only

// workingBuffer.js
prependWorking(results: ScoredEntry[], workingEntries: Entry[], now: Date): ScoredEntry[]

// retrieval/index.js (barrel)
// re-exports all of the above
```

Phase 4 will compose these in tier orchestrators; nothing here touches `State`.

---

## Task 0: Pre-flight

**Objective:** Confirm clean Phase 2 baseline.

**Step 1:** `cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem && git log -1 --oneline`. Expected: `584df74 docs(plans): Phase 2 retro`.

**Step 2:** `git status` → clean. `npm run test --silent 2>&1 | tail -3` → 88 tests pass.

**Step 3:** Commit this plan once drafted:
```bash
git add docs/plans/phase-3-retrieval-core.md
git commit -m "docs(plans): add phase-3 retrieval core plan"
```

No other work this task.

---

## Task 1: BM25 index + query

**Objective:** Land `src/retrieval/bm25.js`. Hand-rolled BM25+ over entry content (plus subject + tags with a small boost). In-memory only; rebuilt on chat load. Deterministic, no randomness, no embeddings.

**Why BM25+ and not plain BM25:** The +δ (delta) term keeps long documents from getting zero score on rare terms. It's a one-line tweak, standard since Lv & Zhai 2011, and removes a well-known BM25 failure mode on heterogeneous corpora.

**Files:**
- Create: `src/retrieval/bm25.js`
- Create: `tests/unit/retrieval/bm25.test.js`

### Algorithm (implement exactly)

Parameters (add to `src/core/constants.js` if not there):
- `k1 = 1.2` — term-frequency saturation (BM25 standard)
- `b = 0.75` — length normalization (BM25 standard)
- `delta = 1.0` — BM25+ lower bound
- `SUBJECT_BOOST = 2.0` — subject tokens weighted 2x in the document
- `TAG_BOOST = 1.5` — tag tokens weighted 1.5x

Check `RETRIEVAL` in constants.js first; if BM25 constants are missing, add them in a small first commit before the BM25 file.

Tokenizer: lowercase, split on non-alphanumeric, drop empties, drop <2-char tokens. Export it—Phase 4's Tier 1 Jaccard reuses it.

Document construction:
```
docTerms = content_tokens ++ (SUBJECT_BOOST replications of subject tokens) ++ (TAG_BOOST replications of each tag's tokens)
```
Use integer replication for `SUBJECT_BOOST`/`TAG_BOOST`—they're weights, not fractions, at this level. (If we need fractional boosts later, that's a scorer-level concern, not a tokenizer concern.)

Index shape:
```js
{
  docs: Map<id, { len: number, terms: Map<term, tf> }>,
  df: Map<term, number>,        // doc-frequency per term
  totalDocs: number,
  avgLen: number,
}
```

Scoring formula for a single term `t` against document `d`:
```
idf(t) = log(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
norm = 1 - b + b * (|d| / avgLen)
termScore(t, d) = idf(t) * (tf(t,d) * (k1+1)) / (tf(t,d) + k1 * norm) + delta
bm25(q, d) = sum over unique q_tokens of termScore
```

Empty-query short-circuit: return `[]`.
Empty-corpus short-circuit: return `[]` (don't divide by zero on avgLen).

### Test (write first)

```javascript
import { buildIndex, query, tokenize } from '../../../src/retrieval/bm25.js';
import { createEntry } from '../../../src/memory/entry.js';

/** @type {(scope: import('../../../src/core/schema.js').Scope, content: string, subject?: string|null, tags?: string[]) => import('../../../src/core/schema.js').Entry} */
function entry(scope, content, subject = null, tags = []) {
    return createEntry({
        scope, content, subject, tags,
        provenance: { sourceMessages: [], extractor: 'test' },
    });
}

describe('tokenize', () => {
    test('lowercases and splits on non-alphanumeric', () => {
        expect(tokenize('Alice, meet Bob!')).toEqual(['alice', 'meet', 'bob']);
    });

    test('drops tokens shorter than 2 chars', () => {
        expect(tokenize('a I go')).toEqual(['go']);
    });

    test('handles unicode word chars', () => {
        // At minimum, preserves ASCII alphanumerics; unicode behavior is "best effort".
        const tokens = tokenize('café 123 test');
        expect(tokens).toContain('test');
        expect(tokens).toContain('123');
    });

    test('empty input returns []', () => {
        expect(tokenize('')).toEqual([]);
        expect(tokenize('!!!')).toEqual([]);
    });
});

describe('buildIndex', () => {
    test('empty corpus produces a valid empty index', () => {
        const idx = buildIndex([]);
        expect(idx.totalDocs).toBe(0);
        expect(idx.avgLen).toBe(0);
        expect(query(idx, 'anything')).toEqual([]);
    });

    test('single entry: query matches its content', () => {
        const e = entry('episodic', 'Alice grew up in Marseille');
        const idx = buildIndex([e]);
        const results = query(idx, 'Marseille');
        expect(results).toHaveLength(1);
        expect(results[0].entry.id).toBe(e.id);
        expect(results[0].bm25).toBeGreaterThan(0);
    });

    test('query with no matches returns empty', () => {
        const idx = buildIndex([entry('episodic', 'the quick brown fox')]);
        expect(query(idx, 'platypus')).toEqual([]);
    });
});

describe('query ranking (golden cases)', () => {
    const corpus = [
        entry('episodic', 'Alice grew up in Marseille, France', 'alice', ['location', 'hometown']),
        entry('episodic', 'Bob lives in Paris and works as a sculptor', 'bob', ['location', 'profession']),
        entry('episodic', 'Alice and Bob met at a café in 2015', null, ['meeting']),
        entry('episodic', 'The cat sat on the mat', null, []),
        entry('episodic', 'Alice plays violin every Sunday', 'alice', ['hobby']),
    ];
    const idx = buildIndex(corpus);

    test('"Marseille" returns the Marseille entry first', () => {
        const r = query(idx, 'Marseille');
        expect(r[0].entry.content).toMatch(/Marseille/);
    });

    test('"Alice hobby" ranks Alice+violin entry above Alice+Marseille', () => {
        const r = query(idx, 'Alice hobby');
        expect(r[0].entry.content).toMatch(/violin/);
    });

    test('subject boost: "alice" ranks alice-subject entries above content-only mentions', () => {
        const r = query(idx, 'alice');
        const top = r[0].entry;
        expect(top.subject).toBe('alice');
    });

    test('tag boost: "hometown" surfaces the Marseille entry', () => {
        const r = query(idx, 'hometown');
        expect(r.length).toBeGreaterThan(0);
        expect(r[0].entry.content).toMatch(/Marseille/);
    });

    test('k parameter caps result count', () => {
        const r = query(idx, 'alice', 2);
        expect(r.length).toBeLessThanOrEqual(2);
    });

    test('results are sorted by bm25 descending', () => {
        const r = query(idx, 'alice');
        for (let i = 1; i < r.length; i++) {
            expect(r[i - 1].bm25).toBeGreaterThanOrEqual(r[i].bm25);
        }
    });
});

describe('empty-query handling', () => {
    test('empty string returns []', () => {
        const idx = buildIndex([entry('episodic', 'hello')]);
        expect(query(idx, '')).toEqual([]);
    });

    test('query with only stopword-length tokens returns []', () => {
        const idx = buildIndex([entry('episodic', 'hello world')]);
        expect(query(idx, 'a i')).toEqual([]);
    });
});
```

### Implementation

Put it behind exact signatures listed in the inter-phase contract. Full code below; treat it as the verbatim source for this task.

```javascript
/**
 * BM25+ full-text index over entries. Hand-rolled per spec §4 dep policy—
 * no vendored libraries, no embeddings. Deterministic.
 *
 * Index is in-memory only. Phase 4 rebuilds it on chat load; no persistence.
 *
 * @module retrieval/bm25
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5, §5.2
 */

import { RETRIEVAL } from '../core/constants.js';

const { BM25_K1, BM25_B, BM25_DELTA, SUBJECT_BOOST, TAG_BOOST } = RETRIEVAL;

/**
 * Tokenize text into lowercase alphanumeric tokens ≥2 chars. Reused by
 * Phase 4's Tier 1 Jaccard.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter(t => t.length >= 2);
}

/**
 * @typedef {object} Index
 * @property {Map<string, { len: number, terms: Map<string, number>, entry: import('../core/schema.js').Entry }>} docs
 * @property {Map<string, number>} df
 * @property {number} totalDocs
 * @property {number} avgLen
 */

/**
 * Build a fresh BM25+ index over a list of entries. O(total tokens).
 *
 * @param {import('../core/schema.js').Entry[]} entries
 * @returns {Index}
 */
export function buildIndex(entries) {
    /** @type {Index} */
    const idx = {
        docs: new Map(),
        df: new Map(),
        totalDocs: 0,
        avgLen: 0,
    };
    if (!Array.isArray(entries) || entries.length === 0) return idx;

    let totalLen = 0;
    for (const entry of entries) {
        const content = tokenize(entry.content);
        const subjectTokens = entry.subject ? tokenize(entry.subject) : [];
        const tagTokens = entry.tags.flatMap(t => tokenize(t));

        const docTerms = [
            ...content,
            ...repeat(subjectTokens, SUBJECT_BOOST),
            ...repeat(tagTokens, TAG_BOOST),
        ];

        /** @type {Map<string, number>} */
        const termCounts = new Map();
        for (const term of docTerms) {
            termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
        }

        idx.docs.set(entry.id, { len: docTerms.length, terms: termCounts, entry });
        totalLen += docTerms.length;

        for (const term of termCounts.keys()) {
            idx.df.set(term, (idx.df.get(term) ?? 0) + 1);
        }
    }

    idx.totalDocs = idx.docs.size;
    idx.avgLen = idx.totalDocs > 0 ? totalLen / idx.totalDocs : 0;
    return idx;
}

/**
 * Query the index. Returns entries sorted by BM25+ score descending.
 *
 * @param {Index} index
 * @param {string} q
 * @param {number} [k] - If provided, caps result count. Omitted = all matches.
 * @returns {{ entry: import('../core/schema.js').Entry, bm25: number }[]}
 */
export function query(index, q, k) {
    const qTokens = Array.from(new Set(tokenize(q)));
    if (qTokens.length === 0 || index.totalDocs === 0) return [];

    /** @type {{ entry: import('../core/schema.js').Entry, bm25: number }[]} */
    const results = [];
    for (const { len, terms, entry } of index.docs.values()) {
        let score = 0;
        for (const term of qTokens) {
            const tf = terms.get(term) ?? 0;
            if (tf === 0) continue;
            const df = index.df.get(term) ?? 0;
            const idf = Math.log(1 + (index.totalDocs - df + 0.5) / (df + 0.5));
            const norm = 1 - BM25_B + BM25_B * (len / index.avgLen);
            score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm) + BM25_DELTA;
        }
        if (score > 0) results.push({ entry, bm25: score });
    }

    results.sort((a, b) => b.bm25 - a.bm25);
    return typeof k === 'number' ? results.slice(0, k) : results;
}

/**
 * Replicate an array `n` times. n must be a non-negative integer; fractional
 * values round down. Used for subject/tag boosting in the tokenizer.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[]}
 */
function repeat(arr, n) {
    const times = Math.max(0, Math.floor(n));
    const out = [];
    for (let i = 0; i < times; i++) out.push(...arr);
    return out;
}
```

### Steps

1. Check `src/core/constants.js` for `BM25_K1`, `BM25_B`, `BM25_DELTA`, `SUBJECT_BOOST`, `TAG_BOOST` under `RETRIEVAL`. If missing, add them with golden-value tests — this is a small first commit (`chore(core): add BM25 constants`).
2. Write failing test.
3. `npm run test tests/unit/retrieval/bm25.test.js` → expect FAIL.
4. Write `src/retrieval/bm25.js`.
5. Test, lint, typecheck — all green.
6. Commit: `feat(retrieval): add BM25+ index with subject/tag boosting per spec §5`

Expected test count: 12 new tests in `bm25.test.js`, plus any constants tests added.

---

## Task 2: Rule-based query classifier

**Objective:** `src/retrieval/classifier.js` — map a query string to `'factual' | 'relational' | 'temporal'`. No LLM. This is the one task in the phase where I'd keep spec-compliance review: the keyword set is judgment-heavy, and a subagent might over-engineer it.

**Files:**
- Create: `src/retrieval/classifier.js`
- Create: `tests/unit/retrieval/classifier.test.js`

### Heuristic rules

Priority order (first match wins):

1. **Temporal** — query contains any of: `when`, `before`, `after`, `during`, `recently`, `last (week|month|year|time)`, `yesterday`, `today`, a year (`\b(19|20|21)\d{2}\b`), a date fragment, "ago".
2. **Relational** — query contains any of: `who`, `with whom`, `together`, `related`, `connection`, `between .+ and`, `how does .+ relate`, or mentions two capitalized proper nouns joined by `and` / `&` / `,`.
3. **Factual** — default. Matches *what*, *where*, *why*, isolated proper nouns, declarative noun phrases, and everything else.

Why priority matters: "When did Alice meet Bob?" is both temporal and relational. Spec §5 gives temporal primacy for graph expansion (edge type `temporal_next` has 0.9 weight on temporal queries vs 0.4 on relational). So temporal > relational > factual.

### Test (5 per intent)

```javascript
import { classify } from '../../../src/retrieval/classifier.js';

describe('classify', () => {
    describe('temporal', () => {
        test.each([
            'When did Alice move to Paris?',
            'What did I say last week?',
            'Show me events from 2015',
            'Was this before or after the conference?',
            'Things that happened yesterday',
        ])('%p → temporal', q => {
            expect(classify(q)).toBe('temporal');
        });
    });

    describe('relational', () => {
        test.each([
            'Who was with Alice at the party?',
            'How is Alice related to Bob?',
            'What is the connection between Alice and Bob?',
            'Tell me about Alice and Bob',
            'Alice & Bob',
        ])('%p → relational', q => {
            expect(classify(q)).toBe('relational');
        });
    });

    describe('factual', () => {
        test.each([
            'Where does Alice live?',
            'What is Bob\'s profession?',
            'Describe the café',
            'Marseille',
            'Tell me about sculpting',
        ])('%p → factual', q => {
            expect(classify(q)).toBe('factual');
        });
    });

    describe('priority', () => {
        test('temporal cue wins over relational cue (§5 edge weights favor temporal_next on temporal)', () => {
            // "when" is temporal, and the query also mentions two names—ambiguous.
            expect(classify('When did Alice meet Bob?')).toBe('temporal');
        });

        test('relational cue wins over bare factual', () => {
            expect(classify('Alice and Bob')).toBe('relational');
        });
    });

    describe('robustness', () => {
        test('empty query defaults to factual', () => {
            expect(classify('')).toBe('factual');
        });

        test('whitespace-only query defaults to factual', () => {
            expect(classify('   ')).toBe('factual');
        });

        test('non-string input throws', () => {
            expect(() => classify(/** @type {any} */ (null))).toThrow(/string/);
            expect(() => classify(/** @type {any} */ (123))).toThrow(/string/);
        });
    });
});
```

### Implementation sketch

```javascript
/**
 * Rule-based query classifier. Returns 'factual' | 'relational' | 'temporal'.
 * No LLM—spec §2 principle 1 (deterministic retrieval, always).
 *
 * Priority: temporal > relational > factual. See phase-3 plan §Task 2 for
 * the rationale.
 *
 * @module retrieval/classifier
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

const TEMPORAL_PATTERNS = [
    /\bwhen\b/i,
    /\b(before|after|during|recently|yesterday|today)\b/i,
    /\blast\s+(week|month|year|time)\b/i,
    /\b(19|20|21)\d{2}\b/,
    /\bago\b/i,
];

const RELATIONAL_PATTERNS = [
    /\bwho\b/i,
    /\bwith\s+whom\b/i,
    /\btogether\b/i,
    /\brelated\b/i,
    /\bconnection\b/i,
    /\bbetween\s+\w+\s+and\s+\w+/i,
    /\brelate(s|d)?\b/i,
    // Two capitalized tokens joined by and/&/,
    /\b[A-Z][a-z]+\s+(and|&|,)\s+[A-Z][a-z]+/,
];

/**
 * Classify a query into one of three intents. Temporal wins over relational
 * wins over factual (priority order matters for §5 edge-weight routing).
 *
 * @param {string} query
 * @returns {'factual' | 'relational' | 'temporal'}
 */
export function classify(query) {
    if (typeof query !== 'string') {
        throw new Error(`classify: query must be a string, got ${typeof query}`);
    }
    if (query.trim().length === 0) return 'factual';

    for (const re of TEMPORAL_PATTERNS) {
        if (re.test(query)) return 'temporal';
    }
    for (const re of RELATIONAL_PATTERNS) {
        if (re.test(query)) return 'relational';
    }
    return 'factual';
}
```

### Steps

1. Write failing test.
2. `npm run test` → FAIL.
3. Write `classifier.js`.
4. Tests may fail on edge cases in first pass — this is the one task where the subagent should iterate on classifier rules until all 15+ tests pass. If rules need tweaks beyond the starter set, document the change in a comment and keep the priority order.
5. Lint, typecheck, all green.
6. Commit: `feat(retrieval): add 3-type rule-based query classifier per spec §5`

**Review note:** After this task only, run a spec-compliance check: does the classifier route queries the way Phase 5's Tier 3 edge-weight table (spec §5.1) expects? E.g., "Tell me about Alice and Bob" should be `relational`, not `factual`, because the relational row has `mentions=0.9` (the strongest weight in that row). This is easy to get wrong with naive rules.

---

## Task 3: Pluggable scorer

**Objective:** `src/retrieval/scorer.js` — the spec §5.2 multiplicative formula as the default, plus `setScorer`/`getScorer` for A/B testing via settings (spec §9.2).

**Files:**
- Create: `src/retrieval/scorer.js`
- Create: `tests/unit/retrieval/scorer.test.js`

### Formula

```
score(entry, query, { now, bm25 }) = bm25 × (1 + importance/100) × recency × maturity_boost
```

- `bm25` is computed externally (Phase 4 passes it in) — scorer doesn't re-run BM25.
- `recency` comes from `lifecycle/recency.js` given `now` and `entry.lifecycle.createdAt`.
- `maturity_boost` comes from `lifecycle/maturity.js` given `entry.lifecycle.maturity`.
- `importance` comes from `entry.lifecycle.importance`, range [0,100].

Factor order isn't mathematically meaningful (multiplication commutes), but keep it as written in the spec for readability.

### Test

```javascript
import {
    defaultScorer,
    setScorer,
    getScorer,
    _resetScorerForTests,
} from '../../../src/retrieval/scorer.js';
import { createEntry } from '../../../src/memory/entry.js';

/** @type {(overrides?: Partial<import('../../../src/core/schema.js').Entry>) => import('../../../src/core/schema.js').Entry} */
function entry(overrides = {}) {
    const base = createEntry({
        scope: 'episodic', content: 'test', subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...base, ...overrides };
}

describe('defaultScorer', () => {
    const now = new Date('2026-04-20T12:00:00Z');

    test('baseline: importance=50, draft, fresh, bm25=1.0', () => {
        const e = entry();
        // (1 + 50/100) × exp(0) × 0.85 = 1.5 × 1 × 0.85 = 1.275
        expect(defaultScorer(e, 'q', { now, bm25: 1.0 })).toBeCloseTo(1.275, 4);
    });

    test('bm25 of zero produces zero score (multiplicative dominance)', () => {
        expect(defaultScorer(entry(), 'q', { now, bm25: 0 })).toBe(0);
    });

    test('higher importance raises score', () => {
        const low = entry({ lifecycle: { ...entry().lifecycle, importance: 10 } });
        const high = entry({ lifecycle: { ...entry().lifecycle, importance: 90 } });
        expect(defaultScorer(high, 'q', { now, bm25: 1.0 }))
            .toBeGreaterThan(defaultScorer(low, 'q', { now, bm25: 1.0 }));
    });

    test('older entry scores lower than newer (recency dominates when other factors equal)', () => {
        const fresh = entry();
        const old = entry({
            lifecycle: { ...entry().lifecycle, createdAt: '2025-04-20T12:00:00Z' }, // 1 year ago
        });
        expect(defaultScorer(fresh, 'q', { now, bm25: 1.0 }))
            .toBeGreaterThan(defaultScorer(old, 'q', { now, bm25: 1.0 }));
    });

    test('core maturity boosts score vs draft at same importance', () => {
        const draftE = entry({ lifecycle: { ...entry().lifecycle, maturity: 'draft' } });
        const coreE = entry({ lifecycle: { ...entry().lifecycle, maturity: 'core' } });
        const draftScore = defaultScorer(draftE, 'q', { now, bm25: 1.0 });
        const coreScore = defaultScorer(coreE, 'q', { now, bm25: 1.0 });
        // core boost (1.2) / draft boost (0.85) = 1.4118x
        expect(coreScore / draftScore).toBeCloseTo(1.2 / 0.85, 4);
    });

    test('golden value: importance=100, core, fresh, bm25=0.5', () => {
        const e = entry({
            lifecycle: { ...entry().lifecycle, importance: 100, maturity: 'core' },
        });
        // 0.5 × (1 + 100/100) × 1.0 × 1.2 = 0.5 × 2 × 1 × 1.2 = 1.2
        expect(defaultScorer(e, 'q', { now, bm25: 0.5 })).toBeCloseTo(1.2, 6);
    });

    test('ignores unknown context fields (forward compat)', () => {
        const e = entry();
        const withExtras = defaultScorer(e, 'q', /** @type {any} */ ({ now, bm25: 1.0, intent: 'factual', futureFactor: 42 }));
        const plain = defaultScorer(e, 'q', { now, bm25: 1.0 });
        expect(withExtras).toBe(plain);
    });
});

describe('scorer injection', () => {
    afterEach(() => _resetScorerForTests());

    test('getScorer returns defaultScorer initially', () => {
        expect(getScorer()).toBe(defaultScorer);
    });

    test('setScorer replaces the active scorer', () => {
        const constant = () => 42;
        setScorer(constant);
        expect(getScorer()).toBe(constant);
        expect(getScorer()(entry(), 'q', { now: new Date(), bm25: 1 })).toBe(42);
    });

    test('_resetScorerForTests restores the default', () => {
        setScorer(() => 0);
        _resetScorerForTests();
        expect(getScorer()).toBe(defaultScorer);
    });

    test('setScorer rejects non-functions', () => {
        expect(() => setScorer(/** @type {any} */ (null))).toThrow(/function/);
        expect(() => setScorer(/** @type {any} */ (42))).toThrow(/function/);
    });
});
```

### Implementation

```javascript
/**
 * Pluggable retrieval scorer. Default implements spec §5.2's multiplicative
 * formula; alternates can be registered via setScorer for A/B benchmarking
 * (spec §9.2).
 *
 * @module retrieval/scorer
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5.2, §9.2
 */

import { recencyAt, maturityBoost } from '../lifecycle/index.js';

/**
 * @typedef {object} ScorerContext
 * @property {Date} now                                  - Reference clock for recency.
 * @property {number} bm25                               - Pre-computed BM25 score (Phase 4 supplies).
 * @property {'factual'|'relational'|'temporal'} [intent] - Reserved for intent-aware scorers (Phase 5+).
 */

/**
 * @typedef {(
 *   entry: import('../core/schema.js').Entry,
 *   query: string,
 *   context: ScorerContext
 * ) => number} Scorer
 */

/**
 * The spec §5.2 multiplicative scorer. Factor order is decorative—
 * multiplication commutes—but matches the spec for readability.
 *
 * The context parameter is deliberately an object (not positional args)
 * so later factors (intent, query length, classifier confidence) can be
 * added without breaking registered scorers. Unknown keys are ignored.
 *
 * @type {Scorer}
 */
export const defaultScorer = (entry, _query, context) => {
    const { now, bm25 } = context;
    if (bm25 === 0) return 0;                       // fast path
    const { importance, maturity, createdAt } = entry.lifecycle;
    return bm25
        * (1 + importance / 100)
        * recencyAt(now, createdAt)
        * maturityBoost(maturity);
};

/** @type {Scorer} */
let current = defaultScorer;

/**
 * Register a new scorer. Phase 8's settings UI calls this when the user
 * switches scorer in A/B mode.
 *
 * @param {Scorer} fn
 */
export function setScorer(fn) {
    if (typeof fn !== 'function') {
        throw new Error(`setScorer: fn must be a function, got ${typeof fn}`);
    }
    current = fn;
}

/** @returns {Scorer} */
export function getScorer() {
    return current;
}

/** Test-only escape hatch. */
export function _resetScorerForTests() {
    current = defaultScorer;
}
```

### Steps

TDD. Write test → FAIL → implement → green → commit: `feat(retrieval): add pluggable scorer with multiplicative default per spec §5.2`.

Expected test count: 11 new tests.

### Deliberate deviation from spec §9.2

Spec §9.2 gives the scorer signature as `(entry, query, lifecycle) => number`. We deviate in two ways:

1. **Drop `lifecycle`** — it's already reachable via `entry.lifecycle`; passing it separately is redundant and invites divergence.
2. **Replace positional `now`/`bm25` with a `ScorerContext` object** — the spec signature has no clock at all (so `recencyAt` would have to call `new Date()` internally, making scorers non-deterministic and hard to test) and hardcodes the factor list to what v2.0 needs. An open context object lets Phase 5 add `intent`, Phase 9 add `queryTokens`, and future scorers consume or ignore as needed — without a breaking signature change for every registered scorer.

This deviation should be reflected in `docs/specs/2026-04-20-starmem-v2-design.md` §9.2 at some point. Flag it in the Phase 3 retro and leave a spec-amendment note.

---

## Task 4: Working-buffer prepend

**Objective:** `src/retrieval/workingBuffer.js` — unconditionally prepend working-buffer entries to any result list, deduping against entries already scored. Spec §5: "Working buffer is prepended to every result unconditionally—it is not a tier."

**Files:**
- Create: `src/retrieval/workingBuffer.js`
- Create: `tests/unit/retrieval/workingBuffer.test.js`

### Behavior

Input:
- `results: { entry, bm25, score }[]` from some tier's output (Phase 4 supplies this).
- `workingEntries: Entry[]` — the raw `scope === 'working'` entries, in insertion order.
- `now: Date` — needed to compute recency for fresh buffer entries.

Output:
- Working entries first (in buffer order), each wrapped in `{ entry, bm25: 0, score: <from current scorer with bm25=0... hmm>` — see below.

Subtlety: the spec says "prepended unconditionally," meaning working entries bypass the scorer for ranking. But the downstream code (Phase 4) expects every result to have a `score` field for merge/sort. Two options:

- **A (chosen)**: Assign working entries a sentinel `score: Infinity` and `bm25: 0`. Downstream treats Infinity as "always ranks first." Clean, no ambiguity.
- **B**: Score them with the current scorer using `bm25: 1.0` to mean "fresh-working-relevance" — but that lets lifecycle decay push an old working entry below a fresh episodic entry, which violates the "unconditionally" clause.

Go with A.

Dedup: if a working entry's id already appears in `results`, drop the duplicate from `results` (keep the working copy, since it's the freshest view).

### Test

```javascript
import { prependWorking } from '../../../src/retrieval/workingBuffer.js';
import { createEntry } from '../../../src/memory/entry.js';

const now = new Date('2026-04-20T12:00:00Z');

function scored(entry, score = 1.0, bm25 = 0.5) {
    return { entry, bm25, score };
}

function e(scope, content, id) {
    const out = createEntry({
        scope, content, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now,
    });
    if (id) return { ...out, id };
    return out;
}

describe('prependWorking', () => {
    test('empty buffer passes through results unchanged', () => {
        const results = [scored(e('episodic', 'a')), scored(e('episodic', 'b'))];
        expect(prependWorking(results, [], now)).toEqual(results);
    });

    test('empty results yields wrapped working entries only', () => {
        const w1 = e('working', 'x');
        const w2 = e('working', 'y');
        const out = prependWorking([], [w1, w2], now);
        expect(out).toHaveLength(2);
        expect(out[0].entry.id).toBe(w1.id);
        expect(out[1].entry.id).toBe(w2.id);
        expect(out[0].score).toBe(Infinity);
    });

    test('working entries come before results', () => {
        const w = e('working', 'fresh');
        const r = e('episodic', 'old');
        const out = prependWorking([scored(r)], [w], now);
        expect(out[0].entry.id).toBe(w.id);
        expect(out[1].entry.id).toBe(r.id);
    });

    test('working entries preserve buffer insertion order', () => {
        const w1 = e('working', 'first');
        const w2 = e('working', 'second');
        const w3 = e('working', 'third');
        const out = prependWorking([], [w1, w2, w3], now);
        expect(out.map(x => x.entry.id)).toEqual([w1.id, w2.id, w3.id]);
    });

    test('dedupes results against working entries by id', () => {
        const w = e('working', 'shared');
        // Simulate the same id appearing in results (uncommon but possible).
        const results = [scored({ ...w, content: 'older copy' })];
        const out = prependWorking(results, [w], now);
        expect(out).toHaveLength(1);
        expect(out[0].entry.content).toBe('shared');  // working copy wins
    });

    test('working entries are assigned score=Infinity and bm25=0', () => {
        const w = e('working', 'x');
        const [wrapped] = prependWorking([], [w], now);
        expect(wrapped.score).toBe(Infinity);
        expect(wrapped.bm25).toBe(0);
    });

    test('rejects malformed inputs', () => {
        expect(() => prependWorking(/** @type {any} */ (null), [], now)).toThrow(/results/);
        expect(() => prependWorking([], /** @type {any} */ (null), now)).toThrow(/working/);
    });
});
```

### Implementation

```javascript
/**
 * Working-buffer prepend. Spec §5: "Working buffer is prepended to every
 * result unconditionally—it is not a tier."
 *
 * Working entries are assigned sentinel score=Infinity to guarantee they
 * outrank any scored tier output, without letting lifecycle factors (decay,
 * maturity) affect their ranking.
 *
 * @module retrieval/workingBuffer
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5
 */

/**
 * @typedef {{
 *   entry: import('../core/schema.js').Entry,
 *   bm25: number,
 *   score: number
 * }} ScoredEntry
 */

/**
 * Prepend working-buffer entries to a scored result list. Dedupes against
 * `results` by id, keeping the working-buffer copy (freshest view).
 *
 * @param {ScoredEntry[]} results
 * @param {import('../core/schema.js').Entry[]} workingEntries
 * @param {Date} _now - Reserved for future factor-awareness; currently unused.
 * @returns {ScoredEntry[]}
 */
export function prependWorking(results, workingEntries, _now) {
    if (!Array.isArray(results)) {
        throw new Error('prependWorking: results must be an array');
    }
    if (!Array.isArray(workingEntries)) {
        throw new Error('prependWorking: workingEntries must be an array');
    }

    const workingIds = new Set(workingEntries.map(e => e.id));
    const prepended = workingEntries.map(entry => ({
        entry,
        bm25: 0,
        score: Infinity,
    }));
    const filteredResults = results.filter(r => !workingIds.has(r.entry.id));
    return [...prepended, ...filteredResults];
}
```

### Steps

TDD, commit: `feat(retrieval): add working-buffer prepend per spec §5`.

Expected test count: 7 new tests.

---

## Task 5: Barrel export

**Objective:** `src/retrieval/index.js` — single import surface for Phase 4.

**Files:**
- Create: `src/retrieval/index.js`
- Create: `tests/unit/retrieval/index.test.js`

```javascript
export { buildIndex, query, tokenize } from './bm25.js';
export { classify } from './classifier.js';
export { defaultScorer, setScorer, getScorer, _resetScorerForTests } from './scorer.js';
export { prependWorking } from './workingBuffer.js';
```

Test mirrors Phase 2's barrel test pattern (type checks + reference equality). Expected: 2 tests.

Commit: `feat(retrieval): add barrel export for Phase 4 consumers`.

---

## Task 6: Phase 3 retro

**Objective:** Append to `docs/plans/ROADMAP.md` a `## Phase 3—YYYY-MM-DD` section. What shipped, surprises, and notes for Phase 4.

**Points to include:**
- BM25 is hand-rolled; revisit if corpus grows past ~10K entries (worth benchmarking, not optimizing prematurely).
- Classifier thresholds likely need tuning against real roleplay queries — flag it as a Phase 9 benchmark target.
- Scorer plug-in pattern is ready for the Phase 9 eval harness hook (§9.3).
- Phase 4 inherits the exact signatures from the inter-phase contract block at the top of this plan.
- Whatever actually surprised during implementation — fill in live.

Commit: `docs(plans): Phase 3 retro`.

---

## Phase-boundary checklist

- [ ] All four primitives exported from `retrieval/index.js`, Phase 4 can import them.
- [ ] No LLM calls anywhere in `src/retrieval/` (spec §2 principle 1 — verify with `grep -r 'fetch\|openai\|claude\|llm' src/retrieval/`).
- [ ] No `chatMetadata` or state I/O in `src/retrieval/` (pure functions + one module-level mutable for scorer).
- [ ] Tests green. Lint green. Typecheck green.
- [ ] Each task committed separately; linear history.
- [ ] Spec §5 and §5.2 invariants satisfied: working buffer prepended unconditionally, multiplicative score factor order preserved, classifier is rule-based only.

---

## What this phase deliberately does NOT do

- **No tier orchestrator.** Tier 0 cache, Tier 1 fuzzy, Tier 2 wrapper — all Phase 4.
- **No state mutation.** Access-event bumps (`applyAccessEvent`) happen at the ladder level (Phase 4), not per-scored-candidate.
- **No trace logger.** `trace.js` is Phase 4.
- **No graph expansion.** Tier 3 is Phase 5.
- **No `runtime.traces` ring buffer.** Phase 4.
- **No benchmark harness.** Phase 9 — but the pluggable scorer is the hook.

If any creep in during implementation, stop and defer to the phase that owns it. This is the piece-supplier phase; the assembler comes next.
