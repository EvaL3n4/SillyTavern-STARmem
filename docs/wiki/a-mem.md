# A-MEM (Agentic Memory)

**Citation:** Xu et al., 2025, arXiv:2502.12110
**Paper URL:** https://arxiv.org/abs/2502.12110
**Code:** https://github.com/agiresearch/A-mem

## Summary

A-MEM (Agentic Memory for LLM Agents, Xu et al. 2025) proposes a dynamic memory system for LLM agents inspired by the Zettelkasten method—a note-taking philosophy where individual atomic notes are linked together to form a web of knowledge. When a new memory is added, A-MEM:

1. Generates a comprehensive note with structured attributes (contextual descriptions, keywords, tags)
2. Analyzes historical memories to identify relevant connections
3. Establishes links where meaningful similarities exist
4. Triggers "memory evolution"—existing memories can have their contextual representations and attributes updated based on the new information

The system uses ChromaDB for vector storage and LLM-driven analysis for relationship detection. It was evaluated on the LoCoMo and DialSim benchmarks, showing improvements over MemGPT and MemoryBank baselines.

---

## Key Ideas

### 1. Zettelkasten-Inspired Architecture

A-MEM treats each memory as an atomic "note" in the Zettelkasten tradition:

- **Atomicity:** Each memory is self-contained and individually addressable
- **Rich metadata:** Notes carry contextual descriptions, keywords, and tags beyond raw text
- **Flexible linking:** Notes are connected by semantic similarity rather than rigid taxonomic hierarchies
- **Dynamic organization:** The structure evolves as new notes are added—there is no fixed schema

This contrasts with STARmem v2's approach, where entries follow a strict schema (§3.1 of the design spec) with typed relations (`mentions`, `supports`, `same_topic`, `temporal_next`, `contradicts`) rather than free-form semantic links.

### 2. Memory Evolution Mechanism

When a new memory enters the system, A-MEM doesn't just store it—it actively updates existing memories:

1. **Semantic analysis:** The LLM reads the new memory and identifies relationships to existing notes
2. **Contextual update:** Existing notes may have their descriptions, tags, or metadata revised to reflect the new information
3. **Link creation:** New edges are established between related notes

This "evolution" is the system's attempt to keep the knowledge network coherent and up-to-date. In the abstract: *"as new memories are integrated, they can trigger updates to the contextual representations and attributes of existing historical memories, allowing the memory network to continuously refine its understanding."*

### 3. ChromaDB Vector Storage

A-MEM uses ChromaDB as its persistence layer:

- Embeddings are computed over both content and generated metadata
- Semantic similarity search drives relationship detection
- Metadata-rich notes enable more nuanced retrieval than raw text chunks

This is an embedding-heavy approach—every memory operation involves vector computation and similarity scoring.

### 4. LLM-Driven Decision Making

The system's core organizational logic is delegated to an LLM:

- Keyword generation
- Tag assignment
- Context description creation
- Relationship identification
- Memory evolution triggers

This makes the system adaptive but also non-deterministic—the same set of memories processed at different times (or with different models) can produce different organizational structures.

---

## Why Not STARmem v2

A-MEM was evaluated during the STARmem v2 design phase and rejected for adoption. The decision rests on four specific incompatibilities:

### 1. No Typed Edges

A-MEM's linking mechanism is based purely on embedding similarity. When the system identifies a connection between two memories, it creates a generic link—there is no semantic typing of edges.

STARmem v2 requires **typed edges** (§3.2, §4):

| Edge Type | Purpose |
| --- | --- |
| `mentions` | One entry references the subject of another |
| `supports` | One entry provides evidence for another |
| `same_topic` | Two entries concern the same thematic domain |
| `temporal_next` | One entry chronologically follows another |
| `contradicts` (reserved) | Two entries contain conflicting information |

These typed edges are essential for Tier 3 (MAGMA-lite) graph expansion (§5.1), which uses edge-type-specific weights to route queries. A-MEM's untyped links cannot support this—a `supports` edge and a `contradicts` edge would be treated identically, making intent-based routing impossible.

**A-MEM's gap:** Embedding similarity tells you *that* two memories are related, but not *how*. For roleplay memory, the distinction matters enormously. "Alice hates cats" and "Alice feeds the stray cat daily" are semantically similar (same subject, same topic) but relationally opposed.

### 2. Memory Evolution Overwrites Historical State

A-MEM's "memory evolution" mechanism updates existing memories when new information arrives. This is a feature for general-purpose agent memory but a **bug for roleplay**.

STARmem v2's design principle includes **retcon honesty**—the system must preserve historical state so that when a roleplay narrative changes a character's backstory or personality, the memory system can distinguish between:

- What was originally true (historical fact)
- What is now true (current state)
- What was retconned (contradiction between old and new)

A-MEM's evolution model overwrites historical attributes, making it impossible to reconstruct the original state after an update. In a roleplay context, this means:

- If Alice's character sheet says she "grew up in Paris" and later the roleplay reveals she "actually grew up in Marseille," A-MEM would update the memory in place.
- The system would lose the fact that Paris was the original statement.
- Future queries about Alice's backstory would only see Marseille, with no trace of the contradiction.

STARmem v2 handles this through immutable Episodic entries with explicit lifecycle tracking (§7)—entries are never mutated in place, only new entries are added with higher importance scores that override lower ones at retrieval time.

### 3. LLM-in-the-Loop Violates Deterministic Retrieval

A-MEM's memory organization is LLM-driven. Every new memory triggers LLM calls for:

- Keyword extraction
- Context description generation
- Tag assignment
- Relationship analysis
- Evolution triggers

STARmem v2's core principle (§2, Principle 1) is **deterministic retrieval, always**—no LLM call on the query path. A-MEM's architecture is fundamentally incompatible with this:

- LLM calls introduce latency variance (model load times, API round-trips, rate limiting)
- LLM outputs are non-deterministic (same input → different outputs across runs)
- LLM failures break the organizational pipeline (network errors, model timeouts)

In STARmem v2, the only LLM touchpoints are:
- Fact extraction during consolidation (§6.1)—off the hot path
- Persona rebuild (§6.4)—explicit, user-initiated, offline

A-MEM's LLM dependency would make it a hot-path component, violating the design principle.

### 4. Simpler Than What v2 Needs

A-MEM is architecturally simpler than STARmem v2's requirements:

| Feature | A-MEM | STARmem v2 |
| --- | --- | --- |
| Retrieval tiers | Single (ChromaDB similarity) | 4-tier ladder + floor (§5) |
| Scoring | Embedding similarity | Multiplicative: BM25 × importance × recency × maturity (§5.2) |
| Edge types | None (implicit) | 5 typed categories (§4) |
| Lifecycle | LLM-driven updates | Deterministic decay + maturity tiers (§7) |
| Query classification | None | 3-type rule-based classifier (§5) |
| Trace logging | None | Full replayable traces (§9.1) |
| Benchmarking hooks | None | Pluggable scorer + eval harness (§9.2, §9.3) |

A-MEM is designed for general-purpose agent memory—it's a good system for that use case. But STARmem v2's roleplay-specific requirements (typed edges, retcon honesty, deterministic retrieval, lifecycle scoring) demand a more sophisticated architecture than A-MEM provides.

---

## Notes

### What A-MEM Does Well

- **Dynamic organization:** The Zettelkasten-inspired approach of atomic, interconnected notes is elegant for general knowledge management
- **Adaptive linking:** Letting the LLM identify relationships rather than enforcing a rigid schema works well for open-ended domains
- **Memory evolution:** The ability to update existing memories as new information arrives keeps the knowledge base coherent over time (even though this is specifically problematic for roleplay)

### Benchmarks

A-MEM was evaluated on:

- **LoCoMo:** Long-term conversational memory benchmark
- **DialSim:** Dialogue similarity benchmark

Results showed improvements over MemGPT and MemoryBank baselines, but these benchmarks measure general conversational memory quality—not the roleplay-specific metrics (retcon handling, entity consistency, character voice preservation) that STARmem v2 prioritizes.

### Relationship to STARmem v2's Design

The aspects of A-MEM that *were* influential on STARmem v2:

1. **Rich metadata on entries:** A-MEM's structured note attributes inspired v2's entry schema (§3.1) with `tags`, `relations`, `lifecycle`, and `provenance` fields
2. **Graph-like linking:** The concept of connecting memories through relationships (even if untyped in A-MEM) informed v2's typed edge system

The aspects that were rejected:

1. LLM-driven organization (violates deterministic retrieval)
2. Memory evolution by overwrite (violates retcon honesty)
3. Single-tier retrieval (insufficient for roleplay context injection)

### Future Reconsideration?

A-MEM's evolution mechanism could be reconsidered if STARmem v2 adds a **versioning layer** to entries—storing the full history of attribute changes rather than mutating in place. This would preserve retcon honesty while gaining the coherence benefits of evolution. Not planned for v2.0, but a possible v2.x extension.
