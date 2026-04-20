# AdaMem

**Citation:** Shannan Yan, Jingchen Ni, Leqi Zheng, Jiajun Zhang, Peixi Wu, Dacheng Yin, Jing Lyu, Chun Yuan, Fengyun Rao, 2026, arXiv:2603.16496  
**Paper URL:** https://arxiv.org/abs/2603.16496

## Summary

AdaMem is an adaptive user-centric memory framework for long-horizon dialogue agents that organizes conversation history into **four complementary memory structures**: Working Memory (recent context buffer), Episodic Memory (structured long-term experiences), Persona Memory (distilled user/assistant profiles), and Graph Memory (relation-aware connections between messages, topics, facts, and events). It addresses three core limitations of existing memory systems: over-reliance on semantic similarity (missing user-centric evidence like preferences and behavioral patterns), fragmented storage (isolated chunks weakening temporal and causal coherence), and static granularities (fixed-length structures that don't adapt to different question requirements).

AdaMem's inference pipeline uses **question-conditioned retrieval**—a deterministic cue-based router that decides whether to enable graph expansion based on temporal, relational, or attribute cues in the query—combined with a multi-agent collaboration model (Memory Agent for online understanding, Research Agent for iterative evidence gathering, Working Agent for final answer synthesis). It achieves state-of-the-art results on both LoCoMo and PERSONAMEM benchmarks.

## Key Ideas

- **Four-tier memory architecture**—Working Memory (bounded FIFO buffer, capacity 20), Episodic Memory (structured long-term records), Persona Memory (compact distilled profiles), Graph Memory (heterogeneous graph connecting messages, topics, facts, attributes, events).
- **Participant-specific memory bundles**—separate memory structures for each participant (user and assistant), enabling targeted retrieval based on who the question is about.
- **Normalized write format**—each utterance is parsed into a canonical record containing text, tags (topic, attitude, reason, facts, attributes), summary, rationale, timestamp, and speaker.
- **Working-to-Episodic consolidation**—when the working buffer fills, the oldest r=5 messages are popped and processed by three routers (event/fact/attribute), each predicting ADD, UPDATE, or IGNORE.
- **Topic regrouping**—sparse nearest-neighbor clustering (using all-MiniLM-L6-v2 embeddings) groups similar keys, followed by LLM merge prompts to create topic-centric summaries and aspect-based persona descriptors.
- **Question-conditioned retrieval**—a deterministic cue detector initializes retrieval plans: temporal cues ("when", "date", "last", "ago") and relation cues ("why", "because", "how") enable graph retrieval; attribute cues ("prefer", "like", "favorite") focus on persona; single-hop cues ("who", "what", "where") use semantic retrieval only.
- **Target participant resolution**—a four-way resolver determines if a question targets the user, assistant, both, or is ambiguous, routing retrieval accordingly.
- **Graph propagation with edge-type priors**—when graph retrieval is enabled, scores propagate along edges with type-specific weights: `supports` (0.90), `mentions` (0.75), `temporal_next` (0.70), `speaker_related` (0.60), `same_topic` (0.55), with hop-decay λ = 0.85.
- **Evidence fusion**—final scores combine semantic rank (α=0.7), graph rank (β=0.1), recency (γ=0.1), and fact confidence (δ=0.1) in a weighted sum.
- **Multi-agent collaboration**—Memory Agent handles online message understanding and memory updates, Research Agent performs iterative evidence gathering (Planning → Search → Integrate → Reflection, max 2 iterations), Working Agent synthesizes the final answer.
- **Graph construction rules**—nodes include message, topic, fact, attribute, event, and persona snapshot nodes; edges are typed: `mentions` (msg→topic), `supports` (msg→fact/attribute, fact→event), `same_topic` (temporal continuity), `temporal_next` (timeline), `speaker_related` (speaker continuity).

## STARmem v2 Adaptation

AdaMem is the **origin of STARmem v2's memory-scope vocabulary** (§4). The terms "Working," "Episodic," and "Persona" come directly from AdaMem's four-tier architecture. However, v2 collapses AdaMem's four scopes into three (dropping Graph as a user-facing scope) and rejects several of AdaMem's core mechanisms in favor of v2's deterministic, single-path principles.

### What we adopt

| AdaMem concept | STARmem v2 mapping |
|---|---|
| **Working Memory** (bounded FIFO buffer) | **§4 Memory Scopes—Working.** v2 adopts the concept of a hot buffer that holds recent turns and is drained by consolidation. We don't fix capacity at 20 messages; instead, consolidation triggers on buffer size ≥ 10 entries or idle ≥ 60s (§6.2). |
| **Episodic Memory** (structured long-term records) | **§4 Memory Scopes—Episodic.** v2 adopts AdaMem's Episodic scope as the long-term store where 95% of entries live. Consolidation moves entries from Working to Episodic (§6.3). |
| **Persona Memory** (distilled profiles) | **§4 Memory Scopes—Persona.** v2 adopts AdaMem's Persona scope as distilled character/user sheets. Unlike AdaMem's continuous persona updates, v2 rebuilds Persona explicitly via Enhanced RAPTOR when the user triggers it (§6.4). |
| **Graph as a relational scaffold** | **§4 Memory Scopes—Graph is infrastructure, not a memory.** v2 explicitly demotes Graph from a user-facing scope to an internal data structure. Edges support Tier 3 retrieval but are not queryable as a separate memory type. |
| **Edge-type vocabulary** (`mentions`, `supports`, `same_topic`, `temporal_next`) | **§4, §5.1 Tier 3.** v2 adopts AdaMem's edge types for graph construction and Tier 3 expansion. We add `contradicts` (reserved for v2.x drift detection) and drop `speaker_related` (not needed in single-user roleplay). |
| **Consolidation from Working to Episodic** | **§6.3 Consolidation Pipeline.** v2 adopts AdaMem's batched consolidation pattern (r=5 messages per batch), but replaces AdaMem's three-router ADD/UPDATE/IGNORE with a single `extractFacts()` call that handles deduplication internally. |
| **Topic-centric summaries** | **§6.4 Persona Rebuild.** v2's Enhanced RAPTOR rebuild is conceptually similar to AdaMem's topic regrouping—both cluster related entries and produce summaries. v2 uses Leiden community detection instead of sparse nearest-neighbor clustering. |

### What we reject or modify

| AdaMem concept | STARmem v2 decision |
|---|---|
| **Graph Memory as a fourth scope** | **Rejected (§4).** AdaMem treats Graph as a user-facing memory type. v2 explicitly states: "Graph is infrastructure, not a memory." Edges exist to support Tier 3 retrieval but are not a queryable scope. |
| **Multi-agent collaboration (Memory/Research/Working Agents)** | **Rejected (§2 Principle 1, §11 Out of Scope).** AdaMem's Research Agent performs iterative LLM-in-the-loop evidence gathering. v2 enforces deterministic retrieval—no LLM calls on the query path. The multi-agent model is incompatible with v2's single-path philosophy. |
| **Question-conditioned route planning with LLM refinement** | **Rejected (§5).** AdaMem uses an optional LLM to refine retrieval plans when confidence < 0.75. v2's query classifier is purely rule-based (3-type: factual/relational/temporal) with no LLM involvement. |
| **Embedding-based topic clustering** | **Rejected (§6.4).** AdaMem uses all-MiniLM-L6-v2 embeddings for sparse nearest-neighbor clustering. v2's Enhanced RAPTOR uses Leiden community detection on a k-NN graph built from BM25 scores—no embeddings. |
| **Evidence fusion with weighted sum** | **Replaced with multiplicative scoring (§5.2).** AdaMem fuses scores as α·s_base + β·s_graph + γ·s_recency + δ·s_fact. v2 uses a multiplicative formula: BM25 × (1 + importance/100) × recency × maturity_boost. The multiplicative choice prevents any single factor from dominating. |
| **Participant-specific memory bundles** | **Simplified to `subject` field (§3.1).** AdaMem maintains separate memory structures for user and assistant. v2 uses a flat `entries` map with a `subject` field to distinguish character vs user memories. No separate bundles. |
| **Normalized write format with attitude/reason tags** | **Simplified.** AdaMem's normalized record includes attitude, reason, facts, and attributes tags. v2's entry schema (§3.1) uses `tags` (free-form), `subject`, `relations`, and `provenance`—a flatter structure that avoids over-engineering. |
| **Four-way target participant resolver** | **Not needed.** AdaMem resolves whether a query targets user, assistant, both, or ambiguous. v2 operates in a single-chat context where the subject is determined by the active character or explicit query scope. |
| **Hop-decay factor λ = 0.85** | **Not used.** AdaMem's graph propagation uses λ = 0.85 per hop. v2's Tier 3 uses beam search with edge-type match weights and BM25 scoring (§5.1), without hop decay. |

### How it maps to the v2 spec

AdaMem's influence is concentrated in two sections:

- **§4 Memory Scopes**—The Working/Episodic/Persona vocabulary is directly from AdaMem. The decision to demote Graph to infrastructure is a v2-specific modification.
- **§5.1 Tier 3 Detail**—AdaMem's edge-type vocabulary (`mentions`, `supports`, `same_topic`, `temporal_next`) is adopted for graph construction and Tier 3 expansion. The edge-type match weights table in §5.1 is v2's adaptation of AdaMem's edge-type priors, tuned for the multiplicative scoring model.

AdaMem's greatest contribution is **naming the scopes**. Without AdaMem, v2 would have invented different terminology. The paper also validates the Working→Episodic→Persona consolidation pipeline, even though v2 simplifies the mechanics.

## Notes

- **Attribution matters.** AdaMem coined the Working/Episodic/Persona vocabulary. The README must cite AdaMem as the origin of these terms, even though v2 modifies the implementation.
- **Graph is not a scope in v2.** This is a deliberate departure from AdaMem. The spec (§4) states: "Three scopes, not four. Graph is infrastructure, not a memory." This decision simplifies the user-facing model and keeps retrieval deterministic.
- **No embeddings in v2.** AdaMem uses all-MiniLM-L6-v2 for topic clustering. v2 rejects embeddings entirely—BM25 and rule-based graphs throughout. This is consistent with v2's deterministic principle (§2).
- **The multi-agent model is explicitly out of scope (§11).** AdaMem's Research Agent is powerful but incompatible with v2's "no LLM on the query path" rule. If iterative evidence gathering becomes necessary, it would need to be reimagined as an offline, user-triggered process (similar to Persona rebuild).
- **Edge-type weights differ from AdaMem's priors.** AdaMem uses fixed priors: `supports` 0.90, `mentions` 0.75, `temporal_next` 0.70, `speaker_related` 0.60, `same_topic` 0.55. v2's Tier 3 uses intent-routed weights (§5.1) that vary by query type (factual/relational/temporal), providing finer-grained control.
- **AdaMem's PERSONAMEM benchmark is not directly relevant to v2.** PERSONAMEM tests user modeling in multi-session dialogues. v2 operates within a single SillyTavern chat, so LoCoMo and LongMemEval are more relevant benchmarks.
