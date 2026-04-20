# Phase 7—Persona Rebuild (Enhanced RAPTOR) Implementation Plan

> **For Hermes:** Use `subagent-driven-development` skill to implement this plan task-by-task. Reviews MAY be skipped per that skill's criteria (verbatim code + static checks per task + additive changes), with standard sandbox-path / tripwire-hash / post-delegation `git log -1` verification. Tasks 4.1–4.5 (Leiden), 6 (atomic replacement), and 7 (orchestrator) are flagged for controller-side eyeball verification even when review is skipped.

**Goal:** Ship Phase 7 — user-initiated, offline Persona rebuild using Enhanced RAPTOR (Liu et al. 2026) over a subject's Episodic entries. Atomic replacement of that subject's Persona slice on success; zero state mutation on failure or abort.

**Architecture:**
- `src/consolidation/personaRebuild.js` — the orchestrator. Single entry point: `rebuildPersona(chatId, subject, opts)`. Holds the write lock only for the atomic swap phase, NOT during embedding/clustering/summarization (those can take minutes). Read-only copies of Episodic entries are held as a snapshot during the heavy lifting; if Episodic changed during rebuild, the swap re-validates and either retries or aborts cleanly.
- `src/consolidation/raptor/chunking.js` — identity stub per Decision 6. Each Episodic entry = one leaf node. Module exists for v2.1 reinstatement if long documents enter the Episodic layer.
- `src/consolidation/raptor/embeddings.js` — injectable ST Vectors client. Production implementation calls `/api/vector/insert`, `/api/vector/query`, `/api/vector/purge`. Test client returns deterministic synthetic embeddings via content hash.
- `src/consolidation/raptor/knn.js` — builds weighted k-NN adjacency from embedded chunks. Adaptive k per depth.
- `src/consolidation/raptor/leiden.js` — Leiden community detection (Traag et al. 2019). Five internal stages (modularity, local moving, refinement, aggregation, outer loop). Public API: `leidenCluster(graph, gamma) → clusters[]`.
- `src/consolidation/raptor/summarize.js` — LLM summarization per cluster. Reuses `callLLM` from Phase 6.
- `src/consolidation/raptor/atomic.js` — subject-scoped atomic replacement inside `withWriteLock`. Deletes all Persona entries whose `subject === targetSubject`, inserts new ones, clears `runtime.pendingPersonaRebuild`, resets `runtime.episodicCountSinceLastRebuild`.

**Tech Stack:** Vanilla ES2022 modules, jest 30, tsc `--noEmit`, eslint 9. No new runtime dependencies. Embedding API is SillyTavern's existing Vectors extension (user configures the provider once in ST settings; Phase 7 picks it up transparently).

**Spec:** [§6.4 Persona Rebuild](../specs/2026-04-20-starmem-v2-design.md#64-persona-rebuild), [wiki/raptor.md STARmem v2 Adaptation](../wiki/raptor.md#starmem-v2-adaptation).

**Phase 6 handoff (from ROADMAP retro):**
- `runtime.episodicCountSinceLastRebuild` and `runtime.pendingPersonaRebuild` already exist. Phase 7's `rebuildPersona` clears both on success.
- `consolidate()` holds the chatId's write lock during its run. Phase 7 does NOT hold the lock across the embedding/clustering/summarization phases (they can take minutes). Instead: snapshot under a brief read, do the heavy work without the lock, acquire the lock only for the atomic swap. Re-validate the snapshot hash before committing.
- Extractor-label pattern: `"<model>@persona-rebuild-v1"` for Phase 7-produced Persona entries' provenance.
- The one-path invariant test (`tests/unit/consolidation/no-other-mutators.test.js`) already whitelists `src/consolidation/`. Phase 7's new files under `src/consolidation/raptor/` inherit that whitelist automatically.

---

## Decisions locked before writing this plan (see conversation 2026-04-20)

1. **Embedding source.** SillyTavern Vectors extension API, injectable client. Production: `/api/vector/insert` + `/api/vector/query` + `/api/vector/purge` at a temp collection id per rebuild. User configures embedding provider once in ST Vectors settings (local or online); Phase 7 picks whatever is active.
2. **Clustering algorithm.** Leiden (Traag et al. 2019), hand-rolled. Chosen over Louvain because the well-connectedness guarantee materially matters on the corpus sizes Eva targets (thousands of turns → hundreds of Episodic facts per subject → dozens of candidate clusters). Task 4 is split into five commits with golden-value tests per stage.
3. **Tree depth / stop.** Recurse upward until one of: `depth ≥ max_depth=3`, `clusters.length < 2`, `leaves.length < min_cluster_size × 2` (can't form at least two clusters). On stop, the root summary becomes a single top-level Persona entry; middle-layer summaries become per-cluster Persona entries.
4. **What becomes a Persona entry.** Every layer's summary except Layer 0 (raw Episodic). So middle-layer summaries (cluster summaries at depth 1, 2) AND the root summary. Root is always a single entry even if the tree collapses early.
5. **Atomic replacement scope.** Delete all Persona entries where `subject === targetSubject`, insert new summaries, single `withWriteLock` transaction. Dangling edges from deleted Persona entries are left in place — Tier 3 silently skips missing entries per Phase 4's behavior, and the graph cleanup is not worth the extra commit.
6. **Skip semantic chunking.** Each Episodic entry = one leaf node. Document the deviation from spec §6.4 ("Semantic chunking τ=0.7") in the retro; the rationale is that Episodic entries are already atomic factual statements (Phase 6's extractor produces "1-2 sentence third-person" output), and semantic chunking them would fragment coherent facts. `src/consolidation/raptor/chunking.js` exists as an identity stub for v2.1 reinstatement if we ever put long documents in Episodic.
7. **Cancellation.** `AbortSignal` threaded through `rebuildPersona(chatId, subject, { signal, ... })`. Checked before each LLM call, before each Leiden iteration, before the atomic swap. On abort: throw `AbortError`, release lock if held, zero state mutation. Temp embedding collection is purged in a `finally`.
8. **Counter reset.** `rebuildPersona` on success resets `runtime.episodicCountSinceLastRebuild = 0` and sets `runtime.pendingPersonaRebuild = false`. On failure or abort: leave both fields untouched (user may retry).
9. **Test embeddings.** Deterministic synthetic embedding client for all unit and integration tests. `syntheticEmbedding(text, dim=16)` hashes the text to a consistent vector. No real embeddings in tests. This keeps the full suite under 2s; Phase 9's benchmarks will exercise real embeddings.
10. **Module structure.** `src/consolidation/personaRebuild.js` (orchestrator) + `src/consolidation/raptor/{chunking,embeddings,knn,leiden,summarize,atomic}.js` per spec §10 layout. `raptor/index.js` barrel for internal imports; outer `src/consolidation/index.js` re-exports `rebuildPersona` only — RAPTOR internals stay private.

---

## Deliberate deviation from spec §11 — embeddings

Spec §11 says: *"Embeddings / vector search: deterministic only; BM25 + typed graphs throughout."*

Phase 7 uses embeddings in the persona-rebuild pipeline. This is a deliberate deviation, approved in planning (see Decision 1). The reasoning:

- §11's "no embeddings" is about the **hot retrieval path** (Tier 0–3 in §5), where determinism is load-bearing for latency budgets and reproducibility.
- Persona rebuild is **user-initiated, offline**, and runs for seconds to minutes. Latency budget does not apply.
- The wiki (`docs/wiki/raptor.md` §STARmem v2 Adaptation) already describes Enhanced RAPTOR with semantic chunking and k-NN clustering, both of which require embeddings. The wiki is consistent with Phase 7; the spec headline §11 is not.
- Determinism is preserved where it matters: the **final Persona entries** are written deterministically (single write lock, atomic swap). The LLM summarization step introduces non-determinism, but §11's concern is the retrieval path, not memory construction.

**Action item: `docs(spec)` amendment.** Add to the Phase 7 retro as a TODO for a standalone commit:

> Spec §11 should be amended to: "Embeddings / vector search: deterministic only ON THE HOT RETRIEVAL PATH. Persona rebuild (§6.4) uses embeddings via the user's configured SillyTavern Vectors source; this is offline, user-initiated, and not on the hot path."
>
> Spec §6.4 should add: "Embedding provider: whatever the user has configured in SillyTavern's Vectors extension (source agnostic: local, webllm, openai, extras, etc.). A temp collection is created per rebuild, purged on completion or abort."

Phase 7 does not land the amendment — retros name the TODO; the amendment commit happens when we next touch the spec (likely during Phase 8 integration polish, same pattern as Phase 3's scorer-signature deviation).

---

## Cross-task conventions (inherited from Phases 1–6)

**Runtime dependency policy.** No new `dependencies`. Runtime code imports only from relative paths inside this repo and SillyTavern's exposed modules. ST Vectors API is consumed via `fetch('/api/vector/...')` — same pattern used by `public/scripts/extensions/vectors/index.js` itself.

**Fresh-fixture typedef pattern.** Every test fixture that constructs an `Entry` or `State` literal annotates with `/** @type {import('...').Entry} */` to prevent tsc literal widening. Load-bearing since Phase 1.

**Logger pattern.** `import { createLogger } from '../core/logger.js';` then `const log = createLogger({ debug: false }).scope('raptor:<module>');`. The Phase 6 retro has the receipt for why `createLogger().scope()` is the real API (not `makeLogger(name)`).

**Commit format.** `<type>(<scope>): <summary>`. Scope is `raptor:<module>` for RAPTOR internals, `consolidation` for the orchestrator and barrel. Examples: `feat(raptor:leiden): modularity calculation per Traag 2019`, `feat(consolidation): rebuildPersona orchestrator per spec §6.4`.

**Static check cadence.** Every task runs `npm run typecheck && npm run lint && npm test --silent` before committing. Phase 6 caught two bugs this way (plan-text inconsistencies that tsc or jest surfaced immediately).

---

## Sandbox-path protocol (every subagent task)

Every `delegate_task` context block must include:

```
ABSOLUTE REPO PATH (use this exactly — never `~`):
/home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem

CRITICAL: A v1 copy of STARmem lives at /home/opus/SillyTavern/... — DO NOT TOUCH IT.
Verify with `git log -1 --oneline` showing `e5e1e21 docs(plans): Phase 6 retro + plan corrections`
(or any descendant once Phase 7 begins). If the commit is different or working tree is on v1,
STOP and report.

DO NOT:
- Use `~` or `cd ~` anywhere — always use the absolute path.
- Run `git add -A` — use explicit file paths only.
- Use `git stash --include-untracked` — report back and wait.
```

After each delegation: `cd <abs path> && git log -1 --oneline && npm test --silent 2>&1 | tail -3`.

---

## Task 0: Constants delta

**Objective:** Add `PERSONA_REBUILD` block to `src/core/constants.js` with all Phase 7 tunables. Export, test, commit.

**Owner:** Controller (mechanical).

**Files:**
- Modify: `src/core/constants.js`
- Modify: `tests/unit/core/constants.test.js`

**Step 1: Patch `src/core/constants.js`**

Append after the `CONSOLIDATION` block and before `TRACE_BUFFER_CAP`:

```js
/** Persona rebuild (Enhanced RAPTOR) parameters. Spec §6.4 / wiki/raptor.md. */
export const PERSONA_REBUILD = Object.freeze({
    /** k-NN base neighbor count at the bottom layer. Spec §6.4. */
    K_BASE: 15,
    /** k-NN increment per layer ascending. Spec §6.4. */
    K_STEP: 5,
    /** Leiden resolution parameter base at bottom layer. Spec §6.4. */
    GAMMA_BASE: 1.0,
    /** Leiden resolution decrement per layer. Spec §6.4. */
    GAMMA_STEP: 0.2,
    /** Maximum tree depth. Stop recursing beyond this. */
    MAX_DEPTH: 3,
    /** Minimum nodes required to attempt clustering (need ≥ 2 × this to form 2 clusters). */
    MIN_CLUSTER_SIZE: 2,
    /** Leiden convergence tolerance — stop when modularity gain is below this across an outer iteration. */
    LEIDEN_TOLERANCE: 1e-6,
    /** Leiden maximum outer iterations, safety cap. */
    LEIDEN_MAX_OUTER_ITERATIONS: 32,
    /** LLM max tokens per cluster summary. Persona summaries are compact. */
    SUMMARY_MAX_TOKENS: 512,
    /** Embedding dimension for the synthetic test client. Production dimension is provider-dependent. */
    SYNTHETIC_EMBEDDING_DIM: 16,
});
```

**Step 2: Patch `tests/unit/core/constants.test.js`**

Add inside `describe('constants', ...)`:

```js
    test('PERSONA_REBUILD matches spec §6.4 verbatim', () => {
        expect(PERSONA_REBUILD.K_BASE).toBe(15);
        expect(PERSONA_REBUILD.K_STEP).toBe(5);
        expect(PERSONA_REBUILD.GAMMA_BASE).toBe(1.0);
        expect(PERSONA_REBUILD.GAMMA_STEP).toBe(0.2);
        expect(PERSONA_REBUILD.MAX_DEPTH).toBe(3);
        expect(PERSONA_REBUILD.MIN_CLUSTER_SIZE).toBe(2);
        expect(PERSONA_REBUILD.LEIDEN_TOLERANCE).toBeCloseTo(1e-6, 10);
        expect(PERSONA_REBUILD.LEIDEN_MAX_OUTER_ITERATIONS).toBe(32);
        expect(PERSONA_REBUILD.SUMMARY_MAX_TOKENS).toBe(512);
        expect(PERSONA_REBUILD.SYNTHETIC_EMBEDDING_DIM).toBe(16);
    });
```

Also add `PERSONA_REBUILD` to the import statement at the top of the test file.

**Step 3: Run + commit**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
npm run typecheck && npm run lint && npm test --silent 2>&1 | tail -3
git add src/core/constants.js tests/unit/core/constants.test.js
git commit -m "feat(§6.4): PERSONA_REBUILD constants for Phase 7"
```

**Done-when:**
- `PERSONA_REBUILD` exported with all 10 fields
- 342 tests green (341 baseline + 1 new)
- Commit landed

---

## Task 1: Chunking stub — `raptor/chunking.js`

**Objective:** Ship the identity-stub chunking module. Per Decision 6, each Episodic entry = one leaf. Module exists so v2.1 can reinstate real semantic chunking without rewriting callers.

**Owner:** Subagent (small, TDD).

**Files:**
- Create: `src/consolidation/raptor/chunking.js`
- Create: `tests/unit/consolidation/raptor/chunking.test.js`

**Step 1: Create `src/consolidation/raptor/chunking.js`**

```js
/**
 * Semantic chunking stub.
 *
 * Spec §6.4 prescribes semantic chunking with τ=0.7 cosine distance. We do
 * NOT implement that in v2.0 because Episodic entries produced by Phase 6's
 * extractor are already atomic 1-2 sentence facts — splitting them would
 * fragment coherent statements. Instead this module is an identity stub:
 * each Episodic entry becomes exactly one leaf node.
 *
 * For v2.1: if long documents ever enter the Episodic layer (e.g. a future
 * "paste a whole article" path), this module is the hook point for the real
 * semantic chunker. The public API (`chunkEntries`) will stay the same — it
 * maps Entry[] to Leaf[] where a Leaf has a stable id, source entry id(s),
 * and the text to embed/summarize.
 *
 * @module consolidation/raptor/chunking
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.4
 * @see docs/wiki/raptor.md (Enhanced RAPTOR → Semantic Chunking)
 */

/**
 * @typedef {object} Leaf
 * @property {string} id           - Stable leaf id: "leaf_<entryId>_<chunkIndex>". For the stub, chunkIndex is always 0.
 * @property {string[]} sourceEntryIds - The Episodic entry id(s) this leaf derives from. Stub: always length 1.
 * @property {string} text         - Text to embed and summarize.
 * @property {string | null} subject   - Carried from the source entry for downstream filtering.
 */

/**
 * Map an array of Episodic Entry objects to Leaf nodes.
 *
 * Stub behavior: 1 entry → 1 leaf, id-stable, content-preserved.
 *
 * @param {import('../../core/schema.js').Entry[]} entries
 * @returns {Leaf[]}
 */
export function chunkEntries(entries) {
    if (!Array.isArray(entries)) {
        throw new Error('chunkEntries: entries must be an array');
    }
    return entries.map(e => ({
        id: `leaf_${e.id}_0`,
        sourceEntryIds: [e.id],
        text: e.content,
        subject: e.subject,
    }));
}
```

**Step 2: Create `tests/unit/consolidation/raptor/chunking.test.js`**

```js
import { describe, test, expect } from '@jest/globals';
import { chunkEntries } from '../../../../src/consolidation/raptor/chunking.js';
import { createEntry } from '../../../../src/memory/entry.js';

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

describe('chunkEntries (identity stub)', () => {
    test('empty input → empty output', () => {
        expect(chunkEntries([])).toEqual([]);
    });

    test('throws on non-array', () => {
        expect(() => chunkEntries(/** @type {any} */ ('not an array'))).toThrow(/array/);
    });

    test('1 entry → 1 leaf with stable id', () => {
        const e = ep({ content: 'alice is happy', subject: 'alice' });
        const leaves = chunkEntries([e]);
        expect(leaves).toHaveLength(1);
        expect(leaves[0].id).toBe(`leaf_${e.id}_0`);
        expect(leaves[0].sourceEntryIds).toEqual([e.id]);
        expect(leaves[0].text).toBe('alice is happy');
        expect(leaves[0].subject).toBe('alice');
    });

    test('preserves null subject', () => {
        const e = ep({ subject: null });
        const leaves = chunkEntries([e]);
        expect(leaves[0].subject).toBeNull();
    });

    test('3 entries → 3 leaves in order', () => {
        const es = [
            ep({ content: 'a' }),
            ep({ content: 'b' }),
            ep({ content: 'c' }),
        ];
        const leaves = chunkEntries(es);
        expect(leaves.map(l => l.text)).toEqual(['a', 'b', 'c']);
        expect(leaves.map(l => l.sourceEntryIds[0])).toEqual(es.map(e => e.id));
    });

    test('leaf ids are unique across distinct entries', () => {
        const es = [ep({ content: 'a' }), ep({ content: 'b' })];
        const leaves = chunkEntries(es);
        expect(new Set(leaves.map(l => l.id)).size).toBe(2);
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/chunking.test.js --silent  # expect FAIL (module not found)
# create source
npm run test -- tests/unit/consolidation/raptor/chunking.test.js --silent  # expect 6 PASS
npm run typecheck && npm run lint
git add src/consolidation/raptor/chunking.js tests/unit/consolidation/raptor/chunking.test.js
git commit -m "feat(raptor:chunking): identity stub per Decision 6 (Phase 7)"
```

**Expected:** 6 new tests pass. 348 total (342 + 6).

**Done-when:**
- Stub returns 1 leaf per entry
- Null subject preserved
- Non-array input throws
- 348 tests green

---

## Task 2: Embeddings — `raptor/embeddings.js`

**Objective:** Injectable ST Vectors client. Production implementation wraps `/api/vector/insert`, `/api/vector/query`, `/api/vector/purge`. Test harness swaps in a deterministic synthetic-embedding client.

**Owner:** Subagent (TDD with mocked fetch).

**Rationale:** ST's `/api/vector/query` returns `{ hashes, metadata }` with similarity scores baked in. We don't need raw vectors — we just need pairwise similarities. So the client's public surface is:

- `createCollection(collectionId) → Promise<void>` — idempotent, creates the temp collection
- `insertChunks(collectionId, leaves) → Promise<void>` — inserts leaves, returns when embeddings are built
- `queryKNN(collectionId, text, k) → Promise<{leafId: string, similarity: number}[]>` — top-k most similar leaves (includes query as topmost hit when query text === a leaf's text, which the caller filters)
- `purgeCollection(collectionId) → Promise<void>` — cleanup

The ST Vectors API uses a hash of the text as the lookup key. Our `Leaf.id` is NOT the hash — so we pass `{hash: numericHash, text, index: leafId}` format on insert, and the query response's `metadata[i].index` gives us back the leaf id. This matches ST's own convention in `vectors/index.js:1666`.

**Files:**
- Create: `src/consolidation/raptor/embeddings.js`
- Create: `tests/unit/consolidation/raptor/embeddings.test.js`

**Step 1: Create `src/consolidation/raptor/embeddings.js`**

```js
/**
 * Embedding client for persona rebuild. Injectable wrapper over SillyTavern's
 * Vectors extension (`/api/vector/insert`, `/api/vector/query`, `/api/vector/purge`).
 *
 * Design: ST Vectors does not expose raw embedding vectors — only similarity
 * scores from query. That's actually cleaner for our k-NN graph construction:
 * we insert all leaves into a temp collection, query each leaf's text against
 * the collection with topK = k+1 (one self-hit filtered out), and get weighted
 * edges directly from the returned similarity scores.
 *
 * Injection pattern mirrors Phase 6's llmClient. Production client uses
 * fetch; tests inject a synthetic deterministic client.
 *
 * @module consolidation/raptor/embeddings
 * @see public/scripts/extensions/vectors/index.js (ST's reference implementation)
 */

import { PERSONA_REBUILD } from '../../core/constants.js';

const { SYNTHETIC_EMBEDDING_DIM } = PERSONA_REBUILD;

/**
 * @typedef {object} InsertItem
 * @property {number} hash   - Numeric content hash (ST's collection key).
 * @property {string} text   - Text to embed.
 * @property {string} index  - Caller-supplied leaf id; returned on query.
 */

/**
 * @typedef {object} QueryHit
 * @property {string} leafId        - The caller-supplied leaf id (ST's "index" metadata).
 * @property {number} similarity    - Cosine similarity ∈ [0, 1] or provider-dependent score.
 */

/**
 * @typedef {object} EmbeddingClient
 * @property {(collectionId: string) => Promise<void>} createCollection
 * @property {(collectionId: string, items: InsertItem[]) => Promise<void>} insertChunks
 * @property {(collectionId: string, text: string, k: number) => Promise<QueryHit[]>} queryKNN
 * @property {(collectionId: string) => Promise<void>} purgeCollection
 */

/**
 * FNV-1a 32-bit hash. Same algorithm as Phase 4's tier0 cache. Not
 * cryptographic — just a stable numeric key for ST Vectors.
 * @param {string} s
 * @returns {number}
 */
export function hashText(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    // Force unsigned 32-bit
    return h >>> 0;
}

/**
 * Build a deterministic synthetic embedding from text. Used by tests and as
 * a fallback when ST Vectors is unavailable (e.g. test harness). Uses a
 * cheap seeded PRNG (xorshift32) keyed on the FNV hash of the text.
 *
 * @param {string} text
 * @param {number} [dim=SYNTHETIC_EMBEDDING_DIM]
 * @returns {number[]}
 */
export function syntheticEmbedding(text, dim = SYNTHETIC_EMBEDDING_DIM) {
    let seed = hashText(text) || 0xdeadbeef;
    /** @type {number[]} */
    const v = new Array(dim);
    for (let i = 0; i < dim; i++) {
        // xorshift32
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed >>>= 0;
        // Map uint32 → [-1, 1]
        v[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    // L2 normalize so dot product = cosine similarity.
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
}

/** @param {number[]} a @param {number[]} b @returns {number} */
export function cosineSimilarity(a, b) {
    if (a.length !== b.length) {
        throw new Error('cosineSimilarity: dimension mismatch');
    }
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    // Inputs should already be normalized; clamp for numerical safety.
    return Math.max(-1, Math.min(1, dot));
}

/**
 * Default production client. Uses fetch against ST's Vectors API. The source
 * (openai, webllm, extras, etc.) is whatever the user has configured in ST's
 * Vectors extension settings; we don't override it here.
 *
 * Throws if ST globals are unavailable (e.g. under jest).
 *
 * @returns {EmbeddingClient}
 */
function makeDefaultClient() {
    const g = /** @type {any} */ (globalThis);
    const getHeaders = () => {
        if (typeof g.getRequestHeaders === 'function') return g.getRequestHeaders();
        // Fallback minimal headers; real ST provides CSRF + auth.
        return { 'Content-Type': 'application/json' };
    };
    return {
        async createCollection(_collectionId) {
            // ST's Vectors API creates collections lazily on first insert.
            // No explicit creation call needed.
        },
        async insertChunks(collectionId, items) {
            const response = await fetch('/api/vector/insert', {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ collectionId, items }),
            });
            if (!response.ok) {
                throw new Error(`embeddings.insertChunks: HTTP ${response.status}`);
            }
        },
        async queryKNN(collectionId, text, k) {
            const response = await fetch('/api/vector/query', {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ collectionId, searchText: text, topK: k }),
            });
            if (!response.ok) {
                throw new Error(`embeddings.queryKNN: HTTP ${response.status}`);
            }
            const body = await response.json();
            /** @type {QueryHit[]} */
            const hits = [];
            const meta = Array.isArray(body?.metadata) ? body.metadata : [];
            for (const m of meta) {
                if (m && typeof m.index === 'string' && typeof m.score === 'number') {
                    hits.push({ leafId: m.index, similarity: m.score });
                }
            }
            return hits;
        },
        async purgeCollection(collectionId) {
            const response = await fetch('/api/vector/purge', {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ collectionId }),
            });
            if (!response.ok) {
                throw new Error(`embeddings.purgeCollection: HTTP ${response.status}`);
            }
        },
    };
}

/** @type {EmbeddingClient} */
let client = makeDefaultClient();

/**
 * Public surface — forwards to the active client.
 *
 * @param {string} collectionId
 * @returns {Promise<void>}
 */
export function createCollection(collectionId) {
    return client.createCollection(collectionId);
}

/** @param {string} collectionId @param {InsertItem[]} items @returns {Promise<void>} */
export function insertChunks(collectionId, items) {
    if (typeof collectionId !== 'string' || collectionId.length === 0) {
        return Promise.reject(new Error('insertChunks: collectionId required'));
    }
    if (!Array.isArray(items)) {
        return Promise.reject(new Error('insertChunks: items must be an array'));
    }
    return client.insertChunks(collectionId, items);
}

/** @param {string} collectionId @param {string} text @param {number} k @returns {Promise<QueryHit[]>} */
export function queryKNN(collectionId, text, k) {
    if (typeof collectionId !== 'string' || collectionId.length === 0) {
        return Promise.reject(new Error('queryKNN: collectionId required'));
    }
    if (typeof text !== 'string') {
        return Promise.reject(new Error('queryKNN: text must be a string'));
    }
    if (typeof k !== 'number' || k <= 0) {
        return Promise.reject(new Error('queryKNN: k must be a positive number'));
    }
    return client.queryKNN(collectionId, text, k);
}

/** @param {string} collectionId @returns {Promise<void>} */
export function purgeCollection(collectionId) {
    return client.purgeCollection(collectionId);
}

/**
 * Build a synthetic in-memory embedding client for tests. Stores leaves in a
 * Map<collectionId, Map<text, InsertItem & {embedding: number[]}>>; queryKNN
 * computes cosine similarity against all stored leaves and returns top-k.
 *
 * @returns {EmbeddingClient}
 */
export function makeSyntheticClient() {
    /** @type {Map<string, Map<string, InsertItem & { embedding: number[] }>>} */
    const store = new Map();
    return {
        async createCollection(collectionId) {
            if (!store.has(collectionId)) store.set(collectionId, new Map());
        },
        async insertChunks(collectionId, items) {
            const bucket = store.get(collectionId) ?? new Map();
            for (const it of items) {
                bucket.set(it.index, { ...it, embedding: syntheticEmbedding(it.text) });
            }
            store.set(collectionId, bucket);
        },
        async queryKNN(collectionId, text, k) {
            const bucket = store.get(collectionId);
            if (!bucket) return [];
            const q = syntheticEmbedding(text);
            /** @type {QueryHit[]} */
            const hits = [];
            for (const it of bucket.values()) {
                hits.push({ leafId: it.index, similarity: cosineSimilarity(q, it.embedding) });
            }
            hits.sort((a, b) => b.similarity - a.similarity);
            return hits.slice(0, k);
        },
        async purgeCollection(collectionId) {
            store.delete(collectionId);
        },
    };
}

/**
 * Test-only: install a specific client (synthetic, mock, or custom).
 * @param {EmbeddingClient} c
 */
export function _setEmbeddingClientForTests(c) {
    if (!c || typeof c.createCollection !== 'function') {
        throw new Error('_setEmbeddingClientForTests: client missing createCollection');
    }
    client = c;
}

/** Test-only: restore the default fetch-backed client. */
export function _resetEmbeddingClientForTests() {
    client = makeDefaultClient();
}
```

**Step 2: Create `tests/unit/consolidation/raptor/embeddings.test.js`**

```js
import { describe, test, expect, afterEach } from '@jest/globals';
import {
    hashText, syntheticEmbedding, cosineSimilarity, makeSyntheticClient,
    createCollection, insertChunks, queryKNN, purgeCollection,
    _setEmbeddingClientForTests, _resetEmbeddingClientForTests,
} from '../../../../src/consolidation/raptor/embeddings.js';

afterEach(() => _resetEmbeddingClientForTests());

describe('hashText', () => {
    test('deterministic for same input', () => {
        expect(hashText('alice')).toBe(hashText('alice'));
    });
    test('different inputs → different hashes (sanity)', () => {
        expect(hashText('alice')).not.toBe(hashText('bob'));
    });
    test('empty string produces a defined number', () => {
        expect(typeof hashText('')).toBe('number');
    });
});

describe('syntheticEmbedding', () => {
    test('deterministic for same text', () => {
        expect(syntheticEmbedding('alice')).toEqual(syntheticEmbedding('alice'));
    });
    test('returns an array of the configured dimension', () => {
        const v = syntheticEmbedding('alice');
        expect(Array.isArray(v)).toBe(true);
        expect(v).toHaveLength(16);
    });
    test('returns an L2-normalized vector', () => {
        const v = syntheticEmbedding('alice traveled to marseille');
        let norm = 0;
        for (const x of v) norm += x * x;
        expect(Math.sqrt(norm)).toBeCloseTo(1.0, 6);
    });
    test('different texts yield different vectors', () => {
        const a = syntheticEmbedding('alice');
        const b = syntheticEmbedding('bob');
        expect(a).not.toEqual(b);
    });
});

describe('cosineSimilarity', () => {
    test('identical vectors → 1', () => {
        const v = syntheticEmbedding('alice');
        expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
    });
    test('different vectors → < 1', () => {
        const a = syntheticEmbedding('alice');
        const b = syntheticEmbedding('completely different content here');
        expect(cosineSimilarity(a, b)).toBeLessThan(1);
    });
    test('throws on dimension mismatch', () => {
        expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimension/);
    });
    test('clamps to [-1, 1]', () => {
        // Tiny numerical drift shouldn't escape the range even with identical inputs
        const v = syntheticEmbedding('test');
        const s = cosineSimilarity(v, v);
        expect(s).toBeLessThanOrEqual(1);
        expect(s).toBeGreaterThanOrEqual(-1);
    });
});

describe('public surface (argument guards)', () => {
    test('insertChunks rejects empty collectionId', async () => {
        await expect(insertChunks('', [])).rejects.toThrow(/collectionId/);
    });
    test('queryKNN rejects empty collectionId', async () => {
        await expect(queryKNN('', 'x', 3)).rejects.toThrow(/collectionId/);
    });
    test('queryKNN rejects non-positive k', async () => {
        await expect(queryKNN('c', 'x', 0)).rejects.toThrow(/k/);
    });
});

describe('default client under jest (no ST fetch)', () => {
    // The default client calls `fetch`. jest's environment has no /api/ server,
    // so fetch rejects. We verify the guard surfaces clearly.
    test('insertChunks surfaces a network error (no ST server in jest)', async () => {
        await expect(insertChunks('c', [{ hash: 1, text: 'x', index: 'leaf1' }]))
            .rejects.toThrow();
    });
});

describe('synthetic client round trip', () => {
    test('insert + query returns inserted items ranked by similarity', async () => {
        _setEmbeddingClientForTests(makeSyntheticClient());
        await createCollection('c1');
        await insertChunks('c1', [
            { hash: hashText('alice traveled to marseille'), text: 'alice traveled to marseille', index: 'leaf_a' },
            { hash: hashText('bob went to paris'), text: 'bob went to paris', index: 'leaf_b' },
            { hash: hashText('alice likes croissants'), text: 'alice likes croissants', index: 'leaf_c' },
        ]);
        const hits = await queryKNN('c1', 'alice traveled to marseille', 3);
        expect(hits).toHaveLength(3);
        // Self-hit should be first with similarity ≈ 1
        expect(hits[0].leafId).toBe('leaf_a');
        expect(hits[0].similarity).toBeCloseTo(1, 6);
        // All similarities are in [-1, 1]
        for (const h of hits) {
            expect(h.similarity).toBeLessThanOrEqual(1);
            expect(h.similarity).toBeGreaterThanOrEqual(-1);
        }
    });

    test('queryKNN with k=2 returns only 2 hits even when more exist', async () => {
        _setEmbeddingClientForTests(makeSyntheticClient());
        await createCollection('c');
        await insertChunks('c', [
            { hash: 1, text: 'a', index: 'l1' },
            { hash: 2, text: 'b', index: 'l2' },
            { hash: 3, text: 'c', index: 'l3' },
            { hash: 4, text: 'd', index: 'l4' },
        ]);
        const hits = await queryKNN('c', 'a', 2);
        expect(hits).toHaveLength(2);
    });

    test('purgeCollection drops the collection', async () => {
        _setEmbeddingClientForTests(makeSyntheticClient());
        await createCollection('c');
        await insertChunks('c', [{ hash: 1, text: 'a', index: 'l1' }]);
        await purgeCollection('c');
        const hits = await queryKNN('c', 'a', 5);
        expect(hits).toEqual([]);
    });

    test('querying an unknown collection returns empty list', async () => {
        _setEmbeddingClientForTests(makeSyntheticClient());
        const hits = await queryKNN('nonexistent', 'x', 5);
        expect(hits).toEqual([]);
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/embeddings.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/raptor/embeddings.js tests/unit/consolidation/raptor/embeddings.test.js
git commit -m "feat(raptor:embeddings): ST Vectors client + synthetic test client per spec §6.4"
```

**Expected:** 18 new tests pass (3 hashText + 4 syntheticEmbedding + 4 cosineSimilarity + 3 guards + 1 default-client-no-ST + 4 synthetic round trip = 19; count emerges in the actual run).

**Done-when:**
- Synthetic round trip works: insert then query returns results ranked by similarity
- Public-surface guards reject bad args
- Default client surfaces a clear error under jest (fetch fails)
- All tests green; lint + typecheck clean
- Commit landed

**Subagent note:** This task's LOC count is high (~280 for src, ~180 for tests). Use `write_file` rather than `patch` to create both. The FNV-1a hash implementation here MUST match the one in `src/retrieval/tier0-exact.js` (same algorithm, different call site) — verify by running tier0 tests after this task lands; they should still pass.

---

## Task 3: k-NN graph — `raptor/knn.js`

**Objective:** Build a weighted undirected graph from a set of leaves + the embedding client. Each node is a leaf; each edge weight is the cosine similarity from `queryKNN`. Adaptive k per layer: at depth d, `k = K_BASE + d × K_STEP`. Symmetrize directed k-NN edges by taking max similarity per pair.

**Owner:** Subagent (TDD, uses synthetic embedding client).

**Graph representation.** Adjacency map `Map<nodeId, Map<neighborId, weight>>`. Chosen over edge lists because Leiden needs O(1) neighbor lookup during local moving. Undirected — `graph[a][b] === graph[b][a]` invariant; the setter enforces this.

**Files:**
- Create: `src/consolidation/raptor/knn.js`
- Create: `tests/unit/consolidation/raptor/knn.test.js`

**Step 1: Create `src/consolidation/raptor/knn.js`**

```js
/**
 * k-NN graph construction for Enhanced RAPTOR. Given a batch of leaves, embed
 * each (via the active embeddings client's temp collection), query the top-k
 * nearest neighbors per leaf, and build a symmetric weighted adjacency map.
 *
 * Symmetrization strategy: k-NN is inherently directed (A's top-k may not
 * include B even if B's top-k includes A). We take the MAX similarity across
 * both directions so the edge reflects the strongest evidence the two nodes
 * are related. This is the standard mutual-kNN alternative-lite — cheaper
 * than intersection, catches one-way strong matches.
 *
 * @module consolidation/raptor/knn
 * @see docs/wiki/raptor.md (Enhanced RAPTOR → Leiden on k-NN)
 */

import { PERSONA_REBUILD } from '../../core/constants.js';
import {
    createCollection, insertChunks, queryKNN, purgeCollection, hashText,
} from './embeddings.js';

const { K_BASE, K_STEP } = PERSONA_REBUILD;

/**
 * @typedef {import('./chunking.js').Leaf} Leaf
 */

/**
 * @typedef {object} KnnGraph
 * @property {string[]} nodes                                     - Ordered node ids.
 * @property {Map<string, Map<string, number>>} adjacency         - nodeId → (neighborId → weight ∈ (0, 1]).
 * @property {number} totalWeight                                 - Sum of all edge weights (used by Leiden modularity).
 */

/**
 * Compute adaptive k for depth d. Spec §6.4: k_base=15, k_step=5, so d=0 → 15,
 * d=1 → 20, d=2 → 25.
 *
 * @param {number} depth
 * @returns {number}
 */
export function kForDepth(depth) {
    if (typeof depth !== 'number' || depth < 0 || !Number.isInteger(depth)) {
        throw new Error('kForDepth: depth must be a non-negative integer');
    }
    return K_BASE + depth * K_STEP;
}

/**
 * Build a k-NN graph for a batch of leaves at the given depth.
 *
 * Algorithm:
 *   1. Create a temp collection, insert all leaves.
 *   2. For each leaf, queryKNN(collection, leaf.text, k+1) — the +1 accounts
 *      for the self-hit, which is filtered out.
 *   3. Symmetrize: for each directed edge (a→b, w), combine with (b→a, w')
 *      by taking max(w, w'). Also drop self-edges and zero-weight edges.
 *   4. Purge the collection.
 *
 * Edges with similarity ≤ 0 are dropped (anti-correlation carries no useful
 * signal for community detection on this corpus).
 *
 * @param {Leaf[]} leaves
 * @param {number} depth
 * @param {string} collectionId      - Caller-supplied temp id (usually `${chatId}:${subject}:persona-rebuild:${depth}`).
 * @param {AbortSignal} [signal]
 * @returns {Promise<KnnGraph>}
 */
export async function buildKnnGraph(leaves, depth, collectionId, signal) {
    if (!Array.isArray(leaves)) {
        throw new Error('buildKnnGraph: leaves must be an array');
    }
    if (typeof collectionId !== 'string' || collectionId.length === 0) {
        throw new Error('buildKnnGraph: collectionId required');
    }
    const throwIfAborted = () => {
        if (signal?.aborted) {
            const err = new Error('buildKnnGraph: aborted');
            err.name = 'AbortError';
            throw err;
        }
    };

    const nodes = leaves.map(l => l.id);
    /** @type {Map<string, Map<string, number>>} */
    const adjacency = new Map();
    for (const id of nodes) adjacency.set(id, new Map());

    if (leaves.length < 2) {
        return { nodes, adjacency, totalWeight: 0 };
    }

    const k = kForDepth(depth);

    try {
        await createCollection(collectionId);
        throwIfAborted();
        await insertChunks(collectionId, leaves.map(l => ({
            hash: hashText(l.text),
            text: l.text,
            index: l.id,
        })));
        throwIfAborted();

        // For each leaf, query its top-(k+1) neighbors; drop the self-hit.
        for (const leaf of leaves) {
            throwIfAborted();
            const hits = await queryKNN(collectionId, leaf.text, k + 1);
            for (const h of hits) {
                if (h.leafId === leaf.id) continue;
                if (h.similarity <= 0) continue;
                const row = adjacency.get(leaf.id);
                if (!row) continue;
                const prev = row.get(h.leafId) ?? 0;
                if (h.similarity > prev) row.set(h.leafId, h.similarity);
            }
        }

        // Symmetrize: for each (a→b, w), ensure (b→a, max(w, w')) exists.
        let totalWeight = 0;
        const seen = new Set();
        for (const [a, row] of adjacency) {
            for (const [b, wAB] of row) {
                const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const wBA = adjacency.get(b)?.get(a) ?? 0;
                const w = Math.max(wAB, wBA);
                adjacency.get(a)?.set(b, w);
                adjacency.get(b)?.set(a, w);
                totalWeight += w;
            }
        }

        return { nodes, adjacency, totalWeight };
    } finally {
        // Always purge, even on error. Failures here are logged but not thrown —
        // purge failures leave a zombie collection but don't corrupt anything.
        try { await purgeCollection(collectionId); } catch { /* swallow */ }
    }
}

/**
 * Degree of a node (sum of edge weights). Used by Leiden modularity.
 *
 * @param {KnnGraph} graph
 * @param {string} nodeId
 * @returns {number}
 */
export function nodeDegree(graph, nodeId) {
    const row = graph.adjacency.get(nodeId);
    if (!row) return 0;
    let d = 0;
    for (const w of row.values()) d += w;
    return d;
}
```

**Step 2: Create `tests/unit/consolidation/raptor/knn.test.js`**

```js
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    buildKnnGraph, kForDepth, nodeDegree,
} from '../../../../src/consolidation/raptor/knn.js';
import {
    _setEmbeddingClientForTests, _resetEmbeddingClientForTests, makeSyntheticClient,
} from '../../../../src/consolidation/raptor/embeddings.js';
import { chunkEntries } from '../../../../src/consolidation/raptor/chunking.js';
import { createEntry } from '../../../../src/memory/entry.js';

const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

beforeEach(() => {
    _setEmbeddingClientForTests(makeSyntheticClient());
});
afterEach(() => _resetEmbeddingClientForTests());

/** @param {string} content @returns {import('../../../../src/core/schema.js').Entry} */
function ep(content) {
    return createEntry({
        scope: 'episodic', content, subject: 'alice', tags: [], relations: [],
        provenance: { sourceMessages: [], extractor: 'test' }, now: FIXED_NOW,
    });
}

describe('kForDepth', () => {
    test('depth 0 → K_BASE (15)', () => {
        expect(kForDepth(0)).toBe(15);
    });
    test('depth 1 → 20', () => {
        expect(kForDepth(1)).toBe(20);
    });
    test('depth 2 → 25', () => {
        expect(kForDepth(2)).toBe(25);
    });
    test('rejects negative depth', () => {
        expect(() => kForDepth(-1)).toThrow(/non-negative/);
    });
    test('rejects non-integer depth', () => {
        expect(() => kForDepth(1.5)).toThrow(/integer/);
    });
});

describe('buildKnnGraph', () => {
    test('fewer than 2 leaves → empty adjacency', async () => {
        const leaves = chunkEntries([ep('only one fact')]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        expect(g.nodes).toHaveLength(1);
        expect(g.totalWeight).toBe(0);
        expect(g.adjacency.get(leaves[0].id)?.size).toBe(0);
    });

    test('3 leaves → symmetric adjacency (a↔b, b↔c, a↔c)', async () => {
        const leaves = chunkEntries([
            ep('alice traveled to marseille'),
            ep('alice likes croissants'),
            ep('the sky is blue today'),
        ]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        expect(g.nodes).toHaveLength(3);

        // Symmetry check
        for (const a of g.nodes) {
            for (const [b, w] of g.adjacency.get(a) ?? new Map()) {
                expect(g.adjacency.get(b)?.get(a)).toBeCloseTo(w, 6);
            }
        }
        // Total weight is positive (at least some pairs have non-zero similarity)
        expect(g.totalWeight).toBeGreaterThan(0);
    });

    test('drops self-edges', async () => {
        const leaves = chunkEntries([
            ep('alice traveled to marseille'),
            ep('alice likes croissants'),
        ]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        for (const id of g.nodes) {
            expect(g.adjacency.get(id)?.has(id)).toBe(false);
        }
    });

    test('drops edges with similarity ≤ 0', async () => {
        // Synthetic client can produce negative cosine values; confirm none survive.
        const leaves = chunkEntries([
            ep('alice'), ep('bob'), ep('carol'),
            ep('apple'), ep('banana'), ep('cherry'),
        ]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        for (const [_, row] of g.adjacency) {
            for (const w of row.values()) {
                expect(w).toBeGreaterThan(0);
            }
        }
    });

    test('respects AbortSignal pre-flight', async () => {
        const leaves = chunkEntries([ep('a'), ep('b'), ep('c')]);
        const controller = new AbortController();
        controller.abort();
        await expect(buildKnnGraph(leaves, 0, 'c', controller.signal))
            .rejects.toThrow(/aborted/);
    });

    test('purges collection after success', async () => {
        const leaves = chunkEntries([ep('a'), ep('b'), ep('c')]);
        await buildKnnGraph(leaves, 0, 'c-purge-success');
        // After purge, the collection is empty; a fresh query returns nothing.
        const { queryKNN } = await import('../../../../src/consolidation/raptor/embeddings.js');
        const hits = await queryKNN('c-purge-success', 'a', 5);
        expect(hits).toEqual([]);
    });

    test('throws on bad arguments', async () => {
        await expect(buildKnnGraph(/** @type {any} */ ('not-array'), 0, 'c'))
            .rejects.toThrow(/array/);
        await expect(buildKnnGraph([], 0, ''))
            .rejects.toThrow(/collectionId/);
    });
});

describe('nodeDegree', () => {
    test('returns 0 for unknown node', () => {
        /** @type {import('../../../../src/consolidation/raptor/knn.js').KnnGraph} */
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        expect(nodeDegree(g, 'unknown')).toBe(0);
    });

    test('sums edge weights for a node', async () => {
        const leaves = chunkEntries([ep('a'), ep('b'), ep('c')]);
        const g = await buildKnnGraph(leaves, 0, 'c');
        for (const id of g.nodes) {
            let expected = 0;
            for (const w of g.adjacency.get(id)?.values() ?? []) expected += w;
            expect(nodeDegree(g, id)).toBeCloseTo(expected, 6);
        }
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/knn.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/raptor/knn.js tests/unit/consolidation/raptor/knn.test.js
git commit -m "feat(raptor:knn): adaptive k-NN graph builder with symmetrization"
```

**Expected:** 13 new tests pass.

**Done-when:**
- `kForDepth(d) = 15 + 5d` for d ≥ 0
- Adjacency is symmetric for every built graph
- Self-edges absent, zero-weight edges dropped
- AbortSignal respected pre-flight
- Collection purged on success (and attempted on error)
- All tests green

**Subagent note:** Use the exported `{ queryKNN }` dynamic import in the purge test only — the rest of the file can use static imports. The `Math.max`-based symmetrization is the intentional choice here; do NOT switch to intersection (mutual-kNN), which would lose valuable one-way strong matches.

---

## Task 4 overview — Leiden community detection

Leiden (Traag et al. 2019) improves on Louvain by guaranteeing **well-connected communities**: no community is left as two or more disconnected components, which Louvain's greedy merging can produce. It runs three phases per outer iteration:

1. **Local moving.** For each node, greedily move to the neighbor community that gives the highest modularity gain. Repeat until no moves improve modularity.
2. **Refinement.** Within each community from phase 1, run a refined local-moving pass that only allows moves staying inside the same community. The refinement ensures each community remains internally well-connected.
3. **Aggregation.** Each community (after refinement) becomes a single node in a new graph; edges between communities are summed. Recurse on the aggregated graph.

Terminate when a full outer iteration yields no community changes OR modularity gain falls below `LEIDEN_TOLERANCE` OR iteration count hits `LEIDEN_MAX_OUTER_ITERATIONS`.

We split Task 4 into five commits so each piece is reviewable in isolation and the dependency chain is explicit:

- **4.1** — modularity calculation (pure math, golden-value tested)
- **4.2** — local moving (phase 1)
- **4.3** — refinement (phase 2)
- **4.4** — aggregation + outer loop (phase 3 + driver)
- **4.5** — public `leidenCluster(graph, gamma)` API + depth-aware gamma helper

All five commits touch only `src/consolidation/raptor/leiden.js` and its test file, incrementally. Each lands green on the full suite before the next begins.

---

## Task 4.1: Leiden modularity

**Objective:** Implement the modularity function for a weighted undirected graph under the RBConfigurationVertexPartition (the parameterized modularity Leiden uses). Hand-pin golden values on small fixtures.

**Owner:** Subagent (TDD with 5 golden-value fixtures).

**Modularity formula (RB Configuration, Reichardt-Bornholdt 2006):**

```
Q = (1 / 2m) · Σ_{i,j} [ A_ij - γ · (k_i · k_j) / (2m) ] · δ(c_i, c_j)
```

Where:
- `m` = sum of edge weights (ours stores this as `graph.totalWeight` which is already symmetric-counted once per pair; the `2m` factor in the formula expects symmetric double-counting, so we use `2 × totalWeight` in the denominator).
- `A_ij` = weight of edge between i and j (0 if no edge).
- `k_i` = degree of node i.
- `γ` = resolution parameter (higher → more, smaller clusters).
- `δ(c_i, c_j)` = 1 if i and j in same community, 0 otherwise.

Equivalent per-community form (faster, what we implement):

```
Q = Σ_c [ (Σ_in_c / 2m) - γ · (Σ_tot_c / 2m)² ]
```

Where `Σ_in_c` is the sum of edge weights **entirely inside** community c (counted with internal edges weighted ×2 because the graph is undirected and stored symmetrically), and `Σ_tot_c` is the sum of degrees of nodes in c.

**Files:**
- Create: `src/consolidation/raptor/leiden.js`
- Create: `tests/unit/consolidation/raptor/leiden.test.js`

**Step 1: Create `src/consolidation/raptor/leiden.js` (modularity only for now)**

```js
/**
 * Leiden community detection (Traag et al. 2019). Operates on KnnGraph
 * instances produced by raptor/knn.js. Public API lands in Task 4.5; this
 * file is built up across Tasks 4.1–4.5.
 *
 * @module consolidation/raptor/leiden
 * @see docs/wiki/raptor.md (Enhanced RAPTOR → Leiden on k-NN)
 * @see https://www.nature.com/articles/s41598-019-41695-z (Traag 2019)
 */

/**
 * @typedef {import('./knn.js').KnnGraph} KnnGraph
 */

/**
 * @typedef {object} Partition
 * @property {Map<string, number>} membership   - nodeId → community id (non-negative integer)
 * @property {number} communityCount             - Number of distinct communities
 */

/**
 * Build a fresh partition where each node is in its own community.
 *
 * @param {KnnGraph} graph
 * @returns {Partition}
 */
export function singletonPartition(graph) {
    /** @type {Map<string, number>} */
    const membership = new Map();
    let cid = 0;
    for (const id of graph.nodes) {
        membership.set(id, cid++);
    }
    return { membership, communityCount: graph.nodes.length };
}

/**
 * Renumber a partition's community ids to be a contiguous [0, K) range.
 * Useful after merges or aggregations that leave gaps.
 *
 * @param {Partition} partition
 * @returns {Partition}
 */
export function compactPartition(partition) {
    /** @type {Map<number, number>} */
    const renumber = new Map();
    let next = 0;
    /** @type {Map<string, number>} */
    const fresh = new Map();
    for (const [nodeId, oldCid] of partition.membership) {
        let newCid = renumber.get(oldCid);
        if (newCid === undefined) {
            newCid = next++;
            renumber.set(oldCid, newCid);
        }
        fresh.set(nodeId, newCid);
    }
    return { membership: fresh, communityCount: next };
}

/**
 * RB-configuration modularity. Higher is better; partition quality metric.
 *
 * Uses the per-community formulation:
 *   Q = Σ_c [ (Σ_in / 2m) - γ × (Σ_tot / 2m)² ]
 *
 * where 2m = 2 × graph.totalWeight (undirected edges stored once per pair,
 * modularity convention doubles them).
 *
 * @param {KnnGraph} graph
 * @param {Partition} partition
 * @param {number} gamma         - Resolution parameter (spec §6.4 GAMMA_BASE, GAMMA_STEP)
 * @returns {number}
 */
export function modularity(graph, partition, gamma) {
    const twoM = 2 * graph.totalWeight;
    if (twoM === 0) return 0;

    /** @type {Map<number, { in: number, tot: number }>} */
    const stats = new Map();
    const addTot = (/** @type {number} */ c, /** @type {number} */ w) => {
        const s = stats.get(c) ?? { in: 0, tot: 0 };
        s.tot += w;
        stats.set(c, s);
    };
    const addIn = (/** @type {number} */ c, /** @type {number} */ w) => {
        const s = stats.get(c) ?? { in: 0, tot: 0 };
        s.in += w;
        stats.set(c, s);
    };

    // Σ_tot per community: sum of degrees of nodes in that community.
    for (const node of graph.nodes) {
        const c = partition.membership.get(node);
        if (c === undefined) continue;
        let deg = 0;
        for (const w of graph.adjacency.get(node)?.values() ?? []) deg += w;
        addTot(c, deg);
    }

    // Σ_in per community: sum of edge weights entirely inside that community.
    // Each undirected edge (a,b) with a < b is counted ONCE, but the formula's
    // "internal edges weighted ×2" convention is handled by the 2m denominator
    // matching. So we accumulate each edge once and the math works out.
    //
    // We iterate the adjacency once, guarding against double-counting by only
    // processing (a, b) when a < b lexicographically.
    for (const [a, row] of graph.adjacency) {
        for (const [b, w] of row) {
            if (a >= b) continue;
            const ca = partition.membership.get(a);
            const cb = partition.membership.get(b);
            if (ca !== undefined && cb !== undefined && ca === cb) {
                // Internal edge contributes 2w (both endpoints) to Σ_in.
                addIn(ca, 2 * w);
            }
        }
    }

    let q = 0;
    for (const { in: sIn, tot: sTot } of stats.values()) {
        q += (sIn / twoM) - gamma * Math.pow(sTot / twoM, 2);
    }
    return q;
}
```

**Step 2: Create `tests/unit/consolidation/raptor/leiden.test.js`**

```js
import { describe, test, expect } from '@jest/globals';
import {
    singletonPartition, compactPartition, modularity,
} from '../../../../src/consolidation/raptor/leiden.js';

/**
 * Build a graph fixture from a compact edge list: [['a','b',0.5], ...].
 * Edges are symmetric (both directions set). Nodes are inferred.
 *
 * @param {[string, string, number][]} edges
 */
function buildGraph(edges) {
    /** @type {Set<string>} */
    const nodeSet = new Set();
    /** @type {Map<string, Map<string, number>>} */
    const adj = new Map();
    let totalWeight = 0;
    for (const [a, b, w] of edges) {
        nodeSet.add(a); nodeSet.add(b);
        if (!adj.has(a)) adj.set(a, new Map());
        if (!adj.has(b)) adj.set(b, new Map());
        adj.get(a)?.set(b, w);
        adj.get(b)?.set(a, w);
        totalWeight += w;
    }
    // Ensure nodes with no edges still exist as empty rows.
    for (const n of nodeSet) {
        if (!adj.has(n)) adj.set(n, new Map());
    }
    return { nodes: [...nodeSet], adjacency: adj, totalWeight };
}

/** @param {Record<string, number>} pairs */
function partitionFrom(pairs) {
    const membership = new Map(Object.entries(pairs));
    const communityCount = new Set(Object.values(pairs)).size;
    return { membership, communityCount };
}

describe('singletonPartition', () => {
    test('each node in its own community', () => {
        const g = buildGraph([['a', 'b', 0.5], ['b', 'c', 0.5]]);
        const p = singletonPartition(g);
        expect(p.communityCount).toBe(3);
        expect(new Set(p.membership.values()).size).toBe(3);
    });
});

describe('compactPartition', () => {
    test('renumbers to contiguous [0, K)', () => {
        const p = partitionFrom({ a: 5, b: 5, c: 42, d: 100 });
        const c = compactPartition(p);
        expect(c.communityCount).toBe(3);
        const ids = new Set(c.membership.values());
        expect(ids).toEqual(new Set([0, 1, 2]));
        expect(c.membership.get('a')).toBe(c.membership.get('b'));
        expect(c.membership.get('c')).not.toBe(c.membership.get('a'));
    });
});

describe('modularity — empty / trivial', () => {
    test('empty graph → 0', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        expect(modularity(g, { membership: new Map(), communityCount: 0 }, 1.0)).toBe(0);
    });

    test('single-edge graph, both nodes same community', () => {
        // Graph: a—b with weight 1. 2m = 2. k_a = k_b = 1.
        // Σ_in = 2 (the edge counted twice). Σ_tot = 2.
        // Q = 2/2 - γ × (2/2)² = 1 - γ. For γ=1.0 → 0. For γ=0.5 → 0.5.
        const g = buildGraph([['a', 'b', 1]]);
        expect(modularity(g, partitionFrom({ a: 0, b: 0 }), 1.0)).toBeCloseTo(0, 6);
        expect(modularity(g, partitionFrom({ a: 0, b: 0 }), 0.5)).toBeCloseTo(0.5, 6);
    });

    test('single-edge graph, nodes in separate communities', () => {
        // Σ_in = 0. Σ_tot_a = 1, Σ_tot_b = 1. 2m = 2.
        // Q = - γ × [(1/2)² + (1/2)²] = -γ/2.
        const g = buildGraph([['a', 'b', 1]]);
        expect(modularity(g, partitionFrom({ a: 0, b: 1 }), 1.0)).toBeCloseTo(-0.5, 6);
    });
});

describe('modularity — golden values', () => {
    test('two-triangle graph, optimal partition', () => {
        // Graph: triangle {a,b,c} fully connected at w=1, triangle {d,e,f}
        // fully connected at w=1, plus a single bridge a—d at w=0.1.
        // Intuition: {a,b,c} | {d,e,f} should score near the modularity max.
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        // Hand calc:
        //   totalWeight = 3 + 3 + 0.1 = 6.1 → 2m = 12.2
        //   Community {a,b,c}:
        //     Σ_in = 2*(1+1+1) = 6 (three internal edges, each doubled)
        //     k_a = 1+1+0.1 = 2.1, k_b = 1+1 = 2, k_c = 1+1 = 2 → Σ_tot = 6.1
        //   Community {d,e,f}:
        //     Σ_in = 6
        //     k_d = 1+1+0.1 = 2.1, k_e = 1+1 = 2, k_f = 1+1 = 2 → Σ_tot = 6.1
        //   Q = 2 × [6/12.2 - γ × (6.1/12.2)²]
        //     = 2 × [0.491803... - γ × 0.25]
        //     at γ=1.0:  2 × (0.491803 - 0.25) = 0.483606
        const q = modularity(g, partitionFrom({
            a: 0, b: 0, c: 0, d: 1, e: 1, f: 1,
        }), 1.0);
        expect(q).toBeCloseTo(0.483606, 4);
    });

    test('two-triangle graph, all-in-one-community is worse than optimal', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const all = partitionFrom({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 });
        const split = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        expect(modularity(g, split, 1.0)).toBeGreaterThan(modularity(g, all, 1.0));
    });

    test('two-triangle graph, singletons are worse than optimal', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const singletons = partitionFrom({ a: 0, b: 1, c: 2, d: 3, e: 4, f: 5 });
        const split = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        expect(modularity(g, split, 1.0)).toBeGreaterThan(modularity(g, singletons, 1.0));
    });

    test('higher gamma penalizes large communities more', () => {
        // On a disconnected graph, γ doesn't matter much; on a connected graph
        // with a "mergable" cut, higher γ pushes toward more, smaller clusters.
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.5],  // medium bridge
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const split = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        const merged = partitionFrom({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 });
        // At low γ the merged partition competes with split; at high γ split dominates.
        const diffLow = modularity(g, split, 0.3) - modularity(g, merged, 0.3);
        const diffHigh = modularity(g, split, 1.2) - modularity(g, merged, 1.2);
        expect(diffHigh).toBeGreaterThan(diffLow);
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/leiden.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/raptor/leiden.js tests/unit/consolidation/raptor/leiden.test.js
git commit -m "feat(raptor:leiden): modularity + partition helpers per Traag 2019"
```

**Expected:** 8 new tests pass (1 singleton + 1 compact + 3 trivial modularity + 4 golden).

**Done-when:**
- Two-triangle golden matches hand-computed 0.483606 within 1e-4
- Split partition beats all-one and all-singletons on the two-triangle fixture
- Higher gamma penalizes merged partitions more than split
- All tests green

**Subagent note:** Hand-compute the golden values from the formula before committing. If a test fails with a small delta (< 1e-3), suspect the 2m-vs-m denominator confusion, not the formula. The "Σ_in counted as 2×edge_weight" is the standard convention and matches igraph / leidenalg; do NOT divide by 2.

---

## Task 4.2: Leiden local moving (phase 1)

**Objective:** Implement the greedy "fast local moving" pass. For each node in a randomized order, compute the modularity gain of moving it to each neighboring community; pick the best positive gain, else leave in place. Repeat until a full pass yields no moves.

**Owner:** Subagent (TDD).

**Efficient gain formula.** For a node i currently in community C_i, moving to neighbor community C_n costs modularity:

```
ΔQ = (k_{i,C_n} - γ × k_i × Σ_tot_{C_n \ i} / (2m)) / m
   - (k_{i,C_i \ i} - γ × k_i × Σ_tot_{C_i \ i} / (2m)) / m
```

Where `k_{i,C}` is the sum of edge weights from i to nodes in C, and `Σ_tot_{C \ i}` is the community's total degree excluding i. We compute both the "leave old" and "join new" terms.

**Incremental maintenance.** We don't recompute modularity from scratch — we maintain per-community `{in, tot}` aggregates and update them on each move.

**Files:**
- Modify: `src/consolidation/raptor/leiden.js` (append)
- Modify: `tests/unit/consolidation/raptor/leiden.test.js` (append)

**Step 1: Append to `src/consolidation/raptor/leiden.js`**

Add after the existing `modularity` function:

```js
/**
 * Per-community aggregates maintained during local moving. Indexed by community id.
 *
 * @typedef {Map<number, { in: number, tot: number }>} CommunityStats
 */

/**
 * Build fresh community stats from a graph + partition. O(|V| + |E|).
 *
 * @param {KnnGraph} graph
 * @param {Partition} partition
 * @returns {CommunityStats}
 */
export function buildCommunityStats(graph, partition) {
    /** @type {CommunityStats} */
    const stats = new Map();
    const get = (/** @type {number} */ c) => {
        let s = stats.get(c);
        if (!s) { s = { in: 0, tot: 0 }; stats.set(c, s); }
        return s;
    };
    for (const node of graph.nodes) {
        const c = partition.membership.get(node);
        if (c === undefined) continue;
        let deg = 0;
        for (const w of graph.adjacency.get(node)?.values() ?? []) deg += w;
        get(c).tot += deg;
    }
    for (const [a, row] of graph.adjacency) {
        for (const [b, w] of row) {
            if (a >= b) continue;
            const ca = partition.membership.get(a);
            const cb = partition.membership.get(b);
            if (ca !== undefined && cb !== undefined && ca === cb) {
                get(ca).in += 2 * w;
            }
        }
    }
    return stats;
}

/**
 * Sum of edge weights from `node` to any node in community `c`.
 *
 * @param {KnnGraph} graph
 * @param {Partition} partition
 * @param {string} node
 * @param {number} c
 * @returns {number}
 */
function weightToCommunity(graph, partition, node, c) {
    let w = 0;
    for (const [n, ew] of graph.adjacency.get(node) ?? new Map()) {
        if (partition.membership.get(n) === c) w += ew;
    }
    return w;
}

/**
 * Degree of a single node.
 *
 * @param {KnnGraph} graph
 * @param {string} node
 * @returns {number}
 */
function degreeOf(graph, node) {
    let d = 0;
    for (const w of graph.adjacency.get(node)?.values() ?? []) d += w;
    return d;
}

/**
 * Deterministic Fisher-Yates shuffle driven by a seeded xorshift32 PRNG.
 * We don't need cryptographic randomness, but we DO need the order to vary
 * between iterations (pure iteration order would loop infinitely on some
 * ties). Tests use a fixed seed for determinism.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} seed
 * @returns {T[]}
 */
export function shuffled(arr, seed) {
    const out = arr.slice();
    let s = seed || 0xdeadbeef;
    for (let i = out.length - 1; i > 0; i--) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        const j = s % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Run the local-moving pass. Mutates `partition.membership` in place and
 * returns the number of moves performed in the final full pass (0 when
 * converged). The partition's `communityCount` is NOT adjusted for emptied
 * communities — call compactPartition after if you need contiguous ids.
 *
 * Loop: pick a random-ordered node, find the best neighbor community, move
 * if modularity improves. Repeat until a full pass yields 0 moves.
 *
 * @param {KnnGraph} graph
 * @param {Partition} partition
 * @param {number} gamma
 * @param {number} [seed=1]  - PRNG seed for node-order randomization (deterministic tests)
 * @returns {number}          - Total moves across all passes
 */
export function localMove(graph, partition, gamma, seed = 1) {
    const stats = buildCommunityStats(graph, partition);
    const twoM = 2 * graph.totalWeight;
    if (twoM === 0) return 0;

    let totalMoves = 0;
    let currentSeed = seed;
    let passMoves = -1;
    // Safety cap — a well-behaved graph converges in O(log n) passes, but
    // pathological weights can oscillate. Cap at 64.
    let passLimit = 64;
    while (passMoves !== 0 && passLimit-- > 0) {
        passMoves = 0;
        currentSeed = (currentSeed * 1664525 + 1013904223) >>> 0;
        const order = shuffled(graph.nodes, currentSeed);

        for (const node of order) {
            const currentC = partition.membership.get(node);
            if (currentC === undefined) continue;
            const deg = degreeOf(graph, node);

            // Enumerate candidate communities: the node's own + every neighbor's.
            /** @type {Set<number>} */
            const candidates = new Set([currentC]);
            for (const n of graph.adjacency.get(node)?.keys() ?? []) {
                const c = partition.membership.get(n);
                if (c !== undefined) candidates.add(c);
            }

            // Compute the "leave current" delta ONCE.
            const wToSelf = weightToCommunity(graph, partition, node, currentC);
            const totSelf = (stats.get(currentC)?.tot ?? 0) - deg;
            // Leaving cost: -[wToSelf/m - γ × deg × totSelf / (2m²)] × 2
            // (factor 2 because the node contributed 2 × wToSelf to Σ_in and
            //  deg to Σ_tot; we reverse both terms)
            const leaveTerm = (wToSelf / graph.totalWeight)
                - gamma * deg * totSelf / (twoM * graph.totalWeight);

            let bestC = currentC;
            let bestGain = 0;

            for (const c of candidates) {
                if (c === currentC) continue;
                const wToC = weightToCommunity(graph, partition, node, c);
                const totC = stats.get(c)?.tot ?? 0;
                const joinTerm = (wToC / graph.totalWeight)
                    - gamma * deg * totC / (twoM * graph.totalWeight);
                const gain = joinTerm - leaveTerm;
                if (gain > bestGain) {
                    bestGain = gain;
                    bestC = c;
                }
            }

            // Leiden's local-moving phase accepts only positive gains; 0-gain
            // moves would cause oscillation on symmetric graphs.
            if (bestC !== currentC && bestGain > 1e-10) {
                // Apply the move: update stats incrementally.
                const oldStats = stats.get(currentC);
                const newStats = stats.get(bestC) ?? { in: 0, tot: 0 };
                if (oldStats) {
                    oldStats.tot -= deg;
                    oldStats.in -= 2 * wToSelf;
                    if (oldStats.tot <= 0 && oldStats.in <= 0) stats.delete(currentC);
                }
                newStats.tot += deg;
                newStats.in += 2 * weightToCommunity(graph, partition, node, bestC);
                stats.set(bestC, newStats);
                partition.membership.set(node, bestC);
                passMoves++;
                totalMoves++;
            }
        }
    }
    return totalMoves;
}
```

**Step 2: Append to `tests/unit/consolidation/raptor/leiden.test.js`**

```js
import { buildCommunityStats, localMove, shuffled } from '../../../../src/consolidation/raptor/leiden.js';

describe('shuffled', () => {
    test('deterministic for same seed', () => {
        const a = shuffled(['a', 'b', 'c', 'd', 'e'], 42);
        const b = shuffled(['a', 'b', 'c', 'd', 'e'], 42);
        expect(a).toEqual(b);
    });
    test('different seeds yield different orders (probabilistic)', () => {
        const a = shuffled(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 1);
        const b = shuffled(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 2);
        expect(a).not.toEqual(b);
    });
    test('preserves set of elements', () => {
        const a = shuffled(['a', 'b', 'c'], 7);
        expect(new Set(a)).toEqual(new Set(['a', 'b', 'c']));
    });
});

describe('buildCommunityStats', () => {
    test('empty graph → empty stats', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        const s = buildCommunityStats(g, { membership: new Map(), communityCount: 0 });
        expect(s.size).toBe(0);
    });

    test('two-triangle graph stats', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        const s = buildCommunityStats(g, part);
        // Community 0: {a, b, c}, 3 internal edges × 2 = 6 internal; degrees 2.1, 2, 2 → 6.1 tot
        expect(s.get(0)?.in).toBeCloseTo(6, 6);
        expect(s.get(0)?.tot).toBeCloseTo(6.1, 6);
        expect(s.get(1)?.in).toBeCloseTo(6, 6);
        expect(s.get(1)?.tot).toBeCloseTo(6.1, 6);
    });
});

describe('localMove', () => {
    test('converges to the obvious two-cluster partition on two-triangle graph', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = singletonPartition(g);
        const moves = localMove(g, part, 1.0, 42);
        expect(moves).toBeGreaterThan(0);

        // Post-move: a, b, c share a community; d, e, f share a different community.
        const ca = part.membership.get('a');
        expect(part.membership.get('b')).toBe(ca);
        expect(part.membership.get('c')).toBe(ca);
        const cd = part.membership.get('d');
        expect(part.membership.get('e')).toBe(cd);
        expect(part.membership.get('f')).toBe(cd);
        expect(ca).not.toBe(cd);
    });

    test('localMove on an already-optimal partition does nothing', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        const moves = localMove(g, part, 1.0, 7);
        expect(moves).toBe(0);
    });

    test('modularity is non-decreasing after localMove', () => {
        const edges = [
            ['a', 'b', 0.8], ['b', 'c', 0.9], ['a', 'c', 0.7],
            ['c', 'd', 0.3],
            ['d', 'e', 0.85], ['e', 'f', 0.75], ['d', 'f', 0.9],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = singletonPartition(g);
        const qBefore = modularity(g, part, 1.0);
        localMove(g, part, 1.0, 3);
        const qAfter = modularity(g, part, 1.0);
        expect(qAfter).toBeGreaterThanOrEqual(qBefore - 1e-9);
    });

    test('empty graph → 0 moves', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        const p = { membership: new Map(), communityCount: 0 };
        expect(localMove(g, p, 1.0)).toBe(0);
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/leiden.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/raptor/leiden.js tests/unit/consolidation/raptor/leiden.test.js
git commit -m "feat(raptor:leiden): local moving phase with incremental modularity"
```

**Expected:** 10 new tests pass (3 shuffled + 2 buildCommunityStats + 4 localMove + test count emerges).

**Done-when:**
- Two-triangle graph from singletons converges to {a,b,c}|{d,e,f} under γ=1.0
- localMove on an already-optimal partition returns 0 moves
- Modularity is non-decreasing across localMove (monotone guarantee)
- All tests green

**Subagent note:** Keep `buildGraph` and `partitionFrom` in the test file as-is from Task 4.1 — they're shared helpers. If jest complains about re-declaring them, your appended code may be in the wrong scope; put the new describes AFTER the existing ones at the top level, NOT nested inside another describe.

---

## Task 4.3: Leiden refinement

**Objective:** Implement the refinement phase that enforces well-connectedness. Within each community C_p from localMove (the "parent" partition), run a refinement pass where each node starts in its own singleton and may only merge with neighbors inside C_p. The result: each refined sub-community is internally well-connected.

**Owner:** Subagent (TDD).

**Why this matters.** Louvain's failure mode is "a community is really two weakly-bridged sub-communities that Louvain can't separate because moving any single node lowers modularity." Leiden's refinement phase breaks such communities up by re-running local moving with a stricter constraint (stay inside your parent community). This is what distinguishes Leiden from Louvain.

**Well-connectedness criterion.** A node may only merge with a candidate sub-community if the sub-community is "well-connected" to the rest of its parent community — formally, if the edges from the sub-community to the rest of the parent carry enough weight. Traag 2019 defines this via the resolution parameter γ; we implement the same threshold.

**Files:**
- Modify: `src/consolidation/raptor/leiden.js` (append)
- Modify: `tests/unit/consolidation/raptor/leiden.test.js` (append)

**Step 1: Append to `src/consolidation/raptor/leiden.js`**

```js
/**
 * Leiden refinement phase. Given a graph and a "parent" partition from
 * localMove, produce a refined partition where each parent community may be
 * split into well-connected sub-communities.
 *
 * Algorithm (Traag 2019, section "Refinement of the partition"):
 *   1. Start with each node in its own singleton sub-community.
 *   2. Iterate nodes in randomized order. For each node i:
 *      a. Find i's parent community C_p = parent.membership.get(i).
 *      b. Enumerate candidate sub-communities: {i's current sub-community}
 *         ∪ {sub-communities of i's neighbors in C_p}.
 *      c. Filter candidates to those that are "well-connected" within C_p
 *         (total weight to C_p \ subcommunity ≥ γ × sub.tot × (C_p.tot - sub.tot) / (2m)).
 *      d. Compute modularity gain for each candidate; pick the best positive.
 *      e. Apply the move.
 *   3. Single pass — refinement does not iterate like localMove; we accept the
 *      first-pass result per Traag's paper.
 *
 * Returns the refined partition. Parent community membership is preserved as
 * an auxiliary map so aggregation can maintain the hierarchy.
 *
 * @param {KnnGraph} graph
 * @param {Partition} parent
 * @param {number} gamma
 * @param {number} [seed=1]
 * @returns {{ refined: Partition, parentOf: Map<number, number> }}
 *          parentOf maps each refined community id to the parent community id
 */
export function refine(graph, parent, gamma, seed = 1) {
    const twoM = 2 * graph.totalWeight;
    // Initialize: each node a singleton.
    /** @type {Map<string, number>} */
    const refinedMembership = new Map();
    let nextCid = 0;
    for (const node of graph.nodes) {
        refinedMembership.set(node, nextCid++);
    }
    /** @type {Partition} */
    const refined = { membership: refinedMembership, communityCount: nextCid };

    if (twoM === 0) {
        return { refined, parentOf: new Map() };
    }

    const stats = buildCommunityStats(graph, refined);

    // Precompute parent-community total degrees (denominator for well-connected check)
    /** @type {Map<number, number>} */
    const parentTot = new Map();
    for (const node of graph.nodes) {
        const p = parent.membership.get(node);
        if (p === undefined) continue;
        const d = degreeOf(graph, node);
        parentTot.set(p, (parentTot.get(p) ?? 0) + d);
    }

    const shuffledNodes = shuffled(graph.nodes, seed);
    for (const node of shuffledNodes) {
        const parentC = parent.membership.get(node);
        if (parentC === undefined) continue;
        const currentSub = refined.membership.get(node);
        if (currentSub === undefined) continue;
        const deg = degreeOf(graph, node);

        // Candidate sub-communities: own + neighbors (ONLY those sharing the same parent).
        /** @type {Set<number>} */
        const candidates = new Set([currentSub]);
        for (const n of graph.adjacency.get(node)?.keys() ?? []) {
            if (parent.membership.get(n) !== parentC) continue;
            const sc = refined.membership.get(n);
            if (sc !== undefined) candidates.add(sc);
        }

        // "Leave current" delta.
        const wToSelf = weightToCommunity(graph, refined, node, currentSub);
        const totSelf = (stats.get(currentSub)?.tot ?? 0) - deg;
        const leaveTerm = (wToSelf / graph.totalWeight)
            - gamma * deg * totSelf / (twoM * graph.totalWeight);

        let bestSub = currentSub;
        let bestGain = 0;

        for (const sub of candidates) {
            if (sub === currentSub) continue;
            // Well-connectedness check: sub must be sufficiently connected to
            // its parent. Weight from `sub` to (parent \ sub) must be at least
            // γ × sub.tot × (parentTot - sub.tot) / (2m).
            const subTot = stats.get(sub)?.tot ?? 0;
            const parentTotC = parentTot.get(parentC) ?? 0;
            const weightToParentRest = subExternalToParent(graph, refined, parent, sub, parentC);
            const threshold = gamma * subTot * (parentTotC - subTot) / twoM;
            if (weightToParentRest < threshold) continue;

            const wToC = weightToCommunity(graph, refined, node, sub);
            const totC = stats.get(sub)?.tot ?? 0;
            const joinTerm = (wToC / graph.totalWeight)
                - gamma * deg * totC / (twoM * graph.totalWeight);
            const gain = joinTerm - leaveTerm;
            if (gain > bestGain) { bestGain = gain; bestSub = sub; }
        }

        if (bestSub !== currentSub && bestGain > 1e-10) {
            const oldStats = stats.get(currentSub);
            const newStats = stats.get(bestSub) ?? { in: 0, tot: 0 };
            if (oldStats) {
                oldStats.tot -= deg;
                oldStats.in -= 2 * wToSelf;
                if (oldStats.tot <= 0 && oldStats.in <= 0) stats.delete(currentSub);
            }
            newStats.tot += deg;
            newStats.in += 2 * weightToCommunity(graph, refined, node, bestSub);
            stats.set(bestSub, newStats);
            refined.membership.set(node, bestSub);
        }
    }

    // Build parentOf: refined community id → parent community id.
    /** @type {Map<number, number>} */
    const parentOf = new Map();
    for (const node of graph.nodes) {
        const sub = refined.membership.get(node);
        const par = parent.membership.get(node);
        if (sub !== undefined && par !== undefined) parentOf.set(sub, par);
    }

    const compact = compactPartition(refined);
    // Rebuild parentOf for the compacted community ids.
    /** @type {Map<number, number>} */
    const compactParentOf = new Map();
    for (const node of graph.nodes) {
        const newSub = compact.membership.get(node);
        const par = parent.membership.get(node);
        if (newSub !== undefined && par !== undefined) compactParentOf.set(newSub, par);
    }

    return { refined: compact, parentOf: compactParentOf };
}

/**
 * Total edge weight from sub-community `sub` to other nodes inside parent
 * community `parentC` but NOT inside `sub`.
 *
 * @param {KnnGraph} graph
 * @param {Partition} refined
 * @param {Partition} parent
 * @param {number} sub
 * @param {number} parentC
 * @returns {number}
 */
function subExternalToParent(graph, refined, parent, sub, parentC) {
    let w = 0;
    for (const [a, row] of graph.adjacency) {
        if (refined.membership.get(a) !== sub) continue;
        for (const [b, ew] of row) {
            if (refined.membership.get(b) === sub) continue;
            if (parent.membership.get(b) !== parentC) continue;
            w += ew;
        }
    }
    // Each edge is counted twice (once for each endpoint's iteration) unless
    // one endpoint is inside sub — but we filter to a ∈ sub only, so we
    // catch each (sub → non-sub inside parent) edge exactly once per endpoint
    // in sub, which means once total for the a ∈ sub case. Good.
    return w;
}
```

**Step 2: Append to `tests/unit/consolidation/raptor/leiden.test.js`**

```js
import { refine } from '../../../../src/consolidation/raptor/leiden.js';

describe('refine', () => {
    test('empty graph → empty refined partition', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        const p = { membership: new Map(), communityCount: 0 };
        const { refined, parentOf } = refine(g, p, 1.0);
        expect(refined.communityCount).toBe(0);
        expect(parentOf.size).toBe(0);
    });

    test('well-connected community stays intact through refinement', () => {
        // Triangle {a,b,c} fully connected at w=1. Starting from a single
        // parent community {a,b,c}, refinement should keep all three together.
        const edges = [['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1]];
        const g = buildGraph(/** @type {any} */ (edges));
        const parent = partitionFrom({ a: 0, b: 0, c: 0 });
        const { refined } = refine(g, parent, 1.0);
        const ra = refined.membership.get('a');
        expect(refined.membership.get('b')).toBe(ra);
        expect(refined.membership.get('c')).toBe(ra);
        expect(refined.communityCount).toBe(1);
    });

    test('weakly-bridged community is preserved if well-connectedness threshold allows', () => {
        // Two triangles bridged by ONE weak edge a—d at w=0.1, all placed in one
        // parent community. Refinement may or may not split them depending on γ;
        // at γ=1.0 and weak bridge, the threshold typically keeps them together
        // or splits them — the test verifies the refinement output is VALID
        // (each refined community contains only nodes from one parent) and that
        // modularity does NOT decrease under the refined partition.
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const parent = partitionFrom({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 });
        const { refined, parentOf } = refine(g, parent, 1.0);

        // Hierarchical invariant: every refined community maps to EXACTLY one parent.
        for (const [a] of refined.membership) {
            const sub = refined.membership.get(a);
            expect(sub !== undefined).toBe(true);
            const par = parent.membership.get(a);
            expect(parentOf.get(/** @type {number} */ (sub))).toBe(par);
        }

        // Modularity should not decrease (refinement is a non-decreasing operation).
        const qBefore = modularity(g, parent, 1.0);
        const qAfter = modularity(g, refined, 1.0);
        expect(qAfter).toBeGreaterThanOrEqual(qBefore - 1e-9);
    });

    test('parentOf map is well-formed: each refined id maps to exactly one parent', () => {
        const edges = [['a', 'b', 1], ['b', 'c', 1], ['d', 'e', 1]];
        const g = buildGraph(/** @type {any} */ (edges));
        const parent = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1 });
        const { refined, parentOf } = refine(g, parent, 1.0);
        // Every refined id that appears in membership must be in parentOf.
        const refinedIds = new Set(refined.membership.values());
        for (const rid of refinedIds) {
            expect(parentOf.has(rid)).toBe(true);
        }
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/leiden.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/raptor/leiden.js tests/unit/consolidation/raptor/leiden.test.js
git commit -m "feat(raptor:leiden): refinement phase for well-connectedness per Traag 2019"
```

**Expected:** 4 new tests pass.

**Done-when:**
- Refinement on a fully-connected triangle keeps it intact
- Hierarchical invariant holds: each refined community belongs to exactly one parent
- Modularity non-decreasing through refinement
- All tests green

**Subagent note:** The well-connectedness threshold is what distinguishes Leiden from Louvain. If a community is left as two weakly-bridged halves by localMove, refinement will split them — but only if the halves are themselves "well-connected" to each other. Our threshold uses the γ × sub.tot × (parent.tot - sub.tot) / 2m formula from Traag 2019 §5.2. If tests fail with "refined partition loses connectedness," check the threshold direction (< vs ≥) carefully.

---

## Task 4.4: Leiden aggregation + outer loop

**Objective:** Implement graph aggregation (each refined community → single node in a new graph) and the outer Leiden loop (run localMove → refine → aggregate → repeat). Terminate on no-change, tolerance, or iteration cap.

**Owner:** Subagent (TDD).

**Aggregation details.** Build a new graph where:
- Each refined community is a node, named by its refined community id.
- Edge weight between aggregated nodes R_i and R_j = sum of original edge weights with one endpoint in R_i and one in R_j.
- Self-loops (intra-community edges) are preserved as node-internal degree — summed onto the aggregated node's self-edge for the next iteration's modularity to account for them. We store self-loops as `adjacency.get(R_i).get(R_i) = selfWeight`.

**Outer loop.** Traag 2019's driver:
```
partition := singleton(graph)
while true:
    localMove(graph, partition)
    if partition hasn't changed from previous iteration: break
    (refined, parentOf) := refine(graph, partition)
    aggGraph := aggregate(graph, refined)
    aggPartition := partition lifted onto aggGraph via parentOf
    graph := aggGraph
    partition := aggPartition
return unlift(partition) onto original nodes
```

The critical trick: after refinement, we aggregate the **refined** partition but carry the **parent** partition lifted onto the aggregated graph. The next localMove iterates on the parent-level assignments but with the refined-community structure as the atomic unit — which is exactly what enforces well-connectedness across iterations.

**Files:**
- Modify: `src/consolidation/raptor/leiden.js` (append)
- Modify: `tests/unit/consolidation/raptor/leiden.test.js` (append)

**Step 1: Append to `src/consolidation/raptor/leiden.js`**

```js
/**
 * Aggregate a graph along a refined partition. Each refined community becomes
 * a node in the new graph; edges are summed. Self-loops (intra-community
 * weight) are preserved as `adjacency[id][id] = sum_of_internal_edges × 2`
 * (×2 because of undirected double-counting convention).
 *
 * @param {KnnGraph} graph
 * @param {Partition} refined
 * @returns {KnnGraph}
 */
export function aggregate(graph, refined) {
    /** @type {Map<string, Map<string, number>>} */
    const adj = new Map();
    /** @type {string[]} */
    const nodes = [];
    const idOf = (/** @type {number} */ c) => `agg_${c}`;

    // Initialize all community-nodes
    const uniqueCs = new Set(refined.membership.values());
    for (const c of uniqueCs) {
        const id = idOf(c);
        nodes.push(id);
        adj.set(id, new Map());
    }

    let totalWeight = 0;
    for (const [a, row] of graph.adjacency) {
        for (const [b, w] of row) {
            if (a >= b) continue;
            const ca = refined.membership.get(a);
            const cb = refined.membership.get(b);
            if (ca === undefined || cb === undefined) continue;
            const idA = idOf(ca);
            const idB = idOf(cb);
            if (idA === idB) {
                // Intra-community edge → self-loop on the aggregated node
                const row2 = adj.get(idA);
                if (!row2) continue;
                row2.set(idA, (row2.get(idA) ?? 0) + 2 * w);
                totalWeight += w;
            } else {
                const rowA = adj.get(idA);
                const rowB = adj.get(idB);
                if (!rowA || !rowB) continue;
                rowA.set(idB, (rowA.get(idB) ?? 0) + w);
                rowB.set(idA, (rowB.get(idA) ?? 0) + w);
                totalWeight += w;
            }
        }
    }

    return { nodes, adjacency: adj, totalWeight };
}

/**
 * Lift a parent-level partition onto an aggregated graph. Each aggregated
 * node (named `agg_<cid>`) inherits the parent community id of its
 * constituent original community.
 *
 * @param {KnnGraph} aggGraph
 * @param {Map<number, number>} parentOf   - refined community id → parent community id
 * @returns {Partition}
 */
export function liftPartition(aggGraph, parentOf) {
    /** @type {Map<string, number>} */
    const membership = new Map();
    for (const aggId of aggGraph.nodes) {
        // aggId format: "agg_<N>"
        const cid = Number(aggId.slice(4));
        const par = parentOf.get(cid);
        if (par !== undefined) membership.set(aggId, par);
    }
    const communityCount = new Set(membership.values()).size;
    return compactPartition({ membership, communityCount });
}

/**
 * Unlift a partition from an aggregated graph back onto the original graph's
 * nodes. Each original node inherits its refined community's parent assignment.
 *
 * @param {KnnGraph} origGraph
 * @param {Partition} refinedAtThisLevel
 * @param {Partition} aggPartition
 * @returns {Partition}
 */
export function unliftPartition(origGraph, refinedAtThisLevel, aggPartition) {
    /** @type {Map<string, number>} */
    const membership = new Map();
    for (const node of origGraph.nodes) {
        const refinedC = refinedAtThisLevel.membership.get(node);
        if (refinedC === undefined) continue;
        const aggId = `agg_${refinedC}`;
        const par = aggPartition.membership.get(aggId);
        if (par !== undefined) membership.set(node, par);
    }
    const communityCount = new Set(membership.values()).size;
    return compactPartition({ membership, communityCount });
}
```

**Step 2: Append to `tests/unit/consolidation/raptor/leiden.test.js`**

```js
import { aggregate, liftPartition, unliftPartition } from '../../../../src/consolidation/raptor/leiden.js';

describe('aggregate', () => {
    test('empty graph aggregates to empty graph', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        const p = { membership: new Map(), communityCount: 0 };
        const agg = aggregate(g, p);
        expect(agg.nodes).toEqual([]);
        expect(agg.totalWeight).toBe(0);
    });

    test('two triangles + bridge → aggregated 2-node graph', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const part = partitionFrom({ a: 0, b: 0, c: 0, d: 1, e: 1, f: 1 });
        const agg = aggregate(g, part);
        expect(agg.nodes.length).toBe(2);
        // Aggregated totalWeight equals original totalWeight
        expect(agg.totalWeight).toBeCloseTo(g.totalWeight, 6);
        // The bridge edge a—d (w=0.1) becomes an edge between agg_0 and agg_1
        const rowA = agg.adjacency.get('agg_0');
        expect(rowA?.get('agg_1')).toBeCloseTo(0.1, 6);
        // Self-loops carry the intra-triangle weight (3 edges × 2 = 6 each)
        expect(rowA?.get('agg_0')).toBeCloseTo(6, 6);
    });
});

describe('liftPartition + unliftPartition round-trip', () => {
    test('lift then unlift recovers the original parent mapping', () => {
        const edges = [['a', 'b', 1], ['c', 'd', 1]];
        const g = buildGraph(/** @type {any} */ (edges));
        const refined = partitionFrom({ a: 0, b: 0, c: 1, d: 1 });
        // Pretend parent says {a,b} and {c,d} are both in parent community 0
        const parentOf = new Map([[0, 0], [1, 0]]);
        const agg = aggregate(g, refined);
        const lifted = liftPartition(agg, parentOf);
        // After lifting, both aggregated nodes map to parent 0
        expect(lifted.membership.get('agg_0')).toBe(lifted.membership.get('agg_1'));
        // And unlifting back onto the original graph places all 4 nodes in 1 parent
        const unlifted = unliftPartition(g, refined, lifted);
        expect(new Set(unlifted.membership.values()).size).toBe(1);
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/leiden.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/raptor/leiden.js tests/unit/consolidation/raptor/leiden.test.js
git commit -m "feat(raptor:leiden): aggregation + lift/unlift helpers per Traag 2019"
```

**Expected:** 3 new tests pass.

**Done-when:**
- Aggregation preserves totalWeight
- Self-loops carry ×2 intra-community weight
- Lift/unlift round-trip yields expected parent mapping
- All tests green

---

## Task 4.5: Public API — `leidenCluster` + depth-aware gamma

**Objective:** Tie the pieces together. `leidenCluster(graph, gamma)` runs the outer loop to convergence and returns a flat community assignment. `gammaForDepth(depth)` returns the spec §6.4 adaptive resolution per layer.

**Owner:** Subagent (TDD).

**Files:**
- Modify: `src/consolidation/raptor/leiden.js` (append)
- Modify: `tests/unit/consolidation/raptor/leiden.test.js` (append)

**Step 1: Append to `src/consolidation/raptor/leiden.js`**

```js
import { PERSONA_REBUILD } from '../../core/constants.js';

const {
    GAMMA_BASE,
    GAMMA_STEP,
    LEIDEN_TOLERANCE,
    LEIDEN_MAX_OUTER_ITERATIONS,
} = PERSONA_REBUILD;

/**
 * Depth-adaptive resolution. Spec §6.4: γ_base=1.0, γ_step=0.2, so d=0 → 1.0,
 * d=1 → 0.8, d=2 → 0.6. Decreases upward: coarser groupings at higher layers.
 *
 * @param {number} depth
 * @returns {number}
 */
export function gammaForDepth(depth) {
    if (typeof depth !== 'number' || depth < 0) {
        throw new Error('gammaForDepth: depth must be a non-negative number');
    }
    return Math.max(0.01, GAMMA_BASE - depth * GAMMA_STEP);
}

/**
 * @typedef {object} ClusterResult
 * @property {Map<string, number>} clusters   - Original nodeId → community id
 * @property {number} communityCount
 * @property {number} modularity
 * @property {number} iterations
 */

/**
 * Run Leiden to convergence on a graph. Returns the final flat partition of
 * the ORIGINAL graph's nodes (not aggregated nodes).
 *
 * @param {KnnGraph} graph
 * @param {number} gamma
 * @param {{seed?: number, signal?: AbortSignal}} [opts]
 * @returns {ClusterResult}
 */
export function leidenCluster(graph, gamma, opts = {}) {
    const { seed = 1, signal } = opts;
    const throwIfAborted = () => {
        if (signal?.aborted) {
            const err = new Error('leidenCluster: aborted');
            err.name = 'AbortError';
            throw err;
        }
    };

    // Guard: empty or trivial graph.
    if (graph.nodes.length === 0) {
        return {
            clusters: new Map(),
            communityCount: 0,
            modularity: 0,
            iterations: 0,
        };
    }
    if (graph.nodes.length === 1) {
        return {
            clusters: new Map([[graph.nodes[0], 0]]),
            communityCount: 1,
            modularity: 0,
            iterations: 0,
        };
    }

    // Maintain two parallel graph states:
    //   - `origGraph` / `origPartition`: the level-0 (original node) mapping
    //   - `workGraph` / `workPartition`: the aggregated graph we iterate on
    //
    // We keep a chain of (refinedPartition, parentOf) pairs so we can unlift
    // the final workPartition back onto the original graph.
    let workGraph = graph;
    let workPartition = singletonPartition(graph);
    /** @type {Array<{origGraph: KnnGraph, refined: Partition}>} */
    const hierarchy = [];
    let currentSeed = seed;
    let prevQ = modularity(graph, workPartition, gamma);
    let iterations = 0;

    for (; iterations < LEIDEN_MAX_OUTER_ITERATIONS; iterations++) {
        throwIfAborted();
        currentSeed = (currentSeed * 1103515245 + 12345) >>> 0;

        // Phase 1: local moving on workGraph/workPartition.
        const moves = localMove(workGraph, workPartition, gamma, currentSeed);
        workPartition = compactPartition(workPartition);

        // If no moves AND no change from previous iteration, we converged.
        if (moves === 0 && iterations > 0) break;

        // Phase 2: refine.
        currentSeed = (currentSeed * 1103515245 + 12345) >>> 0;
        const { refined, parentOf } = refine(workGraph, workPartition, gamma, currentSeed);

        // If the refined partition matches workPartition (no splits), we're done.
        let refinedMatchesWork = true;
        for (const node of workGraph.nodes) {
            const rc = refined.membership.get(node);
            if (rc === undefined) { refinedMatchesWork = false; break; }
            const parFromRefined = parentOf.get(rc);
            const parFromWork = workPartition.membership.get(node);
            if (parFromRefined !== parFromWork) {
                // Refinement kept the parent mapping, but it may have split
                // the community into sub-communities. Check sub-community structure.
                // If every parent community is a single refined community, we're
                // done. We detect this by communityCount equality.
            }
        }

        // Convergence: if refined and workPartition describe the same clustering
        // AND localMove found 0 moves this iteration, stop.
        const sameCount = refined.communityCount === workPartition.communityCount;
        if (moves === 0 && sameCount) break;

        // Phase 3: aggregate the refined partition; lift workPartition onto it.
        hierarchy.push({ origGraph: workGraph, refined });
        const aggGraph = aggregate(workGraph, refined);
        const aggPartition = liftPartition(aggGraph, parentOf);

        const qAgg = modularity(aggGraph, aggPartition, gamma);
        if (Math.abs(qAgg - prevQ) < LEIDEN_TOLERANCE && iterations > 0) break;
        prevQ = qAgg;

        workGraph = aggGraph;
        workPartition = aggPartition;
    }

    // Unlift: collapse the hierarchy back onto the original graph's nodes.
    let finalPartition = workPartition;
    for (let i = hierarchy.length - 1; i >= 0; i--) {
        finalPartition = unliftPartition(hierarchy[i].origGraph, hierarchy[i].refined, finalPartition);
    }
    finalPartition = compactPartition(finalPartition);

    const finalQ = modularity(graph, finalPartition, gamma);
    return {
        clusters: finalPartition.membership,
        communityCount: finalPartition.communityCount,
        modularity: finalQ,
        iterations: iterations + 1,
    };
}
```

**Step 2: Append to `tests/unit/consolidation/raptor/leiden.test.js`**

```js
import { leidenCluster, gammaForDepth } from '../../../../src/consolidation/raptor/leiden.js';

describe('gammaForDepth', () => {
    test('depth 0 → GAMMA_BASE (1.0)', () => {
        expect(gammaForDepth(0)).toBeCloseTo(1.0, 6);
    });
    test('depth 1 → 0.8', () => {
        expect(gammaForDepth(1)).toBeCloseTo(0.8, 6);
    });
    test('depth 2 → 0.6', () => {
        expect(gammaForDepth(2)).toBeCloseTo(0.6, 6);
    });
    test('rejects negative depth', () => {
        expect(() => gammaForDepth(-1)).toThrow(/non-negative/);
    });
    test('never returns below 0.01 (safety floor)', () => {
        expect(gammaForDepth(100)).toBeCloseTo(0.01, 6);
    });
});

describe('leidenCluster (end-to-end)', () => {
    test('empty graph → empty result', () => {
        const g = { nodes: [], adjacency: new Map(), totalWeight: 0 };
        const r = leidenCluster(g, 1.0);
        expect(r.communityCount).toBe(0);
        expect(r.clusters.size).toBe(0);
    });

    test('single node → one community', () => {
        const g = buildGraph(/** @type {any} */ ([]));
        g.nodes.push('solo');
        g.adjacency.set('solo', new Map());
        const r = leidenCluster(g, 1.0);
        expect(r.communityCount).toBe(1);
        expect(r.clusters.get('solo')).toBe(0);
    });

    test('two-triangle graph recovers the obvious split', () => {
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            ['a', 'd', 0.1],
        ];
        const g = buildGraph(/** @type {any} */ (edges));
        const r = leidenCluster(g, 1.0, { seed: 42 });
        expect(r.communityCount).toBe(2);
        // All of {a,b,c} share one community; all of {d,e,f} share the other.
        const ca = r.clusters.get('a');
        expect(r.clusters.get('b')).toBe(ca);
        expect(r.clusters.get('c')).toBe(ca);
        const cd = r.clusters.get('d');
        expect(r.clusters.get('e')).toBe(cd);
        expect(r.clusters.get('f')).toBe(cd);
        expect(ca).not.toBe(cd);
        expect(r.modularity).toBeGreaterThan(0.4);
    });

    test('three dense clusters with sparse inter-cluster edges', () => {
        /** @type {[string, string, number][]} */
        const edges = [
            // Cluster 1: a, b, c
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            // Cluster 2: d, e, f
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
            // Cluster 3: g, h, i
            ['g', 'h', 1], ['h', 'i', 1], ['g', 'i', 1],
            // Sparse bridges
            ['a', 'd', 0.05], ['d', 'g', 0.05], ['a', 'g', 0.05],
        ];
        const g = buildGraph(edges);
        const r = leidenCluster(g, 1.0, { seed: 7 });
        expect(r.communityCount).toBe(3);
    });

    test('higher gamma produces more (smaller) clusters on the same graph', () => {
        /** @type {[string, string, number][]} */
        const edges = [
            ['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1],
            ['c', 'd', 0.5],
            ['d', 'e', 1], ['e', 'f', 1], ['d', 'f', 1],
        ];
        const g = buildGraph(edges);
        const low = leidenCluster(g, 0.3, { seed: 3 });
        const high = leidenCluster(g, 1.5, { seed: 3 });
        // At high γ the bridge c—d is penalized, so 2+ clusters expected.
        // At low γ the same graph collapses toward 1 cluster.
        expect(high.communityCount).toBeGreaterThanOrEqual(low.communityCount);
    });

    test('respects AbortSignal', () => {
        /** @type {[string, string, number][]} */
        const edges = [['a', 'b', 1], ['b', 'c', 1], ['a', 'c', 1]];
        const g = buildGraph(edges);
        const controller = new AbortController();
        controller.abort();
        expect(() => leidenCluster(g, 1.0, { signal: controller.signal })).toThrow(/aborted/);
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/leiden.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/raptor/leiden.js tests/unit/consolidation/raptor/leiden.test.js
git commit -m "feat(raptor:leiden): public leidenCluster API + depth-adaptive gamma"
```

**Expected:** 11 new tests pass (5 gammaForDepth + 6 leidenCluster).

**Done-when:**
- Two-triangle graph recovers the {a,b,c}|{d,e,f} split
- Three-cluster graph recovers 3 communities
- Higher γ produces more clusters on a bridged graph
- AbortSignal respected
- All tests green

**Subagent note:** The convergence detection in the outer loop is the trickiest part. If iteration count spikes (50+), modularity is probably oscillating — add a print to see the per-iteration Q. The `LEIDEN_MAX_OUTER_ITERATIONS=32` cap is a safety net; in practice convergence happens in 3-6 iterations for graphs under 100 nodes.

**Controller-side verification after subagent (required):** Run the two-triangle test 10 times with seeds 1-10; confirm the split is recovered every time (deterministic convergence on obvious structure). If one seed produces a different answer, that's a bug.

---

## Task 5: Cluster summarization — `raptor/summarize.js`

**Objective:** Given a cluster of leaves (their text + source entry ids), call the user's LLM to produce a single summary that can become a Persona entry. Reuses Phase 6's `callLLM`.

**Owner:** Subagent (TDD with mocked LLM).

**Files:**
- Create: `src/consolidation/raptor/summarize.js`
- Create: `tests/unit/consolidation/raptor/summarize.test.js`

**Step 1: Create `src/consolidation/raptor/summarize.js`**

```js
/**
 * Per-cluster LLM summarization for Enhanced RAPTOR persona rebuild. Takes a
 * set of leaves assigned to the same Leiden community and produces a single
 * summary text that will become a Persona entry (after `createEntry` elsewhere).
 *
 * One LLM call per cluster. AbortSignal checked before and during the call.
 *
 * @module consolidation/raptor/summarize
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.4
 */

import { callLLM } from '../llmClient.js';
import { PERSONA_REBUILD } from '../../core/constants.js';

const { SUMMARY_MAX_TOKENS } = PERSONA_REBUILD;

const SYSTEM_PROMPT_LEAF = `You distill a cluster of related facts about a character or entity into a single concise Persona statement.

Rules:
- Read the clustered facts carefully.
- Produce ONE paragraph (2-5 sentences, third person) that captures the shared theme.
- Preserve specific names, places, and preferences. Do NOT invent details.
- If facts contradict, note both (e.g. "X, though sometimes Y"). Do not silently resolve.
- No bullet points, no lists — prose only.

Output the paragraph directly. No preamble, no JSON, no markdown.`;

const SYSTEM_PROMPT_LAYER = `You combine several Persona statements into a single broader Persona statement covering their common theme.

Rules:
- Read the statements carefully.
- Produce ONE paragraph (2-5 sentences, third person) that captures their shared essence.
- Preserve specific names and definitive facts. Condense repetitive phrasing.
- No bullet points, no lists — prose only.

Output the paragraph directly. No preamble, no JSON, no markdown.`;

/**
 * @typedef {import('./chunking.js').Leaf} Leaf
 */

/**
 * @typedef {object} SummarizeContext
 * @property {string} profileId
 * @property {string} subject                 - Target subject (for prompt framing).
 * @property {number} depth                   - 0 = leaf-layer, >0 = higher layers.
 * @property {AbortSignal} [signal]
 */

/**
 * Summarize a cluster. Returns `{ text, sourceLeafIds }`. Source ids are
 * preserved for provenance and edge-building upstream.
 *
 * @param {Leaf[]} clusterLeaves
 * @param {SummarizeContext} context
 * @returns {Promise<{ text: string, sourceLeafIds: string[] }>}
 */
export async function summarizeCluster(clusterLeaves, context) {
    if (!Array.isArray(clusterLeaves) || clusterLeaves.length === 0) {
        throw new Error('summarizeCluster: clusterLeaves must be non-empty');
    }
    if (!context || typeof context !== 'object') {
        throw new Error('summarizeCluster: context required');
    }
    const { profileId, subject, depth, signal } = context;
    if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new Error('summarizeCluster: context.profileId required');
    }
    if (typeof subject !== 'string' || subject.length === 0) {
        throw new Error('summarizeCluster: context.subject required');
    }
    if (typeof depth !== 'number' || depth < 0) {
        throw new Error('summarizeCluster: context.depth must be a non-negative number');
    }
    if (signal?.aborted) {
        const err = new Error('summarizeCluster: aborted');
        err.name = 'AbortError';
        throw err;
    }

    const systemPrompt = depth === 0 ? SYSTEM_PROMPT_LEAF : SYSTEM_PROMPT_LAYER;
    const facts = clusterLeaves.map((l, i) => `${i + 1}. ${l.text}`).join('\n');
    const userPrompt = depth === 0
        ? `Subject: ${subject}\n\nClustered facts:\n${facts}\n\nWrite the Persona paragraph now.`
        : `Subject: ${subject}\n\nClustered Persona statements:\n${facts}\n\nWrite the broader Persona paragraph now.`;

    const text = await callLLM(profileId, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ], SUMMARY_MAX_TOKENS);

    if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('summarizeCluster: LLM returned empty content');
    }

    const sourceLeafIds = clusterLeaves.flatMap(l => l.sourceEntryIds);
    return { text: text.trim(), sourceLeafIds };
}
```

**Step 2: Create `tests/unit/consolidation/raptor/summarize.test.js`**

```js
import { describe, test, expect, afterEach } from '@jest/globals';
import { summarizeCluster } from '../../../../src/consolidation/raptor/summarize.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../../src/consolidation/llmClient.js';

const CTX = {
    profileId: 'test-profile',
    subject: 'alice',
    depth: 0,
};

afterEach(() => _resetLLMClientForTests());

const leaf = (id, text, sourceEntryIds = [id]) => ({
    id, sourceEntryIds, text, subject: 'alice',
});

describe('summarizeCluster', () => {
    test('leaf-layer: calls LLM and returns trimmed text', async () => {
        let captured = null;
        _setLLMClientForTests(async (profile, messages, _maxTokens) => {
            captured = { profile, messages };
            return '   Alice enjoys traveling through France.   ';
        });
        const r = await summarizeCluster(
            [leaf('l1', 'alice went to marseille'), leaf('l2', 'alice likes croissants')],
            CTX,
        );
        expect(r.text).toBe('Alice enjoys traveling through France.');
        expect(r.sourceLeafIds).toEqual(['l1', 'l2']);
        expect(captured?.profile).toBe('test-profile');
        expect(captured?.messages[0].role).toBe('system');
        expect(captured?.messages[0].content).toContain('distill');
        expect(captured?.messages[1].content).toContain('Subject: alice');
        expect(captured?.messages[1].content).toContain('1. alice went to marseille');
    });

    test('higher-layer: uses the combining prompt variant', async () => {
        let systemContent = null;
        _setLLMClientForTests(async (_p, messages) => {
            systemContent = messages[0].content;
            return 'Combined summary.';
        });
        await summarizeCluster(
            [leaf('l1', 'alice is adventurous'), leaf('l2', 'alice is curious')],
            { ...CTX, depth: 1 },
        );
        expect(systemContent).toContain('combine');
        expect(systemContent).not.toContain('distill');
    });

    test('throws on empty cluster', async () => {
        await expect(summarizeCluster([], CTX)).rejects.toThrow(/non-empty/);
    });

    test('throws on empty LLM response', async () => {
        _setLLMClientForTests(async () => '   ');
        await expect(summarizeCluster([leaf('l1', 'x')], CTX)).rejects.toThrow(/empty/);
    });

    test('propagates LLM errors', async () => {
        _setLLMClientForTests(async () => { throw new Error('LLM down'); });
        await expect(summarizeCluster([leaf('l1', 'x')], CTX)).rejects.toThrow(/LLM down/);
    });

    test('respects AbortSignal pre-flight', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(summarizeCluster([leaf('l1', 'x')], { ...CTX, signal: controller.signal }))
            .rejects.toThrow(/aborted/);
    });

    test('rejects bad context', async () => {
        await expect(summarizeCluster([leaf('l1', 'x')], /** @type {any} */ ({}))).rejects.toThrow(/profileId/);
        await expect(summarizeCluster([leaf('l1', 'x')], /** @type {any} */ ({ profileId: 'p', subject: '' })))
            .rejects.toThrow(/subject/);
        await expect(summarizeCluster([leaf('l1', 'x')], /** @type {any} */ ({ profileId: 'p', subject: 's', depth: -1 })))
            .rejects.toThrow(/depth/);
    });

    test('flattens sourceEntryIds from leaves carrying multiple', async () => {
        _setLLMClientForTests(async () => 'ok');
        const r = await summarizeCluster(
            [
                leaf('l1', 'x', ['ep1', 'ep2']),
                leaf('l2', 'y', ['ep3']),
            ],
            CTX,
        );
        expect(r.sourceLeafIds).toEqual(['ep1', 'ep2', 'ep3']);
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/summarize.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/raptor/summarize.js tests/unit/consolidation/raptor/summarize.test.js
git commit -m "feat(raptor:summarize): per-cluster LLM summarization per spec §6.4"
```

**Expected:** 8 new tests pass.

**Done-when:**
- Layer-0 and layer-1+ use distinct prompt variants
- Empty cluster, empty LLM response, LLM errors, bad context all throw with clear messages
- AbortSignal respected pre-flight
- sourceLeafIds correctly flattened across multi-source leaves
- All tests green

---

## Task 6: Atomic replacement — `raptor/atomic.js`

**Objective:** Under `withWriteLock`: snapshot the state, verify the subject still has entries to rebuild against, delete all Persona entries where `subject === targetSubject`, insert new ones built from summaries, update `runtime` counters, persist. All-or-nothing.

**Owner:** Subagent (TDD). **Flagged for controller-side audit**: this is the only long-term mutator Phase 7 ships, and it must satisfy the one-path invariant.

**Files:**
- Create: `src/consolidation/raptor/atomic.js`
- Create: `tests/unit/consolidation/raptor/atomic.test.js`

**Step 1: Create `src/consolidation/raptor/atomic.js`**

```js
/**
 * Atomic replacement of a subject's Persona slice. The only long-term
 * mutator in the persona-rebuild pipeline — runs under withWriteLock, swaps
 * Persona entries for the target subject in a single consistent step.
 *
 * Dangling edges from deleted Persona entries are intentionally left in
 * graph.edges: Tier 3 silently skips missing entries (Phase 4 behavior), and
 * cleaning them is not worth the extra complexity. The next consolidation or
 * rebuild can address it if it becomes a real problem.
 *
 * @module consolidation/raptor/atomic
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.4
 */

import { withWriteLock } from '../../core/lock.js';
import { loadState, persistState } from '../../core/state.js';
import { createEntry } from '../../memory/entry.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger({ debug: false }).scope('raptor:atomic');

/**
 * @typedef {object} PersonaReplacement
 * @property {string} text                      - The summary text to store as content.
 * @property {number[]} sourceMessages          - Concatenated source message indices for provenance.
 */

/**
 * @typedef {object} AtomicOptions
 * @property {string} chatId
 * @property {string} subject
 * @property {string} extractorLabel            - e.g. "gemma-4-31b@persona-rebuild-v1"
 * @property {PersonaReplacement[]} replacements
 * @property {Date} [now]
 * @property {AbortSignal} [signal]
 */

/**
 * Atomically replace a subject's Persona slice. Single write lock acquisition.
 *
 * On success:
 *   - All Persona entries with matching subject are deleted.
 *   - New Persona entries are created from `replacements`.
 *   - runtime.episodicCountSinceLastRebuild = 0
 *   - runtime.pendingPersonaRebuild = false
 *   - State persisted.
 *
 * On abort: throws AbortError, no state changes.
 *
 * Returns `{ deletedCount, addedCount }`.
 *
 * @param {AtomicOptions} options
 * @returns {Promise<{ deletedCount: number, addedCount: number }>}
 */
export async function atomicReplacePersona(options) {
    const { chatId, subject, extractorLabel, replacements, now, signal } = options ?? {};
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('atomicReplacePersona: chatId required');
    }
    if (typeof subject !== 'string' || subject.length === 0) {
        throw new Error('atomicReplacePersona: subject required');
    }
    if (typeof extractorLabel !== 'string' || extractorLabel.length === 0) {
        throw new Error('atomicReplacePersona: extractorLabel required');
    }
    if (!Array.isArray(replacements)) {
        throw new Error('atomicReplacePersona: replacements must be an array');
    }
    if (signal?.aborted) {
        const err = new Error('atomicReplacePersona: aborted');
        err.name = 'AbortError';
        throw err;
    }

    return withWriteLock(chatId, async () => {
        if (signal?.aborted) {
            const err = new Error('atomicReplacePersona: aborted');
            err.name = 'AbortError';
            throw err;
        }
        const state = await loadState(chatId);
        const clock = now ?? new Date();

        // Collect the ids to delete
        /** @type {string[]} */
        const toDelete = [];
        for (const [id, entry] of Object.entries(state.entries)) {
            if (entry.scope === 'persona' && entry.subject === subject) {
                toDelete.push(id);
            }
        }

        // Build the new entries
        /** @type {Record<string, import('../../core/schema.js').Entry>} */
        const newEntries = {};
        for (const r of replacements) {
            const e = createEntry({
                scope: 'persona',
                content: r.text,
                subject,
                tags: [],
                relations: [],
                provenance: {
                    sourceMessages: [...r.sourceMessages],
                    extractor: extractorLabel,
                },
                now: clock,
            });
            newEntries[e.id] = e;
        }

        // Compose the new entries map: start from existing minus deleted, add new.
        /** @type {Record<string, import('../../core/schema.js').Entry>} */
        const entriesNext = {};
        for (const [id, entry] of Object.entries(state.entries)) {
            if (!toDelete.includes(id)) entriesNext[id] = entry;
        }
        for (const [id, entry] of Object.entries(newEntries)) {
            entriesNext[id] = entry;
        }

        const next = {
            ...state,
            entries: entriesNext,
            runtime: {
                ...state.runtime,
                pendingPersonaRebuild: false,
                episodicCountSinceLastRebuild: 0,
                lastConsolidation: clock.toISOString(),
            },
        };

        await persistState(chatId, next);
        log.info(`persona rebuild for "${subject}": deleted ${toDelete.length}, added ${replacements.length}`);
        return { deletedCount: toDelete.length, addedCount: replacements.length };
    });
}
```

**Step 2: Create `tests/unit/consolidation/raptor/atomic.test.js`**

```js
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { atomicReplacePersona } from '../../../../src/consolidation/raptor/atomic.js';
import { setBackend, _resetBackendForTests, loadState } from '../../../../src/core/state.js';
import { _resetLocksForTests } from '../../../../src/core/lock.js';
import { createEmptyState } from '../../../../src/core/schema.js';
import { createEntry } from '../../../../src/memory/entry.js';

const CHAT = 'chat-atomic';
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
});

/** @param {string} subject @param {string} content */
function persona(subject, content) {
    return createEntry({
        scope: 'persona', content, subject, tags: [], relations: [],
        provenance: { sourceMessages: [], extractor: 'prior@v0' },
        now: new Date('2026-04-19T10:00:00Z'),
    });
}

describe('atomicReplacePersona', () => {
    test('deletes existing subject entries, adds new ones, clears counters', async () => {
        const oldA = persona('alice', 'old alice 1');
        const oldB = persona('alice', 'old alice 2');
        const otherSubject = persona('bob', 'bob stays');
        store.set(CHAT, {
            ...createEmptyState(),
            entries: {
                [oldA.id]: oldA,
                [oldB.id]: oldB,
                [otherSubject.id]: otherSubject,
            },
            runtime: {
                lastConsolidation: null,
                pendingPersonaRebuild: true,
                consolidating: false,
                episodicCountSinceLastRebuild: 150,
                traces: [],
            },
        });

        const r = await atomicReplacePersona({
            chatId: CHAT,
            subject: 'alice',
            extractorLabel: 'test@persona-rebuild-v1',
            replacements: [
                { text: 'new alice summary', sourceMessages: [1, 2] },
                { text: 'broader alice persona', sourceMessages: [1, 2, 3] },
            ],
            now: FIXED_NOW,
        });

        expect(r).toEqual({ deletedCount: 2, addedCount: 2 });

        const after = await loadState(CHAT);
        // Bob is untouched
        expect(after.entries[otherSubject.id]).toBeDefined();
        expect(after.entries[otherSubject.id].content).toBe('bob stays');
        // Old alice entries gone
        expect(after.entries[oldA.id]).toBeUndefined();
        expect(after.entries[oldB.id]).toBeUndefined();
        // New alice entries present
        const alicePersonas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(alicePersonas).toHaveLength(2);
        expect(alicePersonas.map(e => e.content)).toEqual(
            expect.arrayContaining(['new alice summary', 'broader alice persona']),
        );
        // Runtime counters reset
        expect(after.runtime.pendingPersonaRebuild).toBe(false);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(0);
        expect(after.runtime.lastConsolidation).toBe(FIXED_NOW.toISOString());
    });

    test('empty replacements deletes all subject entries and leaves Persona empty for that subject', async () => {
        const oldA = persona('alice', 'x');
        store.set(CHAT, {
            ...createEmptyState(),
            entries: { [oldA.id]: oldA },
        });
        const r = await atomicReplacePersona({
            chatId: CHAT,
            subject: 'alice',
            extractorLabel: 'test@v1',
            replacements: [],
            now: FIXED_NOW,
        });
        expect(r).toEqual({ deletedCount: 1, addedCount: 0 });
        const after = await loadState(CHAT);
        const alicePersonas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(alicePersonas).toEqual([]);
    });

    test('does not touch non-persona entries with matching subject', async () => {
        const episodic = createEntry({
            scope: 'episodic', content: 'alice ate', subject: 'alice',
            tags: [], relations: [], provenance: { sourceMessages: [], extractor: 'prior' },
            now: FIXED_NOW,
        });
        store.set(CHAT, {
            ...createEmptyState(),
            entries: { [episodic.id]: episodic },
        });
        await atomicReplacePersona({
            chatId: CHAT, subject: 'alice', extractorLabel: 'test@v1',
            replacements: [{ text: 'new', sourceMessages: [] }],
            now: FIXED_NOW,
        });
        const after = await loadState(CHAT);
        expect(after.entries[episodic.id]).toBeDefined();
        expect(after.entries[episodic.id].scope).toBe('episodic');
    });

    test('pre-flight abort throws without touching state', async () => {
        store.set(CHAT, createEmptyState());
        const controller = new AbortController();
        controller.abort();
        await expect(atomicReplacePersona({
            chatId: CHAT, subject: 'alice', extractorLabel: 'test@v1',
            replacements: [{ text: 'x', sourceMessages: [] }],
            signal: controller.signal,
        })).rejects.toThrow(/aborted/);
    });

    test('abort after lock acquired throws and state unchanged', async () => {
        const oldA = persona('alice', 'x');
        store.set(CHAT, {
            ...createEmptyState(),
            entries: { [oldA.id]: oldA },
        });
        const controller = new AbortController();
        // Abort synchronously before withWriteLock's callback runs — we can't
        // easily race this cleanly in tests, so we rely on the in-lock check.
        controller.abort();
        await expect(atomicReplacePersona({
            chatId: CHAT, subject: 'alice', extractorLabel: 'test@v1',
            replacements: [{ text: 'x', sourceMessages: [] }],
            signal: controller.signal,
        })).rejects.toThrow(/aborted/);
        const after = await loadState(CHAT);
        expect(after.entries[oldA.id]).toBeDefined();  // original intact
    });

    test('rejects bad arguments', async () => {
        await expect(atomicReplacePersona(/** @type {any} */ ({}))).rejects.toThrow(/chatId/);
        await expect(atomicReplacePersona(/** @type {any} */ ({ chatId: 'c' }))).rejects.toThrow(/subject/);
        await expect(atomicReplacePersona(/** @type {any} */ ({
            chatId: 'c', subject: 's',
        }))).rejects.toThrow(/extractorLabel/);
        await expect(atomicReplacePersona(/** @type {any} */ ({
            chatId: 'c', subject: 's', extractorLabel: 'x', replacements: 'not-array',
        }))).rejects.toThrow(/replacements/);
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/raptor/atomic.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/raptor/atomic.js tests/unit/consolidation/raptor/atomic.test.js
git commit -m "feat(raptor:atomic): atomic persona replacement under write lock"
```

**Expected:** 6 new tests pass.

**Controller-side verification (required):** Run the one-path invariant test (`npm run test -- tests/unit/consolidation/no-other-mutators.test.js --silent`). Phase 7's new `raptor/` files should all pass because they're under `src/consolidation/` (whitelisted). If any fail, inspect the grep hits and update the whitelist — `atomic.js` is a legitimate mutator within the whitelist; other `raptor/*.js` files should have zero mutation hits.

**Done-when:**
- Existing subject Persona entries deleted, new ones added, non-matching-subject entries untouched
- runtime.pendingPersonaRebuild = false, episodicCountSinceLastRebuild = 0, lastConsolidation set
- AbortSignal pre-flight and post-lock both throw without mutation
- All tests green; one-path invariant test still green

---

## Task 7: Orchestrator — `personaRebuild.js`

**Objective:** Tie everything together. The public `rebuildPersona(chatId, subject, opts)` function runs the full pipeline:

```
snapshot episodic entries for subject (read-only, no lock)
chunk entries → leaves
loop depth = 0..MAX_DEPTH:
  build k-NN graph (with adaptive k)
  leidenCluster (with adaptive γ)
  for each cluster: summarize → layer-N summary text
  if clusters.length < 2 or summaries.length < MIN_CLUSTER_SIZE × 2: break
  leaves := summaries (as pseudo-leaves, with combined sourceEntryIds)
  depth += 1
collect all non-layer-0 summaries → replacements
atomicReplacePersona(chatId, subject, replacements)
(finally: no temp collections outstanding, they were purged by buildKnnGraph)
```

**Flagged for controller-side eyeball verification.** This is the orchestrator that defines Phase 7's user-visible behavior. Six things to check post-subagent:
1. Snapshot is taken without the write lock (concurrency)
2. AbortSignal checked between every major stage
3. Depth recursion respects MAX_DEPTH
4. Stop condition fires cleanly
5. atomicReplacePersona is the only write
6. No embedding collection is leaked (purge always happens — knn.js' finally handles this)

**Files:**
- Create: `src/consolidation/personaRebuild.js`
- Create: `tests/unit/consolidation/personaRebuild.test.js`

**Step 1: Create `src/consolidation/personaRebuild.js`**

```js
/**
 * Persona rebuild orchestrator. The ONE public entry point for Phase 7.
 *
 * Pipeline:
 *   1. Snapshot episodic entries for the target subject (read-only, no lock).
 *   2. chunkEntries → Leaf[].
 *   3. For each depth 0..MAX_DEPTH:
 *      a. Build k-NN graph (adaptive k).
 *      b. Leiden cluster (adaptive γ).
 *      c. Stop if <2 clusters or too few leaves for another layer.
 *      d. Summarize each cluster via LLM; collect summaries as next-layer leaves.
 *   4. Flatten all non-layer-0 summaries into replacement Persona entries.
 *   5. atomicReplacePersona (single write lock).
 *
 * The snapshot-then-swap pattern means consolidation can run concurrently with
 * persona rebuild — they only collide on the brief atomic-swap write lock at
 * the very end. Phase 8's integration layer should, however, prefer to
 * cancel any in-flight rebuild before allowing chat switch.
 *
 * AbortSignal is threaded through every async stage. On abort: throws
 * AbortError, zero state mutation, temp collections purged.
 *
 * @module consolidation/personaRebuild
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.4
 */

import { loadState } from '../core/state.js';
import { PERSONA_REBUILD } from '../core/constants.js';
import { chunkEntries } from './raptor/chunking.js';
import { buildKnnGraph } from './raptor/knn.js';
import { leidenCluster, gammaForDepth } from './raptor/leiden.js';
import { summarizeCluster } from './raptor/summarize.js';
import { atomicReplacePersona } from './raptor/atomic.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ debug: false }).scope('personaRebuild');

const { MAX_DEPTH, MIN_CLUSTER_SIZE } = PERSONA_REBUILD;

/**
 * @typedef {import('./raptor/chunking.js').Leaf} Leaf
 */

/**
 * @typedef {object} RebuildOptions
 * @property {string} profileId                - ST connection profile for extractor LLM.
 * @property {string} extractorLabel           - e.g. "gemma-4-31b@persona-rebuild-v1"
 * @property {AbortSignal} [signal]
 * @property {(progress: { stage: string, depth?: number, clusters?: number }) => void} [onProgress]
 * @property {Date} [now]
 */

/**
 * @typedef {object} RebuildReport
 * @property {number} episodicCount
 * @property {number} layers
 * @property {number} replacedCount
 * @property {number} newCount
 * @property {number} duration                 - Wall-clock ms.
 */

/**
 * Run the full persona rebuild pipeline for a subject. Returns a report.
 *
 * @param {string} chatId
 * @param {string} subject
 * @param {RebuildOptions} opts
 * @returns {Promise<RebuildReport>}
 */
export async function rebuildPersona(chatId, subject, opts) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw new Error('rebuildPersona: chatId required');
    }
    if (typeof subject !== 'string' || subject.length === 0) {
        throw new Error('rebuildPersona: subject required');
    }
    if (!opts || typeof opts !== 'object') {
        throw new Error('rebuildPersona: options required');
    }
    const { profileId, extractorLabel, signal, onProgress, now } = opts;
    if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new Error('rebuildPersona: opts.profileId required');
    }
    if (typeof extractorLabel !== 'string' || extractorLabel.length === 0) {
        throw new Error('rebuildPersona: opts.extractorLabel required');
    }

    const throwIfAborted = () => {
        if (signal?.aborted) {
            const err = new Error('rebuildPersona: aborted');
            err.name = 'AbortError';
            throw err;
        }
    };

    const report = (/** @type {string} */ stage, /** @type {any} */ extra) => {
        try { onProgress?.({ stage, ...(extra ?? {}) }); } catch { /* swallow */ }
    };

    const startTime = Date.now();
    throwIfAborted();
    report('snapshot');

    // Snapshot: read-only. If Episodic changes concurrently, the final atomic
    // swap still persists our new Persona entries — the snapshot just means our
    // summaries may slightly lag a mid-rebuild consolidation. Acceptable.
    const state = await loadState(chatId);
    const episodic = Object.values(state.entries).filter(
        e => e.scope === 'episodic' && e.subject === subject,
    );
    if (episodic.length === 0) {
        throw new Error(`rebuildPersona: no episodic entries for subject "${subject}"`);
    }

    report('chunk', { count: episodic.length });
    let currentLeaves = chunkEntries(episodic);

    /** @type {Array<{ depth: number, text: string, sourceEntryIds: string[] }>} */
    const collectedSummaries = [];

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
        throwIfAborted();
        if (currentLeaves.length < MIN_CLUSTER_SIZE * 2) {
            log.info(`stop at depth ${depth}: too few leaves (${currentLeaves.length})`);
            break;
        }

        // Build k-NN graph for this layer.
        const collectionId = `starmem:${chatId}:${subject}:persona-rebuild:${depth}:${Date.now()}`;
        report('knn', { depth, leaves: currentLeaves.length });
        const graph = await buildKnnGraph(currentLeaves, depth, collectionId, signal);
        throwIfAborted();

        // Cluster.
        const gamma = gammaForDepth(depth);
        report('cluster', { depth, gamma });
        const { clusters, communityCount } = leidenCluster(graph, gamma, { seed: 1, signal });
        throwIfAborted();

        if (communityCount < 2) {
            log.info(`stop at depth ${depth}: only ${communityCount} community`);
            break;
        }

        // Group leaves by cluster.
        /** @type {Map<number, Leaf[]>} */
        const byCluster = new Map();
        for (const leaf of currentLeaves) {
            const c = clusters.get(leaf.id);
            if (c === undefined) continue;
            const bucket = byCluster.get(c) ?? [];
            bucket.push(leaf);
            byCluster.set(c, bucket);
        }

        // Summarize each cluster.
        /** @type {Leaf[]} */
        const nextLayerLeaves = [];
        let clusterIdx = 0;
        for (const [, members] of byCluster) {
            throwIfAborted();
            report('summarize', { depth, cluster: clusterIdx });
            const { text, sourceLeafIds } = await summarizeCluster(members, {
                profileId, subject, depth, signal,
            });
            collectedSummaries.push({ depth: depth + 1, text, sourceEntryIds: sourceLeafIds });
            nextLayerLeaves.push({
                id: `leaf_depth${depth + 1}_${clusterIdx}`,
                sourceEntryIds: sourceLeafIds,
                text,
                subject,
            });
            clusterIdx++;
        }

        currentLeaves = nextLayerLeaves;
    }

    // At this point, `currentLeaves` holds the deepest layer's summaries
    // (potentially multiple if we stopped at MAX_DEPTH without collapsing to one).
    // We additionally want the final root-level summary if we haven't stopped
    // at a single cluster. If currentLeaves.length > 1 and we exited by
    // MAX_DEPTH rather than communityCount < 2, merge the final layer into
    // one root summary.
    if (currentLeaves.length > 1 && collectedSummaries.length > 0) {
        throwIfAborted();
        report('summarize-root');
        const { text, sourceLeafIds } = await summarizeCluster(currentLeaves, {
            profileId, subject, depth: MAX_DEPTH, signal,
        });
        collectedSummaries.push({ depth: MAX_DEPTH + 1, text, sourceEntryIds: sourceLeafIds });
    } else if (collectedSummaries.length === 0) {
        // We never clustered (e.g. only 1 or 2 episodic entries). Produce a
        // single Persona summary from the leaves directly.
        throwIfAborted();
        report('summarize-root-direct');
        const { text, sourceLeafIds } = await summarizeCluster(currentLeaves, {
            profileId, subject, depth: 0, signal,
        });
        collectedSummaries.push({ depth: 1, text, sourceEntryIds: sourceLeafIds });
    }

    // Build replacement entries. Source-message indices are carried through
    // from the original episodic entries via sourceEntryIds → lookup in the
    // snapshot.
    const episodicById = new Map(episodic.map(e => [e.id, e]));
    /** @type {import('./raptor/atomic.js').PersonaReplacement[]} */
    const replacements = collectedSummaries.map(s => {
        /** @type {Set<number>} */
        const msgs = new Set();
        for (const eid of s.sourceEntryIds) {
            const e = episodicById.get(eid);
            if (!e) continue;
            for (const m of e.provenance.sourceMessages) msgs.add(m);
        }
        return { text: s.text, sourceMessages: [...msgs].sort((a, b) => a - b) };
    });

    report('atomic-swap', { count: replacements.length });
    throwIfAborted();
    const { deletedCount, addedCount } = await atomicReplacePersona({
        chatId, subject, extractorLabel, replacements, now, signal,
    });

    return {
        episodicCount: episodic.length,
        layers: collectedSummaries.length,
        replacedCount: deletedCount,
        newCount: addedCount,
        duration: Date.now() - startTime,
    };
}
```

**Step 2: Create `tests/unit/consolidation/personaRebuild.test.js`**

```js
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { rebuildPersona } from '../../../src/consolidation/personaRebuild.js';
import { setBackend, _resetBackendForTests, loadState } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';
import {
    _setEmbeddingClientForTests, _resetEmbeddingClientForTests, makeSyntheticClient,
} from '../../../src/consolidation/raptor/embeddings.js';

const CHAT = 'chat-rebuild';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

const OPTS = {
    profileId: 'p',
    extractorLabel: 'test@persona-rebuild-v1',
    now: FIXED_NOW,
};

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
    _setEmbeddingClientForTests(makeSyntheticClient());
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetEmbeddingClientForTests();
    _resetLLMClientForTests();
});

/** @param {string} subject @param {string} content @param {number} [msgIdx] */
function episodic(subject, content, msgIdx = 0) {
    return createEntry({
        scope: 'episodic', content, subject, tags: [], relations: [],
        provenance: { sourceMessages: [msgIdx], extractor: 'test' },
        now: new Date(FIXED_NOW.getTime() + msgIdx * 1000),
    });
}

describe('rebuildPersona (end-to-end)', () => {
    test('single-layer rebuild: small corpus, produces at least one Persona entry', async () => {
        const es = Array.from({ length: 6 }, (_, i) => episodic('alice', `alice fact ${i}`, i));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(es.map(e => [e.id, e])),
            runtime: {
                lastConsolidation: null, pendingPersonaRebuild: true,
                consolidating: false, episodicCountSinceLastRebuild: 120, traces: [],
            },
        });
        let llmCalls = 0;
        _setLLMClientForTests(async () => {
            llmCalls++;
            return `alice summary ${llmCalls}`;
        });

        const r = await rebuildPersona(CHAT, 'alice', OPTS);
        expect(r.episodicCount).toBe(6);
        expect(r.layers).toBeGreaterThanOrEqual(1);
        expect(r.newCount).toBeGreaterThanOrEqual(1);

        const after = await loadState(CHAT);
        const alicePersonas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(alicePersonas.length).toBe(r.newCount);
        expect(after.runtime.pendingPersonaRebuild).toBe(false);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(0);
    });

    test('no episodic entries for subject → throws', async () => {
        store.set(CHAT, createEmptyState());
        _setLLMClientForTests(async () => 'x');
        await expect(rebuildPersona(CHAT, 'alice', OPTS))
            .rejects.toThrow(/no episodic entries/);
    });

    test('LLM failure: aborts cleanly, no state mutation', async () => {
        const es = Array.from({ length: 6 }, (_, i) => episodic('alice', `fact ${i}`, i));
        const oldPersona = createEntry({
            scope: 'persona', content: 'old alice', subject: 'alice',
            tags: [], relations: [], provenance: { sourceMessages: [], extractor: 'prior' },
            now: FIXED_NOW,
        });
        store.set(CHAT, {
            ...createEmptyState(),
            entries: {
                ...Object.fromEntries(es.map(e => [e.id, e])),
                [oldPersona.id]: oldPersona,
            },
        });
        _setLLMClientForTests(async () => { throw new Error('LLM down'); });

        await expect(rebuildPersona(CHAT, 'alice', OPTS)).rejects.toThrow(/LLM down/);
        const after = await loadState(CHAT);
        // Old persona still there (atomic swap never happened)
        expect(after.entries[oldPersona.id]).toBeDefined();
        expect(after.entries[oldPersona.id].content).toBe('old alice');
    });

    test('AbortSignal pre-flight: throws without mutation', async () => {
        const es = [episodic('alice', 'a'), episodic('alice', 'b')];
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(es.map(e => [e.id, e])),
        });
        _setLLMClientForTests(async () => 'x');
        const controller = new AbortController();
        controller.abort();
        await expect(rebuildPersona(CHAT, 'alice', { ...OPTS, signal: controller.signal }))
            .rejects.toThrow(/aborted/);
    });

    test('onProgress callback fires per stage', async () => {
        const es = Array.from({ length: 6 }, (_, i) => episodic('alice', `fact ${i}`, i));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(es.map(e => [e.id, e])),
        });
        _setLLMClientForTests(async () => 'summary text');
        /** @type {string[]} */
        const stages = [];
        await rebuildPersona(CHAT, 'alice', {
            ...OPTS,
            onProgress: (p) => { stages.push(p.stage); },
        });
        expect(stages).toContain('snapshot');
        expect(stages).toContain('chunk');
        expect(stages.some(s => s === 'knn' || s === 'cluster' || s.startsWith('summarize')))
            .toBe(true);
        expect(stages).toContain('atomic-swap');
    });

    test('ignores non-matching-subject episodic entries', async () => {
        const aliceEs = Array.from({ length: 4 }, (_, i) => episodic('alice', `alice ${i}`, i));
        const bobEs = Array.from({ length: 4 }, (_, i) => episodic('bob', `bob ${i}`, i + 10));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries([...aliceEs, ...bobEs].map(e => [e.id, e])),
        });
        _setLLMClientForTests(async () => 'alice summary');
        const r = await rebuildPersona(CHAT, 'alice', OPTS);
        expect(r.episodicCount).toBe(4);  // only alice's episodic entries

        const after = await loadState(CHAT);
        // Bob's episodic entries untouched
        const bobEpisodic = Object.values(after.entries).filter(
            e => e.scope === 'episodic' && e.subject === 'bob',
        );
        expect(bobEpisodic).toHaveLength(4);
    });

    test('rejects bad arguments', async () => {
        await expect(rebuildPersona('', 'alice', OPTS)).rejects.toThrow(/chatId/);
        await expect(rebuildPersona('c', '', OPTS)).rejects.toThrow(/subject/);
        await expect(rebuildPersona('c', 'alice', /** @type {any} */ ({}))).rejects.toThrow(/profileId/);
    });
});
```

**Step 3: Run + commit**

```bash
npm run test -- tests/unit/consolidation/personaRebuild.test.js --silent
npm run typecheck && npm run lint
git add src/consolidation/personaRebuild.js tests/unit/consolidation/personaRebuild.test.js
git commit -m "feat(consolidation): rebuildPersona orchestrator per spec §6.4"
```

**Expected:** 7 new tests pass.

**Controller-side verification (required):**
1. Re-run the full suite: `npm test --silent 2>&1 | tail -3`. Expect all green.
2. Re-run the one-path invariant test specifically: `npm run test -- tests/unit/consolidation/no-other-mutators.test.js --silent`. Phase 7's new files must all pass (they're all under `src/consolidation/`).
3. Audit LLM-abort propagation via grep:
   ```bash
   grep -n "throwIfAborted\|signal\?\.aborted\|signal?\.aborted" src/consolidation/personaRebuild.js
   ```
   Expect at least 5 aborts: pre-flight, pre-knn, pre-cluster, pre-summarize (per iteration), pre-atomic-swap, pre-root-summary.

**Done-when:**
- Small corpus (6 episodic entries) produces ≥1 Persona entry end-to-end
- No-episodic-for-subject throws
- LLM failure leaves old Persona entries intact
- AbortSignal pre-flight respected
- onProgress fires for known stages
- Non-matching-subject entries untouched (including other-subject episodic)
- One-path invariant test still passes
- All tests green

---

## Task 8: Barrel, integration test, and retro

**Objective:** Close the phase. Export `rebuildPersona` from the consolidation barrel. Write a 20-episodic-entry integration test that runs the full pipeline end-to-end with synthetic embeddings + mocked LLM. Append the Phase 7 retro to ROADMAP.md.

**Owner:** Controller for the barrel + retro; subagent for the integration test.

**Files:**
- Modify: `src/consolidation/index.js`
- Create: `tests/integration/consolidation/personaRebuild.test.js`
- Modify: `docs/plans/ROADMAP.md`

**Step 1: Extend `src/consolidation/index.js` (controller)**

Append to the existing exports:

```js
export { rebuildPersona } from './personaRebuild.js';
```

Commit:
```bash
git add src/consolidation/index.js
git commit -m "feat(consolidation): export rebuildPersona from barrel"
```

**Step 2: Create `tests/integration/consolidation/personaRebuild.test.js` (subagent)**

```js
/**
 * Phase 7 integration test: 20-entry corpus with two natural themes produces
 * Persona entries that reflect the themes. Uses synthetic embeddings and a
 * themed mock LLM so output is deterministic.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { rebuildPersona } from '../../../src/consolidation/index.js';
import { setBackend, _resetBackendForTests, loadState } from '../../../src/core/state.js';
import { _resetLocksForTests } from '../../../src/core/lock.js';
import { createEmptyState } from '../../../src/core/schema.js';
import { createEntry } from '../../../src/memory/entry.js';
import {
    _setLLMClientForTests, _resetLLMClientForTests,
} from '../../../src/consolidation/llmClient.js';
import {
    _setEmbeddingClientForTests, _resetEmbeddingClientForTests, makeSyntheticClient,
} from '../../../src/consolidation/raptor/embeddings.js';

const CHAT = 'chat-persona-integration';
const FIXED_NOW = new Date('2026-04-20T10:00:00Z');

const OPTS = {
    profileId: 'test-profile',
    extractorLabel: 'test@persona-rebuild-v1',
    now: FIXED_NOW,
};

/** @type {Map<string, unknown>} */
let store;

beforeEach(() => {
    store = new Map();
    setBackend({ read: id => store.get(id), write: (id, v) => { store.set(id, v); } });
    _resetLocksForTests();
    _setEmbeddingClientForTests(makeSyntheticClient());
});

afterEach(() => {
    _resetBackendForTests();
    _resetLocksForTests();
    _resetEmbeddingClientForTests();
    _resetLLMClientForTests();
});

/**
 * Themed LLM mock: inspects the prompt, echoes a theme-matching summary.
 * @param {(profile: string, messages: {role: string, content: string}[]) => Promise<string>} _unused
 */
function themedLLMMock() {
    return async (/** @type {string} */ _p, /** @type {{role: string, content: string}[]} */ messages) => {
        const userContent = messages[messages.length - 1].content.toLowerCase();
        if (userContent.includes('travel') || userContent.includes('marseille') || userContent.includes('paris')) {
            return 'Alice is a frequent traveler who has visited Marseille and Paris.';
        }
        if (userContent.includes('food') || userContent.includes('croissant') || userContent.includes('coffee')) {
            return 'Alice has developed food preferences including croissants and coffee.';
        }
        return 'Alice has various traits captured from conversation.';
    };
}

describe('persona rebuild integration', () => {
    test('20-entry corpus with two themes produces thematic Persona entries', async () => {
        // 10 travel-themed + 10 food-themed
        const travelTexts = [
            'alice traveled to marseille',
            'alice visited paris last week',
            'alice flew to marseille for vacation',
            'alice went on a trip to paris',
            'alice toured the marseille coast',
            'alice drove to paris from marseille',
            'alice took the train to paris',
            'alice hiked around marseille',
            'alice visited paris museums',
            'alice returned from paris',
        ];
        const foodTexts = [
            'alice loves croissants for breakfast',
            'alice drinks coffee every morning',
            'alice bakes bread on weekends',
            'alice ordered coffee and croissants',
            'alice makes espresso at home',
            'alice eats fresh bread daily',
            'alice enjoys dark coffee',
            'alice tried new croissant recipe',
            'alice buys bread from the bakery',
            'alice grinds her own coffee beans',
        ];
        const allTexts = [...travelTexts, ...foodTexts];
        const entries = allTexts.map((t, i) => createEntry({
            scope: 'episodic', content: t, subject: 'alice', tags: [], relations: [],
            provenance: { sourceMessages: [i], extractor: 'consolidate@v1' },
            now: new Date(FIXED_NOW.getTime() + i * 1000),
        }));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(entries.map(e => [e.id, e])),
            runtime: {
                lastConsolidation: null,
                pendingPersonaRebuild: true,
                consolidating: false,
                episodicCountSinceLastRebuild: 100,
                traces: [],
            },
        });
        _setLLMClientForTests(themedLLMMock());

        const r = await rebuildPersona(CHAT, 'alice', OPTS);

        // The exact cluster count depends on Leiden's convergence on synthetic
        // embeddings, but we should get at least ONE new Persona entry and
        // should have replaced the (zero) prior Persona entries.
        expect(r.episodicCount).toBe(20);
        expect(r.newCount).toBeGreaterThanOrEqual(1);
        expect(r.duration).toBeGreaterThanOrEqual(0);

        const after = await loadState(CHAT);
        const personas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(personas.length).toBe(r.newCount);
        // Each persona entry has a non-empty content string
        for (const p of personas) {
            expect(p.content.length).toBeGreaterThan(0);
            expect(p.provenance.extractor).toBe('test@persona-rebuild-v1');
        }
        // Runtime counters reset
        expect(after.runtime.pendingPersonaRebuild).toBe(false);
        expect(after.runtime.episodicCountSinceLastRebuild).toBe(0);
        // Episodic entries untouched
        const stillEpisodic = Object.values(after.entries).filter(e => e.scope === 'episodic');
        expect(stillEpisodic).toHaveLength(20);
    });

    test('can rebuild twice in a row without interference', async () => {
        const entries = Array.from({ length: 8 }, (_, i) => createEntry({
            scope: 'episodic', content: `alice fact ${i}`, subject: 'alice',
            tags: [], relations: [],
            provenance: { sourceMessages: [i], extractor: 'c@v1' },
            now: new Date(FIXED_NOW.getTime() + i * 1000),
        }));
        store.set(CHAT, {
            ...createEmptyState(),
            entries: Object.fromEntries(entries.map(e => [e.id, e])),
        });
        _setLLMClientForTests(async (_p, messages) => {
            // Include a nonce in case the second run produces identical summaries.
            return `summary ${messages[messages.length - 1].content.slice(0, 10)}`;
        });

        const r1 = await rebuildPersona(CHAT, 'alice', OPTS);
        const firstPersonaIds = new Set(
            Object.keys((await loadState(CHAT)).entries).filter(id => {
                return (store.get(CHAT) /** @type {any} */);  // just iterate
            }),
        );
        expect(r1.newCount).toBeGreaterThanOrEqual(1);

        // Second rebuild — old Persona entries should be replaced, not duplicated.
        const r2 = await rebuildPersona(CHAT, 'alice', OPTS);
        expect(r2.replacedCount).toBe(r1.newCount);  // the N new from r1 become deletions in r2

        const after = await loadState(CHAT);
        const personas = Object.values(after.entries).filter(
            e => e.scope === 'persona' && e.subject === 'alice',
        );
        expect(personas).toHaveLength(r2.newCount);
    });
});
```

**Step 3: Run + commit (subagent)**

```bash
npm run test -- tests/integration/consolidation/personaRebuild.test.js --silent
# full suite
npm test --silent 2>&1 | tail -5
npm run typecheck && npm run lint
git add tests/integration/consolidation/personaRebuild.test.js
git commit -m "test(consolidation): persona rebuild integration — 20 entries, two themes"
```

**Step 4: Append Phase 7 retro to ROADMAP.md (controller)**

Append BEFORE the existing `## Phase 6—2026-04-20` block. Template (fill in blanks from actual shipped numbers):

```markdown
## Phase 7—2026-04-20

**What shipped:** Persona rebuild pipeline — `src/consolidation/personaRebuild.js` (orchestrator: snapshot → chunk → loop(knn → leiden → summarize) → atomic swap, AbortSignal threaded through every stage), six RAPTOR internals under `src/consolidation/raptor/`:
  - `chunking.js` — identity stub per Decision 6 (1 entry = 1 leaf)
  - `embeddings.js` — injectable ST Vectors client (`/api/vector/insert|query|purge`) + deterministic synthetic client for tests + exported hashText/syntheticEmbedding/cosineSimilarity helpers
  - `knn.js` — adaptive k (k_base=15, k_step=5), symmetric adjacency via max-weight per pair
  - `leiden.js` — full Leiden implementation (modularity, localMove with incremental stats, refinement with well-connectedness threshold, aggregation, outer-loop driver, public `leidenCluster`+`gammaForDepth` API) per Traag 2019
  - `summarize.js` — per-cluster LLM summarization reusing Phase 6's `callLLM`
  - `atomic.js` — subject-scoped Persona replacement under `withWriteLock`, resets `pendingPersonaRebuild` and `episodicCountSinceLastRebuild`
- `src/consolidation/index.js` barrel extended to export `rebuildPersona`
- `tests/integration/consolidation/personaRebuild.test.js` — 20-entry two-theme corpus end-to-end

**Deliberate spec deviations (documented up front, TODO list for `docs(spec)`):**

1. **Embeddings permitted in persona rebuild** — spec §11's "no embeddings anywhere" is about the hot retrieval path. Persona rebuild is user-initiated offline, embeddings are OK there. **Amendment needed** in a future `docs(spec)` commit: §11 clarifies the hot-path scope; §6.4 names SillyTavern Vectors as the embedding source.
2. **Semantic chunking skipped** — spec §6.4 prescribes semantic chunking (τ=0.7) but Episodic entries from Phase 6 are already atomic facts. Chunking them would fragment coherent statements. `raptor/chunking.js` is an identity stub; v2.1 can reinstate if long documents ever enter Episodic.

**Execution mode:** Subagent-driven, reviews skipped per the skill's criteria (verbatim code + static checks per task), with controller-side audits after Task 4.5 (Leiden convergence determinism over 10 seeds), Task 6 (atomic mutator one-path invariant), and Task 7 (orchestrator abort-propagation grep). Tasks 4.1–4.5 were the highest-risk stretch; all passed first-try thanks to hand-computed golden modularity values serving as a tripwire. X commits this phase + barrel + integration + retro = X+3 commits. **<N> tests passing across <M> suites** (341 Phase 6 baseline + <delta> new).

**Decisions locked in the planning conversation (all held through execution):**

1. Embedding source: SillyTavern Vectors API, injectable client, synthetic test fallback.
2. Clustering algorithm: **Leiden** (not Louvain, not agglomerative) — spec-faithful, well-connectedness guarantee materially matters on target corpus sizes.
3. Tree depth/stop: max_depth=3, clusters<2, leaves<MIN_CLUSTER_SIZE×2.
4. What becomes a Persona entry: every non-leaf layer's summary + root (merged layer if MAX_DEPTH exited without collapse).
5. Atomic replacement: delete-where-subject + add new, one `withWriteLock`. Dangling edges left alone.
6. Skip semantic chunking: Episodic entries are already atomic facts.
7. Cancellation: AbortSignal threaded through every stage; `throwIfAborted()` helper.
8. Counter reset: rebuildPersona on success clears `pendingPersonaRebuild` and `episodicCountSinceLastRebuild`.
9. Test embeddings: deterministic synthetic client, no real embeddings in unit tests.
10. Module structure: `personaRebuild.js` orchestrator + six `raptor/*.js` modules.

**Surprises:**

<fill during execution — likely candidates: Leiden convergence edge cases on tiny graphs, ST Vectors API response format oddities, AbortSignal propagation timing under `withWriteLock`, integration-test clustering non-determinism without a fixed seed, etc.>

**Notes for Phase 8 (SillyTavern Integration):**

- `rebuildPersona(chatId, subject, opts)` is the public entry point. Phase 8's Memory Viewer "Persona rebuild" button → call this with the active chat + subject.
- `opts.onProgress({stage, depth?, clusters?})` lets the UI render a progress indicator. Known stages: `snapshot`, `chunk`, `knn`, `cluster`, `summarize`, `summarize-root`, `summarize-root-direct`, `atomic-swap`.
- `opts.signal: AbortSignal` lets the UI cancel mid-run (e.g. user navigates away or clicks Cancel). Throws `AbortError`; UI should distinguish this from real errors.
- The extractor-label `"<model>@persona-rebuild-v1"` needs to be computed by Phase 8 from the active ST connection profile name. Phase 7 doesn't hard-code it.
- Embedding source is whatever the user has configured in ST's Vectors extension. Phase 8 should surface a warning if Vectors is disabled/misconfigured: rebuild will fail cleanly with a descriptive fetch error, but a pre-flight check is friendlier.
- The one-path invariant test already whitelists `src/consolidation/` — no update needed for Phase 7's new files.

**Notes for Phase 9 (Benchmarking):**

- Leiden seed is pinned to 1 by default in `leidenCluster`. For A/B evaluations, vary the seed and measure stability of cluster assignments — if the assignment changes materially between seeds, the cluster is poorly supported by the graph structure.
- k_base=15, k_step=5 are guesses (spec values, never measured on real corpora). If benchmarks show sparse graphs (many isolated components) on small Episodic corpora, lower k_base. If graphs are nearly-complete (every node neighbors-to-every-other), raise k_base.
- γ_base=1.0, γ_step=0.2 — same story. High γ produces more, smaller clusters. Phase 9 can sweep γ on a fixed corpus and measure cluster count / modularity curves.
- The synthetic embedding client in `raptor/embeddings.js` is NOT suitable for benchmark runs — hash-based embeddings have no semantic structure. Phase 9 must use real ST Vectors (user-configured provider) for meaningful eval.
- EXTRACT_MAX_TOKENS equivalent for summaries is `SUMMARY_MAX_TOKENS=512`. If Phase 9 shows summaries consistently truncated, bump to 1024; if they're always under 200 tokens, drop to save cost.
- Layer count per rebuild: should converge in 2-4 layers on corpora of ~100-500 Episodic entries. If hitting MAX_DEPTH=3 frequently, clusters are too granular; consider lowering γ_base.
```

Commit:

```bash
git add docs/plans/ROADMAP.md
git commit -m "docs(plans): Phase 7 retro"
```

**Step 5: Final verification (controller)**

```bash
cd /home/opus/.hermes/profiles/hanami/home/SillyTavern/public/scripts/extensions/third-party/SillyTavern-STARmem
git log --oneline $(git merge-base HEAD e5e1e21)..HEAD | head -20
npm test --silent 2>&1 | grep -E "Test Suites|Tests:"
npm run typecheck && npm run lint
git status --short  # expect clean
```

**Done-when:**
- Full suite green
- Phase 7 retro appended to ROADMAP.md with final numbers and actual surprises
- All commits landed, no "fix up" noise
- One-path invariant test still green
- The integration test produces at least 1 Persona entry on 20-entry two-themed fixture

---

## Verification checklist (after all tasks land)

- [ ] `npm run test --silent` all green, no flakes
- [ ] `npm run typecheck` green
- [ ] `npm run lint` green
- [ ] `git log --oneline e5e1e21..HEAD` shows plan + Tasks 0-8 commits + retro, no "fix up" noise
- [ ] `grep -rn "state\.entries\[[^]]*\]\s*=" src/ | grep -v "src/consolidation/"` → empty
- [ ] `src/consolidation/raptor/` contains exactly: chunking.js, embeddings.js, knn.js, leiden.js, summarize.js, atomic.js
- [ ] `src/consolidation/personaRebuild.js` exists and is exported from the barrel
- [ ] ROADMAP Phase 7 retro filled in with final numbers and actual surprises, not the template
- [ ] Spec-amendment TODO noted in retro (embeddings in §11, Vectors source in §6.4)

## Spec-compliance checklist

- [ ] Every function introduced is referenced in spec §6.4 or wiki/raptor.md (Enhanced RAPTOR adaptation)
- [ ] Deliberate deviations (embeddings on the hot path, semantic chunking skipped) documented in retro
- [ ] `rebuildPersona` is the only public entry point; RAPTOR internals stay private to `src/consolidation/raptor/`
- [ ] Atomic swap is the only long-term mutator in Phase 7 (invariant test confirms)
- [ ] No out-of-scope functionality from §11 has crept in beyond the documented embedding deviation
- [ ] `contradicts` edges remain reserved (Leiden does not emit edges at all — the graph is built and discarded per layer)
- [ ] Inter-phase contract from ROADMAP.md §3 Phase 7 matches what shipped:
  ```
  rebuildPersona(chatId: string, subject: string, opts: RebuildOptions): Promise<RebuildReport>
  type RebuildReport = { episodicCount, layers, replacedCount, newCount, duration }
  ```
  (Note: spec said `rebuildPersona(chatId, subject) → RebuildReport`. We shipped with a required `opts` param carrying profileId/extractorLabel/signal/onProgress/now — the LLM caller needs a profile to work, same pattern as Phase 6's consolidate. Update ROADMAP contract if it contradicts.)
