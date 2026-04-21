/**
 * Consolidation dedup — same-subject, near-duplicate-content collapse.
 *
 * Called by consolidate() for each newly-extracted Entry: if a prior Episodic
 * entry has the same subject (exact string, null≠null per spec §6.3) AND the
 * content Jaccard similarity is ≥ DEDUP_JACCARD_THRESHOLD, it is returned and
 * the caller bumps its lifecycle via applyUpdateEvent instead of adding a new
 * Entry. Working and Persona entries are not dedup candidates.
 *
 * Jaccard uses the same tokenize() as BM25 for consistency with retrieval.
 *
 * @module consolidation/dedup
 * @see docs/specs/2026-04-20-starmem-v2-design.md §6.3
 */

import { CONSOLIDATION } from '../core/constants.js';
import { tokenize } from '../retrieval/bm25.js';

/**
 * Jaccard similarity over two token arrays. Empty-over-empty returns 0 (not 1)
 * — zero-content entries should never dedup against each other.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccard(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    if (A.size === 0 && B.size === 0) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Return the first Episodic entry in `allEntries` that is a duplicate of
 * `candidate` under spec §6.3 rules, or null. Subject must match exactly
 * (strings or both null→no; null matches produce no candidates). Tokenization
 * shares the BM25 tokenize() function for consistency.
 *
 * @param {import('../core/schema.js').Entry} candidate
 * @param {import('../core/schema.js').Entry[]} allEntries
 * @returns {import('../core/schema.js').Entry | null}
 */
export function findDuplicate(candidate, allEntries) {
    // Spec §6.3: "duplicate_subject" — null subject never dedups.
    if (candidate.subject === null) return null;
    const candTokens = tokenize(candidate.content);
    for (const e of allEntries) {
        if (e.scope !== 'episodic') continue;
        if (e.subject !== candidate.subject) continue;
        const sim = jaccard(candTokens, tokenize(e.content));
        if (sim >= CONSOLIDATION.DEDUP_JACCARD_THRESHOLD) return e;
    }
    return null;
}
