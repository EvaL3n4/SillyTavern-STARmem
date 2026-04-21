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

## Phase 9—2026-04-21

**What shipped:** Benchmarking subsystem — `bench/cli.js` (single-harness entry point), `bench/runner.js` (seed → retrieve → metrics orchestration), `bench/baselines.js` (ladder / bm25only / recency / random comparison), `bench/harness/seeder.js` (conversation-to-state seeder), `bench/loaders/locomo.js` + `index.js` (LoCoMo JSON parser), `bench/metrics/retrieval.js` (precision@k, recall@k, MRR), `bench/sweeps/_driver.js` (coordinate-descent driver), `bench/sweeps/{tau,graph,consolidation,bm25}.js` (four knob sweeps), `bench/baselines/{bm25only,recency,random}.js` (three baseline retrievers), `docs/bench/baseline.json` (measured-values artifact with FLAT/DEFERRED status), `tests/integration/bench/cli-mounts-wired.test.js` (grep invariant across 6 bench entry points), `tests/integration/bench/baseline-json.test.js` (schema validator for baseline.json). 5 smoke writeups produced (4 sweeps + 1 baseline comparison, all untracked).

**Test totals:** 70 suites / 734 tests — all green. Baseline at Phase 8 close was 68 suites / 732 tests; Task 9 added 2 suites and 2 tests (wire-invariant 12 assertions + baseline-json validator 7 assertions).

**Commits this phase:** 9 (Tasks 0–8) + 3 (Task 9 close) = 12. Baseline commit `54986c2` (plan-patch preflight); Phase 9 HEAD after retro is the Task 9 close commit.

**Execution mode:** Subagent-driven for Tasks 1–8 via Fireworks/Kimi-K2.6 routing (avoided Azure flakiness). Controller executed Task 9 directly (retro narrative quality > subagent speed). Preflight pattern: 6 Task dispatches, each preceded by a plan-patch commit. ~18 plan bugs caught preflight across Tasks 4–8; zero downstream-discovered bugs.

**Decisions held (1–3, 6–10) / revised (4–5):**

- Corpus (LoCoMo primary, synthetic smoke), metrics (P@k/R@k/MRR), harness shape (Node CLI), coordinate descent (one knob at a time), synthetic embeddings, advisory-only regression gate, out-of-scope list, spec amendment first — all held.
- Decision 4 (Jaccard gold-match): worked mechanically, but rule-based seeder flattens the signal — extractor is the real bottleneck, not the matcher.
- Decision 5 (baselines): bm25only > ladder on synthetic 4-QA is a non-structural flag (ladder-vs-random invariant held). Re-validate on real LoCoMo in sub-phase 9.5.

**Surprises:**

1. Rule-based extractor is the structural bottleneck for all four knob sweeps — flat metrics across τ, graph λ, dedup, and bm25 boosts on both synthetic and 3-conv real LoCoMo.
2. bm25only > ladder on synthetic 4-QA (MRR 1.0 vs 0.6875). Scorer chain multiplicative factors introduce perturbations that hurt on tiny corpora; not a bug, but needs re-validation.
3. Short-form key-name drift plan-bug pattern: Tasks 4, 5, 6 all had colloquial short names in the plan that didn't match `_SWEPT_*_KEYS`. Task 7 was the first clean match. Fix: preflight-audit skill now greps `_SWEPT_*_KEYS` first.
4. Signature drift against Task 3c: Task 8 baseline plan drafted `(chatId, query, {k}) → Array` before real `retrieve()` shape `(state, queryStr, opts) → RetrieveResult` landed. Caught preflight.
5. Azure empty-completion turns under >25KB payload bloat: Task 8 dispatch tripped threshold twice. Mitigation: smaller delegate_task contexts pointing at plan sections.
6. Subagent seeder-API confabulation during Task 3c: `chatIdPrefix` vs `chatId` — caught in-flight, fixed in runner, no rework.

**Notes for sub-phase 9.5 and Phase 10:**

- **9.5:** Swap rule-based extractor for real LLM (env-gated), re-run all 4 sweeps on full LoCoMo, validate ladder ≥ bm25only, add `TIER3_MAX_HOPS` + `EXPLICIT_RELATION_WEIGHT` sweeps, tune `EXTRACT_MAX_TOKENS` with real token counts.
- **Phase 10:** Playwright smoke harness for live ST integration, UX polish pass (settings panel hierarchy, viewer tab alignment, indicator tooltip), external memory-system baselines (Zep, Mem0).

---

## Phase 8—2026-04-21

**What shipped:** SillyTavern integration surface — `src/integration/constants.js` (UI-scoped settings + injection constants, `CSS_PREFIX=starmem`, `INJECTION_DEPTH=4`), `src/integration/settings.js` (`extension_settings['STARmem']` persistence with defaults, clamps, schemaVersion drift handling, injectable context for tests), `src/integration/interceptor.js` (the real `starmemInterceptor` body — chatId resolution, last-user-message query extraction, retrieve → splice at `INJECTION_DEPTH=4` with short-chat prepend fallback, all errors caught and swallowed), `src/integration/bootstrap.js` (APP_READY handler — settings load, state backend install, indicator mount, viewer pre-mount, idle timer install, `CHAT_CHANGED`/`MESSAGE_SENT`/`MESSAGE_RECEIVED`/`MESSAGE_DELETED` subscriptions, idempotent double-bootstrap), `src/integration/indicator.js` (consolidation dot mounted in `#send_but_container` with floating-fallback — idempotent mount, 1 s polling, animated amber pulse), `src/integration/settingsPanel.js` + inlined HTML (`renderSettingsPanel` — profile/embed profile / scorer dropdowns, three sliders, Reset button — all persisting through `setSettings`), `src/integration/viewer/mount.js` (native `<dialog>` shell via `openViewer` — tab strip + mobile `<select>` collapse at 639 px, close/teardown, tab routing, subject filter, popup fallback when `<dialog>` unavailable), `src/integration/viewer/tabs/{working,episodic,persona,graph,traces}.js` (five tabs, each self-contained, each JSDOM-tested), `tests/helpers/stContextMock.js` (minimal `getContext()` factory + real-pub/sub `eventSource` spy + `installGlobalSillyTavern` teardown — 11 self-tests), `src/integration/index.js` barrel, root `index.js` rewrite (TLA subscription to APP_READY + interceptor shim with try/catch shield), `src/consolidation/` got `clearTraces(chatId)` for the Traces tab, `style.css` (hybrid ST-var + hardcoded-accent theme, native `<dialog>` sizing, single 639 px breakpoint, four CSS invariants enforced in tests: prefix / `!important` budget / fallback requirement / single-breakpoint), grep invariant `no-leaky-css.test.js` (walks `src/integration/` for non-prefixed class/id tokens — tripwire-verified), `scripts/smoke.md` (18-step manual checklist in three sections). Plan finalized in-place as `docs/plans/phase-8-st-integration.md` — no rename needed, never had the old name.

**Test totals:** 57 suites / 618 tests — all green. Baseline at Phase 7 close was 44 suites / 488 tests; Phase 8 added 13 suites and 130 tests.

**Commits this phase:** 24, plus this retro = 25. Baseline commit `5812b79` (plan draft); Phase 8 HEAD before retro is `2928298`.

**Execution mode:** Mixed — controller for load-bearing / small tasks (0, 2, 3, 8, 9, 11 and all inline plan-bug patches), subagents for DOM-heavy or mechanical tasks (1, 4, 5, 6, 7.1–7.5, 10). Reviews skipped per subagent-driven-development skill criteria (verbatim code + static checks: tsc, eslint, jest). Controller audits: two grep invariants (CSS prefix, ET map) tripwire-verified; `git log -1` hash checks after every subagent delegation per sandbox-path-hygiene.

**Decisions locked in the planning conversation (all held through execution):**

1. E2E harness: JSDOM + manual smoke checklist. Playwright deferred to Phase 9.
2. DOM rendering: vanilla `createElement`/`textContent` for data, `innerHTML` only for static templates.
3. Settings persistence: `extension_settings['STARmem']` for globals, no new per-chat settings.
4. Injection format: spliced at `INJECTION_DEPTH=4` with `role: system`, short-chat prepend fallback.
5. Access events: pre-generate — called on entries returned by `retrieve()`, not every candidate.
6. Chat switch hygiene: `CHAT_CHANGED` cancels idle timer, clears per-chat caches, triggers `maybeConsolidate` on new chat if over threshold.
7. Traces: 128-entry ring buffer, JSONL export via blob URL, per-trace expand.
8. Delegation split: controller owns load-bearing/integration, subagents own DOM components.
9. CSS scoping: `starmem-*` prefix on every class/id, enforced by grep invariant.
10. Module layout deviates from spec §10 — documented in §5 of the phase plan; spec amendment deferred to Phase 9 preamble.
11. `stContextMock` surface: minimal + `eventSource` spy, factory-per-test (not shared singleton).
12. CSS theming: hybrid — `var(--SmartTheme…, #fallback)` for surfaces, hardcoded accents (`#7aa2f7` blue, `#e0af68` amber) for STARmem-specific elements.
13. Viewer modal: native `<dialog>` with `showModal()`.
14. Indicator mount: `#send_but_container` anchor (stable ST structure), NOT `document.body` — revised from chunk 3 draft.
15. Smoke checklist: thorough (18 steps, pure prose, single `smoke.md` file).

**Surprises:**

1. **Plan bug pattern held steady: three verbatim-code bugs caught in the last three tasks, each by a different signal.** Task 8's `ET` map dropped `GENERATION_STARTED` (not a Phase-8 event) and had to add `MESSAGE_SENT`; patched into the plan as commit `4ac4e3f` before execution. Task 9's barrel referenced four symbol names that didn't match what Tasks 2/3/5/6 actually shipped (`runInterceptor`→`starmemInterceptor`, `bootstrap/teardown`→`bootstrap`, `mountSettingsPanel/unmountSettingsPanel`→`renderSettingsPanel`, `mountViewer/unmountViewer/isViewerOpen`→`openViewer`); caught by `tsc --noEmit` on first run, fixed in the shipped code, plan annotated with a reconciliation block. Task 10's invariants test regex scanned raw CSS without stripping `/* ... */` comments, producing false positives on hex fallbacks (`#e8e8e8`), decision refs (`14.B`), and filename tokens (`.json`, `.css`); caught by the Task 10 subagent correctly stopping on ambiguity rather than modifying the CSS to pass. Pattern: for ~5 500-line plans with verbatim code, expect 2–4 drift bugs per phase. `tsc` + `eslint` + `jest --silent` are load-bearing — they catch 100% of the ones my eyes miss.

2. **`subagent-driven-development` skill's "trust stops on ambiguity" protocol paid off cleanly on Task 10.** The delegated subagent wrote both files from the plan, hit the invariants-test failure, correctly identified the four token classes causing false positives, presented four options (fix test / fix CSS / commit broken / update plan), and stopped. Fix at the controller level took ~3 minutes (strip comments + skip hex tokens + tripwire-verify). If the subagent had pushed through with judgment, we'd have shipped either an incorrect test that silently loses coverage or a reformatted CSS that still fails the invariant.

3. **Plan file rename was already done.** Decision 15 called for a `phase-8-integration.md` → `phase-8-st-integration.md` rename, but the finalized plan never had the old name — `663a924` committed it directly as `phase-8-st-integration.md`. No-op.

4. **Post-ship miss: three UI mounts were orphaned in `index.js` (caught 2026-04-21, after retro).** `renderSettingsPanel`, `mountIndicator`, and `openViewer` shipped with full unit + JSDOM coverage but zero production callers — the plan's Task 9 ("`index.js` wire-up") subscribed `bootstrap()` to `APP_READY` and stopped there. `bootstrap()` only wires event handlers and the state backend; it touches no DOM. The extension loaded "successfully" (no console errors after the async/sync `bootstrap().catch` bug was fixed) but rendered nothing in ST. Fourth plan-drift bug of the phase, undetected by static checks because there was nothing to statically check — unused imports were never there to trip eslint; the fallout was purely a missing call graph, which tsc/jest can't see. **Reviewer (Eva) self-flagged:** spec §8's "Settings UI panel / Consolidation indicator / Memory Viewer" as deliverables didn't translate into explicit `index.js` call-site checklist items, and the Task 9 description focused on the APP_READY subscription shape instead of the full DOM attachment chain. Fix: added `tests/integration/integration/index-mounts-wired.test.js` — tripwire-verified guard that every mount symbol listed in `index.js`'s docblock is both imported AND called at a non-import site. All three tripwires fire cleanly.

5. **Deferred UX polish.** The Phase 8 UI is functional but visually crude — cramped `<details>` sections in the settings panel, the viewer modal's tab strip has rough alignment and no active-state emphasis, the indicator dot is a plain amber pulse with no tooltip on hover. The smoke-test aesthetic. Eva's review verdict: "ugly for the most part, hard to parse." Non-blocking for Phase 9 (benchmarking is invisible to the end user), but worth a dedicated polish pass before any external release.

**Notes for Phase 9 (Benchmarking):**

- **Playwright gate for real DOM regressions.** JSDOM smoke coverage is structural only — it can't catch CSS layout bugs, z-index stacking issues, or `<dialog>` backdrop rendering differences across browsers. Phase 9 is the right time to add a minimal Playwright harness: install the extension into a fresh SillyTavern, run through the 18-step `smoke.md` checklist as automated steps, snapshot the viewer dialog at desktop and < 640 px widths.
- **Trace ring buffer is the telemetry surface.** The 128-entry ring in `chatMetadata['STARmem'].runtime.traces` plus JSONL export is exactly the shape a bench harness needs. Phase 9 can consume these directly — no additional logging needed. Bench pipeline: seed chat → replay user turns via interceptor-eligible messages → dump JSONL → compute precision@k / recall@k / MRR offline.
- **Azure delegation payload-bloat caveat.** This phase ran during a week of flaky Azure Claude 4.7 completions caused by large tool-call arguments; subagents for tasks writing >25 KB of verbatim code failed intermittently. Task 10's CSS was 11 KB (safe) but flirted with the threshold. Phase 9 tasks that subagents touch: keep individual `write_file` calls under 25 KB. Chunk larger files across multiple calls.
- **Spec §10 module layout amendment.** Phase 8 deviated from spec §10 in two places (viewer sub-directory, integration barrel). Update the spec before Phase 9 begins — Phase 9 needs clean anchors to reference.
- **`starmem-*` CSS prefix invariant is load-bearing and cheap.** Keep it running in Phase 9. Extend if Phase 9 adds DOM (unlikely — benchmarking is non-UI — but if a benchmark-viewer ships, apply the same test).
- **`stContextMock` factory covers everything Phase 8 needed; extend minimally.** When Phase 9 tests need additional ST surface (e.g., `getEventSourceStream`), add the field to `stContextMock` rather than inline per-test.
- **Plan-drift detection: call-site invariants, not just symbol-existence invariants.** Phase 8 had four verbatim-code drift bugs; three were caught by `tsc`/`eslint`/`jest`, but the fourth (orphaned UI mounts) slipped through because the missing signal was a *call site*, not a *symbol*. Phase 9+ template: for any public-entry-point file whose job is "wire these N things together," add a grep-invariant test asserting the wiring exists. `index-mounts-wired.test.js` is the template. Cost: ~80 LOC per entry point, including tripwire verification. Benefit: catches the one class of bug nothing else catches.
- **Plan writing: translate deliverables into explicit call-site checklists.** Decision for the Phase 9 plan template — every "ships X" bullet in the scope recap should generate a matching "from Y, `X` is called at line Z of file W" bullet in the verification block. The reviewer (me, Eva) missed this on Phase 8; structural fix beats another round of vigilance.
- **UX polish pass needed before any external release.** Phase 8 settings panel, viewer modal, and indicator are visually crude — functional but "ugly for the most part, hard to parse." Phase 9 is non-UI so this defers naturally; pick it up before a real user sees the extension. Scope: settings panel visual hierarchy (collapsed-by-default `<details>` are too dense), viewer tab strip active-state + alignment, indicator tooltip/state affordance, overall type scale + spacing rhythm.

---

## Phase 7—2026-04-20

**What shipped:** Persona rebuild pipeline — `src/consolidation/personaRebuild.js` (orchestrator: snapshot → chunk → loop(knn → leiden → summarize) → atomic swap; AbortSignal threaded through every stage with 8 `throwIfAborted` call sites; 8-stage `onProgress` callback), six RAPTOR internals under `src/consolidation/raptor/`:
  - `chunking.js` — identity stub per Decision 6 (1 entry = 1 leaf)
  - `embeddings.js` — injectable ST Vectors client (`/api/vector/insert|query|purge`) + deterministic synthetic client for tests + exported hashText/syntheticEmbedding/cosineSimilarity helpers
  - `knn.js` — adaptive k (K_BASE=15, K_STEP=5), symmetric adjacency via max-weight per pair
  - `leiden.js` — full Leiden (708 LOC): modularity + partition helpers, localMove with incremental stats, refinement with well-connectedness threshold, aggregation + lift/unlift, outer-loop driver, public `leidenCluster` + depth-aware `gammaForDepth`, per Traag et al. 2019
  - `summarize.js` — per-cluster LLM summarization reusing Phase 6's `callLLM`
  - `atomic.js` — subject-scoped Persona replacement under `withWriteLock`, functional-swap via `entriesNext`, resets `pendingPersonaRebuild` and `episodicCountSinceLastRebuild`

`src/consolidation/index.js` barrel extended to export `rebuildPersona`. `tests/integration/consolidation/personaRebuild.test.js` — 20-entry two-theme corpus end-to-end + idempotent-rebuild test. 13 feature commits + plan + integration test + retro = **15 commits this phase**. **440 tests passing across 41 suites** (341 Phase 6 baseline + 99 new: 1 constants delta + 6 chunking + 19 embeddings + 14 knn + 36 leiden + 8 summarize + 6 atomic + 7 personaRebuild unit + 2 integration). Lint, typecheck, test all green. **~1,636 LOC** across `src/consolidation/` additions.

**Deliberate spec deviations (documented up front, TODO list for a standalone `docs(spec)` commit):**

1. **Embeddings permitted in persona rebuild** — spec §11's "no embeddings anywhere" is about the hot retrieval path. Persona rebuild is user-initiated, offline, and not on the query path; embeddings are OK there. **Amendment needed:** §11 should clarify the hot-path scope; §6.4 should name SillyTavern Vectors as the embedding source.
2. **Semantic chunking skipped** — spec §6.4 prescribes semantic chunking (τ=0.7) but Episodic entries from Phase 6 are already atomic third-person facts. Chunking them would fragment coherent statements. `raptor/chunking.js` is an identity stub; v2.1 can reinstate if long documents ever enter Episodic.
3. **Per-task commit discipline slipped by one** — Task 8 Step 1 prescribed a standalone `"feat(consolidation): export rebuildPersona from barrel"` commit. The Task 7 subagent folded the one-line barrel change into its orchestrator commit (`661ee54`). Minor, harmless, caught during the Task 7 audit. Not worth retroactive history editing; just note that Task 8 ended up being "integration test + retro" rather than "barrel + integration test + retro."

**Execution mode:** Subagent-driven, reviews skipped per the skill's criteria (verbatim code + static checks per task), with controller-side audits after Task 4.5 (Leiden convergence determinism over 10 seeds), Task 6 (atomic mutator one-path invariant + functional-swap verification), and Task 7 (orchestrator abort-propagation grep). Tasks 4.1–4.5 were the highest-risk stretch; all passed first try thanks to hand-computed golden modularity values serving as a tripwire. Zero sandbox-path strays across 10 delegations.

**Decisions locked in the planning conversation (all held through execution):**

1. Embedding source: SillyTavern Vectors API, injectable client, synthetic test fallback.
2. Clustering algorithm: **Leiden** (not Louvain, not agglomerative) — spec-faithful; well-connectedness guarantee materially matters on Eva's target corpora (thousands of turns → hundreds of Episodic facts per subject).
3. Tree depth/stop: `MAX_DEPTH=3`, clusters<2, leaves<`MIN_CLUSTER_SIZE`×2.
4. What becomes a Persona entry: every non-leaf layer's summary + root (merged layer if MAX_DEPTH exited without collapse).
5. Atomic replacement: delete-where-subject + add new, one `withWriteLock`. Dangling edges left alone.
6. Skip semantic chunking: Episodic entries are already atomic facts.
7. Cancellation: `AbortSignal` threaded through every stage; `throwIfAborted()` helper.
8. Counter reset: `rebuildPersona` on success clears `pendingPersonaRebuild` and zeroes `episodicCountSinceLastRebuild`.
9. Test embeddings: deterministic synthetic FNV-based client, no real embeddings in unit tests.
10. Module structure: `personaRebuild.js` orchestrator + six `raptor/*.js` modules.

**Surprises:**

1. **Two genuine plan-side bugs surfaced by subagents during TDD** — the same class Phase 6 saw:
   - **Task 1 (chunking):** the plan used `over.subject ?? 'alice'` to default a subject. Nullish-coalescing doesn't fire on explicit `null`, which the test fixture was passing. Subagent caught this on the first test run and picked the right fix. Lesson: `??` vs `||` is a spec-semantics choice that should be decided at plan time, not left to an idiom tax on the subagent.
   - **Task 8 (integration test):** three typos in the verbatim-code block — `FIXED_NOW_time()` instead of `FIXED_NOW.getTime()` (flat typo), an awkward `firstPersonaIds` block that triggered lint noise, and a JSDoc `@param` that should have been `@returns`. Subagent fixed all three and committed.
   The writing-plans skill's "don't bake predicted totals into task instructions" generalises: don't trust verbatim code in a ~4K-line plan to be free of copy-paste drift. Subagent TDD catches it, but it's friction.

2. **Task 4.5 (Leiden public API) shipped dead code from the plan.** `refinedMatchesWork` was computed but only used inside the scope it was defined in — the outer comparison never referenced it. Subagent replaced it with a cleaner `sameCount` convergence check. Same root cause as surprise #1: the plan was 3948 lines and the Leiden section carried enough state to lose track of. The fact the subagent noticed rather than just transcribing is a quality signal for the approach.

3. **Leiden landed deterministic on the first try.** The Task 4.5 controller audit ran the two-triangle fixture across 10 random seeds; 10/10 converged to the correct 2-community split. The Task 4.1 modularity golden value matched hand computation within 1.7e-16 (`Q = 0.4836065573770493` vs expected `0.483606`). This is the biggest positive surprise: Leiden is notorious for subtle convergence bugs and we shipped ~700 LOC of it with zero convergence defects. Two things earned this: (a) splitting Task 4 into five reviewable sub-commits with tests after each, (b) anchoring 4.1 with a hand-computed golden value so every downstream stage inherited a tripwire.

4. **Snapshot-then-swap concurrency held.** `rebuildPersona` takes the write lock only for the final atomic swap; the heavy LLM/clustering phase runs lock-free. No test observed a rebuild-consolidate interleaving problem because the atomic swap is subject-scoped and consolidation mutates `state.entries` via its own lock — the race windows don't overlap on data. Phase 8 should re-verify this under real usage but the static analysis holds.

5. **Integration test passes with synthetic (hash-based) embeddings.** The `newCount ≥ 1` assertion is loose enough that even semantically-meaningless vectors produce *some* Leiden partition, so the integration test validates the pipeline wiring but NOT cluster quality. This is known and explicit (see Phase 9 notes), but worth calling out: green integration tests here do not imply good character sheets in production. Phase 9's real-embedding benchmarks are what actually stress cluster quality.

**Notes for Phase 8 (SillyTavern Integration):**

- `rebuildPersona(chatId, subject, opts)` is the public entry point. Phase 8's Memory Viewer "Persona rebuild" button → call this with the active chat + subject.
- `opts.onProgress({stage, depth?, clusters?})` lets the UI render a progress indicator. Known stages: `snapshot`, `chunk`, `knn`, `cluster`, `summarize`, `summarize-root`, `summarize-root-direct`, `atomic-swap` (8 total).
- `opts.signal: AbortSignal` lets the UI cancel mid-run (e.g. navigation away or Cancel click). Throws `AbortError`; UI should distinguish this from real errors.
- The extractor-label `"<model>@persona-rebuild-v1"` needs to be computed by Phase 8 from the active ST connection profile name. Phase 7 doesn't hard-code it.
- Embedding source is whatever the user has configured in ST's Vectors extension. Phase 8 should surface a warning if Vectors is disabled/misconfigured: rebuild will fail cleanly with a descriptive fetch error, but a pre-flight check is friendlier.
- The one-path invariant test already whitelists `src/consolidation/` — no update needed for Phase 7's new files.
- `SillyTavern.getContext()` is already the canonical access pattern (Phase 1 locked this in); the Phase 7 code does not introduce any new ST integration surface — all ST calls are via the injectable `embeddingClient` and `callLLM`.

**Notes for Phase 9 (Benchmarking):**

- Leiden seed is pinned to 1 by default in `leidenCluster`. For A/B evaluations, vary the seed and measure stability of cluster assignments — if the assignment changes materially between seeds, the cluster is poorly supported by the graph structure.
- `K_BASE=15`, `K_STEP=5` are spec values, never measured on real corpora. If benchmarks show sparse graphs (many isolated components) on small Episodic corpora, lower `K_BASE`. If graphs are near-complete (every node neighbours every other), raise it.
- `GAMMA_BASE=1.0`, `GAMMA_STEP=0.2` — same story. Higher γ produces more, smaller clusters. Phase 9 can sweep γ on a fixed corpus and measure cluster count / modularity curves.
- **The synthetic embedding client in `raptor/embeddings.js` is NOT suitable for benchmark runs** — hash-based embeddings have no semantic structure. Phase 9 must use real ST Vectors (user-configured provider) for meaningful eval.
- `SUMMARY_MAX_TOKENS=512`. If Phase 9 shows summaries consistently truncated (response ends in `,` or `"…`), bump to 1024; if they're always under 200 tokens, drop to save cost. Same "tunable-under-benchmark" treatment as Phase 6's `EXTRACT_MAX_TOKENS`.
- Layer count per rebuild should converge in 2–4 layers on corpora of ~100–500 Episodic entries. If hitting `MAX_DEPTH=3` frequently, clusters are too granular; consider lowering `GAMMA_BASE`.
- Integration-test assertion is `newCount ≥ 1` — deliberately loose because synthetic embeddings can't support tighter bounds. Phase 9's real-embedding tests should pin expected cluster count on a fixed golden corpus.

---

## Phase 6—2026-04-20

**What shipped:** Consolidation pipeline — `src/consolidation/consolidate.js` (single long-term mutator, holds write lock, drains `BATCH_SIZE`=5 working-buffer entries, extracts via user-configured LLM, dedupes same-subject + Jaccard≥0.7, adds/updates, builds edges for new entries, invalidates Tier 0 cache, flips `pendingPersonaRebuild` at 100 new episodics), `src/consolidation/extractFacts.js` (JSON-schema-constrained prompt with strip-fences JSON parser + permissive-where-spec-allows shape validator; silently drops reserved `contradicts` relations per spec §4; 2048 max_tokens for extraction), `src/consolidation/dedup.js` (`findDuplicate` + exported `jaccard` helper sharing `tokenize` with BM25), `src/consolidation/llmClient.js` (injectable wrapper over ST's `ConnectionManagerRequestService.sendRequest` with lazy `SillyTavern.getContext()` resolution, test-mock hooks), `src/consolidation/triggers.js` (`maybeConsolidate` gating + per-chat idle timer via module-level `setTimeout` map, not persisted), `src/consolidation/index.js` barrel, `tests/unit/consolidation/no-other-mutators.test.js` (one-path invariant test, grep-based, verified via tripwire sentinel), `tests/integration/consolidation/pipeline.test.js` (12-turn end-to-end). 7 feature commits + barrel + invariant/integration + retro = 10 commits this phase. **341 tests passing across 33 suites** (262 Phase 5 baseline + 79 new: 2 constants/schema delta + 12 dedup + 7 llmClient + 20 extractFacts + 10 consolidate + 9 triggers + ~17 invariant (one per non-whitelisted src file) + 2 integration).

**Execution mode:** Subagent-driven with reviews skipped per the skill's criteria (verbatim code + static checks per task), with controller-side invariant audit after Task 4 (consolidate) and tripwire verification of the one-path test after Task 6. Six delegations ran serially. Zero sandbox-path strays. Zero merge conflicts. Three subagent deviations from plan code (all correct fixes, reported up-front, controller verified and folded into the same commit). The `~` trap did not recur — every subagent context passed absolute paths + tripwire hash.

**Decisions locked in the planning conversation (all held through execution):**

1. Dedup criterion: same subject + Jaccard ≥ 0.7 over BM25 tokenization.
2. Dedup update semantics: keep older content, bump lifecycle via `applyUpdateEvent` only.
3. LLM client: `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens)` with user-selected profile, injectable for tests via `_setLLMClientForTests`.
4. JSON parse/validate: fail-closed, no retry in `consolidate` (buffer stays intact → natural retry on next trigger).
5. In-flight guard: `state.runtime.consolidating` flag, checked before lock, set inside, cleared in finally.
6. New runtime fields: `consolidating: boolean`, `episodicCountSinceLastRebuild: number`.
7. Idle timer: module-level per-chat `setTimeout`, not persisted; `resetIdleTimer` debounces, `cancelIdleTimer` tears down.
8. One-path invariant: grep-based test in `no-other-mutators.test.js` with explicit whitelist + tripwire-verified.
9. Batch size r = 5 verbatim from spec §6.3.

**Surprises:**

1. **Three verbatim-code plan bugs, caught by subagents during TDD.** Worth tracking because the pattern repeats:
   - **`EXTRACT_MAX_TOKENS = ***`** in the plan — the heredoc I used to author Task 3 tripped the editing-near-secrets guard, which redacted the numeric literal `2048` to `***` on write. Subagent sensibly picked `500` as a safe fallback, reported, and I patched both the source and the plan to `2048` before amending the commit. Pattern for future plans: when writing plans via heredoc, avoid looking-like-credentials constants, or use a placeholder like `/* TODO fill in */` and assign explicitly in a follow-up.
   - **`makeLogger('scope')` → `createLogger({ debug: false }).scope('scope')`** — my plan used a function that didn't exist. The real API is `createLogger(options).scope(name)`. Caught by Task 4's subagent; Task 5's subagent applied the same fix pre-emptively because I flagged the known bug in the delegation context.
   - **`.by train` Jaccard = 0.667, below threshold 0.7** — same plan-side mistake in three places (Task 1 dedup test, Task 4 consolidate test, Task 4 mock-LLM dedup test). `.train` alone gives 4/5 = 0.8. The Task 1 subagent caught and fixed it; the Task 4 subagent independently applied the same fix. Consistency across subagents here was better than my consistency across the plan.

2. **Invariant test regex was too naive for first commit.** `state.entries[` matches reads too (`const e = state.entries[id]`). `applyUpdateEvent\s*\(` matches the function definition line too (`function applyUpdateEvent(l, now = ...)`). Task 6's subagent surfaced two false positives against tier3-graph.js (read) and lifecycle/importance.js (definition) and — correctly — stopped without modifying the whitelist. Controller fix: tighten writes to require an assignment operator after the bracket (`state\.entries\[[^\]]*\]\s*(?:=|\+=|...)`), add lookbehinds to exclude `function` declarations, and add `src/lifecycle/importance.js` to the whitelist as the definition site. Tripwire test after the fix: injected `// TEST-SENTINEL: state.entries['bogus'] = 1` into tier3-graph.js, confirmed the invariant test failed with a clear "Spec §2 principle 2 violation" message pointing at the file and line, then reverted. Test is now genuinely load-bearing.

3. **Subagent-reported test counts drifted from plan predictions by a small, honest amount.** Task 3 shipped 20 tests, not the plan's predicted 22. The plan listed "4 parseLLMJson + 8 validate + 1 renderPrompt + 9 extractFacts" but the verbatim code only contained 7 extractFacts tests, so 4+8+1+7 = 20. The writing-plans skill already says "let the actual number emerge; don't bake predicted totals into task instructions" — this reconfirms. Baking totals is future-you staring at a 2-off arithmetic error with no good way to reconcile.

4. **Concurrent-consolidation test passed on first run with zero flakes.** The `Promise.all([consolidate, consolidate])` test relies on `withWriteLock` serializing two fresh runs such that the second sees `workingBuffer.length === 2` after the first drained 5 of 7. If there were any `await` re-ordering bugs in the consolidate pipeline, this test would catch them. It didn't, which means the "capture batch before mutation" discipline in the plan held.

**Notes for Phase 7 (Persona Rebuild):**

- `runtime.pendingPersonaRebuild` flips at `PERSONA_REBUILD_SUGGESTION_THRESHOLD = 100` cumulative new episodic entries. Phase 7's rebuild pipeline should clear that flag on completion AND reset `runtime.episodicCountSinceLastRebuild` to 0.
- `consolidate()` holds the chatId's write lock during its run. Persona rebuild is heavier (seconds to minutes); it should NOT run under the same lock — otherwise consolidation queues up behind rebuild. Options: a second lock primitive keyed by `${chatId}:persona`, or a rebuild-in-progress flag + explicit "rebuild mutates state.entries Persona slice only, consolidation mutates Episodic slice only" carve-out. The carve-out means rebuild can bypass the write lock if (and only if) it touches disjoint state. Decide in the phase-7 plan, not here.
- The extractor-label pattern (`"<model>@consolidation-v1"`) is the template for rebuild provenance: `"<model>@persona-rebuild-v1"`. Phase 7 entries should carry this in `provenance.extractor`.
- The one-path invariant test already whitelists `src/consolidation/` — Phase 7's rebuild code should live under `src/consolidation/persona-rebuild/` (or similar) to inherit the whitelist, OR be added as an explicit new whitelist entry with a comment explaining why.

**Notes for Phase 8 (SillyTavern Integration):**

- `ConsolidateOptions.messageOf` is the interceptor's hook — maps a Working entry to a `{ role, content }` batch message. This is where roleplay-specific formatting lives (system/assistant role preservation, author notes stripped, etc.). Phase 8's interceptor provides the real implementation.
- Settings UI needs a connection-profile dropdown for `profileId` (spec §8). Default: whatever ST reports as the active profile at install time. Wire `ConnectionManagerRequestService.getProfiles()` (or equivalent — check ST's API) into the dropdown.
- Idle timer requires the interceptor to call `resetIdleTimer(chatId, opts)` on every user activity event (generation request, message send). `cancelIdleTimer(chatId)` on chat switch or extension teardown. Module-level timer map means no cleanup needed across chats — just cancel the specific one.
- Consolidation indicator (spec §8) keys off `state.runtime.consolidating` — Phase 8 polls or subscribes. The flag is cleared in a `finally` inside the write lock, so polling frequency doesn't matter for correctness.
- The Memory Viewer Traces tab doesn't render consolidation events yet — Phase 6 doesn't produce traces, only Phase 4's retrieval ladder does. If Eva wants a "consolidation log" tab, we'd hook it off the `consolidate()` return value `{ added, updated, drained }` — file as a v2.1 enhancement if the retrieval traces prove insufficient.

**Notes for Phase 9 (Benchmarking):**

- `DEDUP_JACCARD_THRESHOLD = 0.7` is an opening value. Watch the ratio of `added : updated` in traces. If updates are rare (< 10%), threshold is too strict — near-dupes are being added rather than merged. If updates are very common (> 50%), threshold is too lax — distinct facts are being collapsed.
- The fact-extraction `SYSTEM_PROMPT` lives in `src/consolidation/extractFacts.js`. Treat it as a Phase 9 tunable — benchmarks against LoCoMo vs LongMemEval may need corpus-specific prompt variants. Plumb a `promptVariant` option into `extractFacts` if A/B testing warrants.
- The `{ added, updated, drained }` return from `consolidate` is the natural place to hang consolidation traces. Shape TBD in Phase 9 — consider mirroring the retrieval trace shape (timestamp, batch ids, extractor label, result counts, latency per stage).
- `EXTRACT_MAX_TOKENS = 2048` was a guess. If Phase 9 shows the LLM hitting the cap (response ends in `,` or `"...`), bump. If responses always fit in < 500 tokens, drop to save cost.
- The 12-turn integration test drains 5 of 12 — the real roleplay cadence matters: if sessions are 100+ turns with 2 consolidations of 5 each, we have 90+ Working entries accumulating until idle fires. Watch `runtime.episodicCountSinceLastRebuild` over session histories — if it hits 100 often on realistic transcripts, the Persona rebuild prompt will appear frequently, which may or may not be what Eva wants.

---

## Phase 5—2026-04-20

**What shipped:** Graph store (`src/memory/graph.js`, pure `addEdge`/`removeEdge`/`listEdges` + per-call `buildAdjacency`/`neighborsOf`), pure edge builder (`src/memory/edgeBuilder.js`, explicit `@relations` at weight 1.0 + entity co-occurrence at weight 0.5 via `/\b[A-Z][a-z]{2,}\b/g` with a stop-word filter, cap at 20 with weight-preferring eviction returning `{ newEdges, evicted }`), Tier 3 intent-routed beam search (`src/retrieval/tier3-graph.js`, 2 hops × beam 5, edge-type × intent weights from spec §5.1 table, single bm25-over-corpus pass for lookup), ladder integration replacing the Phase 4 identity stub (Floor branch factored into `runFloorBranch` helper, Tier 3 falls through to Floor when rescore zeros everything), new memory barrel (`src/memory/index.js`), extended retrieval barrel. 7 commits this phase plus plan + retro. **262 tests passing across 26 suites** (210 Phase 0-4 baseline + 52 new Phase 5 tests: 4 constants delta + 16 graph + 17 edgeBuilder + 11 tier3 + 2 memory barrel + 1 retrieval barrel + 3 ladder integration, minus two baseline tests that were covered by new ones).

**Execution mode:** Subagent-driven with reviews skipped per skill criteria (verbatim code + static checks per task). Tasks 1–4 delegated serially; Tasks 0 (constants) and 5 (barrel + retro) done in the controller. Task 4 (ladder) flagged for no-skip-review in the plan; the subagent self-audited invariants via grep and the controller confirmed them post-delegation. Zero sandbox-path strays. Two subagents flagged real issues I'd missed in the plan — saved a round of fixes each.

**Decisions locked in the planning conversation (all held through execution):**

1. Edge weights: explicit `@relations`=1.0, co-occurrence=0.5.
2. Co-occurrence edge type: `mentions`.
3. Beam width B=5 (opening value, Phase 9 tunes).
4. Edge cap per source=20 (spec §12.2 resolution), weight-preferring eviction.
5. Adjacency built per-call, not persisted.
6. Entity matcher: `/\b[A-Z][a-z]{2,}\b/g`, case-sensitive, plus stop-word filter (deviation from plan — see Surprises §1).
7. Tier 3 gating: always fires when Tier 2 has seeds and missed exit. Intent steers edge weights, doesn't gate.
8. Tier 3 trace: `perTier['3']` is Tier-3-specific output, distinct from `perTier['2']`.
9. Tier 3 output cap: `k` from ladder (default 5).
10. `contradicts` edges reserved in `EDGE_TYPE_WEIGHTS` table but never emitted by `buildEdges`.
11. `buildEdges` is pure, returns `{ newEdges, evicted }`; Phase 6 applies inside the write lock.

**Surprises:**

1. **Plan prose and regex disagreed on entity filter.** The plan said "requires ≥3 lowercase chars after capital → filters 'A', 'I', 'The'" but the regex was `{2,}` (≥2 lowercase chars), which lets "The" through (capital T + 2 lowercase = fires). The subagent caught it and resolved with a stop-word filter rather than tightening the regex to `{3,}` (which would drop valid 3-letter names like "Bob"). Correct call — the stop-word list handles the specific noise words without sacrificing short names. Some entries in the stop-word set are redundant (most are <3 chars and never match anyway) but harmless. Phase 9 traces will tell us if the entity pipeline needs NER after all.

2. **Phase 3's scorer zero-BM25 fast-path broke the 2-hop test.** The Tier 3 unit test "respects 2-hop max" seeded entries with content "Bob", "Carol", "Dan" and queried "alice" — BM25 for "alice" against those entries is 0, the scorer's `bm25 === 0 → return 0` fast-path zeroed their final scores, and the zero-filter dropped them before they could demonstrate 2-hop reach. The subagent fixed by adding "Alice" to each entry's content so BM25 is nonzero. This is a test-data bug in my plan, not a code bug, but it reveals something important for Phase 9: **Tier 3 entries are meaningless if they have zero BM25 signal against the query.** The scorer's multiplicative form means graph structure alone cannot surface an entry — BM25 > 0 is required. That's actually a feature (no lexically-disconnected entries surface via graph alone) but worth calling out for the benchmarking harness.

3. **The Floor-factor-out refactor was cheap insurance.** Separating the refactor commit from the Tier 3 wire-in commit meant the diff for each was reviewable in isolation. Subagent nailed both without needing a review round. The `runFloorBranch` helper now serves two call sites (ordinary Floor fall-through AND Tier 3 empty fallthrough), and the `perTier2` optional prefix threads diagnostic data through cleanly — Phase 9's benchmark traces can distinguish "Floor reached because nothing matched" from "Floor reached because Tier 2 had seeds but Tier 3 dropped them."

4. **Task 4's fallthrough-to-Floor test was skipped as planned.** Producing a clean scenario requires either coupling to scorer internals (fragile) or a multi-stage call-counting scorer (brittle). Plan explicitly permitted skipping; the code path is visually obvious and Phase 9 will exercise it on real data.

**Notes for Phase 6 (Consolidation):**

- `buildEdges(entry, allEntries, state) → { newEdges, evicted }` is the contract. Inside the write lock: iterate `newEdges` → `addEdge(state, e)`, iterate `evicted` → `removeEdge(state, e.from, e.to, e.type)`, then `invalidateTier0Cache(state)` once at end of batch.
- The entity matcher is case-sensitive and has a stop-word list. If Phase 9 traces show missed relationships because "alice" in dialogue doesn't match "Alice" in narration, lift case-sensitivity in `extractEntities` at the cost of false positives. Defer until measured.
- Edge cap enforcement happens at `buildEdges` time only. If Phase 6 or later adds edges via a non-`buildEdges` path (e.g., manual UI action in Phase 8), those paths need their own cap check.
- `runFloorBranch`'s `tracePrefix.perTier2` optional field is how Phase 6's consolidation-trace UI can surface "Floor was reached with Tier 2 seeds available" — useful diagnostic.

**Notes for Phase 8 (SillyTavern Integration):**

- Memory Viewer's Graph tab renders `state.graph.edges`. Scales: ~5–20 edges per entry × a few hundred entries = a few thousand edges. Force-directed layout handles that; no pagination needed in v2.0.
- Tier 3 trace's `perTier['3']` exposes the scored beam-search output. Traces tab can render it alongside `perTier['2']` (Tier 2's seeds) to show "what the graph added" — that's the clearest demonstration of Tier 3 earning its keep.
- A Floor trace with `perTier['2']` populated means "we had seeds but couldn't rank them" — good signal for a "tune your τ_confidence" hint.

**Notes for Phase 9 (Benchmarking):**

- λ₁=1.0 / λ₂=0.3 is the spec default. First thing to tune against LoCoMo — these govern how much the graph earns over pure BM25.
- Beam width 5 × 2 hops is an educated guess. If benchmarks show Tier 3 under-expanding (low recall@k), bump to 10. If latency blows, drop to 3.
- Co-occurrence weight 0.5 vs explicit 1.0 is a 2× ratio. If Phase 9 shows explicit-relation corpora outperforming co-occurrence heavily, widen the gap. If both carry similar signal, narrow it.
- Edge cap=20 was a guess from §12.2. Traces will show per-entry edge counts; if the cap is binding on >20% of entries, it's too tight.
- AdaMem ablation claims graph expansion is worth 2.02 F1. If Phase 9 numbers on a matched benchmark show <0.5 F1 lift vs Tier-2-only, something structural is wrong — do NOT tune λ values to paper over a structural bug.
- **Critical:** the scorer's `bm25 === 0` fast-path means Tier 3 entries require some lexical overlap with the query. Graph-only surfacing (zero BM25, edge-only relevance) is structurally impossible under the current multiplicative scorer. If Phase 9 benchmarks demand it, the scorer needs a pluggable additive mode — file that as a v2.1 concern, don't hack it into v2.0.

---

## Phase 4—2026-04-20

**What shipped:** Scorer registry refactor (`src/retrieval/scorer.js`, string-keyed via `registerScorer` / `setScorer(id)` / `getScorerId`), Tier 0 exact cache (`src/retrieval/tier0-exact.js`, FNV-1a hash of trim+lowercase query, `invalidateTier0Cache` hook for Phase 6), Tier 1 Jaccard fuzzy over recent query token sets (`src/retrieval/tier1-fuzzy.js`, θ=0.6 with `>=` comparison), Tier 2 BM25 wrapper with exit condition (`src/retrieval/tier2-bm25.js`, τ_conf=2.0 / τ_gap=0.5, zero-score filter pre-gap), Floor pure fallback (`src/retrieval/floor.js`, recency × (1 + importance/100) × maturity_boost), trace logger (`src/retrieval/trace.js`, 128-cap ring buffer with `scorerId` in trace shape), ladder orchestrator (`src/retrieval/ladder.js`, Tier 3 = identity stub until Phase 5), extended barrel (`src/retrieval/index.js`). 10 commits this phase plus plan + retro. **210 tests passing across 22 suites** (144 Phase 0-3 baseline + 66 new Phase 4 tests: 2 constants delta + 5 scorer registry delta + 14 tier0 + 17 tier1 + 8 tier2 + 7 floor + 5 trace + 9 ladder integration + barrel additions).

**Execution mode:** Subagent-driven, reviews skipped per the skill's criteria (verbatim code + static checks per task), with Task 7 (ladder) flagged for eyeball verification in the controller. Seven delegations: Tasks 1, 2, 3, 6, 7 serial; Tasks 4 + 5 in parallel. Task 0 (constants delta) and Task 8 (barrel + retro) done directly in the controller — too mechanical for a subagent. Zero sandbox-path strays, zero summary confabulations requiring rework. Task 7 ladder landed green first try on all 9 integration tests including the applyAccessEvent-called-once-per-returned invariant; `grep`-based invariant audit in the controller confirmed five branches, five `logTrace`s, five `prependWorking`s, zero accidental double-bumps.

**Decisions locked in the planning conversation (all held through execution):**

1. τ_confidence=2.0, τ_gap=0.5 — opening values. Phase 9 will tune against real BM25 score distributions on LoCoMo/LongMemEval.
2. TRACE_BUFFER_CAP bumped 100 → 128. Spec §12.4 "make configurable" deferred to Phase 8 settings panel; default stays in `constants.js`.
3. Scorer identity via string registry (`registerScorer('id', fn)`, `getScorerId()`), NOT `.name`. Survives minification, re-exports, JSONL roundtrip. Breaking change from Phase 3's `setScorer(fn)` — no external callers existed yet.
4. Tier 0 invalidation: long-term writes only (Phase 6's `consolidate()` calls `invalidateTier0Cache(state)`). Working-buffer appends do NOT invalidate — the prepend runs downstream of the cache.
5. Tier 0 keys: FNV-1a 32-bit of trim+lowercase query, 8-char lowercase hex.
6. Tier 1 candidate source: recent query token sets from `state.tierCaches.fuzzy`, NOT raw entry tokens. Matches spec §5's "near-duplicate queries" wording.
7. Tier 2: zero-scored candidates filtered BEFORE the gap check (so `score===0` never counts as the #2 result).
8. Floor: pure fallback. Runs only when Tiers 0-3 all yield empty scored lists.
9. applyAccessEvent: called at ladder level, once per entry in the final returned list. Never on candidates that were scored but not returned. Verified by the `r.state.entries[id].lifecycle.accessCount` assertion in ladder.test.js.
10. Tier 3 stub: identity passthrough of Tier 2's scored seeds when Tier 2 misses exit condition. Phase 5 replaces with MAGMA-lite beam search.

**Surprises:**

1. **Parallel subagent dispatch worked cleanly for Tasks 4 + 5.** Floor needs a JSDoc type import from tier2-bm25.js, which didn't exist yet in the Floor subagent's view of the worktree. The plan called this out and documented the fallback (inline object type for `@returns`); the Floor subagent took the fallback path. Task 4's subagent landed first, so the fallback wasn't strictly needed, but the guard was cheap insurance. No merge conflicts, no `git add -A` leaks.

2. **Ladder invariant audit via grep was faster than re-reading 235 lines.** `grep -n "applyAccessEventsToReturned\|logTrace\|prependWorking\|recordTier"` showed the exact call-site distribution across the five branches in one pass. Saved a good five minutes of manual tracing and caught zero bugs — the subagent's implementation was correct the first time.

3. **Floor running as pure fallback means Tier 3 stub resolves a LOT of queries right now.** Any query where Tier 2 has BM25 hits but the exit condition (τ_conf=2.0 with default scorer) isn't met falls through to Tier 3, which passes Tier 2's seeds unchanged. On LoCoMo-sized corpora this is probably most queries, because τ_conf=2.0 is a guess. Phase 9 benchmarking will move those thresholds; expect a shift in the tierResolved distribution toward Tier 2 once tuned.

4. **The scorer registry was surprisingly small.** Only ~40 new LOC for `registerScorer` + `setScorer(id)` + `getScorerId` + `_resetScorerForTests` combined. The `.name`-based alternative would have been similar length but lossier across the JSONL roundtrip Phase 8's Traces tab needs. The decision from planning held up cleanly.

**Notes for Phase 5 (Graph + Tier 3):**

- `src/retrieval/ladder.js` has an explicit Tier 3 branch that resolves when `t2.scored.length > 0 && !t2.hit`. Phase 5's real `tier3(state, seeds, queryStr, intent)` slots into that branch — signature `(state, Entry[], string, Intent) → ScoredEntry[]`. The identity stub currently reuses Tier 2's scored list as the output; Phase 5's version should produce reranked results under the spec §5.1 beam-search formula.
- `state.runtime.traces[i].perTier['3']` is currently populated with Tier 2's scored list as a placeholder. Phase 5 should emit its own Tier 3 scored list with different content (beam-search outputs, reranked under the multiplicative formula). The integration test `'Tier 3 stub: when Tier 2 misses exit condition but has results, ladder resolves at Tier 3'` will need a counterpart once Tier 3 is real: "Tier 3 changes ordering vs Tier 2 seeds on a multi-hop query."
- `recordTier0` / `recordTier1` both run on Tier 3 resolutions — same cache layer as Tier 2 hits. Phase 5 doesn't need a separate cache for graph-expanded results; they share the query key.
- If Phase 5 mutates state (it shouldn't — graph building is Phase 6's responsibility), it must also call `invalidateTier0Cache`. Better: keep Phase 5 pure.

**Notes for Phase 6 (Consolidation):**

- `invalidateTier0Cache(state)` is the hook. Call it inside the write lock after any long-term mutation that could change Tier 2's answer: new episodic entry added, edge written, importance/maturity bumped. Exported from `src/retrieval/tier0-exact.js` and re-exported from the barrel.
- Tier 1's fuzzy cache is NOT invalidated on long-term writes. Rationale: fuzzy matches return entry ids, and `tier1()` derefs through `state.entries` at read time — stale ids get silently skipped. If Phase 9 traces show a high skipped-id rate (>~5%), add fuzzy invalidation as well. Defer until measured.
- The scorer registry is module-level global. Phase 8's settings UI should call `registerScorer(id, fn)` on startup for each alternate scorer, then `setScorer(id)` when the user switches in A/B mode. Traces record whichever id is active at call time, so A/B comparisons are a JSONL filter away.

**Notes for Phase 9 (Benchmarking):**

- τ_confidence and τ_gap are the first knobs. Expect substantial movement — the guesses came from the planning conversation, not measurement. BM25+ with SUBJECT_BOOST=TAG_BOOST=2 pushes on-target matches into the 3-8 range on small corpora; τ_conf=2.0 and τ_gap=0.5 are conservative "something obvious happened" values.
- FNV-1a collision rate over a 1000-query session: should be essentially zero at 32 bits with natural-language queries. Worth a smoke test in the eval harness to catch edge cases (e.g. bot-generated query variants that happen to hash-collide).
- Trace shape is JSONL-ready. Memory Viewer Traces tab (Phase 8) exports `state.runtime.traces` as JSONL; Phase 9's harness reads the same JSONL. No format bridge needed.
- The scorer registry supports A/B evaluation natively — `evalAgainstCorpus(corpus, { scorer: 'default' })` vs `{ scorer: 'my-experimental' }` is a one-line switch in the harness.

---

## Phase 3—2026-04-20

**What shipped:** BM25+ index (`src/retrieval/bm25.js`, hand-rolled, subject/tag boost via integer replication), rule-based 3-type classifier (`src/retrieval/classifier.js`, temporal > relational > factual priority), pluggable scorer with context-object signature (`src/retrieval/scorer.js`, deviation from spec §9.2 — see below), unconditional working-buffer prepend (`src/retrieval/workingBuffer.js`, sentinel `score: Infinity`), barrel (`src/retrieval/index.js`). 6 commits this phase plus plan + retro. **144 tests passing across 15 suites** (88 Phase 0-2 baseline + 56 new Phase 3 tests: 9 constants delta + 15 bm25 + 20 classifier + 11 scorer + 7 workingBuffer + 2 barrel).

**Execution mode:** Subagent-driven, review stages skipped, absolute-path + tripwire-hash protocols from the skill. Five delegations ran serially; total wall-clock for implementation ~5 minutes. BM25 (Task 1) was the biggest risk — math could be wrong in ways that only show up at benchmark time. All 15 BM25 tests including the 6 golden-ranking cases passed on first run; the Alice/Bob/Marseille corpus produces sensible orderings.

**Surprises:**

1. **TAG_BOOST chose integer 2, not plan's fractional 1.5.** The plan explicitly called out that "fractional boosts belong at scorer level, not tokenizer level," which implies integer replication at the tokenizer. The plan's own ALGO section also says "Use integer replication for SUBJECT_BOOST/TAG_BOOST—they're weights, not fractions, at this level." So the 1.5 was plan-text inconsistency. Resolved by setting TAG_BOOST=2. If Phase 9 benchmarking shows tag matches outrank subject matches in unhelpful ways, this is the knob to tune — but it needs fractional support first, which means a refactor.

2. **All five subagent tasks passed first try.** Zero regex tweaks in the classifier, zero BM25 ranking debug, zero context-object signature confusion. The "verbatim code in plan + static checks + additive changes" recipe from the skill paid off again. Fourth phase in a row with clean subagent delegation; the pattern is solid.

3. **Scorer signature deviation is now permanent.** `(entry, query, context)` with `context = { now, bm25, intent? }` differs from spec §9.2's `(entry, query, lifecycle)`. Reasons: spec signature had no clock (forcing implicit `new Date()`, non-deterministic) and redundant `lifecycle` (already inside `entry.lifecycle`). Eva flagged the risk before execution, so this was caught at plan time, not later. **Spec needs amendment** — `docs/specs/2026-04-20-starmem-v2-design.md` §9.2 should be updated to match what's shipped, or we carry a persistent "code disagrees with spec" lint against our own docs. Defer to a standalone `docs(spec)` commit when we can spare the context switch.

**Notes for Phase 4 (Retrieval Tiers):**

- Inter-phase contract at the top of `docs/plans/phase-3-retrieval-core.md` is stable and imported-from throughout `src/retrieval/index.js`. Phase 4's ladder orchestrator can `import { buildIndex, query, tokenize, classify, defaultScorer, getScorer, prependWorking } from '../retrieval/index.js'`.
- `applyAccessEvent` (lifecycle) is still NOT wired. Phase 4's ladder should call it only for entries actually returned to the user, not every candidate scored. This is a behavior decision, not a code one.
- `runtime.traces` ring buffer is Phase 4 territory. The trace shape in spec §9.1 includes the active scorer's identity — when `setScorer` is non-default, traces need a label. Consider adding an optional `.name` property to Scorer functions, or a registry, before traces start recording.
- Tier 1 Jaccard reuses `tokenize` from `bm25.js` — already exported. Good.
- Tier 0 cache is keyed on query hash; normalize the query (trim + lowercase) before hashing to avoid trivial misses. The classifier can stay case-sensitive because its patterns use `/i` flag.
- Tier 2's "exit condition" is `top score ≥ τ_confidence AND gap ≥ τ_gap`. These thresholds aren't in `constants.js` yet — Phase 4 task 0 should add them as sub-commit before the ladder lands.
- Multiplicative scorer can produce a zero score when any factor is zero. The workingBuffer prepend bypasses this via `Infinity`, but Phase 4 should decide how to handle Tier 2 results with `score === 0` — probably exclude them from the Floor fallback (they'd sort below useful results anyway).

---

## Phase 2—2026-04-20

**What shipped:** `src/lifecycle/recency.js` (`recencyAt` + `MS_PER_DAY`), `src/lifecycle/importance.js` (`applyAccessEvent`/`applyUpdateEvent`/`applyDailyDecay`—all pure, all clamped), `src/lifecycle/maturity.js` (`maturityFor` with hysteresis + single-step transitions, `maturityBoost`), `src/lifecycle/index.js` (barrel re-export for Phase 3 consumers). 4 commits. **88 tests passing across 10 suites** (46 Phase 0+1 baseline + 42 new Phase 2 tests). Lint, typecheck, test all green.

**Execution mode:** Subagent-driven-development with review stages skipped per the skill's criteria (verbatim code in plan + static checks per task + additive changes). 4 delegated tasks ran serially; each subagent completed in 60-90s. Phase 1's `~` trap fully mitigated by embedding the absolute repo path in every subagent context and requiring a `git log -1` target-verification step before work. v1 at `/home/opus/SillyTavern/...` was untouched across the entire phase.

**Surprises:**

1. **Subagent narration can be misleading without changing outcomes.** The Task 3 subagent reported its work as "already complete in a previous session" and cited the commit hash it had itself just produced. Investigation: the subagent did run the full TDD flow, wrote the files, committed, and then when looking at `git log` to report the hash interpreted the fresh entry as pre-existing. Work was real and correct (verified by controller). Lesson: subagent summary prose is unreliable—**always verify by running `git log -1` and `npm run test` in the controller** after each delegation, and don't trust "already done" claims without checking.

2. **Test counts in the plan can drift from reality.** Phase 2 plan said 18 importance tests; actual was 19. Not a correctness issue (tests still pin all spec §7 formulas), just off-by-one on the mental count. For future plans: let the actual number emerge; don't bake predicted totals into task instructions.

3. **Absolute paths are sufficient mitigation for the `~` trap.** Every Task 1-4 context had `ABSOLUTE REPO PATH: /home/opus/.hermes/...` as the first line plus an explicit "verify with `git log -1` showing <expected hash>" step. No subagent strayed into v1. The verification hash acts as a tripwire: if the subagent saw a different commit, it would know immediately. Pattern worth codifying as a skill patch.

**Notes for Phase 3 (Retrieval Core):**

- BM25 index lives in `src/retrieval/bm25.js`—hand-roll per spec §4 "runtime dependency policy," no vendored libraries yet. Reference: the BM25+ formula with `k1=1.2, b=0.75` (standard defaults).
- The multiplicative score from spec §5.2 composes `bm25 × (1 + importance/100) × recency × maturity_boost`—all four factors are now available via `src/lifecycle/index.js` plus the forthcoming BM25 function.
- Pluggable scorer (spec §9.2): a module-level `let currentScorer = defaultScorer; export function setScorer(fn)` pattern mirrors Phase 1's backend injection. Test-only `_resetScorerForTests` escape hatch.
- Classifier is rule-based, not LLM—spec §5 is explicit. Keyword/regex heuristics over three intents (factual, relational, temporal). Test 15 fixture queries per the roadmap (5 per intent).
- `applyAccessEvent` is called from the retrieval hot path when an entry is surfaced (spec §7). Phase 3 needs to decide *where* that call happens: at the scorer level (every candidate scored) or the ladder level (only entries actually returned). The latter is correct—we don't want scoring to inflate importance on everything we consider.
- Fresh-fixture typedef pattern worked well in Phase 2; Phase 3 tests should continue annotating: `/** @type {import('../../src/core/schema.js').Entry} */` on test Entry objects to avoid the literal-widening issue from Phase 1 surprise #2.

---

## Phase 1—2026-04-20

**What shipped:** `src/core/schema.js` (typedefs + enum guards + `createEmptyState`), `src/memory/entry.js` (`createEntry`/`generateEntryId`/`isValidEntry`—total validator), `src/core/lock.js` (per-chat async mutex, promise-chain implementation), `src/core/state.js` (injectable backend, loose state shape check, deep-clone round-trip), and an integration round-trip test that also includes a control demonstration of the lock-free hazard. 5 commits this phase (plus the plan doc). 46 tests passing across 7 suites. Lint, typecheck, test all green.

**Surprises:**

1. **Subagent `~` trap.** Dispatched Task 1 via `delegate_task` expecting `cd ~/SillyTavern/...` to hit Eva's profile sandbox (`/home/opus/.hermes/profiles/hanami/home/...`). It didn't—subagent shells resolve `~` to the real `/home/opus`, so the subagent modified v1 at `/home/opus/SillyTavern/...` instead. Aborted, reverted v1, and switched to controller-executed tasks for the rest of Phase 1. **For Phase 2+:** if subagents are used, always pass absolute paths and never rely on `~` or relative home resolution. Verify post-delegation with `git log -1` on the intended target.

2. **Test fixtures need explicit `@type` for literal-narrowing.** The entry tests' `baseFields` object with `scope: 'episodic'` was widened to `string` by tsc, which then rejected subsequent `createEntry({ ...baseFields })` calls because `Scope` is a union of three literals. Fix: annotate the fixture with `/** @type {Parameters<typeof createEntry>[0]} */`. Phase 2+ lifecycle tests will likely hit the same pattern with `Maturity`.

3. **Destructure-for-delete pattern doesn't satisfy eslint+tsc together.** Tried `const { provenance: _p, ...rest } = baseFields` in the "rejects missing provenance" test. eslint flagged `_p` as unused despite the underscore prefix (the flat config's `no-unused-vars` has `argsIgnorePattern: '^_'` but not `varsIgnorePattern`). Switched to mutating `delete` on a shallow copy. Worth adding `varsIgnorePattern: '^_'` to the eslint rule in Phase 2 if this pattern recurs.

4. **ST has two metadata APIs; extensions must use the camelCase one.** Initial `state.js` read `globalThis.chat_metadata` directly, banking on ST's module binding (`export let chat_metadata = {}` in `public/script.js`) leaking onto the window. Eva caught this at Phase 1 close. The canonical extension surface is `SillyTavern.getContext()`, which returns `{ chatMetadata, saveMetadataDebounced, ... }` — see `public/scripts/st-context.js` lines 132-133 for the mapping. Direct globals are fragile and not ST's documented API. Fixed in commit `50b8e72`: resolve `getContext()` on every read/write (ST swaps `chatMetadata` on chat switch), and `write()` throws a descriptive error when context is absent so Phase 8 integration bugs fail loud instead of persisting to a dangling global. **For Phase 8:** when wiring the ST integration, confirm `SillyTavern.getContext()` is available at APP_READY, not earlier.

**Notes for Phase 2 (Lifecycle):**

- Lifecycle math lives in `src/lifecycle/*.js`—pure functions, no state mutation. Import types from `core/schema.js` (already has `Lifecycle` and `Maturity` typedefs).
- The hysteresis test is the important one: oscillate importance 60→70→60 and verify maturity stays `validated`. Golden-value tests are the easiest way to pin formulas; the roadmap lists the expected value `importance=50 → 7 accesses → 71`.
- If lifecycle tests use a fixture Lifecycle object, annotate it with `/** @type {import('../../src/core/schema.js').Lifecycle} */` from the start to avoid the widening issue from surprise #2.
- `withWriteLock` exists but is not imported by lifecycle—lifecycle is pure. The lock is caller's responsibility at mutation sites (consolidation in Phase 6).
- The `_resetLocksForTests` and `_resetBackendForTests` escape hatches are the model: test-only exports get a leading underscore and a comment explaining they're not production code.

## Phase 0—2026-04-20

**What shipped:** dev toolchain (eslint 9 flat config, jest ESM, tsc JSDoc mode), empty `src/` tree per spec §10, `constants.js` with 8 golden-value tests, structured logger with 5 tests (injectable console, debug gate, scoped children), `index.js` wired to logger. 9 commits. 13 tests passing. Lint, typecheck, test all green.

**Surprises:**

1. **The plan's Tasks 2-4 verification steps were wrong.** They ask you to run `npm run lint|typecheck|test` immediately after writing each config, on an empty `src/` tree. All three tools exit *non-zero* on "no files matched" — eslint 9 errors loudly, tsc emits TS18003, jest reports 0 matches. The real first green-check is after Task 6 lands `constants.js` + its test. Plan has been demoted to "verify at Task 6, not earlier" for Phase 1's equivalent.

2. **`@types/jest` was missing from the plan's devDependencies.** Without it, `tsc --noEmit` fails on the test file with TS2304/TS2582 on `expect`/`test` globals. Added it during Task 6. Phase 1+ plans should list `@types/jest` alongside the other dev tooling up front.

3. **No logger-scope accumulation test** was in the plan but would be worth adding (calling `.scope('a').scope('b')` should produce `[STARmem:a:b]`). The implementation supports it (recursive `makeLogger`), but it's untested.

**Notes for Phase 1:**

- Storage layer will need a mock for ST's `chatMetadata` and `saveMetadataDebounced` — design those test fixtures early.
- The write lock from §2 principle 2 is a real concurrency primitive, not just a flag — unit test should assert that a second `withWriteLock` call genuinely waits (use `jest.useFakeTimers()` + promise microtask drain, or a real async barrier).
- Consider adding a `scope-accumulation` test to the logger suite before Phase 1 starts. It's a 4-line addition.
- Plan's verification steps should always check the state *after* the code exists, never on an empty tree.
