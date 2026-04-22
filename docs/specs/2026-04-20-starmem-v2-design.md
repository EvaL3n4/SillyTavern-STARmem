# STARmem v2—Design Specification

**Status:** Approved (brainstorm phase complete)
**Date:** 2026-04-20
**Author:** Eva (design) + Hanami (synthesis)
**Supersedes:** `SillyTavern-STARmem` v1 (private beta)

---

## 1. Context

STARmem v1 (~40K LOC) implemented a hybrid Memory-Augmented Generation system for SillyTavern based on the AdaMem paper's 4-memory architecture with an ad-hoc 3-tier retrieval router. In private beta the retrieval path grew three overlapping implementations (RetrievalRouter, UnifiedRetrieval fallback, direct memory-retrieval bypass) and the async consolidation pipeline sprawled beyond its original spec as latency anxiety drove "just add another event hook" reactions. The architecture still works but does not justify its weight.

**STARmem v2 is a clean-break rewrite** informed by ByteRover (arXiv:2604.01599), retaining AdaMem's conceptual vocabulary where it earns its keep, borrowing MAGMA (arXiv:2601.03236) for graph-expansion retrieval, and saving Enhanced RAPTOR (Liu et al. 2026) for offline Persona distillation only. Retrieval is **deterministic at query time**—no LLM-in-the-loop. LLM calls happen only during write-path fact extraction and offline Persona rebuild.

---

## 2. Principles

1. **Deterministic retrieval, always.** No LLM call on the query path. Extraction and Persona rebuild are the only LLM touchpoints; both run off the hot path.
2. **One path per responsibility.** One extraction function, one consolidation function, one retrieval ladder, one write lock. Many readers, single mutator.
3. **Honest instrumentation.** Every retrieval produces a replayable trace `(query, classifier output, per-tier results, final scores)`. Benchmarks are a first-class v2.0 subsystem, not a v2.1 addition.

---

## 3. Storage Substrate

Single JSON tree serialized to `chatMetadata['STARmem']`. Rides SillyTavern's native chat-file backup and sync—no sidecar files, no filesystem writes, no external indices.

### 3.1 Entry Schema

One shape covers all three scopes (Working / Episodic / Persona).

```json
{
  "id": "ep_2026-04-20T14:12:33_a3f",
  "scope": "working | episodic | persona",
  "content": "Alice grew up in Marseille and moved to Paris at 18.",
  "subject": "alice",
  "tags": ["location", "hometown", "backstory"],
  "relations": [
    {"type": "mentions", "target": "ep_2026-04-18_11a"},
    {"type": "same_topic", "target": "ep_2026-04-19_02c"}
  ],
  "lifecycle": {
    "importance": 50.0,
    "maturity": "draft",
    "createdAt": "2026-04-20T14:12:33Z",
    "updatedAt": "2026-04-20T14:12:33Z",
    "accessCount": 0,
    "updateCount": 0
  },
  "provenance": {
    "sourceMessages": [42, 43, 44],
    "extractor": "gemma-4-31b@consolidation-v1"
  }
}
```

### 3.2 Top-Level State

```json
{
  "entries": { "<id>": { /* entry */ } },
  "workingBuffer": ["<id>", "<id>"],
  "graph": {
    "edges": [
      { "from": "<id>", "to": "<id>", "type": "mentions", "weight": 0.75 }
    ]
  },
  "tierCaches": {
    "exact": { "<queryHash>": ["<id>"] },
    "fuzzy": { "<queryTokenSet>": ["<id>"] }
  },
  "runtime": {
    "lastConsolidation": "2026-04-20T14:12:33Z",
    "pendingPersonaRebuild": false,
    "traces": [ /* ring buffer, cap 100 */ ]
  }
}
```

`entries` is a flat map keyed by `id`. The "tree" shape is derived when needed. `tierCaches` is invalidated on any write. Edges are a flat list; the BM25 index and adjacency lists are rebuilt in memory on chat load.

---

## 4. Memory Scopes

Three scopes, not four. **Graph is infrastructure, not a memory.**

| Scope     | Write trigger                              | Eviction                          | Purpose                                       |
| --------- | ------------------------------------------ | --------------------------------- | --------------------------------------------- |
| Working   | Every turn                                 | Drained by consolidation          | Hot buffer; last-N turns appended to retrieval unconditionally |
| Episodic  | Working→Episodic consolidation (batched)   | Lifecycle decay + explicit delete | Long-term store; 95% of entries live here     |
| Persona   | Episodic→Persona consolidation (explicit)  | Replaced atomically by rebuild    | Distilled character/user sheets, Enhanced-RAPTOR-built |

**Graph** lives alongside entries. Edges are created at write time from two sources: (a) explicit `@relations` in extracted entries, (b) rule-based entity co-occurrence (capitalized-word matching; optional lightweight NER in v2.1). Edges are typed: `mentions | supports | same_topic | temporal_next`. Graph is queried only during Tier 3 expansion; it is not user-facing as a scope.

*Note:* `contradicts` edges are reserved in the schema but not produced in v2.0 (drift detection is deferred; see §11). Tier 3's edge-weight table (§5.1) lists `contradicts` to document the intended penalty when the edge type becomes active.

---

## 5. Retrieval Ladder

Four deterministic tiers plus a floor. Working buffer is prepended to every result unconditionally—it is not a tier.

| Tier  | Mechanism                                           | Exit condition                              | Latency |
| ----- | --------------------------------------------------- | ------------------------------------------- | ------- |
| 0     | Exact query hash in `tierCaches.exact`              | Hit → return                                | <1ms    |
| 1     | Jaccard fuzzy (θ = 0.6) over recent queries         | Hit → return                                | <5ms    |
| 2     | BM25 over all entries                               | Top score ≥ τ_confidence AND gap ≥ τ_gap    | <50ms   |
| 3     | Intent-routed graph expansion from Tier 2 seeds     | Always returns (final tier)                 | <100ms  |
| Floor | Top-K by `recency × importance × maturity_boost`    | Always (never fails)                        | <5ms    |

> **Tuning amendment (9.4.8, 2026-04-22):** `τ_gap` default is **10** (was 0.5 in the opening spec). LoCoMo sweeps showed the knob effectively acts as a boolean: gap ≤ ~5 engages the Tier 2 shortcut (MRR 0.73–0.77), gap ≥ 10 disables it and every query falls through to Tier 3 (MRR plateau at 0.8077 through gap=1000). The current default disables the shortcut, which is net-positive on this corpus — graph expansion contributes +0.0794 MRR when allowed to run. `τ_confidence` stayed at 2.0 (inert on LoCoMo across 0.5–5.0). Full sweep data in `docs/bench/sweeps/2026-04-22-tau.md`; see `docs/plans/phase-9-4-8-retro.md` for the journey. Phase 11 may remove the τ comparison entirely as part of ladder simplification.

**Query classifier:** 3-type—`factual | relational | temporal`. Rule-based, not LLM-based. Decides (a) whether Tier 3 fires at all for this query, and (b) which edge-type weights to use on graph expansion.

### 5.1 Tier 3 Detail (MAGMA-lite)

Seeds: top-K entries from Tier 2 (typically K=3).

Beam search, 1–2 hops, scoring:

```
S(neighbor | seed, query) = exp(λ₁ · edge_type_match(type) + λ₂ · BM25(neighbor, query))
```

Defaults: `λ₁ = 1.0`, `λ₂ = 0.3`. (Subject to benchmark tuning.)

Edge-type match weights per query intent:

| Edge type      | factual | relational | temporal |
| -------------- | ------- | ---------- | -------- |
| `supports`     | 0.9     | 0.5        | 0.3      |
| `mentions`     | 0.7     | 0.9        | 0.3      |
| `same_topic`   | 0.5     | 0.8        | 0.5      |
| `temporal_next`| 0.3     | 0.4        | 0.9      |
| `contradicts`  | 0.2     | 0.3        | 0.2      |

Results are merged with Tier 2 seeds, deduped, rescored under the multiplicative formula (§5.2), top-K returned.

### 5.2 Retrieval Score (Multiplicative)

```
score(entry, query) = BM25(entry, query)
                    × (1 + importance / 100)
                    × recency
                    × maturity_boost
```

Multiplicative choice is intentional: pure-recency noise should not outrank pure-relevance hits. A stale entry with high BM25 still ranks—just suppressed by low recency. An irrelevant entry with high importance does not surface because BM25 near zero dominates.

Subject to A/B benchmarking; the scorer is pluggable (§9).

---

## 6. Write Path

### 6.1 Fact Extraction

Single function: `extractFacts(batch, context) → Entry[]`

- Called **only** during consolidation. Never on the hot path.
- Routes through SillyTavern's configured connection profile—user picks their model via native ST UI.
- **Recommended (documented default):** Gemma 4 31B for quality, Gemma 4 26B A4B for speed. Users may configure any model ST supports.
- Output is JSON-schema-constrained (`entries: Entry[]`).
- No Child/Tertiary distinction in v2—one extraction model, user-configured.

### 6.2 Consolidation Trigger

`maybeConsolidate()` fires when either:

- Working buffer size ≥ 10 entries, OR
- User idle ≥ 60s with non-empty Working buffer

Both thresholds configurable. In-flight lock ensures at most one consolidation runs concurrently. Debounced.

### 6.3 Consolidation Pipeline

```
consolidate():
    acquire write_lock
    batch = workingBuffer[0 : r]  # r = 5
    entries = extractFacts(batch, context)
    for entry in entries:
        if duplicate_subject_and_similar_content(entry):
            UPDATE existing (importance += 5, updateCount += 1)
        else:
            ADD entry
            build_edges(entry)  # from @relations + entity co-occurrence
    workingBuffer.splice(0, r)
    entries.forEach(e => e.scope = "episodic")
    persist(chatMetadata)
    maybeSuggestPersonaRebuild()  # sets flag, does not run
    release write_lock
```

`consolidate()` is the **only** function that mutates long-term storage. All other code reads. Violations of this rule are spec violations.

### 6.4 Persona Rebuild

**Always explicit**, never automatic. The `runtime.pendingPersonaRebuild` flag flips true after N = 100 new Episodic entries. User sees a "Persona rebuild available" indicator in Memory Viewer; clicks to run.

Rebuild pipeline: Enhanced RAPTOR over all Episodic entries for a given subject.
- Semantic chunking (τ = 0.7 cosine distance)
- Leiden community detection on k-NN graph (k_base=15, k_step=5; γ_base=1.0, γ_step=0.2)
- LLM summarization per cluster (user's configured model)
- Resulting summary nodes replace old Persona entries atomically for that subject

Expensive; runs for seconds to minutes depending on Episodic size. Progress surfaced in the consolidation indicator.

---

## 7. Lifecycle (AKL-lite)

Pure ByteRover math. Multiplicative score (§5.2). Nothing more.

**Event effects:**
- Access: `importance += 3`
- Update: `importance += 5`
- Daily decay (background): `importance *= 0.995` (≈0.5% daily)

**Maturity tiers** (hysteresis gaps preserved):

| Transition           | Promote when | Demote when  |
| -------------------- | ------------ | ------------ |
| draft → validated    | ι ≥ 65       | ι < 35       |
| validated → core     | ι ≥ 85       | ι < 60       |

`maturity_boost`: `{draft: 0.85, validated: 1.0, core: 1.2}`

**Recency decay:** `recency = exp(−Δt_days / τ)`, τ = 30 days (half-life ≈ 21 days).

**Explicitly not in v2.0:**
- Drift detection (contradiction flagging)—deferred to v2.x if benchmarks or user reports demand it
- Influence propagation at retrieval time—Tier 3 already does this correctly with intent routing
- Four-type consolidation triggers—collapsed to the single size-or-idle rule above

---

## 8. SillyTavern Integration Surface

| Component                | v2.0 | Notes                                             |
| ------------------------ | ---- | ------------------------------------------------- |
| Settings UI              | Yes  | ST-native extension settings panel                |
| Consolidation indicator  | Yes  | Subtle dot in sidebar, tooltip with batch count   |
| Memory Viewer            | Yes  | Tabs: Working / Episodic / Persona / Graph / Traces |
| Setup Wizard             | No   | Cut—good first-run UX but not core              |
| Health Checks            | No   | Cut—devtools / traces tab suffices              |
| Debug Console            | No   | Cut—browser devtools serves this                |

The **Traces tab** in Memory Viewer is the benchmarking surface: last 100 retrieval traces, each showing resolved tier, intermediate scores, final ranked list, and (optionally) what was injected into the prompt. JSONL export supported.

---

## 9. Benchmarking Hooks

First-class subsystem. Three components:

### 9.1 Trace Logger

Every retrieval writes a trace to the `runtime.traces` ring buffer (cap 100):

```json
{
  "timestamp": "ISO",
  "query": "…",
  "classifier": "factual | relational | temporal",
  "tierResolved": 2,
  "perTier": {
    "2": [{"id": "…", "bm25": 0.82, "score": 1.14}, ...],
    "3": null
  },
  "finalRanking": ["<id>", "<id>"],
  "injectedFragment": "…"
}
```

Exportable as JSONL from the Memory Viewer Traces tab.

### 9.2 Pluggable Scorer

The retrieval score function is a pluggable interface:

```typescript
type Scorer = (entry: Entry, query: Query, lifecycle: Lifecycle) => number;
```

Default: multiplicative (§5.2). Alternates can be registered and swapped via settings for A/B comparison. Each trace records which scorer was active.

### 9.3 Eval Harness Hook

Function stub in v2.0:

```typescript
evalAgainstCorpus(
  corpus: { query: string, goldIds: string[] }[],
  options?: { scorer?: Scorer, kMax?: number }
): { precisionAtK: number[], recallAtK: number[], mrr: number }
```

Shape only in v2.0. Full implementation against LoCoMo/LongMemEval-shaped data in v2.1.

---

## 10. Repository Structure

Target path: `~/SillyTavern/public/scripts/extensions/third-party/STARmem/`

```
STARmem/
├── manifest.json
├── index.js                    # ST hooks, interceptor, entry point
├── package.json
├── tsconfig.json
├── eslint.config.js
├── style.css
├── LICENSE
├── README.md                   # architecture summary + full paper citations
├── src/
│   ├── core/                   # state, schema, persistence, write lock
│   ├── retrieval/              # 4-tier ladder, 3-type classifier, scorer
│   ├── memory/                 # working, episodic, persona operations, graph ops
│   ├── lifecycle/              # akl-lite: importance, maturity, recency, decay
│   ├── consolidation/          # extractFacts, consolidate, persona-rebuild
│   └── integration/            # settings UI, memory viewer, indicator, event wiring
│       ├── viewer/             # viewer modal + per-tab renderers (Phase 8)
│       └── index.js            # integration barrel (Phase 8)
├── bench/                      # benchmarking harness — development-only, non-runtime
│   ├── loaders/                # corpus loaders (LoCoMo, synthetic)
│   ├── metrics/                # retrieval metrics (precision@k, recall@k, MRR)
│   ├── sweeps/                 # per-knob coordinate-descent drivers
│   ├── baselines/              # naive BM25, recency, random
│   └── runner.js               # orchestrator
├── docs/
│   ├── specs/
│   │   └── 2026-04-20-starmem-v2-design.md   # this file
│   ├── bench/                  # measured values + per-sweep writeups (Phase 9)
│   └── wiki/
│       ├── byterover.md        # primary substrate inspiration
│       ├── adamem.md           # origin of the Working/Episodic/Persona vocabulary
│       ├── magma.md            # Tier 3 design source
│       ├── raptor.md           # original + Enhanced RAPTOR (Persona rebuild)
│       ├── a-mem.md            # evaluated, not adopted
│       └── zep.md              # evaluated, too heavy
└── tests/
    ├── unit/
    └── integration/            # ST mock + trace assertions
```

**Layout deviations from the original draft:**

- Phase 8 added `src/integration/viewer/` (viewer modal + per-tab renderers) and `src/integration/index.js` (integration barrel). Originally this section listed a flat `src/integration/`. The sub-directory is load-bearing: the viewer has five tabs, each ~100-200 LOC, and grouping them keeps the directory listing legible.
- Phase 9 moved the `src/eval/` placeholder out to a top-level `bench/` directory. Rationale: the harness is development-only (no SillyTavern runtime code references `bench/`), and grouping it with `docs/bench/` keeps both evaluation artifacts visually adjacent in a file tree.

### 10.1 README Sources Block (mandatory)

Cited papers, first-class in README:

- **ByteRover**—Nguyen et al. 2026, arXiv:2604.01599 (substrate design)
- **AdaMem**—Yan et al. 2026, arXiv:2603.16496 (memory-scope vocabulary)
- **MAGMA**—Jiang et al. 2026, arXiv:2601.03236 (Tier 3 graph expansion)
- **Enhanced RAPTOR**—Liu et al. 2026, DOI 10.3389/fcomp.2025.1710121 (Persona rebuild)
- **RAPTOR**—Sarthi et al. 2024, arXiv:2401.18059 (original)
- **A-MEM**—Xu et al. 2025, arXiv:2502.12110 (evaluated, not adopted)
- **Zep**—Rasmussen et al. 2025, arXiv:2501.13956 (evaluated, too heavy)

---

## 11. Out of Scope

- **Drift detection** (contradiction flagging)—v2.x
- **Influence propagation** at retrieval time—subsumed by Tier 3
- **Multi-agent research loop** (AdaMem's Research Agent)—incompatible with deterministic principle
- **Embeddings / vector search**—deterministic only; BM25 + typed graphs throughout
- **Migration from v1**—clean break, no tooling (v1 was private beta)
- **Lightweight NER** for entity extraction—capitalized-word matching suffices in v2.0, NER in v2.1 if precision demands it

---

## 12. Open Questions

1. **BM25 index rebuild cost.** Rebuilt in memory on chat load. Need to measure at 1K / 10K entry sizes; if unacceptable, cache the index in a separate ephemeral store (not `chatMetadata`, since it's derived).
2. **Graph edge bloat.** Entity co-occurrence can create O(n²) edges for chatty entries. Cap edges per entry at 20, prefer recent and higher-weight edges. Evaluate after v2.0 usage data.
3. **Consolidation indicator visual.** Needs a concrete mock; deferred to implementation.
4. **Traces ring buffer size.** 100 may be too small for a benchmarking session, too large for normal use. Make configurable.

These are open but not blockers—they can be resolved during implementation.
