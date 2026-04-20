# STARmem

**STARmem** is a memory extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern) built for long-form roleplay and narrative chat. It combines a single-substrate context tree with a deterministic 4-tier retrieval ladder, offline-only LLM calls, and first-class benchmarking instrumentation.

> **STARmem v2** is a clean-break rewrite of the v1 private beta. v1 is not migrated; new chats only.

## Design at a glance

- **Storage.** One JSON tree in `chatMetadata['STARmem']`—rides SillyTavern's native backup. No sidecar files, no vector DB, no embeddings.
- **Memory scopes.** Three: Working (hot buffer), Episodic (long-term), Persona (distilled character sheets, Enhanced-RAPTOR-built). Graph is infrastructure, not a memory.
- **Retrieval (deterministic).** Tier 0 exact cache → Tier 1 fuzzy cache → Tier 2 BM25 → Tier 3 intent-routed graph expansion (MAGMA-lite). Floor: top-K by `recency × importance × maturity_boost`.
- **Write path.** Single `consolidate()` function, lazy-chained: Working → Episodic (triggered at buffer ≥ 10 or idle ≥ 60s) → Persona (explicit rebuild only).
- **Lifecycle.** ByteRover's AKL math: importance (0–100), maturity tiers with hysteresis gaps, recency decay (τ = 30d). Multiplicative retrieval score.
- **No LLM on the query path.** LLM calls only during fact extraction (write) and Persona rebuild (offline batch). User picks the extraction model via SillyTavern's connection profiles.

For the full architecture, read the [design spec](docs/specs/2026-04-20-starmem-v2-design.md).

## Status

**v2.0 is in active development.** The [design spec](docs/specs/2026-04-20-starmem-v2-design.md) is approved; implementation plan to follow.

## Sources

STARmem's design draws on published research. Paper-by-paper notes live under [docs/wiki/](docs/wiki/).

**Adopted:**
- **ByteRover**—Nguyen et al. 2026, [arXiv:2604.01599](https://arxiv.org/abs/2604.01599)—substrate design (Context Tree, lifecycle metadata, tiered retrieval)
- **AdaMem**—Yan et al. 2026, [arXiv:2603.16496](https://arxiv.org/abs/2603.16496)—origin of the Working/Episodic/Persona vocabulary
- **MAGMA**—Jiang et al. 2026, [arXiv:2601.03236](https://arxiv.org/abs/2601.03236)—Tier 3 intent-routed graph expansion
- **Enhanced RAPTOR**—Liu et al. 2026, [DOI:10.3389/fcomp.2025.1710121](https://doi.org/10.3389/fcomp.2025.1710121)—Persona rebuild pipeline
- **RAPTOR**—Sarthi et al. 2024, [arXiv:2401.18059](https://arxiv.org/abs/2401.18059)—original recursive abstractive tree

**Evaluated, not adopted:**
- **A-MEM**—Xu et al. 2025, [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)—too weak on multi-hop for roleplay
- **Zep / Graphiti**—Rasmussen et al. 2025, [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)—full KG engine is overkill at chat scale

## License

Apache License 2.0—see [LICENSE](LICENSE).
