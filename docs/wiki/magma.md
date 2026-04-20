# MAGMA

**Citation:** Dongming Jiang, Yi Li, Guanpeng Li, Bingzhe Li, 2026, arXiv:2601.03236  
**Paper URL:** https://arxiv.org/abs/2601.03236

## Summary

MAGMA (Multi-Graph based Agentic Memory Architecture) addresses the fundamental limitation of monolithic, semantic-only memory stores by representing memory across **four orthogonal relational graphs**: temporal (chronological ordering), causal (logical entailment), semantic (conceptual similarity), and entity (object persistence across disjoint timelines). Instead of static similarity search, MAGMA formulates retrieval as **policy-guided graph traversal**—an adaptive beam search that combines structural alignment with semantic relevance, guided by query intent classification.

MAGMA achieves state-of-the-art performance on LoCoMo (0.700 judge score, an 18.6–45.5% relative improvement over prior systems) and strong LongMemEval results (61.2% accuracy) while reducing token usage by over 95% compared to full-context baselines. Its key insight is that different query types ("why", "when", "what") require different retrieval strategies, and a multi-graph substrate enables query-adaptive traversal paths that monolithic embeddings cannot provide.

## Key Ideas

- **Four orthogonal relation graphs**—memory is represented across separate temporal, causal, semantic, and entity graphs, each capturing a different dimension of knowledge. The temporal graph provides immutable chronological ground truth; the causal graph enables "why" reasoning; the semantic graph captures conceptual similarity; the entity graph solves object persistence across disjoint timelines.
- **Unified node representation**—each event node is defined as ⟨content, timestamp, dense_embedding, metadata⟩, carrying all information needed for multi-graph traversal.
- **Time-variant directed multigraph**—the memory substrate is formalized as 𝒢_t = (𝒩_t, ℰ_t), where edges are partitioned into four semantic subspaces (temporal, causal, semantic, entity).
- **Policy-guided graph traversal**—retrieval is formulated as adaptive beam search over the multi-graph, not static lookup. The traversal policy dynamically scores candidate neighbors based on edge-type relevance to query intent and semantic similarity.
- **Query intent classification**—queries are mapped to intent types {WHY, WHEN, ENTITY}, which acts as a "steering wheel" for graph traversal, selecting which edge types to prioritize and which subgraphs to explore.
- **Transition scoring formula**—S(n_j | n_i, q) = exp(λ₁ · φ(type(e_ij), T_q) + λ₂ · sim(v⃗_j, v⃗_q)), combining intent-aware edge weights with semantic similarity.
- **Reciprocal Rank Fusion (RRF)**—anchor identification fuses signals from vector search, keyword matching, and temporal filtering via RRF, providing robust multi-signal seed selection.
- **Adaptive traversal with beam search**—the algorithm maintains a current frontier and visited set, expanding to neighbors based on the transition score, with depth controlled by query intent.
- **Narrative synthesis via graph linearization**—retrieved nodes are serialized into context with topological ordering (causal queries get topological sort; temporal queries get chronological sort) and provenance scaffolding (timestamp, content, reference ID).
- **Salience-based token budgeting**—low-relevance nodes are compressed to brevity codes ("...3 intermediate events...") to stay within context window limits while preserving narrative coherence.
- **Dual-stream memory evolution**—fast path (synaptic ingestion) handles latency-critical operations like event segmentation and vector indexing; slow path (structural consolidation) asynchronously infers latent causal and entity links using an LLM reasoning function.
- **Dual query representation**—queries are represented both as dense embeddings and sparse keywords, enabling both semantic and lexical matching during anchor identification.

## STARmem v2 Adaptation

MAGMA is the **source for STARmem v2's Tier 3 graph expansion** (§5.1). The core idea—that retrieval should be query-adaptive and leverage relational structure beyond semantic similarity—directly informs v2's design. However, v2 adopts only the lightweight structural concepts from MAGMA, rejecting the heavy infrastructure (vector databases, dense embeddings, LLM-based consolidation).

### What we adopt

| MAGMA concept | STARmem v2 mapping |
|---|---|
| **Multi-graph substrate** | **§4 Graph infrastructure.** v2 adopts MAGMA's insight that different edge types capture different dimensions of knowledge. The graph stores typed edges: `mentions`, `supports`, `same_topic`, `temporal_next`, and reserved `contradicts`. Unlike MAGMA's four orthogonal graphs, v2 uses a single graph with typed edges—simpler but functionally equivalent for our use case. |
| **Policy-guided graph traversal** | **§5.1 Tier 3 Detail (MAGMA-lite).** v2's beam search over the graph is a direct adaptation of MAGMA's traversal policy. Seeds come from Tier 2 BM25 results; neighbors are scored and ranked. |
| **Query intent classification** | **§5 Query classifier.** v2 adopts MAGMA's three-way intent classification (factual/relational/temporal, mapping to MAGMA's {ENTITY, WHY, WHEN}). The classifier is rule-based, not LLM-based. |
| **Transition scoring with edge-type weights** | **§5.1 Tier 3 scoring formula.** v2 uses S(neighbor | seed, query) = exp(λ₁ · edge_type_match(type) + λ₂ · BM25(neighbor, query)), directly adapted from MAGMA's S(n_j | n_i, q) = exp(λ₁ · φ(type(e_ij), T_q) + λ₂ · sim(v⃗_j, v⃗_q)). |
| **Intent-routed edge-type weights** | **§5.1 Edge-type match weight table.** v2 extends MAGMA's single weight per edge type to a per-intent weight matrix. Different query types prioritize different edges: `supports` weights highest for factual queries (0.9), `mentions` for relational (0.9), `temporal_next` for temporal (0.9). |
| **Beam search with depth control** | **§5.1 Tier 3.** v2 limits beam search to 1–2 hops, keeping latency under 100ms. Depth is controlled by query intent—factual queries may go deeper than temporal ones. |
| **Seed selection from primary retrieval** | **§5 Retrieval Ladder.** v2 uses Tier 2's top-K BM25 results (typically K=3) as seeds for Tier 3 expansion, adapted from MAGMA's RRF-based anchor identification. |

### What we reject or modify

| MAGMA concept | STARmem v2 decision |
|---|---|
| **Four orthogonal graphs** | **Collapsed to single typed graph (§4).** MAGMA maintains separate temporal, causal, semantic, and entity graphs. v2 uses a single graph with typed edges—simpler storage, same expressive power for our use case. The `temporal_next` edge covers MAGMA's temporal graph; `supports` covers causal; `same_topic` and `mentions` cover semantic; entity persistence is handled by the `subject` field, not a separate graph. |
| **Dense vector embeddings** | **Rejected entirely.** MAGMA uses dense embeddings for semantic similarity and transition scoring. v2 uses BM25 for lexical matching and rule-based edge weights—no embeddings, no vector database. This is consistent with v2's deterministic principle (§2). |
| **Reciprocal Rank Fusion (RRF)** | **Simplified to top-K BM25.** MAGMA's RRF fuses vector search, keyword matching, and temporal filtering. v2's Tier 3 uses only BM25 seeds from Tier 2—no RRF needed since we don't have multiple retrieval signals to fuse. |
| **LLM-based structural consolidation** | **Rejected (§2 Principle 1).** MAGMA's slow path uses an LLM to infer latent causal and entity links asynchronously. v2's edge construction is rule-based: explicit `@relations` from extracted entries plus entity co-occurrence (capitalized-word matching). |
| **Salience-based token budgeting with brevity codes** | **Deferred.** MAGMA compresses low-relevance nodes to brevity codes ("...3 intermediate events...") for context window management. v2 doesn't need this in v2.0—the beam search naturally limits results. If context bloat becomes an issue, this is a candidate for v2.1. |
| **Narrative synthesis via topological ordering** | **Partially adopted.** MAGMA's causal queries get topological sort and temporal queries get chronological sort. v2 uses the same principle in Tier 3 but applies it during final ranking, not as a separate synthesis step. |
| **Dual query representation (dense + sparse)** | **Reduced to sparse only.** MAGMA uses both dense embeddings and sparse keywords. v2 uses only BM25 (sparse lexical matching) for all retrieval—no dense embeddings. |
| **Node metadata structure** | **Simplified to v2 entry schema (§3.1).** MAGMA's unified node representation ⟨c, τ, v, A⟩ includes dense embeddings. v2's entry schema uses `id`, `scope`, `content`, `subject`, `tags`, `relations`, `lifecycle`, and `provenance`—a richer structure that doesn't need embeddings. |

### How it maps to the v2 spec

MAGMA's influence is concentrated in one section:

- **§5.1 Tier 3 Detail (MAGMA-lite)**—The entire Tier 3 design is MAGMA-derived. The beam search scoring formula, the intent-routed edge weights, and the seed selection from Tier 2 are all adapted from MAGMA's policy-guided traversal. The "MAGMA-lite" label in the spec acknowledges the source while indicating the simplified adaptation.

MAGMA's key contribution to v2 is the insight that **retrieval should be query-adaptive and leverage relational structure**. Without MAGMA, v2 would have stopped at BM25 and missed the graph expansion tier entirely. The paper validates that multi-graph traversal outperforms monolithic semantic similarity—v2 applies this lesson with a simpler, embedding-free substrate.

## Notes

- **MAGMA uses embeddings; v2 does not.** This is the single biggest divergence. MAGMA's dense embeddings enable semantic similarity scoring and RRF anchor identification. v2 replaces all of this with BM25 and rule-based edge weights. The trade-off is acceptable because BM25 is fast, deterministic, and requires no external service.
- **The "MAGMA-lite" label is intentional.** It signals that Tier 3 is a simplified adaptation, not a full implementation. The spec keeps the label to maintain attribution clarity.
- **Edge-type weights in v2 are more granular than MAGMA's.** MAGMA uses a single weight per edge type. v2 uses a per-intent weight matrix (3 query types × 5 edge types = 15 weights), providing finer control over retrieval behavior. The defaults (§5.1) are starting points subject to benchmark tuning.
- **MAGMA's causal graph is the hardest to replicate without embeddings.** v2's `supports` edge type partially covers causal relationships, but the rule-based approach (entity co-occidence + explicit `@relations`) is a simplification. If drift detection becomes a v2.1 priority, the causal graph will need more sophisticated construction.
- **The beam search depth (1–2 hops) is a latency constraint.** MAGMA's paper doesn't specify a hard depth limit. v2 caps at 2 hops to keep Tier 3 under 100ms. This may miss longer chains of reasoning, but the Floor fallback (§5) ensures no query returns empty.
- **MAGMA's code is at https://github.com/FredJiang0324/MAMGA** (note the typo in the repo name—MAMGA instead of MAGMA). Worth checking if we need to reference implementation details during v2.1 development.
