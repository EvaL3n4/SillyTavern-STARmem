# ByteRover

**Citation:** Nguyen Anh Duy, 2026, arXiv:2604.01599  
**Paper URL:** https://arxiv.org/abs/2604.01599

## Summary

ByteRover inverts the conventional Memory-Augmented Generation (MAG) paradigm by making the LLM agent itself the curator of its knowledge store. Instead of delegating memory to an external pipeline (chunk → embed → index → retrieve), ByteRover gives the agent first-class `ADD`, `UPDATE`, `MERGE`, `DELETE`, and `UPSERT` tools that operate on a file-based **Context Tree**—a hierarchical knowledge graph stored as human-readable markdown files organized as Domain > Topic > Subtopic > Entry.

Every entry carries explicit relations, provenance metadata, and an **Adaptive Knowledge Lifecycle (AKL)** governed by importance scoring, maturity tiers, and recency decay. Retrieval follows a 5-tier progressive strategy that resolves the vast majority of queries at sub-100 ms latency without any LLM call, escalating to agentic reasoning only for genuinely novel or underspecified questions. The result is SOTA accuracy on LoCoMo (96.1%) and competitive LongMemEval performance—all with zero vector database, zero graph database, and zero embedding service.

## Key Ideas

- **Agent-native memory**—memory operations are tools in the agent's reasoning loop, not API calls to external services. The LLM that reasons about a task also curates its knowledge.
- **Context Tree**—a file-based hierarchical knowledge graph (Domain → Topic → Subtopic → Entry) with explicit `@relation` cross-references between entries. Each node is a markdown file with structured frontmatter.
- **Five atomic curate operations**—`ADD`, `UPDATE`, `UPSERT`, `MERGE`, `DELETE`. Each returns per-operation status (success/failure + message), enabling the agent to detect and adapt to failures.
- **Stateful feedback loop**—unlike opaque embedding pipelines, ByteRover returns structured operation results. Agents see which memories were created, updated, merged, or failed, and can reason about gaps.
- **Adaptive Knowledge Lifecycle (AKL)**—every entry carries an importance score ι ∈ [0, 100], maturity tier (`draft → validated → core`), and recency decay r = exp(−Δt/τ) with τ = 30 days. Access events add +3 to importance, updates add +5, daily decay multiplies by 0.995. Maturity transitions use hysteresis gaps (promote validated at ι ≥ 65, demote at ι < 35).
- **5-tier progressive retrieval**—Tier 0 (exact cache), Tier 1 (fuzzy Jaccard cache), Tier 2 (direct BM25), Tier 3 (LLM reasoning for underspecified queries), Tier 4 (full agent reasoning). Most queries exit before Tier 3.
- **Compound retrieval score**—Score(nᵢ, q) = wᵣ·BM25 + wᵢ·î + wₜ·r, balancing lexical relevance, learned importance, and recency.
- **Crash safety via atomic write**—write-to-temp-then-rename pattern ensures the Context Tree remains consistent even if the process crashes mid-write.
- **Pre-compaction pipeline**—three-level compression (LLL summarization → aggressive summarization → deterministic binary-search prefix truncation) guarantees convergence to a fixed token budget.
- **Zero external infrastructure**—everything runs on local files with BM25 (MiniSearch). No vector DBs, no embedding services, no graph databases.

## STARmem v2 Adaptation

ByteRover is the **primary substrate inspiration** for STARmem v2 (§1). The design inherits ByteRover's core philosophy of deterministic, infrastructure-free memory, but adapts it to SillyTavern's constraints and v2's scope discipline.

### What we adopt

| ByteRover concept | STARmem v2 mapping |
|---|---|
| **AKL** (importance scoring, maturity tiers, recency decay) | **§7 Lifecycle (AKL-lite).** ByteRover's exact math: +3 per access, +5 per update, daily decay ×0.995, maturity transitions at 65/35 (draft↔validated) and 85/60 (validated↔core), recency r = exp(−Δt/30). All preserved verbatim. |
| **BM25-based retrieval** | **§5 Retrieval Ladder, Tier 2.** We use BM25 rebuilt in memory on chat load (MiniSearch equivalent). No vector embeddings. |
| **Tiered retrieval with early exit** | **§5 Retrieval Ladder.** We adopt the 4-tier pattern (Tier 0 exact cache → Tier 1 fuzzy Jaccard → Tier 2 BM25 → Tier 3 graph expansion), dropping ByteRover's Tier 4 (full LLM reasoning). |
| **Tier 0 exact cache** | **§5, `tierCaches.exact`.** Query hash lookup in `chatMetadata`. |
| **Tier 1 fuzzy cache** | **§5, `tierCaches.fuzzy`.** Jaccard similarity over recent query token sets (θ = 0.6). |
| **Compound score balancing BM25, importance, recency** | **§5.2 Retrieval Score (Multiplicative).** We diverge from ByteRover's additive formula (`wᵣ·BM25 + wᵢ·î + wₜ·r`) in favor of a multiplicative model: `BM25 × (1 + importance/100) × recency × maturity_boost`. The multiplicative choice ensures that pure-recency noise cannot outrank pure-relevance hits, and irrelevant high-importance entries are suppressed when BM25 ≈ 0. |
| **Write-time statefulness** | **§6.3 Consolidation Pipeline.** We adopt ByteRover's philosophy of explicit per-entry status, but fold it into a single `consolidate()` function with a write lock rather than a five-tool API. |
| **Crash safety** | **§3 Storage Substrate.** We inherit ByteRover's atomic-write principle—all mutations go through `consolidate()` which holds a write lock and persists atomically to `chatMetadata`. |

### What we reject or modify

| ByteRover concept | STARmem v2 decision |
|---|---|
| **5-tier retrieval with LLM escalation** | **Rejected (§5, §2 Principle 1).** ByteRover's Tier 3/4 escalate to LLM reasoning for novel questions. v2 enforces *deterministic retrieval always*—no LLM calls on the query path. We cap at Tier 3 (graph expansion) with a Floor fallback, all rule-based. |
| **Context Tree (4-level hierarchy)** | **Collapsed to flat entry map (§3.1).** ByteRover's Domain → Topic → Subtopic → Entry hierarchy is overkill for a single-chat memory system. v2 uses a flat `entries` map; topical grouping is handled by `tags` and `subject` fields, with the graph providing relational structure. |
| **File-based storage** | **Adapted to `chatMetadata` (§3).** ByteRover stores markdown files on disk. v2 serializes to SillyTavern's `chatMetadata['STARmem']`—a single JSON tree that rides ST's native chat backup and sync. No sidecar files, no filesystem writes. |
| **Pre-compaction pipeline (3-level)** | **Deferred.** ByteRover's summarization → aggressive summarization → truncation pipeline is useful but not core to v2.0. If memory bloat becomes an issue, this is a candidate for v2.1. |
| **Five-tool curation API** | **Simplified to single consolidation function (§6.3).** ByteRover exposes `ADD/UPDATE/UPSERT/MERGE/DELETE` as separate agent tools. v2 routes everything through `extractFacts()` → `consolidate()`, which internally performs deduplication (ADD vs UPDATE) and creates new entries. No explicit MERGE or DELETE in v2.0. |
| **Multi-agent coordination context** | **Rejected.** ByteRover's focus on cross-agent provenance and coordination doesn't map to single-user roleplay chats. We keep per-entry provenance (`sourceMessages`, `extractor`) but drop the multi-agent aspects. |
| **Additive scoring formula** | **Replaced with multiplicative (§5.2).** See compound score entry above. |

### How it maps to the v2 spec

ByteRover's DNA runs through four sections of the spec:

- **§5 Retrieval Ladder**—Tier 0/1/2 are ByteRover's first three tiers, adapted for in-memory JSON storage.
- **§5.2 Retrieval Score**—ByteRover's compound score, but multiplicative instead of additive.
- **§7 Lifecycle (AKL-lite)**—ByteRover's AKL math, copied verbatim with one addition: the `maturity_boost` multiplier applied during retrieval.
- **§6 Write Path**—ByteRover's curate operations collapsed into a deterministic consolidation pipeline with a write lock.

The core principle—*deterministic retrieval without external infrastructure*—is ByteRover's greatest contribution to this project.

## Notes

- **ByteRover is the single most influential paper for v2.** The AKL-lite math in §7, the tiered retrieval in §5, and the consolidation design in §6 are all ByteRover-derived. Credit accordingly in the README.
- **The flat entry map vs. Context Tree is the biggest architectural divergence.** We lose ByteRover's human-readable folder hierarchy but gain compatibility with SillyTavern's chat-metadata constraint. The graph edges partially compensate by providing relational structure without the hierarchy.
- **Tier 4 (LLM reasoning) was considered and explicitly cut.** This is a scope decision, not a quality decision—LLM-in-the-loop retrieval violates v2's deterministic principle (§2). If benchmarks show Tier 3 misses too often, we may revisit this for v2.1 with strict confidence thresholds.
- **ByteRover's pre-compaction pipeline is on the "nice to have" list.** For chats that grow beyond 1K episodic entries, summarization-based compression could keep the BM25 index manageable. Deferred to v2.1 based on usage data.
- **The 3-level pre-compaction (summarize → aggressive summarize → truncation) is a pattern worth preserving.** If we need compression later, ByteRover's approach of guaranteed-convergence truncation is superior to arbitrary hard cuts.
