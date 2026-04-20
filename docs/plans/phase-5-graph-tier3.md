# Phase 5—Graph + Tier 3: Implementation Plan

> **For Hermes:** Execute via `subagent-driven-development` with the Sandbox Path Hygiene + Summary Verification protocols. Absolute paths only; verify each commit in the controller via `git log -1` after every delegation. Reviews skipped per the skill's criteria (verbatim code + static checks per task), with one exception in Task 4 (ladder integration — swap identity stub for real Tier 3).

**Goal:** Turn the Tier 3 identity stub from Phase 4 into the MAGMA-lite beam-search-over-typed-edges retrieval the spec §5.1 describes. By the end: `tier3(state, seeds, queryStr, intent)` walks 1–2 hops through `state.graph.edges`, scores neighbors with the intent-routed edge-weight table, merges with seeds, reranks under the multiplicative scorer, and returns a different ordering than Tier 2's seeds when graph structure earns it. Edge building is pure and will be wired into Phase 6's consolidation write lock.

**Architecture:** Three modules under `src/memory/` (graph store + edge builder) and `src/retrieval/` (tier3 beam search). Edge building is pure — `buildEdges(entry, allEntries) → { newEdges, evicted }` — so Phase 5 produces the logic and Phase 6 applies it during `consolidate()`. The graph lives at `state.graph.edges` (already shaped by Phase 1); an in-memory adjacency `Map<id, Edge[]>` is built per ladder call (not persisted). Tier 3 is called when Tier 2 has scored results but missed its exit condition — the branch already exists in `ladder.js` from Phase 4.

**Tech Stack:** Same as Phase 4 — Node 20+, ESM, jest, ESLint 9, tsc JSDoc check-only. No new devDependencies. No runtime deps.

**Spec references:** §4 (graph infrastructure), §5.1 (Tier 3 MAGMA-lite detail), §6.3 (edge building in consolidate), §11 (contradicts reserved but not emitted), §12.2 (edge cap open question).

**Inter-phase contract Phase 6 inherits:**

```typescript
// memory/graph.js
addEdge(state: State, edge: Edge): State                            // pure
removeEdge(state: State, from: string, to: string, type: EdgeType): State  // pure
listEdges(state: State): Edge[]                                     // convenience reader
buildAdjacency(state: State): Map<string, Edge[]>                   // in-memory per-call cache
neighborsOf(adjacency: Map<string, Edge[]>, entryId: string): Edge[]

// memory/edgeBuilder.js
buildEdges(entry: Entry, allEntries: Entry[], state: State): {
    newEdges: Edge[];         // edges to add
    evicted: Edge[];          // edges to remove to stay under cap
}
extractEntities(text: string): string[]                             // capitalized-noun matcher, exported for tests

// retrieval/tier3-graph.js
tier3(state: State, seeds: Entry[], queryStr: string, intent: Intent, ctx: {
    now: Date,
    k?: number,                   // output cap
}): ScoredEntry[]
```

**Decisions locked before writing this plan (see conversation 2026-04-20):**

1. **Edge weights.** Explicit `@relations` → `weight = 1.0` (extractor asserted). Co-occurrence → `weight = 0.5` (inferred).
2. **Co-occurrence edge type.** `mentions`. Spec §4 reads that way ("mentions" for shared proper nouns).
3. **Beam width.** `B = 5`. Budget fit: 2 hops × 5 seeds × ~20 neighbors ≈ 200 score evaluations under 100ms.
4. **Edge cap per entry.** 20 total per-source (spec §12.2 open q resolution). Enforced at write time in `buildEdges`, preferring higher weight + recent. Returns `evicted: Edge[]` alongside `newEdges`.
5. **Adjacency caching.** Built per ladder call, not persisted. Flat `state.graph.edges` stays authoritative. BM25 index rebuild precedent.
6. **Entity matcher.** Regex `/\b[A-Z][a-z]{2,}\b/g` on raw content. Requires ≥3 lowercase chars after capital → filters out "A", "I", "The" at sentence starts but keeps "Alice", "Marseille", etc.
7. **Tier 3 gating.** Always fires when Tier 2 has seeds and missed exit. Intent steers edge weights, doesn't gate the tier itself. Phase 9 decides if a factual-intent skip earns its complexity.
8. **Tier 3 trace output.** `perTier['3']` becomes the Tier-3-specific scored list (merged + reranked), not a copy of Tier 2. Integration test gains an "ordering differs from Tier 2 seeds" assertion.
9. **Tier 3 output cap.** `k` from ladder (default 5), matching other tiers. Caller trims further before prepending working buffer.
10. **contradicts edges.** Reserved in schema, NOT emitted by `buildEdges`. Tier 3's intent-weight table does include the contradicts row — latent for v2.x when drift detection lands.
11. **buildEdges is pure.** Returns `{ newEdges, evicted }`. `consolidate()` (Phase 6) applies both inside the write lock and calls `invalidateTier0Cache` afterward.

---

## Task 0: Pre-flight + constants delta

**Objective:** Confirm 210-test baseline. Land Phase 5 constants (beam width, seeds K, edge cap, edge weights, intent-routing table) in a single small commit before any graph code.

**Files:**
- Modify: `src/core/constants.js`
- Modify: `tests/unit/core/constants.test.js`

**Step 1:** `cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem && git log -1 --oneline`. Expected: `1a8630c docs(plans): Phase 4 retro`.

**Step 2:** `git status` clean. `npm run test --silent 2>&1 | tail -3` → 210 tests.

**Step 3:** Commit this plan:
```bash
git add docs/plans/phase-5-graph-tier3.md
git commit -m "docs(plans): add phase-5 graph + Tier 3 plan"
```

**Step 4:** Extend `RETRIEVAL` in `src/core/constants.js`. Before the closing `});`:

```javascript
    /** Tier 3 seeds drawn from Tier 2's top-K. Spec §5.1. */
    TIER3_SEEDS_K: 3,
    /** Tier 3 beam width. Not in spec; opening value, Phase 9 tunes. */
    TIER3_BEAM_WIDTH: 5,
    /** Max edges per source entry. Spec §12.2 resolution. */
    EDGE_CAP_PER_ENTRY: 20,
    /** Weight for edges from extractor-asserted @relations. Spec §4 / §6.3. */
    EXPLICIT_RELATION_WEIGHT: 1.0,
    /** Weight for edges from entity co-occurrence (capitalized noun match). Spec §4 / §6.3. */
    COOCCURRENCE_WEIGHT: 0.5,
```

Then, **after** the `RETRIEVAL` block (as a standalone frozen const since it's a nested structure), add:

```javascript
/**
 * Tier 3 edge-type match weights per query intent. Spec §5.1 table.
 * `contradicts` is included for completeness but v2.0 edgeBuilder never emits
 * that type — the row is dormant until drift detection lands.
 */
export const EDGE_TYPE_WEIGHTS = Object.freeze({
    supports:      Object.freeze({ factual: 0.9, relational: 0.5, temporal: 0.3 }),
    mentions:      Object.freeze({ factual: 0.7, relational: 0.9, temporal: 0.3 }),
    same_topic:    Object.freeze({ factual: 0.5, relational: 0.8, temporal: 0.5 }),
    temporal_next: Object.freeze({ factual: 0.3, relational: 0.4, temporal: 0.9 }),
    contradicts:   Object.freeze({ factual: 0.2, relational: 0.3, temporal: 0.2 }),
});
```

**Step 5:** Extend `tests/unit/core/constants.test.js`. Add import for `EDGE_TYPE_WEIGHTS` at the top, then:

```javascript
test('RETRIEVAL Phase 5 graph/Tier 3 constants', () => {
    expect(RETRIEVAL.TIER3_SEEDS_K).toBe(3);
    expect(RETRIEVAL.TIER3_BEAM_WIDTH).toBe(5);
    expect(RETRIEVAL.EDGE_CAP_PER_ENTRY).toBe(20);
    expect(RETRIEVAL.EXPLICIT_RELATION_WEIGHT).toBe(1.0);
    expect(RETRIEVAL.COOCCURRENCE_WEIGHT).toBe(0.5);
});

test('EDGE_TYPE_WEIGHTS matches spec §5.1 table', () => {
    expect(EDGE_TYPE_WEIGHTS.supports).toEqual({ factual: 0.9, relational: 0.5, temporal: 0.3 });
    expect(EDGE_TYPE_WEIGHTS.mentions).toEqual({ factual: 0.7, relational: 0.9, temporal: 0.3 });
    expect(EDGE_TYPE_WEIGHTS.same_topic).toEqual({ factual: 0.5, relational: 0.8, temporal: 0.5 });
    expect(EDGE_TYPE_WEIGHTS.temporal_next).toEqual({ factual: 0.3, relational: 0.4, temporal: 0.9 });
    expect(EDGE_TYPE_WEIGHTS.contradicts).toEqual({ factual: 0.2, relational: 0.3, temporal: 0.2 });
});

test('EDGE_TYPE_WEIGHTS covers all produced edge types + contradicts', () => {
    const keys = Object.keys(EDGE_TYPE_WEIGHTS).sort();
    expect(keys).toEqual(['contradicts', 'mentions', 'same_topic', 'supports', 'temporal_next']);
});
```

**Step 6:** `npm run test`, `npm run lint`, `npm run typecheck` → all green. Expected: ~213 tests (210 + 3 new).

**Step 7:**
```bash
git add src/core/constants.js tests/unit/core/constants.test.js
git commit -m "feat(core): add Phase 5 graph/Tier 3 constants"
```

---

## Task 1: Graph store + adjacency

**Objective:** Land `src/memory/graph.js`. Pure edge operations over `state.graph.edges` + a per-call adjacency builder for Tier 3's beam search.

**Files:**
- Create: `src/memory/graph.js`
- Create: `tests/unit/memory/graph.test.js`

### Behavior

`state.graph.edges` is a flat `Edge[]` (shape from `core/schema.js`: `{ from, to, type, weight }`). Operations:

- `addEdge(state, edge) → State` — pure, deduplicates on `(from, to, type)` tuple (updates weight on collision to the newer value).
- `removeEdge(state, from, to, type) → State` — pure, no-op on miss.
- `listEdges(state) → Edge[]` — convenience reader, returns a fresh array (not the live reference).
- `buildAdjacency(state) → Map<string, Edge[]>` — per-call in-memory cache. Keyed by `edge.from`. Called once at the top of `tier3()`.
- `neighborsOf(adjacency, entryId) → Edge[]` — cheap lookup, returns `[]` if no entries.

**Dedup rule:** `addEdge` checks for existing edges with identical `(from, to, type)` and replaces weight. Reverse-direction edges `(to, from)` are distinct — edges are directional (matches spec shape).

### Test

```javascript
import {
    addEdge,
    removeEdge,
    listEdges,
    buildAdjacency,
    neighborsOf,
} from '../../../src/memory/graph.js';
import { createEmptyState } from '../../../src/core/schema.js';

function edge(from, to, type = 'mentions', weight = 0.5) {
    return { from, to, type, weight };
}

function seed(edges = []) {
    const s = createEmptyState();
    s.graph.edges = edges;
    return s;
}

describe('addEdge', () => {
    test('adds to empty graph', () => {
        const s = addEdge(createEmptyState(), edge('a', 'b'));
        expect(s.graph.edges).toHaveLength(1);
        expect(s.graph.edges[0]).toEqual(edge('a', 'b'));
    });

    test('is pure (returns new state)', () => {
        const s = createEmptyState();
        const before = structuredClone(s);
        addEdge(s, edge('a', 'b'));
        expect(s).toEqual(before);
    });

    test('dedupes on (from, to, type), updating weight', () => {
        let s = addEdge(createEmptyState(), edge('a', 'b', 'mentions', 0.3));
        s = addEdge(s, edge('a', 'b', 'mentions', 0.9));
        expect(s.graph.edges).toHaveLength(1);
        expect(s.graph.edges[0].weight).toBe(0.9);
    });

    test('keeps different types between same nodes distinct', () => {
        let s = addEdge(createEmptyState(), edge('a', 'b', 'mentions'));
        s = addEdge(s, edge('a', 'b', 'same_topic'));
        expect(s.graph.edges).toHaveLength(2);
    });

    test('keeps reverse-direction edges distinct', () => {
        let s = addEdge(createEmptyState(), edge('a', 'b', 'mentions'));
        s = addEdge(s, edge('b', 'a', 'mentions'));
        expect(s.graph.edges).toHaveLength(2);
    });
});

describe('removeEdge', () => {
    test('removes matching edge', () => {
        const s = seed([edge('a', 'b'), edge('a', 'c')]);
        const next = removeEdge(s, 'a', 'b', 'mentions');
        expect(next.graph.edges).toHaveLength(1);
        expect(next.graph.edges[0].to).toBe('c');
    });

    test('no-op on miss returns new state', () => {
        const s = seed([edge('a', 'b')]);
        const next = removeEdge(s, 'x', 'y', 'mentions');
        expect(next.graph.edges).toHaveLength(1);
        expect(next).not.toBe(s);
    });

    test('is pure', () => {
        const s = seed([edge('a', 'b')]);
        const before = structuredClone(s);
        removeEdge(s, 'a', 'b', 'mentions');
        expect(s).toEqual(before);
    });

    test('only removes exact type match', () => {
        const s = seed([edge('a', 'b', 'mentions'), edge('a', 'b', 'same_topic')]);
        const next = removeEdge(s, 'a', 'b', 'mentions');
        expect(next.graph.edges).toHaveLength(1);
        expect(next.graph.edges[0].type).toBe('same_topic');
    });
});

describe('listEdges', () => {
    test('returns a fresh array', () => {
        const s = seed([edge('a', 'b')]);
        const out = listEdges(s);
        expect(out).toEqual([edge('a', 'b')]);
        expect(out).not.toBe(s.graph.edges);
    });

    test('empty state yields empty array', () => {
        expect(listEdges(createEmptyState())).toEqual([]);
    });
});

describe('buildAdjacency', () => {
    test('empty state yields empty map', () => {
        expect(buildAdjacency(createEmptyState()).size).toBe(0);
    });

    test('groups edges by from-id', () => {
        const s = seed([
            edge('a', 'b'),
            edge('a', 'c'),
            edge('b', 'c'),
        ]);
        const adj = buildAdjacency(s);
        expect(adj.get('a')).toHaveLength(2);
        expect(adj.get('b')).toHaveLength(1);
        expect(adj.get('c')).toBeUndefined();
    });

    test('returned arrays are independent of state.graph.edges', () => {
        const s = seed([edge('a', 'b')]);
        const adj = buildAdjacency(s);
        adj.get('a').push(edge('a', 'x'));
        expect(s.graph.edges).toHaveLength(1);
    });
});

describe('neighborsOf', () => {
    test('returns edges for an id present in the adjacency', () => {
        const adj = new Map([['a', [edge('a', 'b'), edge('a', 'c')]]]);
        expect(neighborsOf(adj, 'a')).toHaveLength(2);
    });

    test('returns empty array for missing id', () => {
        const adj = new Map([['a', [edge('a', 'b')]]]);
        expect(neighborsOf(adj, 'nope')).toEqual([]);
    });
});
```

### Implementation

```javascript
/**
 * Graph store. Pure edge operations over `state.graph.edges` plus a
 * per-call adjacency builder for Tier 3's beam search. Edges are
 * directional; dedup key is (from, to, type).
 *
 * Persisted shape lives in state.graph.edges per spec §3.2. Adjacency is
 * NOT persisted — rebuilt at Tier 3 entry, same pattern as the BM25 index.
 *
 * @module memory/graph
 * @see docs/specs/2026-04-20-starmem-v2-design.md §4
 */

/**
 * Add or update an edge. Dedupes on (from, to, type): if an edge with
 * identical keys exists, its weight is replaced by the new edge's weight.
 * Reverse-direction and different-type edges stay distinct.
 *
 * @param {import('../core/schema.js').State} state
 * @param {import('../core/schema.js').Edge} edge
 * @returns {import('../core/schema.js').State}
 */
export function addEdge(state, edge) {
    const existing = state.graph.edges;
    const nextEdges = [];
    let replaced = false;
    for (const e of existing) {
        if (e.from === edge.from && e.to === edge.to && e.type === edge.type) {
            nextEdges.push({ ...edge });
            replaced = true;
        } else {
            nextEdges.push(e);
        }
    }
    if (!replaced) nextEdges.push({ ...edge });
    return {
        ...state,
        graph: { ...state.graph, edges: nextEdges },
    };
}

/**
 * Remove an edge matching (from, to, type). No-op on miss; still returns a
 * new state object for API consistency.
 *
 * @param {import('../core/schema.js').State} state
 * @param {string} from
 * @param {string} to
 * @param {import('../core/schema.js').EdgeType} type
 * @returns {import('../core/schema.js').State}
 */
export function removeEdge(state, from, to, type) {
    return {
        ...state,
        graph: {
            ...state.graph,
            edges: state.graph.edges.filter(
                e => !(e.from === from && e.to === to && e.type === type),
            ),
        },
    };
}

/**
 * Convenience reader. Returns a fresh array so callers can mutate freely.
 *
 * @param {import('../core/schema.js').State} state
 * @returns {import('../core/schema.js').Edge[]}
 */
export function listEdges(state) {
    return [...state.graph.edges];
}

/**
 * Build a per-call adjacency index. O(|edges|). Called once at the top of
 * Tier 3; NOT persisted.
 *
 * @param {import('../core/schema.js').State} state
 * @returns {Map<string, import('../core/schema.js').Edge[]>}
 */
export function buildAdjacency(state) {
    /** @type {Map<string, import('../core/schema.js').Edge[]>} */
    const adj = new Map();
    for (const e of state.graph.edges) {
        const bucket = adj.get(e.from);
        if (bucket) {
            bucket.push(e);
        } else {
            adj.set(e.from, [e]);
        }
    }
    return adj;
}

/**
 * Look up neighbors of an entry id in a prebuilt adjacency. Returns the
 * stored array unchanged (Tier 3 treats it as read-only).
 *
 * @param {Map<string, import('../core/schema.js').Edge[]>} adjacency
 * @param {string} entryId
 * @returns {import('../core/schema.js').Edge[]}
 */
export function neighborsOf(adjacency, entryId) {
    return adjacency.get(entryId) ?? [];
}
```

### Steps

1. Write test file (TDD).
2. Run → fail with module-not-found.
3. Implement.
4. All tests pass.
5. Lint, typecheck green.
6. Commit: `feat(memory): add graph store with pure edge ops and adjacency builder`.

Expected: ~15 new tests.

---

## Task 2: Edge builder — explicit relations + co-occurrence + cap

**Objective:** Land `src/memory/edgeBuilder.js`. Pure: given one entry and the full corpus, return the edges to add and any edges that must be evicted to keep each source under `EDGE_CAP_PER_ENTRY`. Phase 6's `consolidate()` applies both.

**Files:**
- Create: `src/memory/edgeBuilder.js`
- Create: `tests/unit/memory/edgeBuilder.test.js`

### Behavior

Single public function:

```
buildEdges(entry, allEntries, state):
    1. Edges from entry.relations → { from: entry.id, to: rel.target, type: rel.type, weight: EXPLICIT_RELATION_WEIGHT }
    2. Co-occurrence edges from entity overlap:
        myEntities = extractEntities(entry.content)   // Set<string> (case-preserving; comparison is case-sensitive to avoid "alice" vs "Alice" collisions from quoted/lower speech)
        for each other entry o in allEntries where o.id !== entry.id AND o.scope !== 'working':
            otherEntities = extractEntities(o.content)
            if |myEntities ∩ otherEntities| >= 1:
                emit { from: entry.id, to: o.id, type: 'mentions', weight: COOCCURRENCE_WEIGHT }
    3. Merge candidate list. Dedupe on (from, to, type); explicit relations win over co-occurrence (higher weight is kept).
    4. Enforce cap per source:
        existingFromEntry = state.graph.edges.filter(e => e.from === entry.id)
        combined = existingFromEntry + newCandidates (after dedup step 3)
        sort by weight desc, then by position (stable, so newer/explicit come first in ties)
        if combined.length > EDGE_CAP_PER_ENTRY: evicted = combined.slice(EDGE_CAP_PER_ENTRY)
        otherwise: evicted = []
        newEdges = newCandidates that aren't already in existingFromEntry by (from, to, type)
    5. Return { newEdges, evicted }.
```

**Subtlety on step 4:** The cap applies to the combined set. If the new candidates push existing edges over the cap, older low-weight existing edges may end up evicted. That matches the spec §12.2 resolution ("prefer recent and higher-weight edges"). `consolidate()` in Phase 6 will call `addEdge` for each `newEdges` entry and `removeEdge` for each `evicted` entry inside the write lock, and invalidate Tier 0 once.

**Entity extractor (exported for tests):**

```javascript
const ENTITY_RE = /\b[A-Z][a-z]{2,}\b/g;
export function extractEntities(text) {
    if (typeof text !== 'string') return [];
    const matches = text.match(ENTITY_RE);
    return matches ? Array.from(new Set(matches)) : [];
}
```

`/\b[A-Z][a-z]{2,}\b/g` — capital letter followed by ≥2 lowercase letters. Skips "A", "I", "The" (only 2 lowercase), keeps "Alice", "Bob", "Marseille", "Paris". Case-sensitive comparison means "alice" in quoted speech doesn't collide with "Alice" in narration — a deliberate choice; false-negatives are safer than false-positives at this stage.

**Critical invariant:** `buildEdges` never mutates `state` or `entry` or `allEntries`. It's a read-only function that returns the work to do.

### Test

```javascript
import { buildEdges, extractEntities } from '../../../src/memory/edgeBuilder.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import { RETRIEVAL } from '../../../src/core/constants.js';

const { EDGE_CAP_PER_ENTRY, EXPLICIT_RELATION_WEIGHT, COOCCURRENCE_WEIGHT } = RETRIEVAL;

function ep(id, content, relations = [], scope = 'episodic') {
    const e = createEntry({
        scope, content, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...e, id, relations };
}

function seedStateWithEdges(edges = []) {
    const s = createEmptyState();
    s.graph.edges = edges;
    return s;
}

describe('extractEntities', () => {
    test('matches capitalized words with ≥3 lowercase chars', () => {
        expect(extractEntities('Alice met Bob in Marseille')).toEqual(
            expect.arrayContaining(['Alice', 'Bob', 'Marseille']),
        );
    });

    test('skips sentence-start "The", "A", "I"', () => {
        const ents = extractEntities('The quick brown fox. A lazy dog. I saw it.');
        expect(ents).not.toContain('The');
        expect(ents).not.toContain('A');
        expect(ents).not.toContain('I');
    });

    test('deduplicates', () => {
        expect(extractEntities('Alice and Alice')).toEqual(['Alice']);
    });

    test('empty / non-string input', () => {
        expect(extractEntities('')).toEqual([]);
        expect(extractEntities(/** @type {any} */ (null))).toEqual([]);
    });

    test('case-sensitive (does not fold "alice" into "Alice")', () => {
        expect(extractEntities('alice met Alice')).toEqual(['Alice']);
    });
});

describe('buildEdges — explicit relations', () => {
    test('emits edges for each @relations entry, weight=EXPLICIT_RELATION_WEIGHT', () => {
        const a = ep('a1', 'plain content', [
            { type: 'supports', target: 'b2' },
            { type: 'same_topic', target: 'c3' },
        ]);
        const { newEdges, evicted } = buildEdges(a, [a], createEmptyState());
        expect(newEdges).toEqual(expect.arrayContaining([
            { from: 'a1', to: 'b2', type: 'supports', weight: EXPLICIT_RELATION_WEIGHT },
            { from: 'a1', to: 'c3', type: 'same_topic', weight: EXPLICIT_RELATION_WEIGHT },
        ]));
        expect(evicted).toEqual([]);
    });

    test('empty relations → no explicit edges', () => {
        const a = ep('a1', 'plain content', []);
        const { newEdges } = buildEdges(a, [a], createEmptyState());
        const explicit = newEdges.filter(e => e.weight === EXPLICIT_RELATION_WEIGHT);
        expect(explicit).toEqual([]);
    });
});

describe('buildEdges — co-occurrence', () => {
    test('emits mentions edge when two entries share an entity', () => {
        const a = ep('a1', 'Alice lives in Marseille');
        const b = ep('b2', 'Alice moved to Paris');
        const { newEdges } = buildEdges(a, [a, b], createEmptyState());
        const coocc = newEdges.filter(e => e.weight === COOCCURRENCE_WEIGHT);
        expect(coocc).toContainEqual({
            from: 'a1', to: 'b2', type: 'mentions', weight: COOCCURRENCE_WEIGHT,
        });
    });

    test('no edge when entities disjoint', () => {
        const a = ep('a1', 'Alice in Marseille');
        const b = ep('b2', 'Bob in Tokyo');
        const { newEdges } = buildEdges(a, [a, b], createEmptyState());
        expect(newEdges.every(e => e.to !== 'b2')).toBe(true);
    });

    test('does not emit self-edge', () => {
        const a = ep('a1', 'Alice and Alice');
        const { newEdges } = buildEdges(a, [a], createEmptyState());
        expect(newEdges.every(e => e.to !== 'a1')).toBe(true);
    });

    test('skips working-scope entries', () => {
        const a = ep('a1', 'Alice in Marseille');
        const w = ep('w1', 'Alice is here', [], 'working');
        const { newEdges } = buildEdges(a, [a, w], createEmptyState());
        expect(newEdges.every(e => e.to !== 'w1')).toBe(true);
    });
});

describe('buildEdges — merge and precedence', () => {
    test('explicit relation wins over co-occurrence for same (from, to, type)', () => {
        const a = ep('a1', 'Alice lives here', [{ type: 'mentions', target: 'b2' }]);
        const b = ep('b2', 'Alice visits');
        const { newEdges } = buildEdges(a, [a, b], createEmptyState());
        const aliceToB = newEdges.filter(e => e.from === 'a1' && e.to === 'b2' && e.type === 'mentions');
        expect(aliceToB).toHaveLength(1);
        expect(aliceToB[0].weight).toBe(EXPLICIT_RELATION_WEIGHT);
    });

    test('keeps different types between same nodes distinct', () => {
        const a = ep('a1', 'Alice meets Bob', [{ type: 'supports', target: 'b2' }]);
        const b = ep('b2', 'Alice was there');   // co-occurrence on "Alice"
        const { newEdges } = buildEdges(a, [a, b], createEmptyState());
        const types = newEdges.filter(e => e.from === 'a1' && e.to === 'b2').map(e => e.type).sort();
        expect(types).toEqual(['mentions', 'supports']);
    });
});

describe('buildEdges — cap enforcement', () => {
    test('under-cap: no eviction', () => {
        const a = ep('a1', 'Alice');
        // seed state with 5 existing edges from a1
        const seeded = seedStateWithEdges(
            Array.from({ length: 5 }, (_, i) => ({
                from: 'a1', to: `x${i}`, type: 'mentions', weight: 0.5,
            })),
        );
        const b = ep('b2', 'Alice visits');  // adds one co-occurrence edge
        const { newEdges, evicted } = buildEdges(a, [a, b], seeded);
        expect(evicted).toEqual([]);
        expect(newEdges.length).toBe(1);
    });

    test('over-cap: evicts lowest-weight existing edges', () => {
        const a = ep('a1', 'Alice', [{ type: 'supports', target: 'b2' }]);
        // seed state with EDGE_CAP_PER_ENTRY low-weight edges from a1
        const seeded = seedStateWithEdges(
            Array.from({ length: EDGE_CAP_PER_ENTRY }, (_, i) => ({
                from: 'a1', to: `old${i}`, type: 'mentions', weight: 0.1,
            })),
        );
        const b = ep('b2', 'plain');
        const { newEdges, evicted } = buildEdges(a, [a, b], seeded);
        // New explicit edge has weight 1.0 > 0.1 existing → one old edge must go
        expect(newEdges.length).toBeGreaterThan(0);
        expect(evicted.length).toBeGreaterThan(0);
        // Total should land at cap
        const remainingExisting = EDGE_CAP_PER_ENTRY - evicted.length;
        expect(remainingExisting + newEdges.length).toBeLessThanOrEqual(EDGE_CAP_PER_ENTRY);
    });

    test('prefers higher-weight edges when evicting', () => {
        const a = ep('a1', 'Alice', [{ type: 'supports', target: 'new' }]);
        // seed with one high-weight (0.9) and many low-weight (0.1) edges
        const seeded = seedStateWithEdges([
            { from: 'a1', to: 'hi', type: 'mentions', weight: 0.9 },
            ...Array.from({ length: EDGE_CAP_PER_ENTRY - 1 }, (_, i) => ({
                from: 'a1', to: `lo${i}`, type: 'mentions', weight: 0.1,
            })),
        ]);
        const { evicted } = buildEdges(a, [a], seeded);
        // High-weight edge must NOT be evicted
        expect(evicted.every(e => e.to !== 'hi')).toBe(true);
    });
});

describe('buildEdges — purity', () => {
    test('does not mutate state, entry, or allEntries', () => {
        const a = ep('a1', 'Alice', [{ type: 'mentions', target: 'b2' }]);
        const b = ep('b2', 'Alice');
        const all = [a, b];
        const state = seedStateWithEdges([{ from: 'a1', to: 'c3', type: 'mentions', weight: 0.5 }]);
        const entryBefore = structuredClone(a);
        const allBefore = structuredClone(all);
        const stateBefore = structuredClone(state);
        buildEdges(a, all, state);
        expect(a).toEqual(entryBefore);
        expect(all).toEqual(allBefore);
        expect(state).toEqual(stateBefore);
    });
});
```

### Implementation

```javascript
/**
 * Edge builder. Pure function from (entry, allEntries, state) to the
 * newEdges / evicted pair. Phase 6's consolidate() applies both inside the
 * write lock.
 *
 * Sources of edges:
 *  1. Explicit @relations in extracted entries (weight = EXPLICIT_RELATION_WEIGHT)
 *  2. Entity co-occurrence via capitalized-noun match (weight = COOCCURRENCE_WEIGHT,
 *     type = 'mentions')
 *
 * contradicts edges are reserved in schema but never emitted here — spec §11.
 *
 * @module memory/edgeBuilder
 * @see docs/specs/2026-04-20-starmem-v2-design.md §4, §6.3, §11, §12.2
 */

import { RETRIEVAL } from '../core/constants.js';

const {
    EDGE_CAP_PER_ENTRY,
    EXPLICIT_RELATION_WEIGHT,
    COOCCURRENCE_WEIGHT,
} = RETRIEVAL;

const ENTITY_RE = /\b[A-Z][a-z]{2,}\b/g;

/**
 * Extract capitalized-noun entities from text. Case-sensitive; deduplicated.
 * Filters out sentence-start "A", "I", "The" by requiring ≥3 lowercase chars.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractEntities(text) {
    if (typeof text !== 'string') return [];
    const matches = text.match(ENTITY_RE);
    return matches ? Array.from(new Set(matches)) : [];
}

/**
 * @typedef {import('../core/schema.js').Edge} Edge
 * @typedef {import('../core/schema.js').Entry} Entry
 * @typedef {import('../core/schema.js').State} State
 */

/**
 * Build edges for `entry` against the corpus. Pure; returns the edges to
 * add and any existing edges from this source that must be evicted to stay
 * under EDGE_CAP_PER_ENTRY.
 *
 * @param {Entry} entry
 * @param {Entry[]} allEntries
 * @param {State} state
 * @returns {{ newEdges: Edge[], evicted: Edge[] }}
 */
export function buildEdges(entry, allEntries, state) {
    /** @type {Edge[]} */
    const candidates = [];

    // 1. Explicit relations
    for (const rel of entry.relations) {
        candidates.push({
            from: entry.id,
            to: rel.target,
            type: rel.type,
            weight: EXPLICIT_RELATION_WEIGHT,
        });
    }

    // 2. Co-occurrence
    const myEntities = new Set(extractEntities(entry.content));
    if (myEntities.size > 0) {
        for (const other of allEntries) {
            if (other.id === entry.id) continue;
            if (other.scope === 'working') continue;
            const otherEntities = extractEntities(other.content);
            let overlap = false;
            for (const e of otherEntities) {
                if (myEntities.has(e)) { overlap = true; break; }
            }
            if (overlap) {
                candidates.push({
                    from: entry.id,
                    to: other.id,
                    type: 'mentions',
                    weight: COOCCURRENCE_WEIGHT,
                });
            }
        }
    }

    // 3. Dedup candidates by (from, to, type); keep highest weight (explicit wins)
    /** @type {Map<string, Edge>} */
    const dedup = new Map();
    for (const c of candidates) {
        const key = `${c.from}\u0000${c.to}\u0000${c.type}`;
        const prev = dedup.get(key);
        if (!prev || c.weight > prev.weight) dedup.set(key, c);
    }
    const merged = Array.from(dedup.values());

    // 4. Cap enforcement on combined (existing + new) edges from this source
    const existingFromEntry = state.graph.edges.filter(e => e.from === entry.id);
    const existingKeys = new Set(
        existingFromEntry.map(e => `${e.from}\u0000${e.to}\u0000${e.type}`),
    );
    const newEdges = merged.filter(
        e => !existingKeys.has(`${e.from}\u0000${e.to}\u0000${e.type}`),
    );

    // Stable sort by weight desc; existing edges break ties before new ones
    // (tag each with an origin marker, sort, then drop the tag)
    const tagged = [
        ...existingFromEntry.map(e => ({ edge: e, isExisting: true })),
        ...newEdges.map(e => ({ edge: e, isExisting: false })),
    ];
    tagged.sort((a, b) => {
        if (b.edge.weight !== a.edge.weight) return b.edge.weight - a.edge.weight;
        // At equal weight, keep new edges first (fresher info)
        return (a.isExisting ? 1 : 0) - (b.isExisting ? 1 : 0);
    });
    const keep = tagged.slice(0, EDGE_CAP_PER_ENTRY);
    const drop = tagged.slice(EDGE_CAP_PER_ENTRY);

    const keptKeys = new Set(
        keep.map(t => `${t.edge.from}\u0000${t.edge.to}\u0000${t.edge.type}`),
    );
    const evicted = existingFromEntry.filter(
        e => !keptKeys.has(`${e.from}\u0000${e.to}\u0000${e.type}`),
    );
    const finalNewEdges = newEdges.filter(
        e => keptKeys.has(`${e.from}\u0000${e.to}\u0000${e.type}`),
    );
    // Edges in `drop` that are new (not existing) simply aren't returned in newEdges —
    // they're discarded rather than evicted.

    return { newEdges: finalNewEdges, evicted };
}
```

### Steps

1. Write tests (TDD).
2. Run → fail with module-not-found.
3. Implement `edgeBuilder.js`.
4. All tests pass. The cap-eviction logic is the tricky piece — verify "prefers higher-weight" and "under-cap no-eviction" cases green before moving on.
5. Lint, typecheck green.
6. Commit: `feat(memory): add pure edgeBuilder with cap enforcement per spec §12.2`.

Expected: ~18 new tests.

---

## Task 3: Tier 3 — intent-routed beam search

**Objective:** Land `src/retrieval/tier3-graph.js`. Beam search from Tier 2's seeds across 1–2 hops through the adjacency, scoring each reachable neighbor by `exp(λ₁·edge_type_match + λ₂·BM25)`, merging with seeds, reranking under the multiplicative scorer, returning top-K. Spec §5.1.

**Files:**
- Create: `src/retrieval/tier3-graph.js`
- Create: `tests/unit/retrieval/tier3-graph.test.js`

### Algorithm

```
tier3(state, seeds, queryStr, intent, { now, k = 5 }):
    if seeds.length === 0: return []

    adjacency = buildAdjacency(state)
    index = buildIndex(non-working entries)       // BM25 for λ₂ term
    scorer = getScorer()

    // Beam search, 1–2 hops. Seeds are hop 0.
    // Per hop, expand each frontier entry's neighbors, score them, keep top B.
    frontier = seeds.map(s => ({ entry: s, hop: 0 }))
    discovered = Map<id, { entry, hop }>    // seed ids included
    for s of seeds: discovered.set(s.id, { entry: s, hop: 0 })

    for hop in 1..TIER3_MAX_HOPS:
        candidates = []
        for item of frontier:
            for edge of neighborsOf(adjacency, item.entry.id):
                if discovered.has(edge.to): continue
                neighbor = state.entries[edge.to]
                if !neighbor || neighbor.scope === 'working': continue
                edgeWeight = EDGE_TYPE_WEIGHTS[edge.type]?.[intent] ?? 0
                bm25 = bm25ScoreFor(index, neighbor, queryStr)    // use the index.docs[id] path
                beamScore = Math.exp(λ₁ * edgeWeight + λ₂ * bm25)
                candidates.push({ entry: neighbor, bm25, beamScore, hop })
        // Top B per hop
        candidates.sort((a, b) => b.beamScore - a.beamScore)
        topOfHop = candidates.slice(0, TIER3_BEAM_WIDTH)
        for t of topOfHop: discovered.set(t.entry.id, { entry: t.entry, hop: t.hop })
        frontier = topOfHop.map(t => ({ entry: t.entry, hop: t.hop }))
        if frontier.length === 0: break

    // Rescore everyone discovered under the multiplicative scorer,
    // using per-entry BM25 (seeds already have bm25 via Tier 2 passing them
    // as Entry[]—but we don't have it. Compute fresh.)
    merged = Array.from(discovered.values())
    final = merged.map(({ entry }) => {
        const bm25 = bm25ScoreFor(index, entry, queryStr)
        const score = scorer(entry, queryStr, { now, bm25, intent })
        return { entry, bm25, score }
    })
    final.sort((a, b) => b.score - a.score)
    return final.filter(r => r.score > 0).slice(0, k)
```

**Helper: `bm25ScoreFor(index, entry, queryStr)`** — compute the BM25 contribution for a single known entry. Either:

- **Option A (simpler):** call `query(index, queryStr, index.totalDocs)` once and build a `Map<id, bm25>` lookup. Wasteful if we only need ~20 entries' scores.
- **Option B (cheaper):** expose a new `bm25For(index, entry, queryStr)` function in `bm25.js`. Single-entry scoring, reuses the same term loop.

**Going with A** for v2.0. Simpler, one new bm25.js function (`query`) already exists, and 100ms budget is plenty for a single full query. If Phase 9 shows Tier 3 latency blowing the budget, promote to B.

Concretely:
```
const rawAll = bm25Query(index, queryStr, index.totalDocs || 1000000)
const bm25Map = new Map(rawAll.map(r => [r.entry.id, r.bm25]))
function bm25Of(id) { return bm25Map.get(id) ?? 0 }
```

### Test

```javascript
import { tier3 } from '../../../src/retrieval/tier3-graph.js';
import {
    _resetScorerForTests,
    registerScorer,
    setScorer,
} from '../../../src/retrieval/scorer.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';

function ep(id, content, overrides = {}) {
    const base = createEntry({
        scope: 'episodic', content, subject: null, tags: [],
        provenance: { sourceMessages: [], extractor: 'test' },
        now: new Date('2026-04-20T12:00:00Z'),
    });
    return { ...base, id, ...overrides };
}

function seed(entries, edges = []) {
    const s = createEmptyState();
    for (const e of entries) s.entries[e.id] = e;
    s.graph.edges = edges;
    return s;
}

const now = new Date('2026-04-20T12:00:00Z');

describe('tier3', () => {
    afterEach(() => _resetScorerForTests());

    test('empty seeds → empty result', () => {
        const s = seed([ep('a', 'Alice')]);
        expect(tier3(s, [], 'alice', 'factual', { now })).toEqual([]);
    });

    test('no edges → returns only seeds reranked', () => {
        const s = seed([
            ep('a', 'Alice Marseille'),
            ep('b', 'Bob Paris'),
        ]);
        const result = tier3(s, [s.entries['a']], 'alice marseille', 'factual', { now });
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].entry.id).toBe('a');
    });

    test('expands 1 hop to neighbor via mentions edge', () => {
        const s = seed(
            [
                ep('a', 'Alice Marseille'),
                ep('b', 'Alice Paris'),
            ],
            [{ from: 'a', to: 'b', type: 'mentions', weight: 0.5 }],
        );
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        const ids = result.map(r => r.entry.id);
        expect(ids).toContain('a');
        expect(ids).toContain('b');
    });

    test('respects 2-hop max', () => {
        const s = seed(
            [
                ep('a', 'Alice'),
                ep('b', 'Bob'),
                ep('c', 'Carol'),
                ep('d', 'Dan'),         // 3 hops from a — should NOT appear
            ],
            [
                { from: 'a', to: 'b', type: 'mentions', weight: 0.9 },
                { from: 'b', to: 'c', type: 'mentions', weight: 0.9 },
                { from: 'c', to: 'd', type: 'mentions', weight: 0.9 },
            ],
        );
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        const ids = result.map(r => r.entry.id);
        expect(ids).toContain('a');
        expect(ids).toContain('b');
        expect(ids).toContain('c');
        expect(ids).not.toContain('d');
    });

    test('intent routing: temporal query prefers temporal_next edges', () => {
        // a -mentions-> b (weight table factual=0.7)
        // a -temporal_next-> c (weight table temporal=0.9)
        // On 'temporal' intent, c should score higher in beam than b.
        const s = seed(
            [
                ep('a', 'event one'),
                ep('b', 'unrelated topic'),
                ep('c', 'event two'),
            ],
            [
                { from: 'a', to: 'b', type: 'mentions', weight: 0.5 },
                { from: 'a', to: 'c', type: 'temporal_next', weight: 0.5 },
            ],
        );
        const factual = tier3(s, [s.entries['a']], 'event', 'factual', { now });
        const temporal = tier3(s, [s.entries['a']], 'event', 'temporal', { now });
        // Both queries likely return all three, but final ranking should differ.
        // On temporal intent, c should outrank b (or at least not rank worse).
        const fIdx = (arr, id) => arr.findIndex(r => r.entry.id === id);
        const factualBvsC = fIdx(factual, 'b') - fIdx(factual, 'c');
        const temporalBvsC = fIdx(temporal, 'b') - fIdx(temporal, 'c');
        // Positive value means c comes first. Temporal-intent should push c ahead more.
        expect(temporalBvsC).toBeGreaterThanOrEqual(factualBvsC);
    });

    test('beam width caps expansion per hop', () => {
        // Seed a with many neighbors — beam should cap to TIER3_BEAM_WIDTH (5) per hop.
        // We create 10 neighbors; with beam=5, only 5 survive the first hop.
        const neighbors = Array.from({ length: 10 }, (_, i) => ep(`n${i}`, `Alice neighbor${i}`));
        const edges = neighbors.map(n => ({
            from: 'a', to: n.id, type: 'mentions', weight: 0.5,
        }));
        const s = seed([ep('a', 'Alice'), ...neighbors], edges);
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        const nonSeed = result.filter(r => r.entry.id !== 'a');
        // At most TIER3_BEAM_WIDTH (5) non-seed entries should appear.
        expect(nonSeed.length).toBeLessThanOrEqual(5);
    });

    test('excludes working-scope entries from expansion', () => {
        const w = ep('w1', 'Alice', { scope: 'working' });
        const s = seed(
            [ep('a', 'Alice'), w],
            [{ from: 'a', to: 'w1', type: 'mentions', weight: 0.5 }],
        );
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        expect(result.every(r => r.entry.id !== 'w1')).toBe(true);
    });

    test('deduplicates: reaching same node via multiple paths counted once', () => {
        const s = seed(
            [ep('a', 'Alice'), ep('b', 'Bob'), ep('c', 'Carol')],
            [
                { from: 'a', to: 'c', type: 'mentions', weight: 0.5 },     // direct
                { from: 'a', to: 'b', type: 'mentions', weight: 0.5 },
                { from: 'b', to: 'c', type: 'mentions', weight: 0.5 },     // via b
            ],
        );
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        const cCount = result.filter(r => r.entry.id === 'c').length;
        expect(cCount).toBe(1);
    });

    test('respects k output cap', () => {
        const entries = Array.from({ length: 10 }, (_, i) => ep(`e${i}`, `Alice ${i}`));
        const edges = entries.slice(1).map(e => ({
            from: 'e0', to: e.id, type: 'mentions', weight: 0.5,
        }));
        const s = seed(entries, edges);
        const result = tier3(s, [s.entries['e0']], 'alice', 'factual', { now, k: 3 });
        expect(result).toHaveLength(3);
    });

    test('filters zero-scored candidates', () => {
        registerScorer('zeroEverything', () => 0);
        setScorer('zeroEverything');
        const s = seed([ep('a', 'Alice'), ep('b', 'Bob')], [
            { from: 'a', to: 'b', type: 'mentions', weight: 0.5 },
        ]);
        const result = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        expect(result).toEqual([]);
    });

    test('returns ScoredEntry shape { entry, bm25, score }', () => {
        const s = seed([ep('a', 'Alice Marseille')]);
        const [r] = tier3(s, [s.entries['a']], 'alice', 'factual', { now });
        expect(r).toHaveProperty('entry');
        expect(r).toHaveProperty('bm25');
        expect(r).toHaveProperty('score');
        expect(typeof r.bm25).toBe('number');
        expect(typeof r.score).toBe('number');
    });
});
```

### Implementation

```javascript
/**
 * Tier 3 — MAGMA-lite intent-routed graph expansion. Beam search 1–2 hops
 * from Tier 2's seeds through `state.graph.edges`, scoring neighbors with
 * exp(λ₁ · edge_type_match + λ₂ · BM25). Final merge with seeds, rescored
 * under the multiplicative scorer.
 *
 * @module retrieval/tier3-graph
 * @see docs/specs/2026-04-20-starmem-v2-design.md §5.1
 */

import { RETRIEVAL, EDGE_TYPE_WEIGHTS } from '../core/constants.js';
import { buildIndex, query as bm25Query } from './bm25.js';
import { getScorer } from './scorer.js';
import { buildAdjacency, neighborsOf } from '../memory/graph.js';

const {
    TIER3_LAMBDA_1,
    TIER3_LAMBDA_2,
    TIER3_MAX_HOPS,
    TIER3_BEAM_WIDTH,
} = RETRIEVAL;

/**
 * @typedef {import('../core/schema.js').State} State
 * @typedef {import('../core/schema.js').Entry} Entry
 * @typedef {import('./tier2-bm25.js').ScoredEntry} ScoredEntry
 * @typedef {'factual' | 'relational' | 'temporal'} Intent
 */

/**
 * @param {State} state
 * @param {Entry[]} seeds
 * @param {string} queryStr
 * @param {Intent} intent
 * @param {{ now: Date, k?: number }} ctx
 * @returns {ScoredEntry[]}
 */
export function tier3(state, seeds, queryStr, intent, ctx) {
    const { now, k = 5 } = ctx;
    if (!Array.isArray(seeds) || seeds.length === 0) return [];

    // Build indexes
    const adjacency = buildAdjacency(state);

    /** @type {Entry[]} */
    const nonWorking = [];
    for (const e of Object.values(state.entries)) {
        if (e.scope !== 'working') nonWorking.push(e);
    }
    if (nonWorking.length === 0) return [];
    const index = buildIndex(nonWorking);

    // One BM25 pass over the whole corpus; lookup map by entry id.
    const rawAll = bm25Query(index, queryStr, Math.max(nonWorking.length, 1));
    /** @type {Map<string, number>} */
    const bm25Map = new Map();
    for (const r of rawAll) bm25Map.set(r.entry.id, r.bm25);
    const bm25Of = (/** @type {string} */ id) => bm25Map.get(id) ?? 0;

    // Beam search
    /** @type {Map<string, { entry: Entry, hop: number }>} */
    const discovered = new Map();
    for (const s of seeds) {
        discovered.set(s.id, { entry: s, hop: 0 });
    }

    let frontier = seeds.map(s => ({ entry: s, hop: 0 }));

    for (let hop = 1; hop <= TIER3_MAX_HOPS; hop++) {
        /** @type {{ entry: Entry, beamScore: number, hop: number }[]} */
        const candidates = [];
        for (const item of frontier) {
            for (const edge of neighborsOf(adjacency, item.entry.id)) {
                if (discovered.has(edge.to)) continue;
                const neighbor = state.entries[edge.to];
                if (!neighbor) continue;
                if (neighbor.scope === 'working') continue;
                const weightTable = EDGE_TYPE_WEIGHTS[edge.type];
                const edgeWeight = weightTable ? weightTable[intent] ?? 0 : 0;
                const bm25 = bm25Of(neighbor.id);
                const beamScore = Math.exp(TIER3_LAMBDA_1 * edgeWeight + TIER3_LAMBDA_2 * bm25);
                candidates.push({ entry: neighbor, beamScore, hop });
            }
        }
        if (candidates.length === 0) break;
        candidates.sort((a, b) => b.beamScore - a.beamScore);
        const topOfHop = candidates.slice(0, TIER3_BEAM_WIDTH);
        for (const t of topOfHop) {
            if (!discovered.has(t.entry.id)) {
                discovered.set(t.entry.id, { entry: t.entry, hop: t.hop });
            }
        }
        frontier = topOfHop.map(t => ({ entry: t.entry, hop: t.hop }));
        if (frontier.length === 0) break;
    }

    // Rescore everyone under the active scorer
    const scorer = getScorer();
    /** @type {ScoredEntry[]} */
    const final = [];
    for (const { entry } of discovered.values()) {
        const bm25 = bm25Of(entry.id);
        const score = scorer(entry, queryStr, { now, bm25, intent });
        final.push({ entry, bm25, score });
    }
    final.sort((a, b) => b.score - a.score);
    return final.filter(r => r.score > 0).slice(0, k);
}
```

### Steps

1. Write tests (TDD).
2. Run → fail with module-not-found.
3. Implement. The beam search is the hairy piece — if a test fails, reason about what `discovered` looks like at each hop before patching.
4. All tests pass. Particularly the 2-hop-max test and the beam-width cap test — those catch off-by-one bugs.
5. Lint, typecheck green.
6. Commit: `feat(retrieval): add Tier 3 intent-routed beam search per spec §5.1`.

Expected: ~11 new tests.

---

## Task 4: Ladder integration — replace Tier 3 stub

**Objective:** Swap the identity stub in `src/retrieval/ladder.js` for a real `tier3()` call. Extend the integration test suite with an "ordering differs from Tier 2 seeds" assertion. This is the one task where `subagent-driven-development`'s reviews are NOT skipped — the ladder is the integration surface, and a subtle bug here corrupts every retrieval.

**Files:**
- Modify: `src/retrieval/ladder.js`
- Modify: `tests/integration/retrieval/ladder.test.js`

### Changes to ladder.js

Add import:
```javascript
import { tier3 } from './tier3-graph.js';
```

In the Tier 3 branch (currently `if (t2.scored.length > 0) { ... }`), replace the identity-stub body. The branch currently does:

```javascript
const topK = t2.scored.slice(0, k);
const entriesOnly = topK.map(r => r.entry);
// ... applies access events, prepends working, builds trace with perTier['3'] = tierDetails (copy of Tier 2) ...
```

New body:

```javascript
// --- Tier 3: intent-routed graph expansion ---
if (t2.scored.length > 0) {
    const seeds = t2.scored.slice(0, RETRIEVAL.TIER3_SEEDS_K).map(r => r.entry);
    const t3Scored = tier3(state, seeds, queryStr, classifier, { now, k });

    // Tier 3 fell flat (no scored outputs) — fall through to Floor
    if (t3Scored.length === 0) {
        return runFloorBranch(state, queryStr, classifier, scorerId, working, now, k, {
            perTier2: t2.scored.map(r => ({ id: r.entry.id, bm25: r.bm25, score: r.score })),
        });
    }

    const topK = t3Scored;
    const entriesOnly = topK.map(r => r.entry);
    let cached = recordTier0(state, queryStr, entriesOnly);
    cached = recordTier1(cached, queryStr, entriesOnly);
    const final = applyAccessEventsToReturned(cached, entriesOnly);
    const prepended = prependWorking(topK, working, now);
    const trace = buildTrace({
        timestamp: now.toISOString(),
        query: queryStr,
        classifier,
        tierResolved: 3,
        perTier: {
            '2': t2.scored.map(r => ({ id: r.entry.id, bm25: r.bm25, score: r.score })),
            '3': topK.map(r => ({ id: r.entry.id, bm25: r.bm25, score: r.score })),
        },
        finalRanking: prepended.map(r => r.entry.id),
        scorerId,
    });
    const nextState = logTrace(final.state, trace);
    return {
        entries: prepended.map(r => r.entry).slice(0, cap),
        tierResolved: 3,
        trace,
        state: nextState,
    };
}
```

Add the `RETRIEVAL` import:
```javascript
import { RETRIEVAL } from '../core/constants.js';
```

And factor the Floor branch into a helper `runFloorBranch(state, queryStr, classifier, scorerId, working, now, k, { perTier2 } = {})` so we can call it from both the final Floor step AND from the Tier 3 empty fallthrough case. The helper signature takes an optional `perTier2` so the trace can record what Tier 2 saw before we gave up. Existing Floor branch becomes `return runFloorBranch(state, queryStr, classifier, scorerId, working, now, k)`.

**Helper (append to ladder.js, before `retrieve`):**

```javascript
/**
 * Run the Floor branch of the ladder. Factored out so Tier 3 can fall through
 * to Floor when graph expansion yields nothing.
 *
 * @param {State} state
 * @param {string} queryStr
 * @param {'factual'|'relational'|'temporal'} classifier
 * @param {string} scorerId
 * @param {Entry[]} working
 * @param {Date} now
 * @param {number} k
 * @param {{ perTier2?: { id: string, bm25: number, score: number }[] }} [tracePrefix]
 * @returns {RetrieveResult}
 */
function runFloorBranch(state, queryStr, classifier, scorerId, working, now, k, tracePrefix = {}) {
    const floorResults = floor(state, { now, k });
    let s1 = state;
    if (floorResults.length > 0) {
        const final = applyAccessEventsToReturned(s1, floorResults.map(r => r.entry));
        s1 = final.state;
    }
    const prepended = prependWorking(floorResults, working, now);
    /** @type {Record<string, unknown>} */
    const perTier = {};
    if (tracePrefix.perTier2) perTier['2'] = tracePrefix.perTier2;
    const trace = buildTrace({
        timestamp: now.toISOString(),
        query: queryStr,
        classifier,
        tierResolved: 'floor',
        perTier,
        finalRanking: prepended.map(r => r.entry.id),
        scorerId,
    });
    const nextState = logTrace(s1, trace);
    return {
        entries: prepended.map(r => r.entry),
        tierResolved: 'floor',
        trace,
        state: nextState,
    };
}
```

### New integration tests

Append to `tests/integration/retrieval/ladder.test.js`:

```javascript
describe('retrieve — Tier 3 (real, Phase 5)', () => {
    afterEach(() => _resetScorerForTests());

    test('Tier 3 expands beyond Tier 2 seeds via graph edges', () => {
        // Flat scorer ensures Tier 2 misses exit condition → Tier 3 fires.
        registerScorer('flat', () => 1.0);
        setScorer('flat');
        const entries = [
            ep('a', 'Alice Marseille', 'alice', ['location']),
            ep('b', 'Alice Paris', 'alice', ['location']),
            ep('c', 'Bob Tokyo', 'bob', ['location']),  // not reachable by edges
        ];
        const s = seed(entries);
        // Add a→b edge so Tier 3 can pull b in
        s.graph.edges.push({ from: 'a', to: 'b', type: 'mentions', weight: 0.5 });
        const r = retrieve(s, 'alice', { now });
        expect(r.tierResolved).toBe(3);
        const ids = r.entries.map(e => e.id);
        expect(ids).toContain('a');
        expect(ids).toContain('b');
    });

    test("Tier 3 trace records its own perTier['3'] (not a copy of '2')", () => {
        registerScorer('flat', () => 1.0);
        setScorer('flat');
        const s = seed([
            ep('a', 'Alice Marseille'),
            ep('b', 'Alice Paris'),
        ]);
        s.graph.edges.push({ from: 'a', to: 'b', type: 'mentions', weight: 0.5 });
        const r = retrieve(s, 'alice', { now });
        expect(r.tierResolved).toBe(3);
        const perTier2 = r.trace.perTier['2'];
        const perTier3 = r.trace.perTier['3'];
        expect(Array.isArray(perTier2)).toBe(true);
        expect(Array.isArray(perTier3)).toBe(true);
        // The two lists may share members but must not be reference-equal.
        expect(perTier3).not.toBe(perTier2);
    });

    test('Tier 3 falls through to Floor when graph expansion yields nothing', () => {
        // Scorer that zeros everything Tier 3 might propose.
        // With flat 1.0 scorer pushing Tier 2 into Tier 3, and NO edges in the graph,
        // Tier 3's rerank returns only the seeds — which still have score > 0.
        // To actually get the fallthrough path we need Tier 3 to rescore to 0.
        // Swap to a scorer that returns 0 for everything — Tier 2's own zero-filter
        // kicks in FIRST, so Tier 3 never fires. That's not the path we want.
        //
        // Correct setup: a scorer that scores seeds flat enough for Tier 2 to miss
        // exit, but zeros out at Tier 3's rescore due to a specific entry property.
        //
        // Simpler approach: mock scorer that returns 1.0 on initial Tier 2 pass
        // (giving us Tier 3 entry) then 0 on all subsequent calls.
        let callCount = 0;
        registerScorer('onlyFirst', () => {
            callCount++;
            return callCount <= 3 ? 1.0 : 0;  // first 3 calls (Tier 2) get 1.0, rest zero
        });
        setScorer('onlyFirst');
        const s = seed([
            ep('a', 'Alice Marseille'),
            ep('b', 'Alice Paris'),
        ]);
        s.graph.edges.push({ from: 'a', to: 'b', type: 'mentions', weight: 0.5 });
        const r = retrieve(s, 'alice', { now });
        // Tier 2 misses exit (flat scores), Tier 3 fires, tier3's internal rescore
        // returns empty (all zero), ladder falls through to Floor.
        expect(r.tierResolved).toBe('floor');
    });

    test('Tier 3 resolution: access events fire on Tier 3 output only, not Tier 2 seeds', () => {
        registerScorer('flat', () => 1.0);
        setScorer('flat');
        const s = seed([
            ep('a', 'Alice Marseille'),
            ep('b', 'Alice Paris'),
            ep('c', 'Carol Tokyo'),    // NOT reachable; never returned
        ]);
        s.graph.edges.push({ from: 'a', to: 'b', type: 'mentions', weight: 0.5 });
        const r = retrieve(s, 'alice', { now, k: 2 });
        expect(r.tierResolved).toBe(3);
        const returnedIds = r.entries.map(e => e.id);
        for (const id of returnedIds) {
            expect(r.state.entries[id].lifecycle.accessCount).toBe(1);
        }
        expect(r.state.entries['c'].lifecycle.accessCount).toBe(0);
    });
});
```

**Note on the fallthrough test:** The scoring trick is finicky. If the subagent finds a cleaner way to force Tier 3 to return empty (e.g., a custom scorer that checks entry content for a marker), use it. The test's intent is: when Tier 3's output is `[]`, the ladder must resolve at `'floor'`, not leave us with no entries at Tier 3.

### Steps

1. Read current `src/retrieval/ladder.js` top-to-bottom before editing (it's ~230 lines; make sure you understand the five branches before touching anything).
2. Factor Floor branch into helper `runFloorBranch`. Before touching Tier 3, run `npm run test tests/integration/retrieval/ladder.test.js` — must still be all green (same behavior, refactored code).
3. Commit the refactor separately: `refactor(retrieval): factor Floor branch into runFloorBranch helper`.
4. Swap Tier 3 stub for real `tier3()` call + fallthrough-to-Floor logic.
5. Add new integration tests.
6. Run full test suite. Report any failures with the failing test name.
7. **DO NOT skip the review stages for this task.** After implementation, dispatch a spec-compliance reviewer:
   - `applyAccessEvent` still called at most once per returned entry?
   - `recordTier0`/`recordTier1` still called on Tier 3 resolutions?
   - Exactly one trace per `retrieve()` call, including the fallthrough-to-Floor path?
   - `prependWorking` still called exactly once?
   - `perTier['2']` AND `perTier['3']` both populated on Tier 3 hits (distinct arrays)?
   - Floor-with-Tier-2-prefix trace carries `perTier['2']` for diagnostics?
8. Fix any review findings, re-review.
9. Commit: `feat(retrieval): wire real Tier 3 into ladder with Floor fallthrough`.

Expected: integration tests grow from 9 to ~13.

---

## Task 5: Barrel + Phase 5 retro

**Objective:** Extend `src/retrieval/index.js` with the Tier 3 export, add a new `src/memory/index.js` barrel for the graph modules, append the Phase 5 retro to ROADMAP.md.

**Files:**
- Modify: `src/retrieval/index.js`
- Create: `src/memory/index.js` (NEW — Phase 5's memory layer gets its own barrel)
- Modify: `tests/unit/retrieval/index.test.js`
- Create: `tests/unit/memory/index.test.js`
- Modify: `docs/plans/ROADMAP.md`

### Retrieval barrel additions

```javascript
export { tier3 } from './tier3-graph.js';
```

### New memory barrel

`src/memory/index.js`:

```javascript
/**
 * Memory barrel. Single import surface for the graph infrastructure and
 * edge builder. Phase 6's consolidate() imports from here.
 *
 * @module memory
 * @see docs/specs/2026-04-20-starmem-v2-design.md §4
 */

export { createEntry, isValidEntry } from './entry.js';
export {
    addEdge,
    removeEdge,
    listEdges,
    buildAdjacency,
    neighborsOf,
} from './graph.js';
export { buildEdges, extractEntities } from './edgeBuilder.js';
```

(Adjust `createEntry`/`isValidEntry` names to match whatever `entry.js` actually exports; the subagent should check before writing.)

### Retro content (append to `docs/plans/ROADMAP.md`, above the Phase 4 retro)

```markdown
## Phase 5—YYYY-MM-DD

**What shipped:** Graph store (`src/memory/graph.js`, pure addEdge/removeEdge/listEdges + per-call buildAdjacency), pure edge builder (`src/memory/edgeBuilder.js`, explicit @relations + co-occurrence via `/\b[A-Z][a-z]{2,}\b/g`, cap at EDGE_CAP_PER_ENTRY=20 with weight-preferring eviction), Tier 3 intent-routed beam search (`src/retrieval/tier3-graph.js`, 2 hops × beam 5, edge-type×intent weights from spec §5.1 table), ladder integration replacing the Phase 4 identity stub, new memory barrel, extended retrieval barrel. N commits this phase plus plan + retro. [TEST COUNT] tests passing across [SUITE COUNT] suites.

**Decisions baked in from 2026-04-20 planning conversation:**

1. Edge weights: explicit @relations=1.0, co-occurrence=0.5.
2. Co-occurrence edge type: `mentions`.
3. Beam width B=5 (opening value, Phase 9 tunes).
4. Edge cap per source=20 (spec §12.2 resolution), weight-preferring eviction.
5. Adjacency built per-call, not persisted (BM25 index precedent).
6. Entity matcher: `/\b[A-Z][a-z]{2,}\b/g`, case-sensitive, skips "A"/"I"/"The".
7. Tier 3 gating: always fires when Tier 2 has seeds and missed exit. Intent steers edge weights, doesn't gate.
8. Tier 3 trace: `perTier['3']` is the Tier-3-specific output, `perTier['2']` is Tier 2's scored list; both present on Tier 3 hits.
9. Tier 3 output cap: `k` from ladder (default 5).
10. `contradicts` edges reserved, never emitted.
11. `buildEdges` is pure, returns `{ newEdges, evicted }`; Phase 6 applies.

**Surprises:** [fill in live]

**Notes for Phase 6 (Consolidation):**

- `buildEdges(entry, allEntries, state) → { newEdges, evicted }` is the contract. Inside the write lock, iterate newEdges → `addEdge(state, e)`, iterate evicted → `removeEdge(state, e.from, e.to, e.type)`, then call `invalidateTier0Cache(state)` once at the end of the batch.
- The entity matcher is case-sensitive. If Phase 9 traces show missed relationships because "alice" in dialogue doesn't match "Alice" in narration, lift the case-sensitivity in `extractEntities` at the cost of some false positives. Defer until measured.
- Edge cap enforcement happens at buildEdges time, not in graph.js. If Phase 6 ever adds an edge via a path other than buildEdges (e.g., a manual UI action), it needs its own cap check.

**Notes for Phase 8 (SillyTavern Integration):**

- Memory Viewer's Graph tab renders `state.graph.edges`. Typical scales: ~5-20 edges per entry × a few hundred entries = a few thousand edges. A simple force-directed layout should handle that; no pagination needed in v2.0.
- Tier 3 trace's `perTier['3']` already exposes the scored beam-search output. Traces tab can render it alongside Tier 2's seeds to show "what the graph added."

**Notes for Phase 9 (Benchmarking):**

- λ₁=1.0 / λ₂=0.3 is the spec default. First thing to tune against LoCoMo — these govern how much the graph earns over pure BM25.
- Beam width 5 × 2 hops is an educated guess. If benchmarks show Tier 3 under-expanding (low recall@k), bump to 10. If latency blows, drop to 3.
- Co-occurrence weight 0.5 vs explicit 1.0 is a 2× ratio. If Phase 9 shows explicit-relation corpora outperforming co-occurrence heavily, widen the gap (0.3 vs 1.0). If both carry similar signal, narrow it (0.7 vs 1.0).
- Edge cap=20 was a guess from §12.2. Traces will show per-entry edge counts; if the cap is binding on >20% of entries, the cap is too tight.
- AdaMem ablation claims graph expansion is worth 2.02 F1. If our Phase 9 numbers on a matched benchmark show <0.5 F1 lift vs Tier-2-only, something is structurally wrong with the beam search or edge-weight routing — do NOT tune λ values to paper over a structural bug.
```

### Steps

1. Inspect `src/memory/entry.js` to confirm its actual exports (`createEntry`, `isValidEntry`, or something else). Adjust the new barrel accordingly.
2. Add Tier 3 to `src/retrieval/index.js` and the barrel test's `'exposes all public functions'` block (assert `typeof retrieval.tier3 === 'function'`).
3. Create `src/memory/index.js` + `tests/unit/memory/index.test.js` (mirror the retrieval barrel test pattern).
4. `npm run test`, `npm run lint`, `npm run typecheck` — green.
5. Commit: `feat(memory,retrieval): add Phase 5 barrel exports`.
6. Append retro to ROADMAP.md with live test counts and any surprises.
7. Commit: `docs(plans): Phase 5 retro`.

---

## Phase-boundary checklist

- [ ] Tier 3 uses ONLY pure functions over state + the in-memory adjacency/index — no state mutations outside the ladder.
- [ ] `buildEdges` is pure — no state mutation; returns the work for Phase 6 to apply.
- [ ] No LLM calls anywhere in `src/memory/` or `src/retrieval/tier3-graph.js` (spec §2 principle 1).
- [ ] `contradicts` edges never emitted by `edgeBuilder.js` (spec §11); only referenced in `EDGE_TYPE_WEIGHTS` constant for latent support.
- [ ] Every `retrieve()` call still emits exactly one trace (verify via `grep -c logTrace src/retrieval/ladder.js` matches expected branch count).
- [ ] `applyAccessEvent` still called at most once per returned entry.
- [ ] Working buffer still prepended exactly once per call, including the Tier 3 → Floor fallthrough path.
- [ ] `state.graph.edges` remains the authoritative store; adjacency is rebuilt per-call.
- [ ] All tests green, lint green, typecheck green.
- [ ] Each task committed separately; linear history.
- [ ] Spec §4, §5.1, §6.3 invariants satisfied.

---

## What this phase deliberately does NOT do

- **No consolidation.** Phase 6 wires `buildEdges` into the write lock alongside `extractFacts` and `invalidateTier0Cache`. Phase 5 produces the pure logic; Phase 6 applies it.
- **No drift detection.** `contradicts` edges are reserved but never emitted. Spec §11.
- **No persistent adjacency.** Rebuilt per Tier 3 call from `state.graph.edges`. BM25 index precedent.
- **No NER.** Capitalized-noun regex suffices for v2.0 (spec §4). NER is v2.1+.
- **No per-edge access events.** Lifecycle bumps happen on entries in the returned list; edges don't have lifecycles.
- **No Tier 3 cache.** Separate from Tier 0/1 which are query caches. Tier 3's output lands in Tier 0/1 caches under the full query key — same as Tier 2 hits — via the ladder's `recordTier0` / `recordTier1` calls. No new cache layer.
- **No benchmark harness.** Phase 9. But λ₁/λ₂/beam width/edge cap are all in `constants.js` ready for tuning.
- **No memory viewer.** Phase 8 renders `state.graph.edges` in the Graph tab and `state.runtime.traces[i].perTier['3']` in the Traces tab. Phase 5 produces, Phase 8 displays.

If any creep in during implementation, stop and defer to the phase that owns it.
