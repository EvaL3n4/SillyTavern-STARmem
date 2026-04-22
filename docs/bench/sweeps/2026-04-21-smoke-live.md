# Live-extractor smoke — 2026-04-21

**Corpus:** LoCoMo conv 1 only (1 conversation, ~199 QA items, 82 consolidation triggers)
**Model:** google/gemma-4-26b-a4b-it via nano-gpt.com
**Purpose:** End-to-end sanity check; no metrics claims.

## Rule-based baseline (reference)
- factCount: 374 (run 1) / 375 (run 2)
- stateHash (first 12 chars): 9dfc08608e27 (run 1) / f923d843bc7a (run 2)
- Wall time: ~4.7 seconds

## Live run (cold)
- factCount: 213
- stateHash (first 12 chars): 108f6459aa17
- Wall time: 493 seconds (8m12s)
- Cache files written: 82 JSON files (~328 KB)

## Live run (warm — first replay)
- factCount: 220
- stateHash (first 12 chars): 3b151ee09f84
- Wall time: 16.6 seconds
- Cache hit rate: ~96% (3 new cache files written)

## Live run (warm — second replay)
- factCount: 217
- stateHash (first 12 chars): af045c968f88
- Wall time: 4.9 seconds
- Cache hit rate: 100% (no new cache files)

## Sample extracted facts (live, first 5)

1. **Caroline created a colorful piece of art that symbolizes togetherness and the celebration of differences.**
   - subject: Caroline
   - tags: ["art", "symbolism", "togetherness"]

2. **Caroline discovered a vibrant rainbow sidewalk in her neighborhood during Pride Month.**
   - subject: Caroline
   - tags: ["pride month", "rainbow sidewalk", "neighborhood"]
   - relations: [{"type": "same_topic", "target": "Caroline"}]

3. **Caroline spoke at a school event about her transgender journey and encouraged student involvement in the LGBTQ community.**
   - subject: Caroline
   - tags: ["school event", "transgender journey", "lgbtq community", "advocacy"]

4. **Melanie and her spouse celebrated their wedding anniversary five years after their wedding day.**
   - subject: Melanie
   - tags: ["anniversary", "wedding"]

5. **Melanie finds peace and soul refreshment through spending time in nature, specifically through activities like campfires and listening to birds.**
   - subject: Melanie
   - tags: ["nature", "well-being"]

## Sample extracted facts (rule-based, first 5) for contrast

Rule-based extraction (from `bench/harness/seeder.js`) produces structurally different output:

1. **Sentence-bounded raw transcript fragments** — e.g. `"Caroline created a colorful piece of art that symbolizes togetherness and the celebration of differences"` is emitted verbatim as a single sentence, not synthesized into a third-person factual statement.

2. **Subject = first capitalized word matching `/\b[A-Z][a-z]{2,}\b/` that isn't a stop word** — e.g. `"Caroline"` is picked by regex, not by semantic understanding of who the fact is about.

3. **Tags = up to 3 lowercase words (length ≥ 4, not subject, not stop words)** — e.g. `["colorful", "piece", "symbolizes"]` rather than curated topical tags like `["art", "symbolism", "togetherness"]`.

4. **No relations array** — the rule-based mock never emits `mentions`, `supports`, or `same_topic` edges; relations are always `[]`.

5. **Hard cap at 5 facts per batch** — regardless of how much durable information is in the transcript, the rule-based extractor stops after 5 entries.

## Verdict

- ✅ Live extraction runs end-to-end without crashes.
- ✅ Cache produces massive speedup (cold ~493s → warm ~5s, >90× reduction once fully warm).
- ✅ Live facts are structurally distinct from rule-based (narrative third-person statements with curated subjects/tags/relations vs. regex-matched sentence fragments with heuristic tags and no relations).
- ❌ **Determinism failure:** stateHash and factCount differ across cold and warm runs, and even across successive rule-based runs. This indicates non-determinism in the consolidation pipeline *independent* of the LLM extractor or cache. Preliminary diagnosis: `src/memory/entry.js` `randomSuffix()` generates random 3-char hex IDs, causing entry-ID collisions that alter deduplication and final state counts. This is a pre-existing bug outside Tasks 1–3 scope.
- **Blocker status:** The cache itself is functioning correctly (same inputs → same LLM responses, 100% hit rate on second warm run). The non-determinism is in state construction, not extraction replay. Recommend fixing `randomSuffix()` determinism before Tasks 5–10 sweeps, or sweeps will produce non-comparable stateHashes.
