# Zep / Graphiti

**Citation:** Rasmussen et al., 2025, arXiv:2501.13956
**Paper URL:** https://arxiv.org/abs/2501.13956
**Code:** https://github.com/getzep/graphiti

## Summary

Zep is a temporal knowledge graph architecture for AI agent memory, built on top of a core engine called Graphiti. The system tracks entities, relationships, and facts with explicit validity windows—when a fact became true, when it stopped being true, and how it evolved over time. In benchmarks, Zep outperforms MemGPT on the Deep Memory Retrieval (DMR) benchmark (94.8% vs 93.4%) and achieves up to 18.5% accuracy improvements on the LongMemEval benchmark while reducing response latency by 90%.

Graphiti, the open-source engine powering Zep, is a full knowledge graph system with Neo4j backing, entity extraction pipelines, community detection, and real-time incremental updates. It is designed for enterprise-scale agent deployments where structured business data and unstructured conversational data must be synthesized into a single queryable graph.

---

## Key Ideas

### 1. Temporal Knowledge Graph

Graphiti models memory as a bi-temporal knowledge graph:

```
G = (N, E, φ)
```

Where:
- **N** = nodes (entities, facts, events)
- **E** = edges (relationships between nodes)
- **φ** = temporal metadata (validity windows, provenance)

Each fact in the graph has an explicit validity period:

> "Kendra loves Adidas shoes (as of March 2026)"

This is not just a timestamp—it's a full temporal range tracking when the fact became true and when (if ever) it ceased to be true. This allows the system to answer questions like "What did Kendra love in 2024?" vs "What does Kendra love now?" with different answers.

### 2. Dual Storage Model

Zep maintains two parallel representations:

1. **Raw episodic data:** The original conversational turns, stored verbatim
2. **Derived semantic entities:** Extracted entities, relationships, and community summaries

This mirrors psychological models of memory (episodic vs semantic) and allows the system to reconstruct the original context when needed while also providing distilled, queryable facts.

### 3. Real-Time Incremental Updates

Unlike batch-oriented RAG systems that recompute indices periodically, Graphiti integrates new data episodes immediately:

- New facts are extracted from incoming messages
- Existing facts are updated or deprecated as needed
- The graph is incrementally restructured without full recomputation
- Community summaries are regenerated for affected subgraphs

This is critical for enterprise applications where the knowledge base changes continuously and stale data is worse than no data.

### 4. Hybrid Retrieval

Graphiti combines three retrieval mechanisms:

1. **Semantic embeddings:** Vector similarity search over entity descriptions
2. **Keyword (BM25):** Traditional inverted index for exact term matching
3. **Graph traversal:** Multi-hop neighborhood expansion from seed nodes

The system weights these mechanisms based on query characteristics, similar in spirit to STARmem v2's Tier 0-3 ladder but implemented as a unified scoring function rather than a tiered cascade.

### 5. Community Summarization

Graphiti applies community detection algorithms (similar to Leiden) to identify clusters of related entities. Each community is summarized by an LLM to produce a high-level description:

- "Alice's social circle: friends, family, coworkers"
- "Alice's professional history: jobs, skills, achievements"

These summaries are stored as first-class nodes in the graph and can be retrieved directly for broad queries or used as starting points for graph traversal.

---

## Why Not STARmem v2

Zep/Graphiti was evaluated during the STARmem v2 design phase and rejected. The decision is straightforward: **it is too heavy for a chat-scale memory system.**

### 1. Full Knowledge Graph Engine = Massive Complexity

Graphiti is not a lightweight library—it is a complete knowledge graph engine:

- **Neo4j dependency:** Requires a running Neo4j instance (or compatible graph database)
- **10,000–20,000+ lines of code:** The Graphiti repository is a substantial codebase with multiple subsystems
- **Multiple services:** Entity extraction, relationship detection, community summarization, temporal tracking, hybrid retrieval
- **Infrastructure overhead:** Database connections, connection pooling, schema migrations, backup/restore

STARmem v2's design principle is **minimalism**—the entire memory system fits in a single JSON tree serialized to `chatMetadata['STARmem']` (§3). There are no external dependencies, no database servers, no sidecar files. Adding Neo4j (or any graph database) would:

- Break SillyTavern's native chat-file backup and sync
- Require users to install and configure a database server
- Add operational complexity (database health, connection failures, schema evolution)
- Violate the "no external indices" principle (§3)

### 2. Over-Engineered for Roleplay Memory

Zep is designed for **enterprise agent deployments** where:

- Multiple agents share a common knowledge base
- Structured business data (CRM records, product catalogs, support tickets) must be integrated with conversational data
- Temporal reasoning across months or years of interactions is required
- Compliance and audit trails are mandatory

STARmem v2 is designed for **single-user roleplay** where:

- Each chat is isolated (no cross-chat knowledge sharing)
- The data is purely conversational (no business records)
- Temporal reasoning spans a single session or a few sessions
- The user is the only consumer of the memory system

Graphiti's temporal validity windows, bi-temporal tracking, and community summarization are powerful features—but they solve problems that don't exist in the roleplay context. A character's backstory doesn't need validity windows; it needs to be consistent within the current narrative.

### 3. Latency Budget Mismatch

Zep reports 90% latency reduction compared to baseline implementations, but the absolute latency is still measured in hundreds of milliseconds to seconds for graph traversal queries. STARmem v2's retrieval ladder (§5) targets sub-100ms end-to-end:

| Tier | Target Latency | Mechanism |
| --- | --- | --- |
| 0 (exact cache) | <1ms | Hash lookup |
| 1 (fuzzy cache) | <5ms | Jaccard similarity |
| 2 (BM25) | <50ms | Inverted index |
| 3 (graph expansion) | <100ms | Typed edge traversal |
| Floor | <5ms | Lifecycle scoring |

Graphiti's graph traversal—even with Neo4j's optimized Cypher queries—cannot match this because:

- Database round-trips add network latency (even local sockets have overhead)
- Graph traversal is inherently more expensive than flat list iteration
- Community summarization requires LLM calls (off the hot path in v2, but still a cost)

### 4. Violates the "Graph Is Infrastructure" Principle

STARmem v2's design spec (§4) is explicit:

> **Three scopes, not four. Graph is infrastructure, not a memory.**

The graph in v2 is a flat list of typed edges between entries, rebuilt in memory on chat load. It is not a user-facing memory scope—users interact with Working, Episodic, and Persona entries. The graph exists solely to support Tier 3 retrieval expansion.

Zep/Graphiti treats the graph as the **primary memory substrate**—entities, relationships, and communities are first-class objects that users query directly. This is the right design for enterprise knowledge management but the wrong design for roleplay memory where:

- Users think in terms of character facts and story events, not entity-relationship graphs
- The memory system should be invisible—facts appear in context without the user managing a knowledge graph
- Simplicity and reliability matter more than expressive power

### 5. No SillyTavern Integration Path

Zep is a standalone service with its own API, authentication, and deployment model. Integrating it into SillyTavern would require:

- A separate server process (or Docker container) running Zep/Graphiti
- API calls from the SillyTavern extension to the Zep service
- Configuration management for connection strings, credentials, and schema versions
- Error handling for network failures, database downtime, and API rate limits

This is fundamentally incompatible with SillyTavern's extension model, where third-party extensions are JavaScript modules that run in the browser and interact with the SillyTavern backend through existing APIs. There is no mechanism for extensions to spawn or manage external services.

---

## Notes

### What Zep/Graphiti Does Well

- **Temporal reasoning:** The bi-temporal model is genuinely novel and well-suited for enterprise applications where facts change over time
- **Incremental updates:** Real-time graph restructuring without batch recomputation is a significant engineering achievement
- **Hybrid retrieval:** Combining embeddings, BM25, and graph traversal is the right approach for complex knowledge bases
- **Community summarization:** LLM-generated summaries of entity clusters provide useful abstraction layers

### Benchmarks

Zep was evaluated on:

- **DMR (Deep Memory Retrieval):** 94.8% vs MemGPT's 93.4%
- **LongMemEval:** Up to 18.5% accuracy improvement over baselines, with 90% latency reduction

These are strong results, but they measure performance on enterprise-scale knowledge management tasks—not roleplay-specific metrics like character consistency, narrative coherence, or retcon handling.

### Relationship to STARmem v2's Design

The aspects of Zep/Graphiti that *were* influential on STARmem v2:

1. **Typed edges:** Graphiti's explicit relationship types (though more numerous than v2's five) inspired v2's typed edge system (`mentions`, `supports`, `same_topic`, `temporal_next`, `contradicts`)
2. **Bi-temporal tracking:** The concept of tracking when facts became true and when they ceased to be true informed v2's lifecycle system (§7), though v2 implements this through immutable entries with timestamps rather than validity windows
3. **Community summarization:** The idea of summarizing clusters of related facts influenced v2's use of Enhanced RAPTOR for persona rebuild (§6.4)

The aspects that were rejected:

1. Neo4j dependency (too heavy for chat-scale)
2. Full knowledge graph as primary memory (violates "graph is infrastructure" principle)
3. Standalone service architecture (incompatible with SillyTavern extension model)
4. Enterprise-scale feature set (over-engineered for roleplay)

### Could a Lightweight Variant Work?

A stripped-down version of Graphiti—removing Neo4j, community summarization, and temporal validity windows, keeping only the typed edge traversal—would essentially be STARmem v2's current Tier 3 (MAGMA-lite). The design spec already incorporates the useful ideas from Graphiti without the infrastructure overhead.

If a future version of STARmem needed more sophisticated graph capabilities, the path would be:

1. Add edge attributes (confidence scores, source provenance) to the existing flat edge list
2. Implement in-memory graph algorithms (BFS, DFS, shortest path) without a database
3. Keep the JSON-tree serialization model

This would preserve the "no external dependencies" principle while gaining some of Graphiti's expressive power. Not planned for v2.0, but a possible v2.x extension.

### Zep vs Graphiti

The paper and repository distinguish between two products:

| Aspect | Zep | Graphiti |
| --- | --- | --- |
| What it is | Managed service for AI agent memory | Open-source temporal graph engine |
| Deployment | Cloud-hosted, API-based | Self-hosted, library-based |
| Target user | Enterprises wanting turnkey memory | Developers building custom graph systems |
| Codebase | Proprietary (backed by Graphiti) | Open-source (MIT license) |

STARmem v2 evaluated Graphiti (the open-source engine) specifically, since Zep (the managed service) is not an option for a self-hosted SillyTavern extension. The rejection applies to both—the architectural complexity is inherent to the knowledge graph approach, not the deployment model.
