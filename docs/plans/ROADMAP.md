# STARmem v2 Implementation Roadmap

**Status:** Active
**Spec:** [`docs/specs/2026-04-20-starmem-v2-design.md`](../specs/2026-04-20-starmem-v2-design.md)
**Approach:** Phased, test-driven, subagent-executed. One detailed plan per phase, written just-in-time.

---

## 1. Purpose of This Document

This roadmap is the cross-phase anchor for the v2 build. It nails down:

- **The nine phases**, their dependency order, and what each one produces
- **The inter-phase contracts**—the function signatures, data shapes, and invariants that the next phase depends on
- **A "spec compliance" checklist**—at each phase boundary, we verify that we haven't drifted from the design

Per-phase plans live in sibling files (`phase-0-foundation.md`, etc.) and are written just-in-time: we plan Phase N only after Phase N-1 has shipped and its lessons are incorporated. This avoids premature detail-lock that won't survive contact with real code.

**Why phased, not one monolithic plan:** STARmem v2 is 8–15K LOC of final code. A single plan at bite-sized granularity is ~200 tasks and becomes unreadable. Phased plans stay under 400 lines each and can reflect what the prior phase actually produced.

---

## 2. The Nine Phases

```
Phase 0: Foundation        [infra: tooling, tests, logging, constants]
        ↓
Phase 1: Storage           [chatMetadata I/O, entry schema, write lock]
        ↓
Phase 2: Lifecycle         [AKL-lite math: importance, maturity, recency, decay]
        ↓
Phase 3: Retrieval Core    [BM25 index, 3-type classifier, multiplicative scorer]
        ↓
Phase 4: Retrieval Tiers   [Tiers 0, 1, 2, Floor—assembled into the ladder]
        ↓
Phase 5: Graph + Tier 3    [edge store, intent-routed beam search, MAGMA-lite]
        ↓
Phase 6: Consolidation     [extractFacts, consolidate(), debounced triggers]
        ↓
Phase 7: Persona Rebuild   [Enhanced RAPTOR over episodic entries—offline batch]
        ↓
Phase 8: ST Integration    [interceptor, settings UI, Memory Viewer, indicator]
        ↓
Phase 9: Benchmarking      [trace logger, pluggable scorer, eval harness stub]
```

**Note on numbering:** Phase 9 is listed but conceptually overlaps Phase 0—trace logger hooks are installed from the start, then filled in. It's called out separately to make the benchmarking subsystem a first-class deliverable, not an afterthought.

---

## 3. Phase-by-Phase

Each phase lists: **inputs**, **outputs**, **spec reference**, **done-when criteria**.

### Phase 0—Foundation

**Purpose:** Get the repo buildable, testable, and ready for real code. No business logic yet.

**Inputs:** Current scaffold (manifest, index.js, package.json).

**Outputs:**
- Node/npm tooling configured (eslint, prettier if desired, jest for unit tests, tsconfig for JSDoc type-checking).
- Empty `src/` tree matching the spec §10 layout.
- `src/core/constants.js`—spec-derived constants (scope names, edge types, thresholds).
- `src/core/logger.js`—structured logger respecting ST's debug conventions.
- `tests/unit/` with a smoke test that proves jest runs.
- `npm run test`, `npm run lint`, `npm run typecheck` all pass green on an empty codebase.

**Spec reference:** §10 (repo structure), §2 (principles—one of them is honest instrumentation, and that starts with a working logger).

**Done-when:**
- `npm run test` passes (smoke test)
- `npm run lint` passes (no errors)
- `npm run typecheck` passes (no errors)
- All constants from the spec that are referenced more than once are named and exported from `constants.js`
- Committed

---

### Phase 1—Storage

**Purpose:** Persistence layer. Nothing reads the store yet; nothing in the store is meaningful yet. Just: we can write and read an entry.

**Inputs:** Foundation tooling from Phase 0.

**Outputs:**
- `src/core/state.js`—the top-level state shape from spec §3.2. `loadState(chatId) → State`, `persistState(chatId, state) → void`.
- `src/core/schema.js`—JSDoc types + validators for the entry schema (spec §3.1).
- `src/core/lock.js`—the write lock (spec §2 principle 2). Any mutation goes through `withWriteLock(fn)`.
- `src/memory/entry.js`—`createEntry(fields) → Entry`, `isValidEntry(x) → bool`.
- Unit tests: round-trip a synthetic state through persist/load, validate entries, write lock rejects concurrent mutations.

**Spec reference:** §3 (storage substrate), §3.1 (entry schema), §3.2 (top-level state), §2 principle 2 (write lock).

**Inter-phase contract—what Phase 2 inherits:**
```typescript
// src/core/state.js
loadState(chatId: string): Promise<State>
persistState(chatId: string, state: State): Promise<void>

// src/core/schema.js
type Entry = {
  id: string;
  scope: 'working' | 'episodic' | 'persona';
  content: string;
  subject: string | null;
  tags: string[];
  relations: { type: EdgeType; target: string }[];
  lifecycle: Lifecycle;  // shape defined in Phase 2
  provenance: { sourceMessages: number[]; extractor: string };
}

// src/core/lock.js
withWriteLock<T>(chatId: string, fn: () => Promise<T>): Promise<T>
```

**Done-when:**
- All unit tests pass
- A fresh chat produces an empty `State` on `loadState`
- `persistState` is a no-op followed by `loadState` returning the same state
- Write lock rejects concurrent callers (test: two `withWriteLock` calls in parallel—second must wait)

---

### Phase 2—Lifecycle (AKL-lite)

**Purpose:** The math from spec §7. Pure functions, no side effects.

**Inputs:** Entry schema from Phase 1.

**Outputs:**
- `src/lifecycle/importance.js`—`applyAccessEvent`, `applyUpdateEvent`, `applyDailyDecay`.
- `src/lifecycle/maturity.js`—`maturityFor(importance, currentTier) → Maturity` (with hysteresis).
- `src/lifecycle/recency.js`—`recencyAt(now, createdAt, tau=30) → number`.
- `src/lifecycle/index.js`—barrel exports + `maturityBoost(m) → number`.
- Unit tests: each formula, hysteresis gap behavior, decay convergence over 365 days.

**Spec reference:** §7 (lifecycle formulas), §5.2 (multiplicative score—shape lives in Phase 3 but lifecycle provides the inputs).

**Inter-phase contract:**
```typescript
type Lifecycle = {
  importance: number;          // [0, 100]
  maturity: 'draft' | 'validated' | 'core';
  createdAt: string;           // ISO
  updatedAt: string;           // ISO
  accessCount: number;
  updateCount: number;
}

applyAccessEvent(l: Lifecycle): Lifecycle
applyUpdateEvent(l: Lifecycle): Lifecycle
applyDailyDecay(l: Lifecycle, daysElapsed: number): Lifecycle
maturityFor(importance: number, currentTier: Maturity): Maturity
recencyAt(now: Date, createdAt: Date, tau?: number): number  // [0, 1]
maturityBoost(m: Maturity): 0.85 | 1.0 | 1.2
```

**Done-when:**
- All formulas from spec §7 match verbatim, with golden-value tests (e.g., `importance=50 → 7 accesses → 71`)
- Hysteresis test: oscillate importance 60 → 70 → 60; maturity stays `validated` both times (not promoted and demoted)
- Recency decay at `Δt = 21 days ≈ 0.5` (half-life check)

---

### Phase 3—Retrieval Core

**Purpose:** The pieces each retrieval tier composes. No ladder yet.

**Inputs:** Entry schema, lifecycle math.

**Outputs:**
- `src/retrieval/bm25.js`—`buildIndex(entries) → Index`, `query(index, q) → Scored[]`. In-memory only.
- `src/retrieval/classifier.js`—`classify(query) → 'factual' | 'relational' | 'temporal'`. Rule-based, spec §5.
- `src/retrieval/scorer.js`—the pluggable scorer (spec §9.2). Default: multiplicative per §5.2. Interface lets us swap at runtime.
- `src/retrieval/workingBuffer.js`—`prepend(results, workingEntries)`—the unconditional working-buffer prepend from spec §5.
- Unit tests: BM25 golden queries, classifier boundary cases (queries that mix cues), multiplicative scorer math.

**Spec reference:** §5 (retrieval ladder overview), §5.2 (score), §9.2 (pluggable scorer).

**Inter-phase contract:**
```typescript
// bm25.js
type Index = /* opaque */;
buildIndex(entries: Entry[]): Index
query(index: Index, q: string, k?: number): { entry: Entry; bm25: number }[]

// classifier.js
classify(query: string): 'factual' | 'relational' | 'temporal'

// scorer.js
type Scorer = (entry: Entry, query: Query, lifecycle: Lifecycle) => number
defaultScorer: Scorer  // multiplicative (spec §5.2)

// workingBuffer.js
prepend(results: ScoredEntry[], workingEntries: Entry[]): ScoredEntry[]
```

**Done-when:**
- BM25 against a fixture corpus returns expected top-K for 5 golden queries
- Classifier correctly routes 15 test queries (5 per type)
- Scorer matches spec §5.2 to 6 decimal places on fixed inputs
- Working-buffer prepend preserves order and deduplicates against results

---

### Phase 4—Retrieval Tiers (0, 1, 2, Floor)

**Purpose:** The deterministic ladder without graph expansion yet. Good enough for "most queries."

**Inputs:** All of Phase 3.

**Outputs:**
- `src/retrieval/tier0-exact.js`—hash cache, invalidated on any write.
- `src/retrieval/tier1-fuzzy.js`—Jaccard over query token sets, θ=0.6.
- `src/retrieval/tier2-bm25.js`—thin wrapper over `bm25.query`, applies the full score, checks exit threshold.
- `src/retrieval/floor.js`—top-K by `recency × importance × maturity_boost` when all tiers fail.
- `src/retrieval/ladder.js`—the orchestrator. Tier 3 slot is stubbed (returns its input unchanged) until Phase 5.
- `src/retrieval/trace.js`—trace logger (spec §9.1). Ring buffer, cap 100.
- Unit tests + integration test running the full ladder on a fixture chat.

**Spec reference:** §5 (ladder), §5.2 (score), §9.1 (trace logger).

**Inter-phase contract:**
```typescript
// ladder.js
retrieve(state: State, query: string, opts?: RetrieveOptions): RetrieveResult
type RetrieveResult = {
  entries: Entry[];
  tierResolved: 0 | 1 | 2 | 3 | 'floor';
  trace: Trace;
}

// trace.js
logTrace(state: State, trace: Trace): State  // mutates state.runtime.traces ring buffer
```

**Done-when:**
- Identical consecutive queries hit Tier 0 on the second call (measured in trace)
- Near-identical queries hit Tier 1
- Novel queries reach Tier 2 and return ranked results
- Fresh-chat query with empty state reaches Floor, returns `[]` without crashing
- Every retrieval produces a valid trace visible in `state.runtime.traces`

---

### Phase 5—Graph + Tier 3

**Purpose:** The relational piece. This is the piece the papers say earns its keep (AdaMem ablation: 2.02 F1 from graph).

**Inputs:** Entry schema, BM25 seeds from Tier 2.

**Outputs:**
- `src/memory/graph.js`—edge store (add/remove/listEdges, find neighbors). Runs on the flat edges array in state.
- `src/memory/edgeBuilder.js`—build edges at write time from (a) `@relations` in entries, (b) entity co-occurrence from capitalized-word matching. Spec §4.
- `src/retrieval/tier3-graph.js`—intent-routed beam search, 1–2 hops, scoring per spec §5.1.
- Integration into `ladder.js`—replace the Phase 4 stub with the real Tier 3.
- Unit tests: edge builder on synthetic entries, beam search on a small graph, intent routing picks expected edges.

**Spec reference:** §4 (graph is infrastructure), §5.1 (Tier 3 detail, MAGMA-lite), spec §11 (contradicts reserved but not produced).

**Inter-phase contract:**
```typescript
type Edge = { from: string; to: string; type: EdgeType; weight: number }
type EdgeType = 'mentions' | 'supports' | 'same_topic' | 'temporal_next'
// 'contradicts' is reserved in schema but NOT emitted by edgeBuilder in v2.0

addEdge(state: State, edge: Edge): State
neighborsOf(state: State, entryId: string): Edge[]
buildEdges(entry: Entry, allEntries: Entry[]): Edge[]

tier3(state: State, seeds: Entry[], query: string, intent: Intent): ScoredEntry[]
```

**Done-when:**
- Edge builder emits at least `mentions` and `same_topic` edges for a multi-entry fixture
- Beam search returns different results for `factual` vs `relational` vs `temporal` routing on the same seeds
- Tier 3's output merges cleanly with Tier 2 seeds, reranked under the full score
- Integration test: a multi-hop roleplay-style query that BM25 alone misses, Tier 3 catches

---

### Phase 6—Consolidation

**Purpose:** Where writes actually happen. The one-function discipline is enforced here.

**Inputs:** All prior phases, plus a way to call the user's configured SillyTavern LLM.

**Outputs:**
- `src/consolidation/extractFacts.js`—single function, ST connection-profile-based LLM call, JSON-schema-constrained output.
- `src/consolidation/consolidate.js`—the singular mutator. Holds the write lock, drains Working, extracts, dedupes, writes Episodic, builds edges, releases.
- `src/consolidation/triggers.js`—the debounced trigger (buffer ≥ 10 OR idle ≥ 60s).
- Integration test: mock LLM, feed 12 turns, verify consolidation runs once and produces the expected Episodic entries.

**Spec reference:** §6 (write path), §2 principle 2 (one path).

**Inter-phase contract:**
```typescript
extractFacts(batch: Message[], context: Context): Promise<Entry[]>
consolidate(chatId: string): Promise<void>  // the ONLY long-term mutator
maybeConsolidate(chatId: string, reason: 'buffer' | 'idle'): Promise<void>
```

**Done-when:**
- All unit tests pass including the "no other code mutates long-term storage" lint/test
- Consolidation is idempotent when re-run on already-consolidated data
- Mock LLM failure surfaces as a logged error without corrupting state

---

### Phase 7—Persona Rebuild

**Purpose:** The Enhanced RAPTOR pipeline. User-triggered, offline, replaces Persona entries atomically.

**Inputs:** All prior phases, user-configured LLM.

**Outputs:**
- `src/consolidation/personaRebuild.js`—pipeline orchestrator.
- `src/consolidation/raptor/chunking.js`—semantic chunking (τ=0.7).
- `src/consolidation/raptor/clustering.js`—Leiden on k-NN graph, adaptive params.
- `src/consolidation/raptor/summarize.js`—LLM summarization per cluster.
- `src/consolidation/raptor/atomic.js`—atomic replacement of Persona entries.
- Tests: fixture Episodic corpus produces expected Persona entries after rebuild.

**Spec reference:** §6.4 (Persona rebuild), wiki/raptor.md.

**Note:** This is the heaviest phase. May benefit from a native `graphology`-style library for k-NN + Leiden, or a hand-rolled version. Decision deferred to phase-7 plan.

**Inter-phase contract:**
```typescript
rebuildPersona(chatId: string, subject: string): Promise<RebuildReport>
type RebuildReport = { replacedCount: number; newCount: number; duration: number }
```

**Done-when:**
- Rebuild on a fixture corpus of 50 episodic entries produces a bounded number of persona summary entries
- Old Persona entries for the subject are atomically replaced
- Rebuild can be cancelled mid-flight without corruption

---

### Phase 8—SillyTavern Integration

**Purpose:** The surface the user actually touches.

**Inputs:** Everything working programmatically.

**Outputs:**
- `src/integration/interceptor.js`—the actual `STARmemInterceptor`.
- `src/integration/settings.js`—settings UI panel (ST-native).
- `src/integration/memoryViewer/`—the tabbed dashboard. Tabs: Working, Episodic, Persona, Graph, Traces.
- `src/integration/indicator.js`—the subtle consolidation dot.
- `index.js`—wire it all up on APP_READY.
- E2E test (Playwright or equivalent) against a fresh ST instance.

**Spec reference:** §8 (ST integration surface).

**Done-when:**
- Install into fresh ST, chat works end-to-end: user sends → interceptor injects retrieved entries → response generated → post-turn, consolidation fires after 10 turns
- Memory Viewer renders all five tabs with seed data
- Traces tab shows the last 100 retrievals, JSONL export works
- Settings UI can change: buffer size, idle timeout, scorer choice, extraction model
- Consolidation indicator visibly flips during a consolidation run

---

### Phase 9—Benchmarking

**Purpose:** Prove we can measure ourselves. Harness that runs on LoCoMo/LongMemEval-shaped data.

**Inputs:** Full working system.

**Outputs:**
- `src/eval/harness.js`—`evalAgainstCorpus(corpus, goldLabels)` with real implementation.
- `src/eval/metrics.js`—precision@k, recall@k, MRR.
- `src/eval/loaders/`—loaders for LoCoMo and LongMemEval-shaped JSON.
- `tests/benchmark/`—full benchmark run scripts.
- Baseline numbers captured and documented in `docs/benchmarks/2026-XX-XX-baseline.md`.

**Spec reference:** §9 (benchmarking hooks), §9.3 (eval harness—spec says "stub in v2.0, full in v2.1" but if time permits we can ship it in v2.0).

**Done-when:**
- `npm run benchmark -- --corpus=locomo` runs end-to-end and prints P@5/R@5/MRR
- Results reproducible across runs given fixed seeds
- At least one baseline number committed to `docs/benchmarks/`

---

## 4. Cross-Phase Conventions

### Runtime dependency policy (critical)

**SillyTavern loads this extension via `git clone` only. There is no build step.**

- `package.json` is development-only (lint, typecheck, test). `devDependencies` exist purely for the dev loop.
- `dependencies` stays **empty**. Runtime code imports only from (a) relative paths inside this repo, (b) SillyTavern's exposed modules.
- **No transpilation.** The code shipped is the code run. Target: ES2022 modules in a modern browser.
- If you need BM25, Jaccard, graph traversal, or Leiden — write it by hand or vendor a pure-JS implementation into `src/vendor/`. Do not add it to `dependencies`.

### Testing discipline

- **Unit tests per file** (`src/foo/bar.js` → `tests/unit/foo/bar.test.js`).
- **Integration tests per phase** in `tests/integration/`.
- **Each phase must end green on `npm run test` and `npm run lint` before moving on.**
- **No mocking beyond LLM calls.** Use real state, real locks, real BM25. Tests that mock too much stop catching real bugs.

### Commit discipline

- **Commit after every passing task.** The subagent-driven-development skill enforces this.
- **Commit messages:** `<type>(<scope>): <summary>`. `feat`, `fix`, `test`, `refactor`, `docs`, `chore`. Scope is a spec section number or a filename.
  - Examples: `feat(lifecycle): add importance scorer per spec §7`, `test(retrieval): golden BM25 queries`, `docs(plans): write phase-2 plan`.

### Documentation discipline

- **Inline JSDoc on every exported function.** Minimum: one-line summary, `@param`, `@returns`.
- **Per-phase `docs/plans/phase-N-<name>.md`** written before starting the phase.
- **Per-phase retro note appended to the roadmap** after the phase ships (what surprised us, what changed).

### Spec compliance checklist (run at every phase boundary)

Before declaring a phase done:

- [ ] Every function this phase introduces is referenced or required by the spec
- [ ] No function this phase introduces violates §2 principles (deterministic retrieval, one-path, honest instrumentation)
- [ ] Inter-phase contract above matches what was actually built
- [ ] If the contract changed during implementation, this roadmap is updated to reflect reality
- [ ] No out-of-scope functionality from §11 has crept in

---

## 5. What's Not in the Roadmap

Per spec §11:

- Drift detection
- Influence propagation at retrieval time
- Multi-agent research loops
- Embeddings anywhere
- Migration from v1
- Lightweight NER (capitalized-word matching suffices for v2.0)

These are v2.1+ considerations. Do not implement them in any phase.

---

## 6. Phase Retro Log

_Appended after each phase ships. Format: `## Phase N—<date>`, with notes on surprises, scope changes, and lessons for subsequent phases._

_(Empty. To be filled as we go.)_
