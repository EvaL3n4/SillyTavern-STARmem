/**
 * Semantic chunking stub.
 *
 * Spec §6.4 prescribes semantic chunking with τ=0.7 cosine distance. We do
 * NOT implement that in v2.0 because Episodic entries produced by Phase 6's
 * extractor are already atomic 1-2 sentence facts — splitting them would
 * fragment coherent statements. Instead this module is an identity stub:
 * each Episodic entry becomes exactly one leaf node.
 *
 * For v2.1: if long documents ever enter the Episodic layer (e.g. a future
 * "paste a whole article" path), this module is the hook point for the real
 * semantic chunker. The public API (`chunkEntries`) will stay the same — it
 * maps Entry[] to Leaf[] where a Leaf has a stable id, source entry id(s),
 * and the text to embed/summarize.
 *
 * @module consolidation/raptor/chunking
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.4
 * @see docs/wiki/raptor.md (Enhanced RAPTOR → Semantic Chunking)
 */

/**
 * @typedef {object} Leaf
 * @property {string} id           - Stable leaf id: "leaf_<entryId>_<chunkIndex>". For the stub, chunkIndex is always 0.
 * @property {string[]} sourceEntryIds - The Episodic entry id(s) this leaf derives from. Stub: always length 1.
 * @property {string} text         - Text to embed and summarize.
 * @property {string | null} subject   - Carried from the source entry for downstream filtering.
 */

/**
 * Map an array of Episodic Entry objects to Leaf nodes.
 *
 * Stub behavior: 1 entry → 1 leaf, id-stable, content-preserved.
 *
 * @param {import('../../core/schema.js').Entry[]} entries
 * @returns {Leaf[]}
 */
export function chunkEntries(entries) {
    if (!Array.isArray(entries)) {
        throw new Error('chunkEntries: entries must be an array');
    }
    return entries.map(e => ({
        id: `leaf_${e.id}_0`,
        sourceEntryIds: [e.id],
        text: e.content,
        subject: e.subject,
    }));
}
