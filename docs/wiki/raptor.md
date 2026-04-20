# RAPTOR & Enhanced RAPTOR

**Original Citation:** Sarthi et al., 2024, ICLR 2024, arXiv:2401.18059
**Enhanced Citation:** Liu et al., 2026, Frontiers in Computer Science, DOI 10.3389/fcomp.2025.1710121
**Original Paper URL:** https://arxiv.org/abs/2401.18059
**Enhanced Paper URL:** https://www.frontiersin.org/articles/10.3389/fcomp.2025.1710121/full

## Summary

RAPTOR (Recursive Abstractive Processing for Tree-Organized Retrieval, Sarthi et al. 2024) introduced a bottom-up tree structure for retrieval-augmented language models. The core idea is to recursively embed, cluster, and summarize text chunks to create a hierarchy from granular leaf nodes (raw text segments) to abstract root nodes (high-level summaries). At query time, RAPTOR retrieves from across the full tree, integrating information at multiple levels of abstraction rather than pulling flat contiguous chunks.

Enhanced RAPTOR (Liu et al. 2026) replaced RAPTOR's two weakest points—the fixed-size token chunker and the Gaussian Mixture Model clustering—with semantic chunking and Leiden community detection on k-NN graphs, plus a layer-aware dual-adaptive parameter strategy. The improvements are measured and significant.

---

## Original RAPTOR (Sarthi et al. 2024)

### Key Ideas

**1. Bottom-Up Tree Construction**

RAPTOR builds a hierarchical tree from the corpus upward:

1. **Leaf creation:** Split the corpus into 100-token contiguous segments (sentence-preserving).
2. **Embed:** Each segment is embedded using SBERT (`multi-qa-mpnet-base-cos-v1`).
3. **Cluster:** Apply Gaussian Mixture Models (GMMs) with soft clustering—nodes can belong to multiple clusters. The optimal cluster count is determined by Bayesian Information Criterion (BIC). UMAP is used for dimensionality reduction before clustering, with `n_neighbors` varied to capture both local and global structure.
4. **Summarize:** For each cluster, prompt an LLM (GPT-3.5-turbo) to generate a summary of the clustered nodes. This summary becomes the parent node.
5. **Repeat:** Re-embed the summaries and recurse until clustering becomes infeasible (single root node or stopping criteria met).

The average compression ratio is ~72%—parent summaries are roughly 28% of their children's total text length. Build time and token cost scale linearly with document length (validated up to 78,000 tokens on consumer-grade hardware).

**2. Two Retrieval Strategies**

RAPTOR proposes two distinct query mechanisms over the constructed tree:

- **Tree Traversal (layer-by-layer):** Start at the root layer. Compute cosine similarity between the query and each node. Select the top-k nodes. Proceed to the children of selected nodes. Repeat until leaves. Concatenate all selected nodes as the retrieval context.

- **Collapsed Tree Retrieval:** Flatten the entire tree into a single layer of nodes. Compute cosine similarity across all nodes. Select the top nodes until a `max_tokens` threshold is reached (default: 2000 tokens).

**Key finding:** The collapsed tree retrieval outperforms the hierarchical tree traversal across all benchmarked datasets. The original paper's own ablation showed this, and this fact directly informs why STARmem v2 uses the tree only for summarization, not as a retrieval structure.

**3. Ablation: Why the Hierarchy Matters**

Testing different layer combinations on QuALITY stories:

| Configuration | Accuracy |
| --- | --- |
| Single layer only | ~57.9% |
| Two layers | 63.15% |
| Full tree (3 layers) | **73.68%** |

The full tree is necessary—no single layer or pair of layers captures all the information needed for complex reasoning questions.

### Experimental Results

| Dataset | RAPTOR + GPT-4 | Previous Best | Improvement |
| --- | --- | --- | --- |
| QuALITY (full) | 82.6% | 62.3% | +20% absolute |
| QuALITY-HARD | 76.2% | 54.7% (CoLISA) | +21.5% |
| QASPER | 55.7% F1 | 53.9% (CoLT5 XL) | +1.8% |
| NarrativeQA (METEOR) | 19.1 | 11.1 | +8.0 |

RAPTOR outperforms both BM25 and Dense Passage Retrieval (DPR) consistently across every tested LLM (GPT-3, GPT-4, UnifiedQA 3B).

### Limitations of the Original

1. **Fixed-size chunking:** 100-token windows split sentences mid-stream and lose semantic coherence. A clause about "why Cinderella was unhappy" may be severed from the clause explaining "what the stepmother did."

2. **GMM clustering:** Gaussian Mixture Models assume data roughly follows elliptical distributions. Text embeddings in high-dimensional space form irregular, non-convex manifolds that GMMs mispartition. Soft clustering helps, but the underlying assumption is still wrong for semantic similarity graphs.

3. **Tree traversal retrieval:** The layer-by-layer approach enforces a fixed ratio of thematic-to-granular information regardless of what the query actually needs. The collapsed tree performs better, which means the hierarchical tree traversal adds latency without adding value.

4. **No entity-aware edges:** Clusters are formed by embedding proximity alone. There is no mechanism for typed edges (mentions, supports, contradicts) or for tracking which specific entities drive relationships between nodes.

---

## Enhanced RAPTOR (Liu et al. 2026)

### Key Ideas

Enhanced RAPTOR addresses the original's two weakest points directly and systematically.

**1. Semantic Chunking (replaces fixed 100-token windows)**

Instead of cutting at an arbitrary token boundary, Enhanced RAPTOR computes the cosine distance between consecutive sentence embeddings. A new chunk boundary is created only when this distance exceeds a threshold τ.

- Default threshold: τ = 0.7
- Result: Each leaf chunk is semantically coherent and self-contained, not a fragment cut mid-sentence.
- In STARmem v2's persona rebuild, this is the first stage applied over Episodic entries for a given subject before any clustering.

**2. Leiden Community Detection (replaces GMM)**

This is the primary architectural change:

1. **Build a k-NN graph:** Nodes are text chunks (or summaries, at higher layers). Edges are weighted by cosine similarity between node embeddings. Only the k nearest neighbors of each node receive an edge, creating a sparse graph.

2. **Run the Leiden algorithm:** Leiden (Traag et al., 2019) is a community detection method that improves on the Louvain algorithm by guaranteeing well-connected communities and avoiding the formation of poorly connected clusters. It uses the RBConfigurationVertexPartition method to optimize the community structure.

3. **Cluster = community:** Each detected Leiden community becomes a cluster. The constituent nodes are summarized by an LLM to produce the parent node.

**Why Leiden over GMM for text:**

| Property | GMM | Leiden on k-NN |
| --- | --- | --- |
| Cluster shape assumption | Elliptical | Agnostic—captures arbitrary shapes |
| Connectivity guarantee | No | Yes—each community is internally well-connected |
| Sensitivity to noise | High—outliers distort covariance | Lower—sparse k-NN graph isolates noise |
| Computational scaling | O(n · k · iterations) | O(n log n) for k-NN construction + near-linear for Leiden |
| Interpretability | Soft membership weights are opaque | Communities are explicit subgraphs—inspectable |

For STARmem v2's persona rebuild, this matters because character facts (e.g., "Alice grew up in Marseille", "Alice speaks French") should cluster together even if their embedding distance isn't perfectly spherical. Leiden captures these semantic neighborhoods correctly.

**3. Layer-Aware Dual-Adaptive Parameters**

The original RAPTOR used the same hyperparameters at every tree layer. Enhanced RAPTOR varies two parameters as the hierarchy ascends:

- **k (neighbor count):** Increases linearly per layer.
  - `k_base = 15` at the bottom layer
  - `k_step = 5` additional neighbors per layer
  - Rationale: Higher layers summarize broader topics, so each node needs to "see" more of the graph to find its community.

- **γ (Leiden resolution parameter):** Decreases linearly per layer.
  - `γ_base = 1.0` at the bottom
  - `γ_step = 0.2` decrement per layer
  - Rationale: A higher resolution produces many fine-grained clusters; a lower resolution merges them into fewer, larger communities. Starting strict at the bottom and relaxing upward mirrors the natural abstraction gradient—details are fine, themes are broad.

**These exact values** (`k_base=15, k_step=5, γ_base=1.0, γ_step=0.2`) are the ones STARmem v2 adopts for persona rebuild, as specified in the design document §6.4.

### Experimental Results

Enhanced RAPTOR was evaluated on the same benchmark suites as the original:

- **QuALITY:** Improved over original RAPTOR's 73.68% (full tree) with measurable gains attributed to cleaner leaf nodes and better community structure.
- **QASPER:** Showed robustness improvements on scientific text where domain-specific terminology benefits from semantic rather than fixed-size chunking.

The paper demonstrates that the dual-adaptive parameter strategy is not a marginal tweak—it consistently outperforms a single-parameter Leiden configuration across datasets.

---

## STARmem v2 Adaptation

### Where It's Used: Offline Persona Rebuild Only

Enhanced RAPTOR is **not** used for hot-path retrieval in STARmem v2. The design spec is explicit: retrieval is deterministic and LLM-free at query time. Enhanced RAPTOR's entire pipeline—semantic chunking, Leiden clustering, LLM summarization—is too expensive for per-turn execution.

Instead, it runs exclusively during **persona rebuild** (§6.4), which is:

- Always explicit, never automatic
- Triggered by user action after a `pendingPersonaRebuild` flag is set (when Episodic count reaches N=100 for a subject)
- An offline operation that can take seconds to minutes

### Adaptation Pipeline

```
Person Rebuild (Enhanced RAPTOR over Episodic entries for a subject):

1. Collect all Episodic entries for the target subject
2. Semantic chunking (τ = 0.7 cosine distance threshold)
   → Splits entries into coherent leaf chunks
3. Build k-NN graph from chunk embeddings
4. Leiden community detection with adaptive parameters:
   - k_base=15, k_step=5
   - γ_base=1.0, γ_step=0.2
   → Each community = a cluster of related facts
5. LLM summarization per cluster (user's configured model)
   → Each summary becomes a Persona entry
6. Atomic replacement: old Persona entries for the subject are replaced
   by the new summaries
```

### Why the Original Tree Structure Is Flattened

The original RAPTOR paper found that **collapsed tree retrieval** (flattening the entire tree and selecting top nodes by similarity) outperformed **hierarchical tree traversal** (layer-by-layer descent). STARmem v2 takes this further: the tree is not used for retrieval at all. The hierarchical structure is built solely to produce high-quality summaries via Leiden community detection, then those summaries are written directly into Persona memory as flat entries.

This is correct for the persona rebuild use case because:

1. Persona entries are consumed as-is during context injection—no retrieval ladder is needed.
2. The LLM reads the full Persona block; there is no top-k budget constraint during persona use.
3. The tree's retrieval advantage (selecting the right abstraction level for a query) is irrelevant when the consumer is a character sheet, not a question-answering model.

### What We Kept vs. What We Changed

| Original RAPTOR | Enhanced RAPTOR | STARmem v2 Adaptation |
| --- | --- | --- |
| 100-token fixed chunks | Semantic chunking (τ=0.7) | ✅ Semantic chunking adopted |
| GMM clustering | Leiden on k-NN graph | ✅ Leiden adopted |
| Single k, γ for all layers | Layer-adaptive k and γ | ✅ Adopted (k_base=15, k_step=5, γ_base=1.0, γ_step=0.2) |
| Tree traversal retrieval |—| ❌ Not used—retrieval is Tier 0-3 ladder |
| Collapsed tree retrieval |—| ❌ Not used—persona entries are flat summaries |
| LLM summarization per cluster | LLM summarization per cluster | ✅ LLM summarization adopted |
| Root-to-leaf tree structure | Root-to-leaf tree structure | ⚠️ Tree built internally, then flattened to persona entries |

### Why Not on the Hot Path

STARmem v2's retrieval ladder (§5) uses BM25, typed graph expansion (MAGMA-lite), and lifecycle scoring—all deterministic, all sub-100ms. Running Enhanced RAPTOR's Leiden community detection and LLM summarization on every query would blow the latency budget by orders of magnitude and violate the "deterministic retrieval, always" principle (§2, Principle 1).

The persona rebuild use case is the one place where the LLM-in-the-loop is acceptable because:

- It's user-initiated (explicit consent to wait)
- It runs on Episodic data (stable, not time-critical)
- The output is a distilled character sheet, not an answer to a conversational query

---

## Notes

### Original RAPTOR Code

- Reference implementation: `parthsarthi03/raptor` (GitHub)
- Language: Python
- Key dependencies: scikit-learn (GMM), umap-learn, sentence-transformers, OpenAI API

### Enhanced RAPTOR Code

- Reference implementation: `Xin5643/Graph-raptor` (GitHub)
- Language: Python 3.8+
- Key dependencies: `leidenalg`, `igraph`, `umap-learn`, `openai`, `tenacity`, `tiktoken`
- Licensed: MIT

### Relationship to Other Papers in the STARmem v2 Stack

- **MAGMA (arXiv:2601.03236)** provides the Tier 3 graph expansion mechanism for retrieval. RAPTOR and MAGMA both use graph-based structures, but MAGMA operates on typed edges between memory entries (mentions, supports, same_topic, temporal_next) while RAPTOR/Enhanced RAPTOR operate on embedding-similarity graphs between text chunks. They are complementary: MAGMA for retrieval, Enhanced RAPTOR for summarization.
- **ByteRover (arXiv:2604.01599)** provides the lifecycle math (importance scoring, recency decay) that determines *which* Episodic entries are fed into the Enhanced RAPTOR persona rebuild. The two systems are cleanly separated: ByteRover for lifecycle, RAPTOR for summarization.

### Future Considerations

- **Drift detection (§11):** If `contradicts` edges become active in v2.x, the Enhanced RAPTOR pipeline could be extended to flag clusters containing contradictory facts and surface them for user review before persona rebuild commits the summary.
- **Incremental rebuild:** Currently, persona rebuild is atomic—it replaces all Persona entries for a subject. An incremental approach could rebuild only clusters affected by new Episodic entries since the last rebuild, reducing latency for power users.
